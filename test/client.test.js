import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Instrument a test-only copy; no production public globals or exports.
function helpers(overrides = {}) {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let factory
  const context = { window: { __ModuleLoader__: { load: value => { factory = value.factory } } }, ...overrides }
  vm.runInNewContext(source.replace("    return {\n      inject:", "    return { helpers: { datetime, rounds, display, failed, post, manage, traceSettings, settingsDraft, validateSettings, categories, categoryStats, filterAttempts, statusCounts, statusFilters, stageKey, en, zh, detailReason, sessionStats, anomaly, finalFailed, successful, effort, finite, byteText, icon, css, extraCss },\n      inject:"), context)
  return factory(() => ({ createElement() {} })).helpers
}

test('local datetime has exact millisecond resolution and rejects missing/invalid values', () => {
  const { datetime } = helpers()
  const sample = new Date(2026, 10, 4, 9, 8, 7, 6)
  assert.equal(datetime(sample.getTime()), '2026-11-04 09:08:07.006')
  assert.match(datetime(0), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.000$/)
  for (const value of [null, undefined, '', 'invalid']) assert.equal(datetime(value), '—')
})

test('rounds and attempts descend with deterministic ID tie breaks and no mutation', () => {
  const { rounds } = helpers()
  const input = [
    {id:'old',turn:1,startedAt:100}, {id:'a',turn:2,startedAt:200},
    {id:'b',turn:2,startedAt:200}, {id:'new',turn:2,startedAt:300},
  ]
  const before = JSON.stringify(input)
  const result = rounds(input)
  assert.equal(JSON.stringify(result.map(g => g.turn)), '[2,1]')
  assert.equal(JSON.stringify(result[0].attempts.map(a => a.id)), '["new","b","a"]')
  assert.equal(JSON.stringify(input), before)
})

test('nested timestamps transform for display only; zero usage remains zero', () => {
  const { display, datetime } = helpers()
  const input = { response:{events:[{at:1234,type:'text',data:{text:'hello',at:42,createdAt:43,date:'2020-01-01',time:44}}]}, errors:[{observedAt:5678}], http:{exchanges:[{startedAt:9012}]}, usage:{inputTokens:0}, durationMs:99 }
  const before = JSON.stringify(input), result = display(input)
  assert.equal(result.response.events[0].at, datetime(1234))
  assert.equal(result.errors[0].observedAt, datetime(5678))
  assert.equal(result.http.exchanges[0].startedAt, datetime(9012))
  assert.equal(result.response.events[0].data.at, 42)
  assert.equal(result.response.events[0].data.createdAt, 43)
  assert.equal(result.response.events[0].data.date, '2020-01-01')
  assert.equal(result.response.events[0].data.time, 44)
  assert.equal(result.usage.inputTokens, 0)
  assert.equal(result.durationMs, 99)
  assert.equal(JSON.stringify(input), before)
})

test('explicit non-anomaly summaries override retained cancellation evidence', () => {
  const { anomaly } = helpers()
  assert.equal(anomaly({status:'aborted',hasAnomaly:false,errorCount:1,failure:{message:'aborted'}}),false)
  assert.equal(anomaly({status:'interrupted',hasAnomaly:false,errors:[{message:'interrupted'}]}),false)
  assert.equal(anomaly({status:'aborted',hasAnomaly:true,httpErrorCount:1}),true)
})

test('error filter handles summary counts and legacy failure evidence', () => {
  const { failed } = helpers()
  for (const attempt of [{status:'error'},{errorCount:2},{failure:{message:'failed'}},{errors:[{stage:'stream'}]}]) assert.equal(failed(attempt),true)
  assert.equal(failed({status:'running',errorCount:0}),false)
})


test('statistics separate final failures, anomaly requests, cancellation and observations', () => {
  const { sessionStats } = helpers()
  const input = [
    {id:'a',turn:1,status:'error',errorCount:12,durationMs:100,usage:{inputTokens:0}},
    {id:'b',turn:1,status:'stop',hasAnomaly:true,durationMs:200,firstOutputMs:0,retryOf:'a',retryGapMs:50,usage:{inputTokens:10,outputTokens:5},detailBytes:100},
    {id:'c',turn:2,status:'tool-calls',durationMs:300},
    {id:'d',turn:2,status:'max-tokens',durationMs:400},
    {id:'e',turn:3,status:'aborted'}, {id:'f',turn:4,status:'interrupted'},
    {id:'g',turn:5,status:'running'}, {id:'h',status:'unknown'},
  ]
  const before = JSON.stringify(input), s = sessionStats(input)
  assert.equal(s.attempts,8)
  assert.equal(s.finalFailed,1)
  assert.equal(s.anomalousRequests,2)
  assert.equal(s.anomalousRounds,1)
  assert.equal(s.denominator,4)
  assert.equal(s.failureRate,.25)
  assert.equal(s.aborted,1); assert.equal(s.interrupted,1); assert.equal(s.running,1)
  assert.equal(s.avgDuration,250); assert.equal(s.p95Duration,400)
  assert.equal(s.firstAverage,0); assert.equal(s.firstSamples,1)
  assert.equal(s.retryGap,50); assert.equal(s.recovered,1)
  assert.equal(s.tokens.inputTokens.value,10); assert.equal(s.tokens.inputTokens.reported,2)
  assert.equal(s.tokens.outputTokens.value,5); assert.equal(s.tokens.totalTokens.value,undefined)
  assert.equal(s.detailBytes,100); assert.equal(s.detailSamples,1)
  assert.equal(JSON.stringify(input),before)
})

test('missing metadata stays unknown rather than zero and P95 uses nearest rank', () => {
  const {sessionStats,finite,byteText} = helpers(), empty = sessionStats([])
  for (const key of ['avgDuration','p95Duration','firstAverage','retryGap','failureRate','detailBytes']) assert.equal(empty[key],undefined,key)
  assert.equal(empty.tokens.inputTokens.value,undefined)
  for (const bad of [null,undefined,'0',NaN,Infinity,-1]) assert.equal(finite(bad),false)
  assert.equal(byteText(null),'—'); assert.equal(byteText(0),'0 B')
  const s = sessionStats(Array.from({length:20},(_,i) => ({id:String(i),status:'stop',durationMs:i+1})))
  assert.equal(s.p95Duration,19)
  const unknown = sessionStats([{status:'running',durationMs:999},{status:'stop',durationMs:null},{status:'stop',durationMs:'12'}])
  assert.equal(unknown.durationSamples,0)
})

test('recovery requires retryOf evidence and counts each failed chain once', () => {
  const {sessionStats} = helpers()
  assert.equal(sessionStats([{id:'a',status:'error'},{id:'b',status:'stop'}]).recovered,0)
  assert.equal(sessionStats([{id:'b',status:'stop',retryOf:'missing'}]).recovered,0)
  const chain = [{id:'a',status:'error'},{id:'b',status:'error',retryOf:'a'},{id:'c',status:'stop',retryOf:'b'},{id:'d',status:'stop',retryOf:'c'}]
  assert.equal(sessionStats(chain).recovered,1)
  assert.equal(sessionStats(chain).retries,3)
  assert.equal(sessionStats([{id:'a',status:'stop'},{id:'b',status:'stop',retryOf:'a'}]).recovered,0)
  assert.doesNotThrow(() => sessionStats([{id:'a',status:'stop',retryOf:'b'},{id:'b',status:'error',retryOf:'a'}]))
})

test('anomaly and successful-after-anomaly flags retain independent final outcome', () => {
  const {anomaly,finalFailed,successful,effort,extraCss,css} = helpers()
  for (const record of [{hasAnomaly:true},{status:'error'},{observedErrorCount:8},{failure:{code:'x'}},{errors:[{}]}]) assert.equal(anomaly(record),true)
  const a = {status:'stop',hasAnomaly:true,reasoningEffort:'high'}
  assert.equal(anomaly(a),true); assert.equal(finalFailed(a),false); assert.equal(successful(a),true)
  assert.equal(effort(a),'high'); assert.equal(effort({}),undefined)
  assert.equal(effort({request:{value:{reasoningEffort:'low'}}}),'low')
  assert.equal(anomaly({status:'aborted'}),false)
  assert.match(extraCss,/round-anomalous/); assert.match(extraCss,/border-left:4px/)
  assert.doesNotMatch(css,/content:'[+−]'/)
})


test('management helper preserves session scope and preview token with same-origin JSON', async () => {
  const calls = [], signal = {test:true}
  const {manage} = helpers({fetch:async (url,options) => { calls.push({url,options}); return {ok:true,json:async () => ({ok:true,value:{count:1,bytes:10,token:'preview-token'}})} }})
  await manage({action:'status',sessionId:'session-a'},signal)
  await manage({action:'preview',sessionId:'session-a'},signal)
  await manage({action:'cleanup',sessionId:'session-a',token:'preview-token'},signal)
  assert.equal(calls.length,3)
  for (const {url,options} of calls) {
    assert.equal(url,'/api/dsh-trace/manage'); assert.equal(options.credentials,'same-origin')
    assert.equal(options.method,'POST'); assert.equal(options.signal,signal)
    assert.equal(JSON.parse(options.body).sessionId,'session-a')
  }
  assert.deepEqual(JSON.parse(calls[2].options.body),{action:'cleanup',sessionId:'session-a',token:'preview-token'})
})

test('management helper surfaces HTTP and application failures without successful fallback', async () => {
  await assert.rejects(helpers({fetch:async () => ({ok:false,status:503})}).manage({action:'status'}),/HTTP 503/)
  await assert.rejects(helpers({fetch:async () => ({ok:true,json:async () => ({ok:false,error:{message:'expired token'}})})}).manage({action:'cleanup'}),/expired token/)
  await assert.rejects(helpers({fetch:async () => ({ok:true,json:async () => ({ok:true,value:null})})}).manage({action:'status'}),/Invalid management response/)
})


function components(initialStates = [], overrides = {}) {
  let factory, cursor = 0
  const states = [...initialStates]
  const React = {createElement:(type,props,...children) => ({type,props:props ?? {},children}),useState:initial => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i],value => { states[i] = typeof value === 'function' ? value(states[i]):value }] },useEffect() {},useRef:value => ({current:value}),useId:() => 'test-id',Fragment:'fragment'}
  const source = readFileSync(new URL('../client.js', import.meta.url),'utf8').replace('        function Trace(props)', '        ctx.testComponents = {Dashboard, Management, ArchiveSettings, ArchiveManager, TraceSettings, Attempt, Detail, ErrorEvidence, SessionTrace, Diagnosis, HttpView, BodyView, ErrorTree, RawEvidence, RuntimeView}; function Trace(props)')
  vm.runInNewContext(source,{window:{__ModuleLoader__:{load:value => {factory = value.factory}}},...overrides})
  const ctx = {effect() {},locale:{bind:() => key => key},slots:{inject() {}},uiWorkspace:{openSession:id => overrides.openSession?.(id)}}
  factory(() => React).apply(ctx)
  return {...ctx.testComponents,reset:() => {cursor = 0}}
}
const treeText = tree => tree == null || tree === false ? '' : typeof tree === 'object' ? (tree.children ?? []).map(treeText).join(' ') : String(tree)
const visibleText = tree => tree == null || tree === false ? '' : typeof tree !== 'object' ? String(tree) : (tree.type === 'details' && !tree.props.open ? tree.children.slice(0,1) : tree.children ?? []).map(visibleText).join(' ')
const treeFind = (tree,predicate) => tree && typeof tree === 'object' ? (predicate(tree) ? tree : tree.children.map(child => treeFind(child,predicate)).find(Boolean)) : undefined

test('request rows render standard SVG disclosure and successful anomaly wording', () => {
  const {Attempt} = components()
  const tree = Attempt({a:{id:'a',status:'stop',hasAnomaly:true,model:'model',provider:'provider'},sessionId:'s',clock:0})
  assert.match(tree.props.className,/anomalous/)
  assert.equal(tree.children[0].children[0].type,'svg')
  assert.match(treeText(tree),/pastAnomaly/)
})

test('overview places unspecified effort immediately after model and dashboard keeps failure denominator', () => {
  const {Detail} = components([{data:{attempt:{id:'a',model:'model',status:'stop'}},error:false},'overview'])
  const detail = Detail({sessionId:'s',attemptId:'a'})
  const fields = treeFind(detail,node => node.type === 'dl').children
  assert.equal(fields[2].props.key,'model'); assert.equal(fields[3].props.key,'effort')
  assert.match(treeText(fields[3]),/unspecified/)
  const {Dashboard} = components()
  const dashboard = Dashboard({ready:true,attempts:[{id:'a',status:'error',errorCount:100},{id:'b',status:'stop'},{id:'c',status:'aborted'}]})
  assert.match(treeText(dashboard),/50.0%/)
  assert.match(treeText(dashboard),/1\/2/)
})


test('list filtering never narrows dashboard and round flags use all round attempts', () => {
  const attempts = [{id:'a',turn:1,status:'error'},{id:'b',turn:1,status:'running'}]
  const {SessionTrace,Dashboard} = components([0,{data:{attempts},error:false,clock:0},'running',''])
  const tree = SessionTrace({sessionId:'session-a'})
  const dashboard = treeFind(tree,node => node.type === Dashboard)
  assert.equal(dashboard.props.attempts,attempts)
  const title = treeFind(tree,node => node.type === 'h3' && node.props.className === 'round-anomalous')
  assert.ok(title)
})

test('management never renders a cleanup confirmation before preview and always names session scope', () => {
  const {Management} = components([true,{root:'/trace',autoCleanup:false,preserveErrors:true},null,false,'',false])
  const tree = Management({sessionId:'session-a',onClean() {}})
  assert.match(treeText(tree),/scope/)
  assert.doesNotMatch(treeText(tree),/settingsHint/)
  assert.equal(treeFind(tree,node => node.type === 'button' && treeText(node).includes('confirmCleanup')),undefined)
  assert.ok(treeFind(tree,node => node.type === 'button' && treeText(node).includes('preview')))
})


test('categories count unique requests per category and assigned rounds without prompt inference', () => {
  const {categories,categoryStats,filterAttempts} = helpers()
  const attempts = [{id:'a',turn:1,errorCategories:['transport','provider','transport']},{id:'b',turn:1,errorCategories:['provider']},{id:'c',errorCount:1},{id:'d',request:{value:{messages:[{content:'transport error'}]}}}]
  assert.equal(JSON.stringify(categories(attempts[0])),'["transport","provider"]')
  assert.equal(JSON.stringify(categories(attempts[3])),'[]')
  assert.equal(JSON.stringify(categoryStats(attempts)),JSON.stringify([{id:'provider',requests:2,rounds:1},{id:'transport',requests:1,rounds:1},{id:'unknown-anomaly',requests:1,rounds:0}]))
  assert.equal(JSON.stringify(filterAttempts(attempts,'all','provider').map(a => a.id)),'["a","b"]')
})

test('category buttons toggle and reset active state with request and round counts', () => {
  const ui = components(), attempts = [{id:'a',turn:3,errorCategories:['transport']}]
  let selected = 'transport'
  const tree = ui.Dashboard({attempts,ready:true,category:selected,onCategory:value => {selected = value}})
  const button = treeFind(tree,n => n.type === 'button' && n.props['aria-pressed'] === true)
  assert.match(treeText(button),/transport · 1 requests \/ 1 categoryRounds/)
  button.props.onClick(); assert.equal(selected,'')
  selected = 'transport'
  treeFind(tree,n => n.type === 'button' && treeText(n) === 'resetCategory').props.onClick()
  assert.equal(selected,'')
})

test('category list keeps full dashboard, resets status filter, and removes session management', () => {
  const attempts = [{id:'a',turn:1,status:'error',errorCategories:['transport']},{id:'b',turn:2,status:'stop'}]
  const ui = components([0,{data:{attempts},error:false,clock:0},'running','transport'])
  let tree = ui.SessionTrace({sessionId:'s'})
  const dashboard = treeFind(tree,n => n.type === ui.Dashboard)
  assert.equal(dashboard.props.attempts,attempts)
  assert.equal(treeFind(tree,n => n.type === ui.Management),undefined)
  dashboard.props.onCategory('transport'); ui.reset(); tree = ui.SessionTrace({sessionId:'s'})
  assert.equal(treeFind(tree,n => n.type === ui.Attempt).props.a.id,'a')
  treeFind(tree,n => n.type === ui.Dashboard).props.onCategory(''); ui.reset(); tree = ui.SessionTrace({sessionId:'s'})
  assert.ok(treeFind(tree,n => n.type === ui.Attempt && n.props.a.id === 'b'))
})

test('detail absence reports only explicit budget cleanup and renders lightweight error evidence', () => {
  const {detailReason} = helpers()
  assert.equal(detailReason({detailsEvicted:true}),'detailUnknown')
  assert.equal(detailReason({detailsUnavailableReason:'legacy-summary-only'}),'detailLegacy')
  assert.equal(detailReason({detailsUnavailableReason:'disk-budget-cleanup'}),'detailBudget')
  const ui = components([{data:{attempt:{id:'a',detailsEvicted:true,errorEvidence:[{category:'transport',message:'connection closed'}]}},error:false},'errors'])
  const tree = ui.Detail({sessionId:'s',attemptId:'a'})
  assert.match(treeText(tree),/detailUnknown/)
  assert.ok(treeFind(tree,n => n.type === ui.ErrorEvidence))
  assert.match(treeText(ui.ErrorEvidence({attempt:{errorEvidence:[{message:"connection closed"}]}})),/lightEvidence/)
})

test('rows explain purpose and show reasoning effort next to the model', () => {
  const ui = components()
  const tree = ui.Attempt({a:{id:'a',model:'m',purpose:'generation',status:'tool-calls',reasoningEffort:'high'},sessionId:'s',clock:0})
  assert.match(treeText(tree),/m effort: high purpose: purposeGeneration/)
})


test('archive settings mount only for the trace bundle and reuse application settings', () => {
  const ui = components()
  for (const subject of [undefined,{kind:'plugin',pkg:{name:'@local/dsh-trace'}},{kind:'bundle',pkg:{name:'other'}}]) assert.equal(ui.ArchiveSettings({subject}),null)
  assert.equal(ui.ArchiveSettings({subject:{kind:'bundle',pkg:{name:'@local/dsh-trace'}}}).type,ui.TraceSettings)
})

test('archive settings separate global budget and selected-session management', () => {
  const status = {root:'/trace',detailBytes:4096,storageBytes:8192,legacyBytes:2048,combinedStorageBytes:10240,budgetBytes:8192,sessions:[{sessionId:'one',attemptCount:2,detailBytes:1024},{sessionId:'two',attemptCount:1,detailBytes:3072}]}
  const ui = components([status,'one',false,''])
  let tree = ui.ArchiveManager()
  assert.match(treeText(tree),/retainedDetails 4.0 KiB/)
  assert.match(treeText(tree),/sqliteStorage 8.0 KiB/); assert.match(treeText(tree),/legacyStorage 2.0 KiB/); assert.match(treeText(tree),/diskTotal 10.0 KiB/)
  assert.equal(treeFind(tree,n => n.type === ui.Management).props.sessionId,'one')
  treeFind(tree,n => n.props['aria-label'] === 'inspectArchive two').props.onClick()
  ui.reset(); tree = ui.ArchiveManager()
  assert.equal(treeFind(tree,n => n.type === ui.Management).props.sessionId,'two')
  assert.equal(treeFind(tree,n => n.type === ui.Management).props.key,'two')
})

test('request disclosure mounts details only after expansion and preserves error tab access', () => {
  const ui = components()
  let tree = ui.Attempt({a:{id:'a',status:'error'},sessionId:'s',clock:0})
  assert.equal(treeFind(tree,n => n.type === ui.Detail),undefined)
  tree.props.onToggle({currentTarget:{open:true}})
  ui.reset(); tree = ui.Attempt({a:{id:'a',status:'error'},sessionId:'s',clock:0})
  assert.equal(treeFind(tree,n => n.type === ui.Detail).props.attemptId,'a')
  const detailUI = components([{data:{attempt:{id:'a',purpose:'generation',status:'stop'}},error:false},'overview'])
  let detail = detailUI.Detail({sessionId:'s',attemptId:'a'})
  assert.match(treeText(detail),/finishNote/)
  treeFind(detail,n => n.type === 'button' && n.props.role === 'tab' && treeText(n) === 'errors').props.onClick()
  detailUI.reset(); detail = detailUI.Detail({sessionId:'s',attemptId:'a'})
  assert.equal(treeFind(detail,n => n.props.role === 'tab' && n.props['aria-selected']).children[0],'errors')
})

test('status counts use the list predicate over category-scoped full snapshots', () => {
  const {statusFilters,statusCounts,filterAttempts} = helpers()
  const attempts = [
    {id:'a',status:'error',errorCategories:['network']},
    {id:'b',status:'running',hasAnomaly:true,errorCategories:['network']},
    {id:'c',status:'aborted',hasAnomaly:false,errorCategories:['network']},
    {id:'d',status:'interrupted',hasAnomaly:false},
    {id:'e',status:'stop',hasAnomaly:true,errorCategories:['auth']},
    {id:'f',status:'stop'},
  ]
  const before = JSON.stringify(attempts)
  for (const category of ['', 'network', 'auth', 'absent']) {
    const counts = statusCounts(attempts,category)
    for (const key of statusFilters) assert.equal(counts[key],filterAttempts(attempts,key,category).length)
  }
  assert.equal(JSON.stringify(statusCounts(attempts,'network')),JSON.stringify({all:3,errors:2,running:1,aborted:1,interrupted:0}))
  assert.equal(statusCounts(attempts).errors,3)
  assert.equal(JSON.stringify(attempts),before)
})

test('filter buttons distinguish loading and empty, then refresh counts on new snapshots', () => {
  const controls = tree => treeFind(tree,n => n.props.role === 'group' && n.props['aria-label'] === 'attempts')
  for (const data of [null,{attempts:[]}]) {
    const ui = components([0,{data,error:false,clock:0},'all',''])
    const tree = ui.SessionTrace({sessionId:'s'})
    assert.equal(treeText(controls(tree)),data ? 'all · 0 errors · 0 running · 0 aborted · 0 interrupted · 0':'all · — errors · — running · — aborted · — interrupted · —')
    assert.match(treeText(tree),/filterScope/)
  }
  const snapshot = {data:{attempts:[{id:'a',status:'running',errorCategories:['network']},{id:'b',status:'stop'}]},error:false,clock:0}
  const ui = components([0,snapshot,'running','network'])
  let tree = ui.SessionTrace({sessionId:'s'})
  assert.match(treeText(controls(tree)),/all · 1 errors · 1 running · 1/)
  assert.match(treeText(tree),/categoryFilterScope/)
  snapshot.data = {attempts:[{id:'a',status:'error',errorCategories:['network']},{id:'b',status:'stop'},{id:'c',status:'running',errorCategories:['network']}]}
  ui.reset(); tree = ui.SessionTrace({sessionId:'s'})
  assert.match(treeText(controls(tree)),/all · 2 errors · 2 running · 1/)
  assert.equal(treeFind(tree,n => n.type === ui.Attempt).props.a.id,'c')
})

test('error surfaces explain stages without inferring origin and tolerate legacy evidence', () => {
  const {stageKey,zh,en} = helpers()
  const keys = {'adapter-finish':'stageAdapter','stream-iteration':'stageStream','agent-request-error':'stageAgent','http-response':'stageHttp','http-error-body':'stageHttp','http-transport':'stageTransport','http-observer':'stageObserver'}
  for (const [stage,key] of Object.entries(keys)) {
    assert.equal(stageKey(stage),key)
    assert.ok(zh[key]); assert.ok(en[key])
  }
  assert.equal(stageKey('future-stage'),'stageUnknown')
  assert.match(zh.streamLayer,/本身不是错误/)
  assert.match(zh.stageNote,/已有正常文字输出也不保证流最终成功/)
  const ui = components(), evidence = [{stage:'adapter-finish',message:'x'},{stage:'future-stage',origin:'future-origin',message:'y'}]
  const tree = ui.ErrorEvidence({attempt:{errorEvidence:evidence,errors:[{stage:'http-observer'}],failure:{message:'legacy'}}})
  for (const text of ['stageAdapter','stageObserver','stageUnknown','originUnknown','future-origin','rawErrors','failure']) assert.ok(treeText(tree).includes(text),text)
  assert.doesNotThrow(() => ui.ErrorEvidence({attempt:{}}))
})

test('TRANSPORT explanation is case insensitive and never inferred from message text', () => {
  const ui = components(), {zh,en} = helpers()
  for (const code of ['TRANSPORT','transport','TrAnSpOrT']) {
    for (const attempt of [{errorEvidence:[{code}]},{errors:[{code}]},{failure:{code}}]) {
      assert.match(treeText(ui.ErrorEvidence({attempt})),/transportCodeNote/)
    }
  }
  for (const attempt of [{},{errorEvidence:[{code:'API_ERROR',message:'TRANSPORT Connection error.'}]}]) {
    assert.doesNotMatch(treeText(ui.ErrorEvidence({attempt})),/transportCodeNote/)
  }
  assert.equal(zh.categoryNetwork,'网络／传输')
  assert.match(zh.transportCodeNote,/不等于上游 API 错误码/)
  assert.match(zh.transportCodeNote,/原始异常/)
  assert.match(en.transportCodeNote,/not an upstream API error code/)
})


test('overview automatically mounts diagnosis and keeps linked retry metadata', () => {
  const attempt = {id:'a',retryOf:'previous',retryGapMs:0,diagnosis:{stage:{code:'http-response',label:'HTTP response',confidence:'observed'},findings:[],gaps:[]}}
  const ui = components([{data:{attempt},error:false},'overview'])
  const tree = ui.Detail({sessionId:'s',attemptId:'a'})
  assert.equal(treeFind(tree,n => n.type === ui.Diagnosis).props.attempt,attempt)
  assert.match(treeText(tree),/previous/)
  assert.match(treeText(tree),/0 ms/)
  const summary = ui.Diagnosis({attempt:{diagnosis:{stage:{label:'HTTP response',confidence:'observed'},findings:[{code:'http-200-stream-error',detail:'stream failed',severity:'error',evidenceRefs:['/errors/0']}],gaps:[{code:'association-unverified',detail:'weak association'},{code:'future-gap',title:'Future gap',detail:'future detail'}]}}})
  for (const expected of ['deepest','HTTP response','diag-http-200-stream-error','/errors/0','diag-association-unverified','Future gap','future detail']) assert.ok(treeText(summary).includes(expected),expected)
  assert.match(treeText(ui.Diagnosis({attempt:{}})),/diagnosisLegacy/)
})

test('HTTP separates connection events and runtime from exchanges and collapses raw evidence', () => {
  const ui = components(), runtime = {nodeVersion:'v22',autoSelectFamily:false}
  const tree = ui.HttpView({http:{runtime,connections:[{event:'connectError',observedAt:123,association:'async-context-only',endpoint:{hostname:'example.test'},socket:{remoteFamily:'IPv6'}}],exchanges:[{response:{status:200}}]}})
  assert.match(treeText(tree),/connectionNote/)
  assert.match(treeText(tree),/connectError/)
  assert.match(treeText(tree),/example.test/)
  assert.match(treeText(tree),/IPv6/)
  assert.match(treeText(tree),/bodyNote/)
  assert.equal(treeFind(tree,n => n.type === ui.RuntimeView).props.runtime,runtime)
  const raw = ui.RawEvidence({value:{message:'original'}})
  assert.equal(raw.type,'details'); assert.equal(raw.props.open,undefined)
  assert.equal(raw.children[0].type,'summary')
  assert.match(treeText(ui.RuntimeView({runtime})),/no/)
})

test('body completeness, unknown measurements and reasons remain distinct', () => {
  const ui = components()
  const unavailable = ui.BodyView({body:{available:false,complete:false,reasonCode:'body-not-observed',reason:'No chunk events'}})
  for (const expected of ['body-not-observed','No chunk events','—','no']) assert.ok(treeText(unavailable).includes(expected),expected)
  const captured = ui.BodyView({body:{available:true,complete:true,textComplete:false,truncated:true,observedBytes:0,text:'redacted',sha256:'abc',hashCoverage:'observed prefix'}})
  assert.match(treeText(captured),/partial/); assert.match(treeText(captured),/abc/); assert.match(treeText(captured),/observed prefix/)
  assert.equal(treeFind(captured,n => n.type === 'details').props.open,undefined)
})

test('aggregate error trees expose per-address children without expanding original JSON', () => {
  const ui = components()
  const tree = ui.ErrorTree({error:{name:'AggregateError',code:'ETIMEDOUT',errors:[{code:'ETIMEDOUT',address:'::1',port:443,family:6},{code:'ECONNREFUSED',address:'127.0.0.1',port:443}]}})
  const children = treeFind(tree,n => n.type === 'fragment').children
  const nodes = children.filter(n => n && n.type === ui.ErrorTree)
  assert.equal(nodes.length,2)
  assert.match(treeText(ui.ErrorTree(nodes[0].props)),/::1/)
  assert.match(treeText(ui.ErrorTree(nodes[1].props)),/ECONNREFUSED/)
  assert.ok(treeFind(tree,n => n.type === ui.RawEvidence))
})


test('diagnostic tabs retain roving focus and End/Home keyboard navigation', () => {
  const focused = [], ui = components([{data:{attempt:{id:'a'}},error:false},'overview'],{document:{getElementById:id => ({focus:() => focused.push(id)})}})
  let tree = ui.Detail({sessionId:'s',attemptId:'a'}), prevented = 0
  treeFind(tree,n => n.props.role === 'tablist').props.onKeyDown({key:'End',preventDefault:() => prevented++})
  ui.reset(); tree = ui.Detail({sessionId:'s',attemptId:'a'})
  assert.equal(treeFind(tree,n => n.props.role === 'tab' && n.props['aria-selected']).children[0],'http')
  assert.equal(focused[0],'test-id-http')
  treeFind(tree,n => n.props.role === 'tablist').props.onKeyDown({key:'Home',preventDefault:() => prevented++})
  ui.reset(); tree = ui.Detail({sessionId:'s',attemptId:'a'})
  assert.equal(treeFind(tree,n => n.props.role === 'tab' && n.props.tabIndex === 0).children[0],'overview')
  assert.equal(prevented,2)
})

test('header replaces export with accessible new-window service status links', () => {
  const {zh} = helpers(), ui = components()
  assert.equal(zh.title,'请求追踪')
  const header = treeFind(ui.SessionTrace({sessionId:'s'}),n => n.type === 'header')
  for (const [label,href] of [['OpenAI Status','https://status.openai.com'],['DeepSeek Status','https://status.deepseek.com']]) {
    const link = treeFind(header,n => n.type === 'a' && n.props.href === href)
    assert.ok(link); assert.equal(link.props.target,'_blank')
    assert.equal(link.props.rel,'noopener noreferrer')
    assert.equal(link.props['aria-label'],label+' · newWindow')
    assert.match(treeText(link),/↗/)
    assert.equal(treeFind(link,n => n.type === 'span').props['aria-hidden'],true)
  }
  assert.equal(treeFind(header,n => n.type === 'button'),undefined)
  const source = readFileSync(new URL('../client.js',import.meta.url),'utf8')
  assert.doesNotMatch(source,/exportController|setExporting|exportError|async function download|createObjectURL|export:true/)
})

test('diagnosis defaults to stage and important titles while preserving all evidence collapsed', () => {
  const ui = components()
  const diagnosis = {stage:{label:'HTTP response',confidence:'observed'},findings:[
    {code:'stream-failed',severity:'error',detail:'failure explanation',evidenceRefs:['/errors/0']},
    {code:'future-info',title:'Low value information',severity:'info',detail:'normal explanation',evidenceRefs:['/http/0']},
    {code:'future-warning',title:'Important warning',severity:'warning',detail:'warning explanation'},
  ],gaps:[{code:'future-gap',title:'Full gap',detail:'gap explanation',evidenceRefs:['/gaps/0']}]}
  const before = JSON.stringify(diagnosis), tree = ui.Diagnosis({attempt:{diagnosis}})
  const visible = visibleText(tree)
  for (const expected of ['HTTP response','diag-stream-failed','Important warning']) assert.ok(visible.includes(expected))
  for (const hidden of ['diagnosisNote','confidence','failure explanation','/errors/0','Low value information','normal explanation','Full gap','gap explanation']) assert.ok(!visible.includes(hidden),hidden)
  const details = treeFind(tree,n => n.type === 'details')
  assert.equal(details.props.open,undefined)
  for (const retained of ['failure explanation','/errors/0','Low value information','/http/0','Full gap','gap explanation','/gaps/0']) assert.ok(treeText(details).includes(retained),retained)
  assert.equal(treeFind(details,n => n.type === ui.RawEvidence).props.value,diagnosis)
  assert.equal(JSON.stringify(diagnosis),before)
  const normal = ui.Diagnosis({attempt:{diagnosis:{stage:{label:'Completed'},findings:[diagnosis.findings[1]],gaps:diagnosis.gaps}}})
  assert.doesNotMatch(visibleText(normal),/noFindings|Low value information|Full gap|diagnosisNote/)
})

test('new upstream categories use explicit backend labels and preserve filtering', () => {
  const {zh,en,categories,filterAttempts} = helpers()
  assert.equal(zh.categoryOverload,'上游过载'); assert.equal(zh.categoryUpstreamRequest,'上游请求失败')
  assert.equal(zh.categoryProvider,'上游服务异常'); assert.equal(zh.categoryUnknown,'其他异常')
  assert.equal(zh.unknownCategory,'其他异常')
  assert.ok(en.categoryOverload); assert.ok(en.categoryUpstreamRequest)
  const ui = components(), attempts = ['overload','upstream-request','provider','unknown'].map((id,i) => ({id:String(i),errorCategories:[id]}))
  const tree = ui.Dashboard({attempts,ready:true})
  for (const label of ['categoryOverload','categoryUpstreamRequest','categoryProvider','categoryUnknown']) assert.ok(treeText(tree).includes(label),label)
  assert.equal(filterAttempts(attempts,'all','overload').length,1)
  assert.equal(JSON.stringify(categories({status:'stop',request:{value:{text:'overloaded upstream request failed'}}})),'[]')
})

test('serialized causes arrays retain nested AggregateError candidates and truncation state', () => {
  const ui = components(), tree = ui.ErrorTree({error:{code:'TRANSPORT',causes:[{code:'ETIMEDOUT',errors:[{address:'::1'}]}],truncated:true}})
  assert.match(treeText(tree),/partial/)
  const cause = treeFind(tree,n => n.type === ui.ErrorTree)
  assert.equal(cause.props.error.code,'ETIMEDOUT')
  assert.equal(treeFind(ui.ErrorTree(cause.props),n => n.type === ui.ErrorTree).props.error.address,'::1')
})


const settingsValue = () => ({backend:'sqlite',databasePath:'/trace/archive.sqlite',settings:{directory:'/trace',autoCleanup:false,detailBudgetMiB:128,preserveErrors:true,maxAttempts:10000,retentionDays:7}})

test('settings API uses same-origin POST and validates full get/update responses', async () => {
  const calls = [], value = settingsValue(), signal = {}
  const {traceSettings} = helpers({fetch:async (url,options) => { calls.push({url,options}); return {ok:true,json:async () => ({ok:true,value})} }})
  await traceSettings({action:'get'},signal)
  const settings = {autoCleanup:true,detailBudgetMiB:64,preserveErrors:true,maxAttempts:0,retentionDays:0}
  await traceSettings({action:'update',settings},signal)
  assert.equal(calls.length,2)
  for (const {url,options} of calls) { assert.equal(url,'/api/dsh-trace/settings'); assert.equal(options.method,'POST'); assert.equal(options.credentials,'same-origin'); assert.equal(options.signal,signal) }
  assert.deepEqual(JSON.parse(calls[1].options.body),{action:'update',settings})
  await assert.rejects(helpers({fetch:async () => ({ok:false,status:500})}).traceSettings({action:'get'}),/HTTP 500/)
  await assert.rejects(helpers({fetch:async () => ({ok:true,json:async () => ({ok:false,error:{message:'write failed'}})})}).traceSettings({action:'update'}),/write failed/)
  await assert.rejects(helpers({fetch:async () => ({ok:true,json:async () => ({ok:true,value:{backend:'json',settings:{}}})})}).traceSettings({action:'get'}),/Invalid settings response/)
})

test('settings validation preserves zero/unlimited and rejects invalid limits', () => {
  const {settingsDraft,validateSettings} = helpers(), draft = settingsDraft(settingsValue().settings)
  for (const retentionDays of ['0','3','7','15']) assert.equal(Object.keys(validateSettings({...draft,retentionDays,maxAttempts:'0'}).errors).length,0)
  for (const maxAttempts of ['', '-1','1.5','Infinity','9007199254740992']) assert.equal(validateSettings({...draft,maxAttempts}).errors.maxAttempts,'integerError')
  for (const detailBudgetMiB of ['', '-1','Infinity','NaN','1048576.01']) assert.equal(validateSettings({...draft,detailBudgetMiB}).errors.detailBudgetMiB,'budgetError')
  for (const detailBudgetMiB of ['0','0.5','1048576']) assert.equal(validateSettings({...draft,detailBudgetMiB}).errors.detailBudgetMiB,undefined)
  assert.match(helpers().zh.detailBudgetMiBDescription,/0 清理全部可清理详情/)
  assert.match(helpers().en.detailBudgetMiB,/0 cleans all eligible details/)
  assert.equal(validateSettings({...draft,retentionDays:'1'}).errors.retentionDays,'retentionError')
  assert.equal(validateSettings({...draft,retentionDays:'0',maxAttempts:'0'}).value.maxAttempts,0)
})

test('application settings page registers a separate localized list entry', () => {
  let factory; const registrations = []
  vm.runInNewContext(readFileSync(new URL('../client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:value => {factory=value.factory}}}})
  factory(() => ({createElement() {}})).apply({effect() {},locale:{bind:() => key => key},slots:{inject:(name,fn) => fn(),register:(options,component) => registrations.push({options,component})}})
  const entry = registrations.find(r => r.options.name === 'settings.section')
  assert.equal(entry.options.id,'dsh-trace'); assert.equal(entry.options.label(),'settingsTitle')
  assert.ok(registrations.some(r => r.options.name === 'plugins.detail.section'))
})

test('settings page shows loading, retry, SQLite and accessible dirty validation states', () => {
  const data = settingsValue(), draft = helpers().settingsDraft(data.settings)
  let ui = components(), tree = ui.TraceSettings()
  assert.match(treeText(tree),/settingsLoading/); assert.equal(tree.props['aria-busy'],true)
  ui = components([{data:null,draft:null,loading:false,saving:false,error:'load failed',saved:false}]); tree = ui.TraceSettings()
  assert.ok(treeFind(tree,n => n.props.role === 'alert')); assert.ok(treeFind(tree,n => n.type === 'button' && treeText(n) === 'reloadSettings'))
  ui = components([{data,draft,loading:false,saving:false,error:'',saved:false}]); tree = ui.TraceSettings()
  assert.match(treeText(tree),/automaticDescription/); assert.match(treeText(tree),/cleanupRules/); assert.match(treeText(tree),/settingsPolicy/)
  assert.equal(treeFind(tree,n => n.type === 'button' && n.props.type === 'submit').props.disabled,true)
  treeFind(tree,n => n.type === 'input' && n.props.id.endsWith('-maxAttempts')).props.onChange({target:{value:'-1'}})
  ui.reset(); tree = ui.TraceSettings()
  const input = treeFind(tree,n => n.type === 'input' && n.props.id.endsWith('-maxAttempts'))
  assert.equal(input.props['aria-invalid'],true); assert.ok(input.props['aria-describedby']); assert.match(treeText(tree),/dirty/)
  assert.equal(treeFind(tree,n => n.type === 'button' && n.props.type === 'submit').props.disabled,true)
  treeFind(tree,n => n.type === 'button' && treeText(n) === 'resetSettings').props.onClick()
  ui.reset(); tree = ui.TraceSettings(); assert.match(treeText(tree),/unchanged/)
  const select = treeFind(tree,n => n.type === 'select')
  assert.deepEqual(select.children.map(n => n.props.value),['0','3','7','15'])
})

test('save failure preserves edits, announces failure and re-enables retry', async () => {
  const data = settingsValue(), draft = {...helpers().settingsDraft(data.settings),maxAttempts:'0'}
  const ui = components([{data,draft,loading:false,saving:false,error:'',saved:false}],{AbortController,setTimeout,clearTimeout,fetch:async () => ({ok:true,json:async () => ({ok:false,error:{message:'disk full'}})})})
  let tree = ui.TraceSettings()
  treeFind(tree,n => n.type === 'form').props.onSubmit({preventDefault() {}})
  await new Promise(resolve => setImmediate(resolve))
  ui.reset(); tree = ui.TraceSettings()
  assert.match(treeText(treeFind(tree,n => n.props.role === 'alert')),/settingsSaveError: disk full/)
  assert.equal(treeFind(tree,n => n.type === 'input' && n.props.id.endsWith('-maxAttempts')).props.value,'0')
  assert.equal(treeFind(tree,n => n.type === 'button' && n.props.type === 'submit').props.disabled,false)
})


test('successful save sends only editable settings and resets dirty state', async () => {
  const data = settingsValue(), draft = {...helpers().settingsDraft(data.settings),maxAttempts:'0',retentionDays:'15'}, calls = []
  const next = {...data,settings:{...data.settings,maxAttempts:0,retentionDays:15}}
  const ui = components([{data,draft,loading:false,saving:false,error:'',saved:false}],{AbortController,setTimeout,clearTimeout,fetch:async (url,options) => { calls.push(JSON.parse(options.body)); return {ok:true,json:async () => ({ok:true,value:next})} }})
  let tree = ui.TraceSettings()
  treeFind(tree,n => n.type === 'form').props.onSubmit({preventDefault() {}})
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls,[{action:'update',settings:{autoCleanup:false,preserveErrors:true,maxAttempts:0,detailBudgetMiB:128,retentionDays:15}}])
  ui.reset(); tree = ui.TraceSettings()
  assert.match(treeText(tree),/saved/)
  assert.equal(treeFind(tree,n => n.type === 'button' && n.props.type === 'submit').props.disabled,true)
})


test('archive sessions navigate with the real UI service and close settings', () => {
  let opened, closed = false
  const status = {sessions:[{sessionId:'one',attemptCount:3,detailCount:2,detailBytes:50}]}
  const ui = components([status,'',false,''],{openSession:id => {opened = id}})
  const tree = ui.ArchiveManager({close:() => {closed = true}})
  treeFind(tree,n => n.props.className === 'session-link').props.onClick()
  assert.equal(opened,'one'); assert.equal(closed,true)
  assert.equal(treeFind(tree,n => n.type === ui.Management),undefined)
  assert.match(treeText(tree),/archiveCounts: 3 \/ 2/)
})

test('every setting presents title description and control, with scope explanation collapsed', () => {
  const data = settingsValue(), draft = helpers().settingsDraft(data.settings)
  const ui = components([{data,draft,loading:false,saving:false,error:'',saved:false}])
  const tree = ui.TraceSettings()
  for (const key of ['autoCleanup','maxAttempts','retentionDays','detailBudgetMiB','preserveErrors']) {
    const row = treeFind(tree,n => n.props.className === 'settings-field' && n.props.key === key)
    assert.ok(row)
    const label = treeFind(row,n => n.type === 'label')
    const control = treeFind(row,n => n.type === 'input' || n.type === 'select')
    assert.equal(label.props.htmlFor,control.props.id)
    assert.match(control.props['aria-describedby'],/-description/)
  }
  assert.equal(treeFind(tree,n => n.type === 'details' && n.props.className.includes('cleanup-rules')).props.open,undefined)
  assert.doesNotMatch(visibleText(tree),/settingsPolicy/)
  assert.match(helpers().zh.automaticDescription,/10 分钟/)
})
