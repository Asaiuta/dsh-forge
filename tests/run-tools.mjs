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
import { createGrepTool, createFindTool, createStatusCommand } from '../lib/tools.js'
import { buildFixture, FIXTURE_DIR } from './make-fixture.mjs'
import { globMode } from './lib/find-modes.mjs'

const truth = buildFixture()
const pool = new FinderPool()
const exec = { agent: { session: { header: { cwd: FIXTURE_DIR } } } }

const grep = createGrepTool(pool)
const find = createFindTool(pool)
const globTool = globMode(find) // ffglob was folded into fffind as mode=glob
const multi = grep // fff_multi_grep was merged into ffgrep: same {patterns} call, same result shape
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
    // Built-in-grep habit: a regex-shaped pattern that matches nothing
    // literally is retried once in regex mode instead of reading as a miss.
    const result = await grep.execute({ pattern: 'put[Bb]lob' }, exec)
    assert.ok(!result.error, `escalated grep failed: ${result.error}`)
    assert.ok(result.items.length > 0, 'zero-literal pattern must escalate to regex mode')
    assert.match(result.note ?? '', /retried as regex/, `escalation note missing: ${result.note}`)
    ok('ffgrep zero-hit literal→regex auto-escalation')
  }
  {
    // Both modes miss → the result stays a plain zero-hit, no noise note.
    const result = await grep.execute({ pattern: 'zzz[0-9]qqq' }, exec)
    assert.ok(!result.error)
    assert.equal(result.items.length, 0)
    assert.ok(!result.note, `escalation must stay silent when regex also misses: ${result.note}`)
    ok('ffgrep escalation silent when the regex retry also misses')
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
    ok('ffgrep empty page names the path constraint instead of inventing a disk-level absence')
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
      assert.equal(result.items.length, GREP_MAX_MATCHES_PER_FILE,
        `a ${lines}-match file must yield the raised cap (${GREP_MAX_MATCHES_PER_FILE}), got ${result.items.length}`)
      assert.match(result.note ?? '', /matches-per-file cap/, `capped answer must say so: ${result.note}`)
      assert.match(result.note ?? '', /hot\.ts/, `note must name the capped file: ${result.note}`)
      ok(`ffgrep per-file cap: ${GREP_MAX_MATCHES_PER_FILE} lines kept, the cut is announced with the file name`)
    } finally {
      fs.rmSync(capDir, { recursive: true, force: true })
    }
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
    // Same split as ffgrep: `path=` dropped every name the index offered, so the
    // page is empty for a scope reason — not because the file is missing.
    const result = await find.execute({ pattern: 'store', path: 'docs/*.md' }, exec)
    assert.ok(!result.error, `scoped find failed: ${result.error}`)
    assert.equal(result.items.length, 0, 'store.js is not a .md file')
    assert.match(result.note ?? '', /fell outside path=/, `scope note missing, got: ${result.note}`)
    assert.doesNotMatch(result.note ?? '', /exists on disk/, `must not claim a disk-level absence: ${result.note}`)
    ok('fffind empty page names the path constraint instead of "exists on disk"')
  }
  {
    const result = await find.execute({ pattern: '' }, exec)
    assert.match(result.error, /pattern is required/)
    ok('fffind degrade: empty pattern is a structured error')
  }
  // --- fffind: the "wrong tool" signal --------------------------------------
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
    ok('fffind weak-name-match detection: no literal occurrence AND a handful of hits')
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
    assert.ok(out.includes('ffgrep'), 'the note must name the tool that answers content queries')
    ok('fffind render says outright that no file name matched the query')
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
    ok('fffind render exposes the cap and leaves a literal hit unannotated')
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
    ok('fffind render flags glob-shaped patterns')
  }

  // --- fffind mode=glob (the former ffglob) ---------------------------------
  {
    const result = await globTool.execute({ pattern: '**/*.ts' }, exec)
    assert.ok(!result.error, `glob failed: ${result.error}`)
    const paths = result.items.map((i) => i.path)
    assert.ok(paths.includes('src/nested/deep.ts'), `deep.ts listed, got ${JSON.stringify(paths)}`)
    assert.ok(!paths.some((p) => p.includes('build/')), 'gitignored build/ stays out of glob results')
    ok('fffind mode=glob: anchored pattern matches nested ts, gitignored excluded')
  }
  {
    // Built-in-glob habit: no separator → basename match at any depth.
    const result = await globTool.execute({ pattern: '*.md' }, exec)
    assert.ok(!result.error)
    const paths = result.items.map((i) => i.path)
    assert.deepEqual(paths.slice().sort(), ['README.md', 'data/unicode.md', 'docs/guide.md'], `basename glob at any depth, got ${JSON.stringify(paths)}`)
    ok('fffind mode=glob: separator-free pattern matches basenames at any depth')
  }
  {
    // Truncation must be visible; page 2 must not repeat page 1.
    const page1 = await globTool.execute({ pattern: '*.md', limit: 1 }, exec)
    assert.equal(page1.items.length, 1)
    const render = globTool.output.render({ pattern: '*.md' }, page1).map((b) => b.text).join('')
    assert.match(render, /showing 1 of 3/, `cap visible: ${render}`)
    const page2 = await globTool.execute({ pattern: '*.md', limit: 1, page: 1 }, exec)
    assert.equal(page2.items.length, 1)
    assert.notEqual(page1.items[0].path, page2.items[0].path, 'page 2 advances')
    ok('fffind mode=glob: cap note + pagination advances without overlap')
  }
  {
    const scoped = await globTool.execute({ pattern: '*.js', path: 'src' }, exec)
    assert.ok(!scoped.error)
    assert.ok(scoped.items.length >= 4 && scoped.items.every((i) => i.path.startsWith('src/')), 'subdirectory scope via aux finder')
    const empty = await globTool.execute({ pattern: '**/*.nonexistent' }, exec)
    assert.ok(!empty.error && empty.items.length === 0, 'zero matches are structured, not an error')
    ok('fffind mode=glob: path scoping + structured zero-match')
  }
  {
    // --- the same tool serving as the built-in `glob` (takeover) -----------
    // The built-in takes exactly {pattern, path}: no mode to forget, no page to
    // continue with, and an answer that is a path list — never a fuzzy name.
    const asGlob = createFindTool(pool, 'glob')
    assert.equal(asGlob.name, 'glob')
    assert.deepEqual(Object.keys(asGlob.parameters).sort(), ['path', 'pattern'],
      `native shape exposes only the built-in arguments, got ${Object.keys(asGlob.parameters)}`)

    const md = await asGlob.execute({ pattern: '**/*.md' }, exec)
    assert.ok(!md.error, `native glob failed: ${md.error}`)
    assert.ok(md.items.length > 0 && md.items.every((i) => i.path.endsWith('.md')), 'glob semantics, not fuzzy')
    // The decisive difference from mode=name: a typo'd query must NOT fuzzy-match.
    const typo = await asGlob.execute({ pattern: 'stroe' }, exec)
    assert.ok(!typo.error)
    assert.equal(typo.items.length, 0, 'a bare typo is a glob that matches nothing, not a fuzzy hit')

    const noPattern = await asGlob.execute({ pattern: '' }, exec)
    assert.match(noPattern.error, /pattern is required/)

    // Rendered like the built-in: paths only, no page cursor to promise.
    const render = asGlob.output.render({ pattern: '**/*.md' }, md).map((b) => b.text).join('')
    assert.ok(render.split('\n').every((line) => line === '' || line.endsWith('.md')), `bare path list: ${render}`)
    assert.doesNotMatch(render, /page=/, 'the built-in has no page argument; the render must not advertise one')
    ok('createFindTool as `glob`: native arguments, glob semantics, path-list render')
  }

  // --- ffgrep with patterns[] (absorbed from fff_multi_grep) ---------------
  {
    const result = await multi.execute({ patterns: ['putBlob', 'getBlob'] }, exec)
    assert.ok(!result.error, `multi failed: ${result.error}`)
    const texts = result.items.map((i) => i.text)
    assert.ok(texts.some((t) => t.includes('putBlob')) && texts.some((t) => t.includes('getBlob')),
      'OR logic returns both patterns')
    ok('ffgrep patterns: both patterns present in one pass')
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
    ok('ffgrep patterns result set ⊆ per-pattern union (semantics equal on overlap page)')
  }
  {
    const bad = await multi.execute({ patterns: ['only-one'] }, exec)
    assert.match(bad.error, /at least 2/)
    ok('ffgrep patterns degrade: single pattern rejected with guidance')
  }
  {
    const both = await multi.execute({ pattern: 'putBlob', patterns: ['a', 'b'] }, exec)
    assert.match(both.error, /not both/)
    const none = await multi.execute({}, exec)
    assert.match(none.error, /pattern is required/)
    const withMode = await multi.execute({ patterns: ['a', 'b'], mode: 'regex' }, exec)
    assert.match(withMode.error, /always literal/)
    ok('ffgrep: pattern/patterns are mutually exclusive and pattern-only params are refused')
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
    const takeover = createStatusCommand(pool, { mode: 'takeover', takenOver: ['read'] })
    const warmed = await takeover.handler({ rawInput: '' })
    assert.match(warmed.text, /注册模式：takeover，已接管 read/, `takeover mode not reported: ${warmed.text.split('\n')[0]}`)
    const additive = createStatusCommand(pool, { mode: 'additive', takenOver: [] })
    const plain = await additive.handler({ rawInput: '' })
    assert.match(plain.text, /注册模式：additive/, 'additive mode not reported')
    assert.doesNotMatch(plain.text, /已接管/, 'additive must not claim a takeover')
    ok('/forge-status reports the registration mode actually in force')

    // The fallback is invisible from config alone: whether the built-in handle
    // resolves depends on which registry layer the host put its fs tools in.
    const wired = createStatusCommand(pool, { mode: 'takeover', takenOver: ['read', 'grep'], delegate: { available: () => true, run: async () => ({ ok: false, error: 'x' }) } })
    assert.match((await wired.handler({ rawInput: '' })).text, /内置委托：可用/)
    const unwired = createStatusCommand(pool, { mode: 'takeover', takenOver: ['read', 'grep'], delegate: { available: () => false, run: async () => ({ ok: false, error: 'x' }) } })
    assert.match((await unwired.handler({ rawInput: '' })).text, /内置委托：不可用/)
    const noGrep = createStatusCommand(pool, { mode: 'takeover', takenOver: ['read'] })
    assert.doesNotMatch((await noGrep.handler({ rawInput: '' })).text, /内置委托/, 'grep not taken over: the line must not appear at all')
    ok('/forge-status reports whether the built-in fallback is actually reachable')
  }

  // --- serving as the built-in `grep` --------------------------------------
  {
    const native = createGrepTool(pool, 'grep')
    assert.equal(native.name, 'grep')
    assert.deepEqual(Object.keys(native.parameters).sort(), ['include', 'path', 'pattern'])

    // The built-in contract, not ffgrep's: `pattern` is a ripgrep regex and it
    // is case-SENSITIVE. A takeover that quietly ran smart-case here would
    // answer a different question than the tool it replaced.
    const regex = await native.execute({ pattern: 'put[A-Z]\\w+' }, exec)
    assert.ok(!regex.error, `native grep failed: ${regex.error}`)
    assert.ok(regex.items.length >= 2, 'regex pattern must match store.js and login.js')
    assert.ok(regex.items.every((i) => /put[A-Z]\w+/.test(i.text)), `regex hits look wrong: ${JSON.stringify(regex.items.slice(0, 2))}`)
    const lower = await native.execute({ pattern: 'putblob' }, exec)
    assert.ok(!lower.error, `native grep failed: ${lower.error}`)
    assert.equal(lower.items.length, 0, 'lowercase pattern must NOT match putBlob — the built-in is case-sensitive')

    // Column recovery: the built-in drops the column entirely, and the engine's
    // unit is a 0-based BYTE offset (see GrepItem.col), so it is recomputed in
    // that unit rather than as a JS string index — identical for ASCII lines,
    // wrong for the rest, and this fixture has Chinese text elsewhere.
    const located = regex.items.find((i) => i.file.endsWith('store.js'))
    assert.ok(located, 'store.js hit missing')
    assert.equal(Buffer.byteLength(located.text.slice(0, located.text.indexOf('putBlob')), 'utf8'), located.col, `column ${located.col} is not the match offset in ${JSON.stringify(located.text)}`)
    ok('createGrepTool as `grep`: native arguments, ripgrep regex, case-sensitive, column recovered')
  }
  {
    const native = createGrepTool(pool, 'grep')
    const scoped = await native.execute({ pattern: 'putBlob', include: '*.js' }, exec)
    assert.ok(!scoped.error, `native grep include failed: ${scoped.error}`)
    assert.ok(scoped.items.length > 0)
    assert.ok(scoped.items.every((i) => i.file.endsWith('.js')), `include=*.js leaked: ${[...new Set(scoped.items.map((i) => i.file))]}`)
    // `*.js` has no separator, so it matches the basename at any depth — the
    // ripgrep rule, which an anchored whole-path match would get wrong.
    assert.ok(scoped.items.some((i) => i.file.includes('/')), 'nested .js must still match a separator-free include')

    // A pattern that only exists outside the include set must say so instead of
    // reporting an absence: the index did match, the glob dropped it.
    const dropped = await native.execute({ pattern: 'reading back with', include: '*.js' }, exec)
    assert.ok(!dropped.error, `native grep failed: ${dropped.error}`)
    assert.equal(dropped.items.length, 0)
    assert.match(String(dropped.note), /matched outside include="\*\.js"/, `wrong empty reason: ${dropped.note}`)

    const comma = await native.execute({ pattern: 'putBlob', include: '*.js,*.ts' }, exec)
    assert.match(String(comma.error), /comma-separated list/, 'a list must be refused, not silently over-matched')
    const negated = await native.execute({ pattern: 'putBlob', include: '!*.md' }, exec)
    assert.match(String(negated.error), /negation/, 'negation must be refused, not silently ignored')
    ok('native grep: include is ripgrep glob (basename, depth-free), refusals, and the empty-page split')
  }
  {
    // Delegation: the whole point is that a call the index cannot answer
    // honestly is handed to the built-in *with the built-in's own arguments*.
    const calls = []
    const delegate = {
      available: () => true,
      async run(name, args, rawExec) {
        calls.push({ name, args, rawExec })
        return { ok: true, value: { matches: [{ path: 'src/store.js', lineNumber: 7, line: '  putBlob(buffer) {' }] } }
      },
    }
    const native = createGrepTool(pool, 'grep', delegate)

    // Case 1: a scope the index cannot serve. `path` holding a glob is not a
    // path — the built-in refuses it, so the refusal is what gets served.
    const globPath = await native.execute({ pattern: 'putBlob', path: 'src/*.js' }, exec)
    assert.equal(calls.length, 1, 'glob-shaped path must delegate')
    assert.deepEqual(calls[0].args, { pattern: 'putBlob', path: 'src/*.js' }, `delegate got forge arguments: ${JSON.stringify(calls[0].args)}`)
    assert.equal(globPath.items[0].file, 'src/store.js')
    assert.equal(globPath.items[0].col, 2, 'column recovered from the delegate line (0-based byte offset)')

    // Case 2: the index has no match. The index is a snapshot; a file written
    // by another process is invisible to it, so the disk is asked too.
    const absent = await native.execute({ pattern: 'zzzNoSuchTokenZzz' }, exec)
    assert.equal(calls.length, 2, 'a zero-match page must be confirmed against the disk')
    assert.match(String(absent.note), /come from ripgrep on disk/, `delegated hits not announced: ${absent.note}`)
    assert.equal(absent.items.length, 1)

    // Case 3: both say no. That is strictly stronger evidence than the index
    // alone, and the note says which two sources agreed.
    const bothNo = { available: () => true, async run() { return { ok: true, value: { matches: [] } } } }
    const none = await createGrepTool(pool, 'grep', bothNo).execute({ pattern: 'zzzNoSuchTokenZzz' }, exec)
    assert.deepEqual(none.items, [])
    assert.match(String(none.note), /no match in the index and none on disk/, `missing double-negative note: ${none.note}`)

    // Case 4: no built-in at all — the host serves no fs tools, or the lookup
    // refused. The index answer still stands and must not claim a disk check.
    const orphan = await createGrepTool(pool, 'grep').execute({ pattern: 'zzzNoSuchTokenZzz' }, exec)
    assert.deepEqual(orphan.items, [])
    assert.doesNotMatch(String(orphan.note ?? ''), /on disk/, 'must not claim a disk check it never ran')

    // Case 5: a delegated call that throws must not lose the index answer.
    const broken = { available: () => true, async run() { return { ok: false, error: 'rg exploded' } } }
    const survived = await createGrepTool(pool, 'grep', broken).execute({ pattern: 'zzzNoSuchTokenZzz' }, exec)
    assert.deepEqual(survived.items, [])
    assert.match(String(survived.note), /on-disk check could not run \(rg exploded\)/, `failure not reported: ${survived.note}`)

    // Case 6: a path the index cannot resolve. The built-in would search it or
    // fail on it; either answer is better than forge's own "path not found".
    const unresolvable = await native.execute({ pattern: 'putBlob', path: 'no-such-dir' }, exec)
    assert.equal(calls.length, 3, 'an unresolvable path must delegate')
    assert.equal(unresolvable.items[0].file, 'src/store.js')

    // Case 7: path + include compose (scope from `path`, filter from `include`).
    const composed = await native.execute({ pattern: 'putBlob', path: 'src', include: '*.js' }, exec)
    assert.ok(!composed.error, `path+include failed: ${composed.error}`)
    assert.ok(composed.items.length > 0)
    assert.ok(composed.items.every((i) => i.file.endsWith('.js')), 'include must still filter under path=')
    assert.equal(calls.length, 3, 'a servable scope must not delegate on top of a hit')
    ok('native grep delegation: built-in arguments, disk confirmation, double negative, absence, failure')
  }
  {
    // The delegate must never resolve forge's own definitions — a scoped tool
    // that answered its own name would recurse until the stack died.
    const { createNativeDelegate, FORGE_DEFINITION_TAG } = await import('../lib/delegate.js')
    assert.equal(createNativeDelegate(undefined), undefined, 'no registry means no fallback')

    const builtin = { name: 'grep', execute: async () => ({ matches: [] }) }
    let served = builtin
    const lookup = {
      get(name) {
        if (name === 'throws') throw new Error('refused')
        return served
      },
    }
    const delegate = createNativeDelegate(lookup)
    assert.equal(delegate.available('grep'), true)
    assert.equal(delegate.available('edit'), true, 'the same definition is served for any name the registry answers')
    assert.equal(delegate.available('throws'), false, 'a refused read is not a fallback')
    assert.deepEqual(await delegate.run('grep', { pattern: 'x' }, {}), { ok: true, value: { matches: [] } })

    served = { name: 'grep', execute: async () => ({ matches: [] }), [FORGE_DEFINITION_TAG]: 'ffgrep' }
    assert.equal(delegate.available('grep'), false, 'a forge definition must not be delegated to')
    assert.equal((await delegate.run('grep', {}, {})).ok, false)

    served = undefined
    assert.equal(delegate.available('grep'), false, 'an absent definition is not a fallback')
    ok('delegate: no registry, refusal, self-definition rejected, absent, and re-read per call')
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
