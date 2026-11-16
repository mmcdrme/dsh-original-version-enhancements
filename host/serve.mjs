// HTTP plumbing shared by this plugin's Host routes.
//
// Two kinds of thing live here, and both used to be copy-pasted per module:
//   - the JSON helpers every POST route uses (`sendJson`, `readJsonBody`, with
//     the 8 KB bound that keeps a request from growing the Host's heap);
//   - the two file-asset routes (stylesheet, language catalogue), which answer
//     from disk with `no-store` so editing the file and refreshing the page is
//     the whole workflow — no rebuild, no Host restart.
//
// The asset contract itself is written once: GET/HEAD only, a byte bound, and
// a diagnostic 500 instead of a silently empty body.

import { readFile } from 'node:fs/promises'

/** Requests larger than this are a mistake; never buffer an unbounded body. */
export const MAX_REQUEST_BYTES = 8 * 1024

const failure = (code, message) => ({ ok: false, error: { code, message } })

/**
 * Answer one JSON route.
 * @param res - the response.
 * @param status - HTTP status code.
 * @param body - JSON-serialisable payload.
 */
export const sendJson = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

/**
 * Read one bounded JSON request body.
 * @param req - the incoming request.
 * @param maxBytes - size bound, for the routes that accept more than 8 KB.
 * @param options.empty - value returned for a zero-length body, for routes
 *   whose request is optional; omit it to make an empty body a parse error.
 * @returns the parsed body (or `options.empty`).
 * @throws Error('request-too-large') past the bound, or a JSON parse error.
 */
export const readJsonBody = async (req, maxBytes = MAX_REQUEST_BYTES, options = {}) => {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request-too-large')
    chunks.push(buffer)
  }
  if (chunks.length === 0 && options.empty !== undefined) return options.empty
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const methodOf = req => (typeof req.method === 'string' ? req.method.toUpperCase() : 'GET')

const sendAsset = (res, status, body, method, type) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': type,
    // Download managers read this header first: `inline` says this is page
    // furniture, not a file the user asked for, so IDM-class tools leave it be.
    'content-disposition': 'inline',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(text),
  })
  res.end(method === 'HEAD' ? undefined : text)
}

/**
 * Serve one plugin asset from disk on every request.
 * @param options.file - absolute path (a file URL is accepted).
 * @param options.warn - logger for a missing, oversized or invalid file.
 * @param options.name - asset name in warnings ("stylesheet").
 * @param options.tip - asset path in the 500 body ("样式文件 css/style.css").
 * @param options.contentType - success content type.
 * @param options.maxBytes - size bound; a larger file is a mistake, never stream it.
 * @param options.codes - failure codes, for routes whose client parses them.
 * @param options.errorBody - `(code, message)` -> failure body.
 * @param options.errorType - failure content type.
 * @param options.parse - optional extra step: `(text) => { body }`, or
 *   `{ failure: { code, message, warn? } }`; omitted for the stylesheet, which
 *   serves its text as-is.
 * @returns an HTTP handler.
 */
const createAssetHandler = ({
  file, warn = console.warn, name, tip, contentType, maxBytes, codes = {},
  errorBody, errorType, parse,
}) => async (req, res) => {
  const method = methodOf(req)
  const fail = (status, code, message) => sendAsset(
    res, status, errorBody(codes[code] ?? code, message), method, errorType,
  )
  if (method !== 'GET' && method !== 'HEAD') {
    fail(405, 'method-not-allowed', '只支持 GET 与 HEAD。')
    return
  }
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    warn(`original-version-enhancements: could not read the ${name}: ${error instanceof Error ? error.message : String(error)}`)
    fail(500, 'unreadable', `无法读取${tip}。`)
    return
  }
  if (Buffer.byteLength(text) > maxBytes) {
    warn(`original-version-enhancements: the ${name} exceeds ${maxBytes} bytes`)
    fail(500, 'too-large', `${tip}过大。`)
    return
  }
  let body = text
  if (typeof parse === 'function') {
    const outcome = parse(text)
    if (outcome.failure !== undefined) {
      if (outcome.failure.warn !== undefined) warn(`original-version-enhancements: ${outcome.failure.warn}`)
      fail(500, outcome.failure.code, outcome.failure.message)
      return
    }
    body = outcome.body
  }
  sendAsset(res, 200, typeof body === 'string' ? body : JSON.stringify(body), method, contentType)
}

/** Stylesheet route: `css/style.css`, served verbatim as CSS. */
export const createStyleHandler = ({ file, warn = console.warn }) => createAssetHandler({
  file,
  warn,
  name: 'stylesheet',
  tip: '样式文件 css/style.css',
  contentType: 'text/css; charset=utf-8',
  maxBytes: 1024 * 1024,
  errorBody: (_code, message) => message,
  errorType: 'text/plain; charset=utf-8',
})

/** Language route: `locale/lang.json`, parsed and shape-checked before it ships. */
export const createLangHandler = ({ file, warn = console.warn }) => createAssetHandler({
  file,
  warn,
  name: 'language catalogue',
  tip: '语言文件 locale/lang.json',
  contentType: 'application/json; charset=utf-8',
  maxBytes: 512 * 1024,
  codes: { unreadable: 'catalogue-unreadable', 'too-large': 'catalogue-too-large' },
  errorBody: failure,
  errorType: 'application/json; charset=utf-8',
  parse: (text) => {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return {
        failure: {
          code: 'catalogue-invalid',
          message: `语言文件不是有效 JSON：${detail}`,
          warn: `locale/lang.json is not valid JSON: ${detail}`,
        },
      }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        failure: {
          code: 'catalogue-invalid',
          message: '语言文件必须是 { "zh": {...}, "en": {...} } 形式的对象。',
        },
      }
    }
    return { body: parsed }
  },
})
