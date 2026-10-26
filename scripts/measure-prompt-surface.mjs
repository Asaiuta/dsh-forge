/**
 * Full prompt-surface measurement for dsh-forge, using the project's OWN
 * prompt-surface.mjs (which captures DSH's real native + PTC projections).
 *
 * Scope covered (superset of the earlier ad-hoc script):
 *   1. native       — JSON.stringify(schemaOf(...)) for all registered tools
 *   2. ptcTypescript— renderToolsSdk(outputs)  minus empty-preamble
 *   3. ptcPython    — renderToolsSdkPy(outputs) minus empty-preamble
 *   + per-tool marginal cost in each projection
 *   + description prose vs parameter prose split
 *   + blank-parameter check (regression guard)
 *
 * Run from this repository so `@deepseek-ai/dsh-tools` and `js-tiktoken` resolve.
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { getEncoding } = require('js-tiktoken')

const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)
const sdk = await import('@deepseek-ai/dsh-tools')

const cl = getEncoding('cl100k_base')
const o2 = getEncoding('o200k_base')
const tc = (s) => cl.encode(s).length
const to = (s) => o2.encode(s).length
const bytes = (s) => Buffer.byteLength(s, 'utf8')

// --- collect definitions + commands exactly as the host does -----------------
const definitions = [], commands = [], disposers = []
const host = {
  tools: { register: (d) => { definitions.push(d) } },
  commands: { register: (c) => { commands.push(c) } },
}
try {
  for (const dispose of apply(host)) if (typeof dispose === 'function') disposers.push(dispose)

  const schemas = definitions.map((d) => sdk.ToolRuntime.prototype.schemaOf.call({}, d, true))
  const outputs = schemas.map((s, i) => ({ ...s, output: definitions[i].output.schema }))

  const emptyTs = sdk.renderToolsSdk([])
  const emptyPy = sdk.renderToolsSdkPy([])
  const emptyTsLen = bytes(emptyTs), emptyPyLen = bytes(emptyPy)
  const emptyTsTok = tc(emptyTs), emptyPyTok = tc(emptyPy)

  // --- per-tool marginal cost in each projection ----------------------------
  const rows = schemas.map((schema, i) => {
    const native = JSON.stringify(schema)
    const ts = sdk.renderToolsSdk([outputs[i]])
    const py = sdk.renderToolsSdkPy([outputs[i]])
    const paramsText = Object.entries(schema.parameters?.properties ?? {})
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')
    // prose only: every parameter description string, names/types excluded
    const proseBits = []
    const collectProse = (node) => {
      if (!node || typeof node !== 'object') return
      if (typeof node.description === 'string') proseBits.push(node.description)
      if (node.properties) for (const child of Object.values(node.properties)) collectProse(child)
      if (node.items) collectProse(node.items)
      for (const branch of node.oneOf ?? []) collectProse(branch)
    }
    collectProse(schema.parameters)
    const paramDescTok = tc(proseBits.join('\n'))
    let blank = 0
    const walk = (node, path = '') => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'object' && node.properties) {
        for (const [name, child] of Object.entries(node.properties)) {
          const field = path ? `${path}.${name}` : name
          if (!String(child.description ?? '').trim()) blank++
          walk(child, field)
        }
      }
      if (node.type === 'array' && node.items) walk(node.items, `${path}[]`)
      for (const [k, branch] of (node.oneOf ?? []).entries()) walk(branch, `${path}.oneOf[${k}]`)
    }
    walk(schema.parameters)
    return {
      name: schema.name,
      descTok: tc(schema.description ?? ''),
      paramTok: tc(paramsText),
      paramDescTok,
      nativeTok: tc(native),
      tsTok: tc(ts) - emptyTsTok,
      pyTok: tc(py) - emptyPyTok,
      blank,
      required: (schema.parameters?.required ?? []).length,
      props: Object.keys(schema.parameters?.properties ?? {}).length,
    }
  })

  // --- projection totals ----------------------------------------------------
  const nativeAll = JSON.stringify(schemas)
  const tsAll = sdk.renderToolsSdk(outputs)
  const pyAll = sdk.renderToolsSdkPy(outputs)
  const cmdTok = commands.length ? tc(JSON.stringify(commands.map(({ name, description, input }) => ({ name, description, input })))) : 0

  const fmt = (n) => String(n).padStart(8)
  console.log('=== dsh-forge prompt surface — all three DSH projections (js-tiktoken) ===\n')
  console.log(
    'tool'.padEnd(17) + 'desc'.padStart(7) + 'params'.padStart(8) +
    'native'.padStart(9) + 'ptcTS'.padStart(8) + 'ptcPy'.padStart(8) +
    'blank'.padStart(7) + 'req/props'.padStart(11),
  )
  for (const r of rows) {
    console.log(
      '  ' + r.name.padEnd(15) + fmt(r.descTok) + fmt(r.paramTok) +
      fmt(r.nativeTok) + fmt(r.tsTok) + fmt(r.pyTok) +
      String(r.blank).padStart(7) + `${r.required}/${r.props}`.padStart(11),
    )
  }

  const sum = (k) => rows.reduce((a, r) => a + r[k], 0)
  console.log('  ' + '-'.repeat(78))
  console.log(
    '  ' + `SUM(${rows.length} tools)`.padEnd(15) + fmt(sum('descTok')) + fmt(sum('paramTok')) +
    fmt(sum('nativeTok')) + fmt(sum('tsTok')) + fmt(sum('pyTok')) +
    String(sum('blank')).padStart(7),
  )

  console.log('\n--- 离线工具投影总量（不含完整宿主提示及运行时作用域）---')
  console.log(`  native  (JSON schema array)  : ${tc(nativeAll)} tok (cl100k) / ${to(nativeAll)} (o200k)   ${bytes(nativeAll)} B  [${rows.length} 工具]`)
  console.log(`  ptcTypescript (SDK 源码投影) : ${tc(tsAll) - emptyTsTok} tok (cl100k) / ${to(tsAll) - to(emptyTs)} (o200k)   ${bytes(tsAll) - emptyTsLen} B`)
  console.log(`  ptcPython    (SDK 源码投影)  : ${tc(pyAll) - emptyPyTok} tok (cl100k) / ${to(pyAll) - to(emptyPy)} (o200k)   ${bytes(pyAll) - emptyPyLen} B`)
  console.log(`  forge-status 命令            : ${cmdTok} tok (cl100k)`)
  console.log(`  bytes/4 估算(native)         : ${Math.ceil(bytes(nativeAll) / 4)}  → cl100k ${tc(nativeAll)}`)

  console.log('\n--- 结构拆分（native 视角）---')
  console.log(`  description 正文合计 : ${sum('descTok')} tok`)
  console.log(`  参数说明正文合计     : ${sum('paramDescTok')} tok   ← 只有参数 description 字符串`)
  console.log(`  参数 schema 序化文本 : ${sum('paramTok')} tok   ← 参数名+类型+enum+说明`)
  console.log(`  native 全文合计      : ${tc(nativeAll)} tok  → 纯 JSON 骨架占 ${tc(nativeAll) - sum('descTok') - sum('paramTok')} tok`)
  console.log(`  空参数说明           : ${sum('blank')} 项`)
  console.log(`  bytes/4 vs 真实（同一字符串 native）: ${Math.ceil(bytes(nativeAll) / 4)} vs ${tc(nativeAll)} → bytes/4 高估 ${Math.ceil(bytes(nativeAll) / 4) - tc(nativeAll)} (${Math.round((Math.ceil(bytes(nativeAll) / 4) / tc(nativeAll) - 1) * 100)}%)`)

  console.log('\n--- 最贵工具（按 ptcPython 边际）---')
  for (const r of [...rows].sort((a, b) => b.pyTok - a.pyTok).slice(0, 5)) {
    console.log(`  ${r.name.padEnd(16)} ptcPy ${String(r.pyTok).padStart(5)}  ptcTS ${String(r.tsTok).padStart(5)}  native ${String(r.nativeTok).padStart(5)}`)
  }
} finally {
  for (const dispose of disposers.reverse()) await dispose()
}
