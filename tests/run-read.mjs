// ff_read — unified addressing contract: path[#Symbol], lines=L10-20, paths,
// glob, per-file caps, total budget, binary refusal, truncation reporting.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createReadTool } from '../lib/tools-read.js'

const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'forge-read-'))
const work = path.join(sandbox, 'work')
fs.mkdirSync(path.join(work, 'src'), { recursive: true })
fs.mkdirSync(path.join(work, 'test'), { recursive: true })
process.env.DSH_FORGE_DATA_DIR = path.join(sandbox, '.dsh', 'forge')
const exec = { agent: { session: { header: { cwd: work, id: 'read-test' } } }, token: {} }

const put = (name, content) => {
  fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true })
  fs.writeFileSync(path.join(work, name), content)
}
const read = (name) => fs.readFileSync(path.join(work, name), 'utf8')

put('src/alpha.ts', 'export const alpha = 1;\nexport const beta = 2;\nexport const gamma = 3;\n')
put('src/alpha.test.ts', 'import { alpha } from "./alpha.js";\n')
put('src/notes.md', '# notes\nbody\n')
put('test/x.test.ts', 'test only\n')
fs.writeFileSync(path.join(work, 'bin.dat'), Buffer.from([1, 0, 2, 0, 3]))
fs.writeFileSync(path.join(work, '.gitignore'), 'ignored.txt\n')
put('ignored.txt', 'secret\n')
put('src/big.ts', Array.from({ length: 50 }, (_, i) => `line ${i + 1}\n`).join(''))

const tool = createReadTool()
let passed = 0
const ok = (name) => console.log(`ok ${++passed} - ${name}`)
const run = async (args) => await tool.execute(args, exec)

{
  const out = await run({ path: 'src/alpha.ts', lines: 'L2-3' })
  assert.equal(out.blocks.length, 1)
  assert.equal(out.blocks[0].lines, 'L2-3')
  assert.ok(out.blocks[0].text.includes('beta = 2') && !out.blocks[0].text.includes('alpha = 1'))
  ok('lines=L10-20 range read')
}
// A real session sent "L180-L420" (an "L" on BOTH bounds) and was refused; the
// prefix is noise, so both spellings must land on the same slice.
{
  const a = await run({ path: 'src/alpha.ts', lines: 'L2-3' })
  const b = await run({ path: 'src/alpha.ts', lines: 'L2-L3' })
  const c = await run({ path: 'src/alpha.ts', lines: 'L2 - L3' })
  assert.equal(b.blocks.length, 1, 'L2-L3 (repeated prefix) must be accepted')
  assert.equal(c.blocks.length, 1, 'L2 - L3 (spaced, repeated prefix) must be accepted')
  assert.deepEqual(b.blocks[0], a.blocks[0])
  assert.deepEqual(c.blocks[0], a.blocks[0])
  ok('lines accepts a repeated L prefix on the second bound (L2-L3)')
}
{
  const out = await run({ path: 'src/alpha.ts#gamma' })
  assert.equal(out.blocks[0].file, 'src/alpha.ts#gamma')
  assert.equal(out.blocks[0].lines, 'L3-3')
  assert.ok(out.blocks[0].text.includes('gamma = 3'))
  ok('path#Symbol AST addressing')
}
{
  const out = await run({ path: 'src/alpha.ts#nosuch' })
  assert.equal(out.blocks.length, 0)
  assert.ok(out.skipped[0].reason.includes('not found'))
  ok('missing symbol lands in skipped with reason')
}
{
  const out = await run({ paths: ['src/alpha.ts', 'src/notes.md', 'missing.txt'], lines: 'L1' })
  assert.equal(out.blocks.length, 2)
  assert.deepEqual(out.skipped, [{ file: 'missing.txt', reason: 'file not found' }])
  ok('multi-path read with missing reported')
}
{
  const out = await run({ glob: 'src/*.test.ts' })
  assert.equal(out.blocks.length, 1)
  assert.equal(out.blocks[0].file, 'src/alpha.test.ts')
  ok('glob addressing')
}
{
  put('visible.txt', 'fine\n')
  const out = await run({ glob: '*.txt' })
  assert.equal(out.blocks.length, 1)
  assert.equal(out.blocks[0].file, 'visible.txt')
  assert.deepEqual(out.skipped.filter(s => s.file === 'ignored.txt'), [])
  ok('glob respects root .gitignore')
}
{
  const out = await run({ path: 'bin.dat' })
  assert.ok(out.skipped[0].reason.includes('binary'))
  ok('binary refused with explicit reason')
}
{
  const out = await run({ glob: 'src/big.ts', lines: 'L45-60' })
  assert.equal(out.blocks[0].lines, 'L45-50')
  assert.equal(out.blocks[0].truncated, undefined)
  assert.ok(out.blocks[0].text.startsWith('line 45'))
  ok('range clamped to EOF without truncation flag')
}
{
  const out = await run({ paths: Array.from({ length: 30 }, () => 'src/alpha.ts') })
  assert.equal(out.blocks.length, 20)
  assert.ok(out.note.includes('10 target(s) beyond the 20-file cap'))
  ok('default file cap with overflow note')
}
{
  const out = await run({ paths: Array.from({ length: 30 }, () => 'src/alpha.ts'), limit: 100 })
  assert.equal(out.blocks.length, 30)
  ok('limit raises the cap')
}
// The inline budget is sized against the host's spill policy, not the context
// window: `@deepseek-ai/dsh-spill-policy` prices a text block at
// `ceil(chars / 4) + 4`, so any tool result over ~49,984 characters is rewritten
// into head + tail halves plus a spill pointer — and unlike the built-in `read`
// tool, ff_read is not exempt. Everything below keeps forge's own, actionable
// truncation in front of that rewrite.
const HOST_INLINE_LIMIT = 49_984
{
  put('src/huge.ts', Array.from({ length: 9000 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n')
  const out = await run({ path: 'src/huge.ts' })
  assert.equal(out.blocks.length, 1, 'an oversized single target must still return a block')
  assert.equal(out.blocks[0].truncated, true)
  assert.ok(out.blocks[0].text.startsWith('export const v0 = 0;'), 'the prefix is kept')
  assert.ok(out.blocks[0].text.length <= 40 * 1024, `trimmed to the budget, got ${out.blocks[0].text.length}`)
  assert.equal(out.blocks[0].lines, `L1-${out.blocks[0].text.split('\n').length}`, 'the line label follows the trim')
  assert.match(out.note ?? '', /trimmed to the 40KB inline budget/)
  ok('oversized target is trimmed to the inline budget, not dropped')
}
{
  const out = await run({ paths: ['src/huge.ts', 'src/alpha.ts'] })
  assert.equal(out.blocks.length, 1)
  const starved = out.skipped.find((s) => s.file === 'src/alpha.ts')
  assert.ok(starved, 'the starved target must be reported, not silently dropped')
  assert.match(starved.reason, /40KB inline budget/, 'the reason must name the budget, not the file cap')
  assert.ok(!/file cap/.test(out.note ?? ''), 'a budget shortfall is not a file-cap overflow')
  ok('a target past the inline budget is skipped with the budget reason')
}
{
  const bulk = Array.from({ length: 8 }, (_, i) => `src/bulk${i}.ts`)
  for (const file of bulk) put(file, Array.from({ length: 400 }, (_, i) => `export const f${i} = ${i};`).join('\n') + '\n')
  const value = await run({ paths: bulk })
  const rendered = tool.output.render({}, value).map((block) => block.text).join('')
  assert.ok(value.blocks.length >= 1 && value.blocks.length < bulk.length,
    `a batch larger than the budget is cut short, got ${value.blocks.length} block(s)`)
  assert.equal(value.blocks.at(-1).truncated, true, 'the block that crosses the budget is trimmed, not dropped')
  for (const file of bulk.slice(value.blocks.length)) {
    const reason = value.skipped.find((skip) => skip.file === file)?.reason ?? ''
    assert.match(reason, /inline budget/, `${file} must be reported as budget-starved, got: ${reason}`)
  }
  assert.ok(rendered.length < HOST_INLINE_LIMIT,
    `rendered ${rendered.length} chars must stay inside the host's ${HOST_INLINE_LIMIT}-char inline limit`)
  ok('a batch over the inline budget is cut coherently and renders under the host spill threshold')
}
{
  const out = await run({})
  assert.ok(out.error.includes('nothing to read'))
  ok('empty call fails with guidance')
}

// --- built-in `read` contract (takeover) ----------------------------------
// When forge serves the native name, the built-in prompt section keeps telling
// the model to use `offset` and `limit`, so the tool has to answer to them.
{
  const nativeTool = createReadTool(undefined, 'read')
  const nativeRun = async (args) => await nativeTool.execute(args, exec)

  assert.ok('file_path' in nativeTool.parameters && 'offset' in nativeTool.parameters,
    'the native-shaped definition must advertise the built-in arguments')
  assert.ok(!('file_path' in tool.parameters),
    'the additive definition must not grow the built-in arguments')
  ok('only the native-shaped definition advertises file_path/offset')

  {
    const out = await nativeRun({ file_path: 'src/big.ts', offset: 10, limit: 5 })
    assert.equal(out.blocks.length, 1)
    assert.equal(out.blocks[0].lines, 'L10-14', `expected L10-14, got ${out.blocks[0].lines}`)
    assert.ok(out.blocks[0].text.startsWith('line 10') && out.blocks[0].text.endsWith('line 14'),
      `window must start at offset 10, got: ${JSON.stringify(out.blocks[0].text.slice(0, 20))}`)
    assert.equal(out.blocks[0].totalLines, 50, 'the block must report the file length')
    assert.match(out.note ?? '', /showing L10-14 of 50 — continue with offset=15/,
      `a windowed read must say where to continue, got: ${out.note}`)
    ok('file_path + offset + limit reads the built-in window and says how to continue')
  }
  {
    const out = await nativeRun({ file_path: 'src/alpha.ts' })
    assert.equal(out.blocks[0].lines, 'L1-3')
    assert.equal(out.note, undefined, 'a whole-file read has nowhere to continue')
    ok('file_path alone reads the whole file')
  }
  {
    // `offset` with no `limit` means "to end of file" in the built-in contract.
    const out = await nativeRun({ file_path: 'src/big.ts', offset: 48 })
    assert.equal(out.blocks[0].lines, 'L48-50', `open-ended offset must run to EOF, got ${out.blocks[0].lines}`)
    assert.equal(out.note, undefined)
    ok('offset without limit runs to end of file')
  }
  {
    // `limit` is a line count only when a file_path addressed one file; a
    // forge-shaped multi-file call must still read it as a file cap.
    const out = await run({ paths: ['src/alpha.ts', 'src/notes.md'], limit: 1 })
    assert.equal(out.blocks.length, 1, 'limit must still cap files on a forge-shaped call')
    ok('limit keeps its file-cap meaning when the call is forge-shaped')
  }
}

{
  // A view used to drop the arguments it did not honour. A caller cannot tell a
  // dropped `lines` from an honoured one, so each mismatch must be a hard error
  // naming the parameter and the view that does read it.
  const lines = await run({ view: 'outline', path: 'src/alpha.ts', lines: 'L1-2' })
  assert.match(lines.error, /"lines" does not apply to view=outline/)
  assert.match(lines.error, /view=body/, 'the message must name the view that reads it')
  const depth = await run({ view: 'definitions', symbol: 'alpha', depth: 1 })
  assert.match(depth.error, /"depth" does not apply to view=definitions/)
  const typo = await run({ path: 'src/alpha.ts', fileline: 3 })
  assert.match(typo.error, /unknown parameter "fileline"/)
  // A built-in-shaped window is translated to `lines`, which an outline cannot honour.
  const native = await run({ file_path: 'src/alpha.ts', offset: 2, limit: 3, view: 'outline' })
  assert.match(native.error, /"lines" does not apply to view=outline/)
  ok('an argument another view owns is refused by name instead of silently ignored')
}
{
  const outline = await run({ view: 'outline', path: 'src/alpha.ts', depth: 1 })
  assert.equal(outline.error, undefined, `outline with its own arguments must run, got ${outline.error}`)
  ok('outline honours depth so the strict gate does not fire on a legal call')
}

console.log(`\n${passed} read groups passed`)
