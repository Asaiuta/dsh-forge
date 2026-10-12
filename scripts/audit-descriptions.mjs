/** Audit the model-facing tool surface offline. */
import { promptSurface } from './prompt-surface.mjs'

const bytes = value => Buffer.byteLength(String(value ?? ''), 'utf8')
const tok = value => Math.ceil(bytes(value) / 4)
const options = new Set(process.argv.slice(2))
const surface = await promptSurface()

function walk(node, path = '', out = []) {
  if (!node || typeof node !== 'object') return out
  if (node.type === 'object' && node.properties) {
    for (const [name, child] of Object.entries(node.properties)) {
      const field = path ? `${path}.${name}` : name
      if (!String(child.description ?? '').trim()) out.push(field)
      walk(child, field, out)
    }
  }
  if (node.type === 'array' && node.items) walk(node.items, `${path}[]`, out)
  for (const [index, branch] of (node.oneOf ?? []).entries()) walk(branch, `${path}.oneOf[${index}]`, out)
  return out
}

let empty = 0
const rows = surface.schemas.map(schema => {
  const nested = walk(schema.parameters)
  empty += nested.length
  return { name: schema.name, description: tok(schema.description), parameters: tok(JSON.stringify(schema.parameters)), empty: nested }
})
if (options.has('--json')) console.log(JSON.stringify({ rows, empty, metrics: surface.metrics, commands: surface.commands }, null, 2))
else {
  console.log('=== description audit (compiled native schemas; desc/schema are bytes/4 estimates) ===')
  console.log('tool'.padEnd(20) + 'desc'.padStart(7) + 'schema'.padStart(9) + 'empty'.padStart(7))
  for (const row of rows) console.log(`${row.name.padEnd(20)}${String(row.description).padStart(7)}${String(row.parameters).padStart(9)}${String(row.empty.length).padStart(7)}`)
  console.log(`\nblank parameter descriptions: ${empty}`)
  for (const row of rows) for (const path of row.empty) console.log(`  - ${row.name}.${path}`)
  console.log('\nplugin contribution (bytes; tokenizer counts are comparative):')
  for (const [name, metric] of Object.entries(surface.metrics)) console.log(`  ${name}: ${metric.bytes} bytes, ~${metric.estTokens} bytes/4${metric.cl100k_base === undefined ? '' : `, cl100k=${metric.cl100k_base}, o200k=${metric.o200k_base}`}`)
}
