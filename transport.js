import { AsyncLocalStorage } from 'node:async_hooks'
import { channel } from 'node:diagnostics_channel'
import { createHash } from 'node:crypto'
import * as net from 'node:net'
import * as dns from 'node:dns'
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib'
import { snapshot, redactText, safeGet, appendError } from './evidence.js'

const LIMIT = 256 * 1024
const SOURCE = 'undici diagnostics_channel (passive; transport-dependent)'
const secret = /authorization|cookie|api[-_]?key|token|password|secret|credential/i

function urlText(request) {
  const url = new URL(String(request.path ?? ''), String(request.origin))
  if (url.username || url.password) { url.username = '[redacted]'; url.password = '' }
  for (const key of url.searchParams.keys()) if (secret.test(key)) url.searchParams.set(key, '[redacted]')
  return redactText(url.href)
}
function headersCopy(input) {
  const pairs = []
  const add = (name, value) => {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(String(name))) return
    pairs.push([String(name), secret.test(String(name)) ? '[redacted]' : redactText(String(value))])
  }
  if (typeof input === 'string') {
    for (const line of input.split('\r\n')) {
      const colon = line.indexOf(':')
      if (colon > 0) add(line.slice(0, colon), line.slice(colon + 1).trim())
    }
  } else if (Array.isArray(input)) {
    for (let i = 0; i + 1 < input.length; i += 2) add(input[i], input[i + 1])
  } else if (input) for (const [key, value] of Object.entries(input)) add(key, value)
  return snapshot(pairs, LIMIT, 'HTTP header fields; redacted').value ?? []
}
function headerSize(input, retained) {
  const represent = value => Array.isArray(value) ? value.map(item => Array.isArray(item) ? `${item[0]}: ${item[1]}\r\n` : String(item)).join('') : typeof value === 'string' ? value : Object.entries(value ?? {}).map(([key, value]) => `${key}: ${value}\r\n`).join('')
  // Flat diagnostic arrays are alternating name/value fields, without wire framing.
  const original = Array.isArray(input) ? Array.from({ length: Math.floor(input.length / 2) }, (_, i) => `${input[i * 2]}: ${input[i * 2 + 1]}\r\n`).join('') : represent(input)
  return { observedRepresentationBytes: Buffer.byteLength(original), retainedRepresentationBytes: Buffer.byteLength(represent(retained)), measurement: typeof input === 'string' ? 'UTF-8 bytes of original diagnostic string (may include request line); retained redacted header-field representation estimate, not wire bytes' : 'UTF-8 name: value CRLF representation estimate; excludes framing/compression, not wire bytes' }
}
function bodyState(limit = LIMIT) { return { hash: createHash('sha256'), limit, buffers: [], retained: 0, bytes: 0, seen: false, truncated: false } }
function addBody(body, chunk) {
  const bytes = Buffer.from(chunk)
  body.seen = true
  body.bytes += bytes.length
  body.hash.update(bytes)
  const keep = Math.min(bytes.length, body.limit - body.retained)
  if (keep > 0) { body.buffers.push(Buffer.from(bytes.subarray(0, keep))); body.retained += keep }
  if (keep < bytes.length) body.truncated = true
}
function bodyCopy(body, complete, contentType = '', contentEncoding = '') {
  const LIMIT = body.limit
  if (!body.seen) return { available: false, complete, reasonCode: 'body-not-observed', representation: 'http-entity-before-content-decoding', reason: 'No body chunk events observed; byte count unknown (not zero)' }
  const base = { ...bodyMeasurement(body, complete), contentEncoding, measurement: 'Observed HTTP entity body bytes before content decoding; excludes TLS/framing/header bytes' }
  let decoded = Buffer.concat(body.buffers)
  const unavailable = (reason, reasonCode) => ({ ...base, available: false, reason, reasonCode })
  if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
    if (!complete || body.truncated) return unavailable('Compressed body incomplete or capture truncated; decoded text unavailable', body.truncated ? 'capture-truncated' : 'observation-incomplete')
    try {
      for (const encoding of contentEncoding.toLowerCase().split(',').map(value => value.trim()).reverse()) {
        const decode = { gzip: gunzipSync, 'x-gzip': gunzipSync, deflate: inflateSync, br: brotliDecompressSync }[encoding]
        if (!decode) return unavailable('Unsupported content encoding; decoded text unavailable', 'unsupported-content-encoding')
        decoded = decode(decoded, { maxOutputLength: LIMIT })
      }
    } catch { return unavailable('Content decoding failed or decoded body exceeds retention limit', 'content-decoding-failed-or-limit') }
  }
  base.decodedBytes = decoded.length
  base.decodedBytesMeasurement = body.truncated ? 'Retained prefix after decoding; total decoded length unknown' : 'Decoded observed entity length'
  if (contentType && !/(^text\/|json|javascript|xml|x-www-form-urlencoded)/i.test(contentType)) return unavailable('Binary or unsupported media type; text withheld', 'unsupported-media-type')
  const raw = decoded.toString('utf8')
  if (raw.includes('\u0000') || raw.includes('\uFFFD')) return unavailable('Binary or non-UTF-8 body; text withheld', 'non-utf8-body')
  let text
  let format = 'text'
  let redactionTruncated = false
  let textPartial = false
  if (/event-stream/i.test(contentType) || /^data:/m.test(raw)) {
    format = 'sse'
    // A partial SSE line may contain a split credential; never export that line.
    const lines = raw.split(/\r?\n/)
    if (!complete || body.truncated) { lines.pop(); textPartial = true }
    text = lines.map(line => {
      if (!line.startsWith('data:')) return /^(event|id|retry):/.test(line) ? redactText(line) : ''
      const data = line.slice(5).trim()
      if (data === '[DONE]') return 'data: [DONE]'
      try {
        const copy = snapshot(JSON.parse(data), LIMIT, 'HTTP SSE data')
        redactionTruncated ||= !!copy.truncated || !!copy.unavailable
        return `data: ${copy.text ?? '[unavailable]'}`
      }
      catch { textPartial = true; return 'data: [unavailable: non-JSON or partial event]' }
    }).join('\n')
  } else {
    try {
      const copy = snapshot(JSON.parse(raw), LIMIT, 'HTTP JSON body')
      text = copy.text
      redactionTruncated ||= !!copy.truncated || !!copy.unavailable
      format = 'json'
    }
    catch {
      if (/json/i.test(contentType) || /^\s*[\[{]/.test(raw) || !complete || body.truncated) return unavailable('Incomplete or non-parseable structured body; text withheld', body.truncated ? 'capture-truncated' : !complete ? 'observation-incomplete' : 'invalid-structured-body')
      else text = redactText(raw)
    }
  }
  let buffer = Buffer.from(text ?? '')
  const truncated = body.truncated || redactionTruncated || buffer.length > LIMIT
  if (buffer.length > LIMIT) buffer = buffer.subarray(0, LIMIT)
  text = buffer.toString('utf8').replace(/\uFFFD$/, '')
  return { ...base, reasonCode: truncated ? 'capture-truncated' : textPartial ? 'partial-text' : !complete ? 'observation-incomplete' : 'complete', available: true, text, format, retainedBytes: Buffer.byteLength(text), truncated, textComplete: complete && !truncated && !textPartial, textPartial, redacted: true }
}

function bodyMeasurement(body, complete) {
  return { bytes: body.bytes, observedBytes: body.bytes, capturedBytes: body.retained, complete,
    truncated: body.truncated, representation: 'http-entity-before-content-decoding',
    reasonCode: body.truncated ? 'capture-truncated' : complete ? 'complete' : 'observation-incomplete',
    sha256: body.hash.copy().digest('hex'), hashAlgorithm: 'sha256', hashBytes: body.bytes,
    hashCoverage: complete ? 'all-observed-entity-bytes; completion-event-observed' : 'observed-entity-prefix; completion-not-observed' }
}
function runtimeFacts() {
  const read = fn => { try { return typeof fn === 'function' ? fn() : null } catch { return null } }
  return { nodeVersion: process.version, undiciVersion: process.versions.undici ?? null,
    autoSelectFamily: read(net.getDefaultAutoSelectFamily),
    autoSelectFamilyAttemptTimeoutMs: read(net.getDefaultAutoSelectFamilyAttemptTimeout),
    dnsResultOrder: read(dns.getDefaultResultOrder),
    source: 'Host process getters at trace wrap time; null means unavailable; not per-request overrides or proxy routing' }
}
function socketFacts(socket) {
  const result = {}
  for (const key of ['remoteAddress', 'remoteFamily', 'remotePort', 'localAddress', 'localPort', 'alpnProtocol', 'authorized']) {
    const value = safeGet(socket, key)
    if (typeof value === 'string') result[key] = redactText(value).slice(0, 256)
    else if (typeof value === 'number' || typeof value === 'boolean') result[key] = value
  }
  try { const protocol = socket?.getProtocol?.(); if (typeof protocol === 'string') result.tlsProtocol = protocol.slice(0, 64) } catch {}
  return result
}

export function createTransport({ changed = () => {}, now = Date.now } = {}) {
  const scope = new AsyncLocalStorage()
  const requests = new WeakMap()
  const active = new Set()
  const subscriptions = []
  let disposed = false
  function notify() { if (!disposed) try { changed() } catch {} }
  function fail(attempt, error, stage = 'http-observer') { try { appendError(attempt, error, stage, now()) } catch {} }
  function finishBody(record, side, complete) {
    if (record[side].finished) return
    const target = record.exchange[side]
    record[side].finished = true
    const type = target.headers?.find(pair => pair[0].toLowerCase() === 'content-type')?.[1]
    const encoding = target.headers?.find(pair => pair[0].toLowerCase() === 'content-encoding')?.[1]
    target.body = bodyCopy(record[side], complete, type, encoding)
  }
  function listen(name, handler) {
    const event = channel(`undici:${name}`)
    const callback = payload => {
      if (disposed) return
      const request = safeGet(payload, 'request')
      const record = request && requests.get(request)
      const context = record?.context ?? scope.getStore()
      if (!context || context.closed) return
      try { handler(payload, context, record); notify() }
      catch (error) { fail(context.attempt, error) }
    }
    event.subscribe(callback)
    subscriptions.push(() => event.unsubscribe(callback))
  }
  for (const event of ['beforeConnect', 'connected', 'connectError']) listen(`client:${event}`, (payload, context) => {
    const http = context.attempt.http
    http.coverage[event] = true
    if (event === 'connectError') fail(context.attempt, safeGet(payload, 'error'), 'http-connect')
    if (http.connections.length >= 32) { http.coverage.connectionsTruncated = true; return }
    const observation = { id: http.connections.length + 1, event, observedAt: now(),
      association: 'async-context-only', associationStrength: 'weak',
      note: 'Connection event observed in attempt ALS context; pooled/concurrent connections may serve other requests; no exchange binding or DNS/TCP/TLS phase duration inferred' }
    // Only explicitly allowed endpoint fields; never retain connectParams, connector, socket or credentials.
    const params = safeGet(payload, 'connectParams')
    observation.endpoint = {}
    for (const key of ['hostname', 'port', 'protocol']) {
      const value = safeGet(params, key)
      if (typeof value === 'string' || typeof value === 'number') observation.endpoint[key] = redactText(String(value)).slice(0, 256)
    }
    if (event === 'connected') observation.socket = socketFacts(safeGet(payload, 'socket'))
    http.connections.push(observation)
  })
  listen('request:create', ({ request }, context) => {
    if (requests.has(request)) return
    const http = context.attempt.http
    http.coverage.requestCreate = true
    if (http.exchanges.length >= 8) { http.coverage.exchangesTruncated = true; return }
    const exchange = { id: http.exchanges.length + 1, createdAt: now(), request: { url: urlText(request), method: String(request.method), headers: headersCopy(request.headers), body: { available: false, reason: 'Awaiting body chunk events' } }, response: { body: { available: false, reason: 'Awaiting response body chunk events' } } }
    exchange.request.headerBytes = headerSize(request.headers, exchange.request.headers)
    http.exchanges.push(exchange)
    const record = { context, exchange, request: bodyState(context.attempt.captureLimits?.httpBodyBytes), response: bodyState(context.attempt.captureLimits?.httpBodyBytes) }
    requests.set(request, record)
    context.records.add(record)
  })
  listen('client:sendHeaders', (payload, context, record) => {
    if (!record) return
    record.exchange.sentAt = now()
    record.exchange.request.headers = headersCopy(payload.headers)
    record.exchange.request.headerBytes = headerSize(payload.headers, record.exchange.request.headers)
    record.exchange.request.headerMeasurement = 'Header fields from HTTP/1-style diagnostic representation; not exact wire bytes (HTTP/2 differs)'
    context.attempt.http.coverage.sentHeaders = true
  })
  for (const [event, side] of [['bodyChunkSent', 'request'], ['bodyChunkReceived', 'response']]) listen(`request:${event}`, (payload, context, record) => {
    if (!record) return
    addBody(record[side], payload.chunk)
    context.attempt.http.coverage[side === 'request' ? 'requestBodyChunks' : 'responseBodyChunks'] = true
    record.exchange[side].body = { ...bodyMeasurement(record[side], false), available: false, reasonCode: 'awaiting-redaction', reason: 'Body buffered privately until completion/redaction' }
    record.exchange[side].firstBodyAt ??= now()
  })
  listen('request:bodySent', (_payload, context, record) => {
    if (!record) return
    context.attempt.http.coverage.bodySent = true
    record.exchange.request.bodySentAt = now()
    finishBody(record, 'request', true)
  })
  listen('request:headers', ({ response }, context, record) => {
    if (!record) return
    context.attempt.http.coverage.responseHeaders = true
    Object.assign(record.exchange.response, { headersAt: now(), status: response.statusCode, statusText: redactText(response.statusText ?? ''), headers: headersCopy(response.headers) })
    record.exchange.response.headerBytes = headerSize(response.headers, record.exchange.response.headers)
    const length = record.exchange.response.headers.find(([name]) => name.toLowerCase() === 'content-length')
    if (length) record.exchange.response.declaredContentLength = length[1]
    const id = record.exchange.response.headers.find(([name]) => /^(x-request-id|request-id|anthropic-request-id)$/i.test(name))
    if (id) record.exchange.response.requestId = id[1]
  })
  listen('request:trailers', ({ trailers }, _context, record) => {
    if (!record) return
    record.exchange.response.trailers = headersCopy(trailers)
    record.exchange.completedAt = now()
    finishBody(record, 'response', true)
    record.request.buffers = []; record.response.buffers = []
  })
  listen('request:error', ({ error }, context, record) => {
    if (!record) return
    record.exchange.failedAt = now()
    fail(context.attempt, error, 'http-transport')
    finishBody(record, 'request', false)
    finishBody(record, 'response', false)
    record.request.buffers = []; record.response.buffers = []
  })
  function close(context) {
    if (context.closed) return
    context.closed = true
    for (const record of context.records) {
      try {
        finishBody(record, 'request', false)
        finishBody(record, 'response', false)
      } catch (error) { fail(context.attempt, error) }
      finally { record.request.buffers = []; record.response.buffers = [] }
    }
    context.records.clear()
    active.delete(context)
    context.attempt.http.coverage.observationEndedAt = now()
    notify()
  }
  function wrap(attempt, next) {
    if (disposed) return next()
    const context = { attempt, closed: false, records: new Set() }
    attempt.http = { source: SOURCE, runtime: runtimeFacts(), connections: [], exchanges: [], coverage: { beforeConnect: false, connected: false, connectError: false, requestCreate: false, sentHeaders: false, requestBodyChunks: false, responseBodyChunks: false, bodySent: false, responseHeaders: false, note: 'False means not observed, not unsupported or zero; only undici transports in this process are visible' } }
    let iterator
    let started = false
    async function operate(method, value) {
      if (disposed) context.closed = true
      if (!started) { started = true; if (!disposed) active.add(context) }
      try {
        const result = await scope.run(context, () => {
          iterator ??= next()[Symbol.asyncIterator]()
          if (!iterator[method]) {
            if (method === 'throw') throw value
            return { done: true, value }
          }
          return iterator[method](value)
        })
        if (result.done) close(context)
        return result
      } catch (error) { close(context); throw error }
    }
    return { [Symbol.asyncIterator]() { return this }, next(value) { return operate('next', value) }, return(value) { return operate('return', value) }, throw(error) { return operate('throw', error) } }
  }
  function dispose() {
    if (disposed) return
    disposed = true
    for (const unsubscribe of subscriptions) unsubscribe()
    for (const context of active) {
      context.closed = true
      context.attempt.http.coverage.disposedAt = now()
      for (const record of context.records) { record.request.buffers = []; record.response.buffers = [] }
      context.records.clear()
    }
    active.clear()
    scope.disable()
  }
  return { wrap, dispose }
}
