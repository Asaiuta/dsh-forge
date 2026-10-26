/** Bounded, evidence-carrying queries over the existing static file graph. */
import path from 'node:path'
import type { TraceGraph } from './linkgraph.ts'
import type { FfiAnalysis } from './trace-native.ts'
import type { EdgeEvidence, EdgeMode } from './trace-evidence.ts'

export interface DependencyStep { from: string; to: string; line: number; kind: string; evidence: EdgeEvidence; imports?: string[] }
export interface DependencyAnalysis {
  kind: 'impact' | 'path'
  edgeMode: EdgeMode
  source: string
  destination?: string
  /** Traversal completed within its budget; scan coverage is reported separately. */
  complete: boolean
  visitedFiles: number
  /** impact excludes the source; path includes both endpoints when found. */
  totalFiles: number
  totalPages: number
  distance?: number
  /** Includes display truncation; complete can remain true when only rows are capped. */
  truncated: boolean
  files: Array<{ path: string; depth: number }>
  edges: DependencyStep[]
  pages: string[]
}
export interface AnalysisResult { found: boolean; text: string; analysis?: DependencyAnalysis; ffi?: FfiAnalysis }

const NODE_CAP = 20_000
const EDGE_CAP = 200_000
const ROW_CAP = 100
const TEXT_ROWS = 30

export function normalizeTraceFile(root: string, value: string): string | null {
  if (!value.trim() || value.includes('\0')) return null
  const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, ...value.split(/[\\/]+/))
  const relative = path.relative(root, absolute).split(path.sep).join('/')
  return relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative) ? relative : null
}

export function parseDependencyPath(value: string): [string, string] | null {
  const parts = value.split(/\s+->\s+/)
  return parts.length === 2 && parts.every(part => part.trim()) ? [parts[0].trim(), parts[1].trim()] : null
}

interface QueryGraph {
  forward: Map<string, DependencyStep[]>
  reverse: Map<string, DependencyStep[]>
  complete: boolean
}
// Assembled graphs are immutable during queries; a new assembly gets its own
// index. Weak ownership avoids keeping evicted workspaces alive.
const INDEX_CACHE = new WeakMap<TraceGraph, Map<EdgeMode, QueryGraph>>()
function queryGraph(graph: TraceGraph, edgeMode: EdgeMode): QueryGraph {
  const cached = INDEX_CACHE.get(graph)?.get(edgeMode)
  if (cached) return cached
  const forward = new Map<string, DependencyStep[]>(), reverse = new Map<string, DependencyStep[]>()
  let count = 0, complete = true
  const add = (step: DependencyStep): boolean => {
    if (++count > EDGE_CAP) { complete = false; return false }
    const outgoing = forward.get(step.from) ?? []
    if (!forward.has(step.from)) forward.set(step.from, outgoing)
    outgoing.push(step)
    const incoming = reverse.get(step.to) ?? []
    if (!reverse.has(step.to)) reverse.set(step.to, incoming)
    incoming.push(step)
    return true
  }
  // Only rdeps contains confirmed targets. deps also retains raw unresolved
  // expressions, which must never become a path or an affected file.
  outer: for (const [to, refs] of graph.rdeps) {
    for (const ref of refs) {
      if (edgeMode === 'certain' && ref.evidence.confidence !== 'certain') continue
      if (!add({ from: ref.path, to, line: ref.line, kind: ref.kind, evidence: ref.evidence, ...(ref.imports?.length ? { imports: ref.imports } : {}) })) break outer
    }
  }
  if (complete) outer: for (const [page, scripts] of graph.pages) {
    for (const script of scripts) {
      if (script.inline || !script.exists || !script.rel || script.outside || script.external) continue
      if (!add({ from: page, to: script.rel, line: script.line, kind: 'html_script', evidence: { confidence: 'certain', basis: 'html_script' } })) break outer
    }
  }
  const result = { forward, reverse, complete }
  let modes = INDEX_CACHE.get(graph)
  if (!modes) INDEX_CACHE.set(graph, modes = new Map())
  modes.set(edgeMode, result)
  return result
}

const FILE_CACHE = new WeakMap<TraceGraph, Map<string, string>>()
function knownFile(g: TraceGraph, file: string | null): string | null {
  if (!file) return null
  let files = FILE_CACHE.get(g)
  const key = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
  if (!files) {
    files = new Map()
    for (const name of [...g.files.keys(), ...g.rdeps.keys()]) if (!files.has(key(name))) files.set(key(name), name)
    for (const scripts of g.pages.values()) for (const script of scripts) {
      if (script.rel && script.exists && !script.outside && !script.external && !files.has(key(script.rel))) files.set(key(script.rel), script.rel)
    }
    FILE_CACHE.set(g, files)
  }
  return files.get(key(file)) ?? null
}
const row = (edge: DependencyStep): string => `- \`${edge.from}:${edge.line}\` → \`${edge.to}\` · ${edge.kind} · ${edge.evidence.confidence}/${edge.evidence.basis}${edge.evidence.config ? ' · ' + edge.evidence.config : ''}${edge.imports?.length ? ` · 导入 {${edge.imports.slice(0, 6).join(', ')}${edge.imports.length > 6 ? ` 等 ${edge.imports.length} 个` : ''}}` : ''}`

export function traceImpact(graph: TraceGraph, value: string, edgeMode: EdgeMode = 'all'): AnalysisResult {
  const source = knownFile(graph, normalizeTraceFile(graph.root, value))
  if (!source) return { found: false, text: `## Trace impact:${value}\n- 未找到已分析的文件或被源码引用的资源。` }
  const index = queryGraph(graph, edgeMode)
  const queue = [source], depths = new Map([[source, 0]]), edges: DependencyStep[] = []
  let complete = index.complete
  outer: for (let next = 0; next < queue.length; next++) {
    const current = queue[next]
    for (const edge of index.reverse.get(current) ?? []) {
      if (depths.has(edge.from)) continue
      if (depths.size >= NODE_CAP) { complete = false; break outer }
      depths.set(edge.from, depths.get(current)! + 1)
      queue.push(edge.from)
      edges.push(edge)
    }
  }
  const files = queue.slice(1).map(file => ({ path: file, depth: depths.get(file)! }))
  const pages = queue.filter(file => graph.pages.has(file))
  const analysis: DependencyAnalysis = {
    kind: 'impact', edgeMode, source, complete, visitedFiles: depths.size, totalFiles: files.length, totalPages: pages.length,
    truncated: !complete || files.length > ROW_CAP || pages.length > ROW_CAP,
    files: files.slice(0, ROW_CAP), edges: edges.slice(0, ROW_CAP), pages: pages.slice(0, ROW_CAP),
  }
  return { found: true, analysis, text: [
    `## Trace impact:${source}`,
    `- 沿静态文件引用反向遍历，包含 HTML script 引用；${edgeMode === 'certain' ? '仅遍历确定的文件边' : '包含候选边并保留标记'}，不表示运行时必定受影响。`,
    `### 传递引用者（${files.length}${complete ? '' : '，范围受限'}）`,
    ...files.slice(0, TEXT_ROWS).map(file => `- \`${file.path}\` · 距离 ${file.depth}`),
    ...(!files.length ? ['- 无'] : []),
    ...(files.length > TEXT_ROWS ? [`- 另有 ${files.length - TEXT_ROWS} 个引用者；结构化结果最多返回 ${ROW_CAP} 项。`] : []),
    `### 受影响页面（${pages.length}，静态引用）`,
    ...pages.slice(0, TEXT_ROWS).map(page => `- \`${page}\``),
    ...(!pages.length ? ['- 无'] : []),
    `### 引用证据（每个引用者保留一条${complete ? '最短反向路径' : '反向路径'}的父边）`,
    ...edges.slice(0, TEXT_ROWS).map(row),
    ...(!edges.length ? ['- 无'] : []),
    ...(!complete ? ['- ⚠️ 达到图遍历预算，结果仅覆盖已遍历范围。'] : []),
  ].join('\n') }
}

export function tracePath(graph: TraceGraph, value: string, edgeMode: EdgeMode = 'all'): AnalysisResult {
  const pair = parseDependencyPath(value)
  if (!pair) return { found: false, text: `## Trace path:${value}\n- 需要 path:源文件 -> 目标文件（箭头两侧留空格）。` }
  const source = knownFile(graph, normalizeTraceFile(graph.root, pair[0])), destination = knownFile(graph, normalizeTraceFile(graph.root, pair[1]))
  if (!source || !destination) {
    return { found: false, text: `## Trace path:${value}\n- 两端均需为扫描根内已分析的文件或被源码引用的资源。` }
  }
  const index = source === destination ? { forward: new Map<string, DependencyStep[]>(), complete: true } : queryGraph(graph, edgeMode)
  const queue = [source], seen = new Set([source]), parent = new Map<string, DependencyStep>()
  let complete = index.complete
  outer: for (let next = 0; next < queue.length && !seen.has(destination); next++) {
    for (const edge of index.forward.get(queue[next]) ?? []) {
      if (seen.has(edge.to)) continue
      if (seen.size >= NODE_CAP) { complete = false; break outer }
      seen.add(edge.to)
      parent.set(edge.to, edge)
      queue.push(edge.to)
      if (edge.to === destination) break outer
    }
  }
  const found = seen.has(destination), steps: DependencyStep[] = []
  if (found) {
    for (let current = destination; current !== source;) {
      const edge = parent.get(current)!
      steps.push(edge)
      current = edge.from
    }
    steps.reverse()
  }
  const files = found ? [source, ...steps.map(edge => edge.to)] : []
  const pages = files.filter(file => graph.pages.has(file))
  const analysis: DependencyAnalysis = {
    kind: 'path', edgeMode, source, destination, complete, visitedFiles: seen.size, totalFiles: files.length, totalPages: pages.length,
    ...(found ? { distance: steps.length } : {}), truncated: !complete || files.length > ROW_CAP,
    files: files.slice(0, ROW_CAP).map((file, depth) => ({ path: file, depth })), edges: steps.slice(0, ROW_CAP), pages: pages.slice(0, ROW_CAP),
  }
  return { found, analysis, text: [
    `## Trace path:${source} -> ${destination}`,
    `- 沿已解析的静态依赖和 HTML script 引用；${edgeMode === 'certain' ? '已排除候选边' : '包含候选边并保留标记'}，不表示函数调用链。`,
    ...(found ? [
      `### ${complete ? '最短依赖路径' : '依赖路径（预算受限，未证明最短）'}（${steps.length} 跳）`,
      ...steps.slice(0, TEXT_ROWS).map(row),
      ...(!steps.length ? ['- 起点与终点相同（0 跳）。'] : []),
      ...(steps.length > TEXT_ROWS ? [`- 另有 ${steps.length - TEXT_ROWS} 跳；结构化结果最多返回 ${ROW_CAP} 条边。`] : []),
    ] : [`- ${complete ? '已分析的静态图中没有依赖路径。' : '在遍历预算内未找到路径，不能判定不可达。'}`]),
    ...(!complete ? ['- ⚠️ 达到图遍历预算，结果仅覆盖已遍历范围。'] : []),
  ].join('\n') }
}
