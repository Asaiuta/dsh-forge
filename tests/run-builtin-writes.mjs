/** Installed SDK registry and native filesystem; isolated fixtures, no model calls. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as forgePlugin from '../lib/index.js'
import { installBuiltinWrites } from '../src/builtin-writes.ts'
import { getEncoding } from 'js-tiktoken'
const modules = process.env.DSH_FORGE_DSH_MODULES
assert.ok(modules, 'set DSH_FORGE_DSH_MODULES to the extracted installed SDK; this acceptance must not skip')
const load = (pkg, name = 'index') => import(pathToFileURL(path.join(modules, pkg, 'lib', name + '.js')))
const { Context } = await load('cordis')
const { ToolsService, defineTool, projectToolSchema } = await load('dsh-tools')
const { ToolExecutionPipeline } = await load('dsh-tools', 'pipeline')
const { createScope, scopeTarget, scopeOf, bindScopeParent } = await load('dsh-scope')
const { SandboxedFileSystem } = await load('dsh-fs-sandbox')
const builtin = await load('dsh-tool-fs')
const { renderToolsSdk, renderToolsSdkPy } = await load('dsh-tool-executor-ptc')
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-builtin-writes-'))
const workspace = path.join(base, 'work'); fs.mkdirSync(workspace)
const previousData = process.env.DSH_FORGE_DATA_DIR
process.env.DSH_FORGE_DATA_DIR = path.join(base, 'data')
const provider = Object.create(SandboxedFileSystem.prototype)
provider.config = { cwd: workspace, diffBasisMaxBytes: 10 * 1024 * 1024 }
provider.locks = new Map(); provider.internals = {}; provider.defaultMode = 'danger-full-access'
const policy = { resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: workspace }) }
const ctx = new Context(), agents = [], sections = [], commands = [], forks = [], scopes = []
ctx.provide('systemPrompt', { tools() { return () => {} }, section(s) { sections.push(s); return () => sections.splice(sections.indexOf(s), 1) }, getSectionOrder() { return 100 } })
ctx.provide('fs', provider)
ctx.provide('sandboxPolicy', policy)
ctx.provide('workingDirectory', { get: () => workspace })
ctx.provide('agents', { list: () => agents })
ctx.provide('commands', { register(c) { commands.push(c); return () => commands.splice(commands.indexOf(c), 1) } })
forks.push(ctx.plugin(ToolsService))
await new Promise(resolve => setImmediate(resolve))
const tools = ctx.get('tools')
assert.ok(tools)
const preset = createScope(ctx, { preset: 'standard' }); scopes.push(preset)
forks.push(preset.ctx.plugin(builtin, { readImage: false }))
await new Promise(resolve => setImmediate(resolve))
const createAgent = (id, mode = 'danger-full-access', parent = preset, fsProvider = provider) => {
  const agent = { session: { header: { cwd: workspace, id }, mode } }
  const scoped = createScope(ctx, agent)
  agent.binding = bindScopeParent(agent, scopeOf(parent.ctx))
  scopes.push(scoped)
  agent.ctx = { get: name => name === 'fs' ? fsProvider : scoped.ctx.get(name) }
  agent.scoped = scoped
  agents.push(agent)
  ctx.emit(scopeTarget(agent, agent), 'agent/created', { agent })
  return agent
}
const a = createAgent('a'), b = createAgent('b', 'workspace-write')
const remote = { ...provider, resolve: provider.resolve, processPath: provider.processPath, processPathFromHostPath: () => undefined, stat: provider.stat }
const c = createAgent('remote', 'danger-full-access', preset, remote)
let plugin = ctx.plugin(forgePlugin, { surface: 'full', hideBuiltinWrites: true }); forks.push(plugin)
await new Promise(resolve => setImmediate(resolve))
let passed = 0
const ok = text => console.log(`ok ${++passed} - ${text}`)
const visible = (agent, name) => tools.view(agent).visible.has(name)
const status = async agent => (await commands.find(c => c.name === 'forge-status').handler({ agent, rawInput: '' })).text
// Real loop claims the inbox before tools.resolve; agent/pre-step is AFTER
// prompt assembly and cannot provide same-request visibility changes.
const event = agent => ctx.emit(scopeTarget(agent, agent), 'agent/inbox/claimed', { agent })
const pipeline = Object.create(ToolExecutionPipeline.prototype)
pipeline.canonicalResults = new WeakMap(); pipeline.concludingExecutions = new WeakSet()
async function call(name, args, agent = a) {
  const def = tools.get(name, agent); assert.ok(def, name)
  const exec = { agent, arguments: args, signal: new AbortController().signal, token: {} }
  const value = await def.execute(args, exec)
  const native = pipeline.createSuccessResult(exec, def, value)
  const ptc = pipeline.createSuccessResult({ ...exec, parent: {} }, def, value)
  assert.deepEqual(native.value, ptc.value)
  assert.ok(Buffer.byteLength(JSON.stringify(ptc.value)) <= 12288)
  assert.ok(Buffer.byteLength(native.content.map(c => c.text).join('\n')) <= 12288)
  return value
}
const put = (file, raw) => fs.writeFileSync(path.join(workspace, file), raw)
const read = file => fs.readFileSync(path.join(workspace, file), 'utf8')
try {
  assert.ok(visible(a, 'ff_edit') && visible(a, 'ff_file') && visible(a, 'read'), JSON.stringify({ visible: [...tools.view(a).visible.keys()], commands: commands.map(c => c.name), forks: forks.map(f => ({ status: f.status, error: String(f.error ?? '') })) }))
  assert.ok(!visible(a, 'edit') && !visible(a, 'write'), await status(a))
  assert.ok(visible(b, 'edit') && visible(b, 'write'))
  assert.ok(visible(c, 'edit') && visible(c, 'write'))
  assert.match(await status(b), /sandbox escalation retained/)
  assert.match(await status(c), /not shared-local/)
  ok('preset-inherited tools hidden only in ready local agent; confined and remote agents retain built-ins')

  const added = createAgent('later')
  assert.ok(!visible(added, 'edit') && !visible(added, 'write'))
  ctx.emit(scopeTarget(added, added), 'agent/disposed', { agent: added })
  agents.splice(agents.indexOf(added), 1)
  assert.ok(visible(added, 'edit') && visible(added, 'write'))
  a.session.mode = 'read-only'; event(a)
  assert.ok(visible(a, 'edit') && visible(a, 'write'))
  a.session.mode = 'danger-full-access'; event(a)
  assert.ok(!visible(a, 'edit') && !visible(a, 'write'))
  ok('new/disposed agents and standing-policy changes reconcile before step admission')

  const own = a.scoped.ctx.get('tools').register(defineTool({ name: 'edit', description: 'own fixture', parameters: {}, output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] }, execute: () => ({}) }))
  assert.ok(visible(a, 'edit')); assert.match(await status(a), /own-scope/)
  own(); assert.ok(!visible(a, 'edit'))
  const shadow = a.scoped.ctx.get('tools').register(defineTool({ name: 'ff_file', description: 'other plugin', parameters: {}, output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] }, execute: () => ({}) }))
  assert.ok(visible(a, 'write')); assert.match(await status(a), /ff_file unavailable/)
  shadow(); assert.ok(!visible(a, 'write'))
  const emptyPreset = createScope(ctx, { preset: 'empty' }); scopes.push(emptyPreset)
  a.binding.rebind(scopeOf(emptyPreset.ctx)); ctx.emit('session/event', a.session, { type: 'agent-preset/selected' })
  assert.ok(!visible(a, 'edit')); assert.match(await status(a), /built-in absent/)
  a.binding.rebind(scopeOf(preset.ctx)); ctx.emit('session/event', a.session, { type: 'agent-preset/selected' })
  assert.ok(!visible(a, 'edit')); assert.match(await status(a), /edit: hidden/)
  ok('own-scope built-ins remain callable; foreign replacement shadows restore the original')

  // The admitted set is intersected with the live registry, so an old PTC plan
  // cannot execute a built-in after its name is hidden.
  a.session.mode = 'workspace-write'; event(a)
  const admitted = await tools.resolve({ agent: a, signal: new AbortController().signal })
  assert.ok(admitted.view(a).has('edit'))
  a.session.mode = 'danger-full-access'; event(a)
  assert.equal(tools.executable('edit', a, admitted), undefined)
  admitted.dispose()
  const defs = tools.definitions(a), outputDefs = defs.map(d => ({ ...projectToolSchema(d, true), output: d.output.schema }))
  const guidance = () => sections.map(s => typeof s.text === 'function' ? s.text({ scope: a }) : s.text).filter(Boolean).join('\n\n')
  const hiddenGuidance = guidance()
  assert.ok(!tools.schemas(a).some(d => ['edit', 'write'].includes(d.name)))
  for (const rendered of [renderToolsSdk(outputDefs), renderToolsSdkPy(outputDefs)]) assert.doesNotMatch(rendered, /(?:function|def) (?:edit|write)\(/)
  for (const section of sections.filter(s => ['tool:edit', 'tool:write'].includes(s.name))) assert.equal(section.text({ scope: a }), '')
  ok('native schemas, PTC TypeScript/Python and built-in guidance disappear; stale admission cannot call hidden tools')

  assert.match(hiddenGuidance, /Symbol known.*ff_file action=read.*symbol:.*no outline first/)
  put('single.js', '/** chosen */\nexport function chosen() { return 1 }\nexport function other() { return 2 }\n')
  const selected = await call('ff_file', { action: 'read', files: [{ path: 'single.js', symbol: 'chosen' }] })
  assert.equal(selected.read.complete, true); assert.equal(selected.read.items.length, 1)
  assert.equal(selected.read.items[0].text, '/** chosen */\nexport function chosen() { return 1 }')
  const original = read('single.js')
  for (const step of [
    { op: 'replace', find: 'return 1', replaceWith: 'return 3' },
    { op: 'replace', find: 'return 1', replaceWith: 'return 3', inline: true },
    { op: 'replace' },
  ]) {
    await assert.rejects(() => call('ff_edit', { path: 'single.js', steps: [step], reason: 'conflicting intent' }), /use \{.*start.*text.*text matching uses.*find.*replaceWith/)
    assert.equal(read('single.js'), original)
  }
  ok('explicit single-symbol read has equal native/PTC values; conflicting edit intents refuse writes with complete repairs')

  put('batch.txt', '\uFEFFfirst\r\nsecond\nthird\r')
  const exactBatch = await call('ff_edit', { path: 'batch.txt', match: 'literal', steps: [
    { find: 'third', replaceWith: 'THIRD' }, { find: 'first', replaceWith: 'FIRST' }, { find: 'second', replaceWith: 'SECOND' },
  ], reason: 'batch exact edits', receipt: 'diff' })
  assert.equal(exactBatch.applied, 3); assert.equal(exactBatch.diff.complete, true)
  assert.equal(read('batch.txt'), '\uFEFFFIRST\r\nSECOND\nTHIRD\r')
  await call('ff_rollback', { batch: exactBatch.batch, dryRun: false, reason: 'restore exact batch' })
  assert.equal(read('batch.txt'), '\uFEFFfirst\r\nsecond\nthird\r')
  ok('three exact replacements commit once with equal native/PTC evidence and byte-exact rollback')

  const raw = '\uFEFFfirst\r\nxx = 1\nxx = 1\rlast'
  put('mixed.txt', raw)
  await assert.rejects(() => call('ff_edit', { path: 'mixed.txt', find: 'xx = 1', replaceWith: 'xx = 2', match: 'literal', reason: 'unique only' }), /occurs 2 times/)
  assert.equal(read('mixed.txt'), raw)
  await assert.rejects(() => call('ff_edit', { path: 'mixed.txt', find: 'first\nxx', replaceWith: 'other', match: 'literal', reason: 'strict EOL' }), /not found/)
  const changed = await call('ff_edit', { path: 'mixed.txt', find: 'xx = 1', replaceWith: '$& xx = 2', match: 'literal', replaceAll: true, receipt: 'diff', reason: 'all literal' })
  assert.equal(read('mixed.txt'), raw.replaceAll('xx = 1', '$$& xx = 2'))
  await call('ff_rollback', { batch: changed.batch, dryRun: false, reason: 'restore raw bytes' })
  assert.equal(read('mixed.txt'), raw)
  await assert.rejects(() => call('ff_edit', { path: 'mixed.txt', find: 'xx', replaceWith: 'xx', match: 'literal', reason: 'no-op' }), /must differ/)
  await assert.rejects(() => call('ff_edit', { path: 'mixed.txt', find: 'xx', replaceWith: 'yy', replaceAll: true, reason: 'missing literal mode' }), /requires match=literal/)
  put('space.txt', 'a  b\r\n')
  await call('ff_edit', { path: 'space.txt', find: '  ', replaceWith: '\t', match: 'literal', reason: 'whitespace is literal' })
  assert.equal(read('space.txt'), 'a\tb\r\n')
  ok('strict replace-all preserves BOM/mixed EOL and literal dollar text; ambiguous/missing/no-op calls do not write; rollback restores bytes')

  const made = await call('ff_file', { action: 'create', path: 'new/deep/file.txt', content: '\uFEFFone\r\ntwo', reason: 'nested create' })
  assert.equal(read('new/deep/file.txt'), '\uFEFFone\r\ntwo')
  await assert.rejects(() => call('ff_file', { action: 'create', path: 'new/deep/file.txt', content: 'replacement', reason: 'requires overwrite' }), /overwrite=true/)
  await call('ff_file', { action: 'create', path: 'new/deep/file.txt', content: '', overwrite: true, reason: 'empty overwrite' })
  assert.equal(read('new/deep/file.txt'), '')
  await call('ff_rollback', { batch: made.batch, dryRun: true, reason: 'preview old create rollback' })
  b.session.mode = 'read-only'
  await assert.rejects(() => call('ff_file', { action: 'create', path: 'denied/deep/file.txt', content: 'no', reason: 'denied' }, b), /read-only/)
  assert.ok(!fs.existsSync(path.join(workspace, 'denied')))
  await assert.rejects(() => call('ff_file', { action: 'create', path: '../outside/file.txt', content: 'no', reason: 'outside' }), /inside the workspace/)
  assert.ok(!fs.existsSync(path.join(base, 'outside')))
  const rejectWrite = ctx.on('fs/write-intent', async () => ({ kind: 'replaceIfVersion', version: 'stale' }))
  await assert.rejects(() => call('ff_file', { action: 'create', path: 'stale/deep/file.txt', content: 'no', reason: 'stale' }), /write-intent refused/)
  rejectWrite(); assert.ok(!fs.existsSync(path.join(workspace, 'stale')))
  ok('nested create and explicit empty overwrite work; policy, workspace and stale-observation denials create no parent directories')

  plugin.dispose(); await new Promise(resolve => setImmediate(resolve))
  assert.ok(visible(a, 'edit') && visible(a, 'write')); assert.ok(!visible(a, 'ff_edit'))
  plugin = ctx.plugin(forgePlugin, { surface: 'retrieval', hideBuiltinWrites: true }); forks.push(plugin)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(visible(a, 'edit') && visible(a, 'write'))
  plugin.dispose(); await new Promise(resolve => setImmediate(resolve))
  plugin = ctx.plugin(forgePlugin, { surface: 'full', hideBuiltinWrites: false }); forks.push(plugin)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(visible(a, 'edit') && visible(a, 'write'))
  ok('unload, retrieval mode and disabled option restore both original definitions')
  const fallback = installBuiltinWrites({ tools: {}, on: () => () => {} }, { surface: 'full', hideBuiltinWrites: true }, new Map())
  assert.match(fallback.status(a), /restriction API unavailable/)
  assert.ok(visible(a, 'edit') && visible(a, 'write')); fallback.dispose()
  ok('hosts without a scoped restriction API retain built-ins and report the limitation')

  // Compare complete current surfaces, including new Forge parameters/guidance.
  const all = tools.definitions(a)
  const tokenizer = getEncoding('o200k_base')
  const metrics = (defs, guidance) => {
    const schemas = defs.map(d => projectToolSchema(d, true)), output = defs.map((d, i) => ({ ...schemas[i], output: d.output.schema }))
    return Object.fromEntries(Object.entries({ native: JSON.stringify(schemas), ptcTypescript: renderToolsSdk(output), ptcPython: renderToolsSdkPy(output), guidance }).map(([k, v]) => [k, { bytes: Buffer.byteLength(v), tokens: tokenizer.encode(v).length }]))
  }
  const measurement = { tokenizer: 'o200k_base', modelCalls: 0, sdk: modules, config: { surface: 'full' }, visible: { before: all.map(d => d.name), after: defs.map(d => d.name) }, off: metrics(all, guidance()), on: metrics(defs, hiddenGuidance) }
  if (process.env.DSH_FORGE_ACCEPTANCE_DIR) {
    fs.mkdirSync(process.env.DSH_FORGE_ACCEPTANCE_DIR, { recursive: true })
    fs.writeFileSync(path.join(process.env.DSH_FORGE_ACCEPTANCE_DIR, 'measurement.json'), JSON.stringify(measurement, null, 2))
  }
  console.log(JSON.stringify(measurement))
  console.log(`${passed} installed SDK acceptance groups passed`)
} finally {
  for (const fork of forks.reverse()) fork.dispose()
  for (const scope of scopes.reverse()) await scope.dispose()
  if (previousData === undefined) delete process.env.DSH_FORGE_DATA_DIR; else process.env.DSH_FORGE_DATA_DIR = previousData
  fs.rmSync(base, { recursive: true, force: true })
}
