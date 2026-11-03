/**
 * Offline performance and token benchmark: `retrieval` vs `full`.
 *
 * Four measurements, all read-only and reproducible without a model:
 *
 *   1. surface   — the fixed per-request cost: the registered tool schemas in
 *                  the three projections DSH renders (native JSON, PTC
 *                  TypeScript, PTC Python) plus the prompt-guidance section.
 *   2. glob      — the resident Rust sidecar against the built-in's ripgrep
 *                  reference. Both path lists are asserted equal.
 *   3. grep      — offline potential of the excerpt helper; not deployed savings.
 *                  Direct long-line calls delegate to the unchanged host preview.
 *   4. read      — a definition's line window vs the whole file, which is what
 *                  `file#Symbol` buys instead of a full read.
 *
 * Token counts come from js-tiktoken (cl100k_base / o200k_base). DeepSeek ships
 * its own tokenizer, so read these as one consistent yardstick across the two
 * modes — not as a billing statement.
 *
 * Usage:
 *   pnpm bench:takeover
 *   BENCH_CORPUS=D:/corpus/vcpchat pnpm bench:takeover
 *
 * @module dsh-forge/tests/bench-takeover
 */

import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const require = createRequire(import.meta.url)
const { getEncoding } = require('js-tiktoken')
const cl = getEncoding('cl100k_base')
const o2 = getEncoding('o200k_base')

const { apply } = await import('../lib/index.js')
const { excerptLine, toWorkdirRelative, lineWindow } = await import('../lib/augment.js')
const { indexerGlobSearch, resetIndexer } = await import('../lib/indexer-client.js')
const sdk = await import('@deepseek-ai/dsh-tools')

const bytes = (text) => Buffer.byteLength(String(text ?? ''), 'utf8')
const tok = (text) => cl.encode(String(text ?? '')).length
const tokO = (text) => o2.encode(String(text ?? '')).length
const CORPUS = path.resolve(process.env.BENCH_CORPUS ?? process.cwd())
const RG = path.normalize(process.env.DSH_FORGE_RG ?? 'rg')
const VCS_EXCLUDES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']

const int = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

function table(headers, rows, widths) {
  console.log('  ' + headers.map((h, i) => (i === 0 ? h.padEnd(widths[i]) : h.padStart(widths[i]))).join(''))
  console.log('  ' + widths.map((w) => '-'.repeat(w)).join(''))
  for (const row of rows) console.log('  ' + row.map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join(''))
}

// --- 1. tool surface ---------------------------------------------------------

/** Mount the plugin against a stand-in host and collect what it registers. */
async function surface(config) {
  const definitions = []
  const commands = []
  const guidance = []
  // Built-ins the host would serve: `visibleForgeText` probes `read` to decide
  // whether the augmented read answers `file#Symbol`, so a stub registry without
  // them captures the wrong guidance branch.
  const builtins = ['read', 'grep', 'glob', 'edit'].map((name) => ({ name }))
  const host = {
    tools: {
      register: (definition) => { definitions.push(definition) },
      get: (name) => definitions.find((definition) => definition.name === name) ?? builtins.find((builtin) => builtin.name === name),
    },
    commands: { register: (command) => { commands.push(command) } },
    on: () => () => {},
    get: () => undefined,
    systemPrompt: { section: (section) => { guidance.push(section); return () => {} } },
  }
  const disposers = []
  try {
    for (const dispose of apply(host, config)) if (typeof dispose === 'function') disposers.push(dispose)
    const schemas = definitions.map((definition) => sdk.ToolRuntime.prototype.schemaOf.call({}, definition, true))
    const outputs = schemas.map((schema, index) => ({ ...schema, output: definitions[index].output.schema }))
    const emptyTs = sdk.renderToolsSdk([])
    const emptyPy = sdk.renderToolsSdkPy([])
    const native = JSON.stringify(schemas)
    const ts = sdk.renderToolsSdk(outputs)
    const py = sdk.renderToolsSdkPy(outputs)
    // `section.text` is usually a render function (per-scope visibility); the
    // bytes that actually reach the prompt are its output for one scope.
    const guide = guidance
      .map((section) => (typeof section.text === 'function' ? section.text({}) : section.text ?? ''))
      .join('\n')
    return {
      tools: schemas.length,
      nativeBytes: bytes(native), nativeTok: tok(native),
      tsBytes: bytes(ts) - bytes(emptyTs), tsTok: tok(ts) - tok(emptyTs),
      pyBytes: bytes(py) - bytes(emptyPy), pyTok: tok(py) - tok(emptyPy),
      guideBytes: bytes(guide), guideTok: tok(guide),
      commandTok: tok(JSON.stringify(commands.map(({ name, description, input }) => ({ name, description, input })))),
    }
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
  }
}

const additive = await surface(undefined)
const takeover = await surface({ surface: 'full' })

console.log('\n=== 1. 工具面固定成本（每次请求都付） ===')
console.log(`  语料：dsh-forge 工具表；retrieval ${additive.tools} 个工具 / full ${takeover.tools} 个`)
const delta = (a, b) => `${b - a >= 0 ? '+' : ''}${int(b - a)}`
table(['投影', 'retrieval', 'full', 'Δ', 'Δ%'], [
  ['native JSON (B)', int(additive.nativeBytes), int(takeover.nativeBytes), delta(additive.nativeBytes, takeover.nativeBytes), `${((takeover.nativeBytes / additive.nativeBytes - 1) * 100).toFixed(1)}%`],
  ['native (cl100k tok)', int(additive.nativeTok), int(takeover.nativeTok), delta(additive.nativeTok, takeover.nativeTok), `${((takeover.nativeTok / additive.nativeTok - 1) * 100).toFixed(1)}%`],
  ['PTC TypeScript (B)', int(additive.tsBytes), int(takeover.tsBytes), delta(additive.tsBytes, takeover.tsBytes), `${((takeover.tsBytes / additive.tsBytes - 1) * 100).toFixed(1)}%`],
  ['PTC TypeScript (tok)', int(additive.tsTok), int(takeover.tsTok), delta(additive.tsTok, takeover.tsTok), `${((takeover.tsTok / additive.tsTok - 1) * 100).toFixed(1)}%`],
  ['PTC Python (B)', int(additive.pyBytes), int(takeover.pyBytes), delta(additive.pyBytes, takeover.pyBytes), `${((takeover.pyBytes / additive.pyBytes - 1) * 100).toFixed(1)}%`],
  ['PTC Python (tok)', int(additive.pyTok), int(takeover.pyTok), delta(additive.pyTok, takeover.pyTok), `${((takeover.pyTok / additive.pyTok - 1) * 100).toFixed(1)}%`],
  ['guidance 段 (tok)', int(additive.guideTok), int(takeover.guideTok), delta(additive.guideTok, takeover.guideTok), `${((takeover.guideTok / additive.guideTok - 1) * 100).toFixed(1)}%`],
  ['/forge-status 命令 (tok)', int(additive.commandTok), int(takeover.commandTok), delta(additive.commandTok, takeover.commandTok), '—'],
  ['合计 cl100k (tok)', int(additive.nativeTok + additive.guideTok + additive.commandTok), int(takeover.nativeTok + takeover.guideTok + takeover.commandTok),
    delta(additive.nativeTok + additive.guideTok + additive.commandTok, takeover.nativeTok + takeover.guideTok + takeover.commandTok),
    `${(((takeover.nativeTok + takeover.guideTok + takeover.commandTok) / (additive.nativeTok + additive.guideTok + additive.commandTok) - 1) * 100).toFixed(1)}%`],
], [26, 12, 12, 10, 9])

// --- 2. glob -----------------------------------------------------------------

/** Is the ripgrep binary runnable? Probed once; the reason is printed, not thrown. */
function rgAvailable() {
  try {
    return spawnSync(RG, ['--version'], { windowsHide: true, stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

function runRg(argv) {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const child = spawn(RG, ['--no-config', ...argv], { cwd: CORPUS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0 && code !== 1) { reject(new Error(`rg exited ${code}`)); return }
      resolve({ stdout: Buffer.concat(chunks).toString('utf8'), ms: performance.now() - started })
    })
  })
}

function globArgv(pattern, sort) {
  return [
    '--files', `--glob=${pattern}`, '--no-ignore', '--hidden',
    ...VCS_EXCLUDES.flatMap((name) => [`--glob=!**/${name}`, `--glob=!**/${name}/**`]),
    ...(sort ? ['--sort=modified'] : []),
  ]
}

async function builtinGlob(pattern) {
  const { stdout, ms } = await runRg(globArgv(pattern, true))
  return { paths: stdout.split(/\r?\n/).filter(Boolean), ms }
}

async function forgeGlob(pattern) {
  const started = performance.now()
  const paths = await indexerGlobSearch(CORPUS, CORPUS, pattern)
  if (paths === null) throw new Error('native search sidecar unavailable')
  return { paths, ms: performance.now() - started }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

console.log(`\n=== 2. glob：内置（ripgrep 基线）vs resident Rust sidecar ===`)
console.log(`  语料：${CORPUS}    ripgrep：${RG}`)
const rgOk = rgAvailable()
if (!rgOk) {
  console.log('  ✗ 找不到 ripgrep，跳过本节。设 DSH_FORGE_RG 指向 rg（DSH 自带那份在')
  console.log('    resources/app.asar.unpacked/node_modules/@vscode/ripgrep-<platform>/bin/rg.exe），或放进 PATH。')
  process.exitCode = 1
}
const globRows = []
let globMismatch = 0
await resetIndexer()
for (const pattern of rgOk ? ['*.js', '*.ts', '*.md'] : []) {
  const builtinTimes = []
  const forgeTimes = []
  let paths = []
  let equal = true
  for (let round = 0; round < 3; round++) {
    const built = await builtinGlob(pattern)
    const fast = await forgeGlob(pattern)
    builtinTimes.push(built.ms)
    forgeTimes.push(fast.ms)
    paths = built.paths
    const normalize = (value) => value.replaceAll('\\', '/')
    if (built.paths.length !== fast.paths.length || built.paths.some((p, i) => normalize(p) !== normalize(fast.paths[i]))) equal = false
  }
  if (!equal) globMismatch++
  globRows.push([
    pattern,
    int(Math.round(median(builtinTimes))),
    int(Math.round(median(forgeTimes))),
    `${(median(builtinTimes) / median(forgeTimes)).toFixed(2)}×`,
    int(paths.length),
    equal ? '一致' : '不一致',
  ])
}
if (rgOk) table(['查询', '内置 ms', 'native ms', '加速', '路径数', '顺序一致'], globRows, [12, 10, 13, 8, 10, 10])

// --- 3. grep overlong lines --------------------------------------------------

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.css', '.html', '.json', '.md', '.py', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.lua'])
/** Code only: a minified line is the real overlong case; a one-line JSON dump is not. */
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.css', '.html', '.py', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.lua'])
const SKIP_DIR = new Set(['.git', 'node_modules', 'dist', 'lib', 'build', 'target', '.next', '.cache', '.tmp-analysis', '.pnpm-store', '.workbuddy', 'coverage', 'out'])

function* walkFiles(dir, budget) {
  let seen = 0
  const stack = [dir]
  while (stack.length > 0 && seen < budget) {
    const current = stack.pop()
    let entries
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIR.has(entry.name)) stack.push(path.join(current, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue
      seen++
      yield path.join(current, entry.name)
      if (seen >= budget) return
    }
  }
}

const longLines = []
for (const file of walkFiles(CORPUS, 4000)) {
  if (!CODE_EXT.has(path.extname(file).toLowerCase())) continue
  let text
  try {
    if (statSync(file).size > 8 * 1024 * 1024) continue
    text = readFileSync(file, 'utf8')
  } catch { continue }
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const size = bytes(line)
    if (size > 2000) longLines.push({ file, line, size })
  }
  if (longLines.length > 400) break
}
longLines.sort((a, b) => b.size - a.size)
const samples = longLines.slice(0, 5)

console.log('\n=== 3. grep：超长命中行，未部署摘录算法的离线潜力 ===')
console.log('  当前直调长行回退宿主，实际预览与内置一致；下表仅测 excerptLine 纯函数，不计为实际 token 节省。')
if (samples.length === 0) {
  console.log('  语料中没有超过 2000 字节的行，跳过。')
} else {
  const rows = []
  for (const sample of samples.slice(0, 5)) {
    // The word a model would actually search for can sit anywhere on the line;
    // taking the last one keeps the sample honest about the 2000-byte head.
    const words = [...sample.line.matchAll(/[A-Za-z_][A-Za-z0-9_]{7,}/g)]
    const word = words.length > 0 ? words[words.length - 1] : null
    if (word === null) continue
    const re = new RegExp(word[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const at = bytes(sample.line.slice(0, word.index))
    const excerpt = excerptLine(sample.line, re)
    const head = Buffer.from(sample.line, 'utf8').subarray(0, 2000).toString('utf8').replace(/\uFFFD+$/, '')
    const excerptText = excerpt ?? sample.line
    rows.push([
      `${toWorkdirRelative(sample.file, CORPUS)}`,
      word[0],
      int(sample.size),
      int(at),
      int(bytes(head)),
      at + bytes(word[0]) <= 2000 ? '可见' : '丢失',
      excerpt === undefined ? int(sample.size) : int(bytes(excerptText)),
      excerpt === undefined ? '—' : (excerptText.includes(word[0]) ? '可见' : '丢失'),
    ])
  }
  table(['文件', '匹配词', '整行 B', '匹配 @B', '内置预览 B', '内置', '实验摘录 B', '实验摘录'], rows, [40, 15, 9, 9, 11, 6, 11, 8])
}

// --- 4. read -----------------------------------------------------------------

function functionSpan(lines, startIndex) {
  let depth = 0
  let seen = false
  for (let i = startIndex; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; seen = true } else if (ch === '}') { depth--; if (seen && depth === 0) return i }
    }
  }
  return Math.min(lines.length - 1, startIndex + 80)
}

const readRows = []
const sizeCandidates = []
for (const file of walkFiles(CORPUS, 2000)) {
  if (!CODE_EXT.has(path.extname(file).toLowerCase())) continue
  try {
    const size = statSync(file).size
    if (size >= 30 * 1024) sizeCandidates.push({ file, size })
  } catch { /* unreadable: not a sample */ }
}
sizeCandidates.sort((a, b) => b.size - a.size)
for (const { file } of sizeCandidates) {
  if (readRows.length >= 4) break
  let text
  try { text = readFileSync(file, 'utf8') } catch { continue }
  const lines = text.split('\n')
  const index = lines.findIndex((line) => /^(export )?(async )?function [A-Za-z0-9_]+/.test(line))
  if (index < 0) continue
  const name = /function ([A-Za-z0-9_]+)/.exec(lines[index])?.[1] ?? '?'
  const end = functionSpan(lines, index)
  // Typical single-definition reads, not a 50 KB monster: the point is what one
  // definition costs, and a window that hits the 50 KB cap says something else.
  if (end - index < 25 || end - index > 150) continue
  const window = lineWindow(text, index + 1, end + 1)
  const windowText = window.lines.map((entry) => entry.text).join('\n')
  readRows.push([
    `${toWorkdirRelative(file, CORPUS)}#${name}`,
    int(bytes(text)), int(tok(text)),
    int(bytes(windowText)), int(tok(windowText)),
    `${(bytes(windowText) / bytes(text) * 100).toFixed(1)}%`,
  ])
}

console.log('\n=== 4. read：file#Symbol 窗口 vs 整文件 ===')
table(['文件#符号', '整文件 B', '整文件 tok', '窗口 B', '窗口 tok', '占整文件'], readRows, [30, 10, 11, 9, 10, 9])

console.log('\n=== 口径 ===')
console.log('  · token 用 js-tiktoken cl100k_base（o200k 另算不列）；DeepSeek 自家 tokenizer 不同，此数只用于两种模式的相对比较。')
console.log('  · 第 1 节是固定成本，每次请求都付；第 2-4 节是单次调用的成本，按调用次数累加。')
console.log('  · 第 2 节同时断言路径集合与顺序一致（顺序一致=逐字节相同），不一致会显示「不一致」而不是只报加速比。')
console.log('  · 第 3 节内置侧按 2000 字节截断近似；实验摘录侧仅运行 excerptLine() 纯函数。当前长行实际回退宿主，未部署该算法，不能算线上 token 收益。')
console.log('  · 第 4 节窗口用括号计数定位函数体，注释/字符串里的花括号可能让范围略偏，用于量级比较。')
if (globMismatch > 0) {
  console.log(`\n  ⚠ glob 有 ${globMismatch} 个查询的输出与内置不一致 —— 快路径不能用于该查询。`)
  process.exitCode = 1
}
