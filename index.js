// 原版功能增强 — Host half.
// Provides the archive content search route and the confirmed permanent-delete
// route. The Client half registers the UI and the feature switches.

import {
  createDeleteRequestHandler,
  deleteSessionSafely,
  hostRequestFence,
  installAgentHandleTracker,
} from './host/delete-session.mjs'
import {
  createArchiveSearchHandler,
  searchArchivedSessions,
} from './host/archive-manager.mjs'

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

  const persistence = ctx.sessionPersistence
  const sessionRoot = persistence?.config?.root ?? persistence?.root
  if (typeof sessionRoot !== 'string' || sessionRoot.length === 0) {
    // Without the per-session JSONL backend the page still offers search and
    // unarchive; only permanent deletion is unavailable.
    return
  }

  // Drop archive markers whose session storage no longer exists, including
  // ids removed before this reconciliation shipped.
  ctx.effect(() => {
    let cancelled = false
    const reconcile = async () => {
      const registry = ctx.workspaceRegistry
      const ids = Array.isArray(registry?.archivedSessionIds) ? [...registry.archivedSessionIds] : []
      for (const id of ids) {
        if (cancelled) return
        try {
          if (await persistence.stat(id) === undefined) await registry.unarchiveSession(id)
        } catch { /* an unreadable marker is left for a later run */ }
      }
    }
    reconcile().catch(() => undefined)
    return () => { cancelled = true }
  }, 'original-version-enhancements: archive marker reconciliation')

  const deleteHandler = createDeleteRequestHandler({
    isTrustedRequest,
    deleteSession: async (sessionId, options) => {
      const result = await deleteSessionSafely({
        sessions: ctx.sessions,
        agents: ctx.agents,
        agentHandles,
        sessionPersistence: persistence,
      }, { sessionRoot, sessionId, force: options?.force === true })
      if (result.ok) {
        // Keep the archive registry free of ids whose storage was removed.
        try {
          await ctx.workspaceRegistry.unarchiveSession(sessionId)
        } catch { /* the caller still gets the deletion result */ }
      }
      return result
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
}
