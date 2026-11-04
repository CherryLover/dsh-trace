import test from 'node:test'
import assert from 'node:assert/strict'
import { createRecorder, cleanFailure } from '../core.js'

function fixture(extra = {}) {
  const state = { attempts: [] }
  let tick = 1000
  const recorder = createRecorder({ state, changed() {}, position: () => ({ turn: 1, step: 1 }), now: () => tick++, monotonic: () => tick++, ...extra })
  return { state, recorder }
}
const options = { sessionId: 'session', provider: 'test', model: 'model' }
async function collect(stream) { const result = []; for await (const chunk of stream) result.push(chunk); return result }

test('forwards identical chunks and measures successful output with diagnostic content', async () => {
  const { state, recorder } = fixture()
  const chunks = [{ type: 'text-delta', text: 'secret prompt and response', index: 0 }, { type: 'finish', reason: { kind: 'stop' } }]
  const result = await collect(recorder.observe(options, async function* () { yield* chunks }))
  assert.equal(result[0], chunks[0])
  assert.equal(result[1], chunks[1])
  assert.equal(state.attempts[0].status, 'stop')
  assert.equal(state.attempts[0].outputChunks, 1)
  assert.ok(state.attempts[0].firstOutputMs >= 0)
  assert.ok(state.attempts[0].durationMs >= 0)
  assert.equal(state.attempts[0].response.events[0].data.text, 'secret prompt and response')
  assert.equal(state.attempts[0].request.value.provider, 'test')
})
test('rethrows original failure and records partial output', async () => {
  const { state, recorder } = fixture()
  const failure = new Error('network failed')
  await assert.rejects(collect(recorder.observe(options, async function* () { yield { type: 'reasoning-delta', text: 'x' }; throw failure })), error => error === failure)
  assert.equal(state.attempts[0].status, 'error')
  assert.equal(state.attempts[0].outputChunks, 1)
})
test('links retries only with observed retry evidence', async () => {
  let retryEvent
  const { state, recorder } = fixture({ position: () => ({ turn: 1, step: 1, ...(retryEvent ? { retryEvent } : {}) }) })
  await collect(recorder.observe(options, async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'bad gateway', status: 502, code: 'http' } } } }))
  retryEvent = { provider: 'test', retryId: 'chain', retry: 1, delayMs: 100 }
  await collect(recorder.observe(options, async function* () { yield { type: 'finish', reason: { kind: 'stop' } } }))
  assert.equal(state.attempts[1].retryOf, state.attempts[0].id)
  assert.ok(state.attempts[1].retryGapMs >= 0)
  assert.equal(state.attempts[0].failure.status, 502)
})
test('consumer return and abort are accurately distinguished', async () => {
  const { state, recorder } = fixture()
  const iterator = recorder.observe(options, async function* () { yield { type: 'text-delta', text: 'x' }; yield { type: 'text-delta', text: 'y' } })
  await iterator.next(); await iterator.return()
  assert.equal(state.attempts[0].status, 'interrupted')
  const controller = new AbortController(); controller.abort()
  await collect(recorder.observe({ ...options, signal: controller.signal }, async function* () {}))
  assert.equal(state.attempts[1].status, 'aborted')
})
test('observer setup failure never changes stream output', async () => {
  const { recorder } = fixture({ position() { throw new Error('observer unavailable') } })
  const chunk = { type: 'usage', usage: {} }
  assert.equal((await collect(recorder.observe(options, async function* () { yield chunk })))[0], chunk)
})
test('caps retained attempts and skips unscoped requests', async () => {
  const { state, recorder } = fixture({ limit: 2 })
  for (let i = 0; i < 4; i++) await collect(recorder.observe(options, async function* () {}))
  assert.equal(state.attempts.length, 2)
  assert.equal(state.truncated, true)
  await collect(recorder.observe({}, async function* () {}))
  assert.equal(state.attempts.length, 2)
})
test('redacts credentials and URLs and bounds messages', () => {
  const value = cleanFailure({ code: 'http', message: 'Bearer private_secret token=secret https://user:pass@example.com/path?key=secret sk-1234567890123456 ' + 'x'.repeat(2000) })
  assert.ok(!value.message.includes('private_secret'))
  assert.ok(!value.message.includes('example.com'))
  assert.ok(!value.message.includes('token=secret'))
  assert.equal(value.message.length, 1200)
  assert.equal(value.truncated, true)
})
