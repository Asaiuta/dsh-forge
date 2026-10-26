/**
 * Quality eval for dsh-forge — blackhole-style floor gates.
 *
 * Floors are asserted, not reported: any miss exits non-zero. Floors may only
 * be tightened over time, never relaxed (same policy as dsh-blackhole's
 * eval-quality).
 *
 * The oracle is computed independently of fff: a plain Node walk over the
 * fixture with literal line matching and smart-case rules. Recall/precision
 * compare engine output against that oracle.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FinderPool } from '../lib/core.js'
import { createGrepTool, createFindTool } from '../lib/tools.js'
import { buildFixture, FIXTURE_DIR } from './make-fixture.mjs'

const truth = buildFixture()

// ---------------------------------------------------------------------------
// Independent oracle: walk + literal line match with fff's smart-case rules
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['.git', 'node_modules'])
const BINARY_EXT = new Set(['.png', '.jpg', '.exe', '.dll', '.node', '.zip'])

function isGitIgnored(rel) {
  return rel.startsWith('build/') || rel.startsWith('logs/') || rel.endsWith('.log')
}

function walk(dir, base = '', acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), base === '' ? entry.name : `${base}/${entry.name}`, acc)
    } else if (entry.isFile()) {
      const rel = base === '' ? entry.name : `${base}/${entry.name}`
      if (BINARY_EXT.has(path.extname(rel))) continue
      acc.push(rel)
    }
  }
  return acc
}

/** Lines where the literal pattern matches under smart-case semantics. */
function oracleLines(rel, pattern) {
  const smartCase = pattern === pattern.toLowerCase()
  const haystack = smartCase ? pattern.toLowerCase() : pattern
  const abs = path.join(FIXTURE_DIR, rel)
  const raw = readFileSync(abs, 'utf8')
  // fff normalizes EOL for line math; mirror that for the CRLF fixture file.
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const hits = []
  lines.forEach((line, i) => {
    const probe = smartCase ? line.toLowerCase() : line
    if (probe.includes(haystack)) hits.push({ file: rel, line: i + 1 })
  })
  return hits
}

function oracleFor(pattern) {
  const all = walk(FIXTURE_DIR)
    .filter((rel) => !isGitIgnored(rel))
  return all.flatMap((rel) => oracleLines(rel, pattern))
}

// ---------------------------------------------------------------------------
// Floors
// ---------------------------------------------------------------------------

let floorsPassed = 0
function floor(name, label) {
  floorsPassed++
  console.log(`  FLOOR ${floorsPassed} PASS - ${name}: ${label}`)
}

async function main() {
  const pool = new FinderPool()
  const exec = { agent: { session: { header: { cwd: FIXTURE_DIR } } } }
  const grep = createGrepTool(pool)
  const find = createFindTool(pool)
  const multi = grep // fff_multi_grep merged into ffgrep

  // Warm the index once (first call pays the scan; wait it out).
  const warm = await grep.execute({ pattern: 'putBlob', limit: 200 }, exec)
  assert.ok(!warm.error, `warm-up grep failed: ${warm.error}`)
  if (warm.warming) {
    // Wait for warmup to settle so floors measure steady state, not scan races.
    const lease = await pool.main(FIXTURE_DIR)
    if (!lease.error) await lease.finder.waitForIndexReady(30_000)
    const settled = await grep.execute({ pattern: 'putBlob', limit: 200 }, exec)
    assert.ok(!settled.error)
    Object.assign(warm, { items: settled.items, warming: settled.warming })
  }

  // Floor 1: literal recall vs oracle = 100% (no missed hits), for a corpus
  // spanning JS/TS/Python/Rust/Markdown/CJK/CRLF and definition + reference +
  // prose occurrences.
  const LITERAL_PATTERNS = ['putBlob', 'getBlob', 'isEmail', 'compute_score', 'CRLF_TOKEN', '中文标记', 'normalize_path']
  for (const pattern of LITERAL_PATTERNS) {
    const result = await grep.execute({ pattern, limit: 200 }, exec)
    assert.ok(!result.error, `grep ${pattern}: ${result.error}`)
    const got = new Set(result.items.map((i) => `${i.file}:${i.line}`))
    const expected = oracleFor(pattern)
    assert.ok(expected.length > 0, `oracle for ${pattern} must be non-empty (fixture drift)`)
    const missed = expected.filter((h) => !got.has(`${h.file}:${h.line}`))
    assert.deepEqual(missed, [], `recall floor violated for "${pattern}": missed ${JSON.stringify(missed)}`)
  }
  floor('grep-recall', `100% literal recall on ${LITERAL_PATTERNS.length} patterns across 7 file kinds`)

  // Floor 2: smart-case precision — capitalized query on lowercase corpus
  // must produce zero false positives.
  {
    const result = await grep.execute({ pattern: 'PutBlob', limit: 200 }, exec)
    assert.ok(!result.error)
    assert.equal(result.items.length, 0, 'smart case must not match lowercase identifiers for a capitalized query')
  }
  floor('grep-smartcase-precision', 'capitalized query: 0 false positives')

  // Floor 3: precision vs oracle — every engine hit is a real oracle hit
  // (no invented lines).
  for (const pattern of ['putBlob', 'isEmail']) {
    const result = await grep.execute({ pattern, limit: 200 }, exec)
    const oracleSet = new Set(oracleFor(pattern).map((h) => `${h.file}:${h.line}`))
    for (const item of result.items) {
      assert.ok(oracleSet.has(`${item.file}:${item.line}`),
        `engine reported non-oracle hit ${item.file}:${item.line} for ${pattern}`)
    }
  }
  floor('grep-precision', 'no invented hits (2 patterns)')

  // Floor 4: determinism — two identical calls return identical item arrays.
  {
    const a = await grep.execute({ pattern: 'putBlob', limit: 200, context: 1 }, exec)
    const b = await grep.execute({ pattern: 'putBlob', limit: 200, context: 1 }, exec)
    assert.deepEqual(a.items, b.items, 'repeated call must be byte-identical')
  }
  floor('grep-determinism', 'identical calls → identical output')

  // Floor 5: pagination closure — walking pages unites to the single big page.
  {
    const single = await grep.execute({ pattern: 'e', limit: 200 }, exec)
    const walked = new Map()
    let cursor
    for (let page = 0; page < 50; page++) {
      const res = await grep.execute({ pattern: 'e', limit: 5, ...(cursor ? { cursor } : {}) }, exec)
      assert.ok(!res.error, `paged grep failed: ${res.error}`)
      for (const item of res.items) walked.set(`${item.file}:${item.line}`, item)
      if (!res.nextCursor) break
      cursor = res.nextCursor
    }
    const singleKeys = new Set(single.items.map((i) => `${i.file}:${i.line}`))
    assert.equal(walked.size, singleKeys.size,
      `paged union (${walked.size}) must equal single-page (${singleKeys.size})`)
    for (const key of walked.keys()) assert.ok(singleKeys.has(key), `paged hit ${key} missing from single page`)
  }
  floor('grep-pagination-closure', 'page-walk union == single big page')

  // Floor 6: find recall — exact names in top-3, typo in top-10.
  {
    const cases = [
      { query: 'store.js', want: 'store.js', k: 3 },
      { query: 'validate.js', want: 'validate.js', k: 3 },
      { query: 'guide.md', want: 'guide.md', k: 3 },
      { query: 'utils.py', want: 'utils.py', k: 3 },
      { query: 'deep.ts', want: 'deep.ts', k: 3 },
      { query: 'stroe', want: 'store.js', k: 10 },
      { query: 'utls', want: 'utils.py', k: 10 },
      { query: 'scoring.rs', want: 'scoring.rs', k: 3 },
    ]
    for (const c of cases) {
      const result = await find.execute({ pattern: c.query, limit: 50 }, exec)
      assert.ok(!result.error, `find ${c.query}: ${result.error}`)
      const top = result.items.slice(0, c.k).map((i) => i.path)
      assert.ok(top.some((p) => p.endsWith(c.want)),
        `find "${c.query}" must surface ${c.want} in top-${c.k}; got ${JSON.stringify(top)}`)
    }
  }
  floor('find-recall', '6 exact names in top-3, 2 typo paths in top-10')

  // Floor 7: multi-grep equals the union of single greps (same limits).
  {
    const p1 = await grep.execute({ pattern: 'putBlob', limit: 200 }, exec)
    const p2 = await grep.execute({ pattern: 'getBlob', limit: 200 }, exec)
    const p3 = await grep.execute({ pattern: 'putUser', limit: 200 }, exec)
    const unionKeys = new Set([...p1.items, ...p2.items, ...p3.items].map((i) => `${i.file}:${i.line}`))
    const combined = await multi.execute({ patterns: ['putBlob', 'getBlob', 'putUser'], limit: 200 }, exec)
    assert.ok(!combined.error, `multi failed: ${combined.error}`)
    const combinedKeys = new Set(combined.items.map((i) => `${i.file}:${i.line}`))
    assert.deepEqual([...combinedKeys].sort(), [...unionKeys].sort(),
      'multi-grep line set must equal the per-pattern union')
  }
  floor('multi-grep-semantics', '3-pattern OR == union of singles (exact)')

  // Floor 8: ignore rules — nothing from gitignored paths, anywhere.
  {
    const probes = [
      await grep.execute({ pattern: 'IGNORED_BUILD_TOKEN', limit: 200 }, exec),
      await grep.execute({ pattern: 'IGNORED_LOG_TOKEN', limit: 200 }, exec),
      await find.execute({ pattern: 'generated.js', limit: 50 }, exec),
    ]
    for (const res of probes) {
      assert.ok(!res.error)
      assert.equal((res.items ?? []).length, 0, 'gitignored content must never surface')
    }
  }
  floor('ignore-respected', 'build/ and logs/ content absent from grep and find')

  // Floor 9: context lines carry the true neighbor content.
  {
    const wantLine = truth.storePutBlob
    const result = await grep.execute({ pattern: 'putBlob', limit: 200, context: 2 }, exec)
    const hit = result.items.find((i) => i.file === 'src/store.js' && i.line === wantLine)
    assert.ok(hit, 'hit present')
    assert.ok(hit.context && hit.context.length === 4, `context=2 must yield 4 lines, got ${hit.context?.length}`)
    const raw = readFileSync(path.join(FIXTURE_DIR, 'src/store.js'), 'utf8').replace(/\r\n/g, '\n').split('\n')
    for (const ctx of hit.context) {
      assert.equal(ctx.text, raw[ctx.line - 1] ?? '', `context line ${ctx.line} content must match the file`)
    }
  }
  floor('context-accuracy', 'context line numbers and content match the file exactly')

  pool.disposeAll()
  console.log(`\nall ${floorsPassed} floors passed`)
}

main().catch((error) => {
  console.error('EVAL FAILURE:', error?.message ?? error)
  process.exit(1)
})
