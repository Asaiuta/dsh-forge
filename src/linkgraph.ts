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
import { indexFfi, type FfiMatch } from './trace-native.ts'
import type { IncludeResolver } from './compile-commands.ts'
import type { PythonRoots } from './python-project.ts'
import type { RustCrates } from './rust-project.ts'
import type { GoModules } from './go-project.ts'
import { jsFile, relativeJs } from './js-resolution.ts'
import type { EdgeEvidence, JsResolver, UnresolvedModule } from './trace-evidence.ts'
export { traceImpact, tracePath, normalizeTraceFile, parseDependencyPath } from './trace-analysis.ts'
import { COMPAT_GLOBAL, DEFAULT_ROLE_GLOBALS, type PreloadApi, type PreloadDecls } from './decls.ts'
export { TRACE_KINDS, parseTarget, trace, traceFile, traceGlobal, traceIpc, tracePage, type TraceKind } from './trace-queries.ts'


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

export interface ModuleGraph {
  deps: Map<string, DepEdge[]>
  rdeps: Map<string, RdepEdge[]>
  unresolvedModules: UnresolvedModule[]
}

export interface PageGraph {
  pages: Map<string, ScriptEntry[]>
  membership: Map<string, Map<string, { index: number; direct: boolean }>>
  classic: Map<string, Set<string>>
}

export interface ElectronIndex {
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
}

/** Flat by design: queries and tests address fields directly; the parts are built separately. */
export type TraceGraph = ModuleGraph & PageGraph & ElectronIndex & {
  root: string
  files: Map<string, TraceFileFacts>
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

/** Project metadata for non-JavaScript resolution (absent when the workspace has none). */
export interface SourceProjects { python?: PythonRoots; rust?: RustCrates; go?: GoModules }

interface BuildContext {
  entries: Map<string, TraceFileFacts>
  isFile: (rel: string) => boolean
  /** Reuses the scanner's spelling for case-insensitive duplicates; call order fixes first spellings. */
  normalizeTarget: (value: string) => string
  jsResolver: JsResolver
}

interface ModuleBuild {
  graph: ModuleGraph
  /** Resolved edges only — raw unresolved specs never enter page membership. */
  resolvedDeps: Map<string, DepEdge[]>
  /** Inline-script dependencies per HTML file, keyed by script index. */
  inlineDeps: Map<string, Map<number, DepEdge[]>>
  resolutionLimited: boolean
}

/** Module graph (edge-deduplicated): JS/HTML/component references, preload wiring and source-language modules. */
function buildModuleGraph({ entries, isFile, normalizeTarget, jsResolver }: BuildContext, includeResolver?: IncludeResolver, projects: SourceProjects = {}): ModuleBuild {
  const constIndex = constStringsOf(entries)
  const deps = new Map<string, DepEdge[]>()
  const resolvedDeps = new Map<string, DepEdge[]>()
  const inlineDeps = new Map<string, Map<number, DepEdge[]>>()
  const rdeps = new Map<string, RdepEdge[]>()
  const unresolvedModules: UnresolvedModule[] = []
  const edgeSeen = new Set<string>()
  let resolutionLimited = false
  const resolveSource = sourceResolver({ entries, isFile, includeResolver, ...projects, onLimit: () => { resolutionLimited = true } })
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

  return { graph: { deps, rdeps, unresolvedModules }, resolvedDeps, inlineDeps, resolutionLimited }
}

/** Page graph: script order + membership via dependency closure. */
function buildPageGraph({ entries, isFile, normalizeTarget }: BuildContext, { resolvedDeps, inlineDeps }: ModuleBuild): PageGraph {
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

  return { pages, membership, classic }
}

/** IPC channels, preload bridge references and window globals. */
function buildElectronIndex({ entries, isFile, normalizeTarget, jsResolver }: BuildContext, decls: PreloadDecls, { pages, membership, classic }: PageGraph): ElectronIndex {
  const roleGlobals = { ...DEFAULT_ROLE_GLOBALS, ...deriveRoleGlobals(entries), ...(decls.roleGlobals ?? {}) }
  const roleByGlobal = Object.fromEntries(Object.entries(roleGlobals).map(([role, global]) => [global, role]))
  const rootGlobals = new Set([...Object.values(roleGlobals), COMPAT_GLOBAL, ...exposedGlobalsOf(entries)])
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

  return {
    registers, pushes, directCalls, dynamic, apisByName, apisByChannel, namedEntries, roleGlobals, roleByGlobal,
    bridgeRefs, bridgeByObject, bridgeByFile, unknownBridge, gdefs, guses, decls,
  }
}

export function buildGraph(root: string, entries: Map<string, TraceFileFacts>, decls: PreloadDecls, onProbe?: (rel: string, exists: boolean, identity?: string | null) => void, includeResolver?: IncludeResolver, jsResolver: JsResolver = relativeJs, projects: SourceProjects = {}): TraceGraph {
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
  const context: BuildContext = { entries, isFile, normalizeTarget, jsResolver }
  // Order matters: normalizeTarget keeps the first spelling it sees.
  const modules = buildModuleGraph(context, includeResolver, projects)
  const pageGraph = buildPageGraph(context, modules)
  const electron = buildElectronIndex(context, decls, pageGraph)
  const ffi = indexFfi(entries)
  return {
    root, files: entries, ...modules.graph, ...pageGraph, ...electron,
    ...(ffi.size ? { ffi } : {}), ...(modules.resolutionLimited ? { resolutionLimited: true } : {}),
    stats: { withFacts: entries.size, pages: pageGraph.pages.size },
  }
}
