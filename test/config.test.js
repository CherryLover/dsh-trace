import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { homedir } from 'node:os'
import { Config, defaults, readConfig, archiveRoot } from '../config.js'

test('config exposes volatile settings and merges defaults for ordinary and live getters', () => {
  assert.ok(Config)
  assert.deepEqual(readConfig(), defaults)
  assert.deepEqual(readConfig({ directory: '/tmp/example' }), { ...defaults, directory: '/tmp/example' })
  let current = { directory: '/tmp/a', preserveErrors: false }
  const live = { get: () => current }
  assert.equal(readConfig(live).directory, '/tmp/a')
  assert.equal(readConfig(live).preserveErrors, false)
  current = { directory: '/tmp/b', autoCleanup: true, detailBudgetMiB: 0, copyOnDirectoryChange: false }
  assert.deepEqual(readConfig(live), { ...defaults, ...current })
  assert.equal(readConfig(live).memoryCacheMiB, 32)
  assert.equal(readConfig(live).memoryAttemptLimit, 5000)
  assert.equal(defaults.directory, '~/.dsh/request-traces')
})
test('capture limits preserve historical defaults and update through volatile getter without mutating defaults', () => {
  const keys = ['requestLimitKiB', 'responseLimitKiB', 'httpBodyLimitKiB', 'responseEventLimit']
  const pick = value => Object.fromEntries(keys.map(key => [key, value[key]]))
  const historical = { requestLimitKiB: 512, responseLimitKiB: 256, httpBodyLimitKiB: 256, responseEventLimit: 2000 }
  assert.deepEqual(pick(defaults), historical)
  assert.deepEqual(pick(readConfig()), historical)
  let live = { requestLimitKiB: 1, responseLimitKiB: 2, httpBodyLimitKiB: 3, responseEventLimit: 4 }
  const config = { get: () => live }
  assert.deepEqual(pick(readConfig(config)), live)
  live = { requestLimitKiB: 16, responseLimitKiB: 32, httpBodyLimitKiB: 64, responseEventLimit: 100 }
  assert.deepEqual(pick(readConfig(config)), live)
  assert.deepEqual(pick(defaults), historical)
  assert.equal(readConfig(config).preserveErrors, true)
})
test('archiveRoot resolves relative and home paths without opening or writing default directories', () => {
  assert.equal(archiveRoot('~'), homedir())
  assert.equal(archiveRoot('~/traces'), path.join(homedir(), 'traces'))
  assert.equal(archiveRoot('relative/traces'), path.resolve('relative/traces'))
  assert.equal(archiveRoot('/tmp/traces'), '/tmp/traces')
  for (const value of [undefined, null, 0, {}, '', '  ', '\t']) assert.throws(() => archiveRoot(value), /nonempty/)
})

test('public schema hides location migration controls while legacy roots remain readable', () => {
  const schema = Config
  assert.equal(schema.dict.directory, undefined)
  assert.equal(schema.dict.copyOnDirectoryChange, undefined)
  assert.equal(readConfig({ directory: '/legacy/archive' }).directory, '/legacy/archive')
  assert.equal(readConfig(Config({ directory: '/legacy/validated' })).directory, '/legacy/validated', 'schema validation preserves unknown legacy directory internally')
  assert.match(schema.dict.autoCleanup.meta.description, /10 分钟/)
})
