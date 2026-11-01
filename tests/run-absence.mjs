/**
 * Empty-page diagnosis + scope-resolution regressions.
 *
 * Every case here is a bug found by replaying real DSH session db0cb9db
 * against the built lib/ (see dsh-forge-internal/reports/
 * 2026-10-14-why-ffglob-no-files-matched.md). Five of that session's eighteen
 * tool calls returned "no files matched"; four were tool blindness, not
 * missing data.
 *
 *  1. `ff_grep`/`ff_find` with `path` naming ONE FILE matched nothing when the
 *     path used forward slashes — the resolved path was compared against the
 *     caller's un-normalized string. Measured 8/8 deterministic.
 *  2. An empty page discarded the `warming` flag, so a finder that had not
 *     finished scanning was indistinguishable from an empty tree.
 *  3. An empty page said nothing about what the disk actually held, so a
 *     directory the caller had already named (`*compaction*`) looked absent.
 *
 * Runs against built lib/ output (build first: `pnpm run build`).
 */

import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FinderPool } from '../lib/core.js'
import { createGrepTool, createFindTool } from '../lib/tools.js'
import { explainAbsence, literalNeedle, walkForName } from '../lib/absence.js'
import { buildFixture, FIXTURE_DIR } from './make-fixture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROBE_DIR = path.join(HERE, '.absence-probe')

let passed = 0
function ok(label) {
  passed++
  console.log(`  ok ${passed} - ${label}`)
}
function renderOf(tool, args, value) {
  const out = tool.output.render(args, value)
  return Array.isArray(out) ? out.map(part => part?.text ?? '').join('\n') : String(out)
}

/** A tiny tree with a directory name the index will not hold. */
function buildProbeTree() {
  rmSync(PROBE_DIR, { recursive: true, force: true })
  mkdirSync(path.join(PROBE_DIR, 'vendor', '@scope', 'widget-compactor'), { recursive: true })
  writeFileSync(path.join(PROBE_DIR, 'vendor', '@scope', 'widget-compactor', 'index.js'), 'export const x = 1\n')
  mkdirSync(path.join(PROBE_DIR, 'plain-compactor'), { recursive: true })
  writeFileSync(path.join(PROBE_DIR, 'plain-compactor', 'a.js'), 'export const y = 2\n')
  writeFileSync(path.join(PROBE_DIR, 'unrelated.js'), 'export const z = 3\n')
}

const truth = buildFixture()
const pool = new FinderPool()
const fixtureExec = { agent: { session: { header: { cwd: FIXTURE_DIR } } } }
const find = createFindTool(pool)
const grep = createGrepTool(pool)

async function main() {
  // --- literalNeedle -------------------------------------------------------
  assert.equal(literalNeedle('*compaction*'), 'compaction')
  assert.equal(literalNeedle('**/*compaction*'), 'compaction')
  assert.equal(literalNeedle('**/dsh-compaction/**'), 'dsh-compaction')
  assert.equal(literalNeedle('src/**/*.ts'), 'src')
  assert.equal(literalNeedle('**/*'), '', 'a bare wildcard has nothing to search for')
  assert.equal(literalNeedle('ab'), '', 'too short to be evidence')
  ok('literalNeedle extracts the searchable name and refuses noise')

  // --- walkForName ---------------------------------------------------------
  buildProbeTree()
  const walk = walkForName(PROBE_DIR, 'compactor')
  assert.equal(walk.truncated, false)
  assert.deepEqual(
    walk.hits.map(hit => `${hit.rel}:${hit.dir ? 'dir' : 'file'}`).sort(),
    ['plain-compactor:dir', 'vendor/@scope/widget-compactor:dir'],
  )
  assert.deepEqual(walkForName(PROBE_DIR, 'nothing-here-at-all').hits, [])
  ok('walkForName finds names the index cannot hold, skipping nothing')

  // --- explainAbsence: one actionable clause, not a debug dump -------------
  // `*widget*` matches only the nested directory, so the two visibility limits
  // are decided by `canList` alone (no dependence on walk order).
  const nestedHidden = explainAbsence({
    scopeRoot: PROBE_DIR,
    query: '*widget*',
    canList: () => false,
  })
  assert.ok(nestedHidden !== undefined && nestedHidden.includes('not visible at this scope'), nestedHidden)
  assert.ok(nestedHidden.includes('search inside it with path="vendor/@scope/widget-compactor"'), nestedHidden)
  assert.equal(nestedHidden.match(/\[/g).length, 1, 'exactly one bracket: the note is a single clause')
  assert.ok(nestedHidden.length <= 360, `note must stay short, got ${nestedHidden.length}`)

  const nestedVisible = explainAbsence({
    scopeRoot: PROBE_DIR,
    query: '*widget*',
    canList: () => true,
  })
  assert.ok(nestedVisible !== undefined && nestedVisible.includes('ffind lists files only'), nestedVisible)
  assert.ok(!nestedVisible.includes('not visible'), 'no exclusion may be claimed when the engine can list it')

  const bothHits = explainAbsence({ scopeRoot: PROBE_DIR, query: '*compactor*', canList: () => true })
  assert.ok(bothHits !== undefined && bothHits.includes('more'), `two directory hits must collapse into one clause + count: ${bothHits}`)
  assert.equal(bothHits.match(/\[/g).length, 1, 'still one clause with two hits')

  assert.equal(explainAbsence({ scopeRoot: PROBE_DIR, query: '*absent*', canList: () => false }), undefined, 'silent when the disk agrees')
  assert.equal(explainAbsence({ scopeRoot: PROBE_DIR, query: '**/*', canList: () => false }), undefined, 'silent for a bare wildcard')
  ok('explainAbsence states one actionable reason, never a list of examples')

  // --- render: a scanning page makes no claim ------------------------------
  for (const [tool, args, empty] of [
    [find, { pattern: 'store' }, 'no files matched'],
    [grep, { pattern: 'zzz' }, 'no matches'],
  ]) {
    const warm = renderOf(tool, args, { items: [], totalMatched: 0, warming: true })
    assert.ok(warm.includes('still scanning'), `${tool.name}: warming flag must survive an empty page`)
    assert.ok(!warm.includes(empty), `${tool.name}: a page that is not an answer must not also say "${empty}"`)
    const done = renderOf(tool, args, { items: [], totalMatched: 0 })
    assert.ok(done.includes(empty), `${tool.name}: a finished empty page still reports "${empty}"`)
    const noted = renderOf(tool, args, { items: [], totalMatched: 0, note: 'DISK HINT' })
    assert.ok(noted.includes('[DISK HINT]'), `${tool.name}: an absence note must reach the caller`)
  }
  ok('an empty page either reports a result or reports that it has none yet')

  // --- regression: EOFB — path naming one file, both separator spellings ---
  const target = path.join(FIXTURE_DIR, 'src', 'store.js')
  const forward = target.split(path.sep).join('/')
  for (const [tool, args, label] of [
    [grep, { pattern: 'putBlob' }, 'ff_grep'],
    [find, { pattern: 'store.js' }, 'ff_find'],
  ]) {
    const asForward = await tool.execute({ ...args, path: forward }, fixtureExec)
    const asNative = await tool.execute({ ...args, path: target }, fixtureExec)
    assert.equal(asForward?.error, undefined, `${label}: forward-slash file path must not error`)
    assert.ok(asForward.items.length > 0, `${label}: forward-slash file path matched nothing (the Windows separator bug)`)
    assert.equal(asForward.items.length, asNative.items.length, `${label}: both separator spellings must agree`)
  }
  ok('a path naming one file matches under both forward and native separators')

  // --- regression: the find surface states what it cannot see --------------
  // Path patterns moved to the built-in glob; what ff_find must still admit is
  // that a fuzzy name can answer with a directory (a skill folder has no file
  // carrying its own name), and that globs are not its question.
  assert.ok(/directory too/.test(find.description), 'ff_find must say a fuzzy name can return a directory')
  assert.ok(/built-in glob/.test(find.description), 'ff_find must point path patterns at the built-in glob')
  assert.ok(/built-in glob/.test(find.parameters.pattern.description), 'the pattern param must name the tool that answers path patterns')
  ok('ff_find advertises its visibility limits instead of over-promising')

  // --- non-regression: real hits are untouched ----------------------------
  const hits = await find.execute({ path: FIXTURE_DIR, pattern: 'store.js' }, fixtureExec)
  assert.ok(hits.items.length > 0 && hits.note === undefined, 'a non-empty page must carry no absence note')
  ok('a non-empty page is unaffected')

  rmSync(PROBE_DIR, { recursive: true, force: true })
  assert.ok(truth.storePutBlob > 0, 'fixture truth is available')
  console.log(`\nrun-absence: ${passed} checks passed`)
}

await main()
