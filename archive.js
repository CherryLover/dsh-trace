import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { summary } from './evidence.js'

const queues = new Map()
const hash = value => createHash('sha256').update(value).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
const publicSummary = item => {
  const { detailFilename, ...visible } = summary(item)
  if (!item.hasDetails) visible.detailsUnavailableReason = item.detailsUnavailableReason ?? 'unavailable'
  else delete visible.detailsUnavailableReason
  return clone(visible)
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const digest = /^[0-9a-f]{64}$/
function identity(sessionId, id) {
  if (typeof sessionId !== 'string' || !sessionId.length) throw new TypeError('sessionId must be a nonempty string')
  if (id !== undefined && (typeof id !== 'string' || !uuid.test(id))) throw new TypeError('attemptId must be a UUID')
  return hash(sessionId)
}
function corrupt() { return new Error('Archive corruption: invalid or missing archive data') }
async function regular(file, optional = false) {
  try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw corrupt(); return stat }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error.code === 'ENOENT' ? corrupt() : error }
}
async function json(file, optional = false) {
  if (!await regular(file, optional)) return null
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { throw corrupt() }
}
async function directory(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw corrupt()
}
async function atomic(file, value) {
  await regular(file, true)
  const temp = `${file}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await fs.open(temp, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = null
    await fs.rename(temp, file)
    const dirHandle = await fs.open(path.dirname(file), 'r')
    try { await dirHandle.sync() } finally { await dirHandle.close() }
  } finally { await handle?.close(); await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
function failed(value) { return summary(value).hasAnomaly }
const detailFilename = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.json$/i
const LOG_LIMIT = 1024 * 1024
const ORPHAN_LIMIT = 1000
const running = item => ['running', 'pending', 'streaming', 'in_progress', 'in-progress'].includes(item.status) || item.running === true

/** JSON archive. Budgets measure retained detail JSON bytes, not index/log overhead.
 * cleanup({expected}) accepts a preview object or token; stale previews delete nothing.
 * All operations are serialized per resolved root within this process. */
export async function openArchive({ root = path.join(homedir(), '.dsh', 'request-traces'), now = Date.now } = {}) {
  root = path.resolve(root)
  let closed = false
  const enqueue = task => {
    if (closed) return Promise.reject(new Error('Archive is closed'))
    const previous = queues.get(root) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(task)
    const tail = result.catch(() => {})
    queues.set(root, tail)
    tail.then(() => { if (queues.get(root) === tail) queues.delete(root) })
    return result
  }
  const indexPath = key => path.join(root, 'index', `${key}.json`)
  const detailPath = (key, item) => path.join(root, 'sessions', key, item.detailFilename ?? `${item.id}.json`)
  async function indexes({ verifyFiles = false } = {}) {
    const result = []
    for (const name of (await fs.readdir(path.join(root, 'index'))).sort()) {
      if (name.endsWith('.tmp')) continue
      if (!/^[0-9a-f]{64}\.json$/.test(name)) throw corrupt()
      const key = name.slice(0, -5), data = await json(indexPath(key))
      if (!data || data.version !== 1 || typeof data.sessionId !== 'string' || identity(data.sessionId) !== key || !Array.isArray(data.attempts)) throw corrupt()
      const sessionDir = await fs.lstat(path.join(root, 'sessions', key)).catch(() => { throw corrupt() })
      if (!sessionDir.isDirectory() || sessionDir.isSymbolicLink()) throw corrupt()
      const ids = new Set()
      for (const item of data.attempts) {
        identity(data.sessionId, item.id)
        if (item.sessionId !== data.sessionId || ids.has(item.id) || typeof item.hasDetails !== 'boolean' || !Number.isSafeInteger(item.detailBytes) || item.detailBytes < 0) throw corrupt()
        ids.add(item.id)
        if (item.detailFilename !== undefined && (!detailFilename.test(item.detailFilename) || !item.detailFilename.startsWith(`${item.id}.`))) throw corrupt()
        if (!item.hasDetails && item.detailBytes !== 0) throw corrupt()
        if (item.hasDetails && verifyFiles) {
          const stat = await regular(detailPath(key, item))
          if (stat.size !== item.detailBytes) throw corrupt()
        }
      }
      result.push({ key, ...data })
    }
    return result
  }
  async function sweepOrphans(all) {
    const references = new Set(all.flatMap(s => s.attempts.filter(a => a.hasDetails).map(a => `${s.key}/${a.detailFilename ?? `${a.id}.json`}`)))
    let examined = 0, removed = 0
    // Bounded unlink work; later openings resume removal of remaining orphan revisions.
    for (const key of await fs.readdir(path.join(root, 'sessions'))) {
      if (!digest.test(key)) throw corrupt()
      const dir = path.join(root, 'sessions', key)
      const stat = await fs.lstat(dir)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw corrupt()
      for (const name of await fs.readdir(dir)) {
        if (references.has(`${key}/${name}`)) continue
        if (++examined > ORPHAN_LIMIT) return removed
        if (detailFilename.test(name) || /^[0-9a-f.-]+\.json\.[0-9a-f-]+\.tmp$/i.test(name)) {
          await regular(path.join(dir, name)); await fs.unlink(path.join(dir, name)); removed++
        }
      }
    }
    return removed
  }
  async function log(event) {
    const file = path.join(root, 'logs', 'management.jsonl'), backup = path.join(root, 'logs', 'management.1.jsonl')
    const line = JSON.stringify({ at: now(), ...event }) + '\n'
    const stat = await regular(file, true)
    if ((stat?.size ?? 0) + Buffer.byteLength(line) > LOG_LIMIT) {
      if (await regular(backup, true)) await fs.unlink(backup)
      if (stat) await fs.rename(file, backup)
    }
    await fs.appendFile(file, line, { mode: 0o600 })
  }
  await enqueue(async () => {
    await directory(root)
    for (const dir of ['config', 'index', 'sessions', 'logs']) await directory(path.join(root, dir))
    const formatPath = path.join(root, 'config', 'format.json')
    const hasFormat = await regular(formatPath, true)
    const format = hasFormat ? await json(formatPath) : null
    if (hasFormat) { if (!format || format.version !== 1 || format.format !== 'dsh-request-traces') throw corrupt() }
    else {
      if ((await fs.readdir(path.join(root, 'index'))).length || (await fs.readdir(path.join(root, 'sessions'))).length) throw corrupt()
      await atomic(formatPath, { format: 'dsh-request-traces', version: 1 })
    }
    const all = await indexes({ verifyFiles: true })
    await sweepOrphans(all)
  })
  function plan(all, { budgetBytes, preserveErrors = true, sessionId } = {}) {
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) throw new TypeError('budgetBytes must be a nonnegative safe integer')
    if (sessionId !== undefined) identity(sessionId)
    const items = all.filter(s => sessionId === undefined || s.sessionId === sessionId).flatMap(s => s.attempts).filter(a => a.hasDetails)
    const totalBytes = items.reduce((n, a) => n + a.detailBytes, 0)
    const protectedBytes = items.filter(a => preserveErrors && a.isError).reduce((n, a) => n + a.detailBytes, 0)
    const runningBytes = items.filter(running).reduce((n, a) => n + a.detailBytes, 0)
    const eligible = items.filter(a => !running(a) && !(preserveErrors && a.isError)).sort((a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0) || a.id.localeCompare(b.id))
    let remainingBytes = totalBytes
    const candidateIds = []
    for (const a of eligible) {
      if (remainingBytes <= budgetBytes) break
      candidateIds.push({ sessionId: a.sessionId, attemptId: a.id, bytes: a.detailBytes }); remainingBytes -= a.detailBytes
    }
    const result = { candidateIds, bytes: totalBytes - remainingBytes, count: candidateIds.length, totalBytes, remainingBytes, protectedBytes, runningBytes, overBudget: remainingBytes > budgetBytes, budgetBytes }
    // Include all current metadata: a save with equal byte length also invalidates a preview.
    result.token = hash(JSON.stringify({ result, sessionId, preserveErrors, items }))
    return result
  }
  return {
    save(attempt) {
      // Capture immediately so callers can continue mutating their live recorder object.
      let value
      try { value = clone(attempt); identity(value.sessionId, value.id) } catch (error) { return Promise.reject(error) }
      return enqueue(async () => {
        const all = await indexes(), key = identity(value.sessionId, value.id)
        const existing = all.find(s => s.key === key)
        await directory(path.join(root, 'sessions', key))
        const text = JSON.stringify(value)
        const hasDetails = !value.detailsEvicted && value.hasDetails !== false && ['request', 'response', 'http', 'errors'].some(field => value[field] !== undefined && value[field] !== null)
        const item = { ...summary(value), errorCount: Math.max(Number(value.errorCount) || 0, Number(value.observedErrorCount) || 0, value.errors?.length || 0), hasDetails, detailsEvicted: !!value.detailsEvicted, detailBytes: hasDetails ? Buffer.byteLength(text) : 0, isError: !!failed(value), archivedAt: now() }
        delete item.detailFilename
        if (hasDetails) delete item.detailsUnavailableReason
        else item.detailsUnavailableReason = value.detailsUnavailableReason ?? 'unavailable'
        if (hasDetails) item.detailFilename = `${value.id}.${randomUUID()}.json`
        const attempts = existing?.attempts ?? []
        const i = attempts.findIndex(a => a.id === value.id), previous = attempts[i]
        if (i < 0) attempts.push(item); else attempts[i] = item
        // Immutable revision first, then atomic index commit. A failed commit leaves
        // the previous revision readable and an orphan removed on next startup.
        if (hasDetails) await atomic(detailPath(key, item), value)
        await atomic(indexPath(key), { version: 1, sessionId: value.sessionId, attempts })
        if (previous?.hasDetails) await fs.unlink(detailPath(key, previous)).catch(e => { if (e.code !== 'ENOENT') throw e })
        await log({ action: 'save', sessionHash: key, attemptId: value.id, detailBytes: item.detailBytes })
        return publicSummary(item)
      })
    },
    list(sessionId) { identity(sessionId); return enqueue(async () => ((await indexes()).find(s => s.sessionId === sessionId)?.attempts ?? []).map(publicSummary)) },
    detail(sessionId, attemptId) {
      const key = identity(sessionId, attemptId)
      return enqueue(async () => {
        const item = (await indexes()).find(s => s.sessionId === sessionId)?.attempts.find(a => a.id === attemptId)
        if (!item?.hasDetails) return null
        const file = detailPath(key, item), stat = await regular(file), value = await json(file)
        if (stat.size !== item.detailBytes || !value || value.sessionId !== sessionId || value.id !== attemptId) throw corrupt()
        return value
      })
    },
    sessions() { return enqueue(async () => (await indexes()).map(s => ({ sessionId: s.sessionId, attemptCount: s.attempts.length, detailCount: s.attempts.filter(a => a.hasDetails).length, detailBytes: s.attempts.reduce((n, a) => n + a.detailBytes, 0) }))) },
    stats() { return enqueue(async () => {
      const all = await indexes(), items = all.flatMap(s => s.attempts)
      async function diskBytes(dir) {
        let bytes = 0
        for (const name of await fs.readdir(dir)) {
          const file = path.join(dir, name), stat = await fs.lstat(file)
          if (stat.isSymbolicLink()) throw corrupt()
          if (stat.isDirectory()) bytes += await diskBytes(file)
          else if (stat.isFile()) bytes += stat.size
          else throw corrupt()
        }
        return bytes
      }
      const configBytes = await diskBytes(path.join(root, 'config'))
      const indexBytes = await diskBytes(path.join(root, 'index'))
      const logBytes = await diskBytes(path.join(root, 'logs'))
      const sessionFileBytes = await diskBytes(path.join(root, 'sessions'))
      return { sessionCount: all.length, attemptCount: items.length, detailCount: items.filter(a => a.hasDetails).length, detailBytes: items.reduce((n, a) => n + a.detailBytes, 0), protectedBytes: items.filter(a => a.isError).reduce((n, a) => n + a.detailBytes, 0), runningBytes: items.filter(running).reduce((n, a) => n + a.detailBytes, 0), evictedCount: items.filter(a => a.detailsEvicted).length, configBytes, indexBytes, logBytes, sessionFileBytes, storageBytes: configBytes + indexBytes + logBytes + sessionFileBytes }
    }) },
    previewCleanup(options) { return enqueue(async () => plan(await indexes(), options)) },
    cleanup(options) { return enqueue(async () => {
      const all = await indexes(), preview = plan(all, options)
      const expected = typeof options.expected === 'string' ? options.expected : options.expected?.token
      if (options.expected !== undefined && (typeof expected !== 'string' || !digest.test(expected))) throw new TypeError('expected must be a preview object or token')
      if (expected !== undefined && expected !== preview.token) return { ...preview, stale: true, deletedIds: [], deletedBytes: 0, deletedCount: 0 }
      let deletedBytes = 0
      const deletedIds = []
      for (const candidate of preview.candidateIds) {
        const s = all.find(s => s.sessionId === candidate.sessionId), a = s.attempts.find(a => a.id === candidate.attemptId)
        if (running(a)) continue
        const file = detailPath(s.key, a)
        a.hasDetails = false; a.detailsEvicted = true; a.detailsUnavailableReason = 'disk-budget-cleanup'; a.detailBytes = 0
        delete a.detailFilename
        const { key, ...data } = s
        await atomic(indexPath(key), data)
        await fs.unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e })
        deletedBytes += candidate.bytes; deletedIds.push(candidate)
      }
      await log({ action: 'cleanup', deletedCount: deletedIds.length, deletedBytes, overBudget: preview.overBudget })
      return { ...preview, stale: false, deletedIds, deletedBytes, deletedCount: deletedIds.length }
    }) },
    close() { if (closed) return Promise.resolve(); const pending = enqueue(async () => {}); closed = true; return pending },
  }
}
