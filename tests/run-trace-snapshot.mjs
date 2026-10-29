/**
 * Trace snapshots: which graph answered, under which configuration, and does an
 * ID still resolve?
 *
 * The failure this prevents (M0.4): "the last graph for this directory" being
 * used as if it were "the graph for this configuration". Two declarations files,
 * a changed compile_commands.json, or an evicted entry must not silently turn
 * into a different answer — and a query's snapshot token must keep resolving to
 * the graph it quoted.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assembleTraceGraph, lookupTraceSnapshot, resetTraceFactsCache, resetTraceSnapshots, traceSnapshots } from '../lib/tools-trace.js'
import { configIdentity, configKeyOf, TraceSnapshots } from '../lib/trace-snapshot.js'

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-snapshot-'))
const previousWorkers = process.env.DSH_FORGE_AST_WORKERS
const write = (rel, text) => {
  const abs = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

try {
  process.env.DSH_FORGE_AST_WORKERS = '0'

  // --- 1. config identity: one fixed representation for "absent" ------------
  {
    const bare = configIdentity({ root })
    assert.equal(bare.declarations, null)
    assert.equal(bare.declarationsDigest, null)
    assert.equal(bare.compileCommands, null)
    assert.deepEqual(bare.contexts, [])
    assert.equal(configKeyOf(bare), configKeyOf(configIdentity({ root })), 'the same request must hash the same')

    const withDecls = configIdentity({ root, declarations: '/w/a.json', declarationsDigest: 'aa' })
    const otherDecls = configIdentity({ root, declarations: '/w/b.json', declarationsDigest: 'aa' })
    const editedDecls = configIdentity({ root, declarations: '/w/a.json', declarationsDigest: 'bb' })
    assert.notEqual(configKeyOf(bare), configKeyOf(withDecls), 'a declarations file is a different configuration')
    assert.notEqual(configKeyOf(withDecls), configKeyOf(otherDecls), 'a different declarations path is a different configuration')
    assert.notEqual(configKeyOf(withDecls), configKeyOf(editedDecls), 'edited declarations content is a different configuration')
    // Fixed slot order: a later slot appearing must not collide with an earlier one.
    assert.notEqual(
      configKeyOf(configIdentity({ root, contexts: { project: 'p' } })),
      configKeyOf(configIdentity({ root, contexts: { python: 'p' } })),
    )
    ok('config key separates root, declaration identity and project context slots')
  }

  // --- 2. registry: IDs are unique, scoped, and never fall back --------------
  {
    const store = new TraceSnapshots({ perWorkspace: 2, total: 4 })
    const config = configIdentity({ root: 'ws-a' })
    const key = configKeyOf(config)
    const first = store.register({ config, configKey: key, payload: 'A', files: ['x.js'], probes: 1, scanned: 1, truncated: false })
    const second = store.register({ config, configKey: key, payload: 'B', files: ['x.js'], probes: 1, scanned: 1, truncated: false })
    assert.notEqual(first.snapshotId, second.snapshotId)
    assert.equal(store.get(first.snapshotId, 'ws-a').status, 'ok')
    assert.equal(store.get(second.snapshotId, 'ws-a').payload, 'B')

    // Another workspace must not read this snapshot, even with the exact ID.
    const foreign = store.get(first.snapshotId, 'ws-b')
    assert.equal(foreign.status, 'snapshot_unavailable')
    assert.match(foreign.reason, /another workspace/)

    // Unknown ID: unavailable — never "here is the newest one instead".
    const missing = store.get('nope', 'ws-a')
    assert.equal(missing.status, 'snapshot_unavailable')
    assert.match(missing.reason, /not stored/)
    ok('snapshot lookup is scoped, unguessable, and never substitutes another graph')
  }

  // --- 3. eviction removes the oldest, not the configuration ----------------
  {
    const store = new TraceSnapshots({ perWorkspace: 2, total: 8 })
    const config = configIdentity({ root: 'ws' })
    const key = configKeyOf(config)
    const a = store.register({ config, configKey: key, payload: 'A', files: [], probes: 0, scanned: 0, truncated: false })
    const b = store.register({ config, configKey: key, payload: 'B', files: [], probes: 0, scanned: 0, truncated: false })
    const c = store.register({ config, configKey: key, payload: 'C', files: [], probes: 0, scanned: 0, truncated: false })
    assert.equal(store.size, 2)
    assert.equal(store.get(a.snapshotId, 'ws').status, 'snapshot_unavailable')
    assert.equal(store.get(b.snapshotId, 'ws').status, 'ok')
    assert.equal(store.get(c.snapshotId, 'ws').status, 'ok')
    ok('eviction drops the oldest snapshot and never silently re-points its ID')
  }

  // --- 4. an announced-but-uncommitted snapshot does not resolve ------------
  {
    const store = new TraceSnapshots()
    const config = configIdentity({ root: 'ws' })
    const meta = store.announce({ config, configKey: configKeyOf(config), files: ['a.js'], probes: 0, scanned: 1, truncated: false })
    assert.equal(store.get(meta.snapshotId, 'ws').status, 'snapshot_unavailable', 'an unfinished assembly must not be readable')
    store.put(meta, 'payload')
    assert.equal(store.get(meta.snapshotId, 'ws').payload, 'payload')
    ok('a snapshot resolves only after its payload is committed')
  }

  // --- 5. real assemblies: two declarations files are two snapshots ---------
  {
    resetTraceFactsCache()
    resetTraceSnapshots()
    write('main.js', "contextBridge.exposeInMainWorld('apiA', { read: () => 1 })\n")
    write('decls-a.json', JSON.stringify({ apis: [{ name: 'read', channel: 'a:read', kind: 'query', roles: ['page'] }] }))
    write('decls-b.json', JSON.stringify({ apis: [{ name: 'read', channel: 'b:read', kind: 'query', roles: ['page'] }] }))

    const a = await assembleTraceGraph(root, { declarations: 'decls-a.json' })
    const b = await assembleTraceGraph(root, { declarations: 'decls-b.json' })
    assert.notEqual(a.snapshot.snapshotId, b.snapshot.snapshotId)
    assert.notEqual(a.snapshot.configKey, b.snapshot.configKey, 'two declaration inputs are two configurations')
    assert.equal(a.snapshot.workspaceId, path.resolve(root))
    assert.equal(a.snapshot.strength, 'observed', 'M0 observations are not content-bound')
    assert.equal(a.snapshot.truncated, false)

    // Each ID resolves to the graph it named, with that graph's declaration set.
    const backA = lookupTraceSnapshot(root, a.snapshot.snapshotId)
    const backB = lookupTraceSnapshot(root, b.snapshot.snapshotId)
    assert.equal(backA.status, 'ok')
    assert.equal(backB.status, 'ok')
    assert.equal(backA.payload.decls.apis[0].channel, 'a:read')
    assert.equal(backB.payload.decls.apis[0].channel, 'b:read')
    assert.deepEqual(traceSnapshots(root).map(meta => meta.snapshotId).sort(),
      [a.snapshot.snapshotId, b.snapshot.snapshotId].sort())
    ok('two declarations files produce two snapshots, each resolving to its own graph')
  }

  // --- 6. a warm hit keeps its identity; an edit changes it -----------------
  {
    resetTraceFactsCache()
    resetTraceSnapshots()
    write('warm.js', 'const a = 1\n')
    const first = await assembleTraceGraph(root)
    const warm = await assembleTraceGraph(root)
    assert.equal(warm.snapshot.snapshotId, first.snapshot.snapshotId, 'a reused graph keeps its snapshot identity')
    assert.equal(warm.graph, first.graph)

    write('warm.js', 'const a = 2\n')
    const changed = await assembleTraceGraph(root)
    assert.notEqual(changed.snapshot.snapshotId, first.snapshot.snapshotId, 'rebuilt graph is a new snapshot')
    assert.equal(lookupTraceSnapshot(root, first.snapshot.snapshotId).status, 'ok', 'the before snapshot stays addressable as before-evidence')
    ok('warm reuse keeps the ID; a rebuild assigns a new one and keeps the old for before-evidence')
  }

  // --- 7. a declarations edit changes config without a scan change ----------
  {
    resetTraceFactsCache()
    resetTraceSnapshots()
    write('edit-decls.json', JSON.stringify({ apis: [{ name: 'read', channel: 'x:read', kind: 'query', roles: ['page'] }] }))
    const before = await assembleTraceGraph(root, { declarations: 'edit-decls.json' })
    write('edit-decls.json', JSON.stringify({ apis: [{ name: 'write', channel: 'x:write', kind: 'command', roles: ['page'] }] }))
    const after = await assembleTraceGraph(root, { declarations: 'edit-decls.json' })
    assert.notEqual(after.snapshot.configKey, before.snapshot.configKey, 'edited declarations are a new configuration even when no source file changed')
    assert.notEqual(after.snapshot.snapshotId, before.snapshot.snapshotId)
    assert.equal(after.graph.decls.apis[0].name, 'write')
    ok('editing the declarations file alone invalidates the configuration')
  }

  // --- 8. file-set digest notices additions --------------------------------
  {
    resetTraceFactsCache()
    resetTraceSnapshots()
    const first = await assembleTraceGraph(root)
    const store = new TraceSnapshots()
    assert.equal(store.fileSetMatches(first.snapshot, first.graph.files.keys()), true)
    write('extra.js', 'export const extra = 1\n')
    assert.equal(store.fileSetMatches(first.snapshot, [...first.graph.files.keys(), 'extra.js']), false)
    const next = await assembleTraceGraph(root)
    assert.notEqual(next.snapshot.fileSetDigest, first.snapshot.fileSetDigest)
    ok('the file-set digest changes when a file is added, and only then matches')
  }

  // --- 9. a snapshot never crosses workspaces ------------------------------
  {
    resetTraceFactsCache()
    resetTraceSnapshots()
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-snapshot-other-'))
    try {
      fs.writeFileSync(path.join(other, 'x.js'), 'const x = 1\n')
      const mine = await assembleTraceGraph(root)
      const theirs = await assembleTraceGraph(other)
      assert.notEqual(mine.snapshot.workspaceId, theirs.snapshot.workspaceId)
      const crossed = lookupTraceSnapshot(other, mine.snapshot.snapshotId)
      assert.equal(crossed.status, 'snapshot_unavailable')
      assert.match(crossed.reason, /another workspace/)
    } finally {
      fs.rmSync(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
    ok('a snapshot ID is rejected in a workspace other than the one that built it')
  }
} finally {
  resetTraceSnapshots()
  if (previousWorkers === undefined) delete process.env.DSH_FORGE_AST_WORKERS
  else process.env.DSH_FORGE_AST_WORKERS = previousWorkers
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

console.log(`\n${passed} Trace snapshot groups passed`)
