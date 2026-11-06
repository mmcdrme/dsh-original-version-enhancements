// 原版功能增强 — Host half.
// Provides the archive content search route and the confirmed permanent-delete
// route. The Client half registers the UI and the feature switches.

import {
  createDeleteRequestHandler,
  deleteSessionSafely,
  hostRequestFence,
} from './host/delete-session.mjs'
import {
  createArchiveSearchHandler,
  searchArchivedSessions,
} from './host/archive-manager.mjs'

const ROUTE_ROOT = '/plugins/original-version-enhancements'

/**
 * Read an optional Host service without making it a hard dependency.
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
  const webServer = optional(ctx, 'webServer')
  if (typeof webServer?.register !== 'function') return

  const isTrustedRequest = req => hostRequestFence(optional(ctx, 'connection'))(req)

  const searchHandler = createArchiveSearchHandler({
    isTrustedRequest,
    search: (query, signal) => searchArchivedSessions({
      workspaceRegistry: optional(ctx, 'workspaceRegistry'),
      sessionQuery: optional(ctx, 'sessionQuery'),
    }, query, signal),
  })

  ctx.effect(
    () => webServer.register({
      kind: 'exact',
      path: `${ROUTE_ROOT}/archives/search`,
      handler: searchHandler,
    }),
    'original-version-enhancements: archived content search route',
  )

  const persistence = optional(ctx, 'sessionPersistence')
  const sessionRoot = persistence?.config?.root ?? persistence?.root
  if (typeof sessionRoot !== 'string' || sessionRoot.length === 0) {
    // Without the per-session JSONL backend the page still offers search and
    // unarchive; only permanent deletion is unavailable.
    return
  }

  const deleteHandler = createDeleteRequestHandler({
    isTrustedRequest,
    deleteSession: sessionId => deleteSessionSafely({
      sessions: optional(ctx, 'sessions'),
      agents: optional(ctx, 'agents'),
      sessionPersistence: persistence,
    }, { sessionRoot, sessionId }),
  })

  ctx.effect(
    () => webServer.register({
      kind: 'exact',
      path: `${ROUTE_ROOT}/sessions/delete`,
      handler: deleteHandler,
    }),
    'original-version-enhancements: confirmed session deletion route',
  )
}
