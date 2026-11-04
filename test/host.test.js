import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { openSqliteArchive as openArchive } from '../sqlite-archive.js'

async function setup(t, { initial, root, settings = {}, withTools = false } = {}) {
  if (!root) {
    root = await mkdtemp(path.join(tmpdir(), 'dsh-trace-host-'))
    t.after(() => rm(root, { recursive: true, force: true }))
  }
  const effects = [], listeners = new Map(), routes = new Map(), tools = new Map()
  let saved = initial, projection, closed = false, disposed = false
  let value = { directory: root, ...settings }
  const ctx = {
    storageDomain: { async open(spec) {
      assert.match(spec.name, /^[a-z][a-z0-9_]*$/)
      saved ??= structuredClone(spec.global.initial)
      return { global: { get: () => saved, async set(value) { saved = spec.global.schema.parse(value) } }, async close() { closed = true } }
    } },
    effect(callback) { const cleanup = callback(); if (cleanup) effects.push(cleanup) },
    on(name, listener) { listeners.set(name, listener) },
    sessions: { get: id => ({ id }) },
    sessionProjections: { register(value) { projection = value }, stateOf: () => ({ turn: 2, step: 3 }) },
    connection: { fetch: { register(value) { routes.set(value.path, value); return () => routes.delete(value.path) } } },
  }
  if (withTools) ctx.get = name => {
    assert.equal(name, 'tools')
    return { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } }
  }
  // Model Schemastery's volatile getter, rather than mutating the initial config object.
  await apply(ctx, { get: () => value })
  const close = async () => { if (disposed) return; disposed = true; for (const effect of effects.toReversed()) await effect() }
  t.after(close)
  const request = async (route, body, raw = false) => {
    assert.ok(routes.has(route), `route registered: ${route}`)
    return (await routes.get(route).fetch(new Request(`http://localhost${route}`, { method: 'POST', body: raw ? body : JSON.stringify(body) }))).json()
  }
  return { root, listeners, routes, tools, get saved() { return saved }, get closed() { return closed }, get projection() { return projection },
    setSettings(update) { value = { ...value, ...update } },
    query: (body, raw) => request('/api/dsh-trace/session', body, raw),
    manage: (body, raw) => request('/api/dsh-trace/manage', body, raw), close }
}
async function record(fixture, { sessionId = 's1', failure, ...options } = {}) {
  for await (const _ of fixture.listeners.get('llm/stream')({ sessionId, provider: 'test', model: 'model', ...options }, async function* () {
    yield { type: 'reasoning-delta', text: 'diagnostic reasoning' }
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3, reasoningTokens: 2 } }
    yield { type: 'finish', reason: failure ? { kind: 'error', failure } : { kind: 'stop' } }
  })) {}
}

test('host isolates sessions, flushes archive and restores version2 disk evidence with metadata emptied', async t => {
  const fixture = await setup(t)
  assert.equal(fixture.routes.size, 3)
  await record(fixture)
  const result = await fixture.query({ sessionId: 's1' })
  assert.equal(result.ok, true)
  assert.equal(result.value.version, 2)
  assert.equal(result.value.archiveVersion, 1)
  assert.ok(Number.isFinite(result.value.detailsSince))
  assert.equal(result.value.attempts.length, 1)
  assert.equal(result.value.attempts[0].turn, 2)
  assert.equal((await fixture.query({ sessionId: 's2' })).value.attempts.length, 0)
  const detail = (await fixture.query({ sessionId: 's1', export: true })).value.attempts
  await fixture.close()
  assert.equal(fixture.closed, true)
  assert.equal(fixture.saved.archiveMigrated, true)
  assert.deepEqual(fixture.saved.attempts, [])
  const restored = await setup(t, { initial: fixture.saved, root: fixture.root })
  const restoredValue = (await restored.query({ sessionId: 's1' })).value
  assert.equal(restoredValue.detailsSince, result.value.detailsSince)
  assert.deepEqual(restoredValue.attempts, result.value.attempts)
  assert.deepEqual((await restored.query({ sessionId: 's1', export: true })).value.attempts, detail)
})
test('detail endpoint isolates sessions and exports full reasoning and diagnostic payloads', async t => {
  const fixture = await setup(t)
  await record(fixture, { system: 'example prompt', reasoningEffort: 'high' })
  const list = (await fixture.query({ sessionId: 's1' })).value.attempts
  assert.equal(list[0].request, undefined)
  assert.equal(list[0].reasoningEffort, 'high')
  const detail = (await fixture.query({ sessionId: 's1', attemptId: list[0].id })).value.attempt
  assert.equal(detail.request.value.system, 'example prompt')
  assert.equal(detail.request.value.reasoningEffort, 'high')
  assert.equal(detail.usage.inputTokens, 12)
  assert.equal(detail.usage.reasoningTokens, 2)
  assert.equal(detail.response.events[0].data.text, 'diagnostic reasoning')
  assert.equal((await fixture.query({ sessionId: 's2', attemptId: list[0].id })).error.code, 'not-found')
  assert.deepEqual((await fixture.query({ sessionId: 's1', export: true })).value.attempts, [detail])
})
test('invalid session and management inputs do not mutate archives', async t => {
  const fixture = await setup(t)
  for (const body of [null, {}, { sessionId: '' }, { sessionId: 1 }, { sessionId: 'x'.repeat(257) }, { sessionId: 's1', attemptId: {} }, { sessionId: 's1', attemptId: '../a' }, { sessionId: 's1', export: 'yes' }]) {
    assert.equal((await fixture.query(body)).error.code, 'bad-request')
  }
  assert.equal((await fixture.query('{', true)).error.code, 'bad-request')
  for (const body of [null, {}, { sessionId: 's1', action: 'delete' }, { sessionId: '', action: 'status' }, { sessionId: 's1', action: 'cleanup' }, { sessionId: 's1', action: 'cleanup', token: 'bad' }]) {
    assert.equal((await fixture.manage(body)).error.code, 'management-error')
  }
  assert.equal((await fixture.manage('{', true)).error.code, 'management-error')
  assert.equal((await fixture.manage({ sessionId: 's1', action: 'status' })).value.attemptCount, 0)
})
test('legacy migration normalizes IDs and reasoning, interrupts running observations and imports only once', async t => {
  const legacy = { id: 'a', sessionId: 's1', status: 'running', startedAt: 10, request: { value: { reasoningEffort: 'medium' } } }
  const initial = { installedAt: 1, truncated: false, attempts: [legacy] }
  const fixture = await setup(t, { initial })
  const attempt = (await fixture.query({ sessionId: 's1' })).value.attempts[0]
  assert.match(attempt.id, /^[0-9a-f-]{36}$/)
  assert.equal(attempt.legacyId, 'a')
  assert.equal(attempt.reasoningEffort, 'medium')
  assert.equal(attempt.status, 'interrupted')
  assert.equal(attempt.observationInterrupted, true)
  assert.equal(attempt.durationMs, undefined)
  assert.equal(attempt.endedAt, undefined)
  assert.deepEqual(initial.attempts, [legacy], 'migration leaves source object intact')
  const exported = (await fixture.query({ sessionId: 's1', export: true })).value.attempts
  await fixture.close()
  const restored = await setup(t, { root: fixture.root, initial: { ...fixture.saved, attempts: [legacy] } })
  assert.deepEqual((await restored.query({ sessionId: 's1', export: true })).value.attempts, exported)
  assert.equal((await restored.manage({ sessionId: 's1', action: 'status' })).value.attemptCount, 1)
})
test('memory detail release retains readable disk evidence before and after restart', async t => {
  const fixture = await setup(t, { settings: { memoryCacheMiB: 1 } })
  // Each snapshot includes both text and parsed value: these exceed the valid 1 MiB cache budget.
  const system = 'retained on disk:' + 'x'.repeat(300000)
  for (let i = 0; i < 3; i++) await record(fixture, { system })
  const list = (await fixture.query({ sessionId: 's1' })).value.attempts
  const detail = (await fixture.query({ sessionId: 's1', attemptId: list[0].id })).value.attempt
  assert.equal(detail.request.value.system, system)
  assert.equal(list[0].hasDetails, true)
  assert.notEqual(list[0].detailsEvicted, true)
  await fixture.close()
  const restored = await setup(t, { root: fixture.root, initial: fixture.saved })
  assert.deepEqual((await restored.query({ sessionId: 's1', attemptId: list[0].id })).value.attempt, detail)
})
test('projection uses retry events and resets retry evidence at next step', async t => {
  const fixture = await setup(t)
  const fold = fixture.projection.apply
  const retry = fold({ turn: 2, step: 3 }, { type: 'llm/retry', data: { retryId: 'r', retry: 1, delayMs: 1000, provider: 'test', failure: { message: 'private' } } })
  assert.equal(retry.retryEvent.retry, 1)
  assert.ok(!JSON.stringify(retry).includes('private'))
  assert.deepEqual(fold(retry, { type: 'step/start', data: { turn: 2, step: 4 } }), { turn: 2, step: 4 })
  const action = { kind: 'retry' }
  assert.equal(await fixture.listeners.get('agent/request-error')({ agent: { id: 's1' } }, async () => action), action)
})
test('management previews, stale tokens, error protection and cleanup are session scoped', async t => {
  const fixture = await setup(t, { settings: { detailBudgetMiB: 0, preserveErrors: true } })
  await record(fixture)
  await record(fixture, { failure: { message: 'provider broke', code: 'E_TEST' } })
  await record(fixture, { sessionId: 's2' })
  const status = (await fixture.manage({ sessionId: 's1', action: 'status' })).value
  assert.equal(status.root, fixture.root)
  assert.equal(status.autoCleanup, false)
  assert.equal(status.budgetBytes, 0)
  assert.equal(status.attemptCount, 3)
  assert.ok(status.retainedBytes > 0)
  const preview = (await fixture.manage({ sessionId: 's1', action: 'preview' })).value
  assert.equal(preview.count, 1)
  assert.ok(preview.protectedBytes > 0)
  assert.equal(preview.overBudget, true)
  assert.equal(preview.candidateIds, undefined, 'public management responses omit bulk identifiers')
  await record(fixture)
  const stale = (await fixture.manage({ sessionId: 's1', action: 'cleanup', token: preview.token })).value
  assert.equal(stale.stale, true)
  assert.equal(stale.deletedCount, 0)
  assert.equal((await fixture.query({ sessionId: 's1', export: true })).value.attempts.filter(a => a.response).length, 3)
  const fresh = (await fixture.manage({ sessionId: 's1', action: 'preview' })).value
  const cleaned = (await fixture.manage({ sessionId: 's1', action: 'cleanup', token: fresh.token })).value
  assert.equal(cleaned.stale, false)
  assert.equal(cleaned.deletedCount, 2)
  const after = (await fixture.query({ sessionId: 's1', export: true })).value.attempts
  assert.equal(after.length, 3)
  assert.equal(after.filter(a => a.detailsEvicted).length, 2)
  assert.equal(after.find(a => a.status === 'error').response.events.length, 3)
  assert.equal((await fixture.query({ sessionId: 's2', export: true })).value.attempts[0].response.events.length, 3)
  fixture.setSettings({ preserveErrors: false })
  const unprotected = (await fixture.manage({ sessionId: 's1', action: 'preview' })).value
  assert.equal(unprotected.count, 1)
  assert.equal((await fixture.manage({ sessionId: 's1', action: 'cleanup', token: unprotected.token })).value.deletedCount, 1)
})
test('legacy directory is honored at startup and later changes never move or copy evidence', async t => {
  const fixture = await setup(t)
  await record(fixture, { system: 'original evidence' })
  const original = (await fixture.query({ sessionId: 's1', export: true })).value.attempts
  const next = await mkdtemp(path.join(tmpdir(), 'dsh-trace-unused-'))
  t.after(() => rm(next, { recursive: true, force: true }))
  fixture.setSettings({ directory: next, copyOnDirectoryChange: true })
  assert.equal((await fixture.manage({ sessionId: 's1', action: 'status' })).value.root, fixture.root)
  assert.deepEqual((await fixture.query({ sessionId: 's1', export: true })).value.attempts, original)
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual(await readdir(next), [], 'no target archive or copied files are created')
  await fixture.close()
  const restored = await setup(t, { root: fixture.root, initial: fixture.saved })
  assert.deepEqual((await restored.query({ sessionId: 's1', export: true })).value.attempts, original)
})
test('automatic cleanup invalidates cached details and settings alone do not immediately delete evidence', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() })
  const fixture = await setup(t, { settings: { detailBudgetMiB: 0, autoCleanup: false } })
  await record(fixture)
  const id = (await fixture.query({ sessionId: 's1' })).value.attempts[0].id
  fixture.setSettings({ autoCleanup: true })
  const before = (await fixture.query({ sessionId: 's1', attemptId: id })).value.attempt
  assert.ok(before.response)
  t.mock.timers.tick(599999)
  assert.ok((await fixture.query({ sessionId: 's1', attemptId: id })).value.attempt.response)
  t.mock.timers.tick(1)
  // Drain maintenance's promise callback, then the same serialized lock via status.
  await Promise.resolve()
  const status = (await fixture.manage({ sessionId: 's1', action: 'status' })).value
  assert.equal(status.detailCount, 0)
  const detail = (await fixture.query({ sessionId: 's1', attemptId: id })).value.attempt
  assert.equal(detail.detailsEvicted, true)
  assert.equal(detail.request, undefined)
  assert.equal(detail.response, undefined)
  const exported = (await fixture.query({ sessionId: 's1', export: true })).value.attempts
  assert.equal(exported[0].response, undefined)
  await fixture.close()
})
test('management tool shares UI operations and binds scope to exec agent, not supplied sessionId', async t => {
  const fixture = await setup(t, { withTools: true, settings: { detailBudgetMiB: 0 } })
  const tool = fixture.tools.get('harness_trace_manage')
  assert.ok(tool)
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.equal(tool.parameters.properties.sessionId, undefined)
  const exec = { agent: { id: 's1' } }
  await record(fixture)
  await record(fixture, { sessionId: 's2', system: 'other session evidence' })
  const uiStatus = (await fixture.manage({ sessionId: 's1', action: 'status' })).value
  assert.deepEqual(await tool.execute({ action: 'status' }, exec), uiStatus)
  const uiPreview = (await fixture.manage({ sessionId: 's1', action: 'preview' })).value
  const toolPreview = await tool.execute({ action: 'preview', sessionId: 's2' }, exec)
  assert.deepEqual(toolPreview, uiPreview, 'exec identity wins even when execute is invoked outside schema validation')
  assert.equal(toolPreview.count, 1)
  const otherPreview = (await fixture.manage({ sessionId: 's2', action: 'preview' })).value
  const stale = await tool.execute({ action: 'cleanup', token: otherPreview.token }, exec)
  assert.equal(stale.stale, true)
  assert.equal(stale.deletedCount, 0)
  const result = await tool.execute({ action: 'cleanup', token: uiPreview.token }, exec)
  assert.equal(result.deletedCount, 1)
  assert.equal(result.deletedIds, undefined)
  const cleared = (await fixture.query({ sessionId: 's1', export: true })).value.attempts[0]
  assert.equal(cleared.detailsEvicted, true)
  assert.equal(cleared.response, undefined)
  assert.ok((await fixture.query({ sessionId: 's2', export: true })).value.attempts[0].response)
  assert.deepEqual(tool.output.render({}, result), [{ type: 'text', text: JSON.stringify(result) }])
  await assert.rejects(tool.execute({ action: 'status' }, {}), /Expected action and sessionId/)
  await assert.rejects(tool.execute({ action: 'cleanup', token: 'bad' }, exec), /Preview token required/)
  await fixture.close()
  assert.equal(fixture.tools.size, 0)
})
test('invalid live legacy directory updates do not affect persistence or disposal', async t => {
  const fixture = await setup(t)
  const file = path.join(fixture.root, 'not-a-directory')
  await writeFile(file, 'occupied')
  fixture.setSettings({ directory: file })
  await record(fixture)
  const result = await fixture.query({ sessionId: 's1' })
  assert.equal(result.ok, true)
  assert.equal(result.value.storageError, undefined)
  assert.equal(result.value.attempts.length, 1)
  await fixture.close()
  assert.equal(fixture.closed, true)
})

test('cleanup scheduler is absent while disabled, unique when enabled, and released on disable/dispose', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() })
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval
  const active = new Set(), delays = []
  t.mock.method(globalThis, 'setInterval', (fn, delay) => { const id = realSet(fn, delay); active.add(id); delays.push(delay); return id })
  t.mock.method(globalThis, 'clearInterval', id => { active.delete(id); return realClear(id) })
  const fixture = await setup(t, { settings: { autoCleanup: false, detailBudgetMiB: 0 } })
  assert.equal(active.size, 0)
  t.mock.timers.tick(1200000)
  await record(fixture)
  const id = (await fixture.query({ sessionId: 's1' })).value.attempts[0].id
  assert.equal(active.size, 0, 'event-driven persistence does not start cleanup polling')
  fixture.setSettings({ autoCleanup: true })
  await fixture.manage({ action: 'status' })
  assert.deepEqual(delays, [600000])
  for (let i = 0; i < 3; i++) await fixture.manage({ action: 'status' })
  assert.equal(active.size, 1)
  assert.equal(delays.length, 1, 'normal flushes do not duplicate or reset the timer')
  fixture.setSettings({ autoCleanup: false })
  await fixture.manage({ action: 'status' })
  assert.equal(active.size, 0)
  t.mock.timers.tick(1200000)
  assert.ok((await fixture.query({ sessionId: 's1', attemptId: id })).value.attempt.response)
  fixture.setSettings({ autoCleanup: true })
  await fixture.manage({ action: 'status' })
  assert.deepEqual(delays, [600000, 600000])
  t.mock.timers.tick(599999)
  assert.ok((await fixture.query({ sessionId: 's1', attemptId: id })).value.attempt.response)
  await fixture.close()
  assert.equal(active.size, 0)
  t.mock.timers.tick(1200000)
})

test('capture persistence flushes on its event debounce with no cleanup interval', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const intervals = t.mock.method(globalThis, 'setInterval')
  const realSetTimeout = globalThis.setTimeout
  let checkpoint
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => realSetTimeout(() => { checkpoint = fn() }, delay))
  const fixture = await setup(t)
  await record(fixture, { system: 'event driven evidence' })
  t.mock.timers.tick(249)
  assert.equal(checkpoint, undefined)
  t.mock.timers.tick(1)
  assert.ok(checkpoint instanceof Promise)
  await checkpoint // No API request, maintenance timer, or disposal triggers this write.
  const disk = await openArchive({ root: fixture.root })
  try { assert.equal((await disk.list('s1')).length, 1) } finally { await disk.close() }
  assert.equal(intervals.mock.callCount(), 0)
})

test('count cleanup removes cached records entirely while protecting anomalous requests', async t => {
  const fixture = await setup(t, { settings: { maxAttempts: 1, retentionDays: 0 } })
  await record(fixture)
  await record(fixture, { failure: { message: 'retain this anomaly' } })
  const attempts = (await fixture.query({ sessionId: 's1' })).value.attempts
  const removedId = attempts.find(a => a.status === 'stop').id
  const preview = (await fixture.manage({ sessionId: 's1', action: 'preview' })).value
  assert.equal(preview.removedAttemptCount, 1)
  const result = (await fixture.manage({ sessionId: 's1', action: 'cleanup', token: preview.token })).value
  assert.equal(result.deletedAttemptCount, 1)
  assert.equal(result.removedIds, undefined)
  assert.equal((await fixture.query({ sessionId: 's1', attemptId: removedId })).ok, false)
  const remaining = (await fixture.query({ sessionId: 's1', export: true })).value.attempts
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].status, 'error')
  await fixture.close()
  const restored = await setup(t, { root: fixture.root, initial: fixture.saved })
  assert.equal((await restored.query({ sessionId: 's1' })).value.attempts.length, 1)
})

test('Host migrates old JSON before serving SQL reads and never reimports cleaned records', async t => {
  const { openArchive: openJson } = await import('../archive.js')
  const { randomUUID } = await import('node:crypto')
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-trace-json-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const old = await openJson({ root })
  const id = randomUUID()
  await old.save({ id, sessionId: 's1', status: 'stop', startedAt: 1, request: { value: { system: 'migrated source' } } })
  await old.close()
  const fixture = await setup(t, { root, settings: { retentionDays: 3 } })
  assert.equal((await fixture.query({ sessionId: 's1', attemptId: id })).value.attempt.request.value.system, 'migrated source')
  const preview = (await fixture.manage({ sessionId: 's1', action: 'preview' })).value
  assert.equal((await fixture.manage({ sessionId: 's1', action: 'cleanup', token: preview.token })).value.deletedAttemptCount, 1)
  await fixture.close()
  const restored = await setup(t, { root, initial: fixture.saved })
  assert.equal((await restored.query({ sessionId: 's1' })).value.attempts.length, 0)
  const source = await openJson({ root })
  try { assert.equal((await source.list('s1')).length, 1) } finally { await source.close() }
})


test('enabled startup schedules cleanup only at the ten-minute boundary', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() })
  const realSet = globalThis.setInterval
  const delays = []
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { delays.push(ms); return realSet(fn, ms) })
  const fixture = await setup(t, { settings: { autoCleanup: true, detailBudgetMiB: 0 } })
  assert.deepEqual(delays, [600000])
  await record(fixture)
  t.mock.timers.tick(599999)
  assert.equal((await fixture.manage({ action: 'status' })).value.detailCount, 1)
  t.mock.timers.tick(1)
  await Promise.resolve()
  assert.equal((await fixture.manage({ action: 'status' })).value.detailCount, 0)
})
