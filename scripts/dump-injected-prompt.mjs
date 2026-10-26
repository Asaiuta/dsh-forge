/** Dump compiled native schemas and PTC declarations, offline. */
import fs from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { promptSurface } from './prompt-surface.mjs'

// Preserve property names: a schema may legitimately have a field called description.
function contract(schema) {
  const { description, ...rest } = schema
  if (rest.parameters) rest.parameters = contract(rest.parameters)
  if (rest.properties) rest.properties = Object.fromEntries(Object.entries(rest.properties).map(([name, field]) => [name, contract(field)]))
  if (rest.items) rest.items = contract(rest.items)
  if (rest.oneOf) rest.oneOf = rest.oneOf.map(contract)
  return rest
}

const pluginAt = process.argv.indexOf('--plugin')
if (pluginAt >= 0 && !process.argv[pluginAt + 1]) throw new Error('--plugin requires a compiled index.js path')
const surface = await promptSurface({
  ...(process.argv.includes('--takeover') ? { config: { registration: 'takeover' } } : {}),
  ...(pluginAt >= 0 ? { plugin: process.argv[pluginAt + 1] } : {}),
})
const out = {
  generatedAt: new Date().toISOString(),
  note: 'Offline plugin contribution: compiled native schemas, SDK-generated PTC declarations, and the registered guidance rendered in a simulated agent scope. This is not the full production request. PTC metrics subtract the empty SDK preamble. Tokenizers compare changes, not actual DeepSeek usage. Commands are separate. No model request is made.',
  ...surface,
}
const compareAt = process.argv.indexOf('--compare')
if (compareAt >= 0) {
  if (!process.argv[compareAt + 1]) throw new Error('--compare requires a baseline JSON path')
  const baseline = JSON.parse(fs.readFileSync(process.argv[compareAt + 1], 'utf8'))
  out.inputContractsUnchanged = isDeepStrictEqual(surface.schemas.map(contract), baseline.schemas.map(contract))
  out.compare = Object.fromEntries(Object.entries(surface.metrics).map(([name, now]) => {
    const old = baseline.metrics?.[name] ?? {}
    return [name, Object.fromEntries(['bytes', 'estTokens', 'cl100k_base', 'o200k_base'].map(key => [key, {
      before: old[key] ?? null, after: now[key] ?? null,
      delta: old[key] === undefined || now[key] === undefined ? null : now[key] - old[key],
      percent: old[key] && now[key] !== undefined ? (now[key] - old[key]) / old[key] * 100 : null,
    }]))]
  }))
}
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(out, null, 2) + '\n')
else {
  console.log('=== dsh-forge prompt surface ===')
  console.log(out.note)
  console.log(JSON.stringify({ metrics: out.metrics, compare: out.compare, inputContractsUnchanged: out.inputContractsUnchanged, commands: out.commands }, null, 2))
  console.log('\n=== native schemas ===\n' + JSON.stringify(out.schemas, null, 2))
  console.log('\n=== PTC TypeScript ===\n' + out.texts.ptcTypescript)
  console.log('\n=== PTC Python ===\n' + out.texts.ptcPython)
  console.log('\n=== scoped plugin guidance ===\n' + out.texts.guidance)
}
