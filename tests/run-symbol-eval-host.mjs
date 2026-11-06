/** Opt-in installed SDK/process/sandbox integration, isolated fixtures only. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createEditTool } from '../lib/tools-edit.js'
import { createFileTool } from '../lib/tools-files.js'
// host.ts is intentionally not a build entry; source boundary uses the same SDK definition contract.
import { defineForgeTool } from '../src/host.ts'
const modules = process.env.DSH_FORGE_DSH_MODULES
if (!modules) { console.log('installed host evaluation SKIPPED: set DSH_FORGE_DSH_MODULES'); process.exit(0) }
const load = (pkg, file = 'index') => import(pathToFileURL(path.join(modules, pkg, 'lib', `${file}.js`)))
const { Context } = await load('cordis')
const { LocalSubprocessRuntime } = await load('dsh-subprocess-local')
const { LocalSandboxProvider } = await load('dsh-sandbox-local')
const { ToolExecutionPipeline } = await load('dsh-tools', 'pipeline')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-installed-eval-')), workspace = path.join(root, 'work')
fs.mkdirSync(workspace)
const ctx = new Context()
const subFork = ctx.plugin(LocalSubprocessRuntime)
const sandboxFork = ctx.plugin(LocalSandboxProvider, {})
await new Promise(resolve => setImmediate(resolve))
assert.ok(ctx.get('subprocess')); assert.ok(ctx.get('sandbox'))
let mode = 'danger-full-access'
const services = { get: name => name === 'sandboxPolicy' ? { resolve: () => ({ mode, workspaceRoot: workspace }) } : ctx.get(name) }
const factory = createEditTool({}, services), edit = defineForgeTool(factory), file = defineForgeTool(createFileTool())
const pipeline = Object.create(ToolExecutionPipeline.prototype); pipeline.canonicalResults = new WeakMap(); pipeline.concludingExecutions = new WeakSet()
const exec = { agent: { session: { header: { cwd: workspace, id: 'installed-eval' } } } }
let passed = 0
async function call(tool, args) {
  const context = { ...exec, arguments: args, token: {} }, value = await tool.execute(args, context)
  const native = pipeline.createSuccessResult(context, tool, value), ptc = pipeline.createSuccessResult({ ...context, parent: {} }, tool, value)
  assert.deepEqual(native.value, ptc.value); assert.ok(Buffer.byteLength(JSON.stringify(ptc.value)) <= 12288)
  assert.ok(Buffer.byteLength(native.content.map(c => c.text).join('\n')) <= 12288)
  return ptc.value
}
async function evaluate(sourceSymbol, args = '[]') { return (await call(edit, { action: 'eval', path: 'fixture.mjs', sourceSymbol, args, timeoutMs: 15000 })).evaluation }
async function detail(r, stored = false) {
  if (!stored && r.resultComplete) return r.result
  let text = '', offset = 0
  while (true) { const p = (await call(edit, { action: 'eval', resultId: r.resultId, offset })).evaluation; text += p.text; if (p.complete) return JSON.parse(text); offset = p.nextOffset }
}
try {
  fs.writeFileSync(path.join(workspace, 'fixture.mjs'), "import fs from 'node:fs';\nimport {spawn} from 'node:child_process';\nexport function sum(a,b) { return a+b }\nexport function write(file) { fs.writeFileSync(file,'fixture'); return 'written' }\nexport function hang() { while(true){} }\nexport function descendant(file) { const child=spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore',windowsHide:true}); fs.writeFileSync(file,String(child.pid)); return child.pid }\n")
  const read = await call(file, { action: 'read', files: [{ path: 'fixture.mjs', symbol: 'sum' }, { path: 'fixture.mjs', symbol: 'write' }] }); assert.equal(read.read.complete, true)
  console.log('PASS installed SDK native/PTC batch read'); passed++
  const sum = await evaluate('sum', '[3,4]'); assert.equal(sum.status, 'returned', JSON.stringify(await detail(sum))); assert.equal((await detail(sum)).value.value, 7)
  assert.equal(sum.resultComplete, true); assert.equal(sum.result.value.value, 7)
  assert.deepEqual(await detail(sum, true), sum.result)
  console.log('PASS installed DSH subprocess, packaged worker and native/PTC evaluation'); passed++
  mode = 'read-only'
  const pure = await evaluate('sum', '[1,2]'); assert.equal(pure.status, 'returned', JSON.stringify(await detail(pure)))
  const denied = await evaluate('write', JSON.stringify([path.join(workspace, 'denied.txt')])); assert.equal(denied.status, 'threw', JSON.stringify(await detail(denied))); assert.ok(!fs.existsSync(path.join(workspace, 'denied.txt')))
  console.log('PASS real read-only confinement permits calculation and denies file writes'); passed++
  mode = 'workspace-write'
  const allowed = await evaluate('write', JSON.stringify([path.join(workspace, 'allowed.txt')])); assert.equal(allowed.status, 'returned', JSON.stringify(await detail(allowed)))
  assert.equal(fs.readFileSync(path.join(workspace, 'allowed.txt'), 'utf8'), 'fixture')
  const outside = await evaluate('write', JSON.stringify([path.join(root, 'outside.txt')])); assert.equal(outside.status, 'threw', JSON.stringify(await detail(outside))); assert.ok(!fs.existsSync(path.join(root, 'outside.txt')))
  console.log('PASS real workspace-write confinement permits workspace and denies sibling writes'); passed++
  mode = 'danger-full-access'
  const timeout = (await call(edit, { action: 'eval', path: 'fixture.mjs', sourceSymbol: 'hang', timeoutMs: 1500 })).evaluation
  assert.equal(timeout.status, 'timeout')
  console.log('PASS installed subprocess deadline and settlement'); passed++
  const pidFile = path.join(workspace, 'pid.txt')
  await call(edit, { action: 'eval', path: 'fixture.mjs', sourceSymbol: 'descendant', args: JSON.stringify([pidFile]), timeoutMs: 2500 })
  const pid = Number(fs.readFileSync(pidFile, 'utf8'))
  assert.throws(() => process.kill(pid, 0), /ESRCH/)
  console.log('PASS installed process-tree termination leaves no live child'); passed++
  console.log(`${passed} installed host groups passed`)
} finally {
  factory.dispose(); sandboxFork.dispose(); subFork.dispose()
  await new Promise(resolve => setTimeout(resolve, 100))
  fs.rmSync(root, { recursive: true, force: true })
}
