// Deterministic, evidence-only explanations. Never scan prompts/model text or infer a root cause.
export function diagnose(attempt) {
  const detailed = !!(attempt.http || attempt.request || attempt.response || attempt.errors)
  // Compact indexes retain the last diagnosis without reopening every detail snapshot.
  if (!detailed && attempt.diagnosis?.version === 1) return attempt.diagnosis
  const findings = [], gaps = [], http = attempt.http, exchanges = http?.exchanges ?? []
  const coverage = http?.coverage ?? {}, connections = http?.connections ?? []
  const errors = [...(attempt.errors ?? []), ...(attempt.errorEvidence ?? [])]
  const add = (code, title, detail, evidenceRefs = [], severity = 'info') => findings.push({ code, title, detail, severity, evidenceRefs })
  const gap = (code, title, detail, evidenceRefs = []) => gaps.push({ code, title, detail, evidenceRefs })
  const failed = /^(error|failure|failed)$/.test(attempt.status ?? '')
  let stage = { code: 'normalized-only', label: '仅有规范化调用记录', confidence: 'unknown' }
  if (connections.length) stage = { code: 'connect-observed', label: '异步上下文内观测到连接事件（弱关联）', confidence: 'observed' }
  if (coverage.requestCreate || exchanges.length) stage = { code: 'http-created', label: '已观测 HTTP 请求创建', confidence: 'observed' }
  if (coverage.sentHeaders || coverage.bodySent || exchanges.some(e => e.sentAt != null || e.request?.sentHeadersAt != null || e.request?.bodySentAt != null)) stage = { code: 'http-send', label: '已观测 HTTP 发送事件', confidence: 'observed' }
  if (exchanges.some(e => e.response?.status != null)) stage = { code: 'http-response', label: '已观测 HTTP 响应头', confidence: 'observed' }
  if ((attempt.outputChunks ?? 0) > 0) stage = { code: 'normalized-output', label: '已观测规范化输出（不代表最终成功）', confidence: 'observed' }
  for (let i = 0; i < exchanges.length; i++) {
    const exchange = exchanges[i], status = exchange.response?.status
    if (status >= 400) add('http-error', `HTTP ${status} 错误响应`, '实际观测到了错误状态码；错误正文及供应商请求标识见 HTTP 证据。', [`/http/exchanges/${i}/response`], 'error')
    if (status >= 200 && status < 300 && failed) add('http-200-stream-error', `HTTP ${status} 后调用仍失败`, '成功响应头不等于模型流成功结束；请结合结束事件和异常树定位后续断点。', [`/http/exchanges/${i}/response/status`, '/errors', '/response/finish'], 'error')
    for (const side of ['request', 'response']) {
      const body = exchange[side]?.body, ref = `/http/exchanges/${i}/${side}/body`
      if (body?.truncated || body?.textPartial || body?.textComplete === false && body?.available) gap('body-truncated', `${side === 'request' ? '请求' : '响应'}正文采集不完整`, '保留量或流完整性受限；观察字节、捕获字节及脱敏后保留量分别显示。', [ref])
      if (!body || body.available === false) gap('body-unavailable', `${side === 'request' ? '请求' : '响应'}正文未展示`, body?.reason ?? '未取得正文采集证据，不等于空正文。', [ref])
    }
  }
  // The deepest retained OS exception is useful even when an SDK has normalized the outer message.
  let traversed = 0, treeTruncated = false
  const visited = new WeakSet(), candidates = []
  function walk(error, ref, depth = 0) {
    if (!error || typeof error !== 'object' || depth > 10 || traversed++ >= 256 || visited.has(error)) return
    visited.add(error)
    treeTruncated ||= !!(error.truncated || error.causeTruncated)
    if (error.address && (error.syscall === 'connect' || /ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH/.test(error.code ?? ''))) candidates.push(ref)
    for (const key of ['causes', 'errors']) if (Array.isArray(error[key])) error[key].slice(0, 16).forEach((child, i) => walk(child, `${ref}/${key}/${i}`, depth + 1))
    if (error.cause) walk(error.cause, `${ref}/cause`, depth + 1)
  }
  errors.forEach((error, i) => walk(error, i < (attempt.errors?.length ?? 0) ? `/errors/${i}` : `/errorEvidence/${i - (attempt.errors?.length ?? 0)}`))
  if (candidates.length) add('connect-candidates-failed', '已保留候选地址连接异常', '异常树包含具体地址的连接失败；连接池事件仅为上下文弱关联，不据此断定某请求、IP 协议族或上游服务的根因。', candidates.slice(0, 16), 'error')
  if (failed) add('stream-failed', '调用以错误结束', '错误来自真实异常或规范化结束记录；多个观测点可能描述同一次失败。', ['/status', '/errors', '/response/finish'], 'error')
  if (attempt.retryOf) add('retry-linked', '已关联上一次尝试', '这是新的调用尝试，重试来源与等待间隔单独保留，不将多处错误观测重复计为请求。', ['/retryOf', '/retryGapMs'])
  if (attempt.observationInterrupted || attempt.status === 'interrupted') add('observation-interrupted', '观测中断', 'Trace 的观测中断，当前记录不证明供应商最终执行结果。', ['/status'])
  else if (/^(aborted|cancelled|canceled)$/.test(attempt.status ?? '')) add('aborted', '调用已中止', '调用记录报告中止；不将其自动归为供应商故障。', ['/status'])
  if (errors.some(e => e.stage === 'http-observer')) add('observer-error', 'Trace 采集器异常', '该异常属于观测器自身，与模型调用故障分开解释。', ['/errors'], 'warning')
  if (!http) gap('http-not-observed', '缺少 HTTP 层证据', '只保留了规范化记录或历史摘要，未观测不等于没有发送请求。', ['/http'])
  else {
    if (!exchanges.some(e => e.response?.status != null)) gap('response-headers-not-observed', '未观测到响应头', '尚无 HTTP 状态证据；该缺口本身不证明服务端未处理请求。', ['/http/coverage'])
    if (!connections.length) gap('connection-not-observed', '未采集连接阶段事件', '连接可能复用、事件不受支持或位于当前观测范围外；不补造 DNS/TCP/TLS 耗时。', ['/http/coverage'])
    else gap('association-unverified', '连接与请求关联未证实', '连接属于池级事件，仅与当前异步上下文弱关联；没有精确 socket/request 证据时不绑定具体请求。', ['/http/connections'])
    if (coverage.connectionsTruncated || coverage.exchangesTruncated) gap('transport-records-truncated', '传输记录达到保留上限', '连接事件或 HTTP 交换记录为有界采集，列表不覆盖全部活动。', ['/http/coverage'])
  }
  if (attempt.response?.truncated || attempt.request?.truncated) gap('normalized-truncated', '规范化内容达到采集上限', '规范化请求或流事件保留不完整；与 HTTP 正文截断分别计量。', ['/request', '/response'])
  if (treeTruncated || attempt.errorsTruncated) gap('error-tree-truncated', '异常证据达到保留上限', '异常深度、节点数、内容预算或观测次数受限，详细树带有截断标记。', ['/errors'])
  if (attempt.detailsEvicted || !detailed) gap('details-unavailable', '详细快照未保留', '历史仅摘要、快照已清理或未采集；现有证据不会自动补回历史缺失内容。', ['/detailsUnavailableReason'])
  return { version: 1, stage, findings: findings.slice(0, 32), gaps: gaps.slice(0, 48) }
}
