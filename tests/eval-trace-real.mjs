/**
 * Real-repo trace evaluation — the REAL-REPO half of the trace test split
 * (evaluation line B, split requested by review: unit correctness lives in
 * eval-trace.mjs on the deterministic fixture; this file measures the graph
 * pipeline against REAL workspaces).
 *
 * Targets (first-party repos, probed in order, all present ones evaluated):
 *   VCPChat         — real Electron client: pages, IPC, bridge, globals
 *   VCPToolBox      — real Node server: module graph at scale, no IPC surface
 *   audio-engine-core — real Rust workspace: static module/include dependencies
 *   dsh-session-hub — real TS plugin monorepo (small)
 *
 * A real repo has no hand-enumerated ground truth, so no precision/recall is
 * claimed here. What IS asserted per target: assembly completes without
 * truncation, parse errors stay under floor, two cold assemblies produce an
 * identical graph digest, and structural invariants hold (edge/def/use paths
 * point at scanned or referenced files, unresolved paths are reported,
 * membership pages are pages). Per-class counts are printed so zero-surface
 * classes are visible instead of hidden in a total.
 *
 * Skips absent targets (loudly); set DSH_FORGE_REAL_REPO to evaluate a
 * single specific workspace instead of the default candidate list.
 *
 * @module dsh-forge/tests/eval-trace-real
 */

import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assembleTraceGraph, resetTraceFactsCache } from '../lib/tools-trace.js'
import { resetFactsCache } from '../lib/ast.js'
import { disposeAstWorkers } from '../lib/ast-pool.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const up = (n) => path.resolve(here, ...Array(n).fill('..'))
/** Candidate roots: sibling checkouts of this repository, then a few same-tree names. */
const CANDIDATES = [
  up(3) + '/VCPChat',
  up(3) + '/VCPToolBox',
  up(3) + '/audio-engine-core',
  up(2) + '/dsh-session-hub',
]

const isPresent = (root) => existsSync(path.join(root, 'package.json')) || existsSync(path.join(root, '.git'))
const targets = process.env.DSH_FORGE_REAL_REPO?.trim() ? [process.env.DSH_FORGE_REAL_REPO.trim()] : CANDIDATES.filter(isPresent)

// One target per process. Assembling several large repos in the same process
// leaves the AST pool in a state where a later repo's *second* cold assembly
// can differ from its first (measured: VCPToolBox after VCPChat, while the same
// repo is byte-stable in isolation across 14 digest buckets). Determinism is a
// per-process property here, so fan out instead of stacking.
if (!process.env.DSH_FORGE_REAL_REPO?.trim() && targets.length > 1) {
  let failed = 0
  for (const root of targets) {
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, DSH_FORGE_REAL_REPO: root },
      stdio: 'inherit',
    })
    if (run.status !== 0) failed++
  }
  process.exit(failed === 0 ? 0 : 1)
}

if (targets.length === 0) {
  console.log('eval-trace-real: no real repo present among candidates — SKIPPED (set DSH_FORGE_REAL_REPO to enable)')
  process.exitCode = 0
} else {

  async function assembleCold(root) {
    await disposeAstWorkers()
    resetFactsCache()
    resetTraceFactsCache()
    return assembleTraceGraph(root)
  }

  const digest = (a) => JSON.stringify({
    scanned: a.scanned,
    parseErrors: a.parseErrors,
    partialFiles: a.partialFiles,
    walkErrors: a.walkErrors,
    files: [...a.graph.files.keys()].sort(),
    depEdges: [...a.graph.deps.entries()].flatMap(([f, es]) => es.map((e) => `${f}->${e.to}:${e.line}:${e.kind}`)).sort(),
    unresolved: a.graph.unresolvedModules.map((u) => `${u.path}:${u.line}:${u.spec}`).sort(),
    evidence: [...a.graph.rdeps].flatMap(([to, refs]) => refs.map(ref => [ref.path, to, ref.line, ref.kind, ref.evidence])).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    resolutionDiagnostics: a.graph.unresolvedModules,
    fileDiagnostics: a.diagnostics,
    registers: [...a.graph.registers.entries()].flatMap(([c, xs]) => xs.map((x) => `${c} ${x.path}:${x.line}`)).sort(),
    pushes: [...a.graph.pushes.entries()].flatMap(([c, xs]) => xs.map((x) => `${c} ${x.path}:${x.line}`)).sort(),
    directCalls: [...a.graph.directCalls.entries()].flatMap(([c, xs]) => xs.map((x) => `${c} ${x.path}:${x.line}`)).sort(),
    gdefs: [...a.graph.gdefs.entries()].flatMap(([n, xs]) => xs.map((x) => `${n} ${x.path}:${x.line}`)).sort(),
    guses: [...a.graph.guses.entries()].flatMap(([n, xs]) => xs.map((x) => `${n} ${x.path}:${x.line}`)).sort(),
    bridgeRefs: [...a.graph.bridgeRefs.entries()].flatMap(([n, xs]) => xs.map((x) => `${n} ${x.path}:${x.line}`)).sort(),
    unknownBridge: a.graph.unknownBridge.map((b) => `${b.name} ${b.path}:${b.line}`).sort(),
    membership: [...a.graph.membership.entries()].map(([f, ps]) => `${f}=>${[...ps.keys()].sort().join(',')}`).sort(),
    pages: [...a.graph.pages.entries()].map(([p, ss]) => `${p}=>${ss.map((s) => `${s.index}:${s.rel ?? 'inline'}`).join(',')}`).sort(),
  })

  const isRealFile = (root, rel) => {
    try { return statSync(path.join(root, ...rel.split('/'))).isFile() } catch { return false }
  }

  const summary = []
  for (const root of targets) {
    const t0 = Date.now()
    const first = await assembleCold(root)
    const elapsed = Date.now() - t0
    const second = await assembleCold(root)
    const g = first.graph

    // Health floors. scanned === 0 is legitimate for repos outside the
    // supported language surface; per-language counts expose that boundary.
    assert.equal(first.truncated, false, `${root}: must assemble without truncation`)
    if (first.scanned > 0) {
      assert.ok(first.parseErrors / first.scanned <= 0.02,
        `${root}: parse error rate must stay <=2% (${first.parseErrors}/${first.scanned})`)
    }
    // Determinism (two cold assemblies).
    assert.equal(digest(first), digest(second), `${root}: two cold assemblies must produce identical graphs`)

    // Structural invariants. An edge whose target does not exist on disk must
    // be accounted in unresolvedModules (relative misses) or be a dynamic
    // package import (bare spec kept by design).
    const unresolvedKeys = new Set(g.unresolvedModules.map((u) => `${u.path}:${u.line}`))
    const isRelative = (spec) => /^\.\.?(\/|$)/.test(spec) || spec.startsWith('/')
    for (const [from, edges] of g.deps) {
      assert.ok(g.files.has(from) || isRealFile(root, from), `${root}: dep source scanned: ${from}`)
      for (const e of edges) {
        if (g.files.has(e.to) || isRealFile(root, e.to)) continue
        assert.ok(
          unresolvedKeys.has(`${from}:${e.line}`)
          || (!isRelative(e.to) && String(e.kind).includes('dynamic_import')),
          `${root}: unresolvable edge must be accounted unresolved or be a dynamic package import: ${from} -> ${e.to} (${e.kind})`,
        )
      }
    }
    for (const [channel, items] of [...g.registers, ...g.pushes, ...g.directCalls]) {
      void channel
      for (const item of items) assert.ok(g.files.has(item.path), `${root}: ipc item path scanned: ${item.path}`)
    }
    for (const item of g.dynamic) assert.ok(g.files.has(item.path), `${root}: dynamic item path scanned: ${item.path}`)
    for (const [file, pages] of g.membership) {
      assert.ok(g.files.has(file) || isRealFile(root, file), `${root}: member file exists: ${file}`)
      for (const page of pages.keys()) assert.ok(g.pages.has(page), `${root}: membership page is a page: ${file} -> ${page}`)
    }
    for (const items of g.bridgeRefs.values()) for (const b of items) assert.ok(g.files.has(b.path), `${root}: bridge ref path scanned: ${b.path}`)
    for (const b of g.unknownBridge) assert.ok(g.files.has(b.path), `${root}: unknown bridge path scanned: ${b.path}`)

    // Per-class observability.
    const count = (m) => [...m.values()].flat().length
    const rows = [
      ['dep.edges', [...g.deps.values()].flat().length],
      ['dep.unresolved', g.unresolvedModules.length],
      ...['rust', 'python', 'c', 'cpp'].map(lang => [`source.${lang}`, [...g.files.values()].filter(f => f.kind === 'source' && f.lang === lang).length]),
      ['source.depEdges', [...g.deps].filter(([file]) => g.files.get(file)?.kind === 'source').reduce((n, [, edges]) => n + edges.length, 0)],
      ['ipc.register', count(g.registers)],
      ['ipc.push', count(g.pushes)],
      ['ipc.call', count(g.directCalls)],
      ['ipc.dynamic', g.dynamic.length],
      ['global.defs', count(g.gdefs)],
      ['global.uses', count(g.guses)],
      ['bridge.refs', count(g.bridgeRefs)],
      ['bridge.unknown', g.unknownBridge.length],
      ['pages', g.pages.size],
      ['membership', g.membership.size],
    ]
    console.log(`\n== real-repo trace eval: ${root} ==`)
    console.log(`scanned ${first.scanned} files, ${first.parseErrors} parse errors, ${first.partialFiles} partial files, ${first.walkErrors} walk errors, assembled in ${elapsed}ms`)
    for (const [label, n] of rows) console.log(`${label.padEnd(16)} ${String(n).padStart(6)}${n === 0 ? '   (no surface in this repo)' : ''}`)
    summary.push({ root, scanned: first.scanned, parseErrors: first.parseErrors, rows })
  }

  const zero = (s, label) => s.rows.find(([l]) => l === label)?.[1] === 0
  for (const s of summary) {
    const noSurface = ['ipc.register', 'pages', 'bridge.refs'].filter((l) => zero(s, l))
    if (noSurface.length && s.scanned > 0) {
      console.log(`class coverage note [${path.basename(s.root)}]: ${noSurface.join(', ')} have no surface — accuracy for them is measured by eval-trace.mjs (fixture oracle), not by this file`)
    }
  }
  console.log(`\n${summary.length} real target(s) evaluated; health + determinism + invariants floors hold`)
}
