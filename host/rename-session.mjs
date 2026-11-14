// Rename one subagent Session.
//
// The shipped `session/rename` RPC resolves the target to its live Agent, and
// the Host hands every subagent-routed Session to subagent delivery instead
// ("session ... is owned by subagent routing"), so the stock dialog can never
// rename a child conversation. A rename is only a `session/title` event with
// `source.kind = 'user'`, so this route writes exactly that event through the
// official Session services: the live title service when the child is loaded,
// otherwise the persistence write handle (same event, same normalization).
// Ordinary Sessions stay on the shipped RPC — the route refuses them.

const MAX_REQUEST_BYTES = 8 * 1024
/** Request header that must accompany every rename; links and forms cannot set it. */
export const RENAME_CONFIRMATION = 'rename-session'
/** Fallback byte budget when the deployment does not expose the title service. */
const DEFAULT_MAX_TITLE_BYTES = 80

const failure = (code, message) => ({ ok: false, error: { code, message } })

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
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/* ------------------------------------------------------------------ */
/* Title normalization — the shipped service's rules                   */
/* ------------------------------------------------------------------ */

const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu
const ESC_SEQUENCE = /\u001B[@-_]/gu
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu

/** Remove controls and produce one trimmed, whitespace-normalized line. */
const cleanTitleText = (input) => input
  .replace(OSC_SEQUENCE, '')
  .replace(CSI_SEQUENCE, '')
  .replace(ESC_SEQUENCE, '')
  .replace(CONTROL_CHARACTER, '')
  .replace(DIRECTIONAL_CONTROL, '')
  .replace(/\s+/gu, ' ')
  .trim()

/** Longest leading code-point prefix within a UTF-8 byte budget. */
const truncateTitleUtf8 = (input, maxBytes) => {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input
  let used = 0
  let output = ''
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    output += character
    used += bytes
  }
  return output
}

/**
 * Normalize one proposed title the way the shipped title service does.
 * @param {string} input - raw human input.
 * @param {number} maxBytes - positive UTF-8 byte budget.
 * @returns {string} the accepted title, possibly empty.
 */
export const normalizeTitle = (input, maxBytes = DEFAULT_MAX_TITLE_BYTES) => {
  const budget = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_TITLE_BYTES
  return truncateTitleUtf8(cleanTitleText(input), budget).trimEnd()
}

/* ------------------------------------------------------------------ */
/* The rename itself                                                   */
/* ------------------------------------------------------------------ */

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Write one user title to a subagent Session with the official services.
 * @param {object} deps - Host services plus the lazily resolved title service.
 * @param {string} sessionId - the child Session to rename.
 * @param {string} rawTitle - the proposed title.
 * @returns {Promise<{ok: true, value: {title: string, seq: number}} | {ok: false, error: {code: string, message: string}}>}
 */
export const renameSubagentSession = async (deps, sessionId, rawTitle) => {
  const titles = deps.sessionTitle?.()
  const budget = Number.isInteger(titles?.config?.maxTitleBytes) ? titles.config.maxTitleBytes : DEFAULT_MAX_TITLE_BYTES
  const title = normalizeTitle(rawTitle, budget)
  if (title.length === 0) return failure('title-invalid', '会话标题不能为空。')

  // A loaded child is renamed through the same service the stock dialog uses;
  // it appends the event and pins the title in one step.
  const live = deps.sessions?.get?.(sessionId)
  if (live !== undefined && livesInSubagentRouting(live) && typeof titles?.rename === 'function') {
    try {
      const accepted = titles.rename(live, title)
      return { ok: true, value: { title: accepted.title, seq: accepted.eventSeq } }
    } catch (error) {
      return failure('rename-failed', messageOf(error))
    }
  }

  // An unloaded child is not in the Session store at all, so the same event is
  // appended through the persistence write handle instead.
  let handle
  try {
    handle = await deps.sessionPersistence.open(sessionId, 'write')
  } catch (error) {
    const name = error?.name
    if (name === 'SessionAlreadyOwnedError') return failure('session-busy', '该子会话正被宿主独占写入，请稍后重试。')
    if (name === 'SessionPersistenceNotFoundError') return failure('session-not-found', '找不到该子会话的存储文件。')
    return failure('open-failed', messageOf(error))
  }
  try {
    if (handle.header?.origin !== 'subagent') {
      return failure('not-subagent', '该会话不是子智能体会话，请使用官方重命名。')
    }
    const nextSeq = await nextEventSeq(deps, handle)
    const event = {
      type: 'session/title',
      seq: nextSeq,
      time: Date.now(),
      data: { title, messageSeqs: [], source: { kind: 'user' } },
    }
    await handle.append([event])
    await handle.flush()
    return { ok: true, value: { title, seq: nextSeq } }
  } catch (error) {
    return failure('rename-failed', messageOf(error))
  } finally {
    try { await handle.close() } catch { /* the write already failed or the handle is gone */ }
  }
}

/** Whether one loaded Session is a subagent conversation. */
const livesInSubagentRouting = (session) => session?.header?.origin === 'subagent'

/**
 * The seq the next appended event must carry. The persisted event count is used
 * when the backend reports it; otherwise the log's last event is read.
 * @param {object} deps - Host services.
 * @param {object} handle - the open write handle.
 * @returns {Promise<number>} the next contiguous seq.
 */
const nextEventSeq = async (deps, handle) => {
  let count
  try {
    const snapshot = await deps.sessionPersistence.stat?.(handle.id)
    if (Number.isInteger(snapshot?.eventCount)) count = snapshot.eventCount
  } catch { /* fall back to reading the tail */ }
  if (Number.isInteger(count)) {
    if (count === 0) return 0
    const tail = await handle.read(count - 1, 1)
    const last = tail?.events?.[0]
    return Number.isInteger(last?.seq) ? last.seq + 1 : count
  }
  const all = await handle.read()
  const events = Array.isArray(all?.events) ? all.events : []
  const last = events[events.length - 1]
  return Number.isInteger(last?.seq) ? last.seq + 1 : events.length
}

/**
 * HTTP boundary for the subagent rename: same-origin JSON POST plus a
 * confirmation-only header.
 * @param {object} root0 - the rename implementation and the Host request fence.
 * @returns {Function} a route handler for the exact rename path.
 */
export function createRenameRequestHandler({ rename, isTrustedRequest }) {
  return async (req, res) => {
    const contentType = req.headers['content-type']
    const confirmation = req.headers['x-dsh-session-rename-confirmation']

    if (req.method !== 'POST') {
      sendJson(res, 405, failure('method-not-allowed', '只允许使用 POST 重命名会话。'))
      return
    }
    if (!isTrustedRequest(req) || confirmation !== RENAME_CONFIRMATION) {
      sendJson(res, 403, failure('forbidden', '重命名请求未通过同源与确认校验。'))
      return
    }
    if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
      sendJson(res, 415, failure('unsupported-media-type', '重命名请求必须使用 JSON。'))
      return
    }

    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === 'request-too-large'
      sendJson(
        res,
        tooLarge ? 413 : 400,
        failure(tooLarge ? 'request-too-large' : 'invalid-json', tooLarge ? '重命名请求过大。' : '重命名请求不是有效 JSON。'),
      )
      return
    }
    if (
      typeof body?.sessionId !== 'string'
      || body.sessionId.length === 0
      || body.sessionId.length > 512
      || body.sessionId.includes('\0')
    ) {
      sendJson(res, 400, failure('invalid-session-id', '会话 ID 无效。'))
      return
    }
    if (typeof body?.title !== 'string' || body.title.length > 4096) {
      sendJson(res, 400, failure('invalid-title', '会话标题无效。'))
      return
    }

    try {
      const result = await rename(body.sessionId, body.title)
      sendJson(res, result.ok ? 200 : 409, result)
    } catch {
      sendJson(res, 500, failure('internal', '重命名过程中发生未预期错误，未确认修改成功。'))
    }
  }
}
