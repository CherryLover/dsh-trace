import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { classifyError, summary, errorEvidence, ERROR_CATEGORIES } from '../evidence.js'
import { openArchive } from '../archive.js'
import { apply } from '../index.js'

test('stable categories use status, code, name and actual errors, never prompts', () => {
  assert.deepEqual(ERROR_CATEGORIES, ['timeout','network','auth','rate-limit','overload','provider','upstream-request','input','context','unknown'])
  for (const [error, expected] of [
    [{ status: 500, message: 'timeout in provider' }, 'provider'], [{ status: '503' }, 'provider'], [{ status: 429 }, 'rate-limit'],
    [{ code: 'AUTH' }, 'auth'], [{ code: 'SERVER' }, 'provider'], [{ code: 'TRANSPORT', message: 'terminated' }, 'network'],
    [{ statusCode: 401 }, 'auth'], [{ status: 403 }, 'auth'], [{ code: 'ETIMEDOUT' }, 'timeout'], [{ name: 'TimeoutError' }, 'timeout'],
    [{ code: 'ECONNRESET' }, 'network'], [{ message: 'fetch failed' }, 'network'], [{ status: 422 }, 'input'],
    [{ code: 'context_length_exceeded' }, 'context'], [{ message: 'maximum context length reached' }, 'context'], [{ message: 'new mystery' }, 'unknown'],
    [{ name: 'AbortError' }, null], [{ code: 'ERR_CANCELED' }, null], [{ message: 'interrupted' }, null],
  ]) assert.equal(classifyError(error), expected, JSON.stringify(error))
  const normal = summary({ status: 'stop', request: { value: { prompt: 'timeout HTTP 429 context_length_exceeded' } }, response: { events: [{ text: 'network error' }] } })
  assert.deepEqual(normal.errorCategories, [])
  assert.equal(normal.hasAnomaly, false)
  const nested = summary({ status: 'error', errors: [errorEvidence({ message: 'API failed', body: { error: { code: 'context_length_exceeded', message: 'too many tokens' }, prompt: 'auth network timeout' } }, 'adapter-finish', 1)] })
  assert.ok(nested.errorCategories.includes('context'))
  assert.ok(!nested.errorCategories.includes('auth'))
  assert.equal(errorEvidence({ statusCode: '503' }, 'test').statusCode, 503)
  const wire = summary({ status: 'error', http: { exchanges: [{ request: { body: { text: 'auth timeout' } }, response: { status: 400, body: { available: true, format: 'json', text: JSON.stringify({ error: { code: 'context_length_exceeded', message: 'actual context error detail' }, prompt: 'network timeout' }) } } }] } })
  assert.ok(wire.errorCategories.includes('context'))
  assert.equal(wire.errorEvidence[0].message, 'actual context error detail')
  assert.ok(!wire.errorCategories.includes('network'))
})

test('transport and connection failures reclassify old unknown summaries without inventing HTTP evidence', () => {
  for (const error of [{code:'transport',message:'Connection error.'},{name:'APIConnectionError',message:'Connection error.'},{message:'connection failed'}]) assert.equal(classifyError(error),'network')
  const old = {status:'stop',errorEvidence:[{category:'unknown',code:'transport',message:'Connection error.',stage:'adapter-finish'}],errorCategories:['unknown']}
  const result = summary(old)
  assert.deepEqual(result.errorCategories,['network'])
  assert.equal(result.errorEvidence[0].stage,'adapter-finish')
  assert.equal(result.errorEvidence[0].status,undefined)
  assert.deepEqual(summary(result),result)
  assert.deepEqual(summary({status:'error',errors:[{message:'Unrecognized failure'}]}).errorCategories,['unknown'])
})

test('upstream overload and processing failures reclassify historical summaries without guessing outages', () => {
  const processing = 'An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID fixture-request in your message.'
  const overload = 'Our servers are currently overloaded. Please try again later.'
  for (const [error, expected] of [
    [{code:'PI_AI_ERROR',message:overload},'overload'],
    [{status:503,message:overload},'overload'],
    [{code:'overloaded_error'},'overload'],
    [{status:429,message:overload},'rate-limit'],
    [{status:401,message:overload},'auth'],
    [{code:'PI_AI_ERROR',message:processing},'upstream-request'],
    [{status:500,message:processing},'provider'],
    [{code:'server_error'},'provider'],
    [{code:'PI_AI_ERROR',message:'help.openai.com status.openai.com'},'unknown'],
    [{code:'PI_AI_ERROR',message:'new mystery'},'unknown'],
  ]) assert.equal(classifyError(error),expected,JSON.stringify(error))
  for (const [message, previous, expected] of [[overload,'provider','overload'],[processing,'unknown','upstream-request']]) {
    const result = summary({status:'error',errorEvidence:[{code:'PI_AI_ERROR',category:previous,message,stage:'adapter-finish'}],errorCategories:[previous]})
    assert.deepEqual(result.errorCategories,[expected])
    assert.equal(result.errorEvidence[0].message,message)
    assert.equal(result.errorEvidence[0].status,undefined)
    assert.deepEqual(summary(result),result)
  }
  assert.deepEqual(summary({status:'stop',request:{value:{prompt:processing}},response:{events:[{text:overload}]}}).errorCategories,[])
})

test('summary is bounded, redacted, idempotent and keeps actual diagnostic messages', () => {
  const attempt = { status: 'error', errors: [errorEvidence({ code: 'ETIMEDOUT', message: 'upstream timed out token=secret-value ' + 'x'.repeat(3000), cause: { code: 'ECONNRESET', message: 'socket closed' } }, 'stream', 42)], http: { exchanges: [{ response: { status: 429 } }] } }
  const result = summary(attempt)
  assert.deepEqual(result.errorCategories, ['timeout','network','rate-limit'])
  assert.ok(result.errorEvidence.every(e => e.message.length <= 1200))
  assert.ok(!JSON.stringify(result).includes('secret-value'))
  assert.equal(result.errorEvidence[0].observedAt, 42)
  assert.deepEqual(summary(result), result)
  assert.equal(result.errors, undefined)
  for (const status of ['aborted','interrupted','cancelled']) {
    const cancelled = summary({ status, errors: [{ message: 'fetch failed' }], failure: { message: 'fetch failed' } })
    assert.deepEqual(cancelled.errorCategories, [])
    assert.equal(cancelled.hasAnomaly, false)
  }
  assert.equal(summary({ status: 'error', errors: [{ name: 'AbortError', message: 'operation aborted' }] }).hasAnomaly, false)
})

test('archive reasons distinguish unknown historical eviction, migration and real cleanup; old evidence fallback', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-backend-regression-'))
  const archive = await openArchive({ root })
  t.after(async () => { await archive.close(); await rm(root, { recursive: true, force: true }) })
  const make = extra => ({ id: randomUUID(), sessionId: 's', status: 'stop', startedAt: 1, ...extra })
  const old = await archive.save(make({ detailsEvicted: true }))
  assert.equal(old.detailsUnavailableReason, 'unavailable')
  const legacy = await archive.save(make({ hasDetails: false, detailsUnavailableReason: 'legacy-summary-only' }))
  assert.equal(legacy.detailsUnavailableReason, 'legacy-summary-only')
  const detail = await archive.save(make({ request: { text: 'body' }, errors: [{ status: 429, message: 'specific provider quota failure' }] }))
  assert.deepEqual(detail.errorCategories, ['rate-limit'])
  assert.equal(detail.detailsUnavailableReason, undefined)
  await archive.cleanup({ budgetBytes: 0, preserveErrors: false })
  const cleaned = (await archive.list('s')).find(a => a.id === detail.id)
  assert.equal(cleaned.detailsUnavailableReason, 'disk-budget-cleanup')
  assert.equal(cleaned.errorEvidence[0].message, 'specific provider quota failure')
  const file = path.join(root, 'index', createHash('sha256').update('s').digest('hex') + '.json')
  const index = JSON.parse(await readFile(file, 'utf8'))
  const item = index.attempts.find(a => a.id === detail.id)
  delete item.errorCategories; delete item.errorEvidence
  item.failure = { code: 'ETIMEDOUT', message: 'historical upstream timed out' }
  await writeFile(file, JSON.stringify(index))
  assert.deepEqual((await archive.list('s')).find(a => a.id === detail.id).errorCategories, ['timeout'])
})

async function host(t, legacyTruncated) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-host-regression-'))
  const effects = [], routes = new Map(), listeners = new Map(), tools = new Map()
  const metadata = { installedAt: 1, truncated: legacyTruncated, attempts: [{ id: 'legacy', sessionId: 's', status: 'stop' }] }
  let saved = metadata
  let currentConfig = { directory: root, memoryCacheMiB: 1, memoryAttemptLimit: 1 }
  const entry = { options: { name: '@local/dsh-trace' } }
  const editor = { entries: () => [entry], edit: async (_entry, change) => { currentConfig = change(currentConfig, {}) } }
  await apply({
    storageDomain: { open: async () => ({ global: { get: () => saved, set: async v => { saved = v } }, close: async () => {} }) },
    effect: fn => { const cleanup = fn(); if (cleanup) effects.push(cleanup) },
    on: (name, fn) => listeners.set(name, fn), sessions: { get: () => ({}) },
    sessionProjections: { register() {}, stateOf: () => ({}) },
    connection: { fetch: { register: route => { routes.set(route.path, route); return () => {} } } },
    get: name => name === 'configEditor' ? editor : name === 'tools' ? ({ register: tool => { tools.set(tool.name, tool); return () => {} } }) : undefined,
  }, { get: () => currentConfig })
  t.after(async () => { for (const cleanup of effects.toReversed()) await cleanup(); await rm(root, { recursive: true, force: true }) })
  const query = async (route, body) => (await routes.get('/api/dsh-trace/' + route).fetch(new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }))).json()
  return { query, listeners, tools }
}

test('host migration reason, cache trims, legacy truncation and settings global status', async t => {
  for (const legacyTruncated of [false, true]) await t.test(String(legacyTruncated), async t => {
    const fixture = await host(t, legacyTruncated)
    const before = (await fixture.query('session', { sessionId: 's' })).value
    assert.equal(before.attempts[0].detailsUnavailableReason, 'legacy-summary-only')
    for (let i = 0; i < 3; i++) {
      for await (const _ of fixture.listeners.get('llm/stream')({ sessionId: 's', provider: 'p', model: 'm', system: 'x'.repeat(300000) }, async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })) {}
      await fixture.query('session', { sessionId: 's' })
    }
    const after = (await fixture.query('session', { sessionId: 's' })).value
    assert.equal(after.truncated, legacyTruncated)
    assert.equal(after.attempts.length, 4)
    assert.equal(after.attempts.filter(a => a.hasDetails).length, 3)
    const status = await fixture.query('manage', { action: 'status' })
    assert.equal(status.ok, true)
    assert.deepEqual(Object.keys(status.value.sessions[0]).sort(), ['attemptCount','detailBytes','detailCount','sessionId'])
    assert.equal(status.value.sessions[0].attemptCount, 4)
    assert.equal((await fixture.query('manage', { action: 'preview' })).ok, false)
    assert.equal((await fixture.query('manage', { action: 'cleanup' })).ok, false)
    await assert.rejects(fixture.tools.get('harness_trace_manage').execute({ action: 'status' }, {}), /current session required/)
    assert.equal((await fixture.tools.get('harness_trace_manage').execute({ action: 'status' }, { agent: { id: 's' } })).sessions, undefined)
  })
})


test('settings API and agent tool share persisted validated config without immediate deletion', async t => {
  const fixture = await host(t, false)
  const before = await fixture.query('settings', { action: 'get' })
  assert.equal(before.ok, true)
  assert.equal(before.value.backend, 'sqlite')
  assert.equal(before.value.cleanupIntervalSeconds, 600)
  assert.equal(before.value.settings.maxAttempts, 10000)
  assert.equal(before.value.settings.retentionDays, 7)
  assert.ok(before.value.databasePath.endsWith('.sqlite'))
  for (const settings of [{ maxAttempts: -1 }, { maxAttempts: 1.5 }, { retentionDays: 5 }, { directory: '/other' }, { detailBudgetMiB: -1 }]) {
    assert.equal((await fixture.query('settings', { action: 'update', settings })).ok, false)
  }
  const result = await fixture.tools.get('harness_trace_settings').execute({ action: 'update', settings: { maxAttempts: 1, retentionDays: 3, autoCleanup: false, preserveErrors: true } })
  assert.equal(result.settings.maxAttempts, 1)
  assert.equal(result.settings.retentionDays, 3)
  assert.equal((await fixture.query('session', { sessionId: 's' })).value.attempts.length, 1)
  assert.equal((await fixture.query('settings', { action: 'get' })).value.settings.retentionDays, 3)
})


test('persisted settings updates start and stop a single ten-minute cleanup scheduler', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() })
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval
  const active = new Set(), delays = []
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { const id = realSet(fn, ms); active.add(id); delays.push(ms); return id })
  t.mock.method(globalThis, 'clearInterval', id => { active.delete(id); return realClear(id) })
  const fixture = await host(t, false)
  assert.equal(active.size, 0)
  const update = settings => fixture.query('settings', { action: 'update', settings })
  assert.equal((await update({ autoCleanup: true })).value.cleanupIntervalSeconds, 600)
  assert.deepEqual(delays, [600000])
  await update({ retentionDays: 15 })
  assert.equal(active.size, 1)
  assert.equal(delays.length, 1)
  assert.equal((await update({ autoCleanup: false })).value.settings.autoCleanup, false)
  assert.equal(active.size, 0)
  await update({ autoCleanup: true })
  assert.deepEqual(delays, [600000, 600000])
})
