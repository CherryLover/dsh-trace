import { promises as fs, constants } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { summary } from './evidence.js'

const queues = new Map()
const hash = value => createHash('sha256').update(value).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const digest = /^[0-9a-f]{64}$/
const running = item => ['running', 'pending', 'streaming', 'in_progress', 'in-progress'].includes(item.status) || item.running === true
const corruption = () => new Error('Archive corruption: invalid or missing archive data')
const timestamp = a => typeof a.startedAt === 'number' && Number.isFinite(a.startedAt) && a.startedAt >= 0 ? a.startedAt : null
const expiredAt = (a, cutoff) => cutoff !== null && timestamp(a) !== null && timestamp(a) < cutoff
async function legacyDiskBytes(root) {
  let bytes = 0
  async function visit(dir) {
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch (e) { if (e.code === 'ENOENT') return; throw e }
    await directory(dir)
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await visit(file)
      else bytes += (await statFile(file)).size
    }
  }
  for (const name of ['config', 'index', 'sessions', 'logs']) await visit(path.join(root, name))
  return bytes
}
function identity(sessionId, id) {
  if (typeof sessionId !== 'string' || !sessionId.length) throw new TypeError('sessionId must be a nonempty string')
  if (id !== undefined && (typeof id !== 'string' || !uuid.test(id))) throw new TypeError('attemptId must be a UUID')
  return hash(sessionId)
}
function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer`)
  return value
}
function visible(item) {
  const { detailFilename, ...value } = summary(item)
  value.hasDetails = item.hasDetails
  if (!item.hasDetails) value.detailsUnavailableReason = item.detailsUnavailableReason ?? 'unavailable'
  else delete value.detailsUnavailableReason
  return clone(value)
}
async function statFile(file, optional = false) {
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw corruption()
    return stat
  } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error }
}
// Refuse custom symlink traversal, including existing ancestors. Only macOS's
// fixed /var and /tmp system aliases are canonicalized below.
async function directory(dir, create = false) {
  let resolved = path.resolve(dir)
  // macOS ships /var and /tmp as immutable system aliases; accept only
  // these exact OS mappings, not arbitrary user-controlled symlink ancestors.
  if (process.platform === 'darwin') for (const alias of ['/var', '/tmp']) {
    if ((resolved === alias || resolved.startsWith(alias + '/')) && await fs.realpath(alias) === '/private' + alias) resolved = '/private' + resolved
  }
  const parsed = path.parse(resolved)
  let current = parsed.root
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    if (create) await fs.mkdir(current, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e })
    const stat = await fs.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw corruption()
  }
  return resolved
}
async function readJson(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1) throw corruption()
    try { return { value: JSON.parse(await handle.readFile('utf8')), bytes: stat.size } } catch { throw corruption() }
  } finally { await handle.close() }
}
function snapshot(value, now) {
  const text = JSON.stringify(value)
  const hasDetails = !value.detailsEvicted && value.hasDetails !== false && ['request', 'response', 'http', 'errors'].some(k => value[k] !== undefined && value[k] !== null)
  const item = { ...summary(value), errorCount: Math.max(Number(value.errorCount) || 0, Number(value.observedErrorCount) || 0, value.errors?.length || 0), hasDetails, detailsEvicted: !!value.detailsEvicted, detailBytes: hasDetails ? Buffer.byteLength(text) : 0, isError: !!summary(value).hasAnomaly, archivedAt: now }
  delete item.detailFilename
  if (hasDetails) delete item.detailsUnavailableReason
  else item.detailsUnavailableReason = value.detailsUnavailableReason ?? 'unavailable'
  return { item, text: hasDetails ? text : null }
}

/** Real SQLite archive (SQLite header, indexed rows, JSON evidence columns).
 * No automatic cleanup or migration. Node >=22.13 / a node:sqlite-capable host.
 * maxAttempts and retentionDays are global row policies; zero disables them.
 * budgetBytes retains the JSON backend's detail-only eviction semantics.
 * All operations serialize per database path, with BEGIN IMMEDIATE transactions.
 */
export async function openSqliteArchive({ root = path.join(homedir(), '.dsh', 'request-traces'), filename = 'archive.sqlite', now = Date.now, maxAttempts = 0, retentionDays = 0, preserveErrors = true } = {}) {
  integer(maxAttempts, 'maxAttempts'); integer(retentionDays, 'retentionDays')
  if (typeof filename !== 'string' || !filename || path.basename(filename) !== filename || ['.', '..'].includes(filename)) throw new TypeError('filename must be a basename')
  // Dynamic import keeps importing this module possible in older runtimes.
  let DatabaseSync
  try { ({ DatabaseSync } = await import('node:sqlite')) } catch (cause) {
    throw new Error('SQLite archive requires node:sqlite (Node >=22.13 or a compatible Electron host)', { cause })
  }
  root = await directory(root, true)
  const file = path.join(root, filename)
  let db, inode, closed = false, closing
  function enqueue(task) {
    if (closed) return Promise.reject(new Error('Archive is closed'))
    const result = (queues.get(file) ?? Promise.resolve()).catch(() => {}).then(task)
    const tail = result.catch(() => {})
    queues.set(file, tail)
    void tail.then(() => { if (queues.get(file) === tail) queues.delete(file) })
    return result
  }
  async function guard() {
    await directory(root)
    const stat = await statFile(file)
    if (inode && (stat.ino !== inode.ino || stat.dev !== inode.dev)) throw corruption()
    for (const suffix of ['-journal', '-wal', '-shm']) await statFile(file + suffix, true)
  }
  function transaction(task) {
    db.exec('BEGIN IMMEDIATE')
    try { const result = task(); db.exec('COMMIT'); return result } catch (e) { db.exec('ROLLBACK'); throw e }
  }
  const execute = task => enqueue(async () => { await guard(); return task() })
  function rows() { return db.prepare('SELECT summary_json FROM attempts ORDER BY rowid').all().map(row => JSON.parse(row.summary_json)) }
  function revision() { return db.prepare("SELECT value FROM metadata WHERE key='revision'").get().value }
  function changed() { db.exec("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision'") }
  function put(item, text) {
    db.prepare(`INSERT INTO attempts(session_id,attempt_id,status,started_at,is_error,is_running,detail_bytes,summary_json,detail_json)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,attempt_id) DO UPDATE SET status=excluded.status,started_at=excluded.started_at,is_error=excluded.is_error,is_running=excluded.is_running,detail_bytes=excluded.detail_bytes,summary_json=excluded.summary_json,detail_json=excluded.detail_json`).run(
      item.sessionId, item.id, String(item.status ?? ''), Number(item.startedAt) || 0, Number(!!item.isError), Number(running(item)), item.detailBytes, JSON.stringify(item), text)
  }
  await enqueue(async () => {
    await directory(root, true)
    await fs.chmod(root, 0o700)
    if (!await statFile(file, true)) {
      const handle = await fs.open(file, 'wx', 0o600); await handle.close()
    }
    await guard(); await fs.chmod(file, 0o600); inode = await statFile(file)
    try {
      db = new DatabaseSync(file)
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA auto_vacuum=FULL;')
      const version = db.prepare('PRAGMA user_version').get().user_version
      if (version !== 0 && version !== 1) throw corruption()
      if (version === 0) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length) throw corruption()
        transaction(() => db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          INSERT INTO metadata VALUES('format','dsh-request-traces-sqlite'),('revision','0');
          CREATE TABLE attempts(session_id TEXT NOT NULL,attempt_id TEXT NOT NULL,status TEXT NOT NULL,started_at REAL NOT NULL,is_error INTEGER NOT NULL,is_running INTEGER NOT NULL,detail_bytes INTEGER NOT NULL,summary_json TEXT NOT NULL,detail_json TEXT,PRIMARY KEY(session_id,attempt_id));
          CREATE INDEX attempts_session_time ON attempts(session_id,started_at);
          CREATE INDEX attempts_status_time ON attempts(status,started_at);
          CREATE INDEX attempts_time ON attempts(started_at);
          CREATE TABLE imports(source TEXT NOT NULL,session_id TEXT NOT NULL,attempt_id TEXT NOT NULL,PRIMARY KEY(source,session_id,attempt_id));
          PRAGMA user_version=1;`))
      }
      if (db.prepare("SELECT value FROM metadata WHERE key='format'").get()?.value !== 'dsh-request-traces-sqlite' || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw corruption()
    } catch (error) { db?.close(); db = null; throw error }
  })
  function plan(options = {}) {
    const budgetBytes = integer(options.budgetBytes, 'budgetBytes')
    const cap = integer(options.maxAttempts ?? maxAttempts, 'maxAttempts')
    const days = integer(options.retentionDays ?? retentionDays, 'retentionDays')
    const protect = options.preserveErrors ?? preserveErrors
    const sessionId = options.sessionId
    if (sessionId !== undefined) identity(sessionId)
    const all = rows(), selected = all.filter(a => sessionId === undefined || a.sessionId === sessionId)
    const protectedItem = a => running(a) || (protect && a.isError)
    const oldest = values => values.sort((a, b) => Number(!!a.isError) - Number(!!b.isError) || (timestamp(a) ?? Infinity) - (timestamp(b) ?? Infinity) || a.id.localeCompare(b.id) || a.sessionId.localeCompare(b.sessionId))
    const key = a => JSON.stringify([a.sessionId, a.id]), removed = new Set(), candidates = []
    let remainingAttempts = all.length
    // Row policies always use the GLOBAL count; session filtering only restricts
    // deletion scope, never silently reinterprets the cap as a per-session cap.
    const cutoff = days ? now() - days * 86400000 : null
    let globalRemaining = all.length
    for (const a of oldest(all.filter(a => !protectedItem(a)))) {
      const expired = expiredAt(a, cutoff)
      if (!expired && !(cap && globalRemaining > cap)) continue
      globalRemaining--
      if (sessionId !== undefined && a.sessionId !== sessionId) continue
      candidates.push({ sessionId: a.sessionId, attemptId: a.id, bytes: a.detailBytes, action: 'delete', reason: expired ? 'retention-days' : 'max-attempts' })
      removed.add(key(a)); remainingAttempts--
    }
    const details = selected.filter(a => a.hasDetails)
    const totalBytes = details.reduce((n, a) => n + a.detailBytes, 0)
    let remainingBytes = details.filter(a => !removed.has(key(a))).reduce((n, a) => n + a.detailBytes, 0)
    for (const a of oldest(details.filter(a => !removed.has(key(a)) && !protectedItem(a)))) {
      if (remainingBytes <= budgetBytes) break
      candidates.push({ sessionId: a.sessionId, attemptId: a.id, bytes: a.detailBytes, action: 'evict', reason: 'disk-budget-cleanup' }); remainingBytes -= a.detailBytes
    }
    const countWhere = predicate => all.filter(predicate).length
    const result = { candidateIds: candidates, count: candidates.length, bytes: totalBytes - remainingBytes, totalBytes, remainingBytes, budgetBytes, maxAttempts: cap, retentionDays: days,
      remainingAttempts, totalAttempts: all.length, removedAttemptCount: removed.size, protectedCount: countWhere(a => protect && a.isError), runningCount: countWhere(running),
      protectedBytes: details.filter(a => protect && a.isError).reduce((n, a) => n + a.detailBytes, 0), runningBytes: details.filter(running).reduce((n, a) => n + a.detailBytes, 0),
      overBudget: remainingBytes > budgetBytes, overMaxAttempts: !!cap && remainingAttempts > cap, overLimitCount: cap ? Math.max(0, remainingAttempts - cap) : 0,
      expiredProtectedCount: cutoff === null ? 0 : countWhere(a => protectedItem(a) && expiredAt(a, cutoff)) }
    // No wall-clock cutoff in token: only the actual candidates/result and policy.
    result.token = hash(JSON.stringify({ result, revision: revision(), sessionId, protect }))
    return result
  }
  const api = {
    save(attempt) {
      let value
      try { value = clone(attempt); identity(value.sessionId, value.id) } catch (e) { return Promise.reject(e) }
      return execute(() => transaction(() => { const { item, text } = snapshot(value, now()); put(item, text); changed(); return visible(item) }))
    },
    list(sessionId) {
      identity(sessionId)
      return execute(() => db.prepare('SELECT summary_json FROM attempts WHERE session_id=? ORDER BY rowid').all(sessionId).map(row => visible(JSON.parse(row.summary_json))))
    },
    detail(sessionId, attemptId) {
      identity(sessionId, attemptId)
      return execute(() => {
        const row = db.prepare('SELECT detail_json FROM attempts WHERE session_id=? AND attempt_id=?').get(sessionId, attemptId)
        return row?.detail_json ? JSON.parse(row.detail_json) : null
      })
    },
    sessions() { return execute(() => db.prepare('SELECT session_id AS sessionId,COUNT(*) AS attemptCount,SUM(detail_json IS NOT NULL) AS detailCount,SUM(detail_bytes) AS detailBytes FROM attempts GROUP BY session_id ORDER BY MIN(rowid)').all()) },
    stats(options = {}) { return execute(async () => {
      const all = rows(), cap = integer(options.maxAttempts ?? maxAttempts, 'maxAttempts'), days = integer(options.retentionDays ?? retentionDays, 'retentionDays')
      const protect = options.preserveErrors ?? preserveErrors, cutoff = days ? now() - days * 86400000 : null
      const size = async suffix => (await statFile(file + suffix, true))?.size ?? 0
      const sqliteBytes = await size(''), journalBytes = await size('-journal'), walBytes = await size('-wal'), shmBytes = await size('-shm')
      const sum = values => values.reduce((n, a) => n + a.detailBytes, 0)
      const protectedItems = all.filter(a => protect && a.isError), active = all.filter(running)
      const budgetBytes = options.budgetBytes === undefined ? null : integer(options.budgetBytes, 'budgetBytes')
      const legacyRoots = new Set([root, ...db.prepare("SELECT value FROM metadata WHERE key LIKE 'import-source:%'").all().map(row => row.value)])
      let legacyBytes = 0
      for (const legacyRoot of legacyRoots) legacyBytes += await legacyDiskBytes(legacyRoot)
      return { backend: 'sqlite', databasePath: file, legacyBytes, legacyStorageBytes: legacyBytes, combinedStorageBytes: sqliteBytes + journalBytes + walBytes + shmBytes + legacyBytes, archiveVersion: 1, sessionCount: new Set(all.map(a => a.sessionId)).size, attemptCount: all.length, detailCount: all.filter(a => a.hasDetails).length, detailBytes: sum(all),
        protectedCount: protectedItems.length, protectedBytes: sum(protectedItems), runningCount: active.length, runningBytes: sum(active), evictedCount: all.filter(a => a.detailsEvicted).length,
        maxAttempts: cap, retentionDays: days, overMaxAttempts: !!cap && all.length > cap, overLimitCount: cap ? Math.max(0, all.length - cap) : 0,
        expiredCount: cutoff === null ? 0 : all.filter(a => expiredAt(a, cutoff)).length,
        expiredProtectedCount: cutoff === null ? 0 : all.filter(a => (running(a) || (protect && a.isError)) && expiredAt(a, cutoff)).length,
        ...(budgetBytes === null ? {} : { budgetBytes, overBudget: sum(all) > budgetBytes }), sqliteBytes, journalBytes, walBytes, shmBytes, storageBytes: sqliteBytes + journalBytes + walBytes + shmBytes,
        pageSize: db.prepare('PRAGMA page_size').get().page_size, pageCount: db.prepare('PRAGMA page_count').get().page_count, freePages: db.prepare('PRAGMA freelist_count').get().freelist_count,
        configBytes: 0, indexBytes: 0, logBytes: journalBytes, sessionFileBytes: sqliteBytes + walBytes + shmBytes }
    }) },
    previewCleanup(options) { return execute(() => transaction(() => plan(options))) },
    cleanup(options = {}) { return execute(() => {
      const result = transaction(() => {
        const preview = plan(options), expected = typeof options.expected === 'string' ? options.expected : options.expected?.token
        if (options.expected !== undefined && (typeof expected !== 'string' || !digest.test(expected))) throw new TypeError('expected must be a preview object or token')
        if (expected !== undefined && expected !== preview.token) return { ...preview, stale: true, deletedIds: [], removedIds: [], deletedCount: 0, deletedBytes: 0, deletedAttemptCount: 0, removedCount: 0 }
        for (const candidate of preview.candidateIds) {
          if (candidate.action === 'delete') db.prepare('DELETE FROM attempts WHERE session_id=? AND attempt_id=?').run(candidate.sessionId, candidate.attemptId)
          else {
            const item = JSON.parse(db.prepare('SELECT summary_json FROM attempts WHERE session_id=? AND attempt_id=?').get(candidate.sessionId, candidate.attemptId).summary_json)
            Object.assign(item, { hasDetails: false, detailsEvicted: true, detailsUnavailableReason: 'disk-budget-cleanup', detailBytes: 0 })
            put(item, null)
          }
        }
        if (preview.count) changed()
        return { ...preview, stale: false, deletedIds: preview.candidateIds.filter(a => a.action === 'evict'), removedIds: preview.candidateIds.filter(a => a.action === 'delete'), deletedCount: preview.count, deletedBytes: preview.bytes, deletedAttemptCount: preview.removedAttemptCount, removedCount: preview.removedAttemptCount }
      })
      // DELETE journal + FULL auto_vacuum reclaim pages; VACUUM also compacts
      // old databases upgraded from an earlier non-auto-vacuum layout.
      if (result.deletedCount) db.exec('VACUUM')
      return result
    }) },
    /** Read-only import of the JSON openArchive layout. Each attempt + marker
     * commits atomically. limit/signal permit interruption; repeat to resume.
     * Existing target IDs always win. Source files are never changed/opened RW.
     */
    importJsonArchive({ root: sourceRoot, limit = 0, signal } = {}) {
      integer(limit, 'limit')
      if (typeof sourceRoot !== 'string' || !sourceRoot) throw new TypeError('source root required')
      return execute(async () => {
        const source = await directory(sourceRoot)
        const sourceKey = hash(source)
        if (db.prepare('SELECT 1 FROM metadata WHERE key=?').get(`import-complete:${sourceKey}`)) return { imported: 0, skipped: 0, interrupted: false, complete: true }
        if (!await statFile(path.join(source, 'config', 'format.json'), true)) {
          for (const name of ['index', 'sessions']) {
            try { await fs.lstat(path.join(source, name)); throw corruption() } catch (e) { if (e.code !== 'ENOENT') throw e }
          }
          return { imported: 0, skipped: 0, interrupted: false }
        }
        await directory(path.join(source, 'config')); await directory(path.join(source, 'index')); await directory(path.join(source, 'sessions'))
        const format = (await readJson(path.join(source, 'config', 'format.json'))).value
        if (format?.version !== 1 || format.format !== 'dsh-request-traces') throw corruption()
        let imported = 0, skipped = 0, examined = 0
        transaction(() => db.prepare('INSERT OR IGNORE INTO metadata VALUES(?,?)').run(`import-source:${sourceKey}`, source))
        for (const name of (await fs.readdir(path.join(source, 'index'))).sort()) {
          if (name.endsWith('.tmp')) continue
          if (!/^[0-9a-f]{64}\.json$/.test(name)) throw corruption()
          const index = (await readJson(path.join(source, 'index', name))).value
          if (index?.version !== 1 || identity(index.sessionId) !== name.slice(0, -5) || !Array.isArray(index.attempts)) throw corruption()
          const dir = await directory(path.join(source, 'sessions', name.slice(0, -5))), seen = new Set()
          for (const item of index.attempts) {
            identity(index.sessionId, item.id)
            if (item.sessionId !== index.sessionId || seen.has(item.id) || typeof item.hasDetails !== 'boolean' || !Number.isSafeInteger(item.detailBytes) || item.detailBytes < 0 || (!item.hasDetails && item.detailBytes !== 0)) throw corruption()
            if (item.detailFilename !== undefined && (typeof item.detailFilename !== 'string' || !item.detailFilename.startsWith(`${item.id}.`) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.json$/i.test(item.detailFilename))) throw corruption()
            seen.add(item.id)
            if (signal?.aborted || (limit && examined >= limit)) return { imported, skipped, interrupted: true }
            if (db.prepare('SELECT 1 FROM imports WHERE source=? AND session_id=? AND attempt_id=?').get(sourceKey, item.sessionId, item.id)) { skipped++; continue }
            examined++
            let text = null
            // Existing target IDs win, but source evidence still gets validated.
            const exists = db.prepare('SELECT 1 FROM attempts WHERE session_id=? AND attempt_id=?').get(item.sessionId, item.id)
            if (item.hasDetails) {
              const detailName = item.detailFilename ?? `${item.id}.json`
              if (!new RegExp(`^${item.id}(?:\\.[0-9a-f-]{36})?\\.json$`, 'i').test(detailName)) throw corruption()
              const detail = await readJson(path.join(dir, detailName))
              if (detail.bytes !== item.detailBytes || detail.value?.id !== item.id || detail.value.sessionId !== item.sessionId) throw corruption()
              text = JSON.stringify(detail.value)
            }
            // Keep the source summary verbatim (except private filename); do not
            // reconstruct it from detail and lose archived metadata/evidence.
            const copy = clone(item); delete copy.detailFilename
            if (copy.hasDetails && !exists) copy.detailBytes = Buffer.byteLength(text)
            transaction(() => {
              if (!exists) { put(copy, text); changed(); imported++ } else skipped++
              db.prepare('INSERT OR IGNORE INTO imports VALUES(?,?,?)').run(sourceKey, item.sessionId, item.id)
            })
          }
        }
        transaction(() => db.prepare('INSERT OR IGNORE INTO metadata VALUES(?,?)').run(`import-complete:${sourceKey}`, String(now())))
        return { imported, skipped, interrupted: false }
      })
    },
    close() {
      if (closing) return closing
      closing = enqueue(async () => { db?.close(); db = null })
      closed = true
      return closing
    },
  }
  api.get = api.detail
  api.status = api.stats
  api.preview = api.previewCleanup
  api.session = api.list
  return api
}
