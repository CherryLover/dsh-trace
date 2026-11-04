import S from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import path from 'node:path'

export const defaults = { directory: '~/.dsh/request-traces', autoCleanup: false, detailBudgetMiB: 1024, preserveErrors: true, memoryCacheMiB: 32, memoryAttemptLimit: 5000, requestLimitKiB: 512, responseLimitKiB: 256, httpBodyLimitKiB: 256, responseEventLimit: 2000, maxAttempts: 10000, retentionDays: 7 }
export const Config = S.object({
  autoCleanup: S.boolean().default(false).description('自动清理归档 / Automatically clean archives；保存设置不立即删除，后台检查间隔 10 分钟。'),
  detailBudgetMiB: S.number().min(0).max(1048576).default(1024).description('磁盘详情预算 MiB / Detail budget MiB；0 表示清理所有可清理详情，索引与日志另计。'),
  maxAttempts: S.natural().max(10000000).default(10000).description('归档请求条数上限；0 不限。自动清理启用时，优先删除最早成功记录；受保护异常和进行中记录可能使总数超限。'),
  retentionDays: S.union([S.const(0), S.const(3), S.const(7), S.const(15)]).default(7).description('成功请求保留天数：3 / 7 / 15；0 不限。后台每10分钟检查，保存不立即清理。'),
  preserveErrors: S.boolean().default(true).description('优先保留异常请求详情 / Protect error evidence；自动清理跳过错误，可能超出预算。'),
  memoryCacheMiB: S.number().min(1).max(4096).default(32).description('内存详情缓存 MiB / Memory cache MiB；释放内存不删除磁盘证据。'),
  memoryAttemptLimit: S.number().min(100).max(100000).default(5000).description('内存最近请求条数 / Recent attempts in memory；更早摘要仍保留在磁盘。'),
  requestLimitKiB: S.number().min(1).max(16384).default(512).description('单请求规范化输入捕获上限 KiB / Normalized request capture limit'),
  responseLimitKiB: S.number().min(1).max(16384).default(256).description('单请求规范化输出事件捕获上限 KiB（finish/replay 元数据另计） / Normalized response capture limit'),
  httpBodyLimitKiB: S.number().min(1).max(16384).default(256).description('每个 HTTP 请求体或响应体捕获上限 KiB / HTTP entity capture limit'),
  responseEventLimit: S.number().min(1).max(20000).default(2000).description('单请求保留输出事件数 / Retained response event limit'),
}).volatile()
export function readConfig(config) {
  const value = typeof config?.get === 'function' ? config.get() : config
  return { ...defaults, ...value }
}
export function archiveRoot(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Archive directory must be nonempty')
  return path.resolve(value === '~' ? homedir() : value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value)
}
