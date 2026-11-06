/** Offline equal-work comparison: all arguments and complete receipts, no model calls. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { getEncoding } from 'js-tiktoken'
import { createEditTool } from '../lib/tools-edit.js'
import { FinderPool } from '../lib/core.js'
const destination = process.argv[2]
if (!destination) throw new Error('usage: node scripts/measure-edit-batching.mjs <output.json>')
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-batch-cost-'))
const previous = process.env.DSH_FORGE_DATA_DIR
const encodings = Object.fromEntries(['o200k_base', 'cl100k_base'].map(n => [n, getEncoding(n)]))
const results = []
try {
  for (const count of [3, 10]) for (const receipt of ['summary', 'diff']) {
    const source = Array.from({ length: count }, (_, i) => `const value${i} = ${1000 + i};`).join('\n') + '\n'
    const steps = Array.from({ length: count }, (_, i) => ({ find: `value${i} = ${1000 + i}`, replaceWith: `value${i} = ${2000 + i}` }))
    const expected = Array.from({ length: count }, (_, i) => `const value${i} = ${2000 + i};`).join('\n') + '\n'
    for (const mode of ['single', 'batch']) {
      const workspace = path.join(base, `${count}-${receipt}-${mode}`)
      fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, 'fixture.js'), source)
      process.env.DSH_FORGE_DATA_DIR = path.join(workspace, 'data')
      const pool = new FinderPool(), tool = createEditTool(pool)
      const exec = { agent: { session: { header: { cwd: workspace, id: 'measurement' } } } }
      const raw = [], totals = Object.fromEntries(Object.keys(encodings).map(n => [n, { arguments: 0, nativeText: 0, ptcValue: 0 }]))
      try {
        const common = { path: 'fixture.js', match: 'literal', reason: 'update independent values', receipt }
        for (const args of mode === 'batch' ? [{ ...common, steps }] : steps.map(step => ({ ...common, ...step }))) {
          const value = await tool.execute(args, exec)
          assert.equal(value.status, 'applied', JSON.stringify(value)); assert.notEqual(value.receiptComplete, false)
          if (receipt === 'diff') assert.equal(value.diff.complete, true, 'must include continuation cost if fixture grows')
          const text = tool.output.render(args, value).map(c => c.text).join('\n')
          for (const [n, encoding] of Object.entries(encodings)) {
            totals[n].arguments += encoding.encode(JSON.stringify(args)).length
            totals[n].nativeText += encoding.encode(text).length
            totals[n].ptcValue += encoding.encode(JSON.stringify(value)).length
          }
          raw.push({ args, value, text })
        }
        assert.equal(fs.readFileSync(path.join(workspace, 'fixture.js'), 'utf8'), expected)
        for (const t of Object.values(totals)) { t.nativeTotal = t.arguments + t.nativeText; t.ptcTotal = t.arguments + t.ptcValue }
        results.push({ count, receipt, mode, calls: raw.length, continuationCalls: 0, complete: true,
          resultSha256: createHash('sha256').update(expected).digest('hex'), totals, raw })
      } finally { pool.disposeAll(); tool.dispose() }
    }
  }
  for (let i = 0; i < results.length; i += 2) {
    const [single, batch] = results.slice(i, i + 2)
    assert.equal(single.resultSha256, batch.resultSha256)
    for (const name of Object.keys(encodings)) for (const mode of ['nativeTotal', 'ptcTotal']) assert.ok(batch.totals[name][mode] < single.totals[name][mode])
  }
  fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true })
  fs.writeFileSync(destination, JSON.stringify({ modelCalls: 0, scope: 'Tool arguments + full text or structured receipt; excludes model reasoning, request history, caching and provider billing.', results }, null, 2))
  console.log(JSON.stringify(results.map(({ raw, ...row }) => row), null, 2))
} finally {
  if (previous === undefined) delete process.env.DSH_FORGE_DATA_DIR; else process.env.DSH_FORGE_DATA_DIR = previous
  fs.rmSync(base, { recursive: true, force: true })
}
