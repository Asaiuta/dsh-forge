import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFileTool } from '../src/tools-files.ts'
import { defineForgeTool } from '../src/host.ts'
import { createExecutionGuard } from '../src/execution.ts'
import { jsonBytes } from '../src/output-budget.ts'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-batch-read-'))
const exec = { agent: { session: { header: { cwd: root, id: 'reader' } } } }
const observed = []
const provider = { resolve: async p => ({ targetKey: p, displayPath: p }), processPath: t => t.displayPath, processPathFromHostPath: p => p,
  stat: async t => { const s = fs.statSync(t.displayPath); return { type: 'file', size: s.size, version: `${s.mtimeMs}/${s.size}` } } }
const guard = createExecutionGuard(provider, { emit: (_, t) => observed.push(t.displayPath) })
const factory = createFileTool(), tool = defineForgeTool(factory, guard)
const runtime = Object.create(ToolRuntime.prototype); runtime.canonicalResults = new WeakMap(); runtime.concludingExecutions = new WeakSet()
const put = (f, text) => fs.writeFileSync(path.join(root, f), text)
let passed = 0
async function test(name, fn) { await fn(); console.log('PASS', name); passed++ }
async function read(args, context = exec) {
  const input = { action: 'read', ...args }, call = { ...context, arguments: input, parent: {}, token: {} }
  const value = await tool.execute(input, call), result = runtime.createSuccessResult(call, tool, value)
  assert.ok(jsonBytes(result.value) <= 12288)
  assert.ok(Buffer.byteLength(result.content.map(c => c.text).join('\n')) <= 12288)
  return result.value.read
}
try {
  put('a.js', '/** one */\r\nexport function one() { return 1 }\r\nexport const box = { two() { return 2 } };\r\n')
  put('a#b.txt', 'first\nsecond\nthird\n')
  await test('a single explicit symbol selects only that definition through native and PTC output', async () => {
    const input = { action: 'read', files: [{ path: 'a.js', symbol: 'one' }] }
    const call = { ...exec, arguments: input, token: {} }
    const value = await tool.execute(input, call)
    const native = runtime.createSuccessResult(call, tool, value)
    const ptc = runtime.createSuccessResult({ ...call, parent: {} }, tool, value)
    assert.deepEqual(native.value, ptc.value)
    const page = native.value.read
    assert.equal(page.complete, true); assert.equal(page.total, 1); assert.equal(page.items.length, 1)
    assert.equal(page.items[0].text, '/** one */\nexport function one() { return 1 }')
    assert.equal(page.items[0].startLine, 1); assert.equal(page.items[0].endLine, 2)
    assert.ok(page.items[0].snapshot); assert.ok(observed.includes(path.join(root, 'a.js')))
  })
  await test('one SDK/PTC value reads several files, exact symbols, ranges and literal # names', async () => {
    const result = await read({ files: [{ path: 'a.js', symbol: 'one' }, { path: 'a#b.txt', startLine: 2, endLine: 2 }, { path: 'a.js', symbol: 'box.two' }] })
    assert.equal(result.complete, true); assert.equal(result.items.length, 3)
    assert.match(result.items[0].text, /^\/\*\* one/); assert.equal(result.items[1].text, 'second'); assert.match(result.items[2].text, /two\(\)/)
    assert.ok(observed.includes(path.join(root, 'a.js')) && observed.includes(path.join(root, 'a#b.txt')))
  })
  await test('all pages reconstruct Unicode, escaping and very long lines exactly', async () => {
    const content = ('中😀"\\\t').repeat(12000) + '\nlast\n'
    put('long.txt', content)
    let p = await read({ files: [{ path: 'long.txt' }, { path: 'a#b.txt' }] }), chunks = ['', ''], pages = 0
    while (true) {
      pages++; for (const item of p.items) { assert.equal(item.offset, chunks[item.index].length); assert.ok(item.text.isWellFormed()); chunks[item.index] += item.text }
      if (p.complete) break
      p = await read({ cursor: p.nextCursor })
    }
    assert.equal(chunks[0], content); assert.equal(chunks[1], 'first\nsecond\nthird\n'); assert.ok(pages > 2)
  })
  await test('any file drift invalidates the batch cursor; other sessions cannot replay it', async () => {
    const p = await read({ files: [{ path: 'long.txt' }, { path: 'a#b.txt' }] })
    await assert.rejects(read({ cursor: p.nextCursor }, { agent: { session: { header: { cwd: root, id: 'other' } } } }), /unknown\/expired/)
    put('a#b.txt', 'changed')
    await assert.rejects(read({ cursor: p.nextCursor }), /snapshot changed/)
  })
  await test('selection errors, mixed actions, binary input and large files are explicit', async () => {
    put('binary', Buffer.from([0, 1, 2])); put('big', Buffer.alloc(2 * 1024 * 1024 + 1, 65)); put('bad', Buffer.from([0xff]))
    for (const files of [[{ path: 'binary' }], [{ path: 'big' }], [{ path: 'bad' }], [{ path: 'missing' }], [{ path: 'a.js', symbol: 'one', startLine: 1 }], [{ path: 'a.js', startLine: 100 }], Array(21).fill({ path: 'a.js' })]) await assert.rejects(read({ files }))
    await assert.rejects(read({ files: [{ path: 'a.js' }], reason: 'not a write' }), /files or cursor/)
  })
  await test('scoped filesystem denial never falls back to the host filesystem', async () => {
    const denied = { ...exec.agent, ctx: { get: name => name === 'fs' ? { ...provider, resolve: async () => { throw new Error('scope denied') } } : undefined } }
    await assert.rejects(read({ files: [{ path: 'a.js' }] }, { agent: denied }), /scope denied/)
  })
  console.log(`${passed} batch-read groups passed`)
} finally { fs.rmSync(root, { recursive: true, force: true }) }
