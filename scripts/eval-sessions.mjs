// 汇总某工作区会话的实测指标：注册模式、题目、轮数、工具序列、token、墙钟、返回字节。
// 用法：node scripts/eval-sessions.mjs report [--since <ISO>] [--json]
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC_0 = 0x28
const MAGIC_1 = 0xb5
const MAGIC_2 = 0x2f
const MAGIC_3 = 0xfd

function decodeSession(file) {
  const raw = readFileSync(file)
  const frames = []
  let start = -1
  for (let i = 0; i + 4 <= raw.length; i++) {
    if (raw[i] === MAGIC_0 && raw[i + 1] === MAGIC_1 && raw[i + 2] === MAGIC_2 && raw[i + 3] === MAGIC_3) {
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
      // 尾部截断帧
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
  return { frames: frames.length, bytes: raw.length, events }
}

const argOf = (name) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const TEXT = (message) => {
  if (message === undefined) return ''
  if (typeof message === 'string') return message
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n')
  }
  return ''
}

function report(dirName, root) {
  const file = join(root, dirName, 'session.v4.jsonl.zstd')
  if (!existsSync(file)) return undefined
  const { events } = decodeSession(file)

  const systemText = events
    .filter((event) => event.type === 'system/message')
    .map((event) => TEXT(event.data?.message))
    .join('\n')
  const mode = systemText.includes('use built-in glob for path patterns')
    ? 'takeover'
    : systemText.includes('Prefer these tools for the tasks below')
      ? 'additive(old)'
      : systemText.includes('Route by task below')
        ? 'additive'
        : 'no-forge'

  const users = events.filter((event) => event.type === 'user/message')
  const question = TEXT(users[0]?.data?.message ?? users[0]?.data).replace(/\s+/g, ' ').trim()

  const calls = events.filter((event) => event.type === 'tool/call')
  const results = events.filter((event) => event.type === 'tool/result')
  const asst = events.filter((event) => event.type === 'assistant/message')

  let input = 0
  let output = 0
  let cached = 0
  let peak = 0
  for (const message of asst) {
    const usage = message.data?.usage
    if (usage === undefined) continue
    input += usage.inputTokens ?? 0
    output += usage.outputTokens ?? 0
    cached += usage.cacheReadTokens ?? 0
    peak = Math.max(peak, usage.totalTokens ?? 0)
  }

  let resultBytes = 0
  for (const result of results) resultBytes += TEXT(result.data?.message).length

  const turnStart = events.find((event) => event.type === 'turn/start')?.time ?? 0
  const turnEnd = [...events].reverse().find((event) => event.type === 'turn/end')?.time ?? 0

  const finalText = [...asst].reverse().map((message) => TEXT(message.data?.message)).find((text) => text !== '') ?? ''

  return {
    dirName,
    mode,
    question,
    steps: events.filter((event) => event.type === 'step/end').length,
    calls: calls.length,
    seq: calls.map((call) => call.data?.name),
    input,
    output,
    cached,
    peak,
    resultBytes,
    wallMs: turnEnd > turnStart ? turnEnd - turnStart : 0,
    finalChars: finalText.length,
    finalText
  }
}

const root = join(homedir(), '.dsh', 'sessions', '--D-AI-VCPChat--')
const only = argOf('only')
const since = argOf('since')
let names = readdirSync(root).filter((name) => name.startsWith('session-'))
if (only !== undefined) {
  const keep = new Set(only.split(','))
  names = names.filter((name) => keep.has(name))
}

const rows = []
for (const name of names) {
  const entry = report(name, root)
  if (entry === undefined) continue
  if (since !== undefined) {
    const at = readFileSync(join(root, name, 'session.v4.jsonl.zstd')).length
    void at
  }
  rows.push(entry)
}

// 三种组合都留着：no-forge 是对照组，不能被过滤掉。
const filtered = rows
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(filtered, undefined, 2))
} else {
  const pad = (text, width) => String(text).padEnd(width)
  console.log(
    `${pad('mode', 10)}${pad('steps', 6)}${pad('calls', 6)}${pad('in', 8)}${pad('out', 7)}${pad('peak', 8)}${pad('resKB', 8)}${pad('wall', 9)}Q`
  )
  for (const row of filtered) {
    console.log(
      `${pad(row.mode, 10)}${pad(row.steps, 6)}${pad(row.calls, 6)}${pad(row.input, 8)}${pad(row.output, 7)}${pad(
        row.peak,
        8
      )}${pad((row.resultBytes / 1024).toFixed(1), 8)}${pad((row.wallMs / 1000).toFixed(1) + 's', 9)}${row.question.slice(0, 46)}`
    )
    console.log(`    ${row.seq.join(',')}`)
  }
}
