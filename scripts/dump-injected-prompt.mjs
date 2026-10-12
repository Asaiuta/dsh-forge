/** Dump compiled native schemas and PTC declarations, offline. */
import fs from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { promptSurface } from './prompt-surface.mjs'

// Preserve property names (including the ff_project parameter named description).
function contract(schema) {
  const { description, ...rest } = schema
  if (rest.parameters) rest.parameters = contract(rest.parameters)
  if (rest.properties) rest.properties = Object.fromEntries(Object.entries(rest.properties).map(([name, field]) => [name, contract(field)]))
  if (rest.items) rest.items = contract(rest.items)
  if (rest.oneOf) rest.oneOf = rest.oneOf.map(contract)
  return rest
}

const surface = await promptSurface()
const out = {
  generatedAt: new Date().toISOString(),
  note: 'Native is JSON of compiled tool schemas. PTC texts include output schemas; metrics subtract the empty SDK preamble. Tokenizers compare changes, not actual DeepSeek usage. Commands are listed separately. No model request is made.',
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
}
