import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { openArchive } from '../archive.js'
import { openSqliteArchive } from '../sqlite-archive.js'

const attempt = (overrides = {}) => ({ id: randomUUID(), sessionId: 'session-a', status: 'success', startedAt: 1, endedAt: 2, request: { text: 'payload' }, response: { events: [] }, ...overrides })
async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dsh-sqlite-test-')))
  const archive = await openSqliteArchive({ root, now: () => 10 * 86400000, ...options })
  t.after(async () => { await archive.close(); await fs.rm(root, { recursive: true, force: true }) })
  return { root, archive }
}
const key = session => createHash('sha256').update(session).digest('hex')

test('real indexed SQLite, private permissions, full snapshots, aliases and reopen', async t => {
  const { root, archive } = await fixture(t), a = attempt({ sessionId: '../../秘密' })
  const saving = archive.save(a); a.request.text = 'mutated'
  const saved = await saving
  assert.equal(saved.request, undefined); assert.equal(saved.detailFilename, undefined)
  assert.equal((await archive.get(a.sessionId, a.id)).request.text, 'payload')
  assert.equal(await archive.detail('other', a.id), null)
  assert.equal((await archive.session(a.sessionId)).length, 1)
  assert.equal((await archive.sessions())[0].attemptCount, 1)
  const file = path.join(root, 'archive.sqlite')
  assert.equal((await fs.readFile(file)).subarray(0, 16).toString(), 'SQLite format 3\u0000')
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700)
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
  const stats = await archive.status()
  assert.equal(stats.backend, 'sqlite'); assert.ok(stats.storageBytes > stats.detailBytes)
  assert.equal(stats.storageBytes, stats.sqliteBytes + stats.journalBytes + stats.walBytes + stats.shmBytes)
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(file, { readOnly: true })
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name IN ('attempts_session_time','attempts_status_time','attempts_time')").get().n, 3)
  assert.equal(JSON.parse(db.prepare('SELECT detail_json FROM attempts').get().detail_json).request.text, 'payload')
  db.close()
  await archive.close()
  const reopened = await openSqliteArchive({ root }); t.after(() => reopened.close())
  assert.equal((await reopened.list(a.sessionId))[0].id, a.id)
  await archive.close(); await assert.rejects(archive.stats(), /closed/)
})

test('serialized cross-handle writes and full-revision stale preview protection', async t => {
  const { root, archive } = await fixture(t), other = await openSqliteArchive({ root })
  t.after(() => other.close())
  const values = Array.from({ length: 20 }, () => attempt())
  await Promise.all(values.map((a, i) => (i % 2 ? archive : other).save(a)))
  assert.equal((await archive.list('session-a')).length, 20)
  const preview = await archive.previewCleanup({ budgetBytes: 0 })
  await other.save({ ...values[0], request: { text: 'PAYLOAD' } }) // equal byte count
  const stale = await archive.cleanup({ budgetBytes: 0, expected: preview })
  assert.equal(stale.stale, true); assert.equal(stale.deletedCount, 0)
  assert.equal((await archive.stats()).detailCount, 20)
})

test('budget evicts details only, preserves anomaly variants and all running states', async t => {
  const { archive } = await fixture(t)
  const success = attempt(), errors = [{ status: 'error' }, { status: 'failure' }, { failure: { code: 'fail' } }, { errorCount: 1 }, { observedErrorCount: 2 }, { errors: [{ message: 'oops' }] }, { http: { exchanges: [{ response: { status: 429 } }] } }, { hasAnomaly: true }]
  await archive.save(success)
  for (const e of errors) await archive.save(attempt(e))
  for (const status of ['running', 'pending', 'streaming', 'in_progress', 'in-progress']) await archive.save(attempt({ status }))
  const preview = await archive.preview({ budgetBytes: 0 })
  assert.deepEqual(preview.candidateIds.map(a => a.attemptId), [success.id])
  assert.equal(preview.protectedCount, errors.length); assert.equal(preview.runningCount, 5)
  const result = await archive.cleanup({ budgetBytes: 0, expected: preview.token })
  assert.equal(result.deletedAttemptCount, 0); assert.equal(result.deletedCount, 1)
  const list = await archive.list(success.sessionId)
  assert.equal(list.length, 14)
  assert.equal(list.find(a => a.id === success.id).detailsEvicted, true)
  assert.equal(await archive.detail(success.sessionId, success.id), null)
  const next = await archive.cleanup({ budgetBytes: 0, preserveErrors: false })
  assert.equal(next.deletedCount, errors.length); assert.equal(next.overBudget, true)
})

test('global maxAttempts deletes whole rows including summary-only, errors may exceed cap', async t => {
  const { archive } = await fixture(t, { maxAttempts: 2 })
  const old = attempt({ startedAt: 1, hasDetails: false }), newer = attempt({ startedAt: 2, sessionId: 'other' })
  const errors = [attempt({ status: 'error', startedAt: 3 }), attempt({ status: 'error', startedAt: 4 })]
  for (const a of [old, newer, ...errors]) await archive.save(a)
  const before = await archive.stats()
  assert.equal(before.overLimitCount, 2)
  const result = await archive.cleanup({ budgetBytes: 1000000 })
  assert.equal(result.deletedAttemptCount, 2)
  assert.deepEqual(result.removedIds.map(a => a.attemptId), [old.id, newer.id])
  assert.equal((await archive.stats()).attemptCount, 2)
  assert.equal((await archive.sessions()).some(s => s.sessionId === 'other'), false)
  await archive.save(attempt({ status: 'error' }))
  const protectedResult = await archive.cleanup({ budgetBytes: 1000000 })
  assert.equal(protectedResult.deletedCount, 0); assert.equal(protectedResult.overMaxAttempts, true)
  assert.equal(protectedResult.overLimitCount, 1)
})

test('retentionDays removes expired rows, cap remains global with a session scope, zero is unlimited', async t => {
  const { archive } = await fixture(t)
  const old = attempt({ startedAt: 86400000 }), fresh = attempt({ startedAt: 9 * 86400000 }), error = attempt({ startedAt: 0, status: 'error' }), active = attempt({ startedAt: 0, status: 'running' })
  for (const a of [old, fresh, error, active]) await archive.save(a)
  assert.equal((await archive.previewCleanup({ budgetBytes: 1000000, maxAttempts: 0, retentionDays: 0 })).count, 0)
  const result = await archive.cleanup({ budgetBytes: 1000000, retentionDays: 3 })
  assert.deepEqual(result.removedIds.map(a => a.attemptId), [old.id])
  assert.equal(result.expiredProtectedCount, 2)
  await archive.save(attempt({ sessionId: 'other' }))
  const scoped = await archive.cleanup({ budgetBytes: 1000000, maxAttempts: 1, sessionId: 'other' })
  assert.equal(scoped.deletedAttemptCount, 1)
  assert.equal(scoped.overMaxAttempts, true)
  assert.equal((await archive.list('session-a')).length, 3)
})

test('cleanup compacts actual database bytes rather than leaving freelist growth', async t => {
  const { archive } = await fixture(t)
  for (let i = 0; i < 5; i++) await archive.save(attempt({ request: { text: 'x'.repeat(300000) } }))
  const before = await archive.stats()
  await archive.cleanup({ budgetBytes: 0 })
  const after = await archive.stats()
  assert.ok(after.sqliteBytes < before.sqliteBytes / 4)
  assert.equal(after.freePages, 0)
  assert.equal(after.attemptCount, 5)
})

test('read-only JSON import preserves originals, evidence, evicted summaries, interruption and idempotence', async t => {
  const { root, archive } = await fixture(t), sourceRoot = path.join(root, 'json')
  const source = await openArchive({ root: sourceRoot })
  const a = attempt(), b = attempt({ status: 'error', failure: { message: 'proof' } }), c = attempt({ hasDetails: false, detailsEvicted: true, detailsUnavailableReason: 'custom' })
  for (const value of [a, b, c]) await source.save(value)
  await source.close()
  const indexFile = path.join(sourceRoot, 'index', `${key(a.sessionId)}.json`)
  const before = await fs.readFile(indexFile), beforeStat = await fs.stat(indexFile)
  const first = await archive.importJsonArchive({ root: sourceRoot, limit: 1 })
  assert.deepEqual(first, { imported: 1, skipped: 0, interrupted: true })
  await archive.close()
  const reopened = await openSqliteArchive({ root }); t.after(() => reopened.close())
  const second = await reopened.importJsonArchive({ root: sourceRoot })
  assert.equal(second.imported, 2); assert.equal(second.skipped, 1)
  assert.deepEqual(await reopened.detail(a.sessionId, a.id), a)
  assert.deepEqual(await reopened.detail(b.sessionId, b.id), b)
  assert.equal((await reopened.list(c.sessionId)).find(v => v.id === c.id).detailsUnavailableReason, 'custom')
  assert.equal((await reopened.list(b.sessionId)).find(v => v.id === b.id).isError, true)
  assert.equal((await reopened.importJsonArchive({ root: sourceRoot })).imported, 0)
  assert.deepEqual(await fs.readFile(indexFile), before)
  assert.equal((await fs.stat(indexFile)).mtimeMs, beforeStat.mtimeMs)
  // Import markers survive row deletion: reimport never resurrects pruned rows.
  await reopened.cleanup({ budgetBytes: 1000000, maxAttempts: 1, preserveErrors: false })
  assert.equal((await reopened.importJsonArchive({ root: sourceRoot })).imported, 0)
  assert.equal((await reopened.stats()).attemptCount, 1)
})

test('import reads details one at a time and resumes after a missing-detail failure', async t => {
  const { root, archive } = await fixture(t), sourceRoot = path.join(root, 'source')
  const source = await openArchive({ root: sourceRoot }), a = attempt(), b = attempt()
  await source.save(a); await source.save(b); await source.close()
  const index = JSON.parse(await fs.readFile(path.join(sourceRoot, 'index', `${key(a.sessionId)}.json`)))
  const file = path.join(sourceRoot, 'sessions', key(b.sessionId), index.attempts[1].detailFilename)
  const original = await fs.readFile(file); await fs.unlink(file)
  await assert.rejects(archive.importJsonArchive({ root: sourceRoot }))
  assert.equal((await archive.stats()).attemptCount, 1)
  await fs.writeFile(file, original)
  assert.equal((await archive.importJsonArchive({ root: sourceRoot })).imported, 1)
  const aborted = new AbortController(); aborted.abort()
  assert.equal((await archive.importJsonArchive({ root: sourceRoot, signal: aborted.signal })).complete, true)
})

test('retention boundary invalidates preview and invalid timestamps never expire', async t => {
  let clock = 3 * 86400000
  const { archive } = await fixture(t, { now: () => clock })
  const boundary = attempt({ startedAt: 2 * 86400000 })
  await archive.save(boundary)
  for (const startedAt of [undefined, null, '1', -1]) await archive.save(attempt({ startedAt }))
  const preview = await archive.previewCleanup({ budgetBytes: 1000000, retentionDays: 1 })
  assert.equal(preview.count, 0)
  clock++
  const stale = await archive.cleanup({ budgetBytes: 1000000, retentionDays: 1, expected: preview })
  assert.equal(stale.stale, true); assert.equal(stale.deletedCount, 0)
  const result = await archive.cleanup({ budgetBytes: 1000000, retentionDays: 1 })
  assert.deepEqual(result.removedIds.map(a => a.attemptId), [boundary.id])
  assert.equal((await archive.stats()).attemptCount, 4)
})

test('global cap planning precedes session filtering and successes precede unprotected errors', async t => {
  const { archive } = await fixture(t)
  const old = attempt({ sessionId: 'other', startedAt: 1 }), recent = attempt({ startedAt: 2 }), error = attempt({ status: 'error', startedAt: 0 })
  for (const a of [old, recent, error]) await archive.save(a)
  const scoped = await archive.previewCleanup({ budgetBytes: 1000000, maxAttempts: 2, sessionId: 'session-a', preserveErrors: false })
  assert.equal(scoped.count, 0)
  const result = await archive.cleanup({ budgetBytes: 1000000, maxAttempts: 1, preserveErrors: false })
  assert.deepEqual(result.removedIds.map(a => a.attemptId), [old.id, recent.id])
  assert.ok(await archive.detail(error.sessionId, error.id))
  assert.deepEqual(result.deletedIds, [])
})

test('empty SQLite root import is a no-op; legacy bytes are separate and source remains read-only', async t => {
  const { root, archive } = await fixture(t)
  assert.deepEqual(await archive.importJsonArchive({ root }), { imported: 0, skipped: 0, interrupted: false })
  const source = await openArchive({ root })
  const a = attempt(); await source.save(a); await source.close()
  const stats = await archive.stats()
  assert.ok(stats.legacyBytes > 0)
  assert.equal(stats.legacyStorageBytes, stats.legacyBytes)
  assert.equal(stats.combinedStorageBytes, stats.storageBytes + stats.legacyBytes)
  await archive.importJsonArchive({ root })
  // The durable complete marker means later source additions are not silently
  // reintroduced; source is a preserved migration backup, not a live mirror.
  const sourceAgain = await openArchive({ root }); await sourceAgain.save(attempt()); await sourceAgain.close()
  assert.equal((await archive.importJsonArchive({ root })).complete, true)
  assert.equal((await archive.stats()).attemptCount, 1)
})

test('invalid identities/policies, corruption and symlink paths are rejected', async t => {
  const { root, archive } = await fixture(t)
  await assert.rejects(archive.save(attempt({ id: '../bad' })), /UUID/)
  assert.throws(() => archive.detail('s', '../bad'), /UUID/)
  for (const budgetBytes of [-1, undefined, NaN, 1.5, Infinity]) await assert.rejects(archive.previewCleanup({ budgetBytes }), /budgetBytes/)
  for (const field of ['maxAttempts', 'retentionDays']) await assert.rejects(archive.previewCleanup({ budgetBytes: 0, [field]: -1 }), new RegExp(field))
  await assert.rejects(archive.cleanup({ budgetBytes: 0, expected: 'bad' }), /expected/)
  const link = path.join(root, 'linked')
  await fs.symlink(root, link)
  await assert.rejects(openSqliteArchive({ root: link }), /corruption/)
  await fs.symlink(path.join(root, 'archive.sqlite'), path.join(root, 'link.sqlite'))
  await assert.rejects(openSqliteArchive({ root, filename: 'link.sqlite' }), /corruption/)
  await fs.symlink(path.join(root, 'archive.sqlite'), path.join(root, 'archive.sqlite-wal'))
  await assert.rejects(archive.stats(), /corruption/)
  await fs.unlink(path.join(root, 'archive.sqlite-wal'))
  const corruptRoot = path.join(root, 'corrupt'); await fs.mkdir(corruptRoot)
  await fs.writeFile(path.join(corruptRoot, 'archive.sqlite'), '{json}')
  await assert.rejects(openSqliteArchive({ root: corruptRoot }))
})
