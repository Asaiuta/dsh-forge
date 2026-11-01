/**
 * Tool-path unit tests for dsh-forge — pure Node, runs against built lib/
 * output (build first: `node build.mjs`).
 *
 * Exercises the same functions the cordis glue hands to defineTool, with a
 * fake exec carrying a fixture workspace cwd. Degrade paths (missing path,
 * bad root, fs-root refusal) must return structured errors, never throw.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { FinderPool, workdirOf, isFsRoot, clampInt, globToRegExp, parseConstraints, dataDir, weakNameMatch, GREP_MAX_MATCHES_PER_FILE } from '../lib/core.js'
import { createGrepTool, createFindTool } from '../lib/tools.js'
import { createStatusCommand } from '../lib/status.js'
import { buildFixture, FIXTURE_DIR } from './make-fixture.mjs'

const truth = buildFixture()
const pool = new FinderPool()
const exec = { agent: { session: { header: { cwd: FIXTURE_DIR } } } }

const grep = createGrepTool(pool)
const find = createFindTool(pool)
const multi = grep // fff_multi_grep was merged into ff_grep: same {patterns} call, same result shape
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
  if (process.platform === 'win32') {
    // Regression: `path.parse('C:\\Users').dir` is `C:\\`, so the old
    // `root === dir` form refused every top-level directory on a drive — the
    // exact re-root the guidance promises ("another checkout, another drive").
    assert.equal(isFsRoot('C:\\Users'), false)
    assert.equal(isFsRoot('F:\\work'), false)
    assert.equal(isFsRoot('D:\\work'), false)
    assert.equal(isFsRoot('\\\\server\\share'), true, 'UNC share root stays refused')
  } else {
    assert.equal(isFsRoot('/usr'), false)
    assert.equal(isFsRoot('/usr/local/'), false)
  }
  ok('fs-root guard: real roots refused, one-segment paths on a drive allowed')

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

  // --- ff_grep --------------------------------------------------------------
  {
    const result = await grep.execute({ pattern: 'putBlob' }, exec)
    assert.ok(!result.error, `grep failed: ${result.error}`)
    const files = new Set(result.items.map((i) => i.file))
    assert.ok(files.has('src/store.js'), 'store.js must match')
    assert.ok(files.has('src/login.js'), 'login.js call site must match')
    assert.ok(files.has('docs/guide.md'), 'docs mention must match (fff is language-agnostic)')
    assert.ok(result.items.every((i) => !i.file.startsWith('build/')), 'gitignored build/ must not appear')
    ok('ff_grep literal: definition + call site + prose, gitignored excluded')
  }
  {
    const result = await grep.execute({ pattern: 'putBlob' }, exec)
    const storeHit = result.items.find((i) => i.file === 'src/store.js')
    assert.equal(storeHit.line, truth.storePutBlob, `ground-truth line ${truth.storePutBlob}, got ${storeHit.line}`)
    ok('ff_grep line numbers match write-time ground truth')
  }
  {
    // Literal mode: smart case is exact, so a capitalized spelling that only
    // exists in lowercase must not match. (Fuzzy mode deliberately tolerates a
    // transposed or differently-cased spelling — that is its job, asserted
    // below with 'putBlbo'.)
    const result = await grep.execute({ patterns: ['PutBlob', 'GetBlob'] }, exec)
    assert.ok(!result.error)
    assert.equal(result.items.length, 0, 'smart case: capitalized literals must not match lowercase identifiers')
    ok('ff_grep smart case: uppercase literals find nothing')
  }
  {
    const result = await grep.execute({ pattern: 'CRLF_TOKEN' }, exec)
    assert.ok(!result.error)
    const hit = result.items.find((i) => i.file === 'data/crlf.txt')
    assert.ok(hit, 'CRLF file must be searched')
    assert.equal(hit.line, truth.crlfToken)
    ok('ff_grep CRLF file matched with correct line number')
  }
  {
    const result = await grep.execute({ pattern: '中文标记' }, exec)
    assert.ok(!result.error)
    const hit = result.items.find((i) => i.file === 'data/unicode.md')
    assert.ok(hit, 'multibyte content must match')
    ok('ff_grep multibyte (CJK) content matched')
  }
  {
    // `context` outranks typo tolerance: fuzzy hits carry no context lines at
    // all (fff 0.11.0), so serving a context request fuzzily would page a hit
    // whose surrounding lines were silently dropped. It also pins the second
    // effect — the literal match is exact, so `getBlob` no longer rides along
    // as a fuzzy near-miss of `putBlob`.
    const result = await grep.execute({ pattern: 'putBlob', context: 2 }, exec)
    assert.ok(!result.error)
    const hit = result.items.find((i) => i.file === 'src/store.js')
    assert.ok(hit, 'definition must match')
    assert.equal(hit.line, truth.storePutBlob)
    assert.equal(hit.context?.length, 4, `context=2 must attach 4 lines, got ${hit.context?.length}`)
    assert.ok(!result.items.some((i) => i.file === 'src/store.js' && i.line === truth.storeGetBlob),
      'context request must not drag the fuzzy getBlob near-miss in')
    ok('ff_grep context: implies literal match and attaches neighbor lines')
  }
  {
    const result = await grep.execute({ pattern: 'isEmail', path: 'src/nested' }, exec)
    assert.ok(!result.error, `scoped grep failed: ${result.error}`)
    assert.equal(result.items.length, 0, 'isEmail lives in src/, not src/nested/')
    const scoped = await grep.execute({ pattern: 'putUser', path: 'src/nested' }, exec)
    assert.ok(!scoped.error)
    assert.ok(scoped.items.some((i) => i.file === 'deep.ts') || scoped.items.some((i) => i.file.endsWith('deep.ts')),
      'aux finder on subdirectory finds its own files (relative to that sub-root)')
    ok('ff_grep path constraint: subdirectory scoping via aux finder')
  }
  {
    const result = await grep.execute({ pattern: 'putBlob', path: 'docs/*.md' }, exec)
    assert.ok(!result.error)
    assert.ok(result.items.every((i) => i.file.endsWith('.md')), 'glob constraint keeps only .md files')
    assert.ok(result.items.length > 0, 'guide.md mention survives the filter')
    ok('ff_grep glob constraint with post-filter')
  }
  {
    // A hit that the `path=` constraint dropped is NOT an absence on disk. The
    // disk walk would have answered "exists on disk — matching is case-sensitive"
    // here, which is a wrong root cause: the caller would go rewrite the pattern
    // while the actual fix is to widen the path.
    const result = await grep.execute({ pattern: 'isEmail', path: 'docs/*.md' }, exec)
    assert.ok(!result.error, `scoped grep failed: ${result.error}`)
    assert.equal(result.items.length, 0, 'isEmail only lives under src/, so the .md constraint drops every hit')
    assert.match(result.note ?? '', /matched outside path=/, `scope note missing, got: ${result.note}`)
    assert.doesNotMatch(result.note ?? '', /case-sensitive|not indexed at this scope/,
      `disk-level diagnosis must not be used when the index did return hits: ${result.note}`)
    ok('ff_grep empty page names the path constraint instead of inventing a disk-level absence')
  }
  {
    // The per-file cap is a hard cut with no cursor behind it: the engine stops
    // collecting inside a file and moves on. At the engine default of 200 that
    // was 800 lines of a 1000-match file vanishing from a "complete" answer.
    const capDir = path.join(path.dirname(FIXTURE_DIR), '.fixture-cap')
    fs.rmSync(capDir, { recursive: true, force: true })
    fs.mkdirSync(capDir, { recursive: true })
    const lines = 3_000
    fs.writeFileSync(path.join(capDir, 'hot.ts'),
      Array.from({ length: lines }, (_, i) => `const l${i} = 'CAPTOKEN'`).join('\n') + '\n')
    try {
      const result = await grep.execute({ pattern: 'CAPTOKEN', path: capDir, limit: 30 }, exec)
      assert.ok(!result.error, `cap grep failed: ${result.error}`)
      assert.equal(result.items.length, 30, 'the public page budget is strict even for a capped file')
      const all = [...result.items]
      let cursor = result.nextCursor
      for (let n = 0; cursor && n < 100; n++) {
        const next = await grep.execute({ pattern: 'CAPTOKEN', path: capDir, limit: 30, cursor }, exec)
        assert.ok(!next.error, next.error)
        assert.ok(next.items.length <= 30, 'every continuation respects the same page budget')
        all.push(...next.items)
        cursor = next.nextCursor
      }
      assert.equal(cursor, undefined, 'capped engine results must eventually exhaust')
      assert.equal(all.length, GREP_MAX_MATCHES_PER_FILE, 'paging preserves every hit up to the engine cap')
      assert.equal(new Set(all.map(item => `${item.file}:${item.line}`)).size, all.length, 'paging never duplicates a hit')
      assert.match(result.note ?? '', /per-file cap/, `capped answer must say so: ${result.note}`)
      assert.match(result.note ?? '', /hot\.ts/, `note must name the capped file: ${result.note}`)
      ok(`ff_grep per-file cap: ${GREP_MAX_MATCHES_PER_FILE} lines kept, the cut is announced with the file name`)
    } finally {
      fs.rmSync(capDir, { recursive: true, force: true })
    }
  }
  {
    const result = await grep.execute({ pattern: 'e', limit: 5 }, exec)
    assert.ok(!result.error)
    assert.ok(result.items.length >= 1 && result.items.length <= 5,
      `page must respect the strict limit of 5, got ${result.items.length}`)
    if (result.nextCursor) {
      const next = await grep.execute({ pattern: 'e', limit: 5, cursor: result.nextCursor }, exec)
      assert.ok(!next.error)
      const seen = new Set(result.items.map((i) => `${i.file}:${i.line}`))
      for (const item of next.items) {
        assert.ok(!seen.has(`${item.file}:${item.line}`), 'next page must not repeat page-one hits')
      }
    }
    ok('ff_grep page targeting + cursor pagination: no overlap, nextCursor honored')
  }
  {
    const bad = await grep.execute({ pattern: '' }, exec)
    assert.match(bad.error, /pattern is required/)
    const noRoot = await grep.execute({ pattern: 'x' }, { agent: { session: { header: { cwd: 'Z:\\definitely\\missing\\dir' } } } })
    assert.ok(noRoot.error || Array.isArray(noRoot.items), 'missing root must not throw')
    ok('ff_grep degrade paths return structured errors, no throw')
  }

  // --- ff_find --------------------------------------------------------------
  {
    const result = await find.execute({ pattern: 'store.js' }, exec)
    assert.ok(!result.error, `find failed: ${result.error}`)
    const top5 = result.items.slice(0, 5).map((i) => i.path)
    assert.ok(top5.some((p) => p.endsWith('store.js')), `store.js in top5, got ${JSON.stringify(top5)}`)
    ok('ff_find exact-name query hits top-5')
  }
  {
    // ff_find matches file PATHS fuzzily, not symbols inside files — symbol
    // search is stage 2 (AST). A typo'd filename must still surface.
    const result = await find.execute({ pattern: 'stroe' }, exec)
    assert.ok(!result.error)
    const top10 = result.items.slice(0, 10).map((i) => i.path)
    assert.ok(top10.some((p) => p.endsWith('store.js')), `transposed query (stroe) finds store.js in top10, got ${JSON.stringify(top10)}`)
    ok('ff_find typo-tolerant path query (stroe → store.js) hits top-10')
  }
  {
    const result = await find.execute({ pattern: 'generated.js' }, exec)
    assert.ok(!result.error)
    assert.ok(!result.items.some((i) => i.path.includes('generated.js')), 'gitignored files stay out of the index')
    ok('ff_find respects gitignore')
  }
  {
    // Same split as ff_grep: `path=` dropped every name the index offered, so the
    // page is empty for a scope reason — not because the file is missing.
    const result = await find.execute({ pattern: 'store', path: 'docs/*.md' }, exec)
    assert.ok(!result.error, `scoped find failed: ${result.error}`)
    assert.equal(result.items.length, 0, 'store.js is not a .md file')
    assert.match(result.note ?? '', /fell outside path=/, `scope note missing, got: ${result.note}`)
    assert.doesNotMatch(result.note ?? '', /exists on disk/, `must not claim a disk-level absence: ${result.note}`)
    ok('ff_find empty page names the path constraint instead of "exists on disk"')
  }
  {
    const result = await find.execute({ pattern: '' }, exec)
    assert.match(result.error, /pattern is required/)
    ok('ff_find degrade: empty pattern is a structured error')
  }

  // --- the retrieval surface: what ff_grep/ff_find own, and what they refuse ---
  // The built-in grep/glob own plain, regex and path-pattern listing. These two
  // tools own fuzzy content, multi-literal OR and typo-tolerant names, and say
  // where the rest lives rather than silently accepting a mode they ignore.
  {
    const result = await grep.execute({ pattern: 'putBlbo' }, exec)
    assert.ok(!result.error, `fuzzy grep failed: ${result.error}`)
    assert.ok(result.items.length > 0, 'fuzzy grep should tolerate a transposed identifier')
    ok('ff_grep defaults a single pattern to fuzzy search')
  }
  {
    const plain = await grep.execute({ pattern: 'putBlob', mode: 'plain' }, exec)
    assert.match(plain.error, /no mode/)
    const regex = await grep.execute({ pattern: 'putBlob', mode: 'regex' }, exec)
    assert.match(regex.error, /no mode/)
    ok('ff_grep refuses plain and regex: those belong to the built-in grep')
  }
  {
    const result = await grep.execute({ patterns: ['putBlob', 'getBlob'] }, exec)
    assert.ok(!result.error, `multi-pattern grep failed: ${result.error}`)
    const texts = result.items.map((item) => item.text)
    assert.ok(texts.some((text) => text.includes('putBlob')) && texts.some((text) => text.includes('getBlob')),
      'multi-pattern grep must retain OR semantics')
    ok('ff_grep retains multi-literal OR search')
  }
  {
    // Symbol attachment is ff_symbols's job: the address it needs is produced by
    // view=definitions, and a second mechanism here would be a second answer.
    const result = await grep.execute({ pattern: 'putBlob', enclosing: true }, exec)
    assert.match(result.error, /does not attach symbols/)
    ok('ff_grep leaves symbol structure to ff_symbols')
  }
  {
    const result = await find.execute({ pattern: 'stroe' }, exec)
    assert.ok(!result.error, `fuzzy find failed: ${result.error}`)
    assert.ok(result.items.slice(0, 10).some((item) => item.path.endsWith('store.js')),
      `fuzzy filename query should find store.js, got ${JSON.stringify(result.items.slice(0, 10))}`)
    const glob = await find.execute({ pattern: '**/*.js', mode: 'glob' }, exec)
    assert.match(glob.error, /no mode/)
    ok('ff_find keeps fuzzy names and refuses glob mode: that is the built-in glob')
  }

  // --- ff_find: the "wrong tool" signal --------------------------------------
  // A name search only answers a name question. When the query names no file at
  // all, fff still returns its best fuzzy coincidences; with no note, one line
  // of output reads exactly like a hit. A real session took it at face value and
  // stopped using the tool for the rest of the run.
  {
    const item = (p, match = 'fuzzy_filename') => ({
      path: p, name: p.split('/').pop(), score: 70, match, git: 'clean', frecency: 0, size: 1, modified: '2026-01-01',
    })
    // No path contains the query and only a couple of coincidences came back.
    assert.equal(weakNameMatch('dsh-forge', [item('scripts/patch-workspace-changes.mjs')]), true)
    // Real session (2026-10-31): six coincidences at score 80–96 for a name that
    // exists nowhere under that root. The old 3-item ceiling let all six through
    // with no note at all, and the caller read them as candidates.
    const junk = (p, score) => ({
      path: p, name: p.split('/').pop(), score, match: 'fuzzy_path', git: 'clean', frecency: 0, size: 1, modified: '2026-10-26',
    })
    assert.equal(weakNameMatch('reverse-workbench', [
      junk('archive/x/p0-adoption-baseline-2026-10-26.md', 96),
      junk('few-shots-work/pylibs/torch/include/ATen/ops/x.h', 92),
      junk('archive/y/report.jsonl', 86),
      junk('archive/z/a.md', 80),
      junk('archive/z/b.md', 80),
      junk('archive/z/c.md', 80),
    ]), true)
    // A short list of plausible candidates above the coincidence floor is quiet.
    assert.equal(weakNameMatch('stramManager', [junk('src/stream-manager.ts', 220)]), false)
    // A literal prefix is an answer, not a coincidence (score 116 in the probe).
    assert.equal(weakNameMatch('guidanc', [item('src/guidance.ts')]), false)
    // An exact name is an answer (score 219 in the probe).
    assert.equal(weakNameMatch('guidance.ts', [item('src/guidance.ts', 'exact_filename')]), false)
    // A typo query returns a ranked list; the ranking is the answer (50 hits in
    // the probe, vs 1 for a query that names no file).
    assert.equal(weakNameMatch('stroe', Array.from({ length: 50 }, (_, i) => item(`src/f${i}.ts`))), false)
    // Multi-term: every term must be absent before the note fires.
    assert.equal(weakNameMatch('src/ guid', [item('src/guidance.ts')]), false)
    assert.equal(weakNameMatch('   ', [item('src/a.ts')]), false)
    assert.equal(weakNameMatch('nope', []), false)
    ok('ff_find weak-name-match detection: no literal occurrence AND a handful of hits')
  }
  {
    const value = {
      items: [{
        path: 'scripts/patch-workspace-changes.mjs', name: 'patch-workspace-changes.mjs', score: 70,
        match: 'fuzzy_filename', git: 'clean', frecency: 0, size: 1, modified: '2026-10-12',
      }],
      totalMatched: 1,
    }
    const out = find.output.render({ pattern: 'dsh-forge' }, value).map((b) => b.text).join('')
    assert.ok(out.includes('no file name contains "dsh-forge"'), `expected the wrong-tool note, got ${JSON.stringify(out)}`)
    assert.ok(out.includes('ff_grep'), 'the note must name the tool that answers content queries')
    ok('ff_find render says outright that no file name matched the query')
  }
  {
    const value = {
      items: [{
        path: 'src/guidance.ts', name: 'guidance.ts', score: 219,
        match: 'exact_filename', git: 'clean', frecency: 2, size: 1, modified: '2026-10-12',
      }],
      totalMatched: 57,
    }
    const out = find.output.render({ pattern: 'guidance.ts' }, value).map((b) => b.text).join('')
    assert.ok(!out.includes('no file name contains'), 'a literal hit must not be annotated')
    assert.ok(out.includes('showing 1 of 57'), `the cap must be visible, got ${JSON.stringify(out)}`)
    ok('ff_find render exposes the cap and leaves a literal hit unannotated')
  }
  {
    // The built-in glob tool takes shell patterns, so models paste globs here;
    // flag it even when fuzzy hits exist (a plausible coincidence reads as an
    // answer otherwise).
    const value = {
      items: [{
        path: 'src/guidance.ts', name: 'guidance.ts', score: 100,
        match: 'fuzzy_filename', git: 'clean', frecency: 0, size: 1, modified: '2026-10-13',
      }],
      totalMatched: 1,
    }
    const out = find.output.render({ pattern: 'src/**/*.ts' }, value).map((b) => b.text).join('')
    assert.ok(out.includes('pattern looks like a glob'), `glob-shaped pattern must be annotated, got ${JSON.stringify(out)}`)
    ok('ff_find render flags glob-shaped patterns')
  }

  // --- ff_grep with patterns[] (absorbed from fff_multi_grep) ---------------
  {
    const result = await multi.execute({ patterns: ['putBlob', 'getBlob'] }, exec)
    assert.ok(!result.error, `multi failed: ${result.error}`)
    const texts = result.items.map((i) => i.text)
    assert.ok(texts.some((t) => t.includes('putBlob')) && texts.some((t) => t.includes('getBlob')),
      'OR logic returns both patterns')
    ok('ff_grep patterns: both patterns present in one pass')
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
    ok('ff_grep patterns result set ⊆ per-pattern union (semantics equal on overlap page)')
  }
  {
    const bad = await multi.execute({ patterns: ['only-one'] }, exec)
    assert.match(bad.error, /at least 2/)
    ok('ff_grep patterns degrade: single pattern rejected with guidance')
  }
  {
    const both = await multi.execute({ pattern: 'putBlob', patterns: ['a', 'b'] }, exec)
    assert.match(both.error, /not both/)
    const none = await multi.execute({}, exec)
    assert.match(none.error, /pattern is required/)
    const withMode = await multi.execute({ patterns: ['a', 'b'], mode: 'regex' }, exec)
    assert.match(withMode.error, /no mode/)
    ok('ff_grep: pattern/patterns are mutually exclusive and pattern-only params are refused')
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
  {
    // A patch layer that failed to apply looks identical to one never written,
    // unless the running process says which mode it resolved. Both branches are
    // covered: a warmed finder (live state) and the pre-index text.
    const takeover = createStatusCommand(pool, { surface: 'retrieval' })
    const warmed = await takeover.handler({ rawInput: '' })
    assert.match(warmed.text, /工具面：retrieval/, `surface not reported: ${warmed.text.split('\n')[0]}`)
    const additive = createStatusCommand(pool, { surface: 'full' })
    const plain = await additive.handler({ rawInput: '' })
    assert.match(plain.text, /工具面：full/, 'full surface not reported')
    ok('/forge-status reports the surface actually in force')

    // An augmentation that never answers (native search disabled, different built-in)
    // looks exactly like a working one from outside: the counters and decline
    // reasons are the evidence, per built-in.
    const stats = {
      served: { read: 2, glob: 5, grep: 0 },
      declined: { read: {}, glob: { 'rg-exit-2': 1, 'invalid-arguments': 3 }, grep: {} },
      failed: { read: 0, glob: 0, grep: 1 },
    }
    const live = createStatusCommand(pool, {
      surface: 'full',
      augmentation: { stats: () => stats, nativeSearchEnabled: () => true },
    })
    const liveText = (await live.handler({ rawInput: '' })).text
    assert.match(liveText, /read 作答 2 次/, liveText)
    assert.match(liveText, /glob 作答 5 次，交回内置：invalid-arguments×3 rg-exit-2×1，Rust 原生搜索开启（sidecar 不可用时回退）/, liveText)
    assert.match(liveText, /grep 作答 0 次，异常 1 次/, liveText)
    const noNativeSearch = createStatusCommand(pool, { surface: 'full', augmentation: { stats: () => stats, nativeSearchEnabled: () => false } })
    assert.match((await noNativeSearch.handler({ rawInput: '' })).text, /Rust 原生搜索关闭/)
    const noSeam = createStatusCommand(pool, { surface: 'full' })
    assert.match((await noSeam.handler({ rawInput: '' })).text, /没有 tools\/execute 环绕分发点/)
    ok('/forge-status reports what the augmentation answered and why it deferred')
  }
  {
    const coldPool = new FinderPool()
    const cold = createStatusCommand(coldPool, { surface: 'retrieval' })
    const text = (await cold.handler({ rawInput: '' })).text
    assert.match(text, /工具面：retrieval/)
    assert.doesNotMatch(text, /预热/)
    coldPool.disposeAll()
    ok('/forge-status cold retrieval describes lazy index startup')
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
