// Native detached windows.
//
// The Desktop shell does not expose a way for a plugin to create an OS window,
// so the Host half starts a small companion executable (`native/OveWindow.exe`)
// that hosts the embedded conversation page in its own WebView2 window. The
// Host owns the lifetime: it knows which sessions have a window, it closes the
// previous one when another conversation is detached, and it reports the state
// the main window paints its sidebar rows from.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Request bodies are tiny; anything larger is a mistake. */
const MAX_REQUEST_BYTES = 64 * 1024
/** The companion window host shipped with this plugin. */
const EXECUTABLE = fileURLToPath(new URL('../native/OveWindow.exe', import.meta.url))
/** WebView2 profile fallback: some sandboxes deny %LOCALAPPDATA% to children. */
const DATA_DIRECTORY = fileURLToPath(new URL('../.webview-data', import.meta.url))
/** The sidebar-free conversation page each window hosts. */
const WINDOW_PAGE = '/plugins/original-version-enhancements/window'
/** One Chromium instance per window is not cheap; this keeps it bounded. */
const MAX_WINDOWS = 8
/** Every window polls this file, so appearance edits reach open windows. */
const APPEARANCE_FILE = join(DATA_DIRECTORY, 'appearance.json')
const sendJson = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

const readJsonBody = async (req) => {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new Error('request-too-large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const clampSize = (value, fallback, min) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(2400, Math.max(min, Math.round(number)))
}

/**
 * The command line the companion window host understands.
 * @param input - window identity and geometry.
 * @returns the argument vector, without the executable.
 */
export function windowArguments({ bootUrl, appUrl, title, width, height, opacity, mute, dataDir, parentPid, appearanceFile }) {
  const args = [
    '--url', bootUrl,
    '--app-url', appUrl,
    '--title', typeof title === 'string' && title.length > 0 ? title : '独立会话窗口',
    '--width', String(width),
    '--height', String(height),
    '--opacity', String(opacity),
    '--mute', mute === false ? '0' : '1',
    '--data-dir', dataDir,
  ]
  // The exe exits with this process: a Host crash or upgrade must not leave
  // orphan windows that the next Host knows nothing about.
  if (Number.isInteger(parentPid) && parentPid > 0) args.push('--parent-pid', String(parentPid))
  if (typeof appearanceFile === 'string' && appearanceFile.length > 0) args.push('--appearance', appearanceFile)
  return args
}

/**
 * Own the native windows this Host started.
 * @param options.origin - resolves this Host's base URL.
 * @param options.authenticatedUrl - adds the launch token to a browser URL.
 * @param options.isTrustedRequest - same-origin fence for state-changing calls.
 * @param options.warn - logger for a window that could not start.
 * @returns route handlers plus a shutdown hook.
 */
export function createNativeWindows({ origin, authenticatedUrl, isTrustedRequest, warn = console.warn }) {
  /** sessionId -> { child, openedAt, ready, title } */
  const windows = new Map()
  /** Profiles already scheduled for removal (close + exit both fire). */
  const dropped = new Set()

  /**
   * A window's WebView2 profile is only that window's: drop it when the window
   * closes. Chromium releases its files a moment after the process exits, so
   * the removal is retried instead of abandoned on the first lock.
   */
  const dropProfile = (directory) => {
    if (dropped.has(directory)) return
    dropped.add(directory)
    const attempt = (remaining) => {
      rm(directory, { recursive: true, force: true }).catch(() => {
        if (remaining > 0) setTimeout(() => attempt(remaining - 1), 1500)
      })
    }
    attempt(2)
  }

  // Profiles left behind by an earlier Host generation are useless now.
  void readdir(DATA_DIRECTORY).then((names) => {
    for (const name of names) {
      if (!name.startsWith('window-')) continue
      const stamp = Number(name.slice('window-'.length).split('-')[0])
      if (!Number.isFinite(stamp) || Date.now() - stamp > 24 * 60 * 60 * 1000) dropProfile(join(DATA_DIRECTORY, name))
    }
  }).catch(() => { /* no profiles yet */ })
  const supported = process.platform === 'win32' && existsSync(EXECUTABLE)

  /** Write the appearance all open windows follow. */
  const publishAppearance = async ({ opacity, mute }) => {
    const payload = JSON.stringify({ opacity: clampSize(opacity, 100, 30), mute: mute !== false })
    try {
      await mkdir(DATA_DIRECTORY, { recursive: true })
      await writeFile(APPEARANCE_FILE, payload, 'utf8')
    } catch (error) {
      warn(`original-version-enhancements: could not write the window appearance: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const forget = (sessionId, child) => {
    const entry = windows.get(sessionId)
    if (entry === undefined || entry.child !== child) return
    windows.delete(sessionId)
  }

  const close = (sessionId) => {
    const entry = windows.get(sessionId)
    if (entry === undefined) return
    windows.delete(sessionId)
    try { entry.child.kill() } catch { /* already gone */ }
    dropProfile(entry.dataDir)
  }

  const closeAll = () => {
    for (const sessionId of [...windows.keys()]) close(sessionId)
  }

  /**
   * Start one window for one conversation, replacing any other window.
   * @param sessionId - the conversation to show.
   * @param options - title, geometry and opacity from the plugin page.
   * @returns `{ ok: true }` or a failure the client turns into a fallback.
   */
  const open = (sessionId, options = {}) => {
    if (!supported) return { ok: false, error: 'unsupported' }
    if (typeof authenticatedUrl !== 'function') return { ok: false, error: 'unsupported' }
    // One window per conversation; several conversations may be open at once.
    if (windows.has(sessionId)) return { ok: true, reused: true }
    if (windows.size >= MAX_WINDOWS) return { ok: false, error: 'too-many-windows' }
    const base = String(typeof origin === 'function' ? origin() : origin)
    const bootUrl = authenticatedUrl(new URL('/', base).href)
    const appUrl = `${base.replace(/\/+$/u, '')}${WINDOW_PAGE}?session=${encodeURIComponent(sessionId)}`
    const title = typeof options.title === 'string' ? options.title : '独立会话窗口'
    const width = clampSize(options.width, 1100, 560)
    const height = clampSize(options.height, 800, 420)
    const opacity = clampSize(options.opacity, 100, 30)
    const mute = options.mute !== false
    // Each window needs its own WebView2 profile: the Host grants one browser
    // session a single live connection, so a shared cookie jar would leave the
    // second window waiting on the welcome screen forever.
    const dataDir = join(DATA_DIRECTORY, `window-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    void publishAppearance({ opacity, mute })
    let child
    try {
      child = spawn(EXECUTABLE, windowArguments({
        bootUrl, appUrl, title, width, height, opacity, mute, dataDir,
        parentPid: process.pid,
        appearanceFile: APPEARANCE_FILE,
      }), {
        stdio: 'ignore',
        windowsHide: false,
      })
    } catch (error) {
      warn(`original-version-enhancements: could not start the window host: ${error instanceof Error ? error.message : String(error)}`)
      return { ok: false, error: 'spawn-failed' }
    }
    child.once('error', (error) => {
      warn(`original-version-enhancements: the window host failed: ${error instanceof Error ? error.message : String(error)}`)
      forget(sessionId, child)
      dropProfile(dataDir)
    })
    child.once('exit', () => {
      forget(sessionId, child)
      dropProfile(dataDir)
    })
    windows.set(sessionId, { child, openedAt: Date.now(), ready: false, title, dataDir })
    return { ok: true }
  }

  const markReady = (sessionId) => {
    const entry = windows.get(sessionId)
    if (entry === undefined) return false
    entry.ready = true
    return true
  }

  const list = () => [...windows.entries()].map(([sessionId, entry]) => ({
    sessionId,
    openedAt: entry.openedAt,
    ready: entry.ready,
    title: entry.title,
  }))

  const handlers = {
    open: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      if (!isTrustedRequest(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid-body' })
        return
      }
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      if (sessionId.length === 0) { sendJson(res, 400, { ok: false, error: 'invalid-session' }); return }
      const result = open(sessionId, body)
      sendJson(res, result.ok ? 200 : 409, result)
    },
    close: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      if (!isTrustedRequest(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid-body' })
        return
      }
      if (body?.all === true) closeAll()
      else if (typeof body?.sessionId === 'string') close(body.sessionId)
      else { sendJson(res, 400, { ok: false, error: 'invalid-session' }); return }
      sendJson(res, 200, { ok: true })
    },
    ready: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      if (!isTrustedRequest(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid-body' })
        return
      }
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      sendJson(res, 200, { ok: markReady(sessionId) })
    },
    appearance: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      if (!isTrustedRequest(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid-body' })
        return
      }
      await publishAppearance({ opacity: body?.opacity, mute: body?.mute })
      sendJson(res, 200, { ok: true })
    },
    state: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      sendJson(res, 200, { ok: true, supported, windows: list() })
    },
  }

  return { handlers, close, closeAll, supported }
}
