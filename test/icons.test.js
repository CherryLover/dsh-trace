import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Inspect a VM-only copy without exposing implementation helpers in production.
function client(initialStates = []) {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let factory, cursor = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => [cursor < initialStates.length ? initialStates[cursor++] : (cursor++, initial), () => {}],
    useEffect() {}, useRef: value => ({ current: value }), useId: () => 'icons-test', Fragment: 'fragment',
  }
  const instrumented = source
    .replace('    return {\n      inject:', '    return { testHelpers: { iconPaths, statusIcon, settingIcons, icon, css, extraCss },\n      inject:')
    .replace('        function Trace(props)', '        ctx.testComponents = { Attempt, TraceSettings }; function Trace(props)')
  assert.notEqual(instrumented, source, 'VM instrumentation must match the client module')
  vm.runInNewContext(instrumented, { window: { __ModuleLoader__: { load: value => { factory = value.factory } } } })
  const plugin = factory(() => React)
  const ctx = { effect() {}, locale: { bind: () => key => key }, slots: { inject() {} } }
  plugin.apply(ctx)
  return { ...plugin.testHelpers, ...ctx.testComponents }
}

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate))
  if (!tree || typeof tree !== 'object') return []
  return [...(predicate(tree) ? [tree] : []), ...tree.children.flatMap(child => nodes(child, predicate))]
}
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree == null || tree === false ? '' : typeof tree === 'object' ? tree.children.map(text).join('') : String(tree)
const svgShape = tree => JSON.stringify(tree.children.map(({ type, props }) => ({ type, props })))

function decorative(svg) {
  assert.equal(svg.type, 'svg')
  assert.equal(svg.props['aria-hidden'], true)
  assert.equal(svg.props.focusable, false)
  assert.equal(svg.props.viewBox, '0 0 24 24')
  assert.equal(svg.props.width, 16)
  assert.equal(svg.props.height, 16)
  assert.equal(svg.props.fill, 'none')
  assert.equal(svg.props.stroke, 'currentColor')
  assert.equal(svg.props.strokeWidth, 2)
  assert.equal(svg.props.strokeLinecap, 'round')
  assert.equal(svg.props.strokeLinejoin, 'round')
  assert.equal(svg.props['aria-label'], undefined)
  assert.equal(nodes(svg, node => node.type === 'title').length, 0)
  assert.ok(svg.children.length > 0)
  for (const child of svg.children) assert.ok(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse'].includes(child.type), child.type)
}

test('all tracing outcomes map to explicit Lucide icons, with informational unknown fallback', () => {
  const { statusIcon, iconPaths, icon } = client()
  const expected = { running: 'running', stop: 'check', 'tool-calls': 'tools', 'max-tokens': 'limit', error: 'error', aborted: 'aborted', interrupted: 'interrupted', unknown: 'info' }
  for (const [status, name] of Object.entries(expected)) {
    assert.equal(statusIcon(status), name, status)
    assert.ok(Object.hasOwn(iconPaths, name), name)
    decorative(icon(statusIcon(status)))
  }
  for (const status of [undefined, null, '', 'future-status']) assert.equal(statusIcon(status), 'info')
  for (const name of ['future-icon', undefined]) assert.equal(svgShape(icon(name)), svgShape(icon('info')))
  assert.notEqual(svgShape(icon('info')), svgShape(icon('error')))
})

test('setting fields use complete semantic icon mapping in the shared decorative SVG family', () => {
  const { settingIcons, iconPaths, icon } = client()
  const expected = { autoCleanup: 'refresh', maxAttempts: 'hash', retentionDays: 'clock', detailBudgetMiB: 'storage', preserveErrors: 'shield' }
  assert.deepEqual({ ...settingIcons }, expected)
  for (const name of Object.values(expected)) {
    assert.ok(Object.hasOwn(iconPaths, name), name)
    decorative(icon(name))
  }
  for (const name of Object.keys(iconPaths)) decorative(icon(name))
})

test('request status SVGs supplement rather than replace readable outcome labels', () => {
  for (const status of ['running', 'stop', 'tool-calls', 'max-tokens', 'error', 'aborted', 'interrupted', 'unknown']) {
    const ui = client()
    const tree = ui.Attempt({ a: { id: 'a', status }, sessionId: 's', clock: 0 })
    const badge = nodes(tree, node => typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes('status'))[0]
    assert.ok(badge, status)
    assert.ok(text(badge).includes(status), status)
    const icons = nodes(badge, node => node.type === 'svg')
    assert.equal(icons.length, 1, status)
    decorative(icons[0])
    assert.equal(svgShape(icons[0]), svgShape(ui.icon(ui.statusIcon(status))), status)
  }
})

test('settings SVGs preserve label/control associations and description accessibility', () => {
  const data = { backend: 'sqlite', databasePath: '/trace/archive.sqlite', settings: { autoCleanup: false, maxAttempts: 100, retentionDays: 7, detailBudgetMiB: 128, preserveErrors: true } }
  const draft = { autoCleanup: false, maxAttempts: '100', retentionDays: '7', detailBudgetMiB: '128', preserveErrors: true }
  const ui = client([{ data, draft, loading: false, saving: false, error: '', saved: false }])
  const tree = ui.TraceSettings()
  for (const [key, name] of Object.entries(ui.settingIcons)) {
    const row = nodes(tree, node => node.props.className === 'settings-field' && node.props.key === key)[0]
    assert.ok(row, key)
    const label = nodes(row, node => node.type === 'label')[0]
    const control = nodes(row, node => node.type === 'input' || node.type === 'select')[0]
    assert.ok(text(label).includes(key), key)
    assert.equal(label.props.htmlFor, control.props.id)
    assert.ok(control.props['aria-describedby'].includes(control.props.id + '-description'))
    const icons = nodes(row, node => node.type === 'svg')
    assert.equal(icons.length, 1, key)
    decorative(icons[0])
    assert.equal(svgShape(icons[0]), svgShape(ui.icon(name)), key)
  }
})

test('status CSS no longer draws competing pseudo-element dots', () => {
  const { css, extraCss } = client()
  assert.doesNotMatch(css + extraCss, /[^{}]*\.status[^{}]*::?before\s*\{/)
})
