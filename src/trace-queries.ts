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
  const warnings: string[] = []
  const pageSet = new Set([...defs, ...uses].flatMap((x) => pagesOf(g, x.path)))
  const perPage: string[] = []
  for (const page of [...pageSet].sort()) {
    const defPos = defs.map((d) => positionIn(g, page, d)).filter((v): v is number => v !== null)
    const usePos = uses.map((u) => ({ u, pos: positionIn(g, page, u) })).filter((x): x is { u: UseItem; pos: number } => x.pos !== null)
    const first = defPos.length ? Math.min(...defPos) : null
    perPage.push(`- \`${page}\`：定义于第 ${first ?? '—'} 个脚本 · 本页使用 ${usePos.length} 处`)
    if (usePos.length && first === null && defs.length) warnings.push(`⚠️ \`${page}\` 使用了 \`${clean}\`，但本页未加载任何定义它的脚本`)
    for (const { u, pos } of usePos) {
      if (first !== null && pos < first) {
        warnings.push(`⚠️ \`${page}\`：${loc(u)} 所在脚本（第 ${pos} 个）早于定义脚本（第 ${first} 个）加载；若在顶层同步执行会取到 undefined`)
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
    warnings.length ? `### 检查\n${capped(warnings)}` : '',
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
    capped(injected.map((x) => `- \`${x.name}\` · 第 ${x.pos ?? '?'} 个脚本 · ${loc(x)}`), 60),
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
  const text = [
    `## Trace file:${rel}`,
    `### 被页面加载（${members.length}）`,
    members.join('\n') || '- 无（主进程文件、preload 或未被任何页面引用）',
    `### 依赖（${rawDeps.length}） / 被依赖（${rawRdeps.length}）`,
    capped(rawDeps.map((d) => `- → \`${d.to}\` · L${d.line} · ${d.kind} · ${label(d)}${importNames(d.imports)}`), 20),
    capped(rawRdeps.map((d) => `- ← \`${d.path}:${d.line}\` · ${d.kind} · ${label(d)}${importNames(d.imports)}`), 20),
    `### 未解析的导入 / 路径（${unresolved.length}）`,
    capped(unresolved.map(ref => `- \`${ref.spec}\` · L${ref.line} · ${ref.reason}${ref.detail ? ' · ' + ref.detail : ''}`), 20),
    `### IPC 注册（${ipc.filter((i) => i.side === 'register').length}）`,
    capped(ipc.filter((i) => i.side === 'register').map((i) => `- ${ipcChannelLabel(i)} · ipcMain.${i.method} · L${i.line}${i.symbol ? ` · in ${i.symbol}` : ''}（${i.via}）`), 60),
    `### IPC 推送 / 直接调用（${ipc.filter((i) => i.side !== 'register').length}）`,
    capped(ipc.filter((i) => i.side !== 'register').map((i) => `- ${ipcChannelLabel(i)} · ${i.side === 'push' ? i.method : `ipcRenderer.${i.method}`} · L${i.line}${i.symbol ? ` · in ${i.symbol}` : ''}（${i.via}）`)),
    // Calls into a wrapper owned by another module. The channel is a literal
    // argument; whether it reaches ipcMain is decided by that module.
    deferred.length
      ? `### 外部包装调用（${deferred.length}）\n${capped(deferred.map((c) => `- ${c.local}('${c.channel}') · L${c.line}${c.symbol ? ` · in ${c.symbol}` : ''} · 是否 IPC 取决于 ${c.spec}`), 20)}`
      : '',
    `### preload 桥接调用（${bridge.length}）`,
    capped(bridge),
    `### 全局 定义 ${globals.length} / 使用 ${f.kind === 'js' ? f.globalsUsed.length : 0}`,
    capped(globals.map((d) => `- 定义 \`${d.name}\` · ${d.how} · L${d.line}`), 20),
    capped(f.kind === 'js' ? f.globalsUsed.map((u) => `- 使用 \`window.${u.name}\` · L${u.line}`) : [], 20),
    f.kind === 'js' && f.exposes.length ? `### exposeInMainWorld\n${f.exposes.map((e) => exposeRow(g, e)).join('\n')}` : '',
  ].filter(Boolean).join('\n')
  return { found: true, text }
}

/**
 * One exposeInMainWorld entry with its key surface and per-key consumers.
 * The preload reference surface is the union of consumers of exposed members —
 * file-dependency impact alone cannot answer "did I miss anyone using this
 * key" (real-repo A10: dozens of follow-up greps hunting one global).
 */
function exposeRow(g: TraceGraph, e: ExposeFact): string {
  const memberRefs = g.bridgeByObject.get(e.name) ?? []
  const seen = new Set<string>()
  const sites = [
    ...memberRefs.map(ref => `${ref.path}:${ref.line}`),
    ...(g.guses.get(e.name) ?? []).map(ref => `${ref.path}:${ref.line}`),
  ].filter(site => seen.has(site) ? false : (seen.add(site), true)).sort()
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

function traceExposes(g: TraceGraph, value: string): AnalysisResult {
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
  const lines = [
    `## Trace exposes:${filter}`,
    `- 共 ${selected.length} 处 · ${groups.size} 个文件 · 键用法按成员聚合；键和引用点仅反映静态可见结果，动态属性名或运行时构造可能未覆盖。路径:行 可回填 ffread / ffedit。`,
  ]
  for (const [file, items] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`### \`${file}\``)
    for (const item of items) lines.push(exposeRow(g, item))
  }
  return { found: true, text: lines.join('\n') }
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

export function trace(g: TraceGraph, kind: TraceKind, value: string, edgeMode: EdgeMode = 'all'): AnalysisResult {
  if (kind === 'ipc' || kind === 'api') return traceIpc(g, value)
  if (kind === 'global') return traceGlobal(g, value)
  if (kind === 'page') return tracePage(g, value)
  if (kind === 'impact') return traceImpact(g, value, edgeMode)
  if (kind === 'path') return tracePath(g, value, edgeMode)
  if (kind === 'ffi') return traceFfi(g.ffi, value)
  if (kind === 'exposes') return traceExposes(g, value)
  return traceFile(g, value.replace(/\\/g, '/').replace(/^\.\//, ''), edgeMode)
}
