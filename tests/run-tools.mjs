/**
 * Tool-path unit tests for dsh-forge — pure Node, runs against built lib/
 * output (build first: `node build.mjs`).
 *
 * Exercises the same functions the cordis glue hands to defineTool, with a
 * fake exec carrying a fixture workspace cwd. Degrade paths (missing path,
 * bad root, fs-root refusal) must return structured errors, never throw.
 */

import assert from 'node:assert/strict'
import { FinderPool, workdirOf, isFsRoot, clampInt, globToRegExp, parseConstraints, dataDir } from '../lib/core.js'
import { createGrepTool, createFindTool, createMultiGrepTool, createStatusCommand } from '../lib/tools.js'
import { buildFixture, FIXTURE_DIR } from './make-fixture.mjs'

const truth = buildFixture()
const pool = new FinderPool()
const exec = { agent: { session: { header: { cwd: FIXTURE_DIR } } } }

const grep = createGrepTool(pool)
const find = createFindTool(pool)
const multi = createMultiGrepTool(pool)
const status = createStatusCommand(pool)

let passed = 0
function ok(label) {
  passed++
  console.log(`  ok ${passed} - ${label}`)
}

async function main() {
  // --- pure helpers -------------------------------------------------------
  assert.equal(workdirOf(undefined), process.cwd())
  assert.equal(workdirOf(exec), FIXTURE_DIR)
  ok('workdir resolution: exec cwd wins, process.cwd() fallback')

  assert.equal(isFsRoot('C:\\'), true)
  assert.equal(isFsRoot('/'), true)
  assert.equal(isFsRoot(FIXTURE_DIR), false)
  ok('fs-root guard recognizes drive roots and POSIX root')

  assert.deepEqual(parseConstraints('*.ts !test/ docs/'), { includes: ['*.ts', 'docs/'], excludes: ['test/'] })
  ok('constraint parsing: includes and !excludes')

  const re = globToRegExp('**/*.test.{js,ts}')
  assert.equal(re.test('src/a.test.js'), true)
  assert.equal(re.test('src/a.test.ts'), true)
  assert.equal(re.test('src/deep/b.test.js'), true)
  assert.equal(re.test('src/a.js'), false)
  ok('glob→regex: **, brace alternation, anchoring')

  assert.equal(clampInt(500, 30, 1, 200), 200)
  assert.equal(clampInt(undefined, 30, 1, 200), 30)
  assert.equal(clampInt(-5, 30, 0, 20), 0)
  ok('clampInt clamps and falls back')

  // --- ffgrep --------------------------------------------------------------
  {
    const result = await grep.execute({ pattern: 'putBlob' }, exec)
    assert.ok(!result.error, `grep failed: ${result.error}`)
    const files = new Set(result.items.map((i) => i.file))
    assert.ok(files.has('src/store.js'), 'store.js must match')
    assert.ok(files.has('src/login.js'), 'login.js call site must match')
    assert.ok(files.has('docs/guide.md'), 'docs mention must match (fff is language-agnostic)')
    assert.ok(result.items.every((i) => !i.file.startsWith('build/')), 'gitignored build/ must not appear')
    ok('ffgrep literal: definition + call site + prose, gitignored excluded')
  }
  {
    const result = await grep.execute({ pattern: 'putBlob' }, exec)
    const storeHit = result.items.find((i) => i.file === 'src/store.js')
    assert.equal(storeHit.line, truth.storePutBlob, `ground-truth line ${truth.storePutBlob}, got ${storeHit.line}`)
    ok('ffgrep line numbers match write-time ground truth')
  }
  {
    const result = await grep.execute({ pattern: 'PutBlob' }, exec)
    assert.ok(!result.error)
    assert.equal(result.items.length, 0, 'smart case: capitalized query must not match lowercase identifiers')
    ok('ffgrep smart case: uppercase query finds nothing')
  }
  {
    const result = await grep.execute({ pattern: 'putBlob|getBlob', mode: 'regex' }, exec)
    assert.ok(!result.error)
    const files = new Set(result.items.map((i) => i.file))
    assert.ok(files.has('src/store.js') && files.has('docs/guide.md'), 'regex alternation matches both')
    ok('ffgrep regex mode: alternation')
  }
  {
    const result = await grep.execute({ pattern: 'CRLF_TOKEN' }, exec)
    assert.ok(!result.error)
    const hit = result.items.find((i) => i.file === 'data/crlf.txt')
    assert.ok(hit, 'CRLF file must be searched')
    assert.equal(hit.line, truth.crlfToken)
    ok('ffgrep CRLF file matched with correct line number')
  }
  {
    const result = await grep.execute({ pattern: '中文标记' }, exec)
    assert.ok(!result.error)
    const hit = result.items.find((i) => i.file === 'data/unicode.md')
    assert.ok(hit, 'multibyte content must match')
    ok('ffgrep multibyte (CJK) content matched')
  }
  {
    const result = await grep.execute({ pattern: 'isEmail', path: 'src/nested' }, exec)
    assert.ok(!result.error, `scoped grep failed: ${result.error}`)
    assert.equal(result.items.length, 0, 'isEmail lives in src/, not src/nested/')
    const scoped = await grep.execute({ pattern: 'putUser', path: 'src/nested' }, exec)
    assert.ok(!scoped.error)
    assert.ok(scoped.items.some((i) => i.file === 'deep.ts') || scoped.items.some((i) => i.file.endsWith('deep.ts')),
      'aux finder on subdirectory finds its own files (relative to that sub-root)')
    ok('ffgrep path constraint: subdirectory scoping via aux finder')
  }
  {
    const result = await grep.execute({ pattern: 'putBlob', path: 'docs/*.md' }, exec)
    assert.ok(!result.error)
    assert.ok(result.items.every((i) => i.file.endsWith('.md')), 'glob constraint keeps only .md files')
    assert.ok(result.items.length > 0, 'guide.md mention survives the filter')
    ok('ffgrep glob constraint with post-filter')
  }
  {
    const result = await grep.execute({ pattern: 'e', limit: 5 }, exec)
    assert.ok(!result.error)
    assert.ok(result.items.length >= 1 && result.items.length <= 205,
      `page must be non-empty and bounded (limit target 5 + per-file cap slack), got ${result.items.length}`)
    if (result.nextCursor) {
      const next = await grep.execute({ pattern: 'e', limit: 5, cursor: result.nextCursor }, exec)
      assert.ok(!next.error)
      const seen = new Set(result.items.map((i) => `${i.file}:${i.line}`))
      for (const item of next.items) {
        assert.ok(!seen.has(`${item.file}:${item.line}`), 'next page must not repeat page-one hits')
      }
    }
    ok('ffgrep page targeting + cursor pagination: no overlap, nextCursor honored')
  }
  {
    const bad = await grep.execute({ pattern: '' }, exec)
    assert.match(bad.error, /pattern is required/)
    const noRoot = await grep.execute({ pattern: 'x' }, { agent: { session: { header: { cwd: 'Z:\\definitely\\missing\\dir' } } } })
    assert.ok(noRoot.error || Array.isArray(noRoot.items), 'missing root must not throw')
    ok('ffgrep degrade paths return structured errors, no throw')
  }

  // --- fffind --------------------------------------------------------------
  {
    const result = await find.execute({ pattern: 'store.js' }, exec)
    assert.ok(!result.error, `find failed: ${result.error}`)
    const top5 = result.items.slice(0, 5).map((i) => i.path)
    assert.ok(top5.some((p) => p.endsWith('store.js')), `store.js in top5, got ${JSON.stringify(top5)}`)
    ok('fffind exact-name query hits top-5')
  }
  {
    // fffind matches file PATHS fuzzily, not symbols inside files — symbol
    // search is stage 2 (AST). A typo'd filename must still surface.
    const result = await find.execute({ pattern: 'stroe' }, exec)
    assert.ok(!result.error)
    const top10 = result.items.slice(0, 10).map((i) => i.path)
    assert.ok(top10.some((p) => p.endsWith('store.js')), `transposed query (stroe) finds store.js in top10, got ${JSON.stringify(top10)}`)
    ok('fffind typo-tolerant path query (stroe → store.js) hits top-10')
  }
  {
    const result = await find.execute({ pattern: 'generated.js' }, exec)
    assert.ok(!result.error)
    assert.ok(!result.items.some((i) => i.path.includes('generated.js')), 'gitignored files stay out of the index')
    ok('fffind respects gitignore')
  }
  {
    const result = await find.execute({ pattern: '' }, exec)
    assert.match(result.error, /pattern is required/)
    ok('fffind degrade: empty pattern is a structured error')
  }

  // --- fff_multi_grep ------------------------------------------------------
  {
    const result = await multi.execute({ patterns: ['putBlob', 'getBlob'] }, exec)
    assert.ok(!result.error, `multi failed: ${result.error}`)
    const texts = result.items.map((i) => i.text)
    assert.ok(texts.some((t) => t.includes('putBlob')) && texts.some((t) => t.includes('getBlob')),
      'OR logic returns both patterns')
    ok('fff_multi_grep: both patterns present in one pass')
  }
  {
    const single1 = await grep.execute({ pattern: 'putBlob' }, exec)
    const single2 = await grep.execute({ pattern: 'getBlob' }, exec)
    const combined = await multi.execute({ patterns: ['putBlob', 'getBlob'] }, exec)
    const key = (i) => `${i.file}:${i.line}`
    const union = new Set([...single1.items, ...single2.items].map(key))
    for (const item of combined.items) {
      assert.ok(union.has(key(item)), `multi-grep hit ${key(item)} must exist in per-pattern union`)
    }
    ok('fff_multi_grep result set ⊆ per-pattern ffgrep union (semantics equal on overlap page)')
  }
  {
    const bad = await multi.execute({ patterns: ['only-one'] }, exec)
    assert.match(bad.error, /at least 2/)
    ok('fff_multi_grep degrade: single pattern rejected with guidance')
  }

  // --- /forge-status -------------------------------------------------------
  {
    // Ensure a finder exists (previous calls created one).
    await grep.execute({ pattern: 'putBlob' }, exec)
    const result = await status.handler({ rawInput: '' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /dsh-forge/)
    assert.match(result.text, /frecency/)
    ok('/forge-status reports live engine state')
  }
  {
    const result = await status.handler({ rawInput: 'rescan' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /重扫|就绪|扫描中/)
    ok('/forge-status rescan triggers without error')
  }

  // --- data dir default ----------------------------------------------------
  assert.match(dataDir(), /[\\/]\.dsh[\\/]forge$/)
  ok(`data dir default: ${dataDir()}`)

  pool.disposeAll()
  console.log(`\n${passed} assertions groups passed`)
}

main().catch((error) => {
  console.error('FATAL', error)
  process.exit(1)
})
