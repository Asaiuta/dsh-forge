/**
 * dsh-forge link graph: assembles per-file facts + the preload declaration
 * table into the module / page / IPC / globals maps and answers fftrace
 * queries. Clean-room port of the graph semantics documented in the
 * ProjectForge blueprint (5.2-5.6): relative-only module resolution, page
 * membership via require/import closure, classic-script global scoping,
 * page-level bridge aliases, and confidence-labelled edges (literal / const /
 * wrapper / declared / unresolved — dynamic parameters never enter an edge).
 * v1 cuts: ffi symbols, multi-language resolvers (go/java affinity).
 *
 * @module dsh-forge/linkgraph
 */

import { statSync } from 'node:fs'
import path from 'node:path'
import type { TraceFileFacts, FileFacts, IpcFact, BridgeFact, GlobalDefFact, GlobalUseFact } from './facts.ts'
import { COMPAT_GLOBAL, DEFAULT_ROLE_GLOBALS, type PreloadApi, type PreloadDecls } from './decls.ts'

export const TRACE_KINDS = ['ipc', 'api', 'global', 'page', 'file'] as const
export type TraceKind = (typeof TRACE_KINDS)[number]

const JS_EXTS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']
const LIMIT = 30

export interface DepEdge {
  to: string
  line: number
  kind: string
}

export interface RdepEdge {
  path: string
  line: number
  kind: string
}

export type IpcItem = IpcFact & { path: string }
export type BridgeItem = BridgeFact & { path: string; alias?: string }
export type DefItem = GlobalDefFact & { path: string }
export type UseItem = GlobalUseFact & { path: string }

export interface ScriptEntry {
  index: number
  line: number
  module: boolean
  inline: boolean
  spec?: string
  rel?: string
  exists?: boolean
  external?: boolean
  outside?: boolean
}

export interface TraceGraph {
  root: string
  files: Map<string, TraceFileFacts>
  deps: Map<string, DepEdge[]>
  rdeps: Map<string, RdepEdge[]>
  unresolvedModules: Array<{ path: string; line: number; spec: string }>
  pages: Map<string, ScriptEntry[]>
  membership: Map<string, Map<string, { index: number; direct: boolean }>>
  classic: Map<string, Set<string>>
  registers: Map<string, IpcItem[]>
  pushes: Map<string, IpcItem[]>
  directCalls: Map<string, IpcItem[]>
  dynamic: IpcItem[]
  apisByName: Map<string, PreloadApi>
  apisByChannel: Map<string, PreloadApi[]>
  roleGlobals: Record<string, string>
  roleByGlobal: Record<string, string>
  bridgeRefs: Map<string, BridgeItem[]>
  unknownBridge: BridgeItem[]
  gdefs: Map<string, DefItem[]>
  guses: Map<string, UseItem[]>
  decls: PreloadDecls
  stats: { withFacts: number; pages: number }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

function makeIsFile(root: string, entries: Map<string, TraceFileFacts>): (rel: string) => boolean {
  const statCache = new Map<string, boolean>()
  return (rel: string): boolean => {
    if (entries.has(rel)) return true
    const cached = statCache.get(rel)
    if (cached !== undefined) return cached
    let ok = false
    try {
      ok = statSync(path.join(root, ...rel.split('/'))).isFile()
    } catch { ok = false }
    statCache.set(rel, ok)
    return ok
  }
}

/** Relative specifiers only — package names and `electron` never enter the graph (PF parity).
 *  Vite-style query/fragment suffixes (`./x.js?probe=1`) are stripped before
 *  resolution, matching the HTML src resolver — the real-repo eval caught
 *  this gap on VCPChat's test suite. */
function resolveSpec(fromRel: string, spec: string, isFile: (rel: string) => boolean): string | null {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null
  const clean = spec.replace(/[?#].*$/, '')
  const joined = clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(fromRel), clean)
  const base = path.posix.normalize(joined)
  if (base.startsWith('../') || base === '' || base === '.') return null
  const candidates = [base, ...JS_EXTS.map((ext) => base + ext)]
  if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`)
  candidates.push(path.posix.join(base, 'index.js'), path.posix.join(base, 'index.ts'))
  for (const candidate of candidates) if (isFile(candidate)) return candidate
  return null
}

function resolveSrc(htmlRel: string, src: string, isFile: (rel: string) => boolean): Partial<ScriptEntry> {
  let s = String(src ?? '').trim().replace(/[?#].*$/, '')
  try { s = decodeURIComponent(s) } catch { /* keep raw */ }
  if (!s || /^[a-z][a-z0-9+.-]+:/i.test(s) || s.startsWith('//')) return { external: true, spec: src }
  const joined = s.startsWith('/') ? s.slice(1) : path.posix.join(path.posix.dirname(htmlRel), s)
  const rel = path.posix.normalize(joined)
  if (rel.startsWith('../')) return { outside: true, spec: src }
  return { rel, exists: isFile(rel), spec: src }
}

export function buildGraph(root: string, entries: Map<string, TraceFileFacts>, decls: PreloadDecls): TraceGraph {
  const isFile = makeIsFile(root, entries)
  const roleGlobals = decls.roleGlobals ?? DEFAULT_ROLE_GLOBALS
  const roleByGlobal = Object.fromEntries(Object.entries(roleGlobals).map(([role, global]) => [global, role]))
  const rootGlobals = new Set([...Object.values(roleGlobals), COMPAT_GLOBAL])

  // Module graph (edge-deduplicated).
  const deps = new Map<string, DepEdge[]>()
  const rdeps = new Map<string, RdepEdge[]>()
  const unresolvedModules: Array<{ path: string; line: number; spec: string }> = []
  const edgeSeen = new Set<string>()
  for (const [rel, f] of entries) {
    if (f.kind !== 'js') continue
    for (const [kind, list] of [['require', f.requires], ['import', f.imports]] as const) {
      for (const ref of list) {
        const edgeKind = ref.dynamic ? 'dynamic_import' : kind
        const to = resolveSpec(rel, ref.spec, isFile)
        if (to) {
          const edgeKey = `${rel}->${to}:${ref.line}:${edgeKind}`
          if (edgeSeen.has(edgeKey)) continue
          edgeSeen.add(edgeKey)
          push(deps, rel, { to, line: ref.line, kind: edgeKind })
          push(rdeps, to, { path: rel, line: ref.line, kind: edgeKind })
        } else if (/^\.\.?(\/|$)/.test(ref.spec) || ref.spec.startsWith('/') || ref.dynamic) {
          unresolvedModules.push({ path: rel, line: ref.line, spec: ref.spec })
          const unresKey = `${rel}->unresolved:${ref.spec}:${ref.line}`
          if (!edgeSeen.has(unresKey)) {
            edgeSeen.add(unresKey)
            push(deps, rel, { to: ref.spec, line: ref.line, kind: ref.dynamic ? 'dynamic_import' : `${kind} (unresolved)` })
          }
        }
      }
    }
  }

  // Page graph: script order + membership via dependency closure.
  const pages = new Map<string, ScriptEntry[]>()
  const membership = new Map<string, Map<string, { index: number; direct: boolean }>>()
  const classic = new Map<string, Set<string>>()
  for (const [rel, f] of entries) {
    if (f.kind !== 'html') continue
    const scripts = f.scripts.map((s, i): ScriptEntry => {
      const base = { index: i + 1, line: s.line, module: Boolean(s.module), inline: Boolean(s.inline) }
      if (s.inline) return { ...base, rel, exists: true }
      return { ...base, ...resolveSrc(rel, s.src ?? '', isFile) }
    })
    pages.set(rel, scripts)
    for (const script of scripts) {
      if (!script.rel || !script.exists) continue
      if (!script.module && !script.inline) {
        if (!classic.has(script.rel)) classic.set(script.rel, new Set())
        classic.get(script.rel)!.add(rel)
      }
      const queue = [script.rel]
      const seen = new Set<string>()
      while (queue.length) {
        const current = queue.shift()!
        if (seen.has(current)) continue
        seen.add(current)
        if (current !== rel) {
          // Inline bodies would re-add the page as its own member — noise.
          if (!membership.has(current)) membership.set(current, new Map())
          const mine = membership.get(current)!
          if (!mine.has(rel)) mine.set(rel, { index: script.index, direct: current === script.rel })
        }
        // Only real files enter the membership closure — unresolved dynamic
        // targets (raw specs like `import(SOME_VAR)`) must not become
        // phantom members (real-repo eval caught this on VCPChat).
        for (const edge of deps.get(current) ?? []) if (isFile(edge.to)) queue.push(edge.to)
      }
    }
  }

  // IPC + bridge + globals.
  const registers = new Map<string, IpcItem[]>()
  const pushes = new Map<string, IpcItem[]>()
  const directCalls = new Map<string, IpcItem[]>()
  const dynamic: IpcItem[] = []
  const apis = decls.apis
  const apisByName = new Map(apis.map((api) => [api.name, api]))
  const apisByChannel = new Map<string, PreloadApi[]>()
  for (const api of apis) if (api.channel) push(apisByChannel, api.channel, api)
  const bridgeRefs = new Map<string, BridgeItem[]>()
  const unknownBridge: BridgeItem[] = []
  const gdefs = new Map<string, DefItem[]>()
  const guses = new Map<string, UseItem[]>()
  const pageAlias = new Map<string, Array<{ object: string; path: string }>>()
  for (const [rel, f] of entries) {
    const js: FileFacts | null = f.kind === 'js' ? f : f.facts ?? null
    if (!js) continue
    // Inline bodies merged into an HTML entry are classic-script context by
    // construction (module bodies only carry explicit window.X globals).
    const classicCtx = f.kind === 'js' ? classic.has(rel) : true
    for (const alias of js.bridgeAliases) {
      if (alias.topLevel && classicCtx) {
        push(pageAlias, alias.name, { object: alias.object, path: rel })
      }
    }
  }
  const pagesOfRel = (rel: string): Set<string> => new Set([...(pages.has(rel) ? [rel] : []), ...(membership.get(rel)?.keys() ?? [])])
  const resolveAliasRef = (fromRel: string, raw: BridgeFact): BridgeItem | null => {
    if (rootGlobals.has(raw.object)) return { ...raw, path: fromRel }
    const mine = pagesOfRel(fromRel)
    const def = (pageAlias.get(raw.object) ?? []).find((d) => d.path === fromRel || [...pagesOfRel(d.path)].some((p) => mine.has(p)))
    return def ? { ...raw, path: fromRel, alias: raw.object, object: def.object } : null
  }
  for (const [rel, f] of entries) {
    const js: FileFacts | null = f.kind === 'js' ? f : f.facts ?? null
    if (!js) continue
    const classicCtx = f.kind === 'js' ? classic.has(rel) : true
    for (const item of js.ipc) {
      const record: IpcItem = { ...item, path: rel }
      if (item.via === 'param') continue // wrapper passthrough; call sites carry the real channel
      if (item.via === 'dynamic' || !item.channel) {
        dynamic.push(record)
        continue
      }
      if (item.side === 'register') push(registers, item.channel, record)
      else if (item.side === 'push') push(pushes, item.channel, record)
      else push(directCalls, item.channel, record)
    }
    for (const raw of js.bridge) {
      const resolved = resolveAliasRef(rel, raw)
      if (!resolved) continue
      if (apisByName.has(resolved.name)) push(bridgeRefs, resolved.name, resolved)
      else if (decls.status === 'ok') unknownBridge.push(resolved)
    }
    for (const def of js.globalsDefined) {
      // window.X is always a global; bare top-level declarations only in
      // classic <script> files (modules are scoped, PF parity). Inline
      // bodies merged into an HTML entry are classic context by construction.
      if (def.how === 'window' || classicCtx) push(gdefs, def.name, { ...def, path: rel })
    }
    for (const use of js.globalsUsed) push(guses, use.name, { ...use, path: rel })
  }

  return {
    root, files: entries, deps, rdeps, unresolvedModules, pages, membership, classic,
    registers, pushes, directCalls, dynamic, apisByName, apisByChannel, roleGlobals, roleByGlobal,
    bridgeRefs, unknownBridge, gdefs, guses, decls,
    stats: { withFacts: entries.size, pages: pages.size },
  }
}

// ---------------------------------------------------------------------------
// Trace queries (rendered markdown; every row is a `path:line` back-reference)
// ---------------------------------------------------------------------------

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
  const text = [
    `## Trace ipc:${channel}`,
    ...notes.map((n) => `- ${n}`),
    `### 主进程 handler（${handlers.length}）`,
    capped(handlers.map((h) => `- ${loc(h)} · ipcMain.${h.method}（${h.via}）`)),
    `### preload 暴露（${apis.length}）`,
    apiBlocks.join('\n') || (g.decls.status === 'ok' ? '- 无（该通道未进入 preload 声明表）' : `- 声明表不可用（${g.decls.status}${g.decls.error ? `：${g.decls.error}` : ''}）`),
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
  while (queue.length) {
    const current = queue.shift()!
    if (seen.has(current)) continue
    seen.add(current)
    for (const edge of g.deps.get(current) ?? []) queue.push(edge.to)
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
  for (const rel of memberSet) {
    const f = g.files.get(rel)
    if (f?.kind !== 'js') continue
    for (const b of f.bridge) {
      const api = g.apisByName.get(b.name)
      if (!api) {
        if (g.decls.status === 'ok') unknown.push({ ...b, path: rel })
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

export function traceFile(g: TraceGraph, rel: string): { found: boolean; text: string } {
  const f = g.files.get(rel)
  if (!f) {
    return { found: false, text: `## Trace file:${rel}\n- 该文件没有可提取的链路事实（或被忽略规则排除，或没有任何引用/导出/全局声明）。` }
  }
  const ipc = f.kind === 'js' ? f.ipc : []
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
  const rawDeps = g.deps.get(rel) ?? []
  const rawRdeps = g.rdeps.get(rel) ?? []
  const globals = f.kind === 'js'
    ? f.globalsDefined.filter((d) => d.how === 'window' || g.classic.has(rel))
    : []
  const text = [
    `## Trace file:${rel}`,
    `### 被页面加载（${members.length}）`,
    members.join('\n') || '- 无（主进程文件、preload 或未被任何页面引用）',
    `### 依赖（${rawDeps.length}） / 被依赖（${rawRdeps.length}）`,
    capped(rawDeps.map((d) => `- → \`${d.to}\` · L${d.line} · ${d.kind}`), 20),
    capped(rawRdeps.map((d) => `- ← \`${d.path}:${d.line}\` · ${d.kind}`), 20),
    `### IPC 注册（${ipc.filter((i) => i.side === 'register').length}）`,
    capped(ipc.filter((i) => i.side === 'register').map((i) => `- ${ipcChannelLabel(i)} · ipcMain.${i.method} · L${i.line}${i.symbol ? ` · in ${i.symbol}` : ''}（${i.via}）`), 60),
    `### IPC 推送 / 直接调用（${ipc.filter((i) => i.side !== 'register').length}）`,
    capped(ipc.filter((i) => i.side !== 'register').map((i) => `- ${ipcChannelLabel(i)} · ${i.side === 'push' ? i.method : `ipcRenderer.${i.method}`} · L${i.line}${i.symbol ? ` · in ${i.symbol}` : ''}（${i.via}）`)),
    `### preload 桥接调用（${bridge.length}）`,
    capped(bridge),
    `### 全局 定义 ${globals.length} / 使用 ${f.kind === 'js' ? f.globalsUsed.length : 0}`,
    capped(globals.map((d) => `- 定义 \`${d.name}\` · ${d.how} · L${d.line}`), 20),
    capped(f.kind === 'js' ? f.globalsUsed.map((u) => `- 使用 \`window.${u.name}\` · L${u.line}`) : [], 20),
    f.kind === 'js' && f.exposes.length ? `### exposeInMainWorld\n${f.exposes.map((e) => `- \`${e.name}\` · L${e.line} · 键：${e.keys.join('、') || '（非字面量对象）'}`).join('\n')}` : '',
  ].filter(Boolean).join('\n')
  return { found: true, text }
}

export function parseTarget(raw: string): { kind: TraceKind; value: string } | null {
  const m = /^\s*([a-z]+)\s*:\s*(.+?)\s*$/i.exec(String(raw ?? ''))
  if (!m) return null
  const kind = m[1].toLowerCase() as TraceKind
  if (!TRACE_KINDS.includes(kind)) return null
  return { kind, value: m[2] }
}

export function trace(g: TraceGraph, kind: TraceKind, value: string): { found: boolean; text: string } {
  if (kind === 'ipc' || kind === 'api') return traceIpc(g, value)
  if (kind === 'global') return traceGlobal(g, value)
  if (kind === 'page') return tracePage(g, value)
  return traceFile(g, value.replace(/\\/g, '/').replace(/^\.\//, ''))
}
