/**
 * 三组对照：无插件 / additive / takeover，同一批 8 题。
 *
 * 分组依据是 request/header 里的工具列表，不是系统提示的文案 ——
 * 只要工具表里没有 ff* 就是真无插件，避免旧版 guidance 混进来。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const root = join(homedir(), '.dsh', 'sessions', '--D-AI-VCPChat--')

function decode(file) {
  const raw = readFileSync(file)
  const frames = []
  let start = -1
  for (let i = 0; i + 4 <= raw.length; i++) {
    if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) {
      if (start >= 0) frames.push(raw.subarray(start, i))
      start = i
    }
  }
  if (start >= 0) frames.push(raw.subarray(start))
  const chunks = []
  for (const frame of frames) {
    try {
      chunks.push(zstdDecompressSync(frame))
    } catch {
      // 尾帧截断
    }
  }
  const events = []
  for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // 半行
    }
  }
  return events
}

const text = (message) => {
  if (message === undefined || message === null) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('')
  return ''
}

/** 题目归档：按题干里的稳定片段匹配，顺序即表格顺序。 */
const QUESTIONS = [
  ['Q1 模糊文件名', 'stramManager'],
  ['Q2 正则 IPC', 'app-features 开头'],
  ['Q3 多字面量', 'defineWaStubs 和 rendererEntries'],
  ['Q4 路径 glob', 'preloads/api 下所有'],
  ['Q5 读一个定义', 'defineWaStubs 这个函数'],
  ['Q6 同名多定义', 'debounce'],
  ['Q7 长行命中', 'EllipseCurve'],
  ['Q8 IPC 闭环', 'app-features:renderer-entries'],
]

const classify = (question) => {
  for (const [label, key] of QUESTIONS) if (question.includes(key)) return label
  return undefined
}

const rows = []
for (const name of readdirSync(root).filter((entry) => entry.startsWith('session-'))) {
  let events
  try {
    events = decode(join(root, name, 'session.v4.jsonl.zstd'))
  } catch {
    continue
  }
  const question = events
    .filter((event) => event.type === 'user/message')
    .map((event) => text(event.data?.message ?? event.data))
    .join(' ')
    .replace(/\s+/g, ' ')
  const label = classify(question)
  if (label === undefined) continue

  const header = events.find((event) => event.type === 'request/header')
  const tools = (header?.data?.header?.tools ?? []).map((tool) => tool.name)
  const forgeTools = tools.filter((tool) => tool.startsWith('ff'))
  // 工具表决定有没有插件；guidance 文案决定是 additive 还是 takeover。
  // 只看文案会把旧版 guidance 误判成 no-forge，只看工具表又分不出两种模式。
  const systemText = events
    .filter((event) => event.type === 'system/message')
    .map((event) => text(event.data?.message))
    .join('\n')
  const group = forgeTools.length === 0
    ? 'no-forge'
    : systemText.includes('use built-in glob for path patterns')
      ? 'takeover'
      : 'additive'

  const usage = events
    .filter((event) => event.type === 'assistant/message')
    .map((event) => event.data.usage)
    .filter(Boolean)
  if (usage.length === 0) continue

  const turnStart = events.find((event) => event.type === 'turn/start')?.time ?? 0
  const turnEnd = [...events].reverse().find((event) => event.type === 'turn/end')?.time ?? 0
  const results = events.filter((event) => event.type === 'tool/result')
  const resultBytes = results.reduce((sum, event) => sum + text(event.data?.message).length, 0)

  rows.push({
    session: name.slice(8, 16),
    label,
    group,
    rounds: usage.length,
    sumTotal: usage.reduce((sum, entry) => sum + (entry.totalTokens ?? 0), 0),
    sumIn: usage.reduce((sum, entry) => sum + (entry.inputTokens ?? 0), 0),
    peak: Math.max(...usage.map((entry) => entry.totalTokens ?? 0)),
    resultBytes,
    wallMs: turnEnd > turnStart ? turnEnd - turnStart : 0,
    calls: events.filter((event) => event.type === 'tool/call').length,
  })
}

const pad = (value, width) => String(value).padEnd(width)
const num = (value, width = 7) => String(value).padStart(width)

const GROUPS = ['no-forge', 'additive', 'takeover']

/** 组内所有会话按「每题一次」归一化后的平均值，消除重复次数差异。 */
const normalize = (group) => {
  const byLabel = new Map()
  for (const [label] of QUESTIONS) {
    const hits = rows.filter((row) => row.label === label && row.group === group)
    if (hits.length === 0) continue
    byLabel.set(label, {
      rounds: hits.reduce((sum, row) => sum + row.rounds, 0) / hits.length,
      total: hits.reduce((sum, row) => sum + row.sumTotal, 0) / hits.length,
      wall: hits.reduce((sum, row) => sum + row.wallMs, 0) / hits.length / 1000,
      bytes: hits.reduce((sum, row) => sum + row.resultBytes, 0) / hits.length / 1024,
      n: hits.length,
    })
  }
  return byLabel
}

console.log('=== 组汇总（原始）===')
for (const group of GROUPS) {
  const subset = rows.filter((row) => row.group === group)
  if (subset.length === 0) continue
  const rounds = subset.reduce((sum, row) => sum + row.rounds, 0)
  const sumTotal = subset.reduce((sum, row) => sum + row.sumTotal, 0)
  console.log(
    `${pad(group, 10)} 会话 ${num(subset.length, 3)}  轮 ${num(rounds, 4)}  sumTotal ${num(sumTotal, 9)}  ` +
    `每轮 ${num(Math.round(sumTotal / rounds), 6)}  墙钟 ${num((subset.reduce((s, r) => s + r.wallMs, 0) / 1000).toFixed(1), 7)}s`
  )
}

console.log()
console.log('=== 组汇总（每题一次归一化）===')
const norm = Object.fromEntries(GROUPS.map((group) => [group, normalize(group)]))
for (const group of GROUPS) {
  const cells = [...norm[group].values()]
  if (cells.length === 0) continue
  const rounds = cells.reduce((sum, cell) => sum + cell.rounds, 0) / cells.length
  const total = cells.reduce((sum, cell) => sum + cell.total, 0) / cells.length
  const wall = cells.reduce((sum, cell) => sum + cell.wall, 0) / cells.length
  console.log(
    `${pad(group, 10)} 题 ${num(cells.length, 2)}  ${num(rounds.toFixed(1), 5)}r  ` +
    `sumTotal ${num(Math.round(total), 7)}  墙钟 ${num(wall.toFixed(1), 6)}s`
  )
}

console.log()
console.log(pad('题', 15) + pad('组', 10) + num('轮', 4) + num('sumTotal', 10) + num('每轮', 8) + num('峰值', 8) + num('calls', 6) + num('返回KB', 8) + num('墙钟s', 8))
const sorted = [...rows].sort((a, b) => a.label.localeCompare(b.label) || a.group.localeCompare(b.group))
for (const row of sorted) {
  console.log(
    pad(row.label, 15) + pad(row.group, 10) + num(row.rounds, 4) + num(row.sumTotal, 10) +
    num(Math.round(row.sumTotal / row.rounds), 8) + num(row.peak, 8) + num(row.calls, 6) +
    num((row.resultBytes / 1024).toFixed(1), 8) + num((row.wallMs / 1000).toFixed(1), 8)
  )
}

console.log()
console.log('=== 按题归一化（每题平均，消除重复次数差异）===')
console.log(
  pad('题', 16) +
  pad('无插件', 20) + pad('additive', 20) + pad('takeover', 20) + 'takeover vs 无'
)
for (const [label] of QUESTIONS) {
  const a = norm['no-forge'].get(label)
  const b = norm['additive'].get(label)
  const c = norm['takeover'].get(label)
  const fmt = (value) => value === undefined
    ? '—'.padEnd(20)
    : `${value.rounds.toFixed(1)}r ${Math.round(value.total / 1000)}k ${value.wall.toFixed(1)}s`.padEnd(20)
  const delta = a === undefined || c === undefined ? '—' : `${(((c.total / a.total) - 1) * 100).toFixed(0)}%`
  console.log(pad(label, 16) + fmt(a) + fmt(b) + fmt(c) + delta)
}
