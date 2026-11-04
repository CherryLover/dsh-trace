import test from 'node:test'
import assert from 'node:assert/strict'
import { diagnose } from '../diagnosis.js'
import { errorEvidence, summarizeErrors, summary } from '../evidence.js'

const codes = d => [...d.findings, ...d.gaps].map(x => x.code)
test('AggregateError candidates retain address/port across nested SDK causes and classification', () => {
  const candidate = Object.assign(new Error('connect ETIMEDOUT 192.0.2.1:443'), { code:'ETIMEDOUT', syscall:'connect', address:'192.0.2.1', port:443, family:4 })
  const error = new Error('Connection error.', { cause: new TypeError('fetch failed', { cause: new AggregateError([candidate], '') }) })
  const retained = errorEvidence(error, 'http-transport', 12)
  const leaf = retained.causes[0].causes[0].errors[0]
  assert.equal(leaf.address,'192.0.2.1'); assert.equal(leaf.port,443); assert.equal(leaf.family,'4')
  const a = {status:'error',errors:[retained]}
  assert.ok(summarizeErrors(a).errorCategories.includes('timeout'))
  assert.ok(codes(diagnose(a)).includes('connect-candidates-failed'))
  assert.ok(summarizeErrors(a).errorEvidence.some(e => e.address === '192.0.2.1'))
})
test('exception graphs are bounded, cyclic and hostile aggregates are contained', () => {
  const cyclic = new Error('outer token=hidden-value'); cyclic.cause = cyclic
  cyclic.errors = Array.from({length:1000},() => Object.assign(new Error('candidate'), {code:'ECONNREFUSED', address:'192.0.2.2'}))
  const retained = errorEvidence(cyclic,'stream')
  assert.equal(retained.truncated,true); assert.ok(retained.errors.length <= 16)
  assert.ok(!JSON.stringify(retained).includes('hidden-value'))
  assert.ok(JSON.stringify(retained).length < 160000)
  assert.doesNotThrow(() => errorEvidence({get errors(){throw new Error('hostile')}}, 'stream'))
  const budget = errorEvidence(new AggregateError(Array.from({length:16}, () => new Error('a'.repeat(20000))), 'outer'),'stream')
  assert.equal(budget.truncated,true); assert.ok(JSON.stringify(budget).length < 160000)
})
test('diagnosis reports HTTP 200 plus later failure, truncation, and evidence refs without roots', () => {
  const a = {status:'error',outputChunks:2,errors:[{message:'terminated'}],http:{exchanges:[{response:{status:200,body:{available:true,truncated:true,textComplete:false}},request:{body:{available:false,reason:'Incomplete structured body'}}}],coverage:{requestCreate:true}}}
  const d = diagnose(a)
  assert.equal(d.stage.code,'normalized-output')
  for (const code of ['http-200-stream-error','stream-failed','body-truncated','body-unavailable','connection-not-observed']) assert.ok(codes(d).includes(code), code)
  assert.ok(d.findings.every(x => Array.isArray(x.evidenceRefs)))
  assert.ok(!JSON.stringify(d).includes('IPv6'))
})
test('empty HTTP observations differ from zero byte bodies and no guessed DNS timings', () => {
  const d = diagnose({status:'error',http:{coverage:{requestCreate:true},exchanges:[{request:{},response:{}}]}})
  assert.equal(d.stage.code,'http-created')
  assert.ok(codes(d).includes('response-headers-not-observed'))
  assert.equal(d.rootCause,undefined); assert.equal(d.dnsMs,undefined)
})
test('send stage uses actual transport coverage and request timestamps', () => {
  for (const http of [
    { coverage: { sentHeaders: true } },
    { coverage: { bodySent: true } },
    { exchanges: [{ sentAt: 0 }] },
    { exchanges: [{ request: { sentHeadersAt: 0 } }] },
    { exchanges: [{ request: { bodySentAt: 12 } }] },
  ]) assert.equal(diagnose({ status: 'running', http }).stage.code, 'http-send')
  assert.equal(diagnose({ http: { coverage: { sendHeaders: true } } }).stage.code, 'normalized-only')
})
test('weak connection observations do not assert a failed request stage', () => {
  const d = diagnose({status:'running',http:{connections:[{event:'connectError',associationStrength:'weak'}],coverage:{},exchanges:[]}})
  assert.equal(d.stage.code,'connect-observed')
  assert.ok(codes(d).includes('association-unverified'))
  assert.ok(!codes(d).includes('stream-failed'))
})
test('compact summaries retain diagnosis and payloads stay out of summaries', () => {
  const a = {status:'error',request:{text:'prompt-secret'},response:{truncated:true},http:{exchanges:[{response:{status:503},request:{}}]}}
  const first = summary(a), second = summary(first)
  assert.deepEqual(second.diagnosis,first.diagnosis)
  assert.ok(codes(second.diagnosis).includes('http-error'))
  assert.ok(!JSON.stringify(second).includes('prompt-secret'))
})
test('legacy, cancellation, interruption, retry and observer exceptions keep distinct semantics', () => {
  assert.ok(codes(diagnose({status:'error',hasDetails:false})).includes('details-unavailable'))
  const d = diagnose({status:'aborted',retryOf:'previous',errors:[{stage:'http-observer',message:'copy failed'}]})
  assert.ok(codes(d).includes('aborted')); assert.ok(codes(d).includes('retry-linked')); assert.ok(codes(d).includes('observer-error'))
  assert.ok(!codes(d).includes('stream-failed'))
  assert.ok(codes(diagnose({status:'interrupted',observationInterrupted:true})).includes('observation-interrupted'))
})
test('normal prompt and model output never infer errors', () => {
  const d = diagnose({status:'stop',request:{value:{prompt:'HTTP 500 ETIMEDOUT'}},response:{events:[{text:'connection failed'}]}})
  assert.equal(d.findings.length,0)
})
