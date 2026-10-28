/** Coverage, incremental invalidation and shared-cancellation contracts for Trace. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assembleTraceGraph, createTraceTool, resetTraceFactsCache } from '../lib/tools-trace.js'
import { extractTraceFile } from '../lib/trace-facts.js'
import { AstWorkerPool } from '../lib/ast-pool.js'
import { sameGraphExceptSnapshot } from './lib/snapshot-compare.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-cache-'))
const previousWorkers = process.env.DSH_FORGE_AST_WORKERS
const previousNative = process.env.DSH_FORGE_TRACE_NATIVE
let passed = 0
const ok = label => console.log(`ok ${++passed} - ${label}`)
const write = (name, content) => fs.writeFileSync(path.join(root, name), content)
const clear = () => resetTraceFactsCache()
const pool = new AstWorkerPool()
try {
  process.env.DSH_FORGE_AST_WORKERS = '0'
  write('main.js', "ipcMain.handle('cache:one', () => {}); require('./asset.json')\n")
  const first = await assembleTraceGraph(root)
  const warm = await assembleTraceGraph(root)
  assert.equal(first.graph, warm.graph, 'unchanged workspace should reuse its graph')
  write('asset.json', '{}')
  const asset = await assembleTraceGraph(root)
  assert.notEqual(asset.graph, warm.graph)
  assert.ok(asset.graph.deps.get('main.js').some(edge => edge.to === 'asset.json'))
  fs.unlinkSync(path.join(root, 'asset.json'))
  const removedAsset = await assembleTraceGraph(root)
  assert.ok(!removedAsset.graph.deps.get('main.js').some(edge => edge.to === 'asset.json'))
  ok('warm graph reuse revalidates missing and non-source dependency probes')

  // The same dependency coming back under a different case. `scan.signature`
  // cannot see it (a `.json` is not a candidate, so no stamp changed), and an
  // exact-name listing lookup misses because the directory holds `Asset.json`
  // while the probe remembers `asset.json`. Only the case-folded index can
  // notice, and it may only answer "check exactly" — never "still absent".
  write('Asset.json', '{}')
  const recased = await assembleTraceGraph(root)
  assert.notEqual(recased.graph, removedAsset.graph, 'a case-only dependency must not be reused')
  assert.ok(recased.graph.deps.get('main.js').some(edge => edge.to.toLowerCase() === 'asset.json'))
  fs.unlinkSync(path.join(root, 'Asset.json'))
  ok('a dependency that returns under another case invalidates the graph')

  const stat = fs.statSync(path.join(root, 'main.js'))
  write('main.js', "ipcMain.handle('cache:two', () => {}); require('./asset.json')\n")
  fs.utimesSync(path.join(root, 'main.js'), stat.atime, stat.mtime)
  const changed = await assembleTraceGraph(root)
  assert.ok(changed.graph.registers.has('cache:two'))
  assert.ok(!changed.graph.registers.has('cache:one'))
  write('added.ts', "ipcMain.handle('cache:new', () => {})\n")
  assert.ok((await assembleTraceGraph(root)).graph.registers.has('cache:new'))
  fs.unlinkSync(path.join(root, 'added.ts'))
  assert.ok(!(await assembleTraceGraph(root)).graph.registers.has('cache:new'))
  ok('same-size edits with restored mtime, additions and deletions invalidate facts')

  write('alias.js', 'const api = window.bridgeA\n')
  write('caller.js', 'api.read(); other.read()\n')
  write('index.html', '<script src="alias.js"></script><script src="caller.js"></script>')
  const decls = global => JSON.stringify({ apis: [{ name: 'read', channel: 'cache:two', kind: 'query', roles: ['page'] }], roleGlobals: { page: global } })
  write('decls.json', decls('bridgeA'))
  const aliased = await assembleTraceGraph(root, { declarations: 'decls.json' })
  assert.equal(aliased.graph.bridgeRefs.get('read').length, 1)
  assert.equal(aliased.graph.bridgeRefs.get('read')[0].path, 'caller.js')
  write('alias.js', 'const other = window.bridgeB\n')
  write('decls.json', decls('bridgeB'))
  const reAliased = await assembleTraceGraph(root, { declarations: 'decls.json' })
  assert.equal(reAliased.graph.bridgeRefs.get('read').length, 1)
  assert.equal(reAliased.graph.bridgeRefs.get('read')[0].alias, 'other')
  ok('alias and declaration changes refresh bridge classification without phantom refs')

  write('large.js', "ipcMain.handle('cache:hidden', () => {});" + ' '.repeat(2 * 1024 * 1024))
  write('broken.js', 'function broken( {')
  const exec = { agent: { session: { header: { cwd: root } } } }
  const coverage = await createTraceTool().execute({ target: 'ipc:cache:hidden' }, exec)
  assert.equal(coverage.found, false)
  assert.equal(coverage.parseErrors, 1)
  assert.ok(coverage.partialFiles >= 1)
  assert.equal(coverage.incomplete, true)
  // The incomplete-analysis notice is one "限制" line now; what it must still
  // carry is the promise that "not found" is scoped to what was analysed.
  assert.match(coverage.text, /限制[\s\S]*已分析范围/)
  const nonDirectory = await assembleTraceGraph(path.join(root, 'main.js'))
  assert.equal(nonDirectory.walkErrors, 1)
  fs.unlinkSync(path.join(root, 'large.js'))
  fs.unlinkSync(path.join(root, 'broken.js'))
  ok('skipped, partial and unreadable scans are visible alongside negative answers')

  clear()
  const sequential = await assembleTraceGraph(root, { declarations: 'decls.json' })
  clear()
  process.env.DSH_FORGE_AST_WORKERS = '2'
  const parallel = await assembleTraceGraph(root, { declarations: 'decls.json', workers: pool })
  sameGraphExceptSnapshot(parallel, sequential, 'parallel vs sequential')
  ok('parallel and sequential pipelines produce the same complete graph')

  const rootOne = path.join(root, 'root-one'), rootTwo = path.join(root, 'root-two'), rootAlias = path.join(root, 'root-alias')
  fs.mkdirSync(rootOne); fs.mkdirSync(rootTwo)
  write('shared.js', 'export const shared = 1\n')
  fs.linkSync(path.join(root, 'shared.js'), path.join(rootOne, 'main.js'))
  fs.linkSync(path.join(root, 'shared.js'), path.join(rootTwo, 'main.js'))
  const stamp = directory => { const stat = fs.statSync(path.join(directory, 'main.js')); return [stat.mtimeMs, stat.size, stat.ctimeMs] }
  assert.deepEqual(stamp(rootOne), stamp(rootTwo), 'hard links make the source signatures exactly equal')
  fs.symlinkSync(rootOne, rootAlias, process.platform === 'win32' ? 'junction' : 'dir')
  const firstRoot = await assembleTraceGraph(rootAlias, { workers: pool })
  assert.ok(fs.lstatSync(rootAlias).isSymbolicLink() && path.dirname(path.resolve(rootAlias)) === root)
  fs.rmSync(rootAlias, { recursive: true, force: true })
  fs.symlinkSync(rootTwo, rootAlias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.notEqual((await assembleTraceGraph(rootAlias, { workers: pool })).graph, firstRoot.graph)
  ok('root link retargets invalidate the graph even when every source stat signature is identical')

  // The remaining groups pin the WASM worker-pool cancellation contract; the
  // native sidecar would extract these sources without consulting the pool.
  process.env.DSH_FORGE_TRACE_NATIVE = '0'
  clear()
  const otherPool = new AstWorkerPool()
  const originalFacts = pool.facts.bind(pool)
  const otherFacts = otherPool.facts.bind(otherPool)
  let startedA, startedB
  const bothStarted = Promise.all([
    new Promise(resolve => { startedA = resolve }),
    new Promise(resolve => { startedB = resolve }),
  ])
  otherPool.facts = (...args) => { startedA(); return otherFacts(...args) }
  pool.facts = (...args) => { startedB(); return originalFacts(...args) }
  try {
    const owner = new AbortController()
    const owned = assembleTraceGraph(root, { signal: owner.signal, workers: otherPool })
    const independent = assembleTraceGraph(root, { workers: pool })
    const ownerRejected = assert.rejects(owned, /owner-disposed/)
    await bothStarted
    owner.abort(new Error('owner-disposed'))
    await otherPool.dispose()
    await ownerRejected
    assert.ok((await independent).graph.registers.has('cache:two'))
  } finally {
    pool.facts = originalFacts
    await otherPool.dispose()
  }
  ok('separate plugin pools own their inflight work and survive another pool disposal')

  clear()
  let begin, release
  const started = new Promise(resolve => { begin = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let batches = 0, sharedSignal
  const delayed = { async facts(files, signal) {
    batches++
    sharedSignal = signal
    begin()
    await gate
    signal.throwIfAborted()
    return Promise.all(files.map(item => extractTraceFile(item.file)))
  } }
  const aborter = new AbortController()
  const cancelled = assembleTraceGraph(root, { signal: aborter.signal, workers: delayed })
  const survivor = assembleTraceGraph(root, { workers: delayed })
  const rejection = assert.rejects(cancelled, /cancel-one/)
  await started
  aborter.abort(new Error('cancel-one'))
  await rejection
  assert.equal(sharedSignal.aborted, false)
  release()
  assert.ok((await survivor).graph.registers.has('cache:two'))
  assert.equal(batches, 1)
  ok('overlapping scans share work; cancelling one caller preserves the other')

  clear()
  let onStart, acknowledge, sawAbort
  let acknowledged = false
  const allStarted = new Promise(resolve => { onStart = resolve })
  const aborted = new Promise(resolve => { sawAbort = resolve })
  const acknowledgement = new Promise(resolve => { acknowledge = resolve })
  const cancellable = { async facts(_files, signal) {
    onStart()
    await new Promise(resolve => signal.addEventListener('abort', () => { sawAbort(); resolve() }, { once: true }))
    await acknowledgement
    acknowledged = true
    throw signal.reason
  } }
  const last = new AbortController()
  const only = assembleTraceGraph(root, { signal: last.signal, workers: cancellable })
  const lastRejection = assert.rejects(only, cause => {
    assert.equal(acknowledged, true, 'last caller must wait for worker acknowledgement')
    return /cancel-last/.test(cause.message)
  })
  await allStarted
  last.abort(new Error('cancel-last'))
  await aborted
  await new Promise(resolve => setImmediate(resolve))
  acknowledge()
  await lastRejection
  const retry = await assembleTraceGraph(root, { workers: pool })
  assert.ok(retry.graph.registers.has('cache:two'))
  ok('last-caller cancellation stops shared work and a fresh request can retry')
} finally {
  await pool.dispose()
  if (previousWorkers === undefined) delete process.env.DSH_FORGE_AST_WORKERS
  else process.env.DSH_FORGE_AST_WORKERS = previousWorkers
  if (previousNative === undefined) delete process.env.DSH_FORGE_TRACE_NATIVE
  else process.env.DSH_FORGE_TRACE_NATIVE = previousNative
  const intendedParent = path.resolve(os.tmpdir()) + path.sep
  assert.ok(path.resolve(root).startsWith(intendedParent) && path.basename(root).startsWith('forge-trace-cache-'))
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
console.log(`${passed} Trace cache and coverage groups passed`)
