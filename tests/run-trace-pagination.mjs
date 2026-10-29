/**
 * Paging contract for Trace (M0.6).
 *
 * Two properties are being defended here, and both are easy to lose:
 *
 *   1. A page is a slice of *rows*, never a re-slice of rendered text. Text that
 *      was already truncated has no row 137 to hand out.
 *   2. Offsets belong to the server. A cursor names one query against one
 *      snapshot; a caller cannot ask for arbitrary offsets, cannot reuse a
 *      cursor for another query, and cannot silently stitch two workspace
 *      states into one "complete" answer.
 *
 * The negative cases matter as much as the happy path: a stale page must be
 * labelled and unusable for edit planning, an evicted snapshot must ask for a
 * re-query rather than quietly answer from whatever is current, and an
 * incomplete traversal must never be presented as a complete row set.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assembleTraceGraph, createTraceTool, resetTraceSnapshots } from '../lib/tools-trace.js'
import { collectRows } from '../lib/trace-rows.js'
import { resetFactsCache } from '../lib/ast.js'

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-pages-'))
const previousWorkers = process.env.DSH_FORGE_AST_WORKERS
const write = (rel, text) => {
  const abs = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

const exec = { agent: { session: { header: { cwd: root, id: 'pages' } } }, token: {} }
const tool = createTraceTool()
const call = (args, execOverride = exec) => tool.execute(args, execOverride)

/** Every row line from every page, in order, plus the page objects. */
async function readAll(args, maxPages = 20) {
  const pages = []
  let cursor
  for (let i = 0; i < maxPages; i++) {
    const value = await call(cursor ? { ...args, cursor } : args)
    assert.ok(!value.error, `page ${i + 1} failed: ${value.error}`)
    pages.push(value)
    cursor = value.page?.nextCursor
    if (!cursor) return { pages, done: true }
  }
  return { pages, done: false }
}

/** The `- \`file:line\` …` row lines of a page, in order. */
const rowLines = (value) => value.text.split('\n').filter(line => /^- `/.test(line))

try {
  process.env.DSH_FORGE_AST_WORKERS = '0'
  resetFactsCache()
  resetTraceSnapshots()

  // ---- fixture: 250 member consumers, one bridge ---------------------------
  // A wide bridge is the realistic shape of an unbounded answer: a preload that
  // exposes an object with hundreds of members, each used from a renderer file.
  const MEMBERS = 250
  const members = Array.from({ length: MEMBERS }, (_, i) => `  member${String(i).padStart(3, '0')}: () => {},`)
  write('preloads/wide.js', `const api = {\n${members.join('\n')}\n}\ncontextBridge.exposeInMainWorld('wideApi', api)\n`)
  for (let i = 0; i < MEMBERS; i++) {
    write(`renderer/use${String(i).padStart(3, '0')}.js`, `window.wideApi.member${String(i).padStart(3, '0')}()\n`)
  }

  // ---- 1. three pages, no duplicates, no omissions ------------------------
  {
    const { pages, done } = await readAll({ target: 'exposes:wideApi' })
    assert.ok(done, 'pagination must terminate')
    assert.equal(pages.length, 3, `250 rows at 100 per page is 3 pages, got ${pages.length}`)
    assert.equal(pages[0].page.total, MEMBERS)
    assert.deepEqual(pages.map(page => page.page.offset), [0, 100, 200])
    assert.deepEqual(pages.map(page => page.page.returned), [100, 100, 50])
    assert.equal(pages[0].page.limit, 100, 'the default page size is 100 rows')
    assert.ok(!pages[2].page.nextCursor, 'the last page must not offer an empty fourth page')
    for (const page of pages) assert.equal(page.page.stale, false)
    // Every page reads the same snapshot: paging must not re-scan mid-flight.
    assert.equal(new Set(pages.map(page => page.page.snapshotId)).size, 1)

    const seen = pages.flatMap(page => rowLines(page))
    assert.equal(seen.length, MEMBERS, 'the three pages must cover every row exactly once')
    assert.equal(new Set(seen).size, MEMBERS, 'no row may repeat across pages')
    const membersSeen = new Set(seen.map(line => /\.(member\d+)/.exec(line)?.[1]))
    assert.equal(membersSeen.size, MEMBERS, 'every member must appear')
    ok('250 consumers arrive in three pages with no duplicate and no missing row')
  }

  // ---- 2. the structured rows equal the paged text ------------------------
  {
    const assembled = await assembleTraceGraph(root)
    const all = collectRows(assembled.graph, { kind: 'exposes', value: 'wideApi' })
    const { pages } = await readAll({ target: 'exposes:wideApi' })
    const textRows = pages.flatMap(page => rowLines(page))
    assert.equal(textRows.length, all.rows.length)
    // Same order, same content: a page boundary never reshuffles rows.
    const expected = all.rows.map(row => `- \`${row.file}:${row.line}\` · \`${row.object}.${row.member}\``)
    assert.deepEqual(textRows, expected)
    ok('page text is rendered from the row set, in the same stable order')
  }

  // ---- 3. two members on one line stay two rows ---------------------------
  {
    resetFactsCache(); resetTraceSnapshots()
    write('preloads/pair.js', `const api = { alpha: () => {}, beta: () => {} }\ncontextBridge.exposeInMainWorld('pairApi', api)\n`)
    write('renderer/pair.js', 'window.pairApi.alpha(); window.pairApi.beta()\n')
    const value = await call({ target: 'exposes:pairApi', format: 'detail' })
    assert.ok(!value.error, value.error)
    // The detail view prints one row per key; both keys on line 1 must appear.
    assert.ok(/`alpha` ×1/.test(value.text), value.text)
    assert.ok(/`beta` ×1/.test(value.text), value.text)
    const assembled = await assembleTraceGraph(root)
    const rows = collectRows(assembled.graph, { kind: 'exposes', value: 'pairApi' }).rows
    const sameLine = rows.filter(row => row.file === 'renderer/pair.js' && row.line === 1)
    assert.deepEqual(sameLine.map(row => row.member).sort(), ['alpha', 'beta'],
      'rows are keyed by member, so one line can carry two of them')
    ok('two members touched on one line remain two distinct rows')
  }

  // ---- 4. an incomplete traversal cannot claim a complete row set ---------
  {
    resetFactsCache(); resetTraceSnapshots()
    write('lib/shared.js', 'export const shared = 1\n')
    for (let i = 0; i < 6; i++) write(`app/use${i}.js`, "import { shared } from '../lib/shared.js'\nshared\n")
    const assembled = await assembleTraceGraph(root)
    const walk = collectRows(assembled.graph, { kind: 'impact', value: 'lib/shared.js', edgeMode: 'all' }, { nodes: 3 })
    assert.equal(walk.traversalComplete, false, 'a capped walk must report itself incomplete')
    assert.equal(walk.resultComplete, false)
    assert.ok(walk.limitations.some(limit => limit.reason === 'traversal_budget'))
    assert.ok(walk.rows.length < 6, 'the capped walk stops early')
    // And the same graph without the artificial cap is complete, proving the
    // flag comes from the budget and not from the fixture.
    const full = collectRows(assembled.graph, { kind: 'impact', value: 'lib/shared.js', edgeMode: 'all' })
    assert.equal(full.traversalComplete, true)
    assert.equal(full.rows.length, 6)
    ok('an incomplete traversal is reported as incomplete; a capped run never passes for a full one')
  }

  // ---- 5. page size is clamped, and a cursor pins it ---------------------
  {
    const tooBig = await call({ target: 'exposes:wideApi', limit: 1000 })
    assert.ok(!tooBig.error, tooBig.error)
    assert.equal(tooBig.page.limit, 500, 'page size is capped at 500')
    assert.equal(tooBig.page.returned, 250, 'the whole result fits in one capped page')
    assert.ok(!tooBig.page.nextCursor)

    const first = await call({ target: 'exposes:wideApi', limit: 50 })
    assert.equal(first.page.returned, 50)
    const changed = await call({ target: 'exposes:wideApi', limit: 80, cursor: first.page.nextCursor })
    assert.match(changed.error, /页大小/)
    ok('limit is clamped to 500, and a cursor fixes the page size it was created with')
  }

  // ---- 6. a cursor is bound to its query and workspace -------------------
  {
    const first = await call({ target: 'exposes:wideApi' })
    const cursor = first.page.nextCursor
    const otherTarget = await call({ target: 'impact:preloads/wide.js', cursor })
    assert.match(otherTarget.error, /另一个查询/)
    const bogus = await call({ target: 'exposes:wideApi', cursor: 'does-not-exist' })
    assert.match(bogus.error, /不存在或已过期/)
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-pages-other-'))
    try {
      fs.writeFileSync(path.join(otherRoot, 'x.js'), 'const x = 1\n')
      const otherExec = { agent: { session: { header: { cwd: otherRoot, id: 'other' } } }, token: {} }
      const crossed = await call({ target: 'exposes:wideApi', cursor }, otherExec)
      assert.match(crossed.error, /另一个工作区/)
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
    ok('a cursor refuses another query, an unknown id and another workspace')
  }

  // ---- 7. editing the workspace mid-paging is reported as stale ----------
  {
    resetFactsCache(); resetTraceSnapshots()
    const first = await call({ target: 'exposes:wideApi' })
    assert.equal(first.page.total, MEMBERS)
    // A new consumer appears after page 1 was served.
    write('renderer/late.js', 'window.wideApi.member000()\n')
    const second = await call({ target: 'exposes:wideApi', cursor: first.page.nextCursor })
    assert.ok(!second.error, second.error)
    assert.equal(second.page.stale, true, 'a page from the old snapshot must say it is stale')
    assert.equal(second.page.total, MEMBERS, 'the old snapshot still holds the old total')
    assert.match(second.text, /旧快照|stale/)
    assert.match(second.text, /不可作为当前修改计划的依据/)
    assert.ok(!second.analysis, 'a stale page must not be paired with the current analysis')
    // A fresh query sees the new consumer.
    const fresh = await call({ target: 'exposes:wideApi' })
    assert.equal(fresh.page ? fresh.page.total : 1, MEMBERS + 1)
    fs.rmSync(path.join(root, 'renderer', 'late.js'))
    ok('an edit during paging is labelled stale and the stale page carries no current analysis')
  }

  // ---- 8. an evicted snapshot asks for a re-query, never a substitute ----
  {
    resetFactsCache(); resetTraceSnapshots()
    const first = await call({ target: 'exposes:wideApi' })
    const cursor = first.page.nextCursor
    // Four snapshots per workspace are retained; five more assemblies evict it.
    for (let i = 0; i < 5; i++) {
      write('renderer/grow.js', `window.wideApi.member000() // ${i}\n`)
      resetFactsCache()
      await assembleTraceGraph(root)
    }
    const page = await call({ target: 'exposes:wideApi', cursor })
    assert.match(page.error, /快照已不可用|不存在或已过期/)
    assert.match(page.error, /重新发起查询/)
    fs.rmSync(path.join(root, 'renderer', 'grow.js'))
    ok('an evicted snapshot makes the cursor expire instead of answering from the current graph')
  }

  // ---- 9. cancellation during a paged fetch propagates -------------------
  {
    resetFactsCache(); resetTraceSnapshots()
    const first = await call({ target: 'exposes:wideApi' })
    const controller = new AbortController()
    controller.abort(new Error('cancel-page'))
    const cancelledExec = { ...exec, signal: controller.signal }
    await assert.rejects(
      () => call({ target: 'exposes:wideApi', cursor: first.page.nextCursor }, cancelledExec),
      /cancel-page|abort/i,
    )
    ok('an aborted page fetch rejects instead of returning a partial page')
  }

  // ---- 10. impact pages reach referrers the old render dropped -----------
  {
    resetFactsCache(); resetTraceSnapshots()
    // A renderer-file answer used to stop at 30 text rows and 100 structured
    // rows; 140 importers proved nothing beyond that line was reachable.
    write('lib/hub.js', 'export const hub = 1\n')
    for (let i = 0; i < 140; i++) write(`pages/p${String(i).padStart(3, '0')}.js`, "import { hub } from '../lib/hub.js'\nhub\n")
    const { pages, done } = await readAll({ target: 'impact:lib/hub.js' })
    assert.ok(done)
    assert.equal(pages[0].page.total, 140)
    assert.deepEqual(pages.map(page => page.page.returned), [100, 40])
    const rows = pages.flatMap(page => rowLines(page))
    assert.equal(new Set(rows).size, 140, 'every referrer must be reachable across pages')
    ok('impact paging exposes referrers beyond the old 30/100 display caps')
  }
} finally {
  resetTraceSnapshots()
  if (previousWorkers === undefined) delete process.env.DSH_FORGE_AST_WORKERS
  else process.env.DSH_FORGE_AST_WORKERS = previousWorkers
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

console.log(`\n${passed} Trace pagination groups passed`)
