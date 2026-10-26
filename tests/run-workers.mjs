/** Parallel discovery parity, freshness, isolated cancellation and pool lifecycle. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { AstWorkerPool, astWorkerCount } from '../lib/ast-pool.js'
import { createReadTool } from '../lib/tools-read.js'
import { definitionsView } from './lib/read-views.mjs'
const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'forge-workers-'))
const workers = new AstWorkerPool(), other = new AstWorkerPool()
const exec = { agent: { session: { header: { cwd: sandbox, id: 'workers' } } } }
let passed = 0
const ok = label => console.log(`ok ${++passed} - ${label}`)
try {
  fs.mkdirSync(path.join(sandbox, 'src'))
  fs.writeFileSync(path.join(sandbox, '.gitignore'), 'ignored.js\n')
  fs.writeFileSync(path.join(sandbox, 'ignored.js'), 'function A() {}\n')
  for (const [name, content] of [['a.js', '/** A */\r\nfunction A() {}\r\n'], ['b.ts', 'class B {\n A() {}\n}\n']]) fs.writeFileSync(path.join(sandbox, 'src', name), content)
  const tool = definitionsView(createReadTool(workers))
  process.env.DSH_FORGE_AST_WORKERS = '0'
  const sequential = await tool.execute({ name: 'A', limit: 200 }, exec)
  process.env.DSH_FORGE_AST_WORKERS = '2'
  const parallel = await tool.execute({ name: 'A', limit: 200 }, exec)
  assert.deepEqual(parallel.items, sequential.items)
  assert.equal(parallel.items.length, 2)
  assert.equal(parallel.truncated, undefined)
  assert.equal((await tool.execute({ name: 'A', glob: '**/*.ts', kind: 'method' }, exec)).items.length, 1)
  ok('parallel results, ranges, comments, order, kind/glob and ignored discovery match sequential truth')
  fs.writeFileSync(path.join(sandbox, 'src/a.js'), '\n\nfunction A() {}\n')
  fs.writeFileSync(path.join(sandbox, 'src/c.js'), 'function A() {}\n')
  const fresh = await tool.execute({ name: 'A' }, exec)
  assert.equal(fresh.items.length, 3)
  assert.equal(fresh.items.find(item => item.file === 'src/a.js').startLine, 3)
  fs.unlinkSync(path.join(sandbox, 'src/c.js'))
  assert.equal((await tool.execute({ name: 'A' }, exec)).items.length, 2)
  ok('hot worker cache rehashes changed bytes and discovery reflects additions and deletions')
  process.env.DSH_FORGE_AST_WORKERS = '1'
  const files = Array.from({ length: 500 }, (_, n) => {
    const file = path.join(sandbox, `cancel-${n}.js`)
    fs.writeFileSync(file, 'function Cancelled() {}\n'); return file
  })
  const abort = new AbortController()
  const cancelled = workers.find(files, 'Cancelled', null, Date.now() + 20000, abort.signal)
  const live = workers.find([files[0]], 'Cancelled', null, Date.now() + 20000)
  abort.abort(new Error('cancel this request'))
  const outcomes = await Promise.allSettled([cancelled, live])
  assert.equal(outcomes[0].status, 'rejected'); assert.match(outcomes[0].reason.message, /cancel this request/)
  assert.equal(outcomes[1].status, 'fulfilled'); assert.equal(outcomes[1].value.results[0].items.length, 1)
  ok('cancelling one shared-worker request leaves an independent concurrent request successful')
  const deadline = await workers.find(files, 'Cancelled', null, Date.now() - 1)
  assert.equal(deadline.timedOut, true); assert.deepEqual(deadline.results, [])
  const preAborted = new AbortController(); preAborted.abort()
  await assert.rejects(workers.find(files, 'Cancelled', null, Date.now() + 10000, preAborted.signal))
  process.env.DSH_FORGE_AST_WORKERS = '9'; assert.throws(astWorkerCount, /integer from 0 to 8/)
  process.env.DSH_FORGE_AST_WORKERS = '1'
  ok('deadline truncation, pre-abort and invalid configuration are explicit')
  const independent = other.find([files[0]], 'Cancelled', null, Date.now() + 20000)
  await workers.dispose()
  assert.equal((await independent).results[0].items.length, 1)
  await assert.rejects(workers.find(files, 'Cancelled', null, Date.now() + 10000), /disposed/)
  ok('disposing one plugin-owned pool leaves the other pool alive and refuses use after disposal')
  console.log(`${passed} worker groups passed`)
} finally {
  await Promise.all([workers.dispose(), other.dispose()])
  fs.rmSync(sandbox, { recursive: true, force: true })
}
