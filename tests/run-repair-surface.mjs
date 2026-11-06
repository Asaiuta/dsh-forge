import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFindTool, createGrepTool } from '../src/tools.ts'
import { createReadTool } from '../src/tools-read.ts'
import { createTraceTool } from '../src/tools-trace.ts'
import { FORGE_TOOLS, forgeGuidance } from '../src/guidance.ts'

const pool = {}
test('retrieval and trace factories expose canonical names only', () => {
  assert.equal(createFindTool(pool).name, 'ff_find')
  assert.equal(createGrepTool(pool).name, 'ff_grep')
  assert.equal(createReadTool().name, 'ff_symbols')
  assert.equal(createTraceTool().name, 'ff_trace')
})
test('guidance covers independent verification and project governance', () => {
  assert.ok(!('verify' in FORGE_TOOLS))
  assert.equal(FORGE_TOOLS.project, 'ff_project')
  const text = forgeGuidance(Object.keys(FORGE_TOOLS))
  for (const name of Object.values(FORGE_TOOLS)) assert.ok(text.includes(name), name)
  assert.ok(!/\b(?:fffind|ffgrep|ff_read|fftrace|ffedit|ffhistory|ffrollback)\b/.test(text))
})
test('removed duplicate symbol trace rejects before scanning', async () => {
  const out = await createTraceTool().execute({ target: 'symbol:Foo', capture: true })
  assert.match(out.error ?? '', /ff_symbols/)
})
test('irrelevant trace parameters fail before scanning', async () => {
  const trace = createTraceTool()
  for (const args of [
    { target: 'ipc:channel', limit: 5 },
    { target: 'ipc:channel', format: 'auto' },
    { target: 'exposes:', edgeMode: 'all' },
    { target: 'file:a.ts', unexpected: true },
  ]) assert.ok((await trace.execute(args)).error, JSON.stringify(args))
})
test('grep describes positive context and non-ASCII literal matching explicitly', () => {
  const tool = createGrepTool(pool)
  assert.match(tool.parameters.context.description, /positive/)
  assert.match(tool.description, /non-ASCII/)
})
