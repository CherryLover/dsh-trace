import { randomUUID } from 'node:crypto'
import { snapshot, recordChunk, appendError, summary, errorEvidence } from './evidence.js'

export function cleanFailure(value) {
  if (!value) return undefined
  const evidence = errorEvidence(value, 'normalized-failure')
  const clean = (input, max) => String(input ?? '').replace(/https?:\/\/[^\s"<>]+/gi, '[url redacted]').replace(/(token\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]').slice(0, max)
  return { message: clean(evidence.message, 1200), code: clean(evidence.code, 100), ...(Number.isFinite(evidence.status) ? { status: evidence.status } : {}), ...(evidence.requestId ? { requestId: clean(evidence.requestId, 160) } : {}), truncated: evidence.truncated || evidence.message.length > 1200 }
}

export function createRecorder({ state, changed, position, transport, now = Date.now, monotonic = () => performance.now(), limit = 5000, detailBudget = 32 * 1024 * 1024, onRecord, canEvict = () => true, captureLimits = () => ({}) }) {
  const active = new Set()
  function trimDetails() {
    let retained = 0
    for (let i = state.attempts.length - 1; i >= 0; i--) {
      const item = state.attempts[i]
      const bytes = Buffer.byteLength(JSON.stringify(item))
      if (retained + bytes > (typeof detailBudget === 'function' ? detailBudget() : detailBudget) && !active.has(item.id) && canEvict(item)) {
        const compact = summary(item)
        for (const key of Object.keys(item)) delete item[key]
        Object.assign(item, compact, onRecord ? { cacheEvicted: true } : { hasDetails: false, detailsEvicted: true })
        state.truncated = true
      } else retained += bytes
    }
  }
  let lastProgress = 0
  async function* observe(options, next) {
    if (!options.sessionId) { yield* next(); return }
    let attempt
    let startMono
    try {
      const startedAt = now()
      startMono = monotonic()
      attempt = { id: randomUUID(), sessionId: options.sessionId, provider: String(options.provider), model: String(options.model), ...(typeof options.reasoningEffort === 'string' ? { reasoningEffort: options.reasoningEffort } : {}), purpose: options.purpose ?? 'generation', ...position(options), startedAt, status: 'running', outputChunks: 0 }
      const previous = state.attempts.findLast(a => a.sessionId === attempt.sessionId && a.turn === attempt.turn && a.step === attempt.step && a.purpose === attempt.purpose)
      if (attempt.step !== undefined && previous?.status === 'error' && previous.endedAt !== undefined && (previous.retryApproved || (attempt.retryEvent?.provider === attempt.provider && (previous.retryEvent?.retryId !== attempt.retryEvent.retryId || previous.retryEvent?.retry !== attempt.retryEvent.retry)))) {
        attempt.retryOf = previous.id
        attempt.retryGapMs = Math.max(0, startedAt - previous.endedAt)
      }
      attempt.captureLimits = Object.freeze({ ...captureLimits() })
      attempt.request = snapshot(options, attempt.captureLimits.requestBytes)
      attempt.response = { source: 'llm/stream normalized events; not raw HTTP', events: [], observedChunks: 0, observedJsonBytes: 0, capturedBytes: 0, truncated: false }
      attempt.errors = []
      state.attempts.push(attempt)
      active.add(attempt.id)
      while (state.attempts.length > (typeof limit === 'function' ? limit() : limit)) {
        const index = state.attempts.findIndex(a => !active.has(a.id) && canEvict(a))
        if (index < 0) break
        state.attempts.splice(index, 1)
        state.truncated = true
      }
      onRecord?.(attempt)
      changed()
    } catch { attempt = undefined }
    try {
      for await (const chunk of (attempt && transport ? transport.wrap(attempt, next) : next())) {
        if (attempt) {
          try {
            const observedAt = now()
            if ((chunk.type === 'text-delta' && chunk.text) || (chunk.type === 'reasoning-delta' && chunk.text) || (chunk.type === 'tool-call-delta' && (chunk.argumentsDelta || chunk.name))) {
              attempt.firstOutputAt ??= observedAt
              attempt.firstOutputMs ??= Math.max(0, monotonic() - startMono)
              attempt.outputChunks++
            }
            if (chunk.type === 'finish') {
              attempt.status = chunk.reason.kind
              if (chunk.reason.failure) {
                attempt.failure = cleanFailure(chunk.reason.failure)
                appendError(attempt, chunk.reason.failure, 'adapter-finish', observedAt)
              }
            }
            recordChunk(attempt, chunk, observedAt)
            if (observedAt - lastProgress >= 1000) { lastProgress = observedAt; onRecord?.(attempt); changed() }
          } catch {}
        }
        yield chunk
      }
    } catch (error) {
      if (attempt) {
        try {
          attempt.status = options.signal?.aborted ? 'aborted' : 'error'
          attempt.failure = cleanFailure(error)
          appendError(attempt, error, 'stream-iteration', now())
        } catch {}
      }
      throw error
    } finally {
      if (attempt) {
        try {
          attempt.endedAt = now()
          attempt.durationMs = Math.max(0, monotonic() - startMono)
          if (attempt.status === 'running') attempt.status = options.signal?.aborted ? 'aborted' : 'interrupted'
          active.delete(attempt.id)
          onRecord?.(attempt)
          trimDetails()
          changed()
        } catch {}
      }
    }
  }
  return { observe, trimDetails }
}
