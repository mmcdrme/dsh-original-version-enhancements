// 原版功能增强 — Host half.
// Provides the archive content search route and the confirmed permanent-delete
// route. The Client half registers the UI and the feature switches.

import {
  createDeleteRequestHandler,
  deleteSessionSafely,
  hostRequestFence,
  installAgentHandleTracker,
  projectionCacheTable,
  purgeSessionAccounting,
} from './host/delete-session.mjs'
import {
  createArchiveSearchHandler,
  searchArchivedSessions,
} from './host/archive-manager.mjs'
import {
  createTransferRequestHandler,
  transferSession,
} from './host/transfer.mjs'
import {
  createAutomationSurface,
  profileDirectory,
  readAutomationState,
  writeAutomationState,
} from './host/automation.mjs'
import { createLangHandler } from './host/lang.mjs'
import { createStyleHandler } from './host/css.mjs'
import path from 'node:path'

const ROUTE_ROOT = '/plugins/original-version-enhancements'

/** The Host services these routes consume; Cordis waits for all of them. */
export const inject = [
  'webServer',
  'sessionPersistence',
  'sessions',
  'agents',
  'workspaceRegistry',
  'sessionQuery',
]

/**
 * Read an optional Host service without turning it into a hard dependency.
 * @param ctx - the plugin context.
 * @param name - the Cordis service key.
 * @returns the service, or undefined when this composition does not mount it.
 */
const optional = (ctx, name) => {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

export function apply(ctx) {
  const isTrustedRequest = req => hostRequestFence(optional(ctx, 'connection'))(req)

  const agentHandles = installAgentHandleTracker(ctx.agents, ctx.sessions)
  ctx.effect(() => () => agentHandles.release(), 'original-version-enhancements: agent lifecycle tracking')

  const searchHandler = createArchiveSearchHandler({
    isTrustedRequest,
    search: (query, signal) => searchArchivedSessions({
      workspaceRegistry: ctx.workspaceRegistry,
      sessionQuery: ctx.sessionQuery,
    }, query, signal),
  })

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_ROOT}/archives/search`,
      handler: searchHandler,
    }),
    'original-version-enhancements: archived content search route',
  )

  // The UI wording is data, not code: `locale/lang.json` is served from disk on
  // every request (no cache) so editing that one file and refreshing the page is
  // the whole workflow.
  const langHandler = createLangHandler({
    file: new URL('./locale/lang.json', import.meta.url),
    warn: message => ctx.logger?.warn(message),
  })

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_ROOT}/lang`,
      handler: langHandler,
    }),
    'original-version-enhancements: language catalogue route',
  )

  // Same deal for the stylesheet: `css/style.css` is the source of truth and is
  // answered fresh on every request. The route carries no `.css` suffix on
  // purpose — a download manager that captures page sub-resources by file type
  // (IDM and similar) would otherwise pop its download dialog on every reload.
  const styleHandler = createStyleHandler({
    file: new URL('./css/style.css', import.meta.url),
    warn: message => ctx.logger?.warn(message),
  })

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_ROOT}/style`,
      handler: styleHandler,
    }),
    'original-version-enhancements: stylesheet route',
  )

  // Automation task enhancements. The shipped Automation tasks page owns
  // creation, editing, filters and records; these routes add bulk deletion,
  // multi-conversation binding, and the post-delivery auto-clean flag. The
  // Schedule service stays optional so a composition without it still gets
  // every other feature of this plugin.
  const warn = message => ctx.logger?.warn(`original-version-enhancements: ${message}`)
  if (typeof ctx.inject === 'function') {
    const stateFile = path.join(profileDirectory(), 'original-version-enhancements.automation.json')
    const state = readAutomationState(stateFile, warn)
    const save = () => writeAutomationState(stateFile, state, warn)

    ctx.inject(['schedule'], (scope) => {
      const service = scope.schedule
      if (service === undefined) return
      const surface = createAutomationSurface({ service, state, save, isTrustedRequest, warn })
      for (const [name, handler] of Object.entries(surface.handlers)) {
        const segment = name === 'autoClean' ? 'auto-clean' : name === 'remove' ? 'delete' : name
        scope.effect(() => scope.webServer.register({
          kind: 'exact',
          path: `${ROUTE_ROOT}/automation/${segment}`,
          handler,
        }), `original-version-enhancements: automation ${segment} route`)
      }
      scope.effect(() => {
        const off = scope.on('schedule/changed', () => { void surface.reconcile() })
        void surface.reconcile()
        return () => off()
      }, 'original-version-enhancements: automation auto-clean reconciler')
    })
  }

  const persistence = ctx.sessionPersistence
  const sessionRoot = persistence?.config?.root ?? persistence?.root
  if (typeof sessionRoot !== 'string' || sessionRoot.length === 0) {
    // Without the per-session JSONL backend the page still offers search and
    // unarchive; only permanent deletion is unavailable.
    return
  }

  // Drop accounting whose session storage no longer exists, including ids
  // removed before this reconciliation shipped. The transcript is the truth: an
  // id without a stored log can never reopen, so leaving it in the Workspace
  // registry (or the projection cache) is exactly the ghost conversation this
  // cleanup exists to prevent. Both halves mirror the manual cleanup that used
  // to be necessary after a plugin deletion.
  const projectionCache = optional(ctx, 'sessionProjectionCache')
  const storageDomain = optional(ctx, 'storageDomain')
  const accounting = { workspaceRegistry: ctx.workspaceRegistry, sessionProjectionCache: projectionCache, storageDomain }

  ctx.effect(() => {
    let cancelled = false
    const reconcile = async () => {
      const registry = ctx.workspaceRegistry
      if (registry === undefined) return
      let known
      try {
        // One corpus listing answers every question below; never reconcile
        // against a corpus that could not be read.
        known = new Set((await persistence.list()).map(item => String(item?.header?.id ?? item?.id ?? '')))
      } catch {
        return
      }
      const drop = async (id) => {
        if (cancelled) return
        await purgeSessionAccounting(accounting, id)
      }
      const archived = Array.isArray(registry.archivedSessionIds) ? [...registry.archivedSessionIds] : []
      for (const id of archived) if (!known.has(String(id))) await drop(id)
      // Iterate the DURABLE records, not `workspace.sessionIds`: the getter
      // already filters out ids whose header index no longer matches, so the
      // ghosts this cleanup targets are invisible there and would survive
      // forever. The raw table is the only complete accounting.
      const recorded = []
      try {
        if (typeof registry.requireTable === 'function') {
          for (const [workspaceId, record] of registry.requireTable().entries()) recorded.push([workspaceId, record])
        }
      } catch { /* an unavailable table is retried on the next start */ }
      if (recorded.length === 0) {
        try {
          for (const workspace of registry.list()) {
            recorded.push([workspace.id, { path: workspace.path, sessionIds: workspace.sessionIds }])
          }
        } catch { /* an unavailable registry is retried on the next start */ }
      }
      for (const [, record] of recorded) {
        for (const id of [...(record?.sessionIds ?? [])]) {
          if (!known.has(String(id))) await drop(id)
        }
      }
      const table = projectionCacheTable({ sessionProjectionCache: projectionCache, storageDomain })
      if (table !== undefined) {
        try {
          const stale = []
          for (const id of table.keys()) if (!known.has(String(id))) stale.push(id)
          if (stale.length > 0) await table.deleteMany(stale)
        } catch { /* the cache self-heals on its next write */ }
      }
    }
    reconcile().catch(() => undefined)
    return () => { cancelled = true }
  }, 'original-version-enhancements: session accounting reconciliation')

  const deleteHandler = createDeleteRequestHandler({
    isTrustedRequest,
    deleteSession: async (sessionId, options) => {
      // deletion drops the session's Workspace accounting and projection-cache
      // record itself, so no ghost conversation survives the removed transcript.
      return await deleteSessionSafely({
        ...accounting,
        sessions: ctx.sessions,
        agents: ctx.agents,
        agentHandles,
        sessionPersistence: persistence,
      }, { sessionRoot, sessionId, force: options?.force === true })
    },
  })

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_ROOT}/sessions/delete`,
      handler: deleteHandler,
    }),
    'original-version-enhancements: confirmed session deletion route',
  )

  // Moving or copying one session into another workspace. A session belongs to
  // the workspace owning its recorded directory: `copy` materialises an
  // independent session inside the target directory, while `move` recreates the
  // very same session id there, so the conversation keeps its identity.
  const transferHandler = createTransferRequestHandler({
    isTrustedRequest,
    transfer: request => transferSession({
      ...accounting,
      sessionPersistence: persistence,
      sessions: ctx.sessions,
      agents: ctx.agents,
      agentHandles,
      sessionRoot,
    }, request),
  })

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_ROOT}/sessions/transfer`,
      handler: transferHandler,
    }),
    'original-version-enhancements: session transfer route',
  )
}
