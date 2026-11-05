/**
 * 参数卫生：strict 化的上游（Responses/Codex 后端）会把 tools schema 里每个
 * property 都当必填，模型于是补全全部字段——空串、空数组、默认枚举值一起塞进来。
 *
 * 契约：
 * H1 空值形态的不适用参数视为「未表达意图」，归一后照常执行；
 * H2 非空形态的不适用参数仍是真实误用，必须拒绝（保住 strictly rejects 的承诺）；
 * H3 有效字段的空串语义不变：replaceWith:'' 删除匹配块，symbol edit 的 content:'' 合法；
 * H4 默认值形态（includeLeadingComment:true / indent:'auto' / overwrite:false /
 *    edit:'replace'）在字段不适用时视同未提供；
 * H5 required 语义不变：path / reason 缺失仍然报错。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createEditTool } from '../src/tools-edit.ts'
import { createFileTool } from '../src/tools-files.ts'
import { createReadTool } from '../src/tools-read.ts'
import { createVerifyTool } from '../src/tools-verify.ts'
import { createTraceTool } from '../src/tools-trace.ts'
import { createRollbackTool } from '../src/tools-edit.ts'
import { defineForgeTool } from '../src/host.ts'
import { FinderPool } from '../src/core.ts'

const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'forge-hygiene-'))
const workspace = path.join(sandbox, 'work')
fs.mkdirSync(workspace, { recursive: true })
process.env.DSH_FORGE_DATA_DIR = path.join(sandbox, 'data')

const exec = { agent: { session: { header: { cwd: workspace, id: 'hygiene' } } }, token: {} }
const file = name => path.join(workspace, name)
const pool = new FinderPool()
// 走真实注册路径：参数卫生挂在 defineForgeTool 上，直接调 factory.execute 测不到。
const define = factory => defineForgeTool(factory)
// 真实路径把失败走异常通道，测试统一收敛成 {error} 以沿用既有断言写法。
const run = async (tool, args) => {
  try { return await tool.execute(args, exec) } catch (error) { return { error: String(error?.message ?? error) } }
}
const edit = define(createEditTool(pool))
const files = define(createFileTool())
const symbols = define(createReadTool())
const verify = define(createVerifyTool())
const trace = define(createTraceTool())
const rollback = define(createRollbackTool(pool))

/** 上游 strict 化后，模型对 ff_edit 的实际形状：16 个字段一个不少。 */
const paddedEdit = args => ({
  choice: '', content: '', edit: 'replace', find: '', includeLeadingComment: true,
  path: '', projectId: '', reason: '', replaceWith: '', revertOnSyntaxError: true,
  snapshotId: '', sourceSymbol: '', steps: [], taskId: '', ticket: '', verify: [],
  ...args,
})

/** 同一现象下 ff_file 的实际形状：14 个字段一个不少。 */
const paddedFile = args => ({
  action: 'create', after: 0, afterSymbol: '', before: 0, beforeSymbol: '', content: '',
  destination: '', fromLabel: '', fromLines: '', includeLeadingComment: true, indent: 'auto',
  overwrite: false, path: '', projectId: '', reason: 'test', snapshotId: '', sourceSymbol: '',
  taskId: '', ...args,
})

let passed = 0
const ok = label => console.log(`ok ${++passed} - ${label}`)

async function main() {
  fs.writeFileSync(file('a.txt'), 'one\nfoo\nthree\n')

  // H1：全字段补齐的 ff_edit 应当落盘，而不是死在 choice:'' 上。
  const padded = await run(edit, paddedEdit({ path: 'a.txt', find: 'foo', replaceWith: 'bar', reason: 'rename foo' }), exec)
  assert.ok(padded.batch, `padded ff_edit should commit: ${JSON.stringify(padded).slice(0, 160)}`)
  assert.equal(fs.readFileSync(file('a.txt'), 'utf8'), 'one\nbar\nthree\n')
  ok('ff_edit 接收全字段补齐的形状并落盘（choice/content/steps/verify 空值归一）')

  // H1：空 choice 不再冒充 ticket 回复。
  const choiceEmpty = await run(edit, paddedEdit({ path: 'a.txt', find: 'bar', replaceWith: 'baz', reason: 'rename bar', choice: '' }), exec)
  assert.ok(choiceEmpty.batch, `empty choice should not look like a ticket reply: ${JSON.stringify(choiceEmpty).slice(0, 160)}`)
  ok('ff_edit 的 choice:"" 视为未提供，不报 ticket-only 错误')

  // H1 + H3：steps 有真实内容、find/replaceWith 是空串 → 走 steps，空串不当作 shorthand。
  const stepsOnly = await run(edit, paddedEdit({
    path: 'a.txt', reason: 'insert line', steps: [{ op: 'insert', after: 0, text: 'zero' }],
  }), exec)
  assert.ok(stepsOnly.batch, `steps path should win over empty find: ${JSON.stringify(stepsOnly).slice(0, 160)}`)
  assert.equal(fs.readFileSync(file('a.txt'), 'utf8'), 'zero\none\nbaz\nthree\n')
  ok('ff_edit 的空数组 steps 归一、有内容 steps 保留，find/replaceWith 空串不抢占')

  // H3：replaceWith:'' 仍然是「删除匹配块」，不能被归一掉。
  const deleted = await run(edit, paddedEdit({ path: 'a.txt', find: 'one', replaceWith: '', reason: 'drop one' }), exec)
  assert.ok(deleted.batch, `empty replaceWith must still delete: ${JSON.stringify(deleted).slice(0, 160)}`)
  const afterDelete = fs.readFileSync(file('a.txt'), 'utf8')
  assert.ok(!afterDelete.includes('one'), `deletion should remove the matched block: ${JSON.stringify(afterDelete)}`)
  assert.ok(afterDelete.includes('baz'), 'deletion must not swallow neighbouring lines')
  ok('ff_edit 保留 replaceWith:"" 的删除语义')

  // H2：非空的不适用参数仍是误用。
  const misuse = await run(edit, paddedEdit({ path: 'a.txt', find: 'baz', replaceWith: 'qux', reason: 'misuse', content: 'not a symbol edit' }), exec)
  assert.match(String(misuse.error), /sourceSymbol/, `non-empty content without sourceSymbol must still refuse: ${JSON.stringify(misuse)}`)
  ok('ff_edit 仍拒绝非空 content 配普通 find（真实误用）')

  // H2：非空 choice 没有 ticket 仍拒绝。
  const looseChoice = await run(edit, paddedEdit({ path: 'a.txt', find: 'baz', replaceWith: 'qux', reason: 'loose', choice: '2' }), exec)
  assert.match(String(looseChoice.error), /ticket/, `non-empty choice without ticket must refuse: ${JSON.stringify(looseChoice)}`)
  ok('ff_edit 仍拒绝非空 choice 无 ticket')

  // H5：path 为空仍然报错。
  const noPath = await run(edit, paddedEdit({ find: 'baz', replaceWith: 'qux', reason: 'no path' }), exec)
  assert.match(String(noPath.error), /path is required/i, `missing path must still refuse: ${JSON.stringify(noPath)}`)
  ok('ff_edit 的 path 缺失仍然报错')

  // H1：全字段补齐的 ff_file create 应当创建成功。
  const created = await run(files, paddedFile({ path: 'new.txt', content: 'hello\n' }), exec)
  assert.ok(created.batch, `padded ff_file create should commit: ${JSON.stringify(created).slice(0, 160)}`)
  assert.equal(fs.readFileSync(file('new.txt'), 'utf8'), 'hello\n')
  ok('ff_file 接收全字段补齐的 create 并落盘（destination/anchors/indent 空值归一）')

  // H2：非空 destination 配 create 仍拒绝。
  const wrongDest = await run(files, paddedFile({ path: 'other.txt', content: 'x', destination: 'moved.txt' }), exec)
  assert.match(String(wrongDest.error), /destination/, `non-empty destination with create must refuse: ${JSON.stringify(wrongDest)}`)
  ok('ff_file 仍拒绝 create 携带非空 destination')

  // H1：remove 也吃全字段形状，content:'' 不参与。
  const removed = await run(files, paddedFile({ action: 'remove', path: 'new.txt', content: '', reason: 'cleanup' }), exec)
  assert.ok(removed.batch, `padded ff_file remove should commit: ${JSON.stringify(removed).slice(0, 160)}`)
  assert.equal(fs.existsSync(file('new.txt')), false)
  ok('ff_file 的 remove 忽略空值形态的 create 专属字段')

  // H4：create 携带默认形态 overwrite:false / includeLeadingComment:true 不报错，非默认仍报错。
  fs.writeFileSync(file('keep.txt'), 'kept\n')
  const defaults = await run(files, paddedFile({ path: 'keep.txt', content: 'kept\n', overwrite: false, includeLeadingComment: true, indent: 'auto' }), exec)
  assert.match(String(defaults.error), /overwrite/, `create over an existing file still needs overwrite=true: ${JSON.stringify(defaults)}`)
  ok('ff_file 的默认值形态不改变原有校验结果（覆盖仍需 overwrite=true）')

  // ff_symbols：补全产物里的「另一视图专属字段」在该视图下不携带意图。
  fs.writeFileSync(file('sym.js'), 'export function alpha() {}\nexport function beta() {}\n')
  const paddedOutline = await run(symbols, 
    { view: 'outline', path: 'sym.js', symbol: '', glob: '', limit: 200, kind: '', depth: 2 },
    exec,
  )
  assert.ok(Array.isArray(paddedOutline.items), `outline must ignore definitions-only fields: ${JSON.stringify(paddedOutline).slice(0, 160)}`)
  assert.equal(paddedOutline.page.returned, 2)
  ok('ff_symbols 的 outline 忽略 symbol/glob 补全并接受共享 limit')

  const paddedDefinitions = await run(symbols, 
    { view: 'definitions', symbol: 'alpha', path: 'sym.js', glob: '', limit: 200, kind: '', depth: 2 },
    exec,
  )
  assert.ok(Array.isArray(paddedDefinitions.items), `definitions must ignore depth: ${JSON.stringify(paddedDefinitions).slice(0, 160)}`)
  ok('ff_symbols 的 definitions 忽略 depth 补全')

  // 仍未校验的拼写错误仍要报出来，不因为归一把 argumentProblem 掏空。
  const misspelled = await run(symbols, { view: 'outline', path: 'sym.js', symbl: 'alpha' }, exec)
  assert.match(String(misspelled.error), /not used by view=outline/, `unknown key must still refuse: ${JSON.stringify(misspelled)}`)
  ok('ff_symbols 仍拒绝视图里不存在的参数名')

  // ff_verify：batch 补成 0、checks 补成 []，只给了 path → 必须按 path 走。
  const verified = await run(verify, { batch: 0, path: 'sym.js', checks: [] }, exec)
  assert.ok(!verified.error, `path-only verify must not trip the exclusive check: ${JSON.stringify(verified).slice(0, 160)}`)
  ok('ff_verify 的 batch:0 / checks:[] 视为未提供，path 单独成立')

  // ff_trace：空串的 path 类字段与可分页字段要被归一；枚举字段的空串止步于
  // SDK 的参数校验（defineTool 先校验后调 execute），forge 不会把它吞掉。
  const traced = await run(trace, {
    target: 'file:sym.js', edgeMode: 'all', format: 'auto', limit: 200, cursor: '',
    capture: false, declarations: '', compileCommands: '',
  }, exec)
  assert.ok(!traced.error, `file: trace must ignore empty path fields: ${JSON.stringify(traced).slice(0, 160)}`)
  ok('ff_trace 忽略空串的 cursor/declarations/compileCommands')

  const enumPadded = await run(trace, { target: 'file:sym.js', edgeMode: '', format: '' }, exec)
  assert.match(String(enumPadded.error), /must be one of/, `enum padding must surface as an explicit schema error: ${JSON.stringify(enumPadded)}`)
  ok('ff_trace 的枚举空串报出明确的取值错误，而不是被静默删除')

  // ff_rollback：batch 有值、throughBatch 补成 0 → 只能是 batch 选择，不能被判成三选一冲突。
  const rolled = await run(rollback, {
    batch: 1, latest: false, throughBatch: 0, path: '', node: '', version: '', dryRun: false, reason: 'check',
  }, exec)
  assert.ok(!String(rolled.error || '').includes('exactly one'),
    `a padded selector must not collapse into a conflict: ${JSON.stringify(rolled).slice(0, 160)}`)
  ok('ff_rollback 的 throughBatch:0 / 空 path 不与被选中的 batch 冲突')

  pool.disposeAll()
  fs.rmSync(sandbox, { recursive: true, force: true })
  console.log(`\n${passed} groups passed`)
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
