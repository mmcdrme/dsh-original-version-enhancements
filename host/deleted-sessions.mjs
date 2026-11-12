// Retained deletions: a permanent delete moves the session directory into a
// trash folder under the profile instead of unlinking it, so the receipt's
// undo can put the conversation back. The trash is bounded: an entry lives
// until its undo window is closed explicitly, or an hour passes without one
// (a closed tab must not keep session data forever).

import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { inheritedEventCount, waitForCachedProjection } from './transfer.mjs'

/** Shape version of the trash sidecar. */
const STATE_VERSION = 1
/** How long an unclaimed retained session is kept before the next start drops it. */
export const RETAIN_LIFETIME_MS = 60 * 60 * 1000

/**
 * Absolute path of the trash directory for one profile.
 * @param profileDir - the profile directory.
 * @returns the trash root.
 */
export const retainedRoot = profileDir => path.join(profileDir, 'deleted-sessions')

/**
 * Absolute path of the sidecar that indexes the trash.
 * @param profileDir - the profile directory.
 * @returns the state file path.
 */
export const retainedStateFile = profileDir => path.join(profileDir, 'original-version-enhancements.deleted.json')

const emptyState = () => ({ version: STATE_VERSION, entries: {} })

/**
 * Read the trash index, tolerating a missing or malformed file.
 * @param profileDir - the profile directory.
 * @param warn - diagnostic sink.
 * @returns the mutable state object.
 */
export async function readRetainedState(profileDir, warn = () => undefined) {
  const file = retainedStateFile(profileDir)
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.entries !== null && typeof parsed.entries === 'object') {
      const entries = {}
      for (const [token, value] of Object.entries(parsed.entries)) {
        if (value === null || typeof value !== 'object') continue
        if (typeof value.sessionId !== 'string' || typeof value.directory !== 'string') continue
        entries[token] = value
      }
      return { version: STATE_VERSION, entries }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`deleted-sessions: could not read ${file}: ${String(error)}`)
  }
  return emptyState()
}

const writeRetainedState = async (profileDir, state) => {
  const file = retainedStateFile(profileDir)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(state), 'utf8')
}

/**
 * Move a directory, falling back to copy-then-remove across filesystems.
 * @param from - current location.
 * @param to - destination (must not exist).
 */
const moveDirectory = async (from, to) => {
  try {
    await rename(from, to)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await cp(from, to, { recursive: true, force: false })
    await rm(from, { recursive: true, force: true })
  }
}

const exists = async (target) => {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Take one removed session directory into the trash and record what is needed
 * to put it back: the project directory, the directory name, its header and
 * whether it was archived when the human deleted it.
 * @param options - profile directory, the removed directory and its identity.
 * @returns the undo token.
 */
export async function retainDeletedSession({
  profileDir,
  sessionId,
  projectDir,
  name,
  sourceDirectory,
  header,
  archived = false,
  now = Date.now(),
  warn = () => undefined,
}) {
  const token = randomUUID()
  const root = retainedRoot(profileDir)
  await mkdir(root, { recursive: true })
  const directory = path.join(root, token)
  await moveDirectory(sourceDirectory, directory)
  const state = await readRetainedState(profileDir, warn)
  state.entries[token] = {
    token,
    sessionId,
    projectDir,
    name,
    directory,
    header,
    archived: archived === true,
    createdAt: now,
  }
  await writeRetainedState(profileDir, state)
  return { token }
}

/**
 * Put a retained session back where it was deleted from, and file it again so
 * the sidebar lists it with its title instead of an untitled placeholder.
 * @param deps - profile directory, workspace registry, persistence, projection cache.
 * @param request - the undo token.
 * @returns a tagged result understood by the delete dialog.
 */
export async function restoreRetainedSession(deps, { token }) {
  const { profileDir, workspaceRegistry, sessionPersistence, sessionProjectionCache, warn = () => undefined } = deps
  const state = await readRetainedState(profileDir, warn)
  const entry = typeof token === 'string' ? state.entries[token] : undefined
  if (entry === undefined) {
    return { ok: false, error: { code: 'undo-expired', message: '撤销期限已过，该会话已彻底删除。' } }
  }
  const destination = path.join(entry.projectDir, entry.name ?? entry.sessionId)
  try {
    if (await exists(destination)) {
      return { ok: false, error: { code: 'undo-conflict', message: '原位置已经存在同名会话目录，未改动任何文件。' } }
    }
    await mkdir(entry.projectDir, { recursive: true })
    await moveDirectory(entry.directory, destination)
  } catch (error) {
    return { ok: false, error: { code: 'undo-failed', message: `恢复会话存储失败：${String(error?.message ?? error)}` } }
  }

  delete state.entries[token]
  await writeRetainedState(profileDir, state).catch(() => undefined)

  // Files are back; everything below only makes the Host see them again, and a
  // failure there is reported as a warning rather than undoing the restore.
  let warning
  try {
    if (typeof workspaceRegistry?.indexHeader === 'function') await workspaceRegistry.indexHeader(entry.header)
  } catch (error) {
    warning = String(error?.message ?? error)
  }
  let workspaceId = ''
  try {
    const workspace = typeof workspaceRegistry?.resolveByPath === 'function'
      ? await workspaceRegistry.resolveByPath(entry.header?.cwd)
      : undefined
    if (workspace !== undefined) {
      workspaceId = String(workspace.id ?? '')
      await workspace.attachSession(entry.sessionId)
      if (entry.archived === true && typeof workspaceRegistry?.archiveSession === 'function') {
        await workspaceRegistry.archiveSession(entry.sessionId)
      }
    }
  } catch (error) {
    warning = String(error?.message ?? error)
  }
  // Without a projection record the restored conversation would be listed as
  // untitled until it is opened; the same rule as a copied log applies here.
  try {
    const handle = await sessionPersistence?.open?.(entry.sessionId, 'read')
    if (handle !== undefined) {
      const header = handle.header
      const read = await handle.read().catch(() => undefined)
      try { await handle.close() } catch { /* the lease is already gone */ }
      const events = Array.isArray(read?.events) ? read.events : []
      const inherited = header?.isSeeded === true ? inheritedEventCount(events) : 0
      sessionProjectionCache?.coldSnapshot?.(header, inherited, events)
      await waitForCachedProjection(sessionProjectionCache, header)
    }
  } catch (error) {
    warning = String(error?.message ?? error)
  }
  return { ok: true, value: { sessionId: entry.sessionId, workspaceId, archived: entry.archived === true, warning } }
}

/**
 * Drop one retained session for good (the undo window closed).
 * @param deps - profile directory and diagnostic sink.
 * @param request - the token to drop.
 * @returns a tagged result.
 */
export async function purgeRetainedSession(deps, { token }) {
  const { profileDir, warn = () => undefined } = deps
  const state = await readRetainedState(profileDir, warn)
  const entry = typeof token === 'string' ? state.entries[token] : undefined
  if (entry === undefined) return { ok: true, value: { purged: false } }
  delete state.entries[token]
  await writeRetainedState(profileDir, state).catch(() => undefined)
  await rm(entry.directory, { recursive: true, force: true }).catch(error => {
    warn(`deleted-sessions: could not remove ${entry.directory}: ${String(error)}`)
  })
  return { ok: true, value: { purged: true } }
}

/**
 * Drop retained sessions whose undo window was never claimed (a closed tab, a
 * crashed Host). Called once on plugin start so the trash cannot grow forever.
 * @param deps - profile directory, lifetime bound and clock.
 * @returns how many entries were dropped.
 */
export async function purgeStaleRetainedSessions(deps) {
  const { profileDir, maxAgeMs = RETAIN_LIFETIME_MS, now = Date.now(), warn = () => undefined } = deps
  const state = await readRetainedState(profileDir, warn)
  let dropped = 0
  for (const [token, entry] of Object.entries(state.entries)) {
    const createdAt = typeof entry.createdAt === 'number' ? entry.createdAt : 0
    if (now - createdAt < maxAgeMs) continue
    delete state.entries[token]
    await rm(entry.directory, { recursive: true, force: true }).catch(() => undefined)
    dropped += 1
  }
  if (dropped > 0) await writeRetainedState(profileDir, state).catch(() => undefined)
  return dropped
}
