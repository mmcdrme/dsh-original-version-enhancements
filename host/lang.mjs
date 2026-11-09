// Language catalogues route.
//
// The plugin's wording lives in `locale/lang.json` so it can be edited as
// plain data, without touching client code or rebuilding anything. The file is
// read from disk on every request and answered with `no-store`: unlike a
// bundled chunk, which the Host serves with an immutable one-year cache keyed by
// the *entry* revision, this route always reflects the bytes currently on disk,
// so a page refresh is enough to see an edit.

import { readFile } from 'node:fs/promises'

/** A catalogue this size is already a mistake; never stream an unbounded file. */
const MAX_BYTES = 512 * 1024

const send = (res, status, payload, method) => {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // `inline` keeps download managers from treating this page sub-resource as
    // a file the user asked for (see host/css.mjs).
    'content-disposition': 'inline',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
  })
  res.end(method === 'HEAD' ? undefined : body)
}

const failure = (code, message) => ({ ok: false, error: { code, message } })

/**
 * Serve the language catalogues for this plugin.
 * @param options.file - absolute path of the JSON file (a file URL is accepted).
 * @param options.warn - logger for a missing or malformed catalogue.
 * @returns an HTTP handler for the plugin's own route.
 */
export function createLangHandler({ file, warn = console.warn }) {
  return async (req, res) => {
    const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, failure('method-not-allowed', '只支持 GET 与 HEAD。'), method)
      return
    }
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      warn(`original-version-enhancements: could not read the language catalogue: ${error instanceof Error ? error.message : String(error)}`)
      send(res, 500, failure('catalogue-unreadable', '无法读取语言文件 locale/lang.json。'), method)
      return
    }
    if (Buffer.byteLength(text) > MAX_BYTES) {
      warn(`original-version-enhancements: the language catalogue exceeds ${MAX_BYTES} bytes`)
      send(res, 500, failure('catalogue-too-large', '语言文件过大。'), method)
      return
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      // Report the syntax error rather than shipping a body the client cannot
      // parse: an edit that breaks the file is the likeliest failure here.
      warn(`original-version-enhancements: locale/lang.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      send(res, 500, failure('catalogue-invalid', `语言文件不是有效 JSON：${error instanceof Error ? error.message : String(error)}`), method)
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      send(res, 500, failure('catalogue-invalid', '语言文件必须是 { "zh": {...}, "en": {...} } 形式的对象。'), method)
      return
    }
    send(res, 200, parsed, method)
  }
}
