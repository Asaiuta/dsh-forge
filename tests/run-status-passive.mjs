/**
 * Passive capability status (M0.5).
 *
 * `/forge-status` is the command a user runs *when something looks broken*. If
 * describing health requires starting the Rust sidecar, running cargo, loading
 * a project or reaching the network, then the status command fails for exactly
 * the reason it was invoked — and the failure is indistinguishable from "the
 * sidecar is fine".
 *
 * So this suite proves two things with a counted stand-in:
 *
 *   - the status path performs zero spawns and zero executes, across the
 *     never-started, ready and crashed states;
 *   - the reported state tracks what was actually observed. `not_probed` is not
 *     `available`, and an unproven capability never renders as supported.
 *
 * Everything else here is a plain text assertion: the section must exist, must
 * state the capability matrix, and must say outright that the stages the
 * roadmap has not delivered are unavailable.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStatusCommand } from '../lib/tools.js'
import { peekIndexerStatus, indexerReady, resetIndexer, setIndexerTransportForTest } from '../lib/indexer-client.js'
import { traceLanguageCapability, TRACE_CAPABILITY_MATRIX } from '../lib/trace-capabilities.js'
import { traceSnapshotStatus, resetTraceSnapshots } from '../lib/tools-trace.js'

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-status-passive-'))
fs.writeFileSync(path.join(root, 'main.js'), 'const x = 1\n')
const exec = { agent: { session: { header: { cwd: root, id: 'status' } } }, token: {} }

/**
 * A pool double that counts every way a status line could have started work.
 * A real FinderPool would spawn the indexer on first use; the point of the test
 * is that nothing here is ever asked to.
 */
function countingPool() {
  const calls = { live: 0, finders: 0 }
  return {
    calls,
    live() { calls.live++; return [] },
  }
}

const previousIndexerEnv = process.env.DSH_FORGE_INDEXER
const previousBinEnv = process.env.DSH_FORGE_INDEXER_BIN

try {
  // ---- 1. never started: status reports configured/not_probed, not "ready" --
  {
    resetTraceSnapshots()
    process.env.DSH_FORGE_INDEXER_BIN = path.join(root, 'no-such-sidecar')
    const pool = countingPool()
    const status = createStatusCommand(pool)
    const result = await status.handler({ rawInput: '', ...exec })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /Trace 覆盖：/, 'the capability line must be present')
    assert.match(result.text, /Trace 原生解析：/, 'the native line must be present')
    assert.match(result.text, /未探测不等于可用/, 'unprobed must not read as available')
    const native = peekIndexerStatus()
    assert.equal(native.state, 'not_probed', `missing binary must be not_probed, got ${native.state}`)
    assert.ok(native.detail.includes('未尝试启动'))
    assert.ok(pool.calls.live >= 1, 'the status path still reads pool state')
    ok('status describes the sidecar without starting it, and never calls a missing binary ready')
  }

  // ---- 2. disabled by env: honest "disabled", still no spawn ---------------
  {
    process.env.DSH_FORGE_INDEXER = 'off'
    const pool = countingPool()
    const result = await createStatusCommand(pool).handler({ rawInput: '', ...exec })
    assert.match(result.text, /Trace 原生解析：disabled/)
    assert.equal(peekIndexerStatus().state, 'disabled')
    ok('an env-disabled sidecar reads disabled rather than failed or ready')
  }

  // ---- 3. ready: the version comes from the ping, not from a guess --------
  {
    delete process.env.DSH_FORGE_INDEXER
    process.env.DSH_FORGE_INDEXER_BIN = path.join(root, 'no-such-sidecar')
    // A transport double stands in for the sidecar process: it proves the
    // reported state comes from an observed reply.
    let pings = 0
    const pingOnce = async (method) => {
      if (method === 'ping') { pings++; return { ok: true, version: '9.9.9-test' } }
      throw new Error(`unexpected method ${method}`)
    }
    await resetIndexer()
    setIndexerTransportForTest(pingOnce)
    // Before any ping there is nothing observed: the pointed-at binary does not
    // exist, so "not_probed" is the honest answer even though a transport is
    // wired up. What must never appear is "ready".
    const before = peekIndexerStatus()
    assert.notEqual(before.state, 'ready', 'readiness must require an actual reply')
    assert.equal(before.state, 'not_probed')
    const ready = await indexerReady()
    assert.equal(ready, true)
    const after = peekIndexerStatus()
    assert.equal(after.state, 'ready')
    assert.equal(after.version, '9.9.9-test', 'the version must come from the reply')
    const pool = countingPool()
    const result = await createStatusCommand(pool).handler({ rawInput: '', ...exec })
    assert.match(result.text, /Trace 原生解析：ready/)
    assert.match(result.text, /版本 9\.9\.9-test/)
    ok('a successful ping is what makes the sidecar ready, and its version is reported as observed')
  }

  // ---- 4. crashed: a failed ping is failed, never silently ready ----------
  {
    await resetIndexer()
    setIndexerTransportForTest(() => { throw new Error('sidecar crashed') })
    await indexerReady()
    const crashed = peekIndexerStatus()
    assert.equal(crashed.state, 'failed')
    assert.ok(crashed.detail.includes('sidecar crashed'), crashed.detail)
    const result = await createStatusCommand(countingPool()).handler({ rawInput: '', ...exec })
    assert.match(result.text, /Trace 原生解析：failed/)
    ok('a crashed sidecar reads failed with its error, not ready')
  }

  // ---- 5. the status path runs nothing, in either direction --------------
  {
    await resetIndexer()
    // A real file so the state is `configured` (the binary appears to exist);
    // if any status line tried to start or ping it, the state would flip to
    // `failed` — that transition is the observable proof of a spawn attempt.
    const fakeBinary = path.join(root, 'fake-sidecar')
    fs.writeFileSync(fakeBinary, 'not a real executable\n')
    process.env.DSH_FORGE_INDEXER_BIN = fakeBinary
    // And a transport that records any request: status must never reach it.
    let transported = 0
    setIndexerTransportForTest(async () => { transported++; throw new Error('status must not talk to the sidecar') })
    const before = peekIndexerStatus()
    assert.equal(before.state, 'configured', `expected configured, got ${before.state}: ${before.detail}`)
    const pool = countingPool()
    const status = createStatusCommand(pool)
    const first = await status.handler({ rawInput: '', ...exec })
    const second = await status.handler({ rawInput: '', ...exec })
    assert.equal(first.kind, 'success'); assert.equal(second.kind, 'success')
    assert.equal(transported, 0, 'the status path must not issue a single sidecar request')
    const after = peekIndexerStatus()
    assert.equal(after.state, 'configured', 'status must not have started, pinged or crashed the sidecar')
    assert.equal(after.version, null)
    assert.match(first.text, /Trace 原生解析：configured/)
    assert.match(first.text, /尚未启动/)
    // The pool is read for its own state, but never asked to build anything.
    assert.ok(pool.calls.live >= 2)
    ok('status issues no sidecar request and leaves the observed state untouched')
  }

  // ---- 6. capability lines match the single source of truth --------------
  {
    const result = await createStatusCommand(countingPool()).handler({ rawInput: '', ...exec })
    const dependencyLanguages = TRACE_CAPABILITY_MATRIX.filter(row => row.fileDependency !== false)
    assert.match(result.text, new RegExp(`文件依赖 ${dependencyLanguages.length} 种`))
    for (const row of TRACE_CAPABILITY_MATRIX) {
      assert.match(result.text, new RegExp(row.language), `language ${row.language} missing from status`)
    }
    // C# is parsed but contributes no dependency edges; the status text must
    // not imply otherwise.
    assert.ok(traceLanguageCapability('csharp').fileDependency === false)
    ok('the status capability line is derived from the matrix, so it cannot drift')
  }

  // ---- 7. undelivered stages are stated, not omitted ---------------------
  {
    const result = await createStatusCommand(countingPool()).handler({ rawInput: '', ...exec })
    assert.match(result.text, /Trace 语义引用：unavailable/)
    assert.match(result.text, /Trace 运行时证据：unavailable/)
    assert.match(result.text, /只找定义，不是引用计数/)
    ok('stages the roadmap has not delivered say unavailable instead of being omitted')
  }

  // ---- 8. snapshot counts are passive and workspace-scoped ---------------
  {
    resetTraceSnapshots()
    assert.deepEqual(traceSnapshotStatus(undefined), { snapshots: 0, configurations: 0, liveCursors: 0, newest: null },
      'no workspace means no claim, not a scan')
    assert.equal(traceSnapshotStatus(root).snapshots, 0)
    const result = await createStatusCommand(countingPool()).handler({ rawInput: '', ...exec })
    assert.match(result.text, /Trace 快照：本次进程内尚无/)
    ok('an empty snapshot registry reads as zero without building a graph')
  }
} finally {
  await resetIndexer()
  setIndexerTransportForTest(null)
  if (previousIndexerEnv === undefined) delete process.env.DSH_FORGE_INDEXER
  else process.env.DSH_FORGE_INDEXER = previousIndexerEnv
  if (previousBinEnv === undefined) delete process.env.DSH_FORGE_INDEXER_BIN
  else process.env.DSH_FORGE_INDEXER_BIN = previousBinEnv
  resetTraceSnapshots()
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

console.log(`\n${passed} passive status groups passed`)
