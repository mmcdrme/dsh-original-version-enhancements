// Tests for the subagent rename route: the shipped `session/rename` RPC hands
// subagent-routed Sessions to subagent delivery (and refuses), so the route
// writes the same user `session/title` event through the official title
// service when the child is loaded, or the persistence write handle otherwise.

import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

const moduleUrl = new URL('../host/rename-session.mjs', import.meta.url)
const { createRenameRequestHandler, normalizeTitle, renameSubagentSession } = await import(moduleUrl)

const SESSION_ID = '356c1e4a-f09c-4707-9625-68e0b7529e74'

/** A persistence write handle over an in-memory event log. */
const memoryHandle = (header, events = []) => {
  const log = [...events]
  return {
    id: header.id,
    header,
    appended: [],
    closed: false,
    async read(offset = 0, length = log.length - offset) {
      return { eventState: 'detached', events: log.slice(offset, offset + length) }
    },
    async append(batch) {
      for (const event of batch) log.push(event)
      this.appended.push(...batch)
    },
    async flush() {},
    async close() { this.closed = true },
  }
}

const SUBAGENT_HEADER = { version: 4, id: SESSION_ID, createdAt: 1, cwd: 'C:/work', origin: 'subagent', isSeeded: false }

test('normalizeTitle follows the shipped rules', () => {
  assert.equal(normalizeTitle('  两个  空格  '), '两个 空格')
  assert.equal(normalizeTitle('\u001b[31mred\u001b[0m'), 'red')
  assert.equal(normalizeTitle('a\u0000b'), 'ab')
  assert.equal(normalizeTitle('   '), '')
})

test('normalizeTitle truncates to the byte budget without splitting code points', () => {
  // Each CJK character is three bytes; a 7-byte budget fits two of them.
  assert.equal(normalizeTitle('一二三四五', 7), '一二')
  // An emoji is four bytes and must not be cut in half.
  assert.equal(normalizeTitle('ab😀😀', 7), 'ab😀')
  assert.equal(normalizeTitle('ab😀', 6), 'ab😀')
})

test('a loaded child is renamed through the official title service', async () => {
  const calls = []
  const live = { id: SESSION_ID, header: SUBAGENT_HEADER }
  const result = await renameSubagentSession({
    sessions: { get: id => (id === SESSION_ID ? live : undefined) },
    sessionPersistence: { open: async () => { throw new Error('should not open a write handle') } },
    sessionTitle: () => ({
      config: { maxTitleBytes: 80 },
      rename: (session, title) => { calls.push({ session, title }); return { title, eventSeq: 42 } },
    }),
  }, SESSION_ID, '  新的名字  ')
  assert.deepEqual(result, { ok: true, value: { title: '新的名字', seq: 42 } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].session, live)
})

test('an unloaded child gets the same session/title event through persistence', async () => {
  const handle = memoryHandle(SUBAGENT_HEADER, [
    { type: 'permission/preset', seq: 0, time: 1, data: { preset: 'workspace-write' } },
    { type: 'session/title', seq: 1, time: 2, data: { title: '旧名字', messageSeqs: [], source: { kind: 'fallback' } } },
  ])
  const result = await renameSubagentSession({
    sessions: { get: () => undefined },
    sessionPersistence: {
      open: async (id, access) => { assert.equal(id, SESSION_ID); assert.equal(access, 'write'); return handle },
      stat: async () => ({ eventCount: 2 }),
    },
    sessionTitle: () => ({ config: { maxTitleBytes: 80 } }),
  }, SESSION_ID, '新名字')
  assert.deepEqual(result, { ok: true, value: { title: '新名字', seq: 2 } })
  assert.equal(handle.appended.length, 1)
  assert.deepEqual(handle.appended[0].data, { title: '新名字', messageSeqs: [], source: { kind: 'user' } })
  assert.equal(handle.appended[0].seq, 2)
  assert.equal(handle.closed, true)
})

test('an empty title is refused before any write', async () => {
  const result = await renameSubagentSession({
    sessions: { get: () => undefined },
    sessionPersistence: { open: async () => { throw new Error('must not open') } },
    sessionTitle: () => ({ config: { maxTitleBytes: 80 } }),
  }, SESSION_ID, '   ')
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'title-invalid')
})

test('an ordinary Session is refused by the subagent route', async () => {
  const header = { ...SUBAGENT_HEADER, origin: undefined }
  const handle = memoryHandle(header)
  const result = await renameSubagentSession({
    sessions: { get: () => undefined },
    sessionPersistence: { open: async () => handle },
    sessionTitle: () => undefined,
  }, SESSION_ID, '名字')
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'not-subagent')
  assert.equal(handle.closed, true)
})

test('a write-owned child is reported as busy', async () => {
  const error = new Error('owned')
  error.name = 'SessionAlreadyOwnedError'
  const result = await renameSubagentSession({
    sessions: { get: () => undefined },
    sessionPersistence: { open: async () => { throw error } },
    sessionTitle: () => undefined,
  }, SESSION_ID, '名字')
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'session-busy')
})

test('the HTTP boundary requires the confirmation header', async () => {
  const responses = []
  const handler = createRenameRequestHandler({
    isTrustedRequest: () => true,
    rename: async () => ({ ok: true, value: { title: 'x', seq: 1 } }),
  })
  const request = (headers = {}) => {
    const body = JSON.stringify({ sessionId: SESSION_ID, title: 'x' })
    return Object.assign(Readable.from([Buffer.from(body)]), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
    })
  }
  const res = {
    writeHead(status) { this.status = status },
    end(payload) { responses.push({ status: this.status, body: JSON.parse(payload) }) },
  }
  await handler(request({}), res)
  assert.equal(responses[0].status, 403)
  await handler(request({ 'x-dsh-session-rename-confirmation': 'rename-session' }), res)
  assert.equal(responses[1].status, 200)
  assert.deepEqual(responses[1].body, { ok: true, value: { title: 'x', seq: 1 } })
})
