import { z } from 'zod'
import { createHash } from 'node:crypto'
import { createRecorder, cleanFailure } from './core.js'
import { appendError, summary } from './evidence.js'
import { diagnose } from './diagnosis.js'
import { createTransport } from './transport.js'
import { openSqliteArchive as openArchive } from './sqlite-archive.js'
import { Config, readConfig, archiveRoot } from './config.js'
export { Config }

export const name = 'dsh-trace'
export const inject = ['storageDomain', 'connection', 'sessions', 'sessionProjections']
const success = value => Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
const failure = (code, message) => Response.json({ ok: false, error: { code, message } }, { headers: { 'cache-control': 'no-store' } })
const validSession = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function apply(ctx, config) {
  const domain = await ctx.storageDomain.open({
    name: 'dsh_trace', version: 1, layout: 'single',
    global: { schema: z.object({ installedAt: z.number(), detailsSince: z.number().optional(), archiveMigrated: z.boolean().optional(), truncated: z.boolean(), attempts: z.array(z.record(z.string(), z.unknown())) }), initial: { installedAt: Date.now(), truncated: false, attempts: [] } }, tables: {},
  })
  const metadata = structuredClone(domain.global.get())
  metadata.detailsSince ??= Date.now()
  let settings = readConfig(config)
  // Legacy installs and test fixtures retain their original location for this activation.
  const root = archiveRoot(settings.directory)
  const archive = await openArchive({ root })
  try { await archive.importJsonArchive({ root }) }
  catch (error) { await archive.close(); await domain.close(); throw error }
  let storageError, disposed = false, timer, writing, recorder
  // Legacy capture loss is persistent evidence. Recorder cache trims are not archive loss.
  const legacyTruncated = metadata.truncated === true
  const state = { attempts: [], truncated: false }
  const pending = new Map(), saved = new Map(), revisions = new Map()
  let serial = Promise.resolve(), maintenance
  const cleanupIntervalMs = 600000
  const locked = task => {
    const result = serial.catch(() => {}).then(task)
    serial = result.catch(() => {})
    return result
  }
  function remember(attempt) {
    const revision = (revisions.get(attempt.id) ?? 0) + 1
    revisions.set(attempt.id, revision)
    pending.set(attempt.id, { revision, value: structuredClone(attempt) })
  }
  function changed() {
    if (!timer && !disposed) timer = setTimeout(() => { timer = undefined; return flush() }, 250)
  }
  function applySettings() {
    // Directory is an internal startup compatibility option, not a live migration feature.
    settings = { ...readConfig(config), directory: settings.directory }
    syncMaintenance()
  }
  function syncMaintenance() {
    if (disposed || !settings.autoCleanup) {
      if (maintenance !== undefined) clearInterval(maintenance)
      maintenance = undefined
    } else if (maintenance === undefined) {
      maintenance = setInterval(() => {
        if (disposed) return
        void flush().then(() => locked(async () => {
          if (disposed || !settings.autoCleanup) return
          try { invalidateDetails(await archive.cleanup({ budgetBytes: Math.floor(settings.detailBudgetMiB * 1024 * 1024), maxAttempts: settings.maxAttempts, retentionDays: settings.retentionDays, preserveErrors: settings.preserveErrors })) }
          catch (error) { storageError = cleanFailure(error)?.message }
        }))
      }, cleanupIntervalMs)
      maintenance.unref?.()
    }
  }
  async function writePending() {
    for (const [id, entry] of [...pending]) {
      await archive.save(entry.value)
      saved.set(id, entry.revision)
      if (pending.get(id) === entry) pending.delete(id)
    }
  }
  function flush() {
    if (writing) return writing
    writing = locked(async () => {
      try {
        applySettings()
        await writePending()
        recorder?.trimDetails()
        storageError = undefined
      } catch (error) { storageError = cleanFailure(error)?.message ?? 'Archive write failed' }
    }).finally(() => { writing = undefined })
    return writing
  }
  try {
    if (!metadata.archiveMigrated) {
      for (const original of metadata.attempts) {
        const attempt = structuredClone(original)
        if (!uuid.test(attempt.id)) {
          const hex = createHash('sha256').update(String(attempt.sessionId) + ':' + String(attempt.id)).digest('hex').slice(0, 32)
          attempt.legacyId = attempt.id; attempt.id = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
        }
        attempt.reasoningEffort ??= attempt.request?.value?.reasoningEffort
        if (!attempt.request && !attempt.response && !attempt.http && !attempt.errors?.length) {
          attempt.hasDetails = false
          attempt.detailsUnavailableReason = 'legacy-summary-only'
        }
        await archive.save(attempt)
      }
      metadata.archiveMigrated = true
      metadata.attempts = []
      await domain.global.set(metadata)
    }
    const summaries = []
    for (const session of await archive.sessions()) {
      for (let item of await archive.list(session.sessionId)) {
        if (item.status === 'running') {
          const detail = await archive.detail(item.sessionId, item.id) ?? item
          detail.status = 'interrupted'; detail.observationInterrupted = true
          item = await archive.save(detail)
        }
        summaries.push({ ...item, cacheEvicted: true })
      }
    }
    summaries.sort((a,b) => a.startedAt - b.startedAt)
    state.attempts = summaries.slice(-settings.memoryAttemptLimit)
  } catch (error) { await archive.close(); await domain.close(); throw error }

  const transport = createTransport({ changed, now: Date.now })
  ctx.sessionProjections.register({
    key: 'dshTracePosition', stateVersion: 1,
    stateSchema: z.object({ turn: z.number().optional(), step: z.number().optional(), retryEvent: z.object({ retryId: z.string(), retry: z.number(), delayMs: z.number(), provider: z.string() }).optional() }),
    init: () => ({}),
    apply: (state, event) => {
      if (event.type === 'step/start') return { turn: event.data.turn, step: event.data.step }
      if (event.type === 'turn/start') return { turn: event.data.turn }
      if (event.type === 'llm/retry') return { ...state, retryEvent: { retryId: event.data.retryId, retry: event.data.retry, delayMs: event.data.delayMs, provider: event.data.provider } }
      return state
    },
  })
  recorder = createRecorder({ state, changed, transport, onRecord: remember,
    canEvict: a => saved.get(a.id) === revisions.get(a.id) && !pending.has(a.id),
    limit: () => settings.memoryAttemptLimit, detailBudget: () => settings.memoryCacheMiB * 1024 * 1024,
    captureLimits: () => { const live = readConfig(config); return { requestBytes: live.requestLimitKiB * 1024, responseBytes: live.responseLimitKiB * 1024, httpBodyBytes: live.httpBodyLimitKiB * 1024, responseEvents: live.responseEventLimit } },
    position: options => {
      if (options.purpose) return {}
      const session = ctx.sessions.get(options.sessionId)
      return session ? ctx.sessionProjections.stateOf(session, 'dshTracePosition') ?? {} : {}
    },
  })
  ctx.on('llm/stream', (options, next) => recorder.observe(options, next))
  ctx.on('agent/request-error', async (payload, next) => {
    const observedAt = Date.now(), action = await next()
    try {
      const attempt = state.attempts.findLast(a => a.sessionId === payload.agent.id && a.turn === payload.turn && a.step === payload.step && a.provider === payload.provider && a.status === 'error')
      if (attempt) {
        // A late retry decision may arrive after the memory payload was released.
        void locked(async () => {
          const full = attempt.cacheEvicted ? await archive.detail(attempt.sessionId, attempt.id) : attempt
          if (full) {
            full.failure = cleanFailure(payload.failure); appendError(full, payload.failure, 'agent-request-error', observedAt)
            full.retryApproved = action?.kind === 'retry'
            Object.assign(attempt, full); delete attempt.cacheEvicted
            remember(attempt); changed()
          }
        }).catch(error => { storageError = cleanFailure(error)?.message })
      }
    } catch {}
    return action
  })
  async function sessionAttempts(sessionId) {
    const records = new Map((await archive.list(sessionId)).map(a => [a.id, a]))
    for (const attempt of state.attempts) if (attempt.sessionId === sessionId && (pending.has(attempt.id) || attempt.status === 'running')) records.set(attempt.id, summary(attempt))
    return [...records.values()]
  }
  async function attemptDetail(sessionId, id) {
    const live = state.attempts.find(a => a.sessionId === sessionId && a.id === id && !a.cacheEvicted && !a.detailsEvicted)
    const attempt = live ?? await archive.detail(sessionId, id) ?? (await archive.list(sessionId)).find(a => a.id === id)
    return attempt ? { ...attempt, diagnosis: diagnose(attempt) } : attempt
  }
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/dsh-trace/session', methods: ['POST'], requestBody: 'buffered', fetch: async request => {
    let body
    try { body = await request.json() } catch { return failure('bad-request', 'Expected JSON') }
    if (!validSession(body?.sessionId)) return failure('bad-request', 'Expected sessionId')
    if (body.attemptId !== undefined && (typeof body.attemptId !== 'string' || !uuid.test(body.attemptId))) return failure('bad-request', 'Expected UUID attemptId')
    if (body.export !== undefined && typeof body.export !== 'boolean') return failure('bad-request', 'Expected boolean export')
    await flush()
    try {
      if (body.attemptId !== undefined) {
        const attempt = await attemptDetail(body.sessionId, body.attemptId)
        return attempt ? success({ attempt }) : failure('not-found', 'Attempt not retained in this session')
      }
      let attempts = await sessionAttempts(body.sessionId)
      if (body.export) attempts = await Promise.all(attempts.map(a => attemptDetail(body.sessionId, a.id)))
      return success({ version: 2, archiveVersion: 1, installedAt: metadata.installedAt, detailsSince: metadata.detailsSince, truncated: legacyTruncated, ...(storageError ? { storageError } : {}), attempts })
    } catch (error) { return failure('archive-error', cleanFailure(error)?.message ?? 'Archive read failed') }
  } }))
  function invalidateDetails(result) {
    const removed = new Set((result.removedIds ?? []).map(a => `${a.sessionId}:${a.attemptId}`))
    state.attempts = state.attempts.filter(a => !removed.has(`${a.sessionId}:${a.id}`))
    for (const entry of result.deletedIds ?? []) {
      const item = state.attempts.find(a => a.id === entry.attemptId && a.sessionId === entry.sessionId)
      if (item) { const clean = summary(item); for (const key of Object.keys(item)) delete item[key]; Object.assign(item, clean, { hasDetails: false, detailsEvicted: true, detailsUnavailableReason: 'disk-budget-cleanup', detailBytes: 0, cacheEvicted: true }) }
    }
  }
  const boundedManagement = ({ candidateIds, deletedIds, removedIds, ...result }) => result
  async function manage(body) {
    if (!['status','preview','cleanup'].includes(body?.action) || (body.sessionId !== undefined && !validSession(body.sessionId)) || (body.action !== 'status' && !validSession(body.sessionId))) throw new Error('Expected action and sessionId for preview/cleanup')
    await flush()
    return locked(async () => {
      const budgetBytes = Math.floor(settings.detailBudgetMiB * 1024 * 1024)
      if (body.action === 'status') {
        const stats = await archive.stats({ maxAttempts: settings.maxAttempts, retentionDays: settings.retentionDays, preserveErrors: settings.preserveErrors })
        return { root, backend: 'sqlite', maxAttempts: settings.maxAttempts, retentionDays: settings.retentionDays, autoCleanup: settings.autoCleanup, budgetBytes, preserveErrors: settings.preserveErrors, ...stats, retainedBytes: body.sessionId === undefined ? stats.detailBytes : (await archive.list(body.sessionId)).reduce((n,a) => n + a.detailBytes, 0), ...(body.sessionId === undefined ? { sessions: await archive.sessions() } : {}), ...(storageError ? { storageError } : {}) }
      }
      const options = { budgetBytes, maxAttempts: settings.maxAttempts, retentionDays: settings.retentionDays, preserveErrors: settings.preserveErrors, sessionId: body.sessionId }
      if (body.action === 'preview') return boundedManagement(await archive.previewCleanup(options))
      if (typeof body.token !== 'string' || !/^[0-9a-f]{64}$/.test(body.token)) throw new Error('Preview token required')
      const result = await archive.cleanup({ ...options, expected: body.token })
      invalidateDetails(result)
      return boundedManagement(result)
    })
  }
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/dsh-trace/manage', methods: ['POST'], requestBody: 'buffered', fetch: async request => {
    try { return success(await manage(await request.json())) }
    catch (error) { return failure('management-error', cleanFailure(error)?.message ?? 'Management operation failed') }
  } }))
  const settingsPatch = z.object({
    autoCleanup: z.boolean().optional(), detailBudgetMiB: z.number().finite().min(0).max(1048576).optional(),
    preserveErrors: z.boolean().optional(), maxAttempts: z.number().int().min(0).max(10000000).optional(),
    retentionDays: z.union([z.literal(0), z.literal(3), z.literal(7), z.literal(15)]).optional(),
  }).strict()
  async function configure(body) {
    if (!['get', 'update'].includes(body?.action)) throw new Error('Expected get or update action')
    if (body.action === 'update') {
      const patch = settingsPatch.parse(body.settings)
      const editor = ctx.get?.('configEditor')
      if (!editor) throw new Error('Configuration editor is unavailable')
      const candidates = editor.entries().filter(entry => entry.options?.name === '@local/dsh-trace')
      if (candidates.length !== 1) throw new Error('Expected one addressable request trace configuration')
      // Loader owns config persistence; never write profile files directly.
      await editor.edit(candidates[0], current => ({ ...current, ...patch }))
    }
    await flush()
    // A coalesced write may have read its snapshot before editor.edit completed.
    // Volatile refs expose get(), not subscribe(); reconcile explicitly on this event.
    applySettings()
    return { settings: { ...settings }, backend: 'sqlite', root, databasePath: (await archive.stats()).databasePath,
      editable: !!ctx.get?.('configEditor'), cleanupIntervalSeconds: 600 }
  }
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/dsh-trace/settings', methods: ['POST'], requestBody: 'buffered', fetch: async request => {
    try { return success(await configure(await request.json())) }
    catch (error) { return failure('settings-error', cleanFailure(error)?.message ?? 'Settings operation failed') }
  } }))
  const tools = ctx.get?.('tools')
  if (tools) ctx.effect(() => tools.register({
    name: 'harness_trace_settings', description: '查看或修改请求追踪的自动清理、保留天数、条数与容量上限以及异常保护；保存不立即删除记录。',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['get', 'update'] },
      settings: { type: 'object', properties: {
        autoCleanup: { type: 'boolean' }, preserveErrors: { type: 'boolean' },
        detailBudgetMiB: { type: 'number', minimum: 0, maximum: 1048576 },
        maxAttempts: { type: 'integer', minimum: 0, maximum: 10000000, description: '0 不限；异常保护可能使总数超限。' },
        retentionDays: { type: 'integer', enum: [0, 3, 7, 15], description: '保留天数；0 不限。' },
      }, additionalProperties: false, description: 'update 时填写要修改的字段。' },
    }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: args => configure(args),
  }))
  if (tools) ctx.effect(() => tools.register({
    name: 'harness_trace_manage',
    description: '查看当前会话请求追踪存储状态，预览或确认清理。超龄及超条数记录整条删除，容量清理只删除详情；异常保护按设置执行。',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['status','preview','cleanup'] }, token: { type: 'string', description: 'cleanup 时填写同一会话 preview 返回的 token；过期预览不删除。' } }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      if (!validSession(exec.agent?.id)) throw new Error('Expected action and sessionId: current session required')
      return manage({ ...args, sessionId: exec.agent.id })
    },
  }))
  syncMaintenance()
  ctx.effect(() => async () => {
    disposed = true; transport.dispose(); clearTimeout(timer); clearInterval(maintenance)
    for (const attempt of state.attempts) if (attempt.status === 'running') { attempt.status = 'interrupted'; attempt.observationInterrupted = true; remember(attempt) }
    await flush(); await serial
    await archive.close(); await domain.close()
  })
}
