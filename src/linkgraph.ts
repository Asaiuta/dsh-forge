/**
 * dsh-forge link graph: assembles per-file facts + the preload declaration
 * table into the module / page / IPC / globals maps and answers fftrace
 * queries. Clean-room port of the graph semantics documented in the
 * ProjectForge blueprint (5.2-5.6): static module resolution, page
 * membership via require/import closure, classic-script global scoping,
 * page-level bridge aliases, and confidence-labelled edges (literal / const /
 * wrapper / declared / unresolved — dynamic parameters never enter an edge).
 * Additional languages add conservative module candidates. FFI queries keep
 * source boundary declarations separate from binary export metadata.
 *
 * @module dsh-forge/linkgraph
 */

import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import type { TraceFileFacts, IpcFact, BridgeFact, GlobalDefFact, GlobalUseFact, WrapperFact, NamedEntryFact, ExposeFact } from './facts.ts'
import { jsReferences, scriptFacts } from './facts.ts'
import { sourceResolver } from './source-resolution.ts'
import { indexFfi, traceFfi, type FfiMatch } from './trace-native.ts'
import type { IncludeResolver } from './compile-commands.ts'
import { traceImpact, tracePath, type AnalysisResult } from './trace-analysis.ts'
import { jsFile, relativeJs } from './js-resolution.ts'
import type { EdgeEvidence, EdgeMode, JsResolver, UnresolvedModule } from './trace-evidence.ts'
export { traceImpact, tracePath, normalizeTraceFile, parseDependencyPath } from './trace-analysis.ts'
import { COMPAT_GLOBAL, DEFAULT_ROLE_GLOBALS, type PreloadApi, type PreloadDecls } from './decls.ts'

export const TRACE_KINDS = ['ipc', 'api', 'global', 'page', 'file', 'impact', 'path', 'ffi', 'exposes'] as const
export type TraceKind = (typeof TRACE_KINDS)[number]

const LIMIT = 30

export interface DepEdge {
  to: string
  line: number
  kind: string
  evidence: EdgeEvidence
  /** Names this file imports from the target (namespace bindings as *local). */
  imports?: string[]
}

export interface RdepEdge {
  path: string
  line: number
  kind: string
  evidence: EdgeEvidence
  imports?: string[]
}

export type IpcItem = IpcFact & { path: string }
export type BridgeItem = BridgeFact & { path: string; alias?: string }
export type DefItem = GlobalDefFact & { path: string }
export type UseItem = GlobalUseFact & { path: string }
export type NamedItem = NamedEntryFact & { path: string }
export type ExposeItem = ExposeFact & { path: string }

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
  unresolvedModules: UnresolvedModule[]
  pages: Map<string, ScriptEntry[]>
  membership: Map<string, Map<string, { index: number; direct: boolean }>>
  classic: Map<string, Set<string>>
  registers: Map<string, IpcItem[]>
  pushes: Map<string, IpcItem[]>
  directCalls: Map<string, IpcItem[]>
  dynamic: IpcItem[]
  apisByName: Map<string, PreloadApi>
  apisByChannel: Map<string, PreloadApi[]>
  /** `name: <wrapper>('channel')` entries derived from source (no declaration file needed). */
  namedEntries: Map<string, NamedItem[]>
  roleGlobals: Record<string, string>
  roleByGlobal: Record<string, string>
  bridgeRefs: Map<string, BridgeItem[]>
  /** Bridge references grouped by resolved window object — no decls table needed. */
  bridgeByObject: Map<string, BridgeItem[]>
  /** Alias-resolved bridge references per file (HTML entries carry inline scripts). */
  bridgeByFile: Map<string, BridgeItem[]>
  unknownBridge: BridgeItem[]
  gdefs: Map<string, DefItem[]>
  guses: Map<string, UseItem[]>
  decls: PreloadDecls
  ffi?: Map<string, FfiMatch[]>
  resolutionLimited?: true
  stats: { withFacts: number; pages: number }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

function makeIsFile(root: string, entries: Map<string, TraceFileFacts>, onProbe?: (rel: string, exists: boolean, identity: string | null) => void): (rel: string) => boolean {
  const statCache = new Map<string, boolean>()
  return (rel: string): boolean => {
    // Discovery already validates scanned files and the physical root for
    // each assembly. Only references outside that candidate set need extra
    // existence/link probes (assets, ignored files and junction paths).
    if (entries.has(rel)) return true
    const cached = statCache.get(rel)
    if (cached !== undefined) return cached
    let ok = false
    const absolute = path.join(root, ...rel.split('/'))
    try { ok = statSync(absolute, { throwIfNoEntry: false })?.isFile() ?? false } catch { ok = false }
    let identity: string | null = null
    if (ok && onProbe) { try { identity = realpathSync(absolute) } catch { ok = false } }
    statCache.set(rel, ok)
    onProbe?.(rel, ok, identity)
    return ok
  }
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

/** Workspace-wide dotted const strings (capped): cross-file preload wiring lookup. */
function constStringsOf(entries: Map<string, TraceFileFacts>): Map<string, string> {
  const index = new Map<string, string>()
  for (const entry of entries.values()) {
    const consts = scriptFacts(entry)?.constStrings
    if (!consts) continue
    for (const [name, value] of Object.entries(consts)) {
      if (index.size >= 20_000) return index
      if (!index.has(name)) index.set(name, value)
    }
  }
  return index
}

/**
 * Role → page-global names recovered from `ROLE_GLOBALS.<role> = 'name'` const
 * strings (VCPChat-style preload registries). Lets bridge usages and exposes
 * resolve without a hand-written declarations file.
 */
export function deriveRoleGlobals(entries: Map<string, TraceFileFacts>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of entries.values()) {
    const consts = scriptFacts(entry)?.constStrings
    if (!consts) continue
    for (const [key, value] of Object.entries(consts)) {
      if (!key.startsWith('ROLE_GLOBALS.')) continue
      const role = key.slice('ROLE_GLOBALS.'.length)
      if (role && /^[A-Za-z_$][\w$]*$/.test(value) && !(role in out)) out[role] = value
    }
  }
  return out
}

/**
 * Literal global names passed to `contextBridge.exposeInMainWorld`. Standalone
 * preloads (chartAPI, loomAPI, …) need no role table to be a bridge root.
 */
export function exposedGlobalsOf(entries: Map<string, TraceFileFacts>): string[] {
  const names = new Set<string>()
  for (const entry of entries.values()) {
    for (const expose of scriptFacts(entry)?.exposes ?? []) {
      if (!expose.dynamic) names.add(expose.name)
    }
  }
  return [...names]
}

/**
 * Resolve a preload wiring spec to a scanned JS file. Path-like specs try
 * file-relative then root-relative; bare role tokens try the preloads/<role>.js
 * convention (Electron projects overwhelmingly keep preloads in that dir).
 * A miss stays edgeless — never a phantom node.
 */
function preloadTarget(from: string, spec: string, isFile: (file: string) => boolean): string | null {
  const clean = spec.replaceAll('\\', '/').replace(/[?#].*$/, '')
  if (!clean || clean.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null
  const fromDir = path.posix.dirname(from)
  const pathlike = clean.includes('/') || /\.(?:[cm]?js|jsx)$/.test(clean)
  const bases = pathlike
    ? [path.posix.join(fromDir, clean), clean]
    : [path.posix.join(fromDir, `${clean}.js`), path.posix.join(fromDir, 'preloads', `${clean}.js`), `${clean}.js`, path.posix.join('preloads', `${clean}.js`)]
  for (const base of bases) {
    const normalized = path.posix.normalize(base)
    if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) continue
    const to = jsFile(normalized, isFile)
    if (to && /\.(?:[cm]?js|jsx)$/.test(to)) return to
  }
  return null
}

export function buildGraph(root: string, entries: Map<string, TraceFileFacts>, decls: PreloadDecls, onProbe?: (rel: string, exists: boolean, identity?: string | null) => void, includeResolver?: IncludeResolver, jsResolver: JsResolver = relativeJs): TraceGraph {
  const isFile = makeIsFile(root, entries, onProbe)
  const entryKeys = new Map<string, string>()
  const graphKey = (value: string): string => {
    const clean = value.replaceAll('\\', '/').replace(/^\.\//, '')
    return process.platform === 'win32' ? clean.toLowerCase() : clean
  }
  for (const key of entries.keys()) entryKeys.set(graphKey(key), key)
  // Windows file systems resolve case-insensitively, while the scanner keeps
  // the spelling returned by readdir. Reuse that spelling for graph nodes so
  // compile_commands entries such as `SRC/MAIN.CPP` cannot create a phantom
  // `SRC`/`src` split in deps/rdeps.
  const normalizeTarget = (value: string): string => {
    const key = graphKey(value)
    const existing = entryKeys.get(key)
    if (existing) return existing
    entryKeys.set(key, value)
    return value
  }
  const constIndex = constStringsOf(entries)
  const roleGlobals = { ...DEFAULT_ROLE_GLOBALS, ...deriveRoleGlobals(entries), ...(decls.roleGlobals ?? {}) }
  const roleByGlobal = Object.fromEntries(Object.entries(roleGlobals).map(([role, global]) => [global, role]))
  const rootGlobals = new Set([...Object.values(roleGlobals), COMPAT_GLOBAL, ...exposedGlobalsOf(entries)])

  // Module graph (edge-deduplicated).
  const deps = new Map<string, DepEdge[]>()
  const resolvedDeps = new Map<string, DepEdge[]>()
  const inlineDeps = new Map<string, Map<number, DepEdge[]>>()
  const rdeps = new Map<string, RdepEdge[]>()
  const unresolvedModules: UnresolvedModule[] = []
  const edgeSeen = new Set<string>()
  let resolutionLimited = false
  const resolveSource = sourceResolver({ entries, isFile, includeResolver, onLimit: () => { resolutionLimited = true } })
  const virtual = new Map<string, string[]>()
  for (const [file, entry] of entries) for (const module of scriptFacts(entry)?.ambientModules ?? []) {
    const files = virtual.get(module.name) ?? []
    if (!files.includes(file)) files.push(file)
    virtual.set(module.name, files)
  }
  for (const [rel, f] of entries) {
    if (f.kind === 'source') {
      for (const ref of f.modules) {
        const result = resolveSource(rel, ref)
        if (result.status !== 'resolved') {
          if (result.status === 'unresolved') unresolvedModules.push({ path: rel, line: ref.line, spec: ref.spec, reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) })
          continue
        }
        for (const target of result.targets) {
          const normalizedTarget = normalizeTarget(target.to)
          if (ref.kind === 'java_type' && normalizedTarget === rel) continue
          const kind = ref.kind + ('role' in ref ? ':' + ref.role : '') + (target.candidate ? ref.kind === 'python_from' ? ' (submodule candidate)' : ' (module candidate)' : '')
          const evidence: EdgeEvidence = { confidence: target.candidate ? 'candidate' : 'certain', basis: ref.kind }
          const key = `${rel}->${normalizedTarget}:${ref.line}:${kind}`
          if (edgeSeen.has(key)) continue
          edgeSeen.add(key)
          const edge = { to: normalizedTarget, line: ref.line, kind, evidence }
          push(deps, rel, edge)
          push(resolvedDeps, rel, edge)
          push(rdeps, normalizedTarget, { path: rel, line: ref.line, kind, evidence })
        }
      }
      continue
    }
    if (f.kind !== 'js' && f.kind !== 'html' && f.kind !== 'component') continue
    // Imported names per specifier: the question "who uses which of my exports"
    // is answerable without re-reading every dependent.
    const bindings = scriptFacts(f)?.bindings ?? []
    const importedNames = (spec: string): string[] | undefined => {
      const names = bindings.filter(binding => binding.spec === spec)
        .map(binding => binding.imported ?? '*' + binding.local)
      return names.length ? [...new Set(names)] : undefined
    }
    for (const { mode, ref, syntax } of jsReferences(f)) {
      const edgeKind = ref.dynamic ? 'dynamic_import' : mode
      const imports = ref.unresolved ? undefined : importedNames(ref.spec)
      // An expression such as `import(/regex/.source)` is retained as an
      // unresolved fact for diagnostics, but its source text must never be
      // interpreted as a file path merely because a matching file exists.
      const declared = virtual.get(ref.spec)
      const resolution = ref.unresolved ? { status: 'unresolved' as const, reason: 'non_literal' as const }
        : declared ? declared.length === 1 ? { status: 'resolved' as const, targets: [{ to: declared[0], evidence: { confidence: 'candidate' as const, basis: 'ambient_module' } }] }
          : { status: 'unresolved' as const, reason: 'ambiguous_target' as const, detail: '多个文件声明同名 ambient module。' }
        : jsResolver(rel, ref.spec, ref.dynamic ? 'dynamic_import' : mode, isFile, syntax)
      if (resolution.status === 'resolved') for (const target of resolution.targets) {
        const normalizedTarget = normalizeTarget(target.to)
        const edge = { to: normalizedTarget, line: ref.line, kind: edgeKind, evidence: target.evidence, ...(imports ? { imports } : {}) }
        if (f.kind === 'html' && ref.scriptIndex !== undefined) {
          let scripts = inlineDeps.get(rel)
          if (!scripts) inlineDeps.set(rel, scripts = new Map())
          push(scripts, ref.scriptIndex, edge)
        }
        const edgeKey = JSON.stringify([rel, normalizedTarget, ref.line, edgeKind, target.evidence])
        if (edgeSeen.has(edgeKey)) continue
        edgeSeen.add(edgeKey)
        push(deps, rel, edge)
        push(resolvedDeps, rel, edge)
        push(rdeps, normalizedTarget, { path: rel, line: ref.line, kind: edgeKind, evidence: target.evidence, ...(imports ? { imports } : {}) })
      } else {
        const { status: _status, ...failure } = resolution
        unresolvedModules.push({ path: rel, line: ref.line, spec: ref.spec, ...failure })
        // Keep the historical unresolved rows for local/dynamic references;
        // external packages are diagnostics, never phantom file edges.
        if (resolution.reason === 'external_package') continue
        const unresKey = `${rel}->unresolved:${ref.spec}:${ref.line}`
        if (!edgeSeen.has(unresKey)) {
          edgeSeen.add(unresKey)
          push(deps, rel, { to: ref.spec, line: ref.line, kind: ref.dynamic ? 'dynamic_import' : `${mode} (unresolved)`, evidence: { confidence: 'candidate', basis: 'unresolved' } })
        }
      }
    }
    // Structural preload wiring edges (see PreloadFact) — these close the
    // impact: gap for preloads/, which require/import graphs can never see.
    // External-ref names retry through every file's exported const table:
    // `const { PRELOAD_ROLES } = require(...)` hides the defining table from
    // the referencing file (real-repo A10).
    for (const fact of scriptFacts(f)?.preloads ?? []) {
      const spec = fact.externalRef ? constIndex.get(fact.spec) ?? null : fact.spec
      if (spec === null) continue
      const to = preloadTarget(rel, spec, isFile)
      if (!to) continue
      const normalizedTarget = normalizeTarget(to)
      const key = `${rel}->${normalizedTarget}:${fact.line}:preload`
      if (edgeSeen.has(key)) continue
      edgeSeen.add(key)
      const evidence: EdgeEvidence = { confidence: fact.literal && !fact.externalRef ? 'certain' : 'candidate', basis: 'preload_wiring' }
      const edge = { to: normalizedTarget, line: fact.line, kind: 'preload', evidence }
      push(deps, rel, edge)
      push(resolvedDeps, rel, edge)
      push(rdeps, normalizedTarget, { path: rel, line: fact.line, kind: 'preload', evidence })
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
      const resolved = resolveSrc(rel, s.src ?? '', isFile)
      return { ...base, ...resolved, ...(resolved.rel && resolved.exists ? { rel: normalizeTarget(resolved.rel) } : {}) }
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
      for (let next = 0; next < queue.length; next++) {
        const current = queue[next]
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
        // A source asset can be referenced by a script; its compile/import
        // dependencies do not thereby become browser script executions.
        if (entries.get(current)?.kind !== 'source') {
          const edges = current === rel
            // Inline facts share the HTML file node, but dependencies belong
            // to individual scripts, even when several tags share one line.
            ? (inlineDeps.get(rel)?.get(script.index) ?? [])
            : (resolvedDeps.get(current) ?? [])
          for (const edge of edges) queue.push(edge.to)
        }
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
  const bridgeByObject = new Map<string, BridgeItem[]>()
  const bridgeByFile = new Map<string, BridgeItem[]>()
  const unknownBridge: BridgeItem[] = []
  const gdefs = new Map<string, DefItem[]>()
  const guses = new Map<string, UseItem[]>()
  const namedEntries = new Map<string, NamedItem[]>()

  // Wrapper tables per module, for resolving calls that cross a file boundary.
  const moduleWrappers = new Map<string, Map<string, WrapperFact>>()
  for (const [rel, f] of entries) {
    const js = scriptFacts(f)
    if (!js?.wrappers.length) continue
    moduleWrappers.set(rel, new Map(js.wrappers.map((w) => [w.name, w])))
  }
  const wrapperAt = (fromRel: string, spec: string, imported: string | null): WrapperFact | null => {
    if (imported === null) return null
    const facts = scriptFacts(entries.get(fromRel)!)
    const modes = ([['import', facts?.imports], ['require', facts?.requires]] as const).filter(([, refs]) => refs?.some(ref => ref.spec === spec)).map(([mode]) => mode)
    const targets = modes.map(mode => jsResolver(fromRel, spec, mode, isFile))
    const first = targets[0]
    if (first?.status !== 'resolved' || first.targets.length !== 1 || first.targets[0].evidence.confidence !== 'certain') return null
    const to = first.targets[0].to
    if (!targets.every(result => result.status === 'resolved' && result.targets.length === 1 && result.targets[0].to === to && result.targets[0].evidence.confidence === 'certain')) return null
    return moduleWrappers.get(normalizeTarget(to))?.get(imported) ?? null
  }
  const pageAlias = new Map<string, Array<{ object: string; path: string }>>()
  for (const [rel, f] of entries) {
    const js = scriptFacts(f)
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
  // Function-local aliases never leave their file: `const api = window.chartAPI`
  // inside a renderer IIFE still decides what `api.listCharts` refers to.
  const localAlias = new Map<string, Map<string, string>>()
  for (const [rel, f] of entries) {
    const js = scriptFacts(f)
    if (!js?.bridgeAliases.length) continue
    const map = new Map<string, string>()
    for (const alias of js.bridgeAliases) if (!map.has(alias.name)) map.set(alias.name, alias.object)
    localAlias.set(rel, map)
  }
  const resolveLocalObject = (file: string, object: string): string | null => {
    const map = localAlias.get(file)
    if (!map) return null
    let current = object
    for (let hop = 0; hop < 4; hop++) {
      const next = map.get(current)
      if (next === undefined) return current !== object && rootGlobals.has(current) ? current : null
      current = next
    }
    return rootGlobals.has(current) ? current : null
  }
  const resolveAliasRef = (fromRel: string, raw: BridgeFact): BridgeItem | null => {
    // A local declaration shadows any same-named global (`const api =
    // window.chartAPI` wins over a preload that exposes a global called `api`),
    // and so does a classic-script alias adopted by the same page.
    const local = resolveLocalObject(fromRel, raw.object)
    if (local) return { ...raw, path: fromRel, alias: raw.object, object: local }
    const mine = pagesOfRel(fromRel)
    const def = (pageAlias.get(raw.object) ?? []).find((d) => d.path === fromRel || [...pagesOfRel(d.path)].some((p) => mine.has(p)))
    if (def) return { ...raw, path: fromRel, alias: raw.object, object: def.object }
    return rootGlobals.has(raw.object) ? { ...raw, path: fromRel } : null
  }
  for (const [rel, f] of entries) {
    const js = scriptFacts(f)
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
    // Cross-file wrapper calls: the edge only exists once the owning module's
    // wrapper table says what that imported name actually forwards to.
    for (const call of js.deferredCalls) {
      const def = wrapperAt(rel, call.spec, call.imported)
      if (!def) continue
      const record: IpcItem = {
        side: def.side, method: def.method, channel: call.channel, via: 'wrapper',
        line: call.line, symbol: call.symbol, path: rel,
      }
      if (def.side === 'register') push(registers, call.channel, record)
      else if (def.side === 'push') push(pushes, call.channel, record)
      else push(directCalls, call.channel, record)
    }
    for (const entry of js.namedEntries) {
      if (entry.spec !== null && !wrapperAt(rel, entry.spec, entry.wrapper)) continue
      push(namedEntries, entry.name, { ...entry, path: rel })
    }
    for (const raw of js.bridge) {
      const resolved = resolveAliasRef(rel, raw)
      if (!resolved) continue
      push(bridgeByObject, resolved.object, resolved)
      push(bridgeByFile, rel, resolved)
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

  const ffi = indexFfi(entries)
  return {
    root, files: entries, deps, rdeps, unresolvedModules, pages, membership, classic,
    registers, pushes, directCalls, dynamic, apisByName, apisByChannel, namedEntries, roleGlobals, roleByGlobal,
    bridgeRefs, bridgeByObject, bridgeByFile, unknownBridge, gdefs, guses, decls, ...(ffi.size ? { ffi } : {}), ...(resolutionLimited ? { resolutionLimited: true } : {}),
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
