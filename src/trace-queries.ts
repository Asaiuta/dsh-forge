/**
 * fftrace queries over an assembled TraceGraph: rendered markdown where every
 * row is a `path:line` back-reference that feeds ffedit / ff_read.
 *
 * @module dsh-forge/trace-queries
 */

import path from 'node:path'
import type { ExposeFact } from './facts.ts'
import { scriptFacts } from './facts.ts'
import { traceFfi } from './trace-native.ts'
import { traceImpact, tracePath, type AnalysisResult } from './trace-analysis.ts'
import type { EdgeEvidence, EdgeMode } from './trace-evidence.ts'
import { COMPAT_GLOBAL, type PreloadApi } from './decls.ts'
import type { BridgeItem, ExposeItem, TraceGraph, UseItem } from './linkgraph.ts'

export const TRACE_KINDS = ['ipc', 'api', 'global', 'page', 'file', 'impact', 'path', 'ffi', 'exposes'] as const
export type TraceKind = (typeof TRACE_KINDS)[number]

const LIMIT = 30

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

function loc(x: { path: string; line: number; symbol?: string }): string {
  return `\`${x.path}:${x.line}\`${x.symbol ? ` · in ${x.symbol}` : ''}`
}

function capped(list: string[], limit = LIMIT): string {
  if (!list.length) return '- 无'
  const rows = list.slice(0, limit)
  if (list.length > limit) rows.push(`- …另有 ${list.length - limit} 处`)
  return rows.join('\n')
}

function positionIn(g: TraceGraph, page: string, x: { path: string; line: number }): number | null {
  if (x.path === page) {
    let index: number | null = null
    for (const s of g.pages.get(page) ?? []) if (s.line <= x.line) index = s.index
    return index
  }
  return g.membership.get(x.path)?.get(page)?.index ?? null
}

function pagesOf(g: TraceGraph, rel: string): string[] {
  return [...new Set([...(g.pages.has(rel) ? [rel] : []), ...(g.membership.get(rel)?.keys() ?? [])])]
}

function pageSuffix(g: TraceGraph, rel: string): string {
  const ps = pagesOf(g, rel)
  if (!ps.length) return ''
  return ` · 页面：${ps.slice(0, 4).join('、')}${ps.length > 4 ? ` 等 ${ps.length} 个` : ''}`
}

function bridgeFlag(g: TraceGraph, ref: BridgeItem, api: PreloadApi): string {
  const role = g.roleByGlobal[ref.object]
  if (role) {
    return api.roles.includes(role)
      ? ''
      : ` · ⚠️ \`${ref.object}\` 属于 ${role} 角色，该 API 只对 ${api.roles.join('/')} 可见（调用得到 undefined）`
  }
  return ref.object === COMPAT_GLOBAL ? ` · 兼容层（可见角色：${api.roles.join('/')}）` : ''
}

function unboundBridgeText(refs: readonly BridgeItem[]): string {
  return refs.length > 0
    ? `### 绑定未确定的桥接站点（${refs.length}）\n${capped(refs.map(ref => `- ${loc(ref)} · \`${ref.object}.${ref.name}\` · 接收者未确定，需复查`), 20)}`
    : ''
}

function suggest(keys: Iterable<string>, q: string, limit = 10): string[] {
  const lq = String(q).toLowerCase()
  return [...keys].filter((k) => k.toLowerCase().includes(lq)).slice(0, limit)
}

function ipcChannelLabel(item: { channel: string | null; expr?: string }): string {
  return item.channel ? `\`${item.channel}\`` : `⚠️ 动态 \`${item.expr ?? '?'}\``
}

export function traceIpc(g: TraceGraph, query: string): { found: boolean; text: string } {
  const notes: string[] = []
  let channel = query
  const known = (ch: string): boolean => g.registers.has(ch) || g.apisByChannel.has(ch) || g.pushes.has(ch) || g.directCalls.has(ch)
  if (!known(channel)) {
    const api = g.apisByName.get(query)
    if (api?.channel) {
      channel = api.channel
      notes.push(`\`${query}\` 是 preload API 名，对应通道 \`${channel}\``)
    }
  }
  if (!known(channel)) {
    // No declaration file: fall back to `name: <wrapper>('channel')` pairs read
    // from source, so api: lookups work on trees that never shipped one.
    const derived = g.namedEntries.get(query)
    if (derived?.length) {
      channel = derived[0].channel
      notes.push(`\`${query}\` 是 preload 对象键（静态推导，非声明表），对应通道 \`${channel}\` · ${derived.length} 处定义`)
    }
  }
  if (!known(channel)) {
    const pool = new Set([...g.registers.keys(), ...g.apisByChannel.keys(), ...g.pushes.keys(), ...g.directCalls.keys(), ...g.apisByName.keys()])
    const near = suggest(pool, query)
    return {
      found: false,
      text: `## Trace ipc:${query}\n- 未找到该通道或 API。${near.length ? `\n- 相近的：${near.map((n) => `\`${n}\``).join('、')}` : ''}\n- 动态通道参数 ${g.dynamic.length} 处无法静态解析（fftrace file:… 可查看某文件内的具体位置）。`,
    }
  }
  const handlers = g.registers.get(channel) ?? []
  const apis = g.apisByChannel.get(channel) ?? []
  const pushes = g.pushes.get(channel) ?? []
  const direct = g.directCalls.get(channel) ?? []
  const apiBlocks = apis.map((api) => {
    const refs = g.bridgeRefs.get(api.name) ?? []
    const label = api.kind === 'subscription' ? '订阅方' : '调用方'
    return [
      `- \`${api.name}\` · ${api.kind} · 角色 ${api.roles.join('/')}（declared）`,
      `  - ${label} ${refs.length} 处：`,
      capped(refs.map((r) => `    - ${loc(r)} · via \`${r.alias ? `${r.alias}（= ${r.object}）` : r.object}\`${bridgeFlag(g, r, api)}${pageSuffix(g, r.path)}`), 20),
    ].join('\n')
  })
  const warnings: string[] = []
  const callers = apis.filter((a) => a.kind !== 'subscription').reduce((n, a) => n + (g.bridgeRefs.get(a.name) ?? []).length, 0)
    + direct.filter((d) => d.method !== 'on' && d.method !== 'once').length
  if (callers && !handlers.length) warnings.push('⚠️ 有调用方但未找到 `ipcMain` 注册（也可能经动态通道注册，见文末）')
  if (!callers && !handlers.length && apis.some((a) => a.kind !== 'subscription')) {
    warnings.push('ℹ️ preload 声明了该通道，但既没有主进程 handler 也没有调用方（疑似遗留声明）')
  }
  const handles = handlers.filter((h) => /^handle/.test(h.method))
  const listens = handlers.filter((h) => !/^handle/.test(h.method))
  if (apis.some((a) => a.kind === 'query') && handlers.length && !handles.length) warnings.push('⚠️ preload 以 invoke 调用，但主进程只有 on/once 注册，invoke 会一直等不到返回')
  if (apis.some((a) => a.kind === 'command') && handlers.length && !listens.length) warnings.push('⚠️ preload 以 send 调用，但主进程只有 handle 注册，send 不会被处理')
  if (handles.length > 1) warnings.push(`⚠️ 同一通道有 ${handles.length} 处 handle 注册（同时生效时第二次会抛错，请确认是互斥分支）`)
  if (apis.some((a) => a.kind === 'subscription') && !pushes.length) warnings.push('⚠️ 有订阅方但未找到 `webContents.send` 推送方（可能经动态通道或其他对象推送）')
  if (!callers && !direct.length && handlers.length) warnings.push('ℹ️ 未找到任何渲染端调用方（可能是死 handler，或由动态通道 / 非桥接写法调用）')
  const derivedNames = [...g.namedEntries.values()].flat().filter((n) => n.channel === channel)
  const derivedLines = derivedNames.map((n) => `- \`${n.name}\` · ${n.path}:${n.line} · 静态推导（无声明表）`)
  const preloadLines = [
    ...apiBlocks,
    ...(apiBlocks.length ? ['- 静态推导（同通道）：', ...derivedLines] : derivedLines),
  ]
  const text = [
    `## Trace ipc:${channel}`,
    ...notes.map((n) => `- ${n}`),
    `### 主进程 handler（${handlers.length}）`,
    capped(handlers.map((h) => `- ${loc(h)} · ipcMain.${h.method}（${h.via}）`)),
    `### preload 暴露（${apis.length + derivedNames.length}）`,
    preloadLines.join('\n') || (g.decls.status === 'ok' ? '- 无（该通道未进入 preload 声明表）' : `- 声明表不可用（${g.decls.status}${g.decls.error ? `：${g.decls.error}` : ''}）`),
    `### 直接 ipcRenderer 调用（${direct.length}）`,
    capped(direct.map((d) => `- ${loc(d)} · ipcRenderer.${d.method}（${d.via}）${pageSuffix(g, d.path)}`)),
    `### 推送方 webContents.send（${pushes.length}）`,
    capped(pushes.map((p) => `- ${loc(p)} · ${p.method}（${p.via}）`)),
    warnings.length ? `### 检查\n${warnings.map((w) => `- ${w}`).join('\n')}` : '',
    g.dynamic.length ? `- 全局另有 ${g.dynamic.length} 处动态通道参数无法静态解析（unresolved），不计入上表。` : '',
    unboundBridgeText(g.unboundBridge.filter(ref => apis.some(api => api.name === ref.name))),
  ].filter(Boolean).join('\n')
  return { found: true, text }
}

export function traceGlobal(g: TraceGraph, name: string): { found: boolean; text: string } {
  const clean = name.replace(/^window\./, '')
  const defs = g.gdefs.get(clean) ?? []
  const uses = g.guses.get(clean) ?? []
  if (!defs.length && !uses.length) {
    const near = suggest(new Set([...g.gdefs.keys(), ...g.guses.keys()]), clean)
    return {
      found: false,
      text: `## Trace global:${clean}\n- 未找到 \`window.${clean}\` 的定义或使用。${near.length ? `\n- 相近的：${near.map((n) => `\`${n}\``).join('、')}` : ''}`,
    }
  }
  // The per-page table already says which script defines the global on each
  // page ("定义于第 — 个脚本"), so a second ⚠️ line repeating "this page used it
  // but loaded no definer" would restate the same rows for a real repo: on
  // VCPChat, 25 pages appeared in both sections, 54% of the whole reply. The
  // miss is marked inline instead. Only the ordering hazard stays a separate
  // row — that fact exists nowhere else.
  const ordering: string[] = []
  const pageSet = new Set([...defs, ...uses].flatMap((x) => pagesOf(g, x.path)))
  const perPage: string[] = []
  for (const page of [...pageSet].sort()) {
    const defPos = defs.map((d) => positionIn(g, page, d)).filter((v): v is number => v !== null)
    const usePos = uses.map((u) => ({ u, pos: positionIn(g, page, u) })).filter((x): x is { u: UseItem; pos: number } => x.pos !== null)
    const first = defPos.length ? Math.min(...defPos) : null
    // A page that uses the global but loads no definer is a real defect, so it
    // is marked in place rather than dropped.
    const miss = usePos.length > 0 && first === null && defs.length > 0
    perPage.push(`- \`${page}\`：定义于第 ${first ?? '—'} 个脚本 · 本页使用 ${usePos.length} 处${miss ? ' · ⚠️ 本页未加载定义脚本' : ''}`)
    for (const { u, pos } of usePos) {
      if (first !== null && pos < first) {
        ordering.push(`- \`${page}\`：${loc(u)} 所在脚本（第 ${pos} 个）早于定义脚本（第 ${first} 个）加载；顶层同步执行会取到 undefined`)
      }
    }
  }
  const text = [
    `## Trace global:${clean}`,
    `### 定义（${defs.length}）`,
    capped(defs.map((d) => `- ${loc(d)} · ${d.how === 'window' ? `window.${clean} =` : `顶层 ${d.how}`}${pageSuffix(g, d.path)}`)),
    `### 使用 \`window.${clean}\`（${uses.length}，只统计显式 window./globalThis. 访问）`,
    capped(uses.map((u) => `- ${loc(u)}${pageSuffix(g, u.path)}`)),
    perPage.length ? `### 按页面\n${perPage.join('\n')}` : '',
    ordering.length ? `### ⚠️ 加载顺序风险（${ordering.length}）\n${capped(ordering)}` : '',
    !defs.length ? '- ⚠️ 未找到定义（可能由第三方库、非 window.X 写法或 module 脚本定义）' : '',
  ].filter(Boolean).join('\n')
  return { found: true, text }
}

function closure(g: TraceGraph, start: string): Set<string> {
  const seen = new Set<string>()
  const queue = [start]
  for (let next = 0; next < queue.length; next++) {
    const current = queue[next]
    if (seen.has(current)) continue
    seen.add(current)
    if (g.files.get(current)?.kind !== 'source') {
      for (const edge of g.deps.get(current) ?? []) {
        if (g.rdeps.get(edge.to)?.some(ref => ref.path === current && ref.line === edge.line && ref.kind === edge.kind)) queue.push(edge.to)
      }
    }
  }
  seen.delete(start)
  return seen
}

function findPage(g: TraceGraph, q: string): { page?: string; candidates: string[] } {
  const target = String(q).replace(/\\/g, '/').replace(/^\.\//, '')
  if (g.pages.has(target)) return { page: target, candidates: [] }
  const cands = [...g.pages.keys()].filter((p) => p.endsWith(`/${target}`) || path.posix.basename(p) === target)
  if (cands.length === 1) return { page: cands[0], candidates: [] }
  return { candidates: cands.length ? cands : suggest(g.pages.keys(), path.posix.basename(target)) }
}

export function tracePage(g: TraceGraph, q: string): { found: boolean; text: string } {
  const { page, candidates } = findPage(g, q)
  if (!page) {
    return {
      found: false,
      text: `## Trace page:${q}\n- ${candidates.length ? `未唯一确定页面，候选：${candidates.map((c) => `\`${c}\``).join('、')}` : '未找到该 HTML 页面（或页面内没有 <script>）'}`,
    }
  }
  const scripts = g.pages.get(page) ?? []
  const rows = scripts.map((s) => {
    if (s.inline) return `${s.index}. （内联${s.module ? ' module' : ''}脚本）· L${s.line}`
    if (s.external) return `${s.index}. ${s.spec} · 外部资源 · L${s.line}`
    if (s.outside) return `${s.index}. ${s.spec} · ⚠️ 越出扫描根 · L${s.line}`
    const dep = s.exists ? closure(g, s.rel!).size : 0
    return `${s.index}. \`${s.rel}\`${s.module ? ' · module' : ''} · L${s.line}${s.exists ? (dep ? ` · 依赖闭包 ${dep} 个文件` : '') : ' · ⚠️ 文件不存在'}`
  })
  const members = [...g.membership.entries()].filter(([, m]) => m.has(page)).map(([rel]) => rel)
  const memberSet = new Set([...members, page])
  const injected: Array<{ name: string; path: string; line: number; pos: number | null }> = []
  for (const [name, defs] of g.gdefs) {
    const def = defs.find((x) => memberSet.has(x.path))
    if (def) injected.push({ name, path: def.path, line: def.line, pos: positionIn(g, page, def) })
  }
  injected.sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0) || a.name.localeCompare(b.name))
  // Group by the script that injects them, and name that script once. Printing
  // "第 N 个脚本 · <path>:<line>" per global repeats one path as many times as
  // there are globals: an inline script with 18 globals spent 810 of its view's
  // 1467 chars restating a single file.
  const injectedGroups = new Map<string, typeof injected>()
  for (const item of injected) {
    const key = `${item.pos ?? '?'}|${item.path}`
    const bucket = injectedGroups.get(key)
    if (bucket) bucket.push(item)
    else injectedGroups.set(key, [item])
  }
  const injectedRows = [...injectedGroups].flatMap(([key, items]) => {
    const [pos] = key.split('|')
    // One script on the page: "第 1 个脚本" says nothing the heading does not.
    const where = injectedGroups.size === 1 ? '' : ` · 第 ${pos === '?' ? '?' : pos} 个脚本`
    return [`- \`${items[0].path}\`${where}（${items.length}）`, ...items.map((x) => `  - \`${x.name}\` L${x.line}`)]
  })
  const bridgeUsed = new Map<string, string[]>()
  const unknown: BridgeItem[] = []
  // Same alias-resolved references as ipc:/exposes:, including inline scripts.
  for (const rel of memberSet) {
    for (const b of g.bridgeByFile.get(rel) ?? []) {
      if (!g.apisByName.has(b.name) && g.decls.status === 'ok') {
        unknown.push(b)
        continue
      }
      push(bridgeUsed, b.object, b.name)
    }
  }
  const text = [
    `## Trace page:${page}`,
    `### 脚本加载顺序（${scripts.length}）`,
    rows.join('\n') || '- 无',
    `- 页面共加载 ${members.length} 个本地文件（含 require/import 闭包）。`,
    `### 页面内注入的全局（${injected.length}，按加载位置）`,
    capped(injectedRows, 60),
    `### preload 桥接使用`,
    [...bridgeUsed].map(([obj, names]) => `- \`${obj}\`：${new Set(names).size} 个 API（${names.length} 处调用）`).join('\n') || '- 无',
    unknown.length ? `### ⚠️ 调用了声明表中不存在的 API（${unknown.length}）\n${capped(unknown.map((u) => `- ${loc(u)} · \`${u.object}.${u.name}\``))}` : '',
  ].filter(Boolean).join('\n')
  return { found: true, text }
}

export function traceFile(g: TraceGraph, rel: string, edgeMode: EdgeMode = 'all'): { found: boolean; text: string } {
  const selected = <T extends { evidence: EdgeEvidence }>(edges: readonly T[]): T[] => edges.filter(edge => edgeMode === 'all' || edge.evidence.confidence === 'certain')
  const label = (edge: { evidence: EdgeEvidence }): string => `${edge.evidence.confidence}/${edge.evidence.basis}${edge.evidence.config ? ' · ' + edge.evidence.config : ''}`
  /** Import names inline, capped so wide imports cannot flood a file view. */
  const importNames = (names: readonly string[] | undefined): string =>
    !names?.length ? '' : ` · 导入 {${names.slice(0, 6).join(', ')}${names.length > 6 ? ` 等 ${names.length} 个` : ''}}`
  const f = g.files.get(rel)
  if (f?.kind === 'binary') {
    const data = f.metadata
    return { found: true, text: [
      `## Trace file:${rel}`,
      `- ${data.format} · ${data.architecture}；仅读取元数据，不加载或执行二进制。`,
      `### 导出（${data.exports.length}）`,
      capped(data.exports.map(ref => `- \`${ref.name}\` · ${ref.kind}${ref.ordinal !== undefined ? ' · ordinal ' + ref.ordinal : ''}${ref.forwarder ? ' → ' + ref.forwarder : ''}`), 30),
      `### 依赖库 / 导入模块（${data.imports.length}）`,
      capped(data.imports.map(name => `- \`${name}\``), 30),
      ...data.limitations.map(note => '- ⚠️ ' + note),
      '- 导出表不证明调用方；依赖库名未自动映射为工作区文件边。',
    ].join('\n') }
  }
  if (!f && !g.rdeps.has(rel)) {
    return { found: false, text: `## Trace file:${rel}\n- 该文件没有可提取的链路事实（或被忽略规则排除，或没有任何引用/导出/全局声明）。` }
  }
  if (!f || f.kind === 'source' || f.kind === 'manifest') {
    const deps = selected(g.deps.get(rel) ?? []), rdeps = selected(g.rdeps.get(rel) ?? [])
    const unresolved = g.unresolvedModules.filter(ref => ref.path === rel)
    return { found: true, text: [
      `## Trace file:${rel}`,
      f ? `- ${f.kind === 'manifest' ? `Go 模块 ${f.module ?? '（未解析）'}` : f.lang} 静态文件依赖；构建元数据仅读取，不执行构建命令、宏或包加载器。`
        : '- 被源码引用，内容未解析；仅展示已确认的文件依赖。',
      `### 依赖（${deps.length}） / 被依赖（${rdeps.length}）`,
      capped(deps.map(ref => `- → \`${ref.to}\` · L${ref.line} · ${ref.kind} · ${label(ref)}`), 30),
      capped(rdeps.map(ref => `- ← \`${ref.path}:${ref.line}\` · ${ref.kind} · ${label(ref)}`), 30),
      `### 未解析的导入 / 路径（${unresolved.length}）`,
      capped(unresolved.map(ref => `- \`${ref.spec}\` · L${ref.line} · ${ref.reason}${ref.detail ? ' · ' + ref.detail : ''}`), 30),
      ...(f?.kind === 'source' && f.ffi?.length ? [`### FFI 源码声明（${f.ffi.length}）`, capped(f.ffi.map(ref => `- \`${ref.name}\` · L${ref.line} · ${ref.kind}${ref.abi ? ' · ABI ' + ref.abi : ''}`), 30)] : []),
    ].join('\n') }
  }
  const ipc = f.kind === 'js' ? f.ipc : []
  const deferred = f.kind === 'js' ? f.deferredCalls : f.kind === 'html' ? f.facts?.deferredCalls ?? [] : []
  const bridge = f.kind === 'js'
    ? f.bridge.map((b) => {
      const api = g.apisByName.get(b.name)
      const tail = api
        ? ` → \`${api.channel ?? '（非 IPC）'}\` · ${api.kind}${bridgeFlag(g, { ...b, path: rel }, api)}`
        : g.decls.status === 'ok' ? ' · ⚠️ 声明表中不存在' : ''
      return `- \`${b.object}.${b.name}\` · L${b.line}${b.symbol ? ` · in ${b.symbol}` : ''}${tail}`
    })
    : []
  const members = [...(g.membership.get(rel) ?? new Map())].map(([page, m]) => `- \`${page}\` · 第 ${m.index} 个脚本${m.direct ? '（直接）' : '（经 require/import）'}`)
  const rawDeps = selected(g.deps.get(rel) ?? [])
  const rawRdeps = selected(g.rdeps.get(rel) ?? [])
  const unresolved = g.unresolvedModules.filter(ref => ref.path === rel)
  const globals = f.kind === 'js'
    ? f.globalsDefined.filter((d) => d.how === 'window' || g.classic.has(rel))
    : []
  /** The `<header>（n）` + body pair, or nothing when the section is empty.
   *
   *  A section that is empty by construction — a TypeScript file cannot register
   *  an ipcMain handler, a main-process file is not loaded by a page — prints a
   *  header and "- 无" that say only "this cannot be here". On a preload view
   *  that was four such pairs of pure noise. The count is folded into the
   *  section list line instead, so a reader still sees the zero.
   */
  const section = (heading: string, count: number, body: string): string => count > 0 ? `### ${heading}（${count}）\n${body}` : ''
  const zeroBits: string[] = []
  const zeroCount = (label: string, count: number): void => { if (count === 0) zeroBits.push(label) }
  zeroCount('被页面加载', members.length)
  zeroCount('依赖', rawDeps.length)
  zeroCount('被依赖', rawRdeps.length)
  zeroCount('未解析导入', unresolved.length)
  zeroCount('IPC 注册', ipc.filter((i) => i.side === 'register').length)
  zeroCount('IPC 调用', ipc.filter((i) => i.side !== 'register').length)
  zeroCount('桥接调用', bridge.length)
  zeroCount('全局定义', globals.length)
  zeroCount('全局使用', f.kind === 'js' ? f.globalsUsed.length : 0)
  const text = [
    `## Trace file:${rel}`,
    f ? `- ${f.kind === 'js' ? `JS · ${g.classic.has(rel) ? 'classic 脚本' : '模块'}` : f.kind === 'html' ? 'HTML' : f.kind === 'component' ? '组件' : '源码'}` : '- 内容未解析',
    ...(zeroBits.length ? [`- 无：${zeroBits.join('、')}`] : []),
    section('被页面加载', members.length, members.join('\n')),
    section('依赖 / 被依赖', rawDeps.length + rawRdeps.length, [
      ...(rawDeps.length ? [capped(rawDeps.map((d) => `- → \`${d.to}\` · L${d.line} · ${d.kind} · ${label(d)}${importNames(d.imports)}`), 20)] : []),
      ...(rawRdeps.length ? [capped(rawRdeps.map((d) => `- ← \`${d.path}:${d.line}\` · ${d.kind} · ${label(d)}${importNames(d.imports)}`), 20)] : []),
    ].join('\n')),
    section('未解析的导入 / 路径', unresolved.length, capped(unresolved.map(ref => `- \`${ref.spec}\` · L${ref.line} · ${ref.reason}${ref.detail ? ' · ' + ref.detail : ''}`), 20)),
    section('IPC 注册', ipc.filter((i) => i.side === 'register').length, capped(ipc.filter((i) => i.side === 'register').map((i) => `- ${ipcChannelLabel(i)} · ipcMain.${i.method} · L${i.line}${i.symbol ? ` · in ${i.symbol}` : ''}（${i.via}）`), 60)),
    section('IPC 推送 / 直接调用', ipc.filter((i) => i.side !== 'register').length, capped(ipc.filter((i) => i.side !== 'register').map((i) => `- ${ipcChannelLabel(i)} · ${i.side === 'push' ? i.method : `ipcRenderer.${i.method}`} · L${i.line}${i.symbol ? ` · in ${i.symbol}` : ''}（${i.via}）`))),
    // Calls into a wrapper owned by another module. The channel is a literal
    // argument; whether it reaches ipcMain is decided by that module.
    deferred.length
      ? `### 外部包装调用（${deferred.length}）\n${capped(deferred.map((c) => `- ${c.local}('${c.channel}') · L${c.line}${c.symbol ? ` · in ${c.symbol}` : ''} · 是否 IPC 取决于 ${c.spec}`), 20)}`
      : '',
    section('preload 桥接调用', bridge.length, capped(bridge)),
    unboundBridgeText(g.unboundBridge.filter(ref => ref.path === rel)),
    section('全局', globals.length + (f.kind === 'js' ? f.globalsUsed.length : 0), [
      ...(globals.length ? [capped(globals.map((d) => `- 定义 \`${d.name}\` · ${d.how} · L${d.line}`), 20)] : []),
      ...(f.kind === 'js' && f.globalsUsed.length ? [capped(f.globalsUsed.map((u) => `- 使用 \`window.${u.name}\` · L${u.line}`), 20)] : []),
    ].join('\n')),
    // Same summary row the exposes: view starts from. A preload with a wide
    // bridge printed one near-identical line per key here; the key surface is
    // still summarised, and the per-key coordinates are one
    // `exposes:<file>`/`format=detail` query away.
    f.kind === 'js' && f.exposes.length
      ? `### exposeInMainWorld\n${f.exposes.map((e) => exposeSummaryRow(g, e, true)).join('\n')}${f.exposes.some((e) => e.keys.length)
        ? `\n- 逐键消费者：\`exposes:${rel}\`（或 \`format=detail\`）`
        : ''}`
      : '',
  ].filter(Boolean).join('\n')
  return { found: true, text }
}

/** The consumer surface of one exposed global: alias-resolved member
 *  references plus bare `window.<global>` uses, deduped and grouped by file.
 *  Both views render from this one computation, so the collapsed and the
 *  expanded row can never disagree about a count. */
interface ExposeSites {
  memberRefs: BridgeItem[]
  sites: string[]
  /** Consumer files, most sites first. */
  files: Array<[string, number]>
  usedKeys: string[]
  unusedKeys: string[]
}

function exposeSites(g: TraceGraph, e: ExposeFact): ExposeSites {
  const memberRefs = g.bridgeByObject.get(e.name) ?? []
  const seen = new Set<string>()
  const sites = [
    ...memberRefs.map(ref => `${ref.path}:${ref.line}`),
    ...(g.guses.get(e.name) ?? []).map(ref => `${ref.path}:${ref.line}`),
  ].filter(site => seen.has(site) ? false : (seen.add(site), true)).sort()
  const byFile = new Map<string, number>()
  for (const site of sites) {
    const file = site.slice(0, site.lastIndexOf(':'))
    byFile.set(file, (byFile.get(file) ?? 0) + 1)
  }
  return {
    memberRefs,
    sites,
    files: [...byFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    usedKeys: e.keys.filter(key => memberRefs.some(ref => ref.name === key)),
    unusedKeys: e.keys.filter(key => !memberRefs.some(ref => ref.name === key)),
  }
}

/**
 * One exposeInMainWorld entry with its key surface and per-key consumers.
 * The preload reference surface is the union of consumers of exposed members —
 * file-dependency impact alone cannot answer "did I miss anyone using this
 * key" (real-repo A10: dozens of follow-up greps hunting one global).
 */
function exposeRow(g: TraceGraph, e: ExposeFact): string {
  const { memberRefs, sites } = exposeSites(g, e)
  const label = e.dynamic ? `\`${e.name}\`（动态名）` : `\`${e.name}\``
  const keyText = e.keys.length
    ? `${e.keys.slice(0, 12).join('、')}${e.keys.length > 12 ? ` 等 ${e.keys.length} 个` : ''}${e.partial ? '（含展开，键可能不全）' : ''}`
    : '（运行时构造，静态不可枚举）'
  const possible = e.dynamic && Object.keys(g.roleGlobals).length
    ? ` · 可能为：${Object.values(g.roleGlobals).join('、')}`
    : ''
  const head = `- ${label} · L${e.line} · 键：${keyText}${possible}${sites.length ? ` · 使用 ${sites.length} 处：${sites.slice(0, 5).map(site => `\`${site}\``).join('、')}${sites.length > 5 ? ' 等' : ''}` : ''}`
  if (e.dynamic) return head
  const rows: string[] = []
  if (e.keys.length) {
    for (const key of e.keys) {
      const refs = memberRefs.filter(ref => ref.name === key)
      if (!refs.length) continue
      const unique = [...new Set(refs.map(ref => `${ref.path}:${ref.line}`))].sort()
      rows.push(`  - \`${key}\` ×${unique.length}：${unique.slice(0, 3).map(site => `\`${site}\``).join('、')}${unique.length > 3 ? ' 等' : ''}`)
    }
    const unused = e.keys.filter(key => !memberRefs.some(ref => ref.name === key))
    if (unused.length) rows.push(`  - 未被使用（${unused.length}）：${unused.slice(0, 12).join('、')}${unused.length > 12 ? ' 等' : ''}`)
  } else if (memberRefs.length) {
    const byName = new Map<string, string[]>()
    for (const ref of memberRefs) push(byName, ref.name, `${ref.path}:${ref.line}`)
    const used = [...byName].sort(([a], [b]) => a.localeCompare(b)).map(([name, refs]) => `\`${name}\` ×${new Set(refs).size}`)
    rows.push(`  - 已使用成员（${byName.size}）：${used.slice(0, 12).join('、')}${used.length > 12 ? ' 等' : ''}`)
  }
  return [head, ...rows].join('\n')
}

/** Collapsed row: "who consumes this bridge, from where" in one line.
 *
 *  Per-key rows only carry information when a bridge has few keys spread over
 *  several consumer files. A 33-key bridge called from one file prints 33
 *  near-identical rows and repeats the key names already in the header — on
 *  VCPChat, 6 of 15 preloads accounted for most of an 18 469-character reply
 *  whose whole answer was "they call it from one file". Counts stay: only the
 *  per-key coordinates move behind `format=detail`. */
function exposeSummaryRow(g: TraceGraph, e: ExposeFact, compact = false): string {
  const { sites, files, usedKeys, unusedKeys } = exposeSites(g, e)
  const label = e.dynamic ? `\`${e.name}\`（动态名）` : `\`${e.name}\``
  const possible = e.dynamic && Object.keys(g.roleGlobals).length
    ? ` · 可能为：${Object.values(g.roleGlobals).join('、')}`
    : ''
  const parts = [
    `- ${label} · L${e.line}`,
    e.keys.length ? `键 ${e.keys.length}${e.partial ? '（含展开）' : ''} · 已用 ${usedKeys.length}` : '键运行时构造',
    sites.length
      ? `站点 ${sites.length} · 消费者 ${files.length} 文件：${files.slice(0, SUMMARY_FILES).map(([file, count]) => `\`${file}\` ×${count}`).join('、')}${files.length > SUMMARY_FILES ? ` 等 ${files.length} 个` : ''}`
      : '无消费者',
  ]
  if (unusedKeys.length) {
    parts.push(compact
      ? `未用 ${unusedKeys.length}`
      : `未用 ${unusedKeys.length}：${unusedKeys.slice(0, SUMMARY_KEYS).join('、')}${unusedKeys.length > SUMMARY_KEYS ? ' 等' : ''}`)
  }
  return parts.join(' · ') + possible
}

/** Within this budget every view is detail-or-summary; above it, the widest
 *  replies collapse. Output is re-read by every later call in the session, so
 *  an oversized reply is charged repeatedly, not once. */
const EXPOSES_BUDGET = 4_000
/** Per-key rows are worth their lines only while the bridge is this small. */
const SUMMARY_KEY_ROWS = 12
const SUMMARY_FILES = 3
const SUMMARY_KEYS = 8

export type ExposesFormat = 'auto' | 'summary' | 'detail'

/** `survey` lists every bridge on one line (per-key rows would restate each
 *  header); `filtered` expands the small bridges where per-key rows still
 *  answer something; `compact` is `survey` under budget pressure. */
type ExposesView = 'survey' | 'filtered' | 'compact' | 'detail'

const VIEW_LABEL: Record<ExposesView, string> = {
  survey: '视图：summary（每个 expose 一行；逐键站点加 format=detail 展开）',
  filtered: '视图：auto（小桥接保留逐键站点；其余每个 expose 一行，format=detail 全展开）',
  compact: '视图：compact（已压缩到预算内；未用键名单与逐键站点加 format=detail 展开）',
  detail: '视图：detail（每个 expose 的全部逐键站点）',
}

function renderExposes(g: TraceGraph, selected: readonly ExposeItem[], groups: ReadonlyMap<string, ExposeItem[]>, filter: string, view: ExposesView): string {
  const lines = [
    `## Trace exposes:${filter}`,
    `- 共 ${selected.length} 处 · ${groups.size} 个文件 · 键用法按成员聚合；键和引用点仅反映静态可见结果，动态属性名或运行时构造可能未覆盖。路径:行 可回填 ffread / ffedit。`,
  ]
  // A collapsed reply has to say it is collapsed, or the agent reads a missing
  // per-key row as "no consumer". detail stays byte-identical to the pre-change
  // render so the escape hatch — and the digest test pinning it — stay honest.
  if (view !== 'detail') lines.push(`- ${VIEW_LABEL[view]}`)
  for (const [file, items] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`### \`${file}\``)
    for (const item of items) {
      if (view === 'detail') { lines.push(exposeRow(g, item)); continue }
      if (view === 'filtered' && isSmallBridge(g, item)) { lines.push(exposeRow(g, item)); continue }
      lines.push(exposeSummaryRow(g, item, view === 'compact'))
    }
  }
  return lines.join('\n')
}

/** Whether a bridge's per-key rows still say something the counts do not. */
function isSmallBridge(g: TraceGraph, e: ExposeFact): boolean {
  const { files, usedKeys } = exposeSites(g, e)
  return usedKeys.length > 0 && usedKeys.length <= SUMMARY_KEY_ROWS && files.length <= SUMMARY_FILES
}

function traceExposes(g: TraceGraph, value: string, format: ExposesFormat = 'auto'): AnalysisResult {
  const filter = value.trim()
  const lower = filter.toLowerCase()
  const all: ExposeItem[] = []
  for (const [rel, entry] of g.files) {
    for (const expose of scriptFacts(entry)?.exposes ?? []) all.push({ ...expose, path: rel })
  }
  const selected = all.filter((item) => {
    if (lower === '' || lower === 'all' || lower === '*') return true
    if (item.name.toLowerCase() === lower) return true
    const file = item.path.toLowerCase()
    return file === lower || file.endsWith(`/${lower}`) || file.includes(lower)
  }).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  if (!selected.length) {
    const names = [...new Set(all.map(item => item.name))].slice(0, 12)
    return { found: false, text: `## Trace exposes:${filter}\n- 未找到匹配的 exposeInMainWorld（全工作区共 ${all.length} 处${names.length ? `：${names.join('、')}` : ''}）。` }
  }
  const groups = new Map<string, ExposeItem[]>()
  for (const item of selected) push(groups, item.path, item)
  // A survey names no key to inspect, so per-key rows would print every
  // bridge's whole key table: collapse it. A filtered query usually narrows to
  // one bridge, and there the per-key rows answer "did I miss a consumer".
  const survey = lower === '' || lower === 'all' || lower === '*'
  const chosen: ExposesView = format === 'detail' ? 'detail' : format === 'summary' || survey ? 'survey' : 'filtered'
  let text = renderExposes(g, selected, groups, filter, chosen)
  // A loose filter (`exposes:preload` matching every preload file) lands between
  // the two shapes, and a survey over a large repo can still run long: the
  // budget decides, not the query's spelling.
  if (chosen !== 'detail' && text.length > EXPOSES_BUDGET) text = renderExposes(g, selected, groups, filter, 'compact')
  return { found: true, text }
}

export function parseTarget(raw: string): { kind: TraceKind; value: string } | null {
  const m = /^\s*([a-z]+)\s*:\s*(.*?)\s*$/i.exec(String(raw ?? ''))
  if (!m) return null
  const kind = m[1].toLowerCase() as TraceKind
  if (!TRACE_KINDS.includes(kind)) return null
  // `exposes:` with no argument means "every preload exposure".
  if (m[2] === '' && kind !== 'exposes') return null
  return { kind, value: m[2] === '' ? 'all' : m[2] }
}

export function trace(g: TraceGraph, kind: TraceKind, value: string, edgeMode: EdgeMode = 'all', format: ExposesFormat = 'auto'): AnalysisResult {
  if (kind === 'ipc' || kind === 'api') return traceIpc(g, value)
  if (kind === 'global') return traceGlobal(g, value)
  if (kind === 'page') return tracePage(g, value)
  if (kind === 'impact') return traceImpact(g, value, edgeMode)
  if (kind === 'path') return tracePath(g, value, edgeMode)
  if (kind === 'ffi') return traceFfi(g.ffi, value)
  if (kind === 'exposes') return traceExposes(g, value, format)
  return traceFile(g, value.replace(/\\/g, '/').replace(/^\.\//, ''), edgeMode)
}
