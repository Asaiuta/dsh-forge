// 写后 overlay：本进程刚写的文件，在索引追上之前就以实时内容作答。
//
// 这条链路的价值全在"两头都疼"的那个窗口里：fff 的索引要 2.3 s 强制重扫
// 或 3.4-4.3 s watcher 往返才认识一次写入，而且没有单文件增量重建 API。
// 所以测试必须同时证明两件事，缺一不可：
//
//   立刻可见  写完马上查，新内容就在结果里（而不是等索引）
//   不算错账  同一次查询里，被覆盖文件的**旧**行不能出现——否则模型会看到
//             一行已被删掉的代码，和它的替代品并排躺在一页里
//
// 第三件是"回到原样"：TTL 过期后 overlay 清空，行为必须和没有 overlay 时
// 逐字节一致，否则这个优化就成了永久性语义偏移。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const lib = (name) => import(new URL(`../lib/${name}`, import.meta.url).href)
const { markWritten, overlaySnapshot, searchOverlay, clearOverlay, OVERLAY_TTL_MS, matchesCase } = await lib('overlay.js')
const { createGrepTool } = await lib('tools.js')
const { FinderPool } = await lib('core.js')
const { storeFor, commitFiles, putBlob } = await lib('ledger.js')

let passed = 0
const ok = (name) => console.log(`ok ${++passed} - ${name}`)

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-overlay-'))
process.env.DSH_FORGE_DATA_DIR = path.join(sandbox, '.forge-data')

// --- registry 规则 ---------------------------------------------------------
{
  clearOverlay()
  const file = path.join(sandbox, 'a.ts')
  markWritten(file, 'const alpha = 1\nconst beta = 2\n')
  const snap = overlaySnapshot(sandbox)
  assert.equal(snap.files.length, 1)
  assert.equal(snap.files[0].rel, 'a.ts', 'relative path must use forward slashes')
  assert.ok(snap.shadowed.has('a.ts'))
  ok('a committed file is overlaid and shadowed under its root')
}

{
  clearOverlay()
  markWritten(path.join(sandbox, 'gone.ts'), null)
  const snap = overlaySnapshot(sandbox)
  assert.equal(snap.files.length, 0, 'a deleted file has no content to serve')
  assert.ok(snap.shadowed.has('gone.ts'), 'a deleted file must still shadow the index')
  ok('a deletion shadows without serving content')
}

{
  clearOverlay()
  markWritten(path.join(sandbox, 'old.ts'), 'x')
  const later = Date.now() + OVERLAY_TTL_MS + 1
  const snap = overlaySnapshot(sandbox, later)
  assert.equal(snap.files.length, 0, 'the overlay must not outlive its TTL')
  assert.equal(snap.shadowed.size, 0)
  ok('expired entries stop shadowing instead of going permanent')
}

{
  clearOverlay()
  markWritten(path.join(sandbox, 'nested', 'deep.ts'), 'y')
  markWritten(path.join(sandbox, '..', 'outside.ts'), 'z')
  const snap = overlaySnapshot(path.join(sandbox, 'nested'))
  assert.deepEqual(snap.files.map((f) => f.rel), ['deep.ts'], 'only files under the searched root are served')
  ok('the overlay is scoped to the index root being searched')
}

// --- 匹配语义要和引擎一致 ---------------------------------------------------
{
  clearOverlay()
  const file = path.join(sandbox, 'case.ts')
  markWritten(file, 'createReadTool\nCREATEREADTOOL\ncreatereadtool\n')
  const all = overlaySnapshot(sandbox).files
  const lower = searchOverlay(all, 'createreadtool', { mode: 'plain', smartCase: true, context: 0, limit: 50 })
  assert.equal(lower.length, 3, 'an all-lowercase query is case-insensitive (engine default)')
  const mixed = searchOverlay(all, 'createReadtool', { mode: 'plain', smartCase: true, context: 0, limit: 50 })
  assert.equal(mixed.length, 0, 'a query with capitals is case-sensitive')
  assert.equal(matchesCase('abc', true), true)
  assert.equal(matchesCase('Abc', true), false)
  // 引擎实测值：smartCase:false 不是"总是不敏感"，而是"总是敏感"。这条注释写在
  // overlay.ts 里就是为了防止后人把它"修正"成直觉版本。
  assert.equal(matchesCase('abc', false), false, 'smartCase:false means always case-SENSITIVE in fff 0.11.0')
  ok('case rules match the engine, including the counter-intuitive smartCase:false')
}

{
  clearOverlay()
  markWritten(path.join(sandbox, 're.ts'), 'a1\nab\nzz\n')
  const all = overlaySnapshot(sandbox).files
  assert.deepEqual(
    searchOverlay(all, 'a\\d', { mode: 'regex', smartCase: true, context: 0, limit: 50 }).map((i) => i.line),
    [1],
    'regex mode must use the pattern as a regex',
  )
  assert.equal(
    searchOverlay(all, 'a\\d', { mode: 'plain', smartCase: true, context: 0, limit: 50 }).length,
    0,
    'plain mode must treat it literally',
  )
  // 编译失败时引擎回退字面量；overlay 跟随后者，不跟随错误。
  assert.equal(
    searchOverlay(all, '(', { mode: 'regex', smartCase: true, context: 0, limit: 50 }).length,
    0,
    'an uncompilable regex falls back to a literal, like the engine',
  )
  assert.equal(
    searchOverlay(all, 'a', { mode: 'fuzzy', smartCase: true, context: 0, limit: 50 }).length,
    0,
    'fuzzy is refused rather than approximated: the index stays the only answer for it',
  )
  ok('regex / plain / fallback behaviour mirrors the engine, fuzzy is refused')
}

{
  clearOverlay()
  markWritten(path.join(sandbox, 'col.ts'), 'ab✓cd\n')
  const all = overlaySnapshot(sandbox).files
  const hit = searchOverlay(all, 'cd', { mode: 'plain', smartCase: true, context: 0, limit: 50 })[0]
  assert.equal(hit.col, Buffer.byteLength('ab✓', 'utf8'), 'col is a 0-based BYTE column, as the engine reports it')
  ok('byte columns survive multi-byte text')
}

{
  clearOverlay()
  markWritten(path.join(sandbox, 'ctx.ts'), 'l1\nl2\nTARGET\nl4\nl5\n')
  const all = overlaySnapshot(sandbox).files
  const hit = searchOverlay(all, 'TARGET', { mode: 'plain', smartCase: true, context: 1, limit: 50 })[0]
  assert.deepEqual(hit.context.map((c) => [c.line, c.before]), [[2, true], [4, false]])
  ok('context lines carry the same before/after shape as the engine')
}

// --- 真实索引 + 真实写入 ----------------------------------------------------
{
  clearOverlay()
  const root = path.join(sandbox, 'repo')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'one.ts'), 'export function alphaOne() {}\n')
  fs.writeFileSync(path.join(root, 'src', 'two.ts'), 'export function betaTwo() {}\n')

  const pool = new FinderPool()
  const grep = createGrepTool(pool)
  const exec = { agent: { session: { header: { cwd: root, id: 'overlay' } } } }
  const search = (pattern, extra = {}) => grep.execute({ pattern, ...extra }, exec)

  // Warm the index so the pre-write state is settled.
  const before = await search('alphaOne')
  assert.equal(before.items.length, 1)
  assert.ok(!before.note?.includes('live content'), 'a plain indexed hit must not claim to be live')

  // Commit a rename through the real funnel: this is what ffedit/ff_file/rollback do.
  const store = storeFor(root)
  const file = path.join(root, 'src', 'one.ts')
  const beforeBytes = fs.readFileSync(file)
  const next = Buffer.from('export function omegaRenamed() {}\n', 'utf8')
  commitFiles(store, {
    kind: 'edit',
    reason: 'overlay probe',
    actor: 'test',
    nodes: [{
      file: 'src/one.ts',
      op: 'update',
      before: putBlob(store, beforeBytes).id,
      after: putBlob(store, next).id,
      bytes: next.length,
      eol: 'LF',
      bom: false,
    }],
  }, [{ file, before: beforeBytes, after: next }])

  const stale = await search('alphaOne')
  assert.equal(stale.items.length, 0, 'the pre-edit symbol must be gone immediately, not in 2.3 s')

  const fresh = await search('omegaRenamed')
  assert.equal(fresh.items.length, 1, 'the new symbol must be visible immediately')
  assert.match(fresh.note ?? '', /live content/, 'a live answer must announce itself')
  assert.equal(fresh.items[0].file, 'src/one.ts', 'live hits keep the slash-separated spelling indexed hits use')

  const other = await search('betaTwo')
  assert.equal(other.items.length, 1, 'untouched files keep coming from the index')
  assert.ok(!other.note?.includes('live content'), 'index-only answers stay unlabelled')

  // A deletion must stop answering too.
  const twoBytes = fs.readFileSync(path.join(root, 'src', 'two.ts'))
  commitFiles(store, {
    kind: 'edit',
    reason: 'overlay probe',
    actor: 'test',
    nodes: [{
      file: 'src/two.ts',
      op: 'delete',
      before: putBlob(store, twoBytes).id,
      after: null,
      bytes: 0,
      eol: 'LF',
      bom: false,
    }],
  }, [{ file: path.join(root, 'src', 'two.ts'), before: twoBytes, after: null }])
  const removed = await search('betaTwo')
  assert.equal(removed.items.length, 0, 'a deleted file must stop answering from its indexed content')
  ok('a committed write is searchable immediately; the stale line and the deleted file are gone')

  pool.disposeAll()
}

clearOverlay()
fs.rmSync(sandbox, { recursive: true, force: true })

console.log(`\n${passed} overlay groups passed`)
