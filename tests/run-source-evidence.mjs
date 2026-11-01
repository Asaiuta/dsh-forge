import assert from 'node:assert/strict'
import { createReadTool } from '../lib/tools-read.js'
const tool = createReadTool()
const result = await tool.execute({ path: 'README.md' }, { agent: { session: { header: { cwd: process.cwd() } } } })
assert.match(result.error, /view must be/)
console.log('ok - source text stays with the built-in read')
