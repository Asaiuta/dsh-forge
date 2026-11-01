import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileFinder } from '@ff-labs/fff-node'
import { FinderPool } from '../lib/core.js'
import { createFindTool, createGrepTool } from '../lib/tools.js'
import { markWritten, clearOverlay, overlaySnapshot, searchOverlay } from '../lib/overlay.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-retrieval-contract-'))
fs.mkdirSync(path.join(root, 'src'))
const exec = { agent: { session: { header: { cwd: root } } } }
const hit = (file, line = 1) => ({ relativePath: file, lineNumber: line, col: 0, lineContent: 'needle', gitStatus: '', totalFrecencyScore: 0 })
const page = items => ({ ok: true, value: { items, totalFilesSearched: 1, filteredFileCount: 1, nextCursor: null } })
function harness(items = []) {
  const finder = { grep: () => page(items), multiGrep: () => page(items), isScanning: () => false }
  const lease = { finder, basePath: root, warming: false, temporary: false, scannedAt: Date.now() + 60000 }
  return { finder, lease, pool: { main: async () => lease, rescan: async () => false } }
}
try {
  await test('live multi-literal OR scans return each matching line once with per-pattern smart case', () => {
    clearOverlay()
    markWritten(path.join(root, 'src/live.ts'), 'needle other\nUPPER\nupper\n')
    const hits = searchOverlay(overlaySnapshot(root).files, ['needle', 'other', 'UPPER'], { mode: 'plain', smartCase: true, context: 0, limit: 200 })
    assert.deepEqual(hits.map(hit => [hit.line, hit.text]), [[1, 'needle other'], [2, 'UPPER']])
  })
  await test('live single and multi hits obey the requested directory scope', async () => {
    for (const args of [{ pattern: 'needle', context: 1 }, { patterns: ['needle', 'other'] }]) {
      clearOverlay()
      markWritten(path.join(root, 'outside.ts'), 'needle\n')
      markWritten(path.join(root, 'src/live.ts'), 'needle\n')
      const { pool } = harness()
      const result = await createGrepTool(pool).execute({ ...args, path: 'src' }, exec)
      assert.deepEqual(result.items.map(i => i.file), ['src/live.ts'])
    }
  })
  await test('multi search shadows stale content and includes committed live bytes', async () => {
    clearOverlay()
    markWritten(path.join(root, 'src/live.ts'), 'needle new\n')
    const { pool } = harness([hit('src/live.ts')])
    const out = await createGrepTool(pool).execute({ patterns: ['needle', 'other'] }, exec)
    assert.equal(out.items.length, 1)
    assert.equal(out.items[0].text, 'needle new')
  })
  await test('single and multi pagination retain overflow with no duplicate live hits', async () => {
    for (const args of [{ pattern: 'needle', context: 1 }, { patterns: ['needle', 'other'] }]) {
      clearOverlay()
      markWritten(path.join(root, 'src/live.ts'), 'needle live1\nneedle live2\n')
      const { pool } = harness([hit('src/index.ts', 1), hit('src/index.ts', 2), hit('src/index.ts', 3)])
      const tool = createGrepTool(pool)
      let cursor
      const all = []
      for (let n = 0; n < 10; n++) {
        const out = await tool.execute({ ...args, limit: 1, ...(cursor ? { cursor } : {}) }, exec)
        assert.ok(!out.error, out.error)
        assert.ok(out.items.length <= 1)
        all.push(...out.items)
        cursor = out.nextCursor
        if (!cursor) break
      }
      assert.equal(cursor, undefined)
      assert.equal(all.length, 5)
      assert.equal(new Set(all.map(i => `${i.file}:${i.line}`)).size, 5)
    }
  })
  await test('filtered multi pages continue past out-of-scope raw pages', async () => {
    clearOverlay()
    const { pool, finder } = harness()
    finder.multiGrep = ({ cursor }) => ({ ok: true, value: { ...page([]).value,
      items: cursor ? [hit('src/inside.ts')] : [hit('outside.ts')], nextCursor: cursor ? null : { nextFileIndex: 1 } } })
    const out = await createGrepTool(pool).execute({ patterns: ['needle', 'other'], path: 'src', limit: 1 }, exec)
    assert.deepEqual(out.items.map(i => i.file), ['src/inside.ts'])
  })
  await test('unknown and query-mismatched cursors fail instead of restarting', async () => {
    clearOverlay()
    const { pool } = harness([hit('src/a.ts', 1), hit('src/a.ts', 2)])
    const tool = createGrepTool(pool)
    assert.match((await tool.execute({ pattern: 'needle', cursor: 'unknown' }, exec)).error, /cursor/i)
    const first = await tool.execute({ pattern: 'needle', limit: 1 }, exec)
    assert.ok(first.nextCursor)
    assert.match((await tool.execute({ pattern: 'different', limit: 1, cursor: first.nextCursor }, exec)).error, /cursor/i)
  })
  await test('scoped fuzzy find never returns more than limit', async () => {
    const { pool, finder } = harness()
    finder.fileSearch = () => ({ ok: true, value: { items: Array.from({ length: 200 }, (_, n) => ({ relativePath: `src/file${n}.ts`, fileName: `file${n}.ts`, size: 1, modified: 0, gitStatus: '' })), scores: [], totalMatched: 200 } })
    const out = await createFindTool(pool).execute({ pattern: 'file', path: 'src', limit: 1 }, exec)
    assert.equal(out.items.length, 1)
    assert.equal(out.totalMatched, 200)
  })
  await test('glob-looking fuzzy guidance only recommends the supported builtin', () => {
    const { pool } = harness()
    const out = createFindTool(pool).output.render({ pattern: '*.ts' }, { items: [] })[0].text
    assert.match(out, /built-in glob/)
    assert.doesNotMatch(out, /mode=glob|ff_symbols with glob|ff_read with glob/)
  })
  await test('rescan timeout preserves scanning state and last completed timestamp', async () => {
    const pool = new FinderPool()
    const lease = { finder: { scanFiles() {}, waitForScan: async () => { throw Error('timeout') }, isScanning: () => true }, basePath: root, warming: true, scannedAt: 123 }
    await pool.rescan(lease, { throttleMs: 0 })
    assert.equal(lease.warming, true)
    assert.equal(lease.scannedAt, 123)
    pool.disposeAll()
  })
  await test('a local write invalidates buffered pages rather than returning disproven bytes', async () => {
    clearOverlay()
    const { pool } = harness([hit('src/a.ts'), hit('src/b.ts')])
    const tool = createGrepTool(pool)
    const first = await tool.execute({ pattern: 'needle', limit: 1 }, exec)
    assert.ok(first.nextCursor)
    markWritten(path.join(root, 'src/b.ts'), 'no longer matches\n')
    const second = await tool.execute({ pattern: 'needle', limit: 1, cursor: first.nextCursor }, exec)
    assert.match(second.error, /cursor.*(changed|expired)|restart/i)
  })
  await test('temporary same-root initialization is shared and all allocations are disposed', async () => {
    const original = FileFinder.create
    let release
    const wait = new Promise(resolve => { release = resolve })
    const allocated = []
    FileFinder.create = () => { const f = { isDestroyed: false, waitForScan: () => wait, isScanning: () => false, destroy() { this.isDestroyed = true } }; allocated.push(f); return { ok: true, value: f } }
    const pool = new FinderPool()
    try {
      const a = pool.temporary(root), b = pool.temporary(root)
      release()
      const [one, two] = await Promise.all([a, b])
      assert.equal(one.finder, two.finder)
      assert.equal(allocated.length, 1)
      pool.disposeAll()
      assert.ok(allocated.every(f => f.isDestroyed))
    } finally { release(); pool.disposeAll(); FileFinder.create = original }
  })
  await test('disposing during temporary initialization cannot publish or leak a finder', async () => {
    const original = FileFinder.create
    let release
    const wait = new Promise(resolve => { release = resolve })
    const allocated = []
    FileFinder.create = () => { const f = { isDestroyed: false, waitForScan: () => wait, isScanning: () => false, destroy() { this.isDestroyed = true } }; allocated.push(f); return { ok: true, value: f } }
    const pool = new FinderPool()
    try {
      const pending = pool.temporary(root)
      pool.disposeAll()
      release()
      assert.ok((await pending).error)
      assert.ok(allocated.every(f => f.isDestroyed))
      assert.equal(pool.live().length, 0)
    } finally { release(); pool.disposeAll(); FileFinder.create = original }
  })
  await test('an active retained temporary lease blocks eviction until its consumer releases it', async () => {
    const original = FileFinder.create
    const allocated = []
    FileFinder.create = () => { const f = { isDestroyed: false, waitForScan: async () => {}, isScanning: () => true, destroy() { this.isDestroyed = true } }; allocated.push(f); return { ok: true, value: f } }
    const pool = new FinderPool()
    try {
      const first = await pool.temporary(root, { retain: true })
      const competing = await pool.temporary(path.join(root, 'src'), { retain: true })
      assert.match(competing.error, /active|busy|use/i)
      assert.equal(first.finder.isDestroyed, false)
      first.release()
      const next = await pool.temporary(path.join(root, 'src'), { retain: true })
      assert.ok(!next.error, next.error)
      assert.equal(first.finder.isDestroyed, true)
      next.release()
    } finally { pool.disposeAll(); FileFinder.create = original }
  })
  await test('a grep waiting for a warm temporary index retains and finally releases its lease', async () => {
    clearOverlay()
    const original = FileFinder.create
    let entered, finish
    const waiting = new Promise(resolve => { entered = resolve })
    const resume = new Promise(resolve => { finish = resolve })
    let temporary
    FileFinder.create = ({ basePath }) => {
      let scans = 0
      const isTemp = basePath === root
      const finder = { isDestroyed: false,
        waitForScan: async () => { if (isTemp && ++scans === 2) { entered(); await resume } },
        isScanning: () => isTemp && scans < 2,
        grep: () => { assert.equal(finder.isDestroyed, false); return page(isTemp && scans >= 2 ? [hit('a.ts')] : []) },
        destroy() { this.isDestroyed = true },
      }
      if (isTemp) temporary = finder
      return { ok: true, value: finder }
    }
    const pool = new FinderPool()
    try {
      const tool = createGrepTool(pool)
      const request = tool.execute({ pattern: 'needle', path: root }, { agent: { session: { header: { cwd: path.join(root, 'src') } } } })
      await waiting
      assert.match((await pool.temporary(path.join(root, 'src'))).error, /active|busy/i)
      assert.equal(temporary.isDestroyed, false)
      finish()
      assert.equal((await request).items.length, 1)
      assert.ok(!(await pool.temporary(path.join(root, 'src'))).error, 'finally releases the active temporary reader')
    } finally { finish(); pool.disposeAll(); FileFinder.create = original }
  })
} finally {
  clearOverlay()
  fs.rmSync(root, { recursive: true, force: true })
}
