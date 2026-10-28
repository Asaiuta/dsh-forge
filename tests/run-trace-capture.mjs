/**
 * Content-bound capture baselines (M1.1).
 *
 * The claim under test is narrow and easy to get wrong: a captured baseline must
 * describe *the bytes that were parsed*, survive a process restart, refuse to
 * vouch for content it never saw, and fail loudly instead of truncating.
 *
 * Each group below is one way that claim breaks.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-capture-data-'))
process.env.DSH_FORGE_DATA_DIR = dataDir
process.env.DSH_FORGE_AST_WORKERS = '0'

const { assembleTraceGraph, resetTraceFactsCache, resetTraceSnapshots, resolveBeforeEvidence } = await import('../lib/tools-trace.js')
const { loadBaseline, saveBaseline, fileSetDigestOf, driftedFiles, baselineStats, MAX_BASELINES_PER_WORKSPACE } = await import('../lib/trace-capture.js')
const { sha256Hex } = await import('../lib/source-evidence.js')

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-capture-ws-'))
const write = (rel, text) => {
  const abs = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
  return abs
}
const hashOf = (rel) => sha256Hex(fs.readFileSync(path.join(root, ...rel.split('/'))))
const dirFor = (workspace) => path.join(dataDir, 'verification')
const baselineFile = (snapshotId) => {
  const dir = fs.readdirSync(dirFor(root)).map(name => path.join(dirFor(root), name))[0]
  return path.join(dir, `${snapshotId}.json`)
}

const previous = { budget: process.env.DSH_FORGE_CAPTURE_BUDGET_BYTES, ttl: process.env.DSH_FORGE_CAPTURE_TTL_MS, indexer: process.env.DSH_FORGE_INDEXER }

try {
  // --- 1. a capture records the hash of the bytes it parsed ----------------
  {
    write('preloads/main.js', "const { contextBridge } = require('electron')\ncontextBridge.exposeInMainWorld('chartAPI', { togglePin() { return 1 } })\n")
    write('a.js', 'window.chartAPI.togglePin()\n')
    write('b.js', 'const api = window.chartAPI\napi.togglePin()\n')
    const captured = await assembleTraceGraph(root, { capture: true })
    assert.equal(captured.snapshot.strength, 'content-bound', 'a complete capture is content-bound')
    assert.equal(captured.snapshot.provider, 'wasm', 'capture never borrows the sidecar\'s facts: it must hash what it parsed')
    assert.equal(captured.capture.persisted, true, captured.capture.saveError ?? 'capture must reach disk')
    const loaded = loadBaseline(root, captured.snapshot.snapshotId)
    assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.detail)
    // Every recorded hash must be recomputable from the file on disk: that is
    // the whole meaning of "content-bound".
    for (const file of loaded.baseline.files) {
      assert.equal(file.rawHash, hashOf(file.path), `${file.path} hash must match the bytes on disk`)
    }
    assert.deepEqual(loaded.baseline.files.map(file => file.path), ['a.js', 'b.js', 'preloads/main.js'])
    assert.equal(loaded.baseline.fileSetDigest, fileSetDigestOf(loaded.baseline.files))
    // The capture path and the fast path describe the same graph.
    const fast = await assembleTraceGraph(root)
    assert.equal(fast.graph.files.size, captured.graph.files.size, 'capture and fast path must see the same file set')
    assert.equal(fast.snapshot.strength, 'observed', 'the ordinary path never claims more than it checked')
    ok('capture persists recomputable per-file hashes and stays separate from the fast path')
  }

  // --- 2. the baseline survives a process restart --------------------------
  {
    const captured = await assembleTraceGraph(root, { capture: true })
    const id = captured.snapshot.snapshotId
    // A fresh process has no in-memory snapshot; the file has to be enough.
    const script = `
      const m = await import(${JSON.stringify(new URL('../lib/trace-capture.js', import.meta.url).href)})
      const loaded = m.loadBaseline(${JSON.stringify(root)}, ${JSON.stringify(id)})
      console.log(JSON.stringify(loaded.ok ? { ok: true, files: loaded.baseline.files.length, strength: loaded.baseline.strength } : { ok: false, reason: loaded.reason }))
    `
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, DSH_FORGE_DATA_DIR: dataDir },
      encoding: 'utf8',
    }).trim()
    const parsed = JSON.parse(out.split('\n').pop())
    assert.deepEqual(parsed, { ok: true, files: 3, strength: 'content-bound' }, 'a new process must load the same baseline')
    ok('a baseline loaded in a fresh process keeps its identity and file list')
  }

  // --- 3. drift is visible, never silently tolerated -----------------------
  {
    const captured = await assembleTraceGraph(root, { capture: true })
    const id = captured.snapshot.snapshotId
    assert.deepEqual(driftedFiles(root, loadBaseline(root, id).baseline), [], 'nothing drifted yet')
    write('a.js', 'window.chartAPI.pinToggle()\n')
    const after = driftedFiles(root, loadBaseline(root, id).baseline)
    assert.equal(after.length, 1)
    assert.equal(after[0].path, 'a.js')
    assert.notEqual(after[0].current, after[0].recorded)
    assert.equal(after[0].current, hashOf('a.js'))
    // Editing does not invalidate the record — it invalidates the *claim* that
    // the file still is what was captured, which the caller now has to say.
    const refused = resolveBeforeEvidence(root, id, path.join(root, 'a.js'))
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'drift')
    const untouched = resolveBeforeEvidence(root, id, path.join(root, 'b.js'))
    assert.equal(untouched.ok, true, untouched.ok ? '' : untouched.detail)
    assert.equal(untouched.rawHash, hashOf('b.js'))
    write('a.js', 'window.chartAPI.togglePin()\n')
    ok('an edited file becomes drift evidence; an untouched file still resolves')
  }

  // --- 4. a removed file drifts too ---------------------------------------
  {
    const captured = await assembleTraceGraph(root, { capture: true })
    const id = captured.snapshot.snapshotId
    write('temp.js', 'export const t = 1\n')
    const withTemp = await assembleTraceGraph(root, { capture: true })
    const tempId = withTemp.snapshot.snapshotId
    fs.rmSync(path.join(root, 'temp.js'))
    const drift = driftedFiles(root, loadBaseline(root, tempId).baseline)
    assert.equal(drift.length, 1)
    assert.equal(drift[0].current, null, 'a deleted file has no current hash')
    const refused = resolveBeforeEvidence(root, tempId, path.join(root, 'temp.js'))
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'drift')
    assert.match(refused.detail, /删除/)
    // The earlier capture simply does not know about the file.
    const notCovered = resolveBeforeEvidence(root, id, path.join(root, 'temp.js'))
    assert.equal(notCovered.ok, false)
    assert.equal(notCovered.reason, 'not_covered')
    assert.match(notCovered.detail, /未覆盖/)
    ok('a rename/delete drifts; a file the capture never saw is not_covered, not a pass')
  }

  // --- 5. corrupt and expired records are refused -------------------------
  {
    const captured = await assembleTraceGraph(root, { capture: true })
    const id = captured.snapshot.snapshotId
    const file = baselineFile(id)
    const good = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, good.slice(0, Math.max(10, good.length - 40)))
    const corrupt = loadBaseline(root, id)
    assert.equal(corrupt.ok, false)
    assert.equal(corrupt.reason, 'corrupt')
    fs.writeFileSync(file, good)
    assert.equal(loadBaseline(root, id).ok, true, 'restored bytes load again')

    // A record whose manifest no longer matches its digest is corrupt, not stale.
    const parsed = JSON.parse(good)
    parsed.files[0].rawHash = 'deadbeef'
    fs.writeFileSync(file, JSON.stringify(parsed))
    const tampered = loadBaseline(root, id)
    assert.equal(tampered.ok, false)
    assert.equal(tampered.reason, 'corrupt')
    assert.match(tampered.detail, /清单|摘要/)
    fs.writeFileSync(file, good)

    process.env.DSH_FORGE_CAPTURE_TTL_MS = '0'
    try {
      const expired = loadBaseline(root, id)
      assert.equal(expired.ok, false)
      assert.equal(expired.reason, 'expired')
    } finally {
      delete process.env.DSH_FORGE_CAPTURE_TTL_MS
    }
    assert.equal(loadBaseline(root, id).ok, true, 'a TTL change is not a stored property')
    ok('half-written, tampered and expired baselines are each refused by name')
  }

  // --- 6. an incomplete capture never becomes a baseline ------------------
  {
    // Force the read budget below one file: the capture must report the stop.
    process.env.DSH_FORGE_CAPTURE_BUDGET_BYTES = '40'
    try {
      const truncated = await assembleTraceGraph(root, { capture: true })
      assert.equal(truncated.truncated, true, 'hitting the budget is truncation, not completion')
      assert.equal(truncated.snapshot.strength, 'observed', 'an incomplete capture cannot claim content binding')
      assert.equal(truncated.capture.persisted, false)
      assert.match(truncated.capture.saveError, /不完整/)
      assert.equal(loadBaseline(root, truncated.snapshot.snapshotId).ok, false)
      assert.ok(truncated.diagnostics.some(issue => issue.reason === 'capture_budget'), 'the stop must say which reason')
    } finally {
      delete process.env.DSH_FORGE_CAPTURE_BUDGET_BYTES
    }
    // And the record itself cannot be stored by hand either.
    const forged = saveBaseline({
      schema: 'trace-capture/1', snapshotId: 'a'.repeat(24), workspaceId: root,
      configKey: 'k', config: { root, declarations: null, declarationsDigest: null, compileCommands: null, compileCommandsDigest: null, contexts: [], extractor: 'trace-snapshot/1' },
      provider: 'wasm', providerVersion: 'wasm', createdAt: new Date().toISOString(), strength: 'content-bound',
      files: [], fileSetDigest: fileSetDigestOf([]), probes: 0, scanned: 0, truncated: true, partialFiles: 0, capturedBytes: 0, facts: {},
    })
    assert.equal(forged.ok, false)
    assert.equal(forged.reason, 'incomplete')
    ok('a truncated capture reports why and is never saved as a baseline')
  }

  // --- 7. rotation and budget are explicit, not silent -------------------
  {
    for (let index = 0; index < MAX_BASELINES_PER_WORKSPACE + 2; index++) {
      write('spin.js', `export const spin = ${index}\n`)
      const captured = await assembleTraceGraph(root, { capture: true })
      assert.equal(captured.capture.persisted, true, `capture ${index} must persist`)
    }
    const stats = baselineStats(root)
    assert.equal(stats.count, MAX_BASELINES_PER_WORKSPACE, `at most ${MAX_BASELINES_PER_WORKSPACE} baselines are kept`)
    assert.ok(stats.bytes > 0)
    ok('the per-workspace baseline cap rotates the oldest instead of growing forever')
  }

  // --- 8. no baseline means no claim about what was introduced ------------
  {
    resetTraceSnapshots()
    const observed = await assembleTraceGraph(root)
    const refused = resolveBeforeEvidence(root, observed.snapshot.snapshotId, path.join(root, 'a.js'))
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'observed_only')
    assert.match(refused.detail, /capture/)
    const missing = resolveBeforeEvidence(root, 'f'.repeat(24), path.join(root, 'a.js'))
    assert.equal(missing.ok, false)
    assert.equal(missing.reason, 'unavailable')
    // Another workspace's snapshot is a miss, never a cross-workspace lookup.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-capture-other-'))
    try {
      fs.writeFileSync(path.join(other, 'x.js'), 'const x = 1\n')
      const theirs = await assembleTraceGraph(other, { capture: true })
      const crossed = loadBaseline(root, theirs.snapshot.snapshotId)
      assert.equal(crossed.ok, false)
      assert.ok(['missing', 'other_workspace'].includes(crossed.reason), crossed.reason)
    } finally {
      fs.rmSync(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
    ok('an observed-only snapshot or unknown ID refuses instead of implying comparison')
  }
} finally {
  resetTraceSnapshots()
  resetTraceFactsCache()
  for (const [key, value] of Object.entries(previous)) {
    const name = key === 'budget' ? 'DSH_FORGE_CAPTURE_BUDGET_BYTES' : key === 'ttl' ? 'DSH_FORGE_CAPTURE_TTL_MS' : 'DSH_FORGE_INDEXER'
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

console.log(`\n${passed} Trace capture groups passed`)
