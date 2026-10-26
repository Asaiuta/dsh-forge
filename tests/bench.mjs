/**
 * Performance benchmark for dsh-forge — floor-gated like eval-quality.
 *
 * Baseline is the spawn-a-process model the built-in search uses (one rg per
 * tool call). fff's advantage IS avoiding that, so the honest comparison is
 * warm in-process calls vs per-call process spawn on the same corpus.
 *
 * Corpus comes from `DSH_FORGE_BENCH_CORPUS` (falling back to the installed DSH
 * app plane) — any large, real, stable tree works. No `fd` is assumed, so the
 * discovery baseline is `rg --files` spawn cost, a proxy floor by construction.
 *
 * Floors (asserted, exit 1 on miss):
 *   F1  warm ffgrep p50 < rg-spawn p50
 *   F2  warm fffind p50 < rg --files spawn p50 (proxy)
 *   F3  warm ffgrep p95 < 300 ms absolute sanity ceiling
 *   F4  cold index wall time < 30 s on the default corpus
 *   F5  resident memory delta during indexing < 512 MB
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { FinderPool } from '../lib/core.js'
import { createGrepTool, createFindTool } from '../lib/tools.js'
import { localEnv } from '../scripts/local-env.mjs'

const CORPUS = localEnv('DSH_FORGE_BENCH_CORPUS') ?? localEnv('DSH_FORGE_DSH_MODULES', { required: true })
const RG = localEnv('DSH_FORGE_RG') ?? 'rg'
const REPS = 20

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

function rgAvailable() {
  try {
    const out = spawnSync(RG, ['--version'], { encoding: 'utf8', timeout: 10_000 })
    return out.status === 0
  } catch {
    return false
  }
}

function timeRg(args, cwd) {
  const start = performance.now()
  const out = spawnSync(RG, args, { cwd, stdio: ['ignore', 'ignore', 'ignore'], timeout: 60_000 })
  const ms = performance.now() - start
  return { ms, hits: out.status === 0 }
}

async function main() {
  if (!rgAvailable()) {
    console.error(`rg not runnable at ${RG} — set DSH_FORGE_RG`)
    process.exit(1)
  }
  const rgVersion = spawnSync(RG, ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0]

  // --- cold index ----------------------------------------------------------
  const pool = new FinderPool()
  const exec = { agent: { session: { header: { cwd: CORPUS } } } }
  const grep = createGrepTool(pool)
  const find = createFindTool(pool)
  const multi = grep // fff_multi_grep merged into ffgrep

  const rssBefore = process.memoryUsage.rss()
  const indexStart = performance.now()
  const first = await grep.execute({ pattern: 'export function', limit: 5 }, exec)
  const indexMs = performance.now() - indexStart
  assert.ok(!first.error, `first grep failed: ${first.error}`)
  const lease = await pool.main(CORPUS)
  assert.ok(!lease.error, `main lease failed: ${lease.error}`)
  const warmed = await lease.finder.waitForIndexReady(60_000)
  assert.ok(warmed.ok && warmed.value, 'index did not become ready in 60s')
  const rssAfter = process.memoryUsage.rss()
  const health = lease.finder.healthCheck()
  const indexedFiles = health.ok ? health.value.filePicker.indexedFiles ?? 0 : 0
  console.log(`corpus: ${CORPUS}`)
  console.log(`indexed files: ${indexedFiles}  cold-to-first-result: ${(indexMs / 1000).toFixed(2)}s  rss Δ: ${((rssAfter - rssBefore) / 1048576).toFixed(0)} MB`)
  console.log(`baseline: ${rgVersion}`)

  // --- pick queries that actually have hits (fair comparison) --------------
  const candidates = [
    'compaction', 'session', 'register', 'describe', 'cordis', 'plugin',
    'undefined', 'process.env', 'async function', 'export function',
    'return null', 'catch', 'toolName', 'JSON.stringify', 'import type',
  ]
  const queries = []
  for (const pattern of candidates) {
    const probe = timeRg(['-S', '-F', '-n', '--no-heading', '--no-config', pattern, '.'], CORPUS)
    if (probe.hits) queries.push(pattern)
    if (queries.length >= 10) break
  }
  assert.ok(queries.length >= 5, `only ${queries.length} candidate patterns had hits; corpus drift?`)
  console.log(`grep queries (${queries.length}): ${queries.join(', ')}`)

  // --- warm ffgrep vs rg spawn --------------------------------------------
  for (let w = 0; w < 3; w++) {
    for (const q of queries) await grep.execute({ pattern: q, limit: 30 }, exec)
  }
  const ffgrepMs = []
  const rgMs = []
  for (const q of queries) {
    for (let i = 0; i < REPS; i++) {
      const start = performance.now()
      await grep.execute({ pattern: q, limit: 30 }, exec)
      ffgrepMs.push(performance.now() - start)
    }
    for (let i = 0; i < REPS; i++) {
      rgMs.push(timeRg(['-S', '-F', '-n', '--no-heading', '--no-config', '-m', '30', q, '.'], CORPUS).ms)
    }
  }
  const ffgrepP50 = percentile(ffgrepMs, 50)
  const ffgrepP95 = percentile(ffgrepMs, 95)
  const rgP50 = percentile(rgMs, 50)
  const rgP95 = percentile(rgMs, 95)
  console.log(`\nffgrep  warm: p50 ${ffgrepP50.toFixed(2)}ms  p95 ${ffgrepP95.toFixed(2)}ms  (n=${ffgrepMs.length})`)
  console.log(`rg spawn     : p50 ${rgP50.toFixed(2)}ms  p95 ${rgP95.toFixed(2)}ms  (n=${rgMs.length})`)
  console.log(`speedup (p50): ${(rgP50 / ffgrepP50).toFixed(1)}x`)

  // --- warm fffind vs rg --files spawn ------------------------------------
  const findQueries = ['index', 'types', 'config', 'store', 'invariant', 'session']
  for (let w = 0; w < 3; w++) {
    for (const q of findQueries) await find.execute({ pattern: q, limit: 30 }, exec)
  }
  const fffindMs = []
  const rgFilesMs = []
  for (const q of findQueries) {
    for (let i = 0; i < REPS; i++) {
      const start = performance.now()
      await find.execute({ pattern: q, limit: 30 }, exec)
      fffindMs.push(performance.now() - start)
    }
    for (let i = 0; i < REPS; i++) {
      rgFilesMs.push(timeRg(['--files', '--no-config'], CORPUS).ms)
    }
  }
  const fffindP50 = percentile(fffindMs, 50)
  const rgFilesP50 = percentile(rgFilesMs, 50)
  console.log(`\nfffind  warm: p50 ${fffindP50.toFixed(2)}ms  (n=${fffindMs.length})`)
  console.log(`rg --files spawn (proxy baseline): p50 ${rgFilesP50.toFixed(2)}ms`)

  // --- multi-grep vs rg -e -e ---------------------------------------------
  const multiMs = []
  for (let i = 0; i < REPS; i++) {
    const start = performance.now()
    await multi.execute({ patterns: ['undefined', 'process.env', 'JSON.stringify'], limit: 30 }, exec)
    multiMs.push(performance.now() - start)
  }
  const rgMultiMs = []
  for (let i = 0; i < REPS; i++) {
    rgMultiMs.push(timeRg(['-S', '-F', '-n', '--no-heading', '--no-config', '-m', '30', '-e', 'undefined', '-e', 'process.env', '-e', 'JSON.stringify', '.'], CORPUS).ms)
  }
  const multiWarmP50 = percentile(multiMs, 50)
  const rgMultiP50 = percentile(rgMultiMs, 50)
  console.log(`\nffgrep patterns warm: p50 ${multiWarmP50.toFixed(2)}ms  rg -e -e -e spawn: p50 ${rgMultiP50.toFixed(2)}ms`)

  // --- floors --------------------------------------------------------------
  let floors = 0
  const pass = (label) => {
    floors++
    console.log(`  FLOOR ${floors} PASS - ${label}`)
  }
  assert.ok(ffgrepP50 < rgP50, `F1 violated: ffgrep p50 ${ffgrepP50.toFixed(2)}ms >= rg p50 ${rgP50.toFixed(2)}ms`)
  pass(`F1 ffgrep p50 < rg spawn p50 (${ffgrepP50.toFixed(2)} < ${rgP50.toFixed(2)})`)
  assert.ok(fffindP50 < rgFilesP50, `F2 violated: fffind p50 ${fffindP50.toFixed(2)}ms >= rg --files p50 ${rgFilesP50.toFixed(2)}ms`)
  pass(`F2 fffind p50 < rg --files spawn p50 (${fffindP50.toFixed(2)} < ${rgFilesP50.toFixed(2)})`)
  assert.ok(ffgrepP95 < 300, `F3 violated: ffgrep p95 ${ffgrepP95.toFixed(2)}ms >= 300ms`)
  pass(`F3 ffgrep p95 < 300ms (${ffgrepP95.toFixed(2)}ms)`)
  assert.ok(indexMs < 30_000, `F4 violated: cold index ${indexMs}ms >= 30s`)
  pass(`F4 cold-to-first-result < 30s (${(indexMs / 1000).toFixed(2)}s)`)
  assert.ok(rssAfter - rssBefore < 512 * 1048576, `F5 violated: rss Δ ${((rssAfter - rssBefore) / 1048576).toFixed(0)}MB >= 512MB`)
  pass(`F5 indexing rss Δ < 512MB (${((rssAfter - rssBefore) / 1048576).toFixed(0)}MB)`)

  pool.disposeAll()
  console.log(`\nall ${floors} bench floors passed`)
}

main().catch((error) => {
  console.error('BENCH FAILURE:', error?.message ?? error)
  process.exit(1)
})
