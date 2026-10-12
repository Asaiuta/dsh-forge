/**
 * Stage-2 performance benchmark — floor-gated like bench.mjs.
 *
 * Corpus: any large real tree, from `DSH_FORGE_BENCH_CORPUS` (falling back to
 * the installed DSH app plane). Measures (1) warm Outline latency on a
 * large real file, (2) FindSymbol cold scan + warm query over the corpus,
 * (3) the grep→symbol weld overhead on a 30-hit page.
 *
 * Floors (asserted, exit 1 on miss):
 *   A1  warm ff_outline p50 < 20 ms on a ≥50 KB file
 *   A2  ff_find_symbol cold scan < 60 s over the corpus
 *   A3  ff_find_symbol warm p50 < 1 s
 *   A4  ffgrep enclosing:true delta vs plain < 150 ms p50 (30-hit page)
 */

import assert from 'node:assert/strict'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { FinderPool } from '../lib/core.js'
import { createGrepTool } from '../lib/tools.js'
import { createOutlineTool, createFindSymbolTool } from '../lib/tools-symbol.js'
import { localEnv } from '../scripts/local-env.mjs'

const CORPUS = localEnv('DSH_FORGE_BENCH_CORPUS') ?? localEnv('DSH_FORGE_DSH_MODULES', { required: true })
const REPS = 20

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

/** Code file closest to `target` bytes in the corpus (representative size). */
function fileClosestTo(root, target, depth = 3) {
  let best = null
  let bestDelta = Infinity
  const visit = (dir, d) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (depth > 0 && !['.git', 'node_modules'].includes(e.name)) visit(abs, d + 1)
      } else if (/\.(js|mjs|cjs|ts|tsx|py|rs|go)$/.test(e.name)) {
        try {
          const delta = Math.abs(statSync(abs).size - target)
          if (delta < bestDelta) {
            bestDelta = delta
            best = abs
          }
        } catch { /* raced */ }
      }
    }
  }
  visit(root, 0)
  return best
}

async function main() {
  const pool = new FinderPool()
  const exec = { agent: { session: { header: { cwd: CORPUS } } } }
  const outline = createOutlineTool()
  const findSymbol = createFindSymbolTool()
  const grep = createGrepTool(pool)

  // --- A1: warm outline on a representative ~200KB file --------------------
  const bigFile = fileClosestTo(CORPUS, 200_000)
  assert.ok(bigFile, 'corpus must contain a code file')
  const bigSize = statSync(bigFile).size
  const coldStart = performance.now()
  const cold = await outline.execute({ path: bigFile }, exec)
  const coldMs = performance.now() - coldStart
  assert.ok(!cold.error, `outline of ${bigFile} failed: ${cold.error}`)
  for (let i = 0; i < 3; i++) await outline.execute({ path: bigFile }, exec)
  const outlineMs = []
  for (let i = 0; i < REPS; i++) {
    const start = performance.now()
    await outline.execute({ path: bigFile }, exec)
    outlineMs.push(performance.now() - start)
  }
  const outlineP50 = percentile(outlineMs, 50)
  console.log(`A1 outline: ${path.basename(bigFile)} (${(bigSize / 1024).toFixed(0)} KB, ${cold.items.length} symbols)`)
  console.log(`   cold ${coldMs.toFixed(1)}ms  warm p50 ${outlineP50.toFixed(2)}ms`)

  // --- A2/A3: FindSymbol cold scan + warm query ----------------------------
  const symStart = performance.now()
  const firstFind = await findSymbol.execute({ name: 'defineTool', limit: 50 }, exec)
  const coldScanMs = performance.now() - symStart
  assert.ok(!firstFind.error, `find_symbol failed: ${firstFind.error}`)
  console.log(`A2 find_symbol cold: ${firstFind.stats} (${(coldScanMs / 1000).toFixed(2)}s)`)
  const findMs = []
  for (let i = 0; i < REPS; i++) {
    const start = performance.now()
    await findSymbol.execute({ name: 'defineTool', limit: 50 }, exec)
    findMs.push(performance.now() - start)
  }
  const findP50 = percentile(findMs, 50)
  console.log(`A3 find_symbol warm p50: ${findP50.toFixed(2)}ms`)

  // --- A4: weld overhead on a hot 30-hit page ------------------------------
  const plain = []
  const welded = []
  for (let i = 0; i < 3; i++) {
    await grep.execute({ pattern: 'compaction', limit: 30 }, exec)
    await grep.execute({ pattern: 'compaction', limit: 30, enclosing: true }, exec)
  }
  for (let i = 0; i < REPS; i++) {
    let start = performance.now()
    const p = await grep.execute({ pattern: 'compaction', limit: 30 }, exec)
    plain.push(performance.now() - start)
    start = performance.now()
    const w = await grep.execute({ pattern: 'compaction', limit: 30, enclosing: true }, exec)
    welded.push(performance.now() - start)
    if (i === 0) assert.equal(w.items.length, p.items.length, 'weld must not drop hits')
  }
  const plainP50 = percentile(plain, 50)
  const weldedP50 = percentile(welded, 50)
  const delta = weldedP50 - plainP50
  console.log(`A4 weld: plain p50 ${plainP50.toFixed(2)}ms  enclosing p50 ${weldedP50.toFixed(2)}ms  Δ ${delta.toFixed(2)}ms`)

  // --- floors ---------------------------------------------------------------
  let floors = 0
  const pass = (label) => {
    floors++
    console.log(`  FLOOR ${floors} PASS - ${label}`)
  }
  assert.ok(outlineP50 < 20, `A1 violated: outline p50 ${outlineP50.toFixed(2)}ms >= 20ms`)
  pass(`A1 warm outline p50 < 20ms (${outlineP50.toFixed(2)}ms, ${(bigSize / 1024).toFixed(0)}KB file)`)
  assert.ok(coldScanMs < 60_000, `A2 violated: cold scan ${coldScanMs}ms >= 60s`)
  pass(`A2 find_symbol cold < 60s (${(coldScanMs / 1000).toFixed(2)}s)`)
  assert.ok(findP50 < 1000, `A3 violated: warm find p50 ${findP50.toFixed(2)}ms >= 1s`)
  pass(`A3 find_symbol warm p50 < 1s (${findP50.toFixed(2)}ms)`)
  assert.ok(delta < 150, `A4 violated: weld Δ ${delta.toFixed(2)}ms >= 150ms`)
  pass(`A4 weld Δ p50 < 150ms (${delta.toFixed(2)}ms)`)

  pool.disposeAll()
  console.log(`\nall ${floors} AST bench floors passed`)
  process.exitCode = 0
}

main().catch((error) => {
  console.error('BENCH FAILURE:', error?.message ?? error)
  process.exitCode = 1
})
