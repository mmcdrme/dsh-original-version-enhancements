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
import { fileURLToPath } from 'node:url'

/** Request bodies are tiny; anything larger is a mistake. */
const MAX_REQUEST_BYTES = 64 * 1024
/** The companion window host shipped with this plugin. */
const EXECUTABLE = fileURLToPath(new URL('../native/OveWindow.exe', import.meta.url))
/** WebView2 profile fallback: some sandboxes deny %LOCALAPPDATA% to children. */
const DATA_DIRECTORY = fileURLToPath(new URL('../.webview-data', import.meta.url))
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
export function windowArguments({ bootUrl, session, title, width, height, opacity, dataDir }) {
  return [
    '--url', bootUrl,
    '--session', session,
    '--title', typeof title === 'string' && title.length > 0 ? title : '独立会话窗口',
    '--width', String(width),
    '--height', String(height),
    '--opacity', String(opacity),
    '--data-dir', dataDir,
  ]
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
  const supported = process.platform === 'win32' && existsSync(EXECUTABLE)

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
    closeAll()
    const base = String(typeof origin === 'function' ? origin() : origin)
    const bootUrl = authenticatedUrl(new URL('/', base).href)
    const title = typeof options.title === 'string' ? options.title : '独立会话窗口'
    const width = clampSize(options.width, 1100, 560)
    const height = clampSize(options.height, 800, 420)
    const opacity = clampSize(options.opacity, 100, 30)
    let child
    try {
      child = spawn(EXECUTABLE, windowArguments({ bootUrl, session: sessionId, title, width, height, opacity, dataDir: DATA_DIRECTORY }), {
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
    })
    child.once('exit', () => { forget(sessionId, child) })
    windows.set(sessionId, { child, openedAt: Date.now(), ready: false, title })
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
