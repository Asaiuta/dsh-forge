/**
 * 工具使用率：每个工具在多少个会话里「被暴露」、实际被调用了多少次。
 *
 * 曝光取 request/header 的 tools 名单（权威：模型当时真能看到它），
 * 调用取 tool/call。只看调用次数会把「后来才加的工具」误判成死工具 ——
 * 分母必须是曝光会话数。
 *
 *   node scripts/tool-usage.mjs            # 全部会话
 *   node scripts/tool-usage.mjs ff_file    # 附带某个 ff* 工具的 action 分布
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const base = join(homedir(), '.dsh', 'sessions')

const text = (message) => {
  if (message === undefined || message === null) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('')
  return ''
}

/** 多帧 zstd：单帧只解第一段会漏掉绝大部分。 */
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

const exposed = new Map()
const used = new Map()
const actions = new Map()
const actionFailure = new Map()
const bytes = new Map()
const biggest = new Map()
const sessions = []

for (const workspace of readdirSync(base)) {
  let entries
  try {
    entries = readdirSync(join(base, workspace))
  } catch {
    continue
  }
  for (const name of entries) {
    if (!name.startsWith('session-')) continue
    let events
    try {
      events = decode(join(base, workspace, name, 'session.v4.jsonl.zstd'))
    } catch {
      continue
    }
    const header = events.find((event) => event.type === 'request/header')
    if (!header) continue
    const tools = (header.data?.header?.tools ?? []).map((tool) => tool.name)
    for (const tool of tools) exposed.set(tool, (exposed.get(tool) ?? 0) + 1)

    const results = new Map()
    for (const event of events) {
      if (event.type !== 'tool/result') continue
      const id = event.data?.toolCallId ?? event.data?.message?.toolCallId
      if (id) results.set(id, event)
    }
    for (const event of events) {
      if (event.type !== 'tool/call') continue
      const tool = event.data?.name
      if (!tool) continue
      used.set(tool, (used.get(tool) ?? 0) + 1)
      const result = results.get(event.data.callId)
      const body = result === undefined ? '' : text(result.data?.message)
      bytes.set(tool, (bytes.get(tool) ?? 0) + body.length)
      if (body.length > (biggest.get(tool) ?? 0)) biggest.set(tool, body.length)
      if (!tool.startsWith('ff')) continue
      let args = {}
      try {
        args = JSON.parse(event.data.arguments)
      } catch {
        // 参数不是 JSON
      }
      const key = `${tool}\0${args.action ?? '(no action)'}`
      actions.set(key, (actions.get(key) ?? 0) + 1)
      if (/error|refus|failed|失败/i.test(body.slice(0, 400))) actionFailure.set(key, (actionFailure.get(key) ?? 0) + 1)
    }
    sessions.push(name.slice(8, 16))
  }
}

const pad = (value, width) => String(value).padEnd(width)
const num = (value, width) => String(value).padStart(width)

console.log(`会话 ${sessions.length} · 调用 ${[...used.values()].reduce((a, b) => a + b, 0)}`)

const ff = [...exposed.keys()].filter((tool) => tool.startsWith('ff'))
console.log()
console.log(pad('工具', 14) + num('曝光', 6) + num('调用', 6) + num('命中率', 8) + num('返回KB', 9) + num('均值KB', 9) + num('最大KB', 9))
for (const tool of ff.sort((a, b) => (used.get(b) ?? 0) / exposed.get(b) - (used.get(a) ?? 0) / exposed.get(a))) {
  const shown = exposed.get(tool)
  const calls = used.get(tool) ?? 0
  const total = (bytes.get(tool) ?? 0) / 1024
  console.log(
    pad(tool, 14) + num(shown, 6) + num(calls, 6) + num(`${((calls / shown) * 100).toFixed(1)}%`, 8) +
    num(total.toFixed(0), 9) + num((calls ? total / calls : 0).toFixed(1), 9) + num(((biggest.get(tool) ?? 0) / 1024).toFixed(1), 9)
  )
}

const focus = process.argv[2]
if (focus) {
  const rows = [...actions.entries()].filter(([key]) => key.startsWith(`${focus}\0`))
  if (rows.length === 0) {
    console.log(`\n${focus}: 无调用记录`)
  } else {
    console.log(`\n${focus} 的 action 分布（失败/拒绝按返回首 400 字粗判）`)
    console.log(pad('action', 18) + num('调用', 7) + num('失败', 7))
    for (const [key, calls] of rows.sort((a, b) => b[1] - a[1])) {
      console.log(pad(key.split('\0')[1], 18) + num(calls, 7) + num(actionFailure.get(key) ?? 0, 7))
    }
  }
}
