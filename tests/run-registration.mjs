import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Context } = require('@deepseek-ai/cordis')
const { apply, Config } = await import('../lib/index.js')
const { resolveConfig } = await import('../lib/config.js')
const { planRegistration } = await import('../lib/registration.js')
const { createGrepTool, createFindTool } = await import('../lib/tools.js')
const { FinderPool } = await import('../lib/core.js')

let passed = 0
const ok = (label) => console.log(`ok ${++passed} - ${label}`)

assert.deepEqual(resolveConfig(), { surface: 'retrieval', hideBuiltinWrites: false })
assert.deepEqual(resolveConfig({}), { surface: 'retrieval', hideBuiltinWrites: false })
assert.deepEqual(resolveConfig({ surface: 'full', hideBuiltinWrites: true }), { surface: 'full', hideBuiltinWrites: true })
assert.throws(() => resolveConfig({ hideBuiltinWrites: 'true' }), /boolean/)
assert.throws(() => resolveConfig('full'), /mapping/)
assert.throws(() => resolveConfig({ surface: 'all' }), /surface/)
for (const config of [{}, { surface: 'retrieval' }, { surface: 'full' }]) {
  assert.equal(Config['~standard'].validate(config).issues, undefined)
}
ok('surface defaults to retrieval and validates retrieval/full')

const rows = [
  { forge: 'ff_find', surface: 'retrieval' },
  { forge: 'ff_grep', surface: 'retrieval' },
  { forge: 'ff_symbols', surface: 'retrieval' },
  { forge: 'ff_edit', surface: 'full' },
  { forge: 'ff_project', surface: 'full' },
]
assert.deepEqual(planRegistration(resolveConfig(), rows).map((row) => row.forge), ['ff_find', 'ff_grep', 'ff_symbols'])
assert.deepEqual(planRegistration(resolveConfig({ surface: 'full' }), rows).map((row) => row.forge), rows.map((row) => row.forge))
ok('retrieval and full register their declared rows')

const pool = new FinderPool()
const grep = createGrepTool(pool)
const find = createFindTool(pool)
assert.ok(!('mode' in grep.parameters) && !('enclosing' in grep.parameters) && !('timeBudgetMs' in grep.parameters))
assert.ok(!('mode' in find.parameters) && !('page' in find.parameters))
pool.disposeAll()
ok('retrieval schemas expose only operations the built-ins cannot express')

async function mount(config) {
  const ctx = new Context()
  const definitions = []
  const sections = []
  const listeners = []
  ctx.provide('tools', {
    register(definition) { definitions.push(definition); return () => {} },
    get(name) { return definitions.find((definition) => definition.name === name) ?? (name === 'read' ? { name } : undefined) },
  })
  ctx.provide('commands', { register() { return () => {} } })
  ctx.provide('fs', { observeNativeRead() {} })
  ctx.provide('systemPrompt', { section(value) { sections.push(value); return () => {} } })
  const on = ctx.on.bind(ctx)
  ctx.on = (event, listener, ...rest) => { listeners.push(event); return on(event, listener, ...rest) }
  const plugin = ctx.plugin(apply, config)
  await new Promise((resolve) => setImmediate(resolve))
  return { definitions, sections, listeners, plugin }
}

{
  const host = await mount(undefined)
  // Wiring remains full-only; the default surface registers exactly three retrieval tools.
  assert.deepEqual(host.definitions.map((definition) => definition.name), ['ff_find', 'ff_grep', 'ff_symbols'])
  assert.deepEqual(host.listeners, ['tools/execute', 'session/event', 'tools/result'])
  assert.deepEqual(host.definitions.find((definition) => definition.name === 'ff_find').parameters.properties, {
    pattern: host.definitions.find((definition) => definition.name === 'ff_find').parameters.properties.pattern,
    path: host.definitions.find((definition) => definition.name === 'ff_find').parameters.properties.path,
    limit: host.definitions.find((definition) => definition.name === 'ff_find').parameters.properties.limit,
  })
  const guidance = host.sections[0].text({})
  assert.ok(guidance.includes('ff_find') && guidance.includes('ff_grep') && guidance.includes('ff_symbols'))
  assert.ok(!/ff_edit|ff_trace|ff_verify|ff_project/.test(guidance), 'full-only tools stay out of the default prompt')
  host.plugin.dispose()
  ok('default mount registers retrieval only and advertises the same surface')
}

{
  const host = await mount({ surface: 'full' })
  const names = host.definitions.map((definition) => definition.name)
  assert.equal(names.length, 9)
  assert.equal(new Set(names).size, 9, 'SDK registration must not duplicate a public tool')
  assert.deepEqual([...names].sort(), ['ff_find', 'ff_grep', 'ff_symbols', 'ff_edit', 'ff_history', 'ff_rollback', 'ff_file', 'ff_trace', 'ff_project'].sort())
  for (const legacy of ['fffind', 'ffgrep', 'ff_read', 'fftrace', 'ffedit', 'ffhistory', 'ffrollback', 'ff_verify', 'ff_eval', 'ff_read_many']) {
    assert.ok(!names.includes(legacy), `retired public name must not be registered: ${legacy}`)
  }
  const grepDef = host.definitions.find((definition) => definition.name === 'ff_grep')
  assert.ok(!('mode' in grepDef.parameters.properties), 'no surface re-introduces plain/regex: the built-in owns them')
  host.plugin.dispose()
  ok('full mount registers all Forge tools, with the same retrieval semantics')
}

console.log(`\n${passed} registration groups passed`)
