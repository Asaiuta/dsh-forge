/** End-to-end file/code transfers, byte recovery, transaction compensation and scope. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { createFileTool } from '../lib/tools-files.js'
import { createProjectTool } from '../lib/tools-project.js'
import { createRollbackTool } from '../lib/tools-edit.js'
import { createDiffTool } from '../lib/tools-history.js'
import { FinderPool } from '../lib/core.js'
import { storeFor, readLedgerTail, workspaceKey, putBlob, recordBatch } from '../lib/ledger.js'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'

const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'forge-files-'))
const workspace = path.join(sandbox, 'work')
fs.mkdirSync(path.join(workspace, 'src'), { recursive: true })
process.env.DSH_FORGE_DATA_DIR = path.join(sandbox, 'data')
const exec = { agent: { session: { header: { cwd: workspace, id: 'files' } } }, token: {} }
const file = name => path.join(workspace, name)
const tool = createFileTool(), projects = createProjectTool(), pool = new FinderPool(), rollback = createRollbackTool(pool)
const call = args => tool.execute({ reason: 'test', ...args }, exec)
const undo = batch => rollback.execute({ batch: String(batch), reason: 'undo', dryRun: false }, exec)
let passed = 0
const ok = label => console.log(`ok ${++passed} - ${label}`)
async function main() {
  const project = (await projects.execute({ action: 'create', name: 'files', root: 'src', reason: 'start' }, exec)).projects[0]
  const id = project.id
  const created = await call({ action: 'create', path: 'src/a.txt', content: 'initial\r\n', projectId: id })
  assert.ok(created.batch)
  const runtime = Object.create(ToolRuntime.prototype); runtime.canonicalResults = new WeakMap(); runtime.concludingExecutions = new WeakSet()
  runtime.createSuccessResult(exec, defineTool(tool), created)
  assert.match((await call({ action: 'create', path: 'src/a.txt', content: 'overwrite' })).error, /overwrite/)
  const overwritten = await call({ action: 'create', path: 'src/a.txt', content: 'next', overwrite: true })
  await undo(overwritten.batch)
  assert.equal(fs.readFileSync(file('src/a.txt'), 'utf8'), 'initial\r\n')
  ok('create and explicit overwrite validate actual SDK and restore original CRLF bytes')

  const binary = Buffer.from([0, 255, 77, 10, 128])
  fs.writeFileSync(file('src/blob.bin'), binary)
  const removed = await call({ action: 'remove', path: 'src/blob.bin', projectId: id })
  assert.equal(fs.existsSync(file('src/blob.bin')), false)
  const diff = await createDiffTool().execute({ batch: removed.batch }, exec)
  assert.equal(diff.items[0].binary, true)
  await undo(removed.batch); assert.deepEqual(fs.readFileSync(file('src/blob.bin')), binary)
  ok('remove retains recoverable exact binary bytes and immutable binary diff')

  const moved = await call({ action: 'move', path: 'src/blob.bin', destination: 'src/moved.bin', projectId: id })
  assert.equal(fs.existsSync(file('src/blob.bin')), false); assert.deepEqual(fs.readFileSync(file('src/moved.bin')), binary)
  assert.equal(readLedgerTail(storeFor(workspace)).find(batch => batch.id === moved.batch).nodes.length, 2)
  await undo(moved.batch)
  assert.deepEqual(fs.readFileSync(file('src/blob.bin')), binary); assert.equal(fs.existsSync(file('src/moved.bin')), false)
  fs.writeFileSync(file('src/exists.bin'), 'existing')
  assert.match((await call({ action: 'move', path: 'src/blob.bin', destination: 'src/exists.bin' })).error, /overwrite/)
  ok('move commits two nodes together, refuses collisions, and rollback restores both paths')

  fs.writeFileSync(file('src/source.js'), '/** A */\r\nfunction A() {\r\n  return 1\r\n}\r\nfunction B() {}\r\n')
  fs.writeFileSync(file('src/target.js'), '\uFEFF// target\r\n')
  const originalSource = fs.readFileSync(file('src/source.js')), originalTarget = fs.readFileSync(file('src/target.js'))
  const copied = await call({ action: 'copy_code', path: 'src/source.js', symbol: 'A', destination: 'src/target.js', after: 1, projectId: id })
  assert.ok(copied.batch, copied.error)
  assert.deepEqual(fs.readFileSync(file('src/source.js')), originalSource)
  assert.ok(fs.readFileSync(file('src/target.js'), 'utf8').includes('/** A */\r\nfunction A()'))
  await undo(copied.batch); assert.deepEqual(fs.readFileSync(file('src/target.js')), originalTarget)
  const transferred = await call({ action: 'move_code', path: 'src/source.js', symbol: 'A', destination: 'src/target.js', after: 1, projectId: id })
  assert.ok(transferred.batch, transferred.error)
  assert.equal(fs.readFileSync(file('src/source.js'), 'utf8').includes('function A'), false)
  await undo(transferred.batch)
  assert.deepEqual(fs.readFileSync(file('src/source.js')), originalSource); assert.deepEqual(fs.readFileSync(file('src/target.js')), originalTarget)
  ok('cross-file symbol copy/move includes adjacent comments, preserves destination BOM/EOL, and rolls back together')

  const reordered = await call({ action: 'move_code', path: 'src/source.js', destination: 'src/source.js', symbol: 'A', after: 5 })
  assert.ok(reordered.batch, reordered.error)
  assert.ok(fs.readFileSync(file('src/source.js'), 'utf8').indexOf('function B') < fs.readFileSync(file('src/source.js'), 'utf8').indexOf('function A'))
  await undo(reordered.batch)
  assert.match((await call({ action: 'move_code', path: 'src/source.js', destination: 'src/source.js', symbol: 'A', after: 2 })).error, /inside/)
  ok('same-file move compiles source/destination against one snapshot and rejects overlap')

  fs.writeFileSync(file('src/inline.js'), '\uFEFFconst chinese="中文"; class C { run() { return "😀"; } other() {} }\r\n')
  const inlineBefore = fs.readFileSync(file('src/inline.js'))
  const symbolEdit = await call({ action: 'edit_symbol', path: 'src/inline.js', symbol: 'C.run', edit: 'replace', content: 'run() { return "changed"; }' })
  assert.ok(symbolEdit.batch, symbolEdit.error)
  assert.equal(fs.readFileSync(file('src/inline.js'), 'utf8'), '\uFEFFconst chinese="中文"; class C { run() { return "changed"; } other() {} }\r\n')
  await undo(symbolEdit.batch); assert.deepEqual(fs.readFileSync(file('src/inline.js')), inlineBefore)
  const deletedSymbol = await call({ action: 'edit_symbol', path: 'src/inline.js', symbol: 'C.other', edit: 'delete' })
  assert.ok(deletedSymbol.batch, deletedSymbol.error)
  assert.equal(fs.readFileSync(file('src/inline.js'), 'utf8').includes('other()'), false)
  assert.ok(fs.readFileSync(file('src/inline.js'), 'utf8').includes('return "😀";'))
  await undo(deletedSymbol.batch)
  const insertedSymbol = await call({ action: 'edit_symbol', path: 'src/inline.js', symbol: 'C.other', edit: 'insert_before', content: 'added() {} ' })
  assert.ok(insertedSymbol.batch, insertedSymbol.error)
  assert.ok(fs.readFileSync(file('src/inline.js'), 'utf8').includes('added() {} other() {}'))
  await undo(insertedSymbol.batch)
  assert.deepEqual(fs.readFileSync(file('src/inline.js')), inlineBefore)
  ok('exact symbol replace/delete/insert preserve same-line neighbors, Unicode offsets, BOM/EOL and byte rollback')

  fs.writeFileSync(file('src/comment.js'), 'const keep = 42; // docs for Drop\nfunction Drop() {}\n')
  const dropped = await call({ action: 'edit_symbol', path: 'src/comment.js', symbol: 'Drop', edit: 'delete' })
  assert.ok(dropped.batch, dropped.error)
  assert.equal(fs.readFileSync(file('src/comment.js'), 'utf8'), 'const keep = 42; // docs for Drop\n\n')
  ok('preceding trailing comment cannot make symbol deletion consume another statement')

  for (const [name, content, symbol] of [
    ['multi.js', 'const keep=1, drop=2;\n', 'drop'],
    ['multi.c', 'int keep=1, drop=2;\n', 'drop'],
    ['inline-type.c', 'struct C { int x; } drop;\nstruct C *keep;\n', 'drop'],
    ['inline-type.cpp', 'struct C { int x; } drop;\nC keep;\n', 'C'],
    ['inline-alias.c', 'typedef struct C { int x; } Drop;\nstruct C *keep;\n', 'Drop'],
    ['Multi.java', 'class C { int keep=1, drop=2; }\n', 'C.drop'],
    ['Multi.cs', 'class C { int keep=1, drop=2; }\n', 'C.drop'],
    ['multi.lua', 'local keep, drop = 1, 2\n', 'drop'],
  ]) {
    fs.writeFileSync(file(`src/${name}`), content)
    const ledger = fs.readFileSync(storeFor(workspace).ledgerFile)
    for (const action of ['edit_symbol', 'move_code', 'copy_code']) {
      const result = await call({ action, path: `src/${name}`, symbol, edit: 'delete', destination: 'src/target.js', after: 0 })
      assert.match(result.error, /shares a declaration|syntax-valid original parse|must be unique/, `${name} ${action}: ${result.error}`)
      assert.equal(fs.readFileSync(file(`src/${name}`), 'utf8'), content)
      assert.deepEqual(fs.readFileSync(storeFor(workspace).ledgerFile), ledger)
    }
  }
  ok('shared declarators in JS/C/Java/C#/Lua refuse isolated mutation or transfer with zero file/history changes')

  for (const [name, content, symbol] of [
    ['member.js', 'const C = { drop:1, keep:2 };\n', 'C.drop'],
    ['method.js', 'const C = { drop() { return 1; }, keep() { return 2; } };\n', 'C.drop'],
    ['member.rs', 'enum C { Drop, Keep }\n', 'C::Drop'],
    ['Member.java', 'enum C { Drop, Keep }\n', 'C.Drop'],
  ]) {
    fs.writeFileSync(file(`src/${name}`), content)
    assert.match((await call({ action: 'edit_symbol', path: `src/${name}`, symbol, edit:'delete' })).error, /separator handling/, name)
    assert.equal(fs.readFileSync(file(`src/${name}`), 'utf8'), content)
  }
  ok('comma list member deletion refuses unsafe separator removal even where grammar misses invalid output')

  for (const [name, content, symbol, prefix, neighbor] of [
    ['attr.rs', '#[test]\nfn drop() {}\nfn keep() {}\n', 'drop', '#[test]', 'fn keep() {}'],
    ['attr-comments.rs', '#[test]\n// docs\n#[allow(dead_code)]\nfn drop() {}\nfn keep() {}\n', 'drop', '#[test]\n// docs\n#[allow(dead_code)]', 'fn keep() {}'],
    ['template.cpp', 'template<typename T>\nT drop(T a) { return a; }\nvoid keep() {}\n', 'drop', 'template<typename T>', 'void keep() {}'],
    ['export.js', 'export const drop = () => 1;\nconst keep = 2;\n', 'drop', 'export const drop', 'const keep = 2;'],
  ]) {
    fs.writeFileSync(file(`src/${name}`), content)
    fs.writeFileSync(file(`src/to-${name}`), '')
    const transferred = await call({ action: 'move_code', path: `src/${name}`, symbol, destination: `src/to-${name}`, after: 0 })
    assert.ok(transferred.batch, `${name}: ${transferred.error}`)
    assert.equal(fs.readFileSync(file(`src/${name}`), 'utf8'), neighbor + '\n')
    assert.ok(fs.readFileSync(file(`src/to-${name}`), 'utf8').startsWith(prefix), name)
    await undo(transferred.batch)
    assert.equal(fs.readFileSync(file(`src/${name}`), 'utf8'), content)
  }
  ok('Rust attributes, C++ templates and JS exported variables travel with their symbols and preserve neighbors')

  const timeline1 = await call({ action: 'create', path: 'src/timeline.txt', content: 'one\n', projectId: id })
  const timeline2 = await call({ action: 'create', path: 'src/timeline.txt', content: 'two\n', overwrite: true, projectId: id })
  const point = await rollback.execute({ throughBatch: timeline1.batch, path: 'timeline.txt', projectId: id, dryRun: false, reason: 'point restore' }, exec)
  assert.equal(point.status, 'applied', point.error)
  assert.equal(fs.readFileSync(file('src/timeline.txt'), 'utf8'), 'one\n')
  await undo(point.newBatch)
  assert.equal(fs.readFileSync(file('src/timeline.txt'), 'utf8'), 'two\n')
  assert.match((await rollback.execute({ batch: String(timeline2.batch), throughBatch: timeline1.batch, reason: 'invalid' }, exec)).error, /exactly one/)
  ok('throughBatch restores file state at a named ledger boundary and its own rollback redoes the current bytes')

  const boundary = await call({ action: 'create', path: 'src/external-time.txt', content: 'AT_BOUNDARY', projectId: id })
  fs.writeFileSync(file('src/external-time.txt'), 'EXTERNAL_AFTER_BOUNDARY')
  await call({ action: 'create', path: 'src/external-time.txt', content: 'CURRENT', overwrite: true, projectId: id })
  const boundaryUndo = await rollback.execute({ throughBatch: boundary.batch, path: 'external-time.txt', projectId: id, dryRun: false, reason: 'external boundary' }, exec)
  assert.equal(boundaryUndo.status, 'applied', boundaryUndo.error)
  assert.equal(fs.readFileSync(file('src/external-time.txt'), 'utf8'), 'AT_BOUNDARY')
  await undo(boundaryUndo.newBatch)
  assert.equal(fs.readFileSync(file('src/external-time.txt'), 'utf8'), 'CURRENT')
  ok('point rollback uses boundary after-state across later external modifications; undo restores current bytes')

  const beforeLedger = fs.readFileSync(storeFor(workspace).ledgerFile)
  const rename = fs.renameSync
  let fail = true
  fs.renameSync = function(from, to) { if (to === file('src/failure.bin') && fail) { fail = false; throw Error('move destination failure') } return rename(from, to) }
  syncBuiltinESMExports()
  try { assert.match((await call({ action: 'move', path: 'src/blob.bin', destination: 'src/failure.bin' })).error, /failure/) }
  finally { fs.renameSync = rename; syncBuiltinESMExports() }
  assert.deepEqual(fs.readFileSync(file('src/blob.bin')), binary)
  assert.equal(fs.existsSync(file('src/failure.bin')), false)
  assert.deepEqual(fs.readFileSync(storeFor(workspace).ledgerFile), beforeLedger)
  ok('second-file failure compensates the first deletion and leaves no committed batch')

  assert.match((await call({ action: 'create', path: '../escape', content: 'x' })).error, /inside/)
  assert.match((await call({ action: 'create', path: 'outside-project.txt', content: 'x', projectId: id })).error, /outside project/)
  assert.match((await call({ action: 'create', path: 'missing/parent.txt', content: 'x' })).error, /parent/)
  fs.writeFileSync(file('src/invalid.js'), Buffer.from([65, 255, 10]))
  assert.ok((await call({ action: 'copy_code', path: 'src/invalid.js', symbol: 'A', destination: 'src/target.js', after: 0 })).error)
  ok('workspace/project containment, absent parents and invalid source encoding fail before writes')

  fs.writeFileSync(file('src/human.txt'), 'HUMAN\n')
  const link = file('src/link.txt')
  fs.symlinkSync(file('src/human.txt'), link)
  const beforeLinks = fs.readFileSync(storeFor(workspace).ledgerFile)
  for (const action of ['remove', 'move']) {
    assert.match((await call({ action, path: 'src/link.txt', destination: 'src/new-link.txt' })).error, /symbolic link identity/)
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true)
    assert.equal(fs.readFileSync(file('src/human.txt'), 'utf8'), 'HUMAN\n')
  }
  const replaceLink = await call({ action: 'create', path: 'src/created-link.txt', content: 'created' })
  fs.unlinkSync(file('src/created-link.txt')); fs.symlinkSync(file('src/human.txt'), file('src/created-link.txt'))
  const priorRollback = fs.readFileSync(storeFor(workspace).ledgerFile)
  assert.match((await undo(replaceLink.batch)).error, /symbolic link identity/)
  assert.equal(fs.lstatSync(file('src/created-link.txt')).isSymbolicLink(), true)
  assert.equal(fs.readFileSync(file('src/human.txt'), 'utf8'), 'HUMAN\n')
  assert.deepEqual(fs.readFileSync(storeFor(workspace).ledgerFile), priorRollback)
  assert.ok(priorRollback.length > beforeLinks.length)
  ok('file removal/move and rollback refuse link identity without changing links, human targets or history')

  const dangling = await call({ action:'create', path:'src/dangling.txt',content:'BEFORE' })
  fs.unlinkSync(file('src/dangling.txt'))
  fs.symlinkSync(file('src/absent-target.txt'), file('src/dangling.txt'))
  const danglingLedger = fs.readFileSync(storeFor(workspace).ledgerFile)
  for (const action of ['create', 'remove', 'move']) {
    assert.match((await call({ action, path:'src/dangling.txt',destination:'src/other.txt',content:'AFTER' })).error, /symbolic link identity/)
  }
  assert.match((await undo(dangling.batch)).error, /symbolic link identity/)
  assert.equal(fs.lstatSync(file('src/dangling.txt')).isSymbolicLink(), true)
  assert.equal(fs.existsSync(file('src/absent-target.txt')), false)
  assert.deepEqual(fs.readFileSync(storeFor(workspace).ledgerFile), danglingLedger)
  ok('dangling links retain identity and history across create/remove/move and rollback refusal')

  const alias = path.join(sandbox, 'junction')
  fs.symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const isolated = path.join(sandbox, 'legacy-data')
  const previousData = process.env.DSH_FORGE_DATA_DIR
  process.env.DSH_FORGE_DATA_DIR = isolated
  const deepRoot = path.join(sandbox, 'real/deep/work')
  fs.mkdirSync(deepRoot, { recursive: true })
  const deepAlias = path.join(sandbox, 'deep-alias')
  fs.symlinkSync(deepRoot, deepAlias, process.platform === 'win32' ? 'junction' : 'dir')
  const originalFile = path.join(deepRoot, 'x.txt')
  const oldRelative = path.relative(deepAlias, originalFile).split(path.sep).join('/')
  const decoy = path.resolve(deepRoot, oldRelative)
  assert.notEqual(decoy, originalFile)
  fs.mkdirSync(path.dirname(decoy), { recursive: true })
  fs.writeFileSync(originalFile, 'AFTER\n'); fs.writeFileSync(decoy, 'HUMAN DECOY\n')
  const legacy = { root: deepAlias, dir: path.join(isolated, 'snapshots', workspaceKey(deepAlias)) }
  Object.assign(legacy, { ledgerFile: path.join(legacy.dir, 'ledger.jsonl'), stateFile: path.join(legacy.dir, 'state.json'), blobsDir: path.join(legacy.dir, 'blobs') })
  fs.mkdirSync(legacy.dir, { recursive: true }); fs.writeFileSync(path.join(legacy.dir, 'workspace.json'), JSON.stringify({ root: deepAlias }))
  const beforeBlob = putBlob(legacy, Buffer.from('BEFORE\n')).id, afterBlob = putBlob(legacy, Buffer.from('AFTER\n')).id
  const legacyBatch = recordBatch(legacy, { kind: 'edit', actor: 'old-host', reason: 'legacy coordinates', nodes: [{
    file: oldRelative, op: 'update', before: beforeBlob, after: afterBlob, bytes: 6, eol: 'LF', bom: false,
  }] })
  assert.equal(storeFor(deepRoot).root, deepAlias)
  const legacyUndo = await rollback.execute({ batch: String(legacyBatch.id), reason: 'coordinate regression', dryRun: false },
    { agent: { session: { header: { cwd: deepRoot, id: 'new-host' } } } })
  assert.equal(legacyUndo.status, 'applied', legacyUndo.error)
  assert.equal(fs.readFileSync(originalFile, 'utf8'), 'BEFORE\n')
  assert.equal(fs.readFileSync(decoy, 'utf8'), 'HUMAN DECOY\n')
  ok('canonical caller rolls back historical alias coordinates to the intended file and leaves the decoy untouched')
  const oldDir = path.join(isolated, 'snapshots', workspaceKey(alias))
  fs.mkdirSync(oldDir, { recursive: true }); fs.writeFileSync(path.join(oldDir, 'workspace.json'), JSON.stringify({ root: alias }))
  assert.equal(storeFor(workspace).dir, oldDir)
  assert.equal(storeFor(alias).dir, oldDir)
  fs.mkdirSync(path.join(isolated, 'snapshots', workspaceKey(workspace)), { recursive: true })
  fs.writeFileSync(path.join(isolated, 'snapshots', workspaceKey(workspace), 'workspace.json'), JSON.stringify({ root: workspace }))
  assert.throws(() => storeFor(alias), /multiple snapshot stores/)
  process.env.DSH_FORGE_DATA_DIR = previousData
  ok('legacy junction history is reused by canonical callers; competing histories fail explicitly')
  // --- transfer anchor matrix + indent=auto + fromLines (PF MoveCode/CopyCode semantics) ---
  fs.writeFileSync(file('lib.js'), 'export function target() {}\n\nexport function afterMe() {\n  return 1;\n}\n')
  fs.writeFileSync(file('dest.js'), 'function wrapper() {\n  return 2;\n}\n')
  const anchored = await call({ action: 'copy_code', path: 'lib.js', symbol: 'afterMe', destination: 'dest.js', afterSymbol: 'wrapper' })
  assert.ok(anchored.batch)
  assert.ok(fs.readFileSync(file('dest.js'), 'utf8').includes('export function afterMe()'))
  assert.ok(anchored.note.includes('insert after wrapper'))
  ok('copy_code anchors by afterSymbol')
  const beforeAnchor = await call({ action: 'copy_code', path: 'lib.js', symbol: 'target', destination: 'dest.js', beforeSymbol: 'wrapper' })
  assert.ok(beforeAnchor.note.includes('incl. its leading comment'))
  const destText = fs.readFileSync(file('dest.js'), 'utf8')
  assert.ok(destText.indexOf('export function target() {}') < destText.indexOf('function wrapper'))
  ok('copy_code beforeSymbol inserts ahead of the anchor symbol')
  fs.writeFileSync(file('src2.js'), 'doWork();\nlogDone();\n')
  fs.writeFileSync(file('nest.js'), 'function outer() {\n  if (ok) {\n    return 1;\n  }\n}\n')
  const shifted = await call({ action: 'copy_code', path: 'src2.js', destination: 'nest.js', fromLines: 'L1-2', before: 4 })
  const nestText = fs.readFileSync(file('nest.js'), 'utf8')
  assert.ok(nestText.includes('    doWork();') && nestText.includes('    logDone();'))
  assert.ok(shifted.note.includes('indent adjusted: 0 \u2192 4 spaces'))
  ok('fromLines source with before=N and indent=auto re-indentation')
  const flat = await call({ action: 'copy_code', path: 'src2.js', destination: 'nest.js', fromLines: 'L1', after: 1, indent: 'none' })
  assert.ok(fs.readFileSync(file('nest.js'), 'utf8').includes('\ndoWork();\n  if (ok)'))
  ok('indent=none keeps block bytes as-is')
  const conflicting = await call({ action: 'copy_code', path: 'lib.js', symbol: 'target', destination: 'dest.js', after: 1, beforeSymbol: 'wrapper' })
  assert.ok(conflicting.error.includes('exactly one destination anchor'))
  ok('conflicting anchors refuse explicitly')
  const moveSame = await call({ action: 'move_code', path: 'lib.js', fromLines: 'L1-3', destination: 'lib.js', after: 2 })
  assert.ok(moveSame.error.includes('inside the source block'))
  ok('same-file move into the source block refuses')
  console.log(`${passed} file groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { pool.disposeAll(); fs.rmSync(sandbox, { recursive: true, force: true }) })
