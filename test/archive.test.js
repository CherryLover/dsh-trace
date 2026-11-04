import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { openArchive } from '../archive.js'

const key = session => createHash('sha256').update(session).digest('hex')
async function storedSummary(root, a) {
  return JSON.parse(await fs.readFile(path.join(root, 'index', `${key(a.sessionId)}.json`), 'utf8')).attempts.find(item => item.id === a.id)
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'dsh-archive-test-'))
  const archive = await openArchive({ root, now: () => 12345 })
  t.after(async () => { await archive.close(); await fs.rm(root, { recursive: true, force: true }) })
  return { root, archive }
}
const attempt = (overrides = {}) => ({ id: randomUUID(), sessionId: 'session-a', status: 'success', startedAt: 1, endedAt: 2, request: { text: 'test payload' }, response: { events: [] }, ...overrides })

test('persist, reopen, summary metadata, session isolation and no archive paths', async t => {
  const { root, archive } = await fixture(t)
  const a = attempt({ sessionId: '../../session/秘密' })
  const saved = await archive.save(a)
  assert.equal(saved.request, undefined)
  assert.equal(saved.detailFilename, undefined)
  assert.equal((await archive.list(a.sessionId))[0].detailFilename, undefined)
  assert.equal(saved.hasDetails, true)
  assert.equal(saved.detailBytes, Buffer.byteLength(JSON.stringify(a)))
  assert.equal(JSON.stringify(saved).includes(root), false)
  assert.deepEqual(await archive.detail(a.sessionId, a.id), a)
  assert.equal(await archive.detail('other', a.id), null)
  assert.deepEqual(await archive.list('other'), [])
  assert.deepEqual(await fs.readdir(path.join(root, 'sessions')), [key(a.sessionId)])
  await archive.close()
  const reopened = await openArchive({ root })
  t.after(() => reopened.close())
  assert.equal((await reopened.list(a.sessionId))[0].id, a.id)
  assert.deepEqual(await reopened.detail(a.sessionId, a.id), a)
  assert.equal((await reopened.sessions())[0].attemptCount, 1)
  const stats = await reopened.stats()
  assert.equal(stats.sessionCount, 1)
  assert.equal(stats.detailBytes, saved.detailBytes)
  assert.ok(stats.storageBytes > stats.detailBytes)
  assert.equal(stats.storageBytes, stats.configBytes + stats.indexBytes + stats.logBytes + stats.sessionFileBytes)
  const log = await fs.readFile(path.join(root, 'logs', 'management.jsonl'), 'utf8')
  assert.equal(log.includes('test payload'), false)
  assert.equal(log.includes(a.sessionId), false)
  assert.equal(log.includes(root), false)
})

test('serialized concurrent saves across instances preserve entries and immutable snapshots', async t => {
  const { root, archive } = await fixture(t)
  const second = await openArchive({ root })
  t.after(() => second.close())
  const values = Array.from({ length: 16 }, () => attempt())
  await Promise.all(values.map((a, i) => (i % 2 ? archive : second).save(a)))
  assert.equal((await archive.list('session-a')).length, 16)
  const a = attempt()
  const pending = archive.save(a)
  a.status = 'error'
  await pending
  assert.equal((await archive.detail(a.sessionId, a.id)).status, 'success')
  const files = await fs.readdir(path.join(root, 'index'))
  assert.equal(files.some(name => name.endsWith('.tmp')), false)
})

test('cleanup evicts oldest successes, preserves summaries, errors and running details', async t => {
  const { archive } = await fixture(t)
  const old = attempt({ startedAt: 1 }), newer = attempt({ startedAt: 5 }), error = attempt({ status: 'error' }), active = attempt({ status: 'running', endedAt: undefined })
  for (const a of [newer, error, active, old]) await archive.save(a)
  const preview = await archive.previewCleanup({ budgetBytes: 0 })
  assert.deepEqual(preview.candidateIds.map(a => a.attemptId), [old.id, newer.id])
  assert.equal(preview.count, 2)
  assert.ok(preview.protectedBytes > 0)
  assert.ok(preview.runningBytes > 0)
  assert.equal(preview.overBudget, true)
  const result = await archive.cleanup({ budgetBytes: 0, expected: preview })
  assert.equal(result.deletedCount, 2)
  assert.equal(await archive.detail(old.sessionId, old.id), null)
  const list = await archive.list(old.sessionId)
  assert.equal(list.length, 4)
  assert.equal(list.find(a => a.id === old.id).detailsEvicted, true)
  assert.equal(list.find(a => a.id === old.id).detailBytes, 0)
  assert.ok(await archive.detail(error.sessionId, error.id))
  assert.ok(await archive.detail(active.sessionId, active.id))
  assert.equal((await archive.stats()).evictedCount, 2)
  const unprotected = await archive.cleanup({ budgetBytes: 0, preserveErrors: false })
  assert.deepEqual(unprotected.deletedIds.map(a => a.attemptId), [error.id])
})

test('all supported error representations are protected, including HTTP evidence', async t => {
  const { archive } = await fixture(t)
  const errors = [{ status: 'failure' }, { failure: { code: 'fail' } }, { errorCount: 1 }, { observedErrorCount: 3 }, { errors: [{ message: 'oops' }] }, { http: { exchanges: [{ response: { status: 429 } }] } }, { http: { exchanges: [{ statusCode: 500 }] } }]
  for (const e of errors) await archive.save(attempt(e))
  assert.equal((await archive.list('session-a')).find(a => a.errorCount === 1)?.isError, true)
  const result = await archive.cleanup({ budgetBytes: 0 })
  assert.equal(result.deletedCount, 0)
  assert.equal(result.overBudget, true)
  assert.equal(result.protectedBytes, result.totalBytes)
})

test('stale preview deletes nothing; current cleanup skips newly running items and isolates sessions', async t => {
  const { archive } = await fixture(t)
  const a = attempt(), other = attempt({ sessionId: 'other' })
  await archive.save(a); await archive.save(other)
  const preview = await archive.previewCleanup({ budgetBytes: 0, sessionId: a.sessionId })
  assert.equal(preview.count, 1)
  await archive.save({ ...a, status: 'running' })
  const result = await archive.cleanup({ budgetBytes: 0, sessionId: a.sessionId, expected: preview.token })
  assert.equal(result.stale, true)
  assert.equal(result.deletedCount, 0)
  assert.equal((await archive.cleanup({ budgetBytes: 0, sessionId: a.sessionId })).deletedCount, 0)
  assert.ok(await archive.detail(other.sessionId, other.id))
})

test('reject path injection and invalid budgets, closed handles reject operations', async t => {
  const { archive } = await fixture(t)
  await assert.rejects(archive.save(attempt({ id: '../evil' })), /UUID/)
  await assert.rejects(archive.save(attempt({ sessionId: '' })), /sessionId/)
  assert.throws(() => archive.detail('a', '../evil'), /UUID/)
  for (const budgetBytes of [-1, NaN, Infinity, 1.5, undefined]) await assert.rejects(archive.previewCleanup({ budgetBytes }), /budgetBytes/)
  await archive.close()
  await assert.rejects(archive.stats(), /closed/)
})

test('corrupt indexes, detail JSON, missing detail and format are explicit errors', async t => {
  for (const target of ['index', 'detail', 'missing', 'format']) await t.test(target, async t => {
    const { root, archive } = await fixture(t), a = attempt()
    await archive.save(a); const saved = await storedSummary(root, a); await archive.close()
    const file = target === 'index' ? path.join(root, 'index', `${key(a.sessionId)}.json`) : target === 'format' ? path.join(root, 'config', 'format.json') : path.join(root, 'sessions', key(a.sessionId), saved.detailFilename)
    if (target === 'missing') await fs.unlink(file)
    else await fs.writeFile(file, '{broken')
    await assert.rejects(openArchive({ root }), /corruption/)
    if (target !== 'missing') assert.equal(await fs.readFile(file, 'utf8'), '{broken')
  })
})

test('null format and symlink session directories are rejected without overwriting', async t => {
  const { root, archive } = await fixture(t), a = attempt()
  await archive.save(a); await archive.close()
  const dir = path.join(root, 'sessions', key(a.sessionId))
  const renamed = `${dir}-original`
  await fs.rename(dir, renamed)
  await fs.symlink(renamed, dir)
  await assert.rejects(openArchive({ root }), /corruption/)
  await fs.unlink(dir); await fs.rename(renamed, dir)
  const format = path.join(root, 'config', 'format.json')
  await fs.writeFile(format, 'null')
  await assert.rejects(openArchive({ root }), /corruption/)
  assert.equal(await fs.readFile(format, 'utf8'), 'null')
})

test('summary-only save has zero retained bytes and zero cleanup candidates', async t => {
  const { archive } = await fixture(t)
  const a = attempt({ detailsEvicted: true, request: undefined, response: undefined })
  const saved = await archive.save(a)
  assert.equal(saved.detailBytes, 0)
  assert.equal(saved.hasDetails, false)
  assert.equal(await archive.detail(a.sessionId, a.id), null)
  assert.equal((await archive.previewCleanup({ budgetBytes: 0 })).count, 0)
  const bare = await archive.save(attempt({ request: undefined, response: undefined }))
  const explicit = await archive.save(attempt({ hasDetails: false }))
  assert.equal(bare.hasDetails, false)
  assert.equal(explicit.hasDetails, false)
  assert.equal((await archive.stats()).detailBytes, 0)
})

test('prompt status/error values do not become archive errors; anomaly metadata survives', async t => {
  const { archive } = await fixture(t)
  const ordinary = attempt({ request: { status: 500, failure: true, error: 'a prompt example' }, response: { events: [{ status: 'error' }] } })
  assert.equal((await archive.save(ordinary)).isError, false)
  assert.equal((await archive.save(attempt({ hasAnomaly: true }))).isError, true)
  assert.equal((await archive.save(attempt({ isError: true }))).isError, true)
  assert.deepEqual((await archive.previewCleanup({ budgetBytes: 0 })).candidateIds.map(a => a.attemptId), [ordinary.id])
  await archive.cleanup({ budgetBytes: 0, preserveErrors: false })
  for (const item of await archive.list(ordinary.sessionId)) await archive.save(item)
  const summaries = await archive.list(ordinary.sessionId)
  assert.equal(summaries.filter(a => a.isError).length, 2)
  assert.equal(summaries.every(a => !a.hasDetails), true)
})

test('detail parsing is lazy while startup validates size and indexes remain usable', async t => {
  const { root, archive } = await fixture(t), a = attempt()
  await archive.save(a)
  const saved = await storedSummary(root, a)
  await archive.close()
  const file = path.join(root, 'sessions', key(a.sessionId), saved.detailFilename)
  await fs.writeFile(file, 'x'.repeat(saved.detailBytes))
  const reopened = await openArchive({ root })
  t.after(() => reopened.close())
  assert.equal((await reopened.list(a.sessionId)).length, 1)
  assert.equal((await reopened.stats()).detailBytes, saved.detailBytes)
  assert.equal((await reopened.previewCleanup({ budgetBytes: 0 })).count, 1)
  await reopened.save(attempt())
  await assert.rejects(reopened.detail(a.sessionId, a.id), /corruption/)
})

test('immutable revisions and startup orphan sweep recover interrupted saves and cleanup', async t => {
  const { root, archive } = await fixture(t), a = attempt()
  await archive.save(a)
  const old = await storedSummary(root, a)
  await archive.save({ ...a, request: { text: 'new' } })
  const current = await storedSummary(root, a)
  assert.notEqual(old.detailFilename, current.detailFilename)
  const dir = path.join(root, 'sessions', key(a.sessionId))
  assert.deepEqual(await fs.readdir(dir), [current.detailFilename])
  // New revision written but index not committed: keep current revision intact.
  const orphan = `${a.id}.${randomUUID()}.json`
  await fs.writeFile(path.join(dir, orphan), '{interrupted write')
  await archive.close()
  const reopened = await openArchive({ root })
  t.after(() => reopened.close())
  assert.equal((await reopened.detail(a.sessionId, a.id)).request.text, 'new')
  assert.deepEqual(await fs.readdir(dir), [current.detailFilename])
  await reopened.cleanup({ budgetBytes: 0 })
  // Index commit happened, unlink did not: a leftover revision is not corruption.
  await fs.writeFile(path.join(dir, current.detailFilename), JSON.stringify(a))
  await reopened.close()
  const recovered = await openArchive({ root })
  t.after(() => recovered.close())
  assert.equal(await recovered.detail(a.sessionId, a.id), null)
  assert.deepEqual(await fs.readdir(dir), [])
})

test('failed index commit preserves previous revision and startup removes abandoned revision', async t => {
  const { root, archive } = await fixture(t), a = attempt()
  await archive.save(a)
  const before = await storedSummary(root, a)
  const rename = fs.rename
  const mock = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === path.join(root, 'index', `${key(a.sessionId)}.json`)) throw new Error('simulated index commit failure')
    return rename(from, to)
  })
  await assert.rejects(archive.save({ ...a, request: { text: 'uncommitted replacement' } }), /simulated/)
  mock.mock.restore()
  assert.deepEqual(await archive.detail(a.sessionId, a.id), a)
  const dir = path.join(root, 'sessions', key(a.sessionId))
  assert.equal((await fs.readdir(dir)).length, 2)
  await archive.close()
  const recovered = await openArchive({ root })
  t.after(() => recovered.close())
  assert.deepEqual(await fs.readdir(dir), [before.detailFilename])
})

test('management log rotates at one MiB and keeps only two bounded files', async t => {
  const { root, archive } = await fixture(t)
  const dir = path.join(root, 'logs'), log = path.join(dir, 'management.jsonl'), backup = path.join(dir, 'management.1.jsonl')
  await fs.writeFile(log, 'x'.repeat(1024 * 1024))
  await archive.save(attempt())
  assert.equal((await fs.stat(backup)).size, 1024 * 1024)
  assert.ok((await fs.stat(log)).size < 1024)
  await fs.writeFile(log, 'y'.repeat(1024 * 1024))
  await archive.save(attempt())
  assert.deepEqual((await fs.readdir(dir)).sort(), ['management.1.jsonl', 'management.jsonl'])
  assert.equal((await fs.readFile(backup, 'utf8'))[0], 'y')
  assert.ok((await archive.stats()).logBytes <= 2 * 1024 * 1024)
})
