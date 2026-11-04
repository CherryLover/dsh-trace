import test from 'node:test'
import assert from 'node:assert/strict'
import { channel } from 'node:diagnostics_channel'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { createTransport } from '../transport.js'
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import * as net from 'node:net'
import * as dns from 'node:dns'

const emit = (name, payload) => channel(`undici:request:${name}`).publish(payload)
const requestOf = () => ({ origin: 'https://example.test', path: '/messages?token=url-secret', method: 'POST', headers: ['authorization', 'Bearer header-secret', 'content-type', 'application/json'] })
async function drain(iterator) { for await (const _chunk of iterator) {} }

function requestEvents(request, text = '{"token":"body-secret","ok":true}') {
  emit('create', { request })
  emit('bodyChunkSent', { request, chunk: Buffer.from(text) })
  emit('bodySent', { request })
  emit('headers', { request, response: { statusCode: 200, statusText: 'OK', headers: ['content-type', 'text/event-stream', 'set-cookie', 'cookie-secret', 'x-request-id', 'req-1'] } })
  emit('bodyChunkReceived', { request, chunk: Buffer.from('data: {"secret":"response-secret","text":"hi"}\n\n') })
  emit('trailers', { request, trailers: [] })
}

test('captures redacted actual HTTP evidence without changing yielded objects', async () => {
  const transport = createTransport()
  const attempt = {}
  const chunk = { type: 'text', text: 'hi' }
  try {
    const iterator = transport.wrap(attempt, async function* () { requestEvents(requestOf()); yield chunk })
    assert.strictEqual((await iterator.next()).value, chunk)
    await iterator.next()
    const exchange = attempt.http.exchanges[0]
    assert.equal(exchange.request.body.bytes, Buffer.byteLength('{"token":"body-secret","ok":true}'))
    assert.equal(exchange.response.status, 200)
    assert.equal(exchange.response.requestId, 'req-1')
    assert.match(exchange.response.body.text, /hi/)
    for (const value of ['url-secret', 'header-secret', 'body-secret', 'cookie-secret', 'response-secret']) assert.ok(!JSON.stringify(attempt).includes(value), value)
    assert.equal(attempt.http.coverage.responseBodyChunks, true)
  } finally { transport.dispose() }
})

test('scopes every lazy generator operation, including return, and isolates concurrent attempts', async () => {
  const transport = createTransport()
  const a = {}, b = {}
  try {
    const make = (attempt, suffix) => transport.wrap(attempt, async function* () {
      try { await Promise.resolve(); requestEvents({ ...requestOf(), path: `/${suffix}` }); yield suffix }
      finally { requestEvents({ ...requestOf(), path: `/${suffix}-cleanup` }) }
    })
    const left = make(a, 'a'), right = make(b, 'b')
    await Promise.all([left.next(), right.next()])
    await Promise.all([left.return(), right.return()])
    assert.deepEqual(a.http.exchanges.map(item => new URL(item.request.url).pathname), ['/a', '/a-cleanup'])
    assert.deepEqual(b.http.exchanges.map(item => new URL(item.request.url).pathname), ['/b', '/b-cleanup'])
  } finally { transport.dispose() }
})

test('preserves original thrown error and header evidence after transport failure', async () => {
  const transport = createTransport()
  const attempt = {}, failure = new Error('aborted original')
  try {
    await assert.rejects(drain(transport.wrap(attempt, async function* () {
      const request = requestOf()
      emit('create', { request })
      emit('headers', { request, response: { statusCode: 429, headers: ['request-id', 'retained-id'] } })
      emit('error', { request, error: failure })
      throw failure
    })), error => error === failure)
    assert.equal(attempt.http.exchanges[0].response.status, 429)
    assert.equal(attempt.http.exchanges[0].response.requestId, 'retained-id')
    assert.equal(attempt.errors[0].stage, 'http-transport')
    assert.equal(attempt.http.exchanges[0].request.body.bytes, undefined)
  } finally { transport.dispose() }
})

test('caps exchanges and body retention; withholds truncated structured secrets', async () => {
  const transport = createTransport()
  const attempt = {}
  try {
    await drain(transport.wrap(attempt, async function* () {
      for (let i = 0; i < 10; i++) requestEvents(requestOf(), JSON.stringify({ token: 'x'.repeat(300000), ok: true }))
    }))
    assert.equal(attempt.http.exchanges.length, 8)
    assert.equal(attempt.http.coverage.exchangesTruncated, true)
    const body = attempt.http.exchanges[0].request.body
    assert.equal(body.truncated, true)
    assert.equal(body.capturedBytes, 256 * 1024)
    assert.ok(body.bytes > body.capturedBytes)
    assert.equal(body.available, false)
    assert.equal(body.text, undefined)
    assert.match(body.reason, /text withheld/)
  } finally { transport.dispose() }
})

test('never exposes temporary split body secret and stops callbacks on dispose', async () => {
  let changes = 0
  const transport = createTransport({ changed: () => changes++ })
  const attempt = {}
  let request
  const iterator = transport.wrap(attempt, async function* () {
    request = requestOf()
    emit('create', { request })
    emit('bodyChunkSent', { request, chunk: Buffer.from('{"token":"split-') })
    yield 1
    emit('bodyChunkSent', { request, chunk: Buffer.from('secret"}') })
    emit('bodySent', { request })
    yield 2
  })
  await iterator.next()
  assert.ok(!JSON.stringify(attempt).includes('split-'))
  transport.dispose()
  const before = JSON.stringify(attempt), count = changes
  await iterator.next()
  await iterator.return()
  assert.equal(JSON.stringify(attempt), before)
  assert.equal(changes, count)
  transport.dispose()
})

async function localFetchTest(t, fetchOptions = {}, fetchImpl = fetch) {
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'local-id', 'set-cookie': 'local-cookie-secret' })
      response.end('data: {"token":"local-response-secret","text":"ok"}\n\n')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const transport = createTransport()
  const attempt = {}
  try {
    await drain(transport.wrap(attempt, async function* () {
      const response = await fetchImpl(`http://127.0.0.1:${server.address().port}/messages`, { ...fetchOptions, method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer local-header-secret' }, body: '{"token":"local-body-secret","model":"test"}' })
      yield await response.text()
    }))
    assert.equal(attempt.http.exchanges.length, 1)
    assert.equal(attempt.http.exchanges[0].response.status, 200)
    assert.equal(attempt.http.exchanges[0].response.requestId, 'local-id')
    assert.ok(!JSON.stringify(attempt).includes('local-header-secret'))
    assert.ok(!JSON.stringify(attempt).includes('local-cookie-secret'))
    if (fetchOptions.dispatcher) {
      assert.equal(attempt.http.coverage.requestBodyChunks, true)
      assert.equal(attempt.http.coverage.responseBodyChunks, true)
      assert.ok(attempt.http.exchanges[0].response.body.bytes > 0)
      assert.ok(!JSON.stringify(attempt).includes('local-response-secret'))
    }
    t.diagnostic(`runtime=${process.version} builtin-undici=${process.versions.undici ?? 'unknown'} coverage=${JSON.stringify(attempt.http.coverage)}`)
  } finally {
    transport.dispose()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
test('built-in fetch local HTTP observation reports actual channel coverage', localFetchTest)
test('measures diagnostic header representations, excluding invalid request-line fields', async () => {
  const transport = createTransport(), attempt = {}
  const request = requestOf()
  const raw = 'POST https://example.test/messages HTTP/1.1\r\nauthorization: Bearer header-secret\r\ncontent-type: application/json\r\n'
  try {
    await drain(transport.wrap(attempt, async function* () {
      emit('create', { request })
      channel('undici:client:sendHeaders').publish({ request, headers: raw })
      emit('headers', { request, response: { statusCode: 200, headers: ['content-length', '123', 'x-request-id', 'id'] } })
    }))
    const exchange = attempt.http.exchanges[0]
    assert.equal(exchange.request.headerBytes.observedRepresentationBytes, Buffer.byteLength(raw))
    assert.ok(exchange.request.headerBytes.retainedRepresentationBytes > 0)
    assert.ok(!exchange.request.headers.some(([name]) => name.includes('POST')))
    assert.equal(exchange.response.declaredContentLength, '123')
    assert.ok(exchange.response.headerBytes.observedRepresentationBytes > 0)
    assert.equal(exchange.response.body.bytes, undefined)
  } finally { transport.dispose() }
})

test('decodes bounded gzip/br/deflate bodies and withholds binary or oversized decompression', async () => {
  const transport = createTransport(), attempt = {}
  const plain = Buffer.from('{"token":"compressed-secret","text":"decoded"}')
  try {
    await drain(transport.wrap(attempt, async function* () {
      for (const [encoding, compress] of [['gzip', gzipSync], ['br', brotliCompressSync], ['deflate', deflateSync]]) {
        const request = requestOf(), body = compress(plain)
        emit('create', { request })
        emit('headers', { request, response: { statusCode: 200, headers: ['content-type', 'application/json', 'content-encoding', encoding] } })
        emit('bodyChunkReceived', { request, chunk: body })
        emit('trailers', { request, trailers: [] })
      }
      for (const [type, encoding, bytes] of [['application/octet-stream', '', Buffer.from([0, 255])], ['application/json', 'gzip', gzipSync(Buffer.from('x'.repeat(300000)))]]) {
        const request = requestOf()
        emit('create', { request })
        emit('headers', { request, response: { statusCode: 200, headers: ['content-type', type, 'content-encoding', encoding] } })
        emit('bodyChunkReceived', { request, chunk: bytes })
        emit('trailers', { request, trailers: [] })
      }
    }))
    for (const exchange of attempt.http.exchanges.slice(0, 3)) {
      assert.equal(exchange.response.body.decodedBytes, plain.length)
      assert.match(exchange.response.body.text, /decoded/)
      assert.ok(!exchange.response.body.text.includes('compressed-secret'))
    }
    for (const exchange of attempt.http.exchanges.slice(3)) {
      assert.equal(exchange.response.body.available, false)
      assert.ok(exchange.response.body.bytes > 0)
      assert.equal(exchange.response.body.text, undefined)
    }
  } finally { transport.dispose() }
})

test('marks redaction expansion truncated and scopes thrown iterator errors', async () => {
  const transport = createTransport(), attempt = {}
  const secretObject = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`k${i}`, { token: '' }]))
  const payload = JSON.stringify(secretObject)
  assert.ok(Buffer.byteLength(payload) < 256 * 1024)
  const original = new Error('original throw')
  try {
    const iterator = transport.wrap(attempt, async function* () {
      try { requestEvents(requestOf(), payload); yield 1 }
      finally { requestEvents({ ...requestOf(), path: '/throw-cleanup' }) }
    })
    await iterator.next()
    await assert.rejects(iterator.throw(original), error => error === original)
    const body = attempt.http.exchanges[0].request.body
    assert.equal(body.truncated, true)
    assert.equal(body.textComplete, false)
    assert.ok(body.retainedBytes <= 256 * 1024)
    assert.equal(attempt.http.exchanges.length, 2)
  } finally { transport.dispose() }
})

test('invalid JSON is unavailable and malformed SSE explicitly partial', async () => {
  const transport = createTransport(), attempt = {}
  try {
    await drain(transport.wrap(attempt, async function* () {
      for (const [type, text] of [['application/json', '{"token":"unterminated'], ['text/event-stream', 'data: {bad event}\n\ndata: {"text":"valid"}\n\n']]) {
        const request = requestOf()
        emit('create', { request })
        emit('headers', { request, response: { statusCode: 200, headers: ['content-type', type] } })
        emit('bodyChunkReceived', { request, chunk: Buffer.from(text) })
        emit('trailers', { request, trailers: [] })
      }
    }))
    const [json, sse] = attempt.http.exchanges.map(exchange => exchange.response.body)
    assert.equal(json.available, false)
    assert.equal(json.text, undefined)
    assert.ok(json.bytes > 0)
    assert.equal(sse.textPartial, true)
    assert.equal(sse.textComplete, false)
    assert.match(sse.text, /valid/)
  } finally { transport.dispose() }
})

test('installed runtime undici dispatcher provides passive body chunks', async t => {
  let Agent, fetchImpl
  try {
    const require = createRequire('/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/package.json')
    ;({ Agent, fetch: fetchImpl } = require('undici'))
  } catch { t.skip('Installed Harness undici dependency unavailable'); return }
  const dispatcher = new Agent()
  try { await localFetchTest(t, { dispatcher }, fetchImpl) } finally { await dispatcher.close() }
})

const connectEvent = (event, payload = {}) => channel(`undici:client:${event}`).publish(payload)

test('connection observations are bounded weak ALS facts, never exchange bindings or sockets', async () => {
  const transport = createTransport(), attempt = {}, original = new Error('connect failed')
  const params = { hostname: 'example.test', port: 443, protocol: 'https:', password: 'private-connect-secret', host: 'user:private-host-secret@example.test' }
  const socket = { remoteAddress: '127.0.0.1', remoteFamily: 'IPv4', remotePort: 443, localAddress: '127.0.0.2', localPort: 1234, alpnProtocol: 'h2', authorized: false,
    getProtocol() { return 'TLSv1.3' }, privateKey: 'private-socket-secret', authorizationError: 'private-error-secret' }
  try {
    connectEvent('connected', { socket }) // no active context: never guess ownership
    await drain(transport.wrap(attempt, async function* () {
      connectEvent('beforeConnect', { connectParams: params })
      connectEvent('connected', { connectParams: params, socket })
      connectEvent('connectError', { connectParams: params, error: original })
      for (let i = 0; i < 40; i++) connectEvent('beforeConnect', { connectParams: params })
    }))
    assert.equal(attempt.http.connections.length, 32)
    assert.equal(attempt.http.coverage.connectionsTruncated, true)
    for (const key of ['beforeConnect', 'connected', 'connectError']) assert.equal(attempt.http.coverage[key], true)
    assert.equal(attempt.http.exchanges.length, 0)
    for (const item of attempt.http.connections) {
      assert.equal(item.associationStrength, 'weak')
      assert.equal(item.association, 'async-context-only')
      assert.equal(item.exchangeId, undefined)
      assert.equal(item.durationMs, undefined)
      assert.ok(Number.isFinite(item.observedAt))
    }
    assert.deepEqual(attempt.http.connections[1].socket, { remoteAddress: '127.0.0.1', remoteFamily: 'IPv4', remotePort: 443, localAddress: '127.0.0.2', localPort: 1234, alpnProtocol: 'h2', authorized: false, tlsProtocol: 'TLSv1.3' })
    assert.equal(attempt.errors[0].stage, 'http-connect')
    assert.ok(!JSON.stringify(attempt).includes('private-'))
    assert.equal(attempt.http.runtime.nodeVersion, process.version)
    assert.equal(attempt.http.runtime.undiciVersion, process.versions.undici ?? null)
    assert.equal(attempt.http.runtime.autoSelectFamily, net.getDefaultAutoSelectFamily())
    assert.equal(attempt.http.runtime.autoSelectFamilyAttemptTimeoutMs, net.getDefaultAutoSelectFamilyAttemptTimeout())
    assert.equal(attempt.http.runtime.dnsResultOrder, dns.getDefaultResultOrder())
    assert.equal(attempt.http.runtime.proxy, undefined)
  } finally { transport.dispose() }
})

test('concurrent pool observations stay weak and isolated, preserving pull and exception identity', async () => {
  const transport = createTransport(), a = {}, b = {}, failure = new Error('original'), chunk = {}
  let pulls = 0
  try {
    const make = (attempt, hostname) => transport.wrap(attempt, async function* () {
      pulls++
      await Promise.resolve()
      connectEvent('beforeConnect', { connectParams: { hostname } })
      yield chunk
      connectEvent('connectError', { error: failure })
      throw failure
    })
    const left = make(a, 'a.test'), right = make(b, 'b.test')
    assert.equal(pulls, 0)
    const values = await Promise.all([left.next(), right.next()])
    assert.equal(pulls, 2)
    assert.ok(values.every(value => value.value === chunk))
    assert.deepEqual(a.http.connections.map(item => item.endpoint.hostname), ['a.test'])
    assert.deepEqual(b.http.connections.map(item => item.endpoint.hostname), ['b.test'])
    await Promise.all([assert.rejects(left.next(), error => error === failure), assert.rejects(right.next(), error => error === failure)])
    assert.equal(a.http.connections.length, 2)
    assert.equal(b.http.connections.length, 2)
    const before = JSON.stringify(a)
    connectEvent('connected', { socket: { remotePort: 9999 } })
    assert.equal(JSON.stringify(a), before)
  } finally { transport.dispose() }
})

test('incremental SHA256 covers all observed bytes beyond retention without consuming hash state', async () => {
  const transport = createTransport(), attempt = { captureLimits: { httpBodyBytes: 16 } }, request = requestOf()
  const first = Buffer.from('{"token":"sensitive-'), second = Buffer.from('secret-that-exceeds-limit"}')
  const sha = bytes => createHash('sha256').update(bytes).digest('hex')
  try {
    const iterator = transport.wrap(attempt, async function* () {
      emit('create', { request })
      emit('bodyChunkSent', { request, chunk: first })
      yield 1
      emit('bodyChunkSent', { request, chunk: second })
      emit('bodySent', { request })
    })
    await iterator.next()
    const progress = attempt.http.exchanges[0].request.body
    assert.equal(progress.sha256, sha(first))
    assert.equal(progress.reasonCode, 'awaiting-redaction')
    assert.equal(progress.text, undefined)
    await iterator.next()
    const body = attempt.http.exchanges[0].request.body
    assert.equal(body.sha256, sha(Buffer.concat([first, second])))
    assert.equal(body.hashBytes, first.length + second.length)
    assert.equal(body.observedBytes, body.hashBytes)
    assert.equal(body.capturedBytes, 16)
    assert.equal(body.complete, true)
    assert.equal(body.truncated, true)
    assert.equal(body.reasonCode, 'capture-truncated')
    assert.equal(body.representation, 'http-entity-before-content-decoding')
    assert.equal(body.text, undefined)
    assert.ok(!JSON.stringify(attempt).includes('sensitive-'))
    const absent = attempt.http.exchanges[0].response.body
    assert.equal(absent.reasonCode, 'body-not-observed')
    assert.equal(absent.bytes, undefined)
    assert.equal(absent.sha256, undefined)
  } finally { transport.dispose() }
})

test('incomplete bodies retain prefix hash and machine readable completeness reason', async () => {
  const transport = createTransport(), attempt = {}, request = requestOf()
  try {
    await drain(transport.wrap(attempt, async function* () {
      emit('create', { request })
      emit('bodyChunkReceived', { request, chunk: Buffer.from('{"token":"private') })
    }))
    const body = attempt.http.exchanges[0].response.body
    assert.equal(body.complete, false)
    assert.equal(body.reasonCode, 'observation-incomplete')
    assert.match(body.hashCoverage, /completion-not-observed/)
    assert.equal(body.text, undefined)
  } finally { transport.dispose() }
})
