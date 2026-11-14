// Unit tests for the embedded conversation document.
//
// The Host rewrites the injected index for the detached window: it hides the
// left sidebar, keeps the right rail usable, paints a loading state, and stops
// the whale widget from replaying the last finished turn on a fresh profile.

import assert from 'node:assert/strict'
import test from 'node:test'

import { renderEmbed } from '../host/embed.mjs'

const INDEX = '<!doctype html><html><head><title>DSH</title></head><body><div id="root"></div></body></html>'
const embed = renderEmbed(INDEX, 'http://127.0.0.1:4850')

/** Pull the body of every injected script tag, in document order. */
const scripts = (html) => [...html.matchAll(/<script[^>]*data-ove-embed[^>]*>([\s\S]*?)<\/script>/gu)].map((match) => match[1])

test('the embedded document keeps its own transport and base', () => {
  assert.match(embed, /<base href="\/">/u)
  assert.match(embed, /window\.__DSH_TRANSPORT__=\{"ownsHost":true,"streamBaseUrl":"http:\/\/127\.0\.0\.1:4850"\}/u)
  assert.match(embed, /window\.__OVE_EMBED__=true/u)
})

test('the left sidebar is hidden but the right rail is left alone', () => {
  assert.match(embed, /\[data-slot="sidebar"\],\[data-side="sidebar"\],\[data-shell-bottom\]\{display:none !important\}/u)
  // The right rail must stay in the layout: hiding its column was what made
  // "打开右侧边栏" do nothing in the detached window.
  assert.doesNotMatch(embed, /\[data-rightbar-col\]/u)
  assert.doesNotMatch(embed, /grid-template-columns:0 minmax\(0,1fr\) 0/u)
  // The frame's column template belongs to the app; only the first track is
  // rewritten, and only at runtime. It must not assume a `px` unit.
  assert.match(embed, /const firstTrack = \(template\) =>/u)
  assert.match(embed, /token\[0\] !== '\['/u)
})

test('the loading state is reported to the companion window, not doubled', () => {
  // The exe paints the one loading state; the page only says when it is done.
  assert.match(embed, /window\.chrome && window\.chrome\.webview/u)
  assert.match(embed, /postMessage\(reason === 'timeout' \? 'ove-timeout' : 'ove-ready'\)/u)
  // The in-page spinner survives only for the browser fallback.
  assert.match(embed, /if \(!native\) \{/u)
  assert.match(embed, /id = 'ove-embed-loading'/u)
  assert.match(embed, /@keyframes ove-load-spin/u)
  assert.match(embed, /conversation\.composer/u)
})

test('the page never reports success when it only timed out', () => {
  assert.match(embed, /reason === 'timeout' \? 'ove-timeout' : 'ove-ready'/u)
  assert.match(embed, /if \(timer !== null\) \{ window\.clearInterval\(timer\); timer = null \}/u)
  assert.match(embed, /finish\('timeout'\)/u)
})

test('the boot chime of a fresh window is rebased instead of replayed', () => {
  assert.match(embed, /\/dsh-whale\/last-turn\.json/u)
  assert.match(embed, /data\.seq = data\.seq > baseline \? data\.seq - baseline : 0/u)
})

test('every injected script parses on its own', () => {
  const bodies = scripts(embed)
  assert.ok(bodies.length >= 3, `expected at least three injected scripts, got ${bodies.length}`)
  for (const body of bodies) {
    assert.doesNotThrow(() => new Function(body))
  }
  // Two statements concatenated without a separator used to produce
  // `})()(() => {` — one script per concern keeps that from coming back.
  for (const body of bodies) assert.doesNotMatch(body, /\}\)\(\(\(\)/u)
})
