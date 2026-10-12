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
{
  const out = await run({})
  assert.ok(out.error.includes('nothing to read'))
  ok('empty call fails with guidance')
}

console.log(`\n${passed} read groups passed`)
