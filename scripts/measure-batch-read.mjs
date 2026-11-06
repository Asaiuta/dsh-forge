/** Replay the frozen three-symbol corpus; include every page and continuation request. */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { getEncoding } from 'js-tiktoken'
import { createFileTool } from '../lib/tools-files.js'
import { promptSurface } from './prompt-surface.mjs'
const [baselineFile, outputFile, sourceRoot] = process.argv.slice(2)
if (!baselineFile || !outputFile) throw new Error('usage: node scripts/measure-batch-read.mjs <dsh-baseline-raw.json> <output.json>')
const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')), tool = createFileTool()
const selected = baseline.records.filter(r => ['ProjectForgeService.js.symbol', 'engine.js.symbol', 'store.js.symbol'].includes(r.label))
assert.equal(selected.length, 3)
const files = selected.map(r => { const i = r.args.file_path.lastIndexOf('#'); return { path: r.args.file_path.slice(0, i), symbol: r.args.file_path.slice(i + 1) } })
const exec = { agent: { session: { header: { cwd: sourceRoot ?? baseline.scratch, id: 'batch-measure' } } } }
const raw = [], reconstructed = ['', '', '']
let args = { action: 'read', files }
while (true) {
  const value = await tool.execute(args, exec); assert.ok(value.read, JSON.stringify(value))
  const text = tool.output.render(args, value).map(c => c.text).join('\n')
  raw.push({ args, value, text })
  for (const item of value.read.items) { assert.equal(reconstructed[item.index].length, item.offset); reconstructed[item.index] += item.text }
  if (value.read.complete) break
  args = { action: 'read', cursor: value.read.nextCursor }
}
for (let i = 0; i < 3; i++) assert.equal(reconstructed[i], selected[i].value.lines.map(l => l.text).join('\n'))
const tokenizers = Object.fromEntries(['o200k_base', 'cl100k_base'].map(n => [n, getEncoding(n)]))
const totals = Object.fromEntries(Object.keys(tokenizers).map(name => [name, { requests: 0, text: 0, value: 0 }]))
for (const page of raw) for (const [name, encoding] of Object.entries(tokenizers)) {
  totals[name].requests += encoding.encode(JSON.stringify(page.args)).length
  totals[name].text += encoding.encode(page.text).length
  totals[name].value += encoding.encode(JSON.stringify(page.value)).length
}
const prompt = await promptSurface({ config: { surface: 'full' } })
const result = { generatedAt: new Date().toISOString(), baseline: path.resolve(baselineFile), sourceRoot: exec.agent.session.header.cwd, sourceEquality: true, pages: raw.length, totals, prompt, raw }
fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true }); fs.writeFileSync(outputFile, JSON.stringify(result, null, 2))
console.log(JSON.stringify({ pages: raw.length, totals, prompt: prompt.metrics }, null, 2))
