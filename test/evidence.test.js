import test from 'node:test'
import assert from 'node:assert/strict'
import { snapshot, errorEvidence, summary, recordChunk, appendError } from '../evidence.js'
import { createRecorder } from '../core.js'

test('snapshot counts UTF-8 normalized JSON, redacts credentials and keeps source explicit', () => {
  const original = { model: '模型', api_key: 'hidden-value', headers: { Authorization: 'Bearer hidden-bearer', 'X-Api-Key': 'hidden-header', 'X-Auth-Token': 'hidden-header-token' }, url: 'https://user:password@example.com/v1?token=hidden-query', signal: new AbortController().signal }
  const result = snapshot(original)
  assert.equal(result.bytes, Buffer.byteLength(JSON.stringify({ ...original, signal: undefined })))
  assert.match(result.source, /not wire/)
  assert.equal(result.value.model, '模型')
  assert.equal(result.value.api_key, '[redacted]')
  for (const secret of ['hidden-value', 'hidden-bearer', 'hidden-query', 'hidden-header', 'hidden-header-token', 'user:password']) assert.ok(!result.text.includes(secret))
  assert.equal(original.api_key, 'hidden-value')
})
test('snapshot is bounded, circular values and hostile getters fail open', () => {
  const result = snapshot({ text: '字'.repeat(1000) }, 128)
  assert.equal(result.truncated, true)
  assert.ok(result.retainedBytes <= 128)
  assert.ok(!result.text.includes('\uFFFD'))
  const circular = {}; circular.self = circular
  assert.equal(snapshot(circular).unavailable, true)
  assert.equal(snapshot({ get malicious() { throw new Error('getter') } }).unavailable, true)
})
test('errors preserve codes, stages and bounded causes without throwing', () => {
  const cause = Object.assign(new Error('socket closed'), { code: 'ECONNRESET', syscall: 'read' })
  const error = new Error('request failed', { cause })
  const result = errorEvidence(error, 'stream-iteration', 123)
  assert.equal(result.observedAt, 123)
  assert.equal(result.causes[0].code, 'ECONNRESET')
  assert.equal(result.causes[0].syscall, 'read')
  assert.ok(result.stack.includes('request failed'))
  assert.doesNotThrow(() => errorEvidence({ get message() { throw error }, get cause() { throw error } }, 'test'))
})
test('bounded errors explicitly flag truncated fields and excess observations', () => {
  assert.equal(errorEvidence({ message: 'short', stack: 'x'.repeat(20000) }, 'test').truncated, true)
  const attempt = {}
  for (let i = 0; i < 30; i++) appendError(attempt, 'failure', 'test', i)
  assert.equal(attempt.errors.length, 24)
  assert.equal(attempt.errorsTruncated, true)
  assert.equal(summary(attempt).errorCount, 30)
})
test('usage reports latest provider values, absent fields remain absent; response is bounded', () => {
  const attempt = { response: { events: [], observedChunks: 0, observedJsonBytes: 0, capturedBytes: 0, truncated: false } }
  recordChunk(attempt, { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }, 1)
  recordChunk(attempt, { type: 'usage', usage: { inputTokens: 3, outputTokens: 5, cacheReadTokens: 1 } }, 2)
  assert.deepEqual(attempt.usage, { inputTokens: 3, outputTokens: 5, cacheReadTokens: 1 })
  assert.equal(attempt.usage.totalTokens, undefined)
  recordChunk(attempt, { type: 'text-delta', text: 'x'.repeat(300000) }, 3)
  assert.equal(attempt.response.truncated, true)
  assert.equal(attempt.response.observedChunks, 3)
  assert.ok(attempt.response.capturedBytes < 262144)
})
test('single oversized and unserializable chunks explicitly mark partial response', () => {
  const attempt = { response: { events: [], observedChunks: 0, observedJsonBytes: 0, capturedBytes: 0, truncated: false } }
  recordChunk(attempt, { type: 'text-delta', text: 'x'.repeat(300000) }, 1)
  assert.equal(attempt.response.truncated, true)
  assert.equal(attempt.response.events[0].truncated, true)
  const circular = { type: 'block-end' }; circular.self = circular
  recordChunk(attempt, circular, 2)
  assert.equal(attempt.response.unavailableChunks, 1)
  assert.equal(attempt.response.observedChunks, 2)
})
test('summary excludes full payloads while retaining lightweight failure and usage', () => {
  const result = summary({ id: 'a', request: { text: 'private prompt' }, response: {}, errors: [{ message: 'detail' }], http: { exchanges: [{}] }, usage: { inputTokens: 4 }, failure: { code: 'http' } })
  assert.equal(result.request, undefined)
  assert.equal(result.response, undefined)
  assert.equal(result.errors, undefined)
  assert.equal(result.http, undefined)
  assert.equal(result.errorCount, 1)
  assert.equal(result.httpCount, 1)
  assert.equal(result.usage.inputTokens, 4)
})
test('hostile thrown values preserve exception identity and stream status', async () => {
  const state = { attempts: [] }
  const recorder = createRecorder({ state, changed() {}, position: () => ({}) })
  const error = { get message() { throw new Error('malicious getter') }, get name() { throw new Error('getter') } }
  await assert.rejects(async () => { for await (const _ of recorder.observe({ sessionId: 's', provider: 'p', model: 'm' }, async function* () { throw error })) {} }, value => value === error)
  assert.equal(state.attempts[0].status, 'error')
})
test('detail retention evicts older payloads and keeps attempt metadata', async () => {
  const state = { attempts: [] }
  const recorder = createRecorder({ state, changed() {}, position: () => ({}), detailBudget: 8000 })
  for (let i = 0; i < 3; i++) for await (const _ of recorder.observe({ sessionId: 's', provider: 'p', model: 'm', system: 'a'.repeat(2000) }, async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })) {}
  assert.equal(state.attempts.length, 3)
  assert.equal(state.attempts[0].detailsEvicted, true)
  assert.equal(state.attempts[0].request, undefined)
  assert.equal(state.attempts[2].status, 'stop')
})
