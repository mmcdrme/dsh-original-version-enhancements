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
  sweepQuarantineDirectories,
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
  purgeRetainedSession,
  purgeStaleRetainedSessions,
  restoreRetainedSession,
  retainDeletedSession,
} from './host/deleted-sessions.mjs'
import {
  createAutomationSurface,
  profileDirectory,
  readAutomationState,
  writeAutomationState,
} from './host/automation.mjs'
import { createRenameRequestHandler, renameSubagentSession } from './host/rename-session.mjs'
import { createLangHandler } from './host/lang.mjs'
import { createStyleHandler } from './host/css.mjs'
import { createEmbedHandler } from './host/embed.mjs'
import { createNativeWindows } from './host/native-window.mjs'
import path from 'node:path'
import { readdir } from 'node:fs/promises'

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

  // The detached-window panel hosts the client in an iframe. The Desktop shell
  // serves `dsh-app://app/` as a bare static document, so that iframe has no
  // boot data and would sit on the loading screen forever; this route answers
  // the injected document the browser seat already gets.
  const embedHandler = createEmbedHandler({
    origin: () => ctx.webServer.getOrigin(),
    warn: message => ctx.logger?.warn(message),
  })

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_ROOT}/window`,
      handler: embedHandler,
    }),
    'original-version-enhancements: embedded client route',
  )

  // A real, independent OS window: the companion executable hosts the embedded
  // page in WebView2 and this Host owns its lifetime, so the main window learns
  // which conversations are detached even across processes.
  const connection = optional(ctx, 'connection')
  const nativeWindows = createNativeWindows({
    origin: () => ctx.webServer.getOrigin(),
    authenticatedUrl: typeof connection?.authenticatedUrl === 'function'
      ? connection.authenticatedUrl.bind(connection)
      : undefined,
    isTrustedRequest,
    warn: message => ctx.logger?.warn(message),
  })
  for (const [name, handler] of Object.entries(nativeWindows.handlers)) {
    ctx.effect(
      () => ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_ROOT}/window/native/${name}`,
        handler,
      }),
      `original-version-enhancements: native window ${name} route`,
    )
  }
  ctx.effect(() => () => nativeWindows.closeAll(), 'original-version-enhancements: native window lifetime')

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

  // A crash in the middle of a delete, move or transfer rollback leaves a
  // quarantined folder holding the only copy of a transcript. Nothing indexes
  // those folders, so the only safe cleanup is age-based and runs once per
  // start; without it they accumulate for the lifetime of the profile.
  ctx.effect(() => {
    void sweepQuarantineDirectories(sessionRoot, { warn })
    return () => {}
  }, 'original-version-enhancements: quarantine sweep')

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
      // An empty listing is what a missing, unmounted or unreadable session root
      // looks like through this API (the JSONL backend answers ENOENT with an
      // empty array rather than throwing). Treating that as "every session was
      // deleted" wiped the workspace, archive, pin and title accounting for the
      // whole profile, and the transcript on disk could not bring it back.
      if (known.size === 0) return
      // The listing itself may silently skip a session whose header is corrupt
      // or written by a newer backend. Its directory still exists, though, and a
      // session that is on disk is not a ghost: only an id with no storage at
      // all may lose its accounting.
      const onDisk = new Set()
      const collect = async (directory, depth) => {
        if (depth > 3) return
        let entries
        try {
          entries = await readdir(directory, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          onDisk.add(entry.name)
          await collect(path.join(directory, entry.name), depth + 1)
        }
      }
      await collect(sessionRoot, 0)
      const drop = async (id) => {
        if (cancelled) return
        if (onDisk.has(String(id))) return
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
          for (const id of table.keys()) {
            if (!known.has(String(id)) && !onDisk.has(String(id))) stale.push(id)
          }
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
      // The archive sets the session was in before the delete: undoing the
      // removal puts it back into the same state instead of re-filing it as a
      // plain workspace conversation.
      const archived = Array.isArray(ctx.workspaceRegistry?.archivedSessionIds)
        && ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)
      // A pinned conversation must come back pinned: the delete unpins it, so the
      // undo has to know whether it was pinned before.
      const pinned = Array.isArray(ctx.workspaceRegistry?.pinnedSessionIds)
        && ctx.workspaceRegistry.pinnedSessionIds.includes(sessionId)
      // deletion drops the session's Workspace accounting and projection-cache
      // record itself, so no ghost conversation survives the removed transcript.
      return await deleteSessionSafely({
        ...accounting,
        sessions: ctx.sessions,
        agents: ctx.agents,
        agentHandles,
        sessionPersistence: persistence,
      }, {
        sessionRoot,
        sessionId,
        force: options?.force === true,
        retain: options?.retain === true
          ? info => retainDeletedSession({
            profileDir: profileDirectory(),
            sessionId: info.sessionId,
            projectDir: info.projectDir,
            name: info.name,
            sourceDirectory: info.directory,
            header: info.header,
            archived,
            pinned,
            warn,
          })
          : undefined,
      })
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

  // Renaming a subagent conversation. The shipped `session/rename` RPC resolves
  // the target to its live Agent, and the Host refuses subagent-routed sessions
  // there, so the same user `session/title` event is written through the
  // official title service (loaded child) or persistence write handle (unloaded
  // child). Ordinary Sessions still go through the shipped RPC.
  const renameHandler = createRenameRequestHandler({
    isTrustedRequest,
    rename: (sessionId, title) => renameSubagentSession({
      sessions: ctx.sessions,
      sessionPersistence: persistence,
      sessionTitle: () => optional(ctx, 'sessionTitle'),
    }, sessionId, title),
  })

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_ROOT}/sessions/rename`,
      handler: renameHandler,
    }),
    'original-version-enhancements: subagent rename route',
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

  // The undo receipt of a permanent delete: `restore` puts the retained session
  // back, `purge` drops it once the window has passed. Both take the same
  // confirmation header the delete takes, so no link can trigger them.
  const retainedHandler = action => async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST') return send(405, { ok: false, error: { code: 'method-not-allowed', message: '只允许使用 POST。' } })
    if (!isTrustedRequest(req) || req.headers['x-dsh-session-delete-confirmation'] !== 'delete-session') {
      return send(403, { ok: false, error: { code: 'forbidden', message: '请求未通过同源与确认校验。' } })
    }
    let body
    try {
      // Same bound every other JSON route enforces: the confirmation header
      // proves intent, not a right to grow the Host's heap.
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk)
        size += buffer.length
        if (size > 8 * 1024) {
          return send(413, { ok: false, error: { code: 'request-too-large', message: '请求过大。' } })
        }
        chunks.push(buffer)
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return send(400, { ok: false, error: { code: 'invalid-json', message: '请求不是有效 JSON。' } })
    }
    const token = typeof body?.token === 'string' ? body.token : ''
    if (token.length === 0 || token.length > 200) {
      return send(400, { ok: false, error: { code: 'invalid-token', message: '撤销凭据无效。' } })
    }
    try {
      const result = action === 'restore'
        ? await restoreRetainedSession({
          profileDir: profileDirectory(),
          workspaceRegistry: ctx.workspaceRegistry,
          sessionPersistence: persistence,
          sessionProjectionCache: projectionCache,
          agentHandles,
          warn,
        }, { token })
        : await purgeRetainedSession({ profileDir: profileDirectory(), warn }, { token })
      return send(result.ok ? 200 : 409, result)
    } catch (error) {
      // A restore that throws must still answer the request; leaving it open
      // strands the receipt's undo button until the browser times out.
      warn(`retained ${action} failed: ${String(error?.stack ?? error)}`)
      return send(500, { ok: false, error: { code: 'internal', message: '处理撤销请求时发生未预期错误。' } })
    }
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_ROOT}/sessions/restore`,
      handler: retainedHandler('restore'),
    }),
    'original-version-enhancements: undo a retained deletion',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_ROOT}/sessions/purge`,
      handler: retainedHandler('purge'),
    }),
    'original-version-enhancements: drop a retained deletion',
  )

  // A tab closed during the undo window must not keep session data forever.
  ctx.effect(() => {
    let cancelled = false
    purgeStaleRetainedSessions({ profileDir: profileDirectory(), warn }).catch(() => undefined)
    return () => { cancelled = true }
  }, 'original-version-enhancements: retained deletion sweep')
}
