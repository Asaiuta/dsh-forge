// 打印单个会话的完整过程：user → (tool/call + 结果摘要) → assistant 文本。
// 用法：node scripts/show-session.mjs <session-id-prefix> [--args] [--result-chars N]
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

function decodeSession(file) {
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
      // 尾帧
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

const prefix = process.argv[2]
const showArgs = process.argv.includes('--args')
const resultIndex = process.argv.indexOf('--result-chars')
const resultChars = resultIndex >= 0 ? Number(process.argv[resultIndex + 1]) : 400

const root = join(homedir(), '.dsh', 'sessions', '--D-AI-VCPChat--')
const name = readdirSync(root).find((entry) => entry.startsWith(prefix))
if (name === undefined) {
  console.log(`no session matching ${prefix}`)
  process.exit(1)
}
const file = join(root, name, 'session.v4.jsonl.zstd')
if (!existsSync(file)) {
  console.log(`missing ${file}`)
  process.exit(1)
}
const events = decodeSession(file)
const toolNames = new Map()
console.log(`# ${name}`)
for (const event of events) {
  if (event.type === 'user/message') {
    console.log(`\n>>> USER\n${TEXT(event.data?.message ?? event.data)}`)
  } else if (event.type === 'assistant/message') {
    const reasoning = (event.data?.message?.content ?? [])
      .filter((part) => part?.type === 'reasoning')
      .map((part) => part.text ?? '')
      .join('\n')
    if (reasoning !== '' && showArgs) console.log(`  ~ think: ${reasoning.replace(/\s+/g, ' ').slice(0, 260)}`)
    for (const part of event.data?.message?.content ?? []) {
      if (part?.type === 'tool-call') {
        toolNames.set(part.id, part.name)
        console.log(`  → ${part.name} ${showArgs ? part.arguments : ''}`)
      }
    }
    const text = TEXT(event.data?.message)
    if (text !== '') console.log(`\n<<< ASSISTANT (chars=${text.length})\n${text}`)
  } else if (event.type === 'tool/result' && resultChars > 0) {
    const text = TEXT(event.data?.message)
    const flat = text.replace(/\s+/g, ' ').trim()
    const name2 = toolNames.get(event.data?.toolCallId) ?? '?'
    console.log(`  ← ${name2} (${text.length}B) ${flat.slice(0, resultChars)}`)
  }
}
