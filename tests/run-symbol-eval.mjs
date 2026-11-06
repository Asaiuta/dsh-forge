import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEditTool, createHistoryTool } from '../src/tools-edit.ts'
import { defineForgeTool } from '../src/host.ts'
import { testSubprocess } from './lib/eval-subprocess.mjs'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-eval-'))
process.env.DSH_FORGE_DATA_DIR = path.join(root, 'private')
const exec = { agent: { session: { header: { cwd: root, id: 'eval-test' } } } }
const subprocess = testSubprocess()
let mode = 'danger-full-access', sandbox
const services = { get: n => ({ subprocess, sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: root }) }, sandbox })[n] }
const factory = createEditTool({}, services), tool = defineForgeTool(factory)
const runtime = Object.create(ToolRuntime.prototype); runtime.canonicalResults = new WeakMap(); runtime.concludingExecutions = new WeakSet()
const put = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text) }
let passed = 0, calls = 0
async function test(name, fn) { await fn(); console.log('PASS', name); passed++ }
async function call(input, context = exec) {
  calls++
  const args = { action: 'eval', ...input }, c = { ...context, arguments: args, parent: {}, token: {} }
  const value = await tool.execute(args, c), result = runtime.createSuccessResult(c, tool, value)
  assert.deepEqual(runtime.createSuccessResult({ ...c, parent: undefined }, tool, value).value, result.value)
  assert.ok(Buffer.byteLength(JSON.stringify(result.value)) <= 12288)
  assert.ok(Buffer.byteLength(result.content.map(c => c.text).join('\n')) <= 12288)
  return result.value.evaluation
}
async function details(result, stored = false) {
  if (!stored && result.resultComplete) return result.result
  let text = '', offset = 0
  while (true) { const page = await call({ resultId: result.resultId, offset }); assert.equal(page.offset, text.length); text += page.text; if (page.complete) break; offset = page.nextOffset }
  return JSON.parse(text)
}
try {
  put('functions.mjs', `export function add(a,b) { return a+b }\nexport const box = { base: 4, plus(n) { return this.base+n } };\nexport async function later(n) { return await Promise.resolve(n*2) }\nexport function typed() { return { big: 10n, missing: undefined, n: NaN, zero: -0, holes: [,3] } }\nexport function throws() { throw new Error('expected failure') }\nexport function cyclic() { const x={}; x.self=x; return x }\nexport function large() { return '中😀'.repeat(20000) }\nexport function logs() { console.log('x'.repeat(1200000)); return 1 }\nexport function hang() { while(true){} }\nexport function exits() { process.exit(0) }\nfunction hidden() { return 1 }\n`)
  await test('ESM call, object this and async setup produce returned, never passed', async () => {
    for (const [symbol, input, expected] of [['add', { args: '[2,3]' }, 5], ['box.plus', { args: '[3]' }, 7], ['later', { setup: 'return [6]' }, 12]]) {
      const start = calls, launched = subprocess.launches
      const r = await call({ path: 'functions.mjs', sourceSymbol: symbol, ...input }); assert.equal(r.status, 'returned', JSON.stringify(await details(r))); assert.equal((await details(r)).value.value, expected)
      assert.equal(r.resultComplete, true); assert.equal(r.evidenceComplete, true); assert.equal(calls, start + 1)
      assert.equal(r.result.stdout, ''); assert.equal(r.result.stderr, '')
      assert.deepEqual(await details(r, true), r.result, 'inline record equals the full stored evidence')
      assert.equal(subprocess.launches, launched + 1, 'evidence lookup must not re-execute')
    }
    const before = (await createHistoryTool().execute({}, exec)).items.length
    await call({ path: 'functions.mjs', sourceSymbol: 'add' }); assert.equal((await createHistoryTool().execute({}, exec)).items.length, before)
  })
  await test('tagged results, lossless evidence pagination, and session isolation', async () => {
    const typed = await details(await call({ path: 'functions.mjs', sourceSymbol: 'typed' }))
    assert.equal(typed.value.entries.find(([k]) => k === 'big')[1].value, '10'); assert.equal(typed.value.entries.find(([k]) => k === 'missing')[1].type, 'undefined')
    const large = await call({ path: 'functions.mjs', sourceSymbol: 'large' }); assert.equal(large.resultComplete, false); assert.equal(large.evidenceComplete, true)
    assert.equal((await details(large)).value.value, '中😀'.repeat(20000))
    await assert.rejects(call({ resultId: large.resultId }, { agent: { session: { header: { cwd: root, id: 'other' } } } }), /unknown\/expired/)
  })
  await test('exceptions, cycles, unexported targets, process exit and deadline stay distinct', async () => {
    for (const [symbol, status] of [['throws', 'threw'], ['cyclic', 'unserializable'], ['hidden', 'threw'], ['exits', 'process_failed']]) assert.equal((await call({ path: 'functions.mjs', sourceSymbol: symbol })).status, status)
    const r = await call({ path: 'functions.mjs', sourceSymbol: 'hang', timeoutMs: 200 }); assert.equal(r.status, 'timeout'); assert.equal(r.evidenceComplete, false); assert.equal(r.resultComplete, true)
    const logs = await call({ path: 'functions.mjs', sourceSymbol: 'logs' }); assert.equal(logs.status, 'returned'); assert.equal(logs.evidenceComplete, false)
  })
  await test('small structured results remain inline near the content limit and large ones page', async () => {
    put('sized.mjs', 'export function sized(n) { return "x".repeat(n) }\n')
    for (const [size, inline] of [[6500, true], [9000, false]]) {
      const start = subprocess.launches
      const r = await call({ path: 'sized.mjs', sourceSymbol: 'sized', args: JSON.stringify([size]) })
      assert.equal(r.resultComplete, inline); assert.equal((await details(r)).value.value, 'x'.repeat(size))
      assert.equal(subprocess.launches, start + 1)
    }
  })
  await test('CJS named exports execute in their original module scope', async () => {
    put('common.cjs', 'const base=9;\nfunction add(x) { return base+x }\nmodule.exports={add};\n')
    const r = await call({ path: 'common.cjs', sourceSymbol: 'add', args: '[1]' }); assert.equal(r.status, 'returned', JSON.stringify(await details(r))); assert.equal((await details(r)).value.value, 10)
  })
  await test('runtime identity checks reject reassigned exports and source drift', async () => {
    put('replaced.mjs', 'export function target() { return 1 }\ntarget = function other() { return 2 };\n')
    const replaced = await call({ path: 'replaced.mjs', sourceSymbol: 'target' }); assert.equal(replaced.status, 'threw'); assert.match((await details(replaced)).message, /does not match/)
    put('drift.mjs', "import fs from 'node:fs';\nexport function change() { fs.appendFileSync(new URL(import.meta.url), '\\n// changed'); return 1 }\n")
    assert.equal((await call({ path: 'drift.mjs', sourceSymbol: 'change' })).status, 'source_changed')
    put('broken.mjs', 'export function nope( {')
    await assert.rejects(call({ path: 'broken.mjs', sourceSymbol: 'nope' }), /syntax errors/)
    const start = subprocess.launches
    await assert.rejects(call({ path: 'functions.mjs', sourceSymbol: 'add', args: '[]', setup: 'return []' }), /cannot accompany/)
    await assert.rejects(call({ path: 'functions.mjs', sourceSymbol: 'add', steps: [{ start: 1, text: '' }] }), /unrelated/)
    assert.equal(subprocess.launches, start)
  })
  await test('Python package imports, kwargs, async setup and tuple results', async () => {
    put('pkg/__init__.py', ''); put('pkg/base.py', 'BASE=7\n')
    put('pkg/target.py', 'from .base import BASE\ndef add(x, *, y=0):\n    return x+y+BASE\nasync def pair(x):\n    return (x, BASE)\n')
    const r = await call({ path: 'pkg/target.py', sourceSymbol: 'add', args: '[2]', kwargs: '{"y":3}' }); assert.equal(r.status, 'returned', JSON.stringify(await details(r))); assert.equal((await details(r)).value.value, '12')
    const p = await details(await call({ path: 'pkg/target.py', sourceSymbol: 'pair', setup: 'return [4]' })); assert.equal(p.status, 'returned', JSON.stringify(p)); assert.equal(p.value.type, 'tuple')
    assert.ok(!fs.existsSync(path.join(root, 'pkg', '__pycache__')))
  })
  await test('missing confinement, policy denial and scoped service loss never spawn', async () => {
    const start = subprocess.launches; mode = 'read-only'
    await assert.rejects(call({ path: 'functions.mjs', sourceSymbol: 'add' }), /confinement/); assert.equal(subprocess.launches, start)
    sandbox = { confine: async () => { throw new Error('policy denied') } }
    const denied = await call({ path: 'functions.mjs', sourceSymbol: 'add' }); assert.equal(denied.status, 'process_failed'); assert.match((await details(denied)).message, /policy denied/); assert.equal(subprocess.launches, start)
    mode = 'danger-full-access'
    await assert.rejects(call({ path: 'functions.mjs', sourceSymbol: 'add' }, { agent: { ...exec.agent, ctx: { get: () => undefined } } }), /requires host/)
  })
  await test('cancel and plugin disposal settle running evaluations', async () => {
    const controller = new AbortController(), pending = call({ path: 'functions.mjs', sourceSymbol: 'hang' }, { ...exec, signal: controller.signal }); setTimeout(() => controller.abort(), 100)
    await assert.rejects(pending)
    const other = createEditTool({}, services), task = other.execute({ action: 'eval', path: 'functions.mjs', sourceSymbol: 'hang' }, exec); setTimeout(() => other.dispose(), 100); await assert.rejects(task)
  })
  await test('Rust executes exactly one existing offline test; ignored/zero/failure never pass', async () => {
    put('Cargo.toml', '[package]\nname="forge_eval_fixture"\nversion="0.1.0"\nedition="2021"\n[workspace]\n')
    put('src/lib.rs', '#[cfg(test)]\nmod tests {\n #[test]\n fn good() { assert_eq!(2+2,4); }\n #[test]\n fn bad() { assert_eq!(2+2,5); }\n #[test]\n #[ignore]\n fn ignored() {}\n fn ordinary() {}\n}\n')
    for (const [symbol, expected] of [['tests::good', 'passed'], ['tests::bad', 'failed'], ['tests::ignored', 'not_executed'], ['tests::ordinary', 'not_executed']]) {
      const r = await call({ path: 'src/lib.rs', sourceSymbol: symbol, timeoutMs: 60000 }); assert.equal(r.status, expected, JSON.stringify(await details(r)))
    }
  })
  console.log(`${passed} symbol-eval groups passed (local test subprocess adapter)`)
} finally { factory.dispose(); fs.rmSync(root, { recursive: true, force: true }) }
