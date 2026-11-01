import assert from 'node:assert/strict'
import { createReadTool } from '../lib/tools-read.js'
const tool = createReadTool()
assert.equal('body' in tool.parameters, false)
assert.equal('paths' in tool.parameters, false)
assert.equal('glob' in tool.parameters, true)
console.log('ok - ff_symbols has no body streaming surface')
