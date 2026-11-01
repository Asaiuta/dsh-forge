/**
 * Three-way prompt-surface comparison: no plugin / additive / takeover.
 *
 * "No plugin" is the baseline: forge contributes nothing, so its delta is zero
 * by construction. What the numbers answer is how much the plugin adds to every
 * single request, and how much of that takeover gives back by narrowing the
 * search schemas it keeps.
 *
 * Measure: native JSON projection (what the host sends), the two PTC source
 * projections, guidance text, and the command list.
 *
 * Run from the repository root so `@deepseek-ai/dsh-tools` and `js-tiktoken` resolve.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { getEncoding } = require('js-tiktoken')

const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)
const sdk = await import('@deepseek-ai/dsh-tools')

const enc = getEncoding('cl100k_base')
const tok = (text) => enc.encode(text).length

/** Collect one registration pass: tool definitions, guidance sections, commands. */
function collect(config) {
  const definitions = []
  const commands = []
  const sections = []
  const disposers = []
  // The takeover path needs a dispatch seam (`on`) and the built-in rows the
  // augmented calls are keyed against; without them `installAugmentation`
  // returns undefined and the config silently falls back to additive.
  const builtins = ['read', 'grep', 'glob', 'edit'].map((name) => ({ name }))
  const host = {
    tools: {
      register: (definition) => { definitions.push(definition) },
      get: (name) => definitions.find((definition) => definition.name === name) ?? builtins.find((row) => row.name === name),
    },
    commands: { register: (command) => { commands.push(command) } },
    systemPrompt: { section: (section) => { sections.push(section) } },
    on: () => () => {},
  }
  try {
    for (const dispose of apply(host, config)) if (typeof dispose === 'function') disposers.push(dispose)
    const schemas = definitions.map((definition) => sdk.ToolRuntime.prototype.schemaOf.call({}, definition, true))
    const outputs = schemas.map((schema, index) => ({ ...schema, output: definitions[index].output.schema }))
    const native = JSON.stringify(schemas)
    const guidance = sections
      .map((section) => (typeof section.text === 'function' ? section.text({}) : section.text))
      .filter(Boolean)
      .join('\n\n')
    const commandNames = commands.map((command) => `${command.name} ${command.description ?? ''}`).join('\n')
    return {
      toolCount: definitions.length,
      names: schemas.map((schema) => schema.name),
      native,
      nativeTok: tok(native),
      ptcTsTok: tok(sdk.renderToolsSdk(outputs)) - tok(sdk.renderToolsSdk([])),
      ptcPyTok: tok(sdk.renderToolsSdkPy(outputs)) - tok(sdk.renderToolsSdkPy([])),
      guidance,
      guidanceTok: tok(guidance),
      commandNames,
      commandTok: tok(commandNames),
    }
  } finally {
    for (const dispose of disposers.reverse()) dispose()
  }
}

const additive = collect(undefined)
const takeover = collect({ registration: 'takeover', takeover: ['read', 'glob', 'grep'] })

const sum = (row) => row.nativeTok + row.guidanceTok + row.commandTok

const cases = [
  { label: '无插件 (baseline)', toolCount: 0, nativeTok: 0, ptcTsTok: 0, ptcPyTok: 0, guidanceTok: 0, commandTok: 0 },
  { label: 'additive', ...additive },
  { label: 'takeover', ...takeover },
]

const pad = (text, width) => String(text).padEnd(width)
const num = (value) => String(value).padStart(7)

console.log('=== 每请求固定开销（cl100k，只算 forge 的贡献）===')
console.log(pad('模式', 20) + pad('工具', 6) + num('native') + num('ptcTS') + num('ptcPy') + num('guid') + num('cmd') + num('合计'))
for (const row of cases) {
  const total = row.nativeTok + row.guidanceTok + row.commandTok
  console.log(
    pad(row.label, 20) + pad(row.toolCount, 6) + num(row.nativeTok) + num(row.ptcTsTok) + num(row.ptcPyTok) +
    num(row.guidanceTok) + num(row.commandTok) + num(total)
  )
}

console.log()
console.log('=== takeover 相对 additive 的变化 ===')
const drop = (key) => `${pad(key, 14)} ${String(additive[key] - takeover[key]).padStart(6)}  (${additive[key]} → ${takeover[key]})`
console.log(drop('nativeTok'))
console.log(drop('ptcTsTok'))
console.log(drop('ptcPyTok'))
console.log(drop('guidanceTok'))
console.log(drop('commandTok'))
console.log(`合计            ${String(sum(additive) - sum(takeover)).padStart(6)}  (${sum(additive)} → ${sum(takeover)})`)

console.log()
console.log('=== 工具面差异（additive 里有、takeover 里没有的名字）===')
const onlyAdditive = additive.names.filter((name) => !takeover.names.includes(name))
const onlyTakeover = takeover.names.filter((name) => !additive.names.includes(name))
console.log('仅 additive:', onlyAdditive.length ? onlyAdditive.join(', ') : '无')
console.log('仅 takeover:', onlyTakeover.length ? onlyTakeover.join(', ') : '无')

console.log()
console.log('=== 每个工具在两模式下的 native token（找 schema 收窄）===')
const perTool = (row) => {
  const map = new Map()
  const schemas = JSON.parse(row.native)
  for (const schema of schemas) map.set(schema.name, tok(JSON.stringify(schema)))
  return map
}
const a = perTool(additive)
const t = perTool(takeover)
for (const name of additive.names) {
  const before = a.get(name) ?? 0
  const after = t.get(name) ?? 0
  const delta = after - before
  console.log(`  ${pad(name, 12)} ${pad(before, 6)} → ${pad(after, 6)} ${delta === 0 ? '' : delta < 0 ? `(${delta})` : `(+${delta})`}`)
}
