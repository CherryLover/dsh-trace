import { diagnose } from './diagnosis.js'
// Bounded, JSON-safe diagnostic copies. Never mutate the model request or chunks.
export const REQUEST_LIMIT = 512 * 1024
export const RESPONSE_LIMIT = 256 * 1024
const SECRET = /^(authorization|proxy-authorization|cookie|set-cookie|x[-_](?:api[-_]key|auth[-_]token|goog[-_]api[-_]key)|api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|credential)$/i
export function redactText(value) {
  return String(value).replace(/Bearer\s+[^\s,;"']+/gi, 'Bearer [redacted]').replace(/\b(?:sk|ds)-[\w-]{12,}/g, '[redacted]').replace(/((?:api[_-]?key|authorization|cookie|access[_-]?token|refresh[_-]?token|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@').replace(/([?&](?:key|token|api_key|access_token|secret|password)=)[^&#\s"']*/gi, '$1[redacted]')
}
export function safeGet(value, key) { try { return value?.[key] } catch { return undefined } }
export function snapshot(value, limit = REQUEST_LIMIT, source = 'llm/stream GenerateOptions (not wire payload)') {
  try {
    const original = JSON.stringify(value, (key, item) => key === 'signal' ? undefined : typeof item === 'bigint' ? String(item) : item)
    if (original === undefined) return { source, unavailable: true }
    const bytes = Buffer.byteLength(original)
    const redacted = JSON.stringify(JSON.parse(original), (key, item) => SECRET.test(key) ? '[redacted]' : typeof item === 'string' ? redactText(item) : item)
    const buffer = Buffer.from(redacted)
    // Round-trip UTF-8 slicing to avoid replacement characters at the boundary.
    let text = buffer.subarray(0, limit).toString('utf8')
    if (buffer.length > limit) text = text.replace(/\uFFFD$/, '')
    const truncated = buffer.length > limit
    return { source, text, ...(!truncated ? { value: JSON.parse(text) } : {}), bytes, retainedBytes: Buffer.byteLength(text), truncated, redacted: true, measurement: 'UTF-8 JSON representation before redaction; not network bytes' }
  } catch { return { source, unavailable: true, reason: 'Diagnostic serialization failed' } }
}
export function errorEvidence(value, stage, observedAt = Date.now(), depth = 0) {
  // One shared budget for the whole cause/AggregateError graph, not per branch.
  const seen = new WeakSet(), budget = { nodes: 64, chars: 65536 }
  function visit(value, level) {
    const marker = reason => ({ stage, observedAt, code: 'evidence-truncated', message: reason, truncated: true, causeTruncated: true })
    if (level > 8 || budget.nodes-- <= 0 || budget.chars <= 0) return marker('Exception tree retention limit reached')
    if (value && (typeof value === 'object' || typeof value === 'function')) {
      if (seen.has(value)) return marker('Repeated or circular exception reference')
      seen.add(value)
    }
    try {
      const read = key => safeGet(value, key)
      let truncated = false
      const text = (value, limit) => {
        const rendered = redactText(value ?? ''), keep = Math.min(limit, budget.chars)
        if (rendered.length > keep) truncated = true
        const result = rendered.slice(0, keep); budget.chars -= result.length
        return result
      }
      const message = read('message') ?? (typeof value === 'string' ? value : 'Unknown failure')
      const result = { stage, observedAt, message: text(message, 12000), code: text(read('code') ?? read('name') ?? 'unknown', 160) }
      // Whitelist only: never serialize sockets, configs, dispatchers or arbitrary fields.
      for (const key of ['name', 'requestId', 'errno', 'syscall', 'type', 'address', 'hostname', 'family']) if (read(key) !== undefined) result[key] = text(read(key), 500)
      for (const key of ['status', 'statusCode', 'providerRetryAfterMs', 'offloadImages', 'port']) if (Number.isFinite(read(key))) result[key] = read(key)
      for (const key of ['status', 'statusCode']) if (typeof read(key) === 'string' && /^\d{3}$/.test(read(key))) result[key] = Number(read(key))
      const children = (input, key) => {
        if (!Array.isArray(input)) return
        const length = Math.min(input.length, 16)
        result[key] = []
        for (let i = 0; i < length && budget.nodes > 0 && budget.chars > 0; i++) result[key].push(visit(safeGet(input, i), level + 1))
        if (result[key].length < input.length) { result.causeTruncated = true; truncated = true }
      }
      const cause = read('cause')
      if (cause) result.causes = [visit(cause, level + 1)]
      else children(read('causes'), 'causes')
      children(read('errors'), 'errors')
      // Candidate failures take priority over stacks and opaque response bodies.
      if (read('stack') !== undefined) result.stack = text(read('stack'), 16000)
      for (const key of ['error', 'body', 'responseBody', 'data']) if (read(key) !== undefined) {
        if (budget.chars <= 0) { truncated = true; break }
        const copy = snapshot(read(key), Math.min(16000, budget.chars), `exception.${key}`)
        result[key] = copy; budget.chars -= copy.retainedBytes ?? 0
        truncated ||= !!copy.truncated
      }
      result.truncated = truncated || !!result.causeTruncated || [...(result.causes ?? []), ...(result.errors ?? [])].some(item => item.truncated)
      return result
    } catch { return { stage, observedAt, code: 'unreadable-error', message: 'Thrown value could not be inspected' } }
  }
  return visit(value, depth)
}
export function appendError(attempt, error, stage, at = Date.now()) {
  attempt.errors ??= []
  attempt.observedErrorCount = (attempt.observedErrorCount ?? attempt.errors.length) + 1
  if (attempt.errors.length < 24) attempt.errors.push(errorEvidence(error, stage, at))
  else attempt.errorsTruncated = true
}
export function recordChunk(attempt, chunk, at) {
  const response = attempt.response
  response.observedChunks++
  const limit = attempt.captureLimits?.responseBytes ?? RESPONSE_LIMIT
  const event = snapshot(chunk, limit, 'normalized StreamChunk')
  if (!event.unavailable) {
    response.observedJsonBytes += event.bytes
    if (!response.truncated && response.events.length < (attempt.captureLimits?.responseEvents ?? 2000) && response.capturedBytes + event.retainedBytes <= limit) {
      response.events.push({ at, type: chunk.type, data: event.value ?? event.text, ...(event.truncated ? { truncated: true } : {}) })
      response.capturedBytes += event.retainedBytes
      if (event.truncated) response.truncated = true
    } else response.truncated = true
  } else {
    response.unavailableChunks = (response.unavailableChunks ?? 0) + 1
    response.truncated = true
  }
  if (chunk.type === 'usage' && chunk.usage) {
    attempt.usage ??= {}
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) if (Number.isFinite(chunk.usage[key])) attempt.usage[key] = chunk.usage[key]
    attempt.usageSource = 'provider-reported via normalized usage event; latest reported values, not summed'
  }
  if (chunk.type === 'finish') {
    response.finish = snapshot(chunk.reason, 16000, 'normalized FinishReason').value
    if (chunk.replayState) response.replayState = snapshot(chunk.replayState, 32768, 'adapter replay state; not raw HTTP')
  }
}

export const ERROR_CATEGORIES = Object.freeze(['timeout', 'network', 'auth', 'rate-limit', 'overload', 'provider', 'upstream-request', 'input', 'context', 'unknown'])
const cancelled = value => /^(aborted|abort|cancelled|canceled|interrupted)$/i.test(String(value ?? ''))
// Only inspect error metadata and actual error messages, never request/prompt text.
export function classifyError(error) {
  const text = [error?.code, error?.name, error?.type, error?.message, typeof error === 'string' ? error : ''].filter(Boolean).join(' ').toLowerCase()
  const status = Number(error?.status ?? error?.statusCode)
  if (/aborterror|aborted|cancelled|canceled|\binterrupted\b|err_canceled|abort_err/.test(text)) return null
  if (status === 429) return 'rate-limit'
  if (status === 401 || status === 403) return 'auth'
  if (status === 408) return 'timeout'
  // Prefer the upstream's explicit overload symptom over a generic 5xx class.
  if (/\boverload(?:ed)?\b|overloaded_error|server[_ -]?overloaded|服务器.{0,8}(过载|繁忙)/.test(text)) return 'overload'
  if (status >= 500 && status <= 599) return 'provider'
  const code = String(error?.code ?? '').toUpperCase()
  if (code === 'AUTH') return 'auth'
  if (code === 'SERVER') return 'provider'
  if (/context[_ -]?(length|window|limit)|maximum context|too many tokens|token limit|prompt.{0,20}too long/.test(text)) return 'context'
  if (/rate[_ -]?limit|too many requests|quota.{0,20}(exceed|exhaust)|resource_exhausted/.test(text)) return 'rate-limit'
  if (/unauth|authentication|invalid.{0,10}(api[_ -]?key|credential)|permission.denied|access.denied/.test(text)) return 'auth'
  if (/time.?out|timed out|etimedout|deadline.exceeded/.test(text)) return 'timeout'
  if (/econn|enotfound|eai_again|enet|epipe|fetch failed|network|socket|\btransport\b|connection[ _-]*(error|failed|failure|reset|refused|closed|lost)|apiconnectionerror/.test(text)) return 'network'
  if (status === 400 || status === 404 || status === 413 || status === 422 || /invalid[_ -]?(request|argument|input)|validation|unsupported/.test(text)) return 'input'
  if (/provider|service.unavailable|internal.server.error|\bserver_error\b|\binternal_error\b|apierror/.test(text)) return 'provider'
  // A reported processing failure is an upstream request symptom, not proof of
  // a service outage, bad input, or network failure. Do not classify from the
  // adapter's generic PI_AI_ERROR code or help/status links alone.
  if (/error (?:occurred )?while processing (?:your |the )?request|error processing (?:your |the )?request|\brequest processing (?:error|failed|failure)\b/.test(text)) return 'upstream-request'
  return 'unknown'
}
export function summarizeErrors(attempt) {
  const evidence = [], seen = new Set(), visited = new WeakSet()
  let remaining = 256
  const add = (value, depth = 0) => {
    if (!value || depth > 9 || evidence.length >= 24 || remaining-- <= 0) return
    if (typeof value === 'object') { if (visited.has(value)) return; visited.add(value) }
    const classified = classifyError(value)
    // Re-evaluate stored summaries so improved classifiers also fix old unknown labels.
    const category = classified === 'unknown' && ERROR_CATEGORIES.includes(value.category) ? value.category : classified
    if (category) {
      const item = { category, message: redactText(typeof value === 'string' ? value : value.message ?? 'Unknown failure').slice(0, 1200) }
      for (const key of ['stage', 'code', 'name', 'type', 'requestId', 'address', 'hostname', 'family', 'syscall']) if (value[key] !== undefined) item[key] = redactText(value[key]).slice(0, 160)
      if (Number.isFinite(value.port)) item.port = value.port
      for (const key of ['status', 'statusCode', 'observedAt']) if (Number.isFinite(Number(value[key]))) item[key] = Number(value[key])
      const signature = JSON.stringify(item)
      if (!seen.has(signature)) { seen.add(signature); evidence.push(item) }
    }
    if (Array.isArray(value.causes)) for (const cause of value.causes.slice(0, 16)) add(cause, depth + 1)
    if (value.cause) add(value.cause, depth + 1)
    if (Array.isArray(value.errors)) for (const error of value.errors.slice(0, 16)) add(error, depth + 1)
    for (const key of ['error', 'body', 'responseBody', 'data']) {
      let nested = value[key]?.value ?? value[key]
      if (typeof nested === 'string') { try { nested = JSON.parse(nested) } catch { if (key === 'error') add(nested, depth + 1); continue } }
      if (nested && typeof nested === 'object') {
        if (nested.error) add(nested.error, depth + 1)
        else if (nested.message || nested.code || nested.status || nested.statusCode) add(nested, depth + 1)
      }
    }
  }
  // Preserve already compact evidence on cache eviction and old-index reads.
  if (cancelled(attempt.status) || attempt.observationInterrupted) for (const item of attempt.errorEvidence ?? []) if (item.stage?.startsWith('http-')) add(item)
  if (!cancelled(attempt.status) && !attempt.observationInterrupted) {
    for (const item of attempt.errorEvidence ?? []) add(item)
    for (const item of attempt.errors ?? []) add(item)
    if (!attempt.errors?.length && !attempt.errorEvidence?.length) add(attempt.failure ?? attempt.error)
  }
  for (const exchange of attempt.http?.exchanges ?? []) {
    const status = Number(exchange.response?.status ?? exchange.response?.statusCode ?? exchange.status ?? exchange.statusCode)
    if (status >= 400) {
      const body = exchange.response?.body
      let detail = body?.value
      if (!detail && body?.available !== false && body?.text) {
        try { detail = JSON.parse(body.text) } catch { if (body.format !== 'json') detail = { message: body.text } }
      }
      const actual = detail?.error ?? detail
      const message = typeof actual === 'string' ? actual : actual?.message
      add({ status, stage: 'http-response', message: message ?? `HTTP ${status}${exchange.response?.statusText ? ` ${exchange.response.statusText}` : ''}`, ...(actual?.code ? { code: actual.code } : {}) })
      if (actual && typeof actual === 'object' && (actual.message || actual.code)) add({ ...actual, stage: 'http-error-body' })
    }
  }
  if (!evidence.length && !attempt.errors?.length && !attempt.errorEvidence?.length && !attempt.failure && !attempt.error && !cancelled(attempt.status) && !attempt.observationInterrupted && (['error', 'failure', 'failed'].includes(attempt.status) || attempt.isError || attempt.errorCount > 0 || attempt.observedErrorCount > 0)) add({ message: 'Error details unavailable', code: 'unknown' })
  return { errorCategories: [...new Set(evidence.map(item => item.category))], errorEvidence: evidence }
}
export function summary(attempt) {
  const { request, response, errors, http, ...rest } = attempt
  const compact = summarizeErrors(attempt)
  const hasAnomaly = compact.errorCategories.length > 0 || (!cancelled(attempt.status) && !attempt.observationInterrupted && Boolean(attempt.hasAnomaly))
  return { ...rest, ...compact, diagnosis: diagnose({ ...attempt, ...compact }), hasAnomaly, hasDetails: !!(request || response || errors || http) || attempt.hasDetails === true, errorCount: attempt.observedErrorCount ?? errors?.length ?? attempt.errorCount ?? 0, ...(http ? { httpCount: http.exchanges?.length ?? 0 } : {}) }
}
