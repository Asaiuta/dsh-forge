/**
 * fftrace: ProjectForge-Trace-style link-graph queries over the session
 * workspace. Scans source/HTML links, module manifests and PE/ELF/WASM metadata,
 * optionally reads a JSON declaration table, assembles the maps
 * (linkgraph.ts), and answers ipc:/api:/global:/page:/file:/impact:/path:/ffi:/
 * exposes:/symbol: queries with `path:line` rows that feed straight back into
 * ffedit / ff_read coordinates.
 *
 * Read-only: never executes workspace code or mutates the ledger.
 *
 * @module dsh-forge/tools-trace
 */

import path from 'node:path'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import ignore from 'ignore'
import { bridgeGlobalsOf, loadPreloadDecls } from './decls.ts'
import { buildGraph, deriveRoleGlobals, exposedGlobalsOf, normalizeTraceFile, parseDependencyPath, type TraceGraph } from './linkgraph.ts'
import { parseTarget, trace } from './trace-queries.ts'
import { loadCompilationDatabase, resetCompilationCache, type CompilationInfo } from './compile-commands.ts'
import { scriptFacts, jsReferences, topLevelAliasNames, type TraceFileFacts } from './facts.ts'
import { workdirOf, type ForgeExec, type ToolFailure } from './core.ts'
import { astWorkerAuto, astWorkerCount, parallelTrace, type AstWorkerPool } from './ast-pool.ts'
import { extractTraceFile, selectBridgeFacts, type TraceFileOutcome } from './trace-facts.ts'
import { indexerReady, indexerTextFacts, indexerTraceFacts, indexerTraceLang, indexerTraceWanted } from './indexer-client.ts'
import { BINARY_EXTENSIONS, MAX_BINARY_BYTES } from './binary-facts.ts'
import { loadJsProject, projectMetadata } from './js-project.ts'
import { loadPythonProject, pythonMetadata } from './python-project.ts'
import { cargoMetadata, loadRustProject } from './rust-project.ts'
import { goMetadata, loadGoProject } from './go-project.ts'
import { findDefinitions } from './tools-symbol.ts'
import type { EdgeMode, ProjectContext, TraceDiagnostic } from './trace-evidence.ts'

const SCAN_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.html', '.vue', '.svelte',
  '.py', '.pyi', '.rs', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx', '.cppm', '.ixx', '.go', '.java', '.lua'])
const FILE_CAP = 20_000
const PER_FILE_BYTES = 2 * 1024 * 1024
const WALK_VISIT_CAP = 200_000

function failure(error: string): ToolFailure {
  return { error }
}

/** Header display only: a directory repeating one issue reason ≥3 times
 *  (minified dist/, extracted vendor trees) collapses to its first row plus
 *  one count line — a flood of generated-file warnings must not bury the
 *  answer (real-repo A2: 84 partial-parse rows made a correct result look
 *  unreliable). diagnostics rows stay complete. */
function collapseIssues(issues: readonly TraceDiagnostic[]): TraceDiagnostic[] {
  const counts = new Map<string, number>()
  for (const issue of issues) {
    const dir = path.posix.dirname(issue.path.replaceAll('\\', '/'))
    counts.set(`${issue.reason}|${dir}`, (counts.get(`${issue.reason}|${dir}`) ?? 0) + 1)
  }
  const collapsed: TraceDiagnostic[] = []
  const shown = new Map<string, number>()
  for (const issue of issues) {
    const dir = path.posix.dirname(issue.path.replaceAll('\\', '/'))
    const key = `${issue.reason}|${dir}`
    if ((counts.get(key) ?? 0) < 3) { collapsed.push(issue); continue }
    const seen = (shown.get(key) ?? 0) + 1
    shown.set(key, seen)
    if (seen === 1) collapsed.push(issue)
    if (seen === 2) collapsed.push({ path: dir + '/…', reason: issue.reason, message: `同目录另有 ${counts.get(key)! - 1} 个文件触发同一问题（已折叠）。` })
    if (seen > 2) continue
  }
  return collapsed
}

function text(value: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value }]
}

/** Rules per root, reused while .gitignore is unchanged: the matcher caches
 *  each path's verdict, which a fresh instance per scan would discard. */
const IGNORE_RULES = new Map<string, { text: string; rules: ReturnType<typeof ignore> }>()

/** Collect supported source, HTML, manifests and binaries, root-.gitignore-aware, capped. */
function collectCandidates(root: string, signal?: AbortSignal): { files: Array<{ abs: string; rel: string }>; projectFiles: string[]; pythonFiles: string[]; cargoFiles: string[]; goFiles: string[]; truncated: boolean; walkErrors: number } {
  let walkErrors = 0
  let text = ''
  const gitignore = path.join(root, '.gitignore')
  if (existsSync(gitignore)) {
    try { text = readFileSync(gitignore, 'utf8') } catch { walkErrors++ }
  }
  let cached = IGNORE_RULES.get(root)
  if (!cached || cached.text !== text) {
    cached = { text, rules: ignore().add(text) }
    IGNORE_RULES.delete(root)
    IGNORE_RULES.set(root, cached)
    if (IGNORE_RULES.size > 8) IGNORE_RULES.delete(IGNORE_RULES.keys().next().value!)
  }
  const rules = cached.rules
  const files: Array<{ abs: string; rel: string }> = []
  const projectFiles: string[] = []
  const pythonFiles: string[] = []
  const cargoFiles: string[] = []
  const goFiles: string[] = []
  let visited = 0
  let truncated = false
  const walk = (dir: string, prefix = ''): void => {
    signal?.throwIfAborted()
    if (files.length >= FILE_CAP || visited > WALK_VISIT_CAP) {
      truncated = true
      return
    }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      walkErrors++
      return
    }
    for (const entry of entries) {
      if (files.length >= FILE_CAP || visited > WALK_VISIT_CAP) {
        truncated = true
        return
      }
      visited++
      const abs = path.join(dir, entry.name)
      const rel = prefix + entry.name
      if (rules.ignores(rel)) continue
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.dsh') continue
        // Host-owned artifact containers (any dot-directory carrying the _dsh
        // marker, e.g. .workbuddy/_dsh/asar-out) are runtime dumps, not
        // workspace source — detection is structural, never by directory name.
        if (entry.name.startsWith('.') && existsSync(path.join(abs, '_dsh'))) continue
        walk(abs, rel + '/')
      } else if (entry.isFile()) {
        if (projectMetadata(entry.name)) projectFiles.push(rel)
        if (pythonMetadata(entry.name)) pythonFiles.push(rel)
        if (cargoMetadata(entry.name)) cargoFiles.push(rel)
        if (goMetadata(entry.name)) goFiles.push(rel)
        if (SCAN_EXTS.has(path.extname(entry.name).toLowerCase()) || BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || entry.name === 'go.mod') files.push({ abs, rel })
      }
    }
  }
  walk(root)
  return { files: files.sort((a, b) => a.rel.localeCompare(b.rel)), projectFiles: projectFiles.sort(), pythonFiles: pythonFiles.sort(), cargoFiles: cargoFiles.sort(), goFiles: goFiles.sort(), truncated, walkErrors }
}

/**
 * Cache bridge-independent facts; select bridge references after discovering
 * aliases across the workspace. No source file needs the old second parse.
 */
interface CachedFacts {
  mtimeMs: number
  size: number
  ctimeMs: number
  value: TraceFileOutcome
}
const FACTS_CACHE = new Map<string, CachedFacts>()
const FACTS_CACHE_CAP = 6000

function rememberFacts(key: string, mtimeMs: number, size: number, ctimeMs: number, value: TraceFileOutcome): void {
  if (!FACTS_CACHE.has(key) && FACTS_CACHE.size >= FACTS_CACHE_CAP) {
    let evict = Math.floor(FACTS_CACHE_CAP / 4)
    for (const stale of FACTS_CACHE.keys()) {
      FACTS_CACHE.delete(stale)
      if (--evict <= 0) break
    }
  }
  FACTS_CACHE.set(key, { mtimeMs, size, ctimeMs, value })
}

/** Drop cached per-file facts. Tests use this to force a genuinely cold assembly. */
export function resetTraceFactsCache(): void {
  FACTS_CACHE.clear()
  GRAPH_CACHE.clear()
  resetCompilationCache()
}

/** Scan one root: per-file facts (HTML scanner + AST extractor). */
async function scanFacts(root: string, signal?: AbortSignal, workers?: AstWorkerPool) {
  const { files, projectFiles, pythonFiles, cargoFiles, goFiles, truncated, walkErrors } = collectCandidates(root, signal)
  // Discovery never follows directory links below root. Check root's own
  // identity once so retargeting an alias cannot reuse another tree's facts,
  // even when every source file happens to have identical stat metadata.
  let rootIdentity: string | null = null
  try { rootIdentity = realpathSync(root) } catch { /* walkErrors reports an inaccessible root */ }
  const entries = new Map<string, TraceFileFacts>()
  const outcomes: TraceFileOutcome[] = Array(files.length)
  const stamps: Array<[string, number, number, number] | [string, null]> = []
  const missing: Array<{ index: number; file: string; cacheKey: string; bytes: number; mtimeMs: number; ctimeMs: number }> = []
  let parseErrors = 0
  let partialFiles = 0
  const diagnostics: TraceDiagnostic[] = []
  for (let index = 0; index < files.length; index++) {
    const { abs, rel } = files[index]
    signal?.throwIfAborted()
    try {
      const stat = statSync(abs)
      stamps.push([rel, stat.mtimeMs, stat.size, stat.ctimeMs])
      const cacheKey = JSON.stringify([rootIdentity, abs])
      const cached = FACTS_CACHE.get(cacheKey)
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.ctimeMs === stat.ctimeMs) {
        outcomes[index] = cached.value
      } else if (stat.size > (BINARY_EXTENSIONS.has(path.extname(abs).toLowerCase()) ? MAX_BINARY_BYTES : PER_FILE_BYTES)) {
        outcomes[index] = { value: null, parseErrors: 1, partialFiles: 0, diagnostics: [{ reason: 'file_too_large', message: '文件超过 Trace 单文件读取上限。' }] }
      } else missing.push({ index, file: abs, cacheKey, bytes: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs })
    } catch (cause) {
      stamps.push([rel, null])
      outcomes[index] = { value: null, parseErrors: 1, partialFiles: 0, diagnostics: [{ reason: 'stat_failed', message: cause instanceof Error ? cause.message : String(cause) }] }
    }
  }
  // Source files go to the native sidecar first. What it declines (size cap,
  // over-deep trees, an older binary) keeps the WASM path below.
  const parsed: Array<TraceFileOutcome | null> = missing.map(() => null)
  const native = indexerTraceWanted() && missing.length > 0 && await indexerReady({ signal })
  if (native) {
    const indexes = missing.flatMap((item, index) => indexerTraceLang(item.file) ? [index] : [])
    const outcomes = await indexerTraceFacts(indexes.map(index => missing[index].file), signal)
    outcomes.forEach((outcome, offset) => { parsed[indexes[offset]] = outcome })
  }
  const rest = missing.flatMap((item, index) => parsed[index] ? [] : [{ ...item, slot: index }])
  // With the sidecar, script hosts, manifests and binaries need no WASM pool:
  // they are scanned here and inline scripts are parsed natively.
  const hosted = native ? rest.filter(item => !indexerTraceLang(item.file)) : []
  for (const item of hosted) {
    signal?.throwIfAborted()
    parsed[item.slot] = await extractTraceFile(item.file, indexerTextFacts)
  }
  const wasm = native ? rest.filter(item => indexerTraceLang(item.file)) : rest
  // Files the sidecar declined are few; a full worker pool would cost each
  // worker its own WASM compilation (hundreds of MB) for a handful of files.
  const parallel = wasm.length > 0 && astWorkerCount() > 0 && (!astWorkerAuto() || wasm.length >= (native ? 256 : 16))
  if (parallel) {
    const outcomes = await (workers ? workers.facts(wasm, signal) : parallelTrace(wasm, signal))
    wasm.forEach((item, index) => { parsed[item.slot] = outcomes[index] })
  } else {
    for (const item of wasm) {
      await new Promise<void>(resolve => setImmediate(resolve))
      signal?.throwIfAborted()
      parsed[item.slot] = await extractTraceFile(item.file)
    }
  }
  signal?.throwIfAborted()
  missing.forEach((item, index) => {
    const value = parsed[index]!
    outcomes[item.index] = value
    // Failed reads must be retried: permission changes need not change stat.
    if (value.value && value.parseErrors === 0) rememberFacts(item.cacheKey, item.mtimeMs, item.bytes, item.ctimeMs, value)
  })
  outcomes.forEach((outcome, index) => {
    parseErrors += outcome.parseErrors
    partialFiles += outcome.partialFiles
    for (const issue of outcome.diagnostics ?? []) diagnostics.push({ ...issue, path: files[index].rel })
    if (outcome.partialFiles) diagnostics.push({ path: files[index].rel, reason: 'partial_parse', message: '语法或格式仅部分解析，事实可能不完整。' })
    if (outcome.value) entries.set(files[index].rel, outcome.value)
  })
  return { entries, projectFiles, pythonFiles, cargoFiles, goFiles, diagnostics, scanned: files.length, truncated, parseErrors, partialFiles, walkErrors,
    signature: JSON.stringify([rootIdentity, stamps, outcomes.map(value => [Boolean(value.value), value.parseErrors, value.partialFiles, value.diagnostics]), truncated, walkErrors]) }
}

function describeDecls(status: string, apis: number, error?: string): string {
  if (status === 'ok') return `preload 声明表 ${apis} 个 API`
  if (status === 'absent') return '无 preload 声明表（只有字面量边）'
  return `⚠️ preload 声明表读取失败：${error ?? '未知原因'}`
}

export interface AssembledTrace {
  graph: TraceGraph
  decls: import('./decls.ts').PreloadDecls
  scanned: number
  truncated: boolean
  parseErrors: number
  partialFiles: number
  walkErrors: number
  diagnostics: TraceDiagnostic[]
  project?: { configs: number; workspacePackages: number }
  compilation?: CompilationInfo
}

export interface TraceAssemblyOptions { declarations?: string; compileCommands?: string; signal?: AbortSignal; workers?: AstWorkerPool }
interface GraphProbe { exists: boolean; identity: string | null }
const GRAPH_CACHE = new Map<string, { signature: string; decls: string; contexts: Array<ProjectContext | undefined>; probes: Map<string, GraphProbe>; assembled: AssembledTrace }>()
interface PendingAssembly { controller: AbortController; users: number; promise: Promise<AssembledTrace> }
const PENDING = new Map<string, Map<AstWorkerPool | undefined, PendingAssembly>>()

/** The exact per-probe check: a file (links followed) with this real path. */
function probeMatches(absolute: string, expected: GraphProbe): boolean {
  try {
    const exists = statSync(absolute, { throwIfNoEntry: false })?.isFile() ?? false
    return exists === expected.exists && (!exists || realpathSync.native(absolute) === expected.identity)
  } catch { return !expected.exists }
}

/**
 * Whether every resolution probe still sees the same file. Most probes are
 * missing extension/index candidates, so each parent directory is listed once
 * instead of stat-ing every probe. A plain-file entry exists with identity
 * realpath(dir)/name; links, case-only matches (case-insensitive volumes) and
 * unreadable directories take the exact per-probe check.
 */
function probesUnchanged(root: string, probes: ReadonlyMap<string, GraphProbe>): boolean {
  type Listing = { entries: Map<string, import('node:fs').Dirent>; folded: Set<string>; real: string | null }
  const EMPTY: Listing = { entries: new Map(), folded: new Set(), real: null }
  const listings = new Map<string, Listing | null>()
  const listing = (dir: string): Listing | null => {
    if (listings.has(dir)) return listings.get(dir)!
    let value: Listing | null = null
    // A directory the parent listing does not contain is missing: answering
    // from the parent avoids an ENOENT throw per guessed package directory.
    const parent = dir.startsWith(root + path.sep) ? listing(path.dirname(dir)) : undefined
    const base = path.basename(dir)
    const own = parent?.entries.get(base)
    if (parent && !own && !parent.folded.has(base.toLowerCase())) value = EMPTY
    else if (parent && own && !own.isDirectory() && !own.isSymbolicLink()) value = EMPTY
    else {
      try {
        const entries = new Map(readdirSync(dir, { withFileTypes: true }).map(entry => [entry.name, entry]))
        value = { entries, folded: new Set([...entries.keys()].map(name => name.toLowerCase())), real: null }
      } catch (cause) {
        // A missing directory holds no files; anything else is checked exactly.
        const code = (cause as NodeJS.ErrnoException).code
        value = code === 'ENOENT' || code === 'ENOTDIR' ? EMPTY : null
      }
    }
    listings.set(dir, value)
    return value
  }
  for (const [rel, expected] of probes) {
    const absolute = path.join(root, ...rel.split('/'))
    const dir = path.dirname(absolute), name = path.basename(absolute)
    const list = listing(dir)
    const entry = list?.entries.get(name)
    if (!list || (entry ? !entry.isFile() && !entry.isDirectory() : list.folded.has(name.toLowerCase()))) {
      if (!probeMatches(absolute, expected)) return false
      continue
    }
    const exists = entry?.isFile() ?? false
    if (exists !== expected.exists) return false
    if (!exists) continue
    try { list.real ??= realpathSync.native(dir) } catch { if (!probeMatches(absolute, expected)) return false; continue }
    if (path.join(list.real, name) !== expected.identity) return false
  }
  return true
}

async function assemble(root: string, key: string, options: TraceAssemblyOptions): Promise<AssembledTrace> {
  const decls = await loadPreloadDecls(root, options.declarations, options.signal)
  const scan = await scanFacts(root, options.signal, options.workers)
  const hasNative = [...scan.entries.values()].some(entry => entry.kind === 'source' && (entry.lang === 'c' || entry.lang === 'cpp'))
  const compilation = hasNative || options.compileCommands ? loadCompilationDatabase(root, options.compileCommands, options.signal) : undefined
  const hasJs = [...scan.entries.values()].some(entry => entry.kind === 'js' || entry.kind === 'html' || entry.kind === 'component')
  // Program membership expands through TS/JS file references only; HTML and
  // component scripts never join a tsc program.
  const jsRefs = new Map<string, ReturnType<typeof jsReferences>>()
  for (const [rel, entry] of scan.entries) if (entry.kind === 'js') {
    const refs = jsReferences(entry)
    if (refs.length) jsRefs.set(rel, refs)
  }
  const project = hasJs ? loadJsProject(root, scan.projectFiles, options.signal, new Set(scan.entries.keys()), jsRefs) : undefined
  const cached = GRAPH_CACHE.get(key)
  const declsKey = JSON.stringify(decls)
  // Fixed slot order: a context that disappears (undefined) must not match one that existed.
  const pythonSources = [...scan.entries].filter(([, entry]) => entry.kind === 'source' && entry.lang === 'python').map(([rel]) => rel)
  const python = pythonSources.length ? loadPythonProject(root, scan.pythonFiles, pythonSources, options.signal) : undefined
  const hasRust = [...scan.entries.values()].some(entry => entry.kind === 'source' && entry.lang === 'rust')
  const rust = hasRust && scan.cargoFiles.length ? loadRustProject(root, scan.cargoFiles, options.signal) : undefined
  const hasGo = [...scan.entries.values()].some(entry => entry.kind === 'source' && entry.lang === 'go')
  const go = hasGo && scan.goFiles.length ? loadGoProject(root, scan.goFiles, options.signal) : undefined
  const contexts: Array<ProjectContext | undefined> = [compilation, project, python, rust, go]
  if (cached && cached.signature === scan.signature && cached.decls === declsKey
    && contexts.every((context, index) => cached.contexts[index]?.signature === context?.signature && cached.contexts[index]?.valid() !== false)
    && scan.walkErrors === 0 && !scan.truncated) {
    // Resolution may probe ignored/non-JS files or missing paths. Revalidate
    // those too, so adding an asset or an index file invalidates the graph.
    if (probesUnchanged(root, cached.probes)) return cached.assembled
  }
  const aliases = topLevelAliasNames([...scan.entries.values()].map((entry) => ({ facts: scriptFacts(entry) })))
  // Role globals recovered from `ROLE_GLOBALS.<role> = 'name'` const strings
  // plus literal exposeInMainWorld names count as bridge roots even without a
  // declarations file, so per-key usage of exposed globals survives the
  // post-scan bridge filter.
  const bridge = [...new Set([...bridgeGlobalsOf(decls), ...Object.values(deriveRoleGlobals(scan.entries)), ...exposedGlobalsOf(scan.entries), ...aliases])]
  const entries = new Map([...scan.entries].map(([rel, entry]) => [rel, selectBridgeFacts(entry, bridge)]))
  options.signal?.throwIfAborted()
  const probes = new Map<string, GraphProbe>()
  const graph = buildGraph(root, entries, decls, (rel, exists, identity) => probes.set(rel, { exists, identity: identity ?? null }), compilation?.resolve, project?.resolve, { python, rust, go })
  const assembled = { graph, decls, scanned: scan.scanned, truncated: scan.truncated, parseErrors: scan.parseErrors, partialFiles: scan.partialFiles, walkErrors: scan.walkErrors,
    diagnostics: [...scan.diagnostics, ...project?.issues ?? [], ...python?.issues ?? [], ...rust?.issues ?? [], ...go?.issues ?? []],
    ...(project ? { project: { configs: project.configs, workspacePackages: project.workspacePackages } } : {}),
    ...(compilation?.info ? { compilation: compilation.info } : {}) }
  if (!scan.truncated && scan.walkErrors === 0) {
    GRAPH_CACHE.delete(key)
    GRAPH_CACHE.set(key, { signature: scan.signature, decls: declsKey, contexts, probes, assembled })
    if (GRAPH_CACHE.size > 4) GRAPH_CACHE.delete(GRAPH_CACHE.keys().next().value!)
  }
  return assembled
}

/** Share overlapping scans, while each caller retains its own cancellation.
 *  Cancel shared work only when no caller is still waiting for it. */
export function assembleTraceGraph(root: string, options: TraceAssemblyOptions = {}): Promise<AssembledTrace> {
  options.signal?.throwIfAborted()
  root = path.resolve(root)
  const key = JSON.stringify([root, options.declarations ? path.resolve(root, options.declarations) : null, options.compileCommands ? path.resolve(root, options.compileCommands) : null])
  let owners = PENDING.get(key)
  if (!owners) { owners = new Map(); PENDING.set(key, owners) }
  let job = owners.get(options.workers)
  if (!job || job.controller.signal.aborted) {
    const controller = new AbortController()
    job = { controller, users: 0, promise: Promise.resolve().then(() => assemble(root, key, { ...options, signal: controller.signal })) }
    const current = job
    const active = owners
    active.set(options.workers, current)
    void current.promise.finally(() => {
      if (active.get(options.workers) === current) active.delete(options.workers)
      if (active.size === 0 && PENDING.get(key) === active) PENDING.delete(key)
    }).catch(() => {})
  }
  const current = job
  current.users++
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (cause?: unknown, result?: AssembledTrace) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', abort)
      current.users--
      if (cause !== undefined) {
        if (current.users === 0) {
          current.controller.abort(cause)
          // With no remaining owner, wait for worker acknowledgement before
          // returning. Cancelling one of several callers may return at once.
          void current.promise.then(() => reject(cause), () => reject(cause))
        } else reject(cause)
      } else resolve(result!)
    }
    const abort = () => finish(options.signal?.reason ?? new Error('Trace scan aborted'))
    options.signal?.addEventListener('abort', abort, { once: true })
    current.promise.then(result => finish(undefined, result), cause => finish(cause))
  })
}

export function createTraceTool(workers?: AstWorkerPool) {
  return {
    name: 'fftrace',
    description:
      'Trace dependencies before changing code. Pick target= by question: who breaks if I change a file (run before any refactor) → impact:<path>; what a file imports → file:<path>; how A reaches B → path:<from> -> <to>; where an IPC channel registers/is called → ipc:<channel>; which channel a preload API reaches → api:<name>; which globals preloads expose and which members are used where → exposes: (all) or exposes:<global-or-file>; which keys one preload exposes (exposeInMainWorld) → file:<preload>; who defines/uses a window.* global → global:<name>; which scripts a page loads in order → page:<file.html>; where a symbol is defined when several files share the name → symbol:<name>. JS/TS resolution supports tsconfig/jsconfig paths/baseUrl/references, workspace package exports/imports, TypeScript program membership, and named imports through re-export barrels to the defining file (candidate reexport edges) (imported excluded files inherit the importing config; plain TS require() never joins a program). edgeMode=certain excludes candidate edges; diagnostics explains unresolved modules. Also covers HTML, Vue/Svelte script dependencies, Python (package roots from pyproject.toml/setup.cfg and src/ layout), Rust (Cargo path dependencies and declared target roots), C/C++, Go (go.work and local replace)/Java/Lua (literal package.path) candidates and TS ambient declarations. ' +
      'ffi:<name> finds source boundary declarations and PE/ELF/WASM exports as separate evidence, never a verified cross-language call chain. Read-only; dynamic paths and external packages stay unresolved. Optional compile_commands.json resolves C/C++ include flags without executing commands.',
    parameters: {
      target: { type: 'string', required: true, description: 'file:<path>, impact:<path>, path:<from> -> <to>, ipc:<channel>, api:<name>, global:<name>, page:<file.html>, exposes:<global-or-file> (empty = all), symbol:<name>, or ffi:<export-or-declaration-name>.' },
      declarations: { type: 'string', description: 'Absolute or workspace-relative JSON file, ≤256KiB: {apis:[{name,channel,kind,roles}],roleGlobals?:{role:global}}; kind=query/command/subscription.' },
      compileCommands: { type: 'string', description: 'Compilation database JSON (≤8MiB); defaults to workspace compile_commands.json for C/C++. Reads include flags without executing commands.' },
      edgeMode: { type: 'string', enum: ['all', 'certain'], description: 'File dependency edges for file:/impact:/path:. all (default) includes labelled candidates; certain excludes them. Static certainty does not prove runtime execution.' },
      limit: { type: 'integer', description: 'symbol: 最多返回的定义数（1-200，默认 50）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          target: { type: 'string', required: true },
          edgeMode: { type: 'string' },
          text: { type: 'string', required: true },
          scanned: { type: 'integer' },
          pages: { type: 'integer' },
          decls: { type: 'string' },
          truncated: { type: 'boolean' },
          parseErrors: { type: 'integer' },
          partialFiles: { type: 'integer' },
          walkErrors: { type: 'integer' },
          incomplete: { type: 'boolean' },
          resolutionLimited: { type: 'boolean' },
          project: { type: 'object', additionalProperties: false, properties: { configs: { type: 'integer', required: true }, workspacePackages: { type: 'integer', required: true } } },
          diagnostics: {
            type: 'object', additionalProperties: false, properties: {
              unresolvedTotal: { type: 'integer', required: true }, issuesTotal: { type: 'integer', required: true }, truncated: { type: 'boolean', required: true },
              unresolved: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                path: { type: 'string', required: true }, line: { type: 'integer', required: true }, spec: { type: 'string', required: true },
                reason: { type: 'string', required: true }, detail: { type: 'string' }, config: { type: 'string' },
              } } },
              issues: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                path: { type: 'string', required: true }, reason: { type: 'string', required: true }, message: { type: 'string', required: true }, line: { type: 'integer' },
              } } },
            },
          },
          compilation: {
            type: 'object', additionalProperties: false, properties: {
              status: { type: 'string', required: true }, path: { type: 'string', required: true },
              entries: { type: 'integer', required: true }, unsupported: { type: 'integer', required: true }, message: { type: 'string' },
            },
          },
          ffi: {
            type: 'object', additionalProperties: false, properties: {
              name: { type: 'string', required: true }, total: { type: 'integer', required: true }, truncated: { type: 'boolean', required: true },
              matches: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                path: { type: 'string', required: true }, name: { type: 'string', required: true }, kind: { type: 'string', required: true }, lang: { type: 'string', required: true },
                line: { type: 'integer' }, symbol: { type: 'string' }, abi: { type: 'string' }, format: { type: 'string' }, ordinal: { type: 'integer' }, forwarder: { type: 'string' },
              } } },
            },
          },
          analysis: {
            type: 'object', additionalProperties: false, properties: {
              kind: { type: 'string', required: true }, source: { type: 'string', required: true }, destination: { type: 'string' },
              edgeMode: { type: 'string', required: true },
              complete: { type: 'boolean', required: true }, visitedFiles: { type: 'integer', required: true },
              totalFiles: { type: 'integer', required: true }, totalPages: { type: 'integer', required: true },
              distance: { type: 'integer' }, truncated: { type: 'boolean', required: true },
              files: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                path: { type: 'string', required: true }, depth: { type: 'integer', required: true },
              } } },
              edges: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                from: { type: 'string', required: true }, to: { type: 'string', required: true },
                line: { type: 'integer', required: true }, kind: { type: 'string', required: true },
                imports: { type: 'array', items: { type: 'string' }, description: 'Names the importer binds from the target (namespace as *local).' },
                evidence: { type: 'object', required: true, additionalProperties: false, properties: {
                  confidence: { type: 'string', required: true }, basis: { type: 'string', required: true }, config: { type: 'string' },
                } },
              } } },
              pages: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
        },
      },
      render: (_args: unknown, value: { text: string }) => text(value.text),
    },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      const raw = typeof args.target === 'string' ? args.target : ''
      // Symbol lookup answers before any graph scan: one call replaces reading
      // every candidate file when a name has several definitions (A8).
      const symbol = /^\s*symbol\s*:\s*(.+?)\s*$/i.exec(raw)
      if (symbol) {
        if (args.edgeMode !== undefined && args.edgeMode !== 'all') return failure('edgeMode 不适用于 symbol: 查询。')
        const name = symbol[1]
        const found = await findDefinitions(exec, { name, ...(args.limit === undefined ? {} : { limit: args.limit }) }, workers)
        if ('error' in found) return found
        const files = new Set(found.items.map((item) => String(item.file))).size
        const lines = [
          `## Trace symbol:${name}`,
          `- 定义 ${found.items.length} 处 · ${files} 个文件 · ${found.stats}${found.truncated ? ' · ⚠️ 结果已截断（可加 limit）' : ''}`,
          ...found.items.map((item) => `- \`${item.file}:${item.startLine}-${item.endLine}\` · ${item.kind} · \`${item.qualifiedName}\`#${item.occurrence}${item.signature ? ` · ${item.signature}` : ''}`),
          ...(found.items.length ? ['- 定位实现：ff_read view=body 传 path=文件 与 qualifiedName（或 path=文件#起-止行）；上方路径:行可直接回填 ffedit。'] : ['- 未找到该符号的定义；名称按精确匹配，不含模糊/前缀搜索。']),
        ]
        return {
          found: found.items.length > 0,
          target: `symbol:${name}`,
          text: lines.join('\n'),
          ...(found.truncated ? { truncated: true } : {}),
        }
      }
      const target = parseTarget(raw)
      if (!target) {
        return failure('fftrace needs a target like file:路径, impact:路径, path:源文件 -> 目标文件, ipc:通道名, api:名称, global:名称, page:xxx.html, exposes:名称, symbol:名称, or ffi:符号名.')
      }
      const edgeMode: EdgeMode = args.edgeMode === undefined || args.edgeMode === 'all' ? 'all' : args.edgeMode === 'certain' ? 'certain' : 'all'
      if (args.edgeMode !== undefined && args.edgeMode !== 'all' && args.edgeMode !== 'certain') return failure('edgeMode 仅接受 all 或 certain。')
      if (edgeMode === 'certain' && !['file', 'impact', 'path'].includes(target.kind)) return failure('edgeMode=certain 适用于 file:/impact:/path: 文件依赖查询。')
      const root = path.resolve(workdirOf(exec))
      const declarations = typeof args.declarations === 'string' ? args.declarations : undefined
      const compileCommands = typeof args.compileCommands === 'string' ? args.compileCommands : undefined
      let value = target.value
      if (target.kind === 'path') {
        const pair = parseDependencyPath(value)
        if (!pair) return failure('path: 需要源文件 -> 目标文件（箭头两侧留空格）。')
        const from = normalizeTraceFile(root, pair[0]), to = normalizeTraceFile(root, pair[1])
        if (!from || !to) return failure('path: 两端都必须位于扫描根内。')
        value = `${from} -> ${to}`
      } else if (target.kind === 'file' || target.kind === 'page' || target.kind === 'impact') {
        const normalized = normalizeTraceFile(root, value)
        if (target.kind === 'impact' && !normalized) return failure('impact: 文件必须位于扫描根内。')
        if (normalized) value = normalized
      }
      const nativePaths = [declarations, compileCommands].filter((file): file is string => Boolean(file)).map(file => path.resolve(root, file))
      if (nativePaths.length) await exec?.authorizeNativePaths?.(nativePaths)
      const assembled = await assembleTraceGraph(root, { declarations, compileCommands, signal: exec?.signal, workers })
      const { graph, decls, scanned, truncated, parseErrors, partialFiles, walkErrors, compilation, project } = assembled
      const result = trace(graph, target.kind, value, edgeMode)
      // Whole-graph queries (impact/path/ipc/…) would bury real findings under
      // thousands of external-package rows (real-repo A2: 4,377 noise items);
      // a single-file query keeps them — one bounded, meaningful row each.
      const unresolvedScope = target.kind === 'file' ? graph.unresolvedModules.filter(ref => ref.path === value) : graph.unresolvedModules
      const localUnresolved = target.kind === 'file' ? unresolvedScope : unresolvedScope.filter(ref => ref.reason !== 'external_package')
      const externalUnresolved = unresolvedScope.length - localUnresolved.length
      const issues = assembled.diagnostics
      const diagnostics = { unresolvedTotal: localUnresolved.length, issuesTotal: issues.length, truncated: localUnresolved.length > 100 || issues.length > 100,
        unresolved: localUnresolved.slice(0, 100), issues: issues.slice(0, 100) }
      const resolutionIncomplete = localUnresolved.some(ref => ref.reason === 'unsupported_config' || ref.reason === 'ambiguous_target')
      const incomplete = truncated || parseErrors > 0 || partialFiles > 0 || walkErrors > 0 || decls.status === 'failed'
        || compilation?.status === 'failed' || Boolean(compilation?.unsupported) || result.analysis?.complete === false || graph.resolutionLimited === true || issues.length > 0 || resolutionIncomplete
      const derivedKeys = graph.namedEntries.size
      const header = [
        `- 范围：${graph.stats.withFacts} 个源码/HTML/模块清单/二进制文件 · ${graph.stats.pages} 个页面 · ${describeDecls(decls.status, decls.apis.length, decls.error)}${derivedKeys ? `（另有 ${derivedKeys} 个 preload 键静态推导）` : ''}${truncated ? ' · ⚠️ 扫描已截断' : ''}`,
        '- 置信度：literal / const / 同文件或跨文件 wrapper 为直连，declared 经 preload 声明表，静态推导键来自 `键: wrapper(\'通道\')`；动态参数不入边。结果中的 `路径:行` 可直接回填 ffedit / ff_read。',
        `- 文件依赖边：${edgeMode === 'certain' ? '仅确定边' : '包含候选边'}；确定仅表示静态文件引用可解析，不保证运行时执行。`,
        ...(localUnresolved.length || externalUnresolved || issues.length ? [`- 解析诊断：本地未解析 ${localUnresolved.length} 项${externalUnresolved ? `（另有 ${externalUnresolved} 项外部包导入，不参与文件边）` : ''}，文件/工程问题 ${issues.length} 项；详见 diagnostics（各最多 100 项）。`] : []),
        ...collapseIssues(issues).slice(0, 5).map(issue => `- ⚠️ \`${issue.path}\` · ${issue.reason} · ${issue.message}`),
        ...(compilation ? [`- 编译数据库：${compilation.status} · ${compilation.entries} 条本地记录 · ${compilation.unsupported} 条不支持${compilation.message ? ` · ${compilation.message}` : ''}；只对有记录的源文件应用 include 搜索路径。`] : []),
        ...(graph.resolutionLimited ? ['- ⚠️ 模块归属或 Java 继承成员解析达到预算，相关推断已停止；未找到不能证明不存在依赖。'] : []),
        ...(incomplete ? [`- ⚠️ 分析不完整：读取/解析失败 ${parseErrors} 处，部分解析 ${partialFiles} 个文件，遍历失败 ${walkErrors} 处${truncated ? '，候选已截断' : ''}${result.analysis?.complete === false ? '，查询遍历受限' : ''}${resolutionIncomplete ? '，存在配置或归属限制' : ''}${compilation?.status === 'failed' || compilation?.unsupported ? '，编译元数据未完整解析' : ''}；未找到仅表示已分析范围内无命中。`] : []),
      ].join('\n')
      const [title, ...rest] = result.text.split('\n')
      return {
        found: result.found,
        target: `${target.kind}:${value}`,
        edgeMode,
        text: [title, header, ...rest].join('\n'),
        scanned,
        pages: graph.stats.pages,
        decls: decls.status,
        parseErrors,
        partialFiles,
        walkErrors,
        incomplete,
        diagnostics,
        ...(project ? { project } : {}),
        ...(graph.resolutionLimited ? { resolutionLimited: true } : {}),
        ...(compilation ? { compilation } : {}),
        ...(result.analysis ? { analysis: result.analysis } : {}),
        ...(result.ffi ? { ffi: result.ffi } : {}),
        ...(truncated ? { truncated: true } : {}),
      }
    },
  } as const
}
