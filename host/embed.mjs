// Embedded client page for the detached-window panel.
//
// The Desktop shell serves the frontend as a static index.html and hands the
// boot data to the page through an Electron preload bridge, so a plain iframe
// of the app URL never boots: it has no `__ModuleLoader__` and no transport.
// This route answers the *injected* index document the Host already builds for
// browsers (same cookie, same page), then teaches it where its socket lives and
// which chrome the little window does not want.

/** An index document this size is already a mistake. */
const MAX_BYTES = 8 * 1024 * 1024

/**
 * Same palette rules as the app shell: the embedded page must not paint a
 * second sidebar, right rail, or inspector inside a small window.
 */
const EMBED_CSS = [
  'html,body{background:transparent !important}',
  '[data-slot="sidebar"],[data-side="sidebar"],[data-rightbar-col],[data-rightbar],[data-shell-bottom]{display:none !important}',
  'div:has(> [data-slot="sidebar"]){display:none !important}',
  '#root > div,[data-slot="root"] > div{grid-template-columns:0 minmax(0,1fr) 0 !important}',
  '[data-shell-overlay]{position:absolute !important}',
].join('')

const send = (res, status, body, method, type = 'text/html; charset=utf-8') => {
  res.writeHead(status, {
    'content-type': type,
    'content-disposition': 'inline',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
  })
  res.end(method === 'HEAD' ? undefined : body)
}

/**
 * Render the index document with the pieces a standalone document needs.
 * @param html - the Host's own injected index document.
 * @param baseUrl - this Host's origin, used for the socket and asset base.
 * @returns the embeddable document.
 */
export function renderEmbed(html, baseUrl) {
  const transport = JSON.stringify({ ownsHost: true, streamBaseUrl: baseUrl })
  const head = [
    '<base href="/">',
    `<script>window.__DSH_TRANSPORT__=${transport};window.__OVE_EMBED__=true;</script>`,
    `<style data-ove-embed>${EMBED_CSS}</style>`,
  ].join('')
  return /<head[^>]*>/iu.test(html)
    ? html.replace(/<head[^>]*>/iu, (tag) => `${tag}${head}`)
    : `${head}${html}`
}

/**
 * Serve the embedded client document.
 * @param options.origin - resolves this Host's own base URL.
 * @param options.warn - logger for a failed upstream read.
 * @returns an HTTP handler for the plugin's embed route.
 */
export function createEmbedHandler({ origin, warn = console.warn }) {
  return async (req, res) => {
    const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, '只支持 GET 与 HEAD。', method, 'text/plain; charset=utf-8')
      return
    }
    let baseUrl
    try {
      baseUrl = String(typeof origin === 'function' ? origin() : origin)
      new URL(baseUrl)
    } catch {
      send(res, 500, '无法确定本机服务地址。', method, 'text/plain; charset=utf-8')
      return
    }
    // The caller's own cookie is the identity this page would have had: reuse
    // it rather than minting a second peer.
    const cookie = typeof req.headers.cookie === 'string' ? req.headers.cookie : ''
    let html
    try {
      const response = await fetch(new URL('/', baseUrl), {
        headers: cookie.length > 0 ? { cookie } : {},
        redirect: 'manual',
      })
      if (!response.ok) throw new Error(`index answered ${response.status}`)
      html = await response.text()
    } catch (error) {
      warn(`original-version-enhancements: could not read the embedded index: ${error instanceof Error ? error.message : String(error)}`)
      send(res, 500, '无法读取应用页面。', method, 'text/plain; charset=utf-8')
      return
    }
    if (Buffer.byteLength(html) > MAX_BYTES) {
      send(res, 500, '应用页面过大。', method, 'text/plain; charset=utf-8')
      return
    }
    send(res, 200, renderEmbed(html, baseUrl), method)
  }
}
