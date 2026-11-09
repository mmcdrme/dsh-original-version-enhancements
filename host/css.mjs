// Stylesheet route.
//
// The plugin's CSS lives in `css/style.css` so it can be edited on its own,
// without touching the 130 KB client bundle. Like the language catalogue, the
// file is read from disk on every request and answered with `no-store`, so an
// edit shows up on the next page refresh — no rebuild, no Host restart.

import { readFile } from 'node:fs/promises'

/** A stylesheet this size is already a mistake; never stream an unbounded file. */
const MAX_BYTES = 1024 * 1024

const send = (res, status, body, method, type = 'text/plain; charset=utf-8') => {
  res.writeHead(status, {
    'content-type': type,
    // Download managers read this header first: `inline` says this is page
    // furniture, not a file the user asked for, so IDM-class tools leave it be.
    'content-disposition': 'inline',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
  })
  res.end(method === 'HEAD' ? undefined : body)
}

/**
 * Serve this plugin's stylesheet.
 * @param options.file - absolute path of the CSS file (a file URL is accepted).
 * @param options.warn - logger for a missing or oversized stylesheet.
 * @returns an HTTP handler for the plugin's own route.
 */
export function createStyleHandler({ file, warn = console.warn }) {
  return async (req, res) => {
    const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, '只支持 GET 与 HEAD。', method)
      return
    }
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      warn(`original-version-enhancements: could not read the stylesheet: ${error instanceof Error ? error.message : String(error)}`)
      send(res, 500, '无法读取样式文件 css/style.css。', method)
      return
    }
    if (Buffer.byteLength(text) > MAX_BYTES) {
      warn(`original-version-enhancements: the stylesheet exceeds ${MAX_BYTES} bytes`)
      send(res, 500, '样式文件过大。', method)
      return
    }
    send(res, 200, text, method, 'text/css; charset=utf-8')
  }
}
