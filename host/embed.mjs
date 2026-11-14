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
 * Same palette rules as the app shell. The embedded window keeps the right
 * rail (it is the only way to reach files / terminal / browser from a detached
 * conversation), so only the left sidebar and the shell's bottom strip go.
 */
const EMBED_CSS = [
  'html,body{background:transparent !important}',
  '[data-slot="sidebar"],[data-side="sidebar"],[data-shell-bottom]{display:none !important}',
  'div:has(> [data-slot="sidebar"]){display:none !important}',
  '[data-shell-overlay]{position:absolute !important}',
].join('')

/**
 * The app owns the window frame's column template and rewrites it whenever the
 * right rail opens, closes or resizes, so the left track cannot be pinned in
 * CSS without freezing the rail too. This script zeroes only the first track
 * (whatever unit the app used), in place, each time the app writes a template.
 */
const SIDEBAR_TRACK_SCRIPT = `(() => {
  const firstTrack = (template) => {
    const spans = []
    let depth = 0
    let start = 0
    for (let index = 0; index < template.length; index += 1) {
      const char = template[index]
      if (char === '(') depth += 1
      else if (char === ')') depth = Math.max(0, depth - 1)
      else if (char === ' ' && depth === 0) {
        spans.push([start, index])
        start = index + 1
      }
    }
    spans.push([start, template.length])
    for (const [from, to] of spans) {
      const token = template.slice(from, to).trim()
      if (token.length > 0 && token[0] !== '[') return [from, to]
    }
    return null
  }
  const fix = () => {
    for (const el of document.querySelectorAll('[style*="grid-template-columns"]')) {
      if (el.querySelector('[data-slot="sidebar"]') === null) continue
      const template = el.style.gridTemplateColumns
      if (!template) continue
      const span = firstTrack(template)
      if (span === null) continue
      const token = template.slice(span[0], span[1]).trim()
      if (token === '0px' || token === '0') continue
      el.style.gridTemplateColumns = template.slice(0, span[0]) + '0px' + template.slice(span[1])
    }
  }
  fix()
  const observer = new MutationObserver(fix)
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] })
  document.addEventListener('DOMContentLoaded', fix, { once: true })
  window.addEventListener('load', fix, { once: true })
})()
`

/**
 * A conversation needs a moment to mount, and the app's own skeleton is not
 * worth showing. The companion exe already paints one loading state of its own
 * and keeps it until the page says it is ready, so this script only reports
 * readiness there; a browser fallback (the in-app window) has no host, so it
 * paints the small spinner itself and lifts it once the conversation is on
 * screen (or after a long safety timeout, so a broken session can never leave
 * the window stuck on the spinner forever).
 */
const LOADING_SCRIPT = `(() => {
  const doc = document
  const root = doc.documentElement
  const bridge = window.chrome && window.chrome.webview
  const native = !!(bridge && typeof bridge.postMessage === 'function')
  const mounted = () => {
    if (!doc.querySelector('[data-slot="conversation.composer"],[data-composer-input]')) return false
    for (const el of doc.querySelectorAll('[data-content-phase]')) {
      if (el.getAttribute('data-content-phase') === 'loading') return false
    }
    return doc.querySelector('[data-chat-flow],[data-slot="conversation.view"]') !== null
  }
  let done = false
  let overlay = null
  let timer = null
  const finish = (reason) => {
    if (done) return
    done = true
    if (timer !== null) { window.clearInterval(timer); timer = null }
    doc.removeEventListener('DOMContentLoaded', check)
    window.removeEventListener('load', check)
    if (native) {
      // A timeout is not success: the host may show its own failure state.
      try { bridge.postMessage(reason === 'timeout' ? 'ove-timeout' : 'ove-ready') } catch (error) { /* the host has its own timeout */ }
      return
    }
    if (overlay === null) return
    root.classList.remove('ove-embed-loading')
    overlay.classList.add('is-done')
    window.setTimeout(() => overlay.remove(), 340)
  }
  if (!native) {
    root.classList.add('ove-embed-loading')
    overlay = doc.createElement('div')
    overlay.id = 'ove-embed-loading'
    overlay.setAttribute('role', 'status')
    overlay.setAttribute('aria-live', 'polite')
    overlay.innerHTML = '<div class="ove-load-badge" aria-hidden="true">'
      + '<svg viewBox="0 0 64 64" focusable="false"><rect width="64" height="64" rx="15" fill="#1D4ED8"/>'
      + '<path d="M16 18h32M16 27h22M16 36h32M16 45h16" fill="none" stroke="#DBEAFE" stroke-width="3.6" stroke-linecap="round"/>'
      + '<circle cx="49" cy="18" r="3.4" fill="#93C5FD"/><circle cx="43" cy="27" r="2.8" fill="#93C5FD"/>'
      + '<circle cx="49" cy="36" r="3.4" fill="#93C5FD"/><circle cx="38" cy="45" r="2.8" fill="#93C5FD"/></svg>'
      + '</div><div class="ove-load-text">正在载入会话…</div>'
      + '<div class="ove-load-dots" aria-hidden="true"><i></i><i></i><i></i></div>'
    ;(doc.body || root).appendChild(overlay)
  }
  const fonts = doc.fonts && typeof doc.fonts.ready === 'object' ? doc.fonts.ready.catch(() => {}) : Promise.resolve()
  const reveal = () => {
    fonts.then(() => requestAnimationFrame(() => requestAnimationFrame(() => finish('ready'))))
  }
  const check = () => {
    if (done || doc.readyState !== 'complete' || !mounted()) return
    reveal()
  }
  doc.addEventListener('DOMContentLoaded', check)
  window.addEventListener('load', check)
  timer = window.setInterval(check, 80)
  window.setTimeout(() => { finish('timeout') }, 20000)
})()`

/**
 * The detachable window boots the whole client, including the whale widget,
 * whose "last turn finished" chime is keyed on a sequence number it remembers
 * in localStorage. A freshly created WebView2 profile has no memory, so the
 * very first poll replays the last completed turn: while the audio context is
 * still suspended that chime waits for the first click and fires then, which is
 * exactly the stray beep a detached window must not make. Rebasing the first
 * sequence seen makes the boot poll a silent alignment while later turns still
 * chime normally.
 */
const LAST_TURN_GUARD_SCRIPT = `(() => {
  const nativeFetch = window.fetch
  if (typeof nativeFetch !== 'function') return
  let baseline = null
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    const answer = nativeFetch.apply(this, arguments)
    if (url.indexOf('/dsh-whale/last-turn.json') < 0) return answer
    return answer.then((response) => {
      if (!response || response.ok !== true || typeof response.clone !== 'function') return response
      return response.clone().json().then((data) => {
        if (!data || typeof data.seq !== 'number') return response
        if (baseline === null || data.seq < baseline) baseline = data.seq
        data.seq = data.seq > baseline ? data.seq - baseline : 0
        const headers = new Headers(response.headers)
        headers.delete('content-length')
        headers.delete('content-encoding')
        return new Response(JSON.stringify(data), { status: response.status, statusText: response.statusText, headers })
      }).catch(() => response)
    })
  }
})()`

/** Spinner chrome; the palette follows the shell's own boot background. */
const LOADING_CSS = [
  'html.ove-embed-loading{overflow:hidden !important}',
  '#ove-embed-loading{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:var(--dsh-boot-bg,#fff);color:#6b7280;font:14px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;opacity:1;transition:opacity .3s ease}',
  '#ove-embed-loading.is-done{opacity:0;pointer-events:none}',
  '#ove-embed-loading .ove-load-badge{position:relative;width:60px;height:60px;display:grid;place-items:center}',
  '#ove-embed-loading .ove-load-badge::before{content:"";position:absolute;inset:-6px;border-radius:50%;background:conic-gradient(from 90deg,rgba(37,99,235,0) 0deg,rgba(37,99,235,.15) 140deg,#2563eb 320deg,#93c5fd 360deg);-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.2px));mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.2px));animation:ove-load-spin 1s linear infinite}',
  '#ove-embed-loading .ove-load-badge::after{content:"";position:absolute;inset:-6px;border-radius:50%;box-shadow:0 8px 26px rgba(37,99,235,.18);animation:ove-load-breathe 2.4s ease-in-out infinite}',
  '#ove-embed-loading .ove-load-badge svg{width:38px;height:38px;border-radius:9px;box-shadow:0 4px 14px rgba(29,78,216,.28)}',
  '#ove-embed-loading .ove-load-text{letter-spacing:.04em;color:#6b7280}',
  '#ove-embed-loading .ove-load-dots{display:flex;gap:6px;height:8px}',
  '#ove-embed-loading .ove-load-dots i{width:6px;height:6px;border-radius:50%;background:#bfdbfe;animation:ove-load-dot 1.2s ease-in-out infinite}',
  '#ove-embed-loading .ove-load-dots i:nth-child(2){animation-delay:.16s}',
  '#ove-embed-loading .ove-load-dots i:nth-child(3){animation-delay:.32s}',
  '@keyframes ove-load-spin{to{transform:rotate(360deg)}}',
  '@keyframes ove-load-breathe{0%,100%{opacity:.35;transform:scale(.96)}50%{opacity:.9;transform:scale(1.04)}}',
  '@keyframes ove-load-dot{0%,80%,100%{transform:translateY(0);background:#bfdbfe}40%{transform:translateY(-5px);background:#2563eb}}',
  '@media (prefers-color-scheme:dark){#ove-embed-loading{background:var(--dsh-boot-bg,#151517);color:#9ca3af}#ove-embed-loading .ove-load-text{color:#9ca3af}#ove-embed-loading .ove-load-badge::after{box-shadow:0 8px 26px rgba(37,99,235,.3)}}',
  '@media (prefers-reduced-motion:reduce){#ove-embed-loading .ove-load-badge::before,#ove-embed-loading .ove-load-badge::after,#ove-embed-loading .ove-load-dots i{animation:none}}',
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
    `<style data-ove-embed>${EMBED_CSS}${LOADING_CSS}</style>`,
    `<script data-ove-embed-boot>${LOADING_SCRIPT}</script>`,
    `<script data-ove-embed-track>${SIDEBAR_TRACK_SCRIPT}</script>`,
    `<script data-ove-embed-audio>${LAST_TURN_GUARD_SCRIPT}</script>`,
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
