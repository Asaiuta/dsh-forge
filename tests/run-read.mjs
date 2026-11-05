import assert from 'node:assert/strict'
import { createReadTool } from '../lib/tools-read.js'

const tool = createReadTool()
assert.deepEqual(Object.keys(tool.parameters), ['view', 'path', 'symbol', 'glob', 'depth', 'kind', 'scope', 'limit', 'cursor'])
assert.deepEqual(tool.parameters.view.enum, ['outline', 'definitions'])
assert.equal(tool.parameters.view.required, true)
const exec = { agent: { session: { header: { cwd: process.cwd() } } }, token: {} }
const outline = await tool.execute({ view: 'outline', path: 'src/tools.ts', depth: 1 }, exec)
assert.ok(outline.items.length > 0)
assert.equal(outline.page.filters.scope, 'declarations')
const definitions = await tool.execute({ view: 'definitions', path: 'src', symbol: 'createGrepTool' }, exec)
assert.ok(definitions.items.some((item) => item.qualifiedName === 'createGrepTool'))
assert.match((await tool.execute({ path: 'src/tools.ts' }, exec)).error, /view must be/)
console.log('ok - ff_symbols exposes only outline and definitions')
