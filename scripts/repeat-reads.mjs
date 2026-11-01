/**
 * 重复读取：同一个会话里，同一份内容被要了两遍没有。
 *
 * 「啰嗦」和「白给」是两件事。返回再长，只要一次到位就不冤；返回再短，
 * 如果模型读完还得再要一遍，那次就是纯浪费。这个脚本量的是后者。
 *
 * 口径：
 *   read  按 (文件, 行窗口) 归组。窗口相同算完全重复；窗口重叠但不同算部分重复
 *         （同一段代码换了个 offset 再要一次）。
 *   grep  按 (模式, 路径, include) 归组，参数完全一致才算重复。
 *   第二次及以后的那几次，其返回字节计入「重复字节」。
 *
 *   node scripts/repeat-reads.mjs
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

const fileOf = (value) => {
  if (typeof value !== 'string') return undefined
  const raw = value.includes('#') ? value.slice(0, value.indexOf('#')) : value
  return raw.replaceAll('\\', '/').toLowerCase()
}

/** `L10-20` / `L10-L20` / `L10`。ff_read 的 `lines` 是字符串，不解析它就会把
 *  每次「读另一段」都当成「读同一个窗口」，凭空造出一堆假重复。 */
const parseLines = (value) => {
  if (typeof value !== 'string') return null
  const match = /^L?(\d+)(?:\s*-\s*L?(\d+))?$/i.exec(value.trim())
  if (match === null) return null
  const from = Number(match[1])
  const to = match[2] === undefined ? from : Number(match[2])
  return { from, to }
}

/** 一次 read 调用要读的文件与窗口；`symbol` 读无法比窗口，只比文件。 */
function readTargets(args) {
  const window = parseLines(args.lines)
  const out = []
  const push = (file, symbol) => {
    if (!file) return
    if (symbol !== undefined) out.push({ file, from: 0, to: 0, symbol })
    else out.push({ file, from: window?.from ?? (Number.isFinite(args.offset) ? args.offset : 1), to: window?.to ?? (Number.isFinite(args.limit) ? (Number.isFinite(args.offset) ? args.offset : 1) + args.limit - 1 : Number.MAX_SAFE_INTEGER) })
  }
  if (Array.isArray(args.targets)) {
    for (const entry of args.targets) push(fileOf(entry?.path ?? entry?.file), entry?.symbol)
    return out
  }
  if (Array.isArray(args.paths)) {
    for (const entry of args.paths) {
      const [file, symbol] = String(entry).split('#')
      push(fileOf(file), symbol)
    }
    return out
  }
  const raw = args.file_path ?? args.path
  if (typeof raw === 'string' && raw.includes('#')) {
    const [file, symbol] = raw.split('#')
    push(fileOf(file), symbol)
    return out
  }
  push(fileOf(raw), args.symbol)
  return out
}

const stats = new Map()
const bump = (key) => {
  if (!stats.has(key)) stats.set(key, { calls: 0, bytes: 0, exact: 0, overlap: 0, exactBytes: 0, overlapBytes: 0, afterTrim: 0, cleanRepeat: 0 })
  return stats.get(key)
}

let sessions = 0
const cases = process.argv.includes('--cases') ? [] : null
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
    sessions++
    const results = new Map()
    for (const event of events) {
      if (event.type !== 'tool/result') continue
      const id = event.data?.toolCallId ?? event.data?.message?.toolCallId
      if (id) results.set(id, text(event.data?.message))
    }
    // 每个会话独立的「已读窗口」表，重复只在会话内成立。
    const seen = new Map()
    // 写过但还没被重读的文件。改完之后再读一遍不是浪费，是必须的 —— 不排除它
    // 就会把「编辑后验证」算成「重复读取」，把结论引向「返回太啰嗦」这个错误方向。
    const dirty = new Set()
    for (const event of events) {
      if (event.type !== 'tool/call') continue
      const tool = event.data?.name
      if (tool === 'write' || tool === 'edit' || tool === 'ffedit' || tool === 'ff_file') {
        let args = {}
        try {
          args = JSON.parse(event.data.arguments)
        } catch {
          continue
        }
        for (const key of ['file_path', 'path', 'destination']) {
          const file = fileOf(args[key])
          if (file) dirty.add(file)
        }
        continue
      }
      if (tool !== 'read' && tool !== 'ff_read' && tool !== 'grep' && tool !== 'ffgrep') continue
      let args = {}
      try {
        args = JSON.parse(event.data.arguments)
      } catch {
        continue
      }
      const bytes = (results.get(event.data.callId) ?? '').length

      if (tool === 'read' || tool === 'ff_read') {
        // 一次调用可能带多个 path（`paths`/`targets`）。重复必须按调用判，
        // 按 path 判会把「一次多文件读」拆成 N 条并各自计满字节，凭空造重复。
        const group = bump(tool)
        group.calls++
        group.bytes += bytes
        const body = results.get(event.data.callId) ?? ''
        let hitExact = false
        let hitOverlap = false
        let trimmedBefore = false
        for (const target of readTargets(args)) {
          if (dirty.has(target.file)) {
            // 上一版内容已经被改掉，旧窗口作废。
            seen.delete(target.file)
            dirty.delete(target.file)
          }
          const windows = seen.get(target.file) ?? []
          const previous = windows.find((w) => (target.symbol !== undefined ? w.symbol === target.symbol : w.from === target.from && w.to === target.to))
          if (previous !== undefined) {
            hitExact = true
            // 第一次是不是被预算截断过？截断过的重读是「没拿全」，不算白花；
            // 没截断还要一遍才是真的重复。
            if (/trimmed to the|truncated|⚠️/.test(previous.body)) trimmedBefore = true
          } else if (target.symbol === undefined) {
            const overlap = windows.find((w) => target.from <= w.to && w.from <= target.to)
            if (overlap !== undefined) hitOverlap = true
            windows.push({ ...target, body })
            seen.set(target.file, windows)
          } else {
            windows.push({ ...target, body })
            seen.set(target.file, windows)
          }
        }
        if (hitExact) {
          group.exact++
          group.exactBytes += bytes
          if (trimmedBefore) group.afterTrim++
          else group.cleanRepeat++
          if (tool === 'ff_read' && cases !== null) {
            cases.push({ session: name.slice(8, 16), args: JSON.stringify(args).slice(0, 170), first: body, second: body, trimmed: trimmedBefore })
          }
        } else if (hitOverlap) {
          group.overlap++
          group.overlapBytes += bytes
        }
        continue
      }

      const patterns = Array.isArray(args.patterns) ? [...args.patterns].sort().join('\u0000') : String(args.pattern ?? '')
      const key = `${patterns}\0${fileOf(args.path) ?? '*'}\0${String(args.include ?? '')}`
      const group = bump(tool)
      group.calls++
      group.bytes += bytes
      const repeats = seen.get(`grep\0${key}`) ?? 0
      if (repeats > 0) {
        group.exact++
        group.exactBytes += bytes
      }
      seen.set(`grep\0${key}`, repeats + 1)
    }
  }
}

const kb = (value) => (value / 1024).toFixed(1)
const pad = (value, width) => String(value).padEnd(width)
const num = (value, width) => String(value).padStart(width)

console.log(`会话 ${sessions}`)
console.log()
console.log(pad('工具', 10) + num('调用', 6) + num('返回KB', 9) + num('重复', 6) + num('重复%', 8) + num('重复KB', 10) + num('占比', 8))
for (const tool of ['read', 'ff_read', 'grep', 'ffgrep']) {
  const row = stats.get(tool)
  if (!row) continue
  const repeats = row.exact + row.overlap
  const repeatBytes = row.exactBytes + row.overlapBytes
  console.log(
    pad(tool, 10) + num(row.calls, 6) + num(kb(row.bytes), 9) + num(repeats, 6) +
    num(`${((repeats / row.calls) * 100).toFixed(1)}%`, 8) + num(kb(repeatBytes), 10) +
    num(`${((repeatBytes / (row.bytes || 1)) * 100).toFixed(1)}%`, 8)
  )
}

const readRow = stats.get('ff_read')
const builtinRead = stats.get('read')
if (readRow || builtinRead) {
  console.log()
  console.log('read 的重复形态（完全重复 = 同一窗口再要一次；部分重复 = 换了 offset 但区间重叠）')
  for (const [tool, row] of [['read', builtinRead], ['ff_read', readRow]]) {
    if (!row) continue
    console.log(
      `  ${pad(tool, 9)} 完全 ${String(row.exact).padStart(3)} 次 / ${kb(row.exactBytes).padStart(7)} KB` +
      `   部分 ${String(row.overlap).padStart(3)} 次 / ${kb(row.overlapBytes).padStart(7)} KB`
    )
    console.log(
      `  ${pad('', 9)} └─ 完全重复里：上次被截断 ${row.afterTrim} 次，上次完整却还是要了 ${row.cleanRepeat} 次`
    )
  }
}

if (cases !== null) {
  console.log()
  console.log(`ff_read 完全重复的 ${cases.length} 个案例`)
  cases.forEach((entry, index) => {
    console.log()
    console.log(`#${index + 1} ${entry.session}  ${entry.first.length} B  上次截断=${entry.trimmed}`)
    console.log(`   args: ${entry.args}`)
    console.log(`   body: ${entry.first.replace(/\s+/g, ' ').slice(0, 180)}`)
  })
}
