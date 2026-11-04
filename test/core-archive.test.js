import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRecorder } from '../core.js'
import { openArchive } from '../archive.js'
import { createTransport } from '../transport.js'
import { channel } from 'node:diagnostics_channel'
import { gzipSync } from 'node:zlib'

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-trace-core-archive-'))
  const archive = await openArchive({ root })
  t.after(async () => { await archive.close(); await rm(root, { recursive: true, force: true }) })
  return { root, archive }
}
async function consume(recorder, sessionId = 's1') {
  for await (const _ of recorder.observe({ sessionId, provider: 'test', model: 'model', reasoningEffort: 'high', system: 'disk evidence' }, async function* () {
    yield { type: 'reasoning-delta', text: 'reasoning evidence' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })) {}
}
test('onRecord checkpoints full evidence; canEvict prevents release until latest revision is durable', async t => {
  const { archive, root } = await fixture(t)
  const state = { attempts: [], truncated: false }, pending = new Map(), durable = new Set()
  const recorder = createRecorder({ state, changed() {}, position: () => ({}), limit: 1, detailBudget: 0,
    onRecord(attempt) { durable.delete(attempt.id); pending.set(attempt.id, structuredClone(attempt)) },
    canEvict: attempt => durable.has(attempt.id),
  })
  await consume(recorder)
  await consume(recorder)
  assert.equal(state.attempts.length, 2, 'unsaved records exceed the memory count rather than losing evidence')
  assert.ok(state.attempts.every(a => a.request && a.response && !a.cacheEvicted))
  const expected = [...pending.values()]
  for (const attempt of expected) { await archive.save(attempt); durable.add(attempt.id) }
  recorder.trimDetails()
  assert.ok(state.attempts.every(a => a.cacheEvicted && !a.request && !a.response))
  assert.ok(state.attempts.every(a => a.hasDetails && !a.detailsEvicted))
  for (const attempt of expected) assert.deepEqual(await archive.detail(attempt.sessionId, attempt.id), attempt)
  await archive.close()
  const restarted = await openArchive({ root })
  try {
    for (const attempt of expected) {
      const detail = await restarted.detail(attempt.sessionId, attempt.id)
      assert.deepEqual(detail, attempt)
      assert.equal(detail.reasoningEffort, 'high')
      assert.equal(detail.response.events[0].data.text, 'reasoning evidence')
    }
  } finally { await restarted.close() }
})
test('canEvict gates count eviction and new onRecord revisions invalidate previous save eligibility', async t => {
  const { archive } = await fixture(t)
  const state = { attempts: [], truncated: false }, durable = new Set(), snapshots = new Map()
  const recorder = createRecorder({ state, changed() {}, position: () => ({}), limit: 1, detailBudget: Infinity,
    onRecord(a) { snapshots.set(a.id, structuredClone(a)); durable.delete(a.id) }, canEvict: a => durable.has(a.id),
  })
  await consume(recorder)
  const first = state.attempts[0]
  await archive.save(snapshots.get(first.id)); durable.add(first.id)
  await consume(recorder)
  assert.equal(state.attempts.length, 1)
  assert.notEqual(state.attempts[0].id, first.id)
  assert.equal(durable.has(state.attempts[0].id), false)
  assert.equal((await archive.detail('s1', first.id)).request.value.system, 'disk evidence')
  assert.equal(state.truncated, true)
})

test('capture limits freeze per attempt, use UTF-8 request bytes and persist alongside capped response events', async t => {
  const { archive } = await fixture(t)
  const state = { attempts: [], truncated: false }
  const limits = { requestBytes: 1024, responseBytes: 1024, httpBodyBytes: 1024, responseEvents: 2 }
  const initial = { ...limits }
  const recorder = createRecorder({ state, changed() {}, position: () => ({}), captureLimits: () => limits })
  const options = { sessionId: 's1', provider: 'test', model: 'model', system: '界'.repeat(1000) }
  const chunks = [0, 1, 2].map(i => ({ type: 'text-delta', text: `chunk ${i}` }))
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
  const iterator = recorder.observe(options, async function* () { yield* chunks })
  assert.strictEqual((await iterator.next()).value, chunks[0])
  Object.assign(limits, { requestBytes: 4096, responseBytes: 4096, httpBodyBytes: 4096, responseEvents: 10 })
  const forwarded = [chunks[0]]
  for await (const chunk of iterator) forwarded.push(chunk)
  assert.deepEqual(forwarded, chunks)
  const first = state.attempts[0]
  assert.deepEqual(first.captureLimits, initial)
  assert.notStrictEqual(first.captureLimits, limits)
  assert.equal(first.request.truncated, true)
  assert.equal(first.request.value, undefined)
  assert.ok(first.request.retainedBytes <= initial.requestBytes)
  assert.equal(first.request.text.includes('\uFFFD'), false)
  assert.equal(first.response.events.length, 2)
  assert.equal(first.response.observedChunks, chunks.length)
  assert.equal(first.response.truncated, true)
  assert.equal(first.status, 'stop', 'event cap does not alter the observed finish outcome')
  await consume(recorder)
  const second = state.attempts[1]
  assert.deepEqual(second.captureLimits, limits)
  assert.equal(second.request.truncated, false)
  assert.equal(second.response.events.length, 2)
  assert.equal(second.response.truncated, false)
  for (const attempt of state.attempts) {
    await archive.save(attempt)
    assert.deepEqual(await archive.detail('s1', attempt.id), attempt)
  }
})
test('response byte cap limits event JSON but still observes usage and finish metadata', async t => {
  const { archive } = await fixture(t)
  const state = { attempts: [], truncated: false }
  const recorder = createRecorder({ state, changed() {}, position: () => ({}),
    captureLimits: () => ({ requestBytes: 1024, responseBytes: 1024, httpBodyBytes: 1024, responseEvents: 100 }),
  })
  const chunks = [
    { type: 'text-delta', text: '界'.repeat(1000) },
    { type: 'usage', usage: { outputTokens: 20, reasoningTokens: 10 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const forwarded = []
  for await (const chunk of recorder.observe({ sessionId: 's1', provider: 'test', model: 'model' }, async function* () { yield* chunks })) forwarded.push(chunk)
  chunks.forEach((chunk, i) => assert.strictEqual(forwarded[i], chunk))
  const attempt = state.attempts[0]
  assert.equal(attempt.response.truncated, true)
  assert.equal(attempt.response.observedChunks, 3)
  assert.ok(attempt.response.observedJsonBytes > 1024)
  assert.ok(attempt.response.capturedBytes <= 1024)
  assert.equal(attempt.response.events.length, 1)
  assert.equal(attempt.response.events[0].truncated, true)
  assert.equal(attempt.response.events[0].data.includes('\uFFFD'), false)
  assert.equal(attempt.usage.reasoningTokens, 10)
  assert.equal(attempt.status, 'stop')
  assert.equal(attempt.response.finish.kind, 'stop')
  await archive.save(attempt)
  assert.deepEqual(await archive.detail('s1', attempt.id), attempt)
})
test('per-attempt HTTP body limit caps capture and decompression with larger limits applying only to next attempt', async t => {
  const { archive } = await fixture(t)
  const transport = createTransport()
  t.after(() => transport.dispose())
  const state = { attempts: [], truncated: false }
  let httpBodyBytes = 1024
  const recorder = createRecorder({ state, transport, changed() {}, position: () => ({}), captureLimits: () => ({ httpBodyBytes }) })
  const emit = (name, payload) => channel(`undici:request:${name}`).publish(payload)
  const requestText = JSON.stringify({ text: 'x'.repeat(2000) })
  const responseText = JSON.stringify({ text: 'y'.repeat(2000) })
  const compressed = gzipSync(responseText)
  async function capture() {
    for await (const _ of recorder.observe({ sessionId: 's1', provider: 'test', model: 'model' }, async function* () {
      const request = { origin: 'https://example.test', path: '/limits', method: 'POST', headers: ['content-type', 'application/json'] }
      emit('create', { request })
      emit('bodyChunkSent', { request, chunk: Buffer.from(requestText) })
      emit('bodySent', { request })
      emit('headers', { request, response: { statusCode: 200, headers: ['content-type', 'application/json', 'content-encoding', 'gzip'] } })
      emit('bodyChunkReceived', { request, chunk: compressed })
      emit('trailers', { request, trailers: [] })
      yield { type: 'finish', reason: { kind: 'stop' } }
    })) {}
  }
  await capture()
  const small = state.attempts[0].http.exchanges[0]
  assert.equal(small.request.body.capturedBytes, 1024)
  assert.equal(small.request.body.truncated, true)
  assert.equal(small.request.body.available, false)
  assert.equal(small.response.body.available, false)
  assert.match(small.response.body.reason, /decod.*limit/i)
  httpBodyBytes = 4096
  await capture()
  const large = state.attempts[1].http.exchanges[0]
  assert.equal(large.request.body.available, true)
  assert.equal(large.request.body.text, requestText)
  assert.equal(large.response.body.available, true)
  assert.equal(large.response.body.text, responseText)
  assert.equal(large.response.body.decodedBytes, Buffer.byteLength(responseText))
  for (const attempt of state.attempts) {
    await archive.save(attempt)
    assert.deepEqual(await archive.detail('s1', attempt.id), attempt)
  }
})
