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
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import ignore from 'ignore'
import { bridgeGlobalsOf, loadPreloadDecls } from './decls.ts'
import { buildGraph, deriveRoleGlobals, exposedGlobalsOf, normalizeTraceFile, parseDependencyPath, type TraceGraph } from './linkgraph.ts'
import { parseTarget, trace, type ExposesFormat } from './trace-queries.ts'
import { loadCompilationDatabase, resetCompilationCache, type CompilationInfo } from './compile-commands.ts'
import { scriptFacts, jsReferences, topLevelAliasNames, type TraceFileFacts } from './facts.ts'
import { workdirOf, type ForgeExec, type ToolFailure } from './core.ts'
import { readBoundedFile } from './fs-paths.ts'
import { extractTraceFileFromBytes } from './trace-facts.ts'
import { fileSetDigestOf, loadBaseline, saveBaseline, type CaptureBaseline, type CapturedFile } from './trace-capture.ts'
import { astWorkerAuto, astWorkerCount, parallelTrace, type AstWorkerPool } from './ast-pool.ts'
import { extractTraceFile, selectBridgeFacts, type TraceFileOutcome } from './trace-facts.ts'
import { indexerCollectCandidates, indexerProbesUnchanged, indexerReady, indexerStatPaths, indexerTextFacts, indexerTraceFacts, indexerTraceLang, indexerTraceWanted } from './indexer-client.ts'
import { BINARY_EXTENSIONS, MAX_BINARY_BYTES } from './binary-facts.ts'
import { loadJsProject, projectMetadata } from './js-project.ts'
import { loadPythonProject, pythonMetadata } from './python-project.ts'
import { cargoMetadata, loadRustProject } from './rust-project.ts'
import { goMetadata, loadGoProject } from './go-project.ts'
import { findDefinitions } from './tools-symbol.ts'
import { TRACE_SCAN_EXTENSIONS } from './trace-capabilities.ts'
import { configIdentity, configKeyOf, TraceSnapshots, type TraceSnapshotMeta } from './trace-snapshot.ts'
import { sha256Hex } from './source-evidence.ts'
import { collectRows, rowText, type RowQuery, type RowSet } from './trace-rows.ts'
import type { EdgeMode, ProjectContext, TraceDiagnostic } from './trace-evidence.ts'

const FILE_CAP = 20_000
const PER_FILE_BYTES = 2 * 1024 * 1024
/** Total source bytes one capture may read. Above this the capture stops and
 *  says so; a partial baseline cannot answer "no new problem". Overridable so a
 *  test can force the truncated case without materializing 256 MiB. */
function captureReadBudget(): number {
  const raw = process.env.DSH_FORGE_CAPTURE_BUDGET_BYTES
  if (raw !== undefined) {
    const value = Number(raw)
    if (Number.isFinite(value) && value >= 0) return value
  }
  return 256 * 1024 * 1024
}
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

/** Collect supported source, HTML, manifests and binaries, root-.gitignore-aware, capped.
 *
 *  This is the reference the sidecar walk in `rust_indexer/src/candidates.rs`
 *  is held to, entry for entry and order included: tests/run-trace-candidates
 *  compares the two lists outright, so a rule that drifts on one side and not
 *  the other fails the suite instead of quietly changing what gets scanned. */
export function collectCandidatesLocal(root: string, signal?: AbortSignal): { files: Array<{ abs: string; rel: string }>; projectFiles: string[]; pythonFiles: string[]; cargoFiles: string[]; goFiles: string[]; truncated: boolean; walkErrors: number } {
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
        if (TRACE_SCAN_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || entry.name === 'go.mod') files.push({ abs, rel })
      }
    }
  }
  walk(root)
  return { files: files.sort((a, b) => a.rel.localeCompare(b.rel)), projectFiles: projectFiles.sort(), pythonFiles: pythonFiles.sort(), cargoFiles: cargoFiles.sort(), goFiles: goFiles.sort(), truncated, walkErrors }
}

/** Discovery, walked by the sidecar when it can. The order it returns is
 *  irrelevant: `localeCompare` and plain `sort()` are the contract here, and
 *  neither has a byte-order equivalent in Rust. */
async function collectCandidates(root: string, signal?: AbortSignal): Promise<ReturnType<typeof collectCandidatesLocal>> {
  const remote = indexerTraceWanted() && await indexerReady({ signal }) ? await indexerCollectCandidates(root, signal) : null
  if (!remote) return collectCandidatesLocal(root, signal)
  // `path.join` per file costs 8-10 ms at this size: it splits both arguments,
  // filters empty segments and re-joins. One `path.join(root, '.')` normalises
  // the root exactly as the per-file call would have, and the walk only returns
  // relative paths that use `/` and contain no `.` or `..` segment, so a
  // separator swap reaches the same string.
  const base = path.join(root, '.') + path.sep
  const files = remote.files.map(rel => ({
    abs: base + (path.sep === '/' ? rel : rel.replaceAll('/', path.sep)),
    rel,
  })).sort((a, b) => a.rel.localeCompare(b.rel))
  return {
    files,
    projectFiles: remote.projectFiles.sort(),
    pythonFiles: remote.pythonFiles.sort(),
    cargoFiles: remote.cargoFiles.sort(),
    goFiles: remote.goFiles.sort(),
    truncated: remote.truncated,
    walkErrors: remote.walkErrors,
  }
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
async function scanFacts(root: string, signal?: AbortSignal, workers?: AstWorkerPool, capture = false) {
  const { files, projectFiles, pythonFiles, cargoFiles, goFiles, truncated, walkErrors } = await collectCandidates(root, signal)
  if (capture) return scanFactsForCapture(root, files, { projectFiles, pythonFiles, cargoFiles, goFiles, truncated, walkErrors }, signal)
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
  // One batched round trip replaces the per-file statSync loop, which dominates
  // a repeat query. A stamp the sidecar cannot produce (missing path, unreadable
  // directory) falls back to the local call so the `stat_failed` diagnostic
  // keeps the same message as before. `indexerReady` is what makes
  // `DSH_FORGE_INDEXER=0` mean "no sidecar at all", statistics included.
  const sidecar = files.length > 0 && indexerTraceWanted() && await indexerReady({ signal })
  const remote = sidecar ? await indexerStatPaths(files.map(file => file.abs), signal) : null
  for (let index = 0; index < files.length; index++) {
    const { abs, rel } = files[index]
    signal?.throwIfAborted()
    try {
      const stat = remote?.[index] ?? statSync(abs)
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
  const native = sidecar && missing.length > 0
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

/**
 * The formal capture read (M1.1).
 *
 * Deliberately separate from the fast scanner rather than a flag inside it.
 * The fast path is optimized for reuse: it consults the stat cache, hands whole
 * languages to the sidecar and remembers what it parsed. A capture must do the
 * opposite of every one of those things — read each file itself, extract from
 * the exact bytes it read, and never take a cached fact as this content —
 * because the hash it records is a promise about those bytes.
 *
 * Files are read sequentially: memory is the constraint here (a 256 MiB capture
 * read would be a 256 MiB live set if it went parallel), and capture is an
 * explicit, occasional action rather than a per-query cost.
 */
async function scanFactsForCapture(
  root: string,
  files: Array<{ abs: string; rel: string }>,
  context: { projectFiles: string[]; pythonFiles: string[]; cargoFiles: string[]; goFiles: string[]; truncated: boolean; walkErrors: number },
  signal?: AbortSignal,
) {
  let rootIdentity: string | null = null
  try { rootIdentity = realpathSync(root) } catch { /* walkErrors reports an inaccessible root */ }
  const entries = new Map<string, TraceFileFacts>()
  const captures = new Map<string, CapturedFile>()
  const diagnostics: TraceDiagnostic[] = []
  const budget = captureReadBudget()
  let parseErrors = 0, partialFiles = 0, capturedBytes = 0, truncated = context.truncated
  for (const { abs, rel } of files) {
    signal?.throwIfAborted()
    const binary = BINARY_EXTENSIONS.has(path.extname(abs).toLowerCase())
    const cap = binary ? MAX_BINARY_BYTES : PER_FILE_BYTES
    let before
    try {
      before = statSync(abs)
    } catch (cause) {
      parseErrors++
      diagnostics.push({ path: rel, reason: 'stat_failed', message: cause instanceof Error ? cause.message : String(cause) })
      continue
    }
    if (before.size > cap) {
      parseErrors++
      diagnostics.push({ path: rel, reason: 'file_too_large', message: '文件超过 Trace 单文件读取上限。' })
      continue
    }
    if (capturedBytes + before.size > budget) {
      truncated = true
      diagnostics.push({ path: rel, reason: 'capture_budget', message: `捕获读取超过 ${(budget / 1048576).toFixed(1)} MiB 预算，其余文件未读取。` })
      break
    }
    let raw: Buffer
    try {
      raw = readBoundedFile(abs, cap)
    } catch (cause) {
      parseErrors++
      diagnostics.push({ path: rel, reason: 'read_failed', message: cause instanceof Error ? cause.message : String(cause) })
      continue
    }
    capturedBytes += raw.length
    // The bytes above may be a torn read: a writer can replace the file between
    // the stat and the read. Re-stating is what lets the baseline notice, and a
    // capture that noticed is not content-bound.
    let stable = true
    try {
      const after = statSync(abs)
      stable = after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs
    } catch {
      stable = false
    }
    if (!stable) {
      partialFiles++
      diagnostics.push({ path: rel, reason: 'capture_unstable', message: '捕获读取期间文件发生变化，本文件的事实不作为内容基线。' })
      continue
    }
    const outcome = await extractTraceFileFromBytes(abs, raw, { strict: true })
    parseErrors += outcome.parseErrors
    partialFiles += outcome.partialFiles
    for (const issue of outcome.diagnostics ?? []) diagnostics.push({ ...issue, path: rel })
    if (outcome.parseErrors === 0) captures.set(rel, { path: rel, rawHash: outcome.rawHash, textHash: outcome.textHash, bytes: raw.length })
    if (outcome.value) entries.set(rel, outcome.value)
  }
  return {
    entries,
    projectFiles: context.projectFiles,
    pythonFiles: context.pythonFiles,
    cargoFiles: context.cargoFiles,
    goFiles: context.goFiles,
    diagnostics,
    scanned: files.length,
    truncated,
    parseErrors,
    partialFiles,
    walkErrors: context.walkErrors,
    captures,
    capturedBytes,
    signature: JSON.stringify([rootIdentity, [...captures.values()].map(file => [file.path, file.rawHash]), truncated, context.walkErrors]),
  }
}

/** One line for a capture reply. Silence would let a caller believe the fast
 *  path ran; saying "persisted: false, here is why" is the whole point. */
function captureHeader(capture: AssembledTrace['capture']): string {
  if (!capture) return ''
  const scope = `捕获 ${capture.files} 文件 · ${(capture.bytes / 1024).toFixed(0)} KB`
  if (capture.persisted) {
    return `- ${scope} · 已保存内容基线（content-bound；快照 ID 可用于改动前后比较）${capture.evicted ? ` · 已轮换最旧基线 ${capture.evicted}` : ''}`
  }
  return `- ${scope} · ⚠️ 未保存基线：${capture.saveError ?? '未知原因'}；本次结果只描述当前状态`
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
  /** Which snapshot answered (M0.4): resolvable through
   *  {@link lookupTraceSnapshot}, never assumed current. */
  snapshot: TraceSnapshotMeta
  /** Set only on a capture (`capture=true`): what was read and whether the
   *  baseline reached disk. Absent means this was an ordinary fast-path scan. */
  capture?: {
    files: number
    bytes: number
    persisted: boolean
    path?: string
    evicted?: string
    saveError?: string
  }
}

export interface TraceAssemblyOptions {
  declarations?: string
  compileCommands?: string
  signal?: AbortSignal
  workers?: AstWorkerPool
  /** Read every file as bytes and persist a content-bound baseline (M1.1).
   *  Bypasses the warm-graph cache and the sidecar: the hash must describe the
   *  bytes that were parsed, and no cached fact qualifies. */
  capture?: boolean
}
interface GraphProbe { exists: boolean; identity: string | null }
const GRAPH_CACHE = new Map<string, { signature: string; decls: string; contexts: Array<ProjectContext | undefined>; probes: Map<string, GraphProbe>; assembled: AssembledTrace }>()
interface PendingAssembly { controller: AbortController; users: number; promise: Promise<AssembledTrace> }
const PENDING = new Map<string, Map<AstWorkerPool | undefined, PendingAssembly>>()

/**
 * Process-local registry of built graphs, addressed by unguessable snapshot ID.
 *
 * Four per workspace: a query session rarely needs more than "the before one"
 * and "the current one" per configuration, and an unbounded registry would pin
 * whole graphs (real repos are hundreds of MB) for the life of the process.
 */
const SNAPSHOTS = new TraceSnapshots<AssembledTrace>({ perWorkspace: 4, total: 16 })

/** Look a snapshot up by ID inside one workspace; a miss never falls back to
 *  another cached graph. `workspace` is the same root the query was made in. */
export function lookupTraceSnapshot(workspace: string, snapshotId: string) {
  return SNAPSHOTS.get(snapshotId, path.resolve(workspace))
}

/** Test/diagnostic hook: the snapshots currently held for one workspace. */
export function traceSnapshots(workspace: string, configKey?: string): TraceSnapshotMeta[] {
  return SNAPSHOTS.list(path.resolve(workspace), configKey)
}

/** Passive snapshot counts for `/forge-status` (M0.5).
 *
 *  Answers "is there a graph I could reuse, and from when" without building a
 *  graph: no scan, no sidecar spawn, no filesystem walk beyond reading the
 *  in-memory registry. A workspace with no snapshots reports zero, not an error.
 */
export function traceSnapshotStatus(workspace: string | undefined): {
  snapshots: number
  configurations: number
  liveCursors: number
  newest: string | null
} {
  if (!workspace) return { snapshots: 0, configurations: 0, liveCursors: 0, newest: null }
  const metas = SNAPSHOTS.list(path.resolve(workspace))
  const now = Date.now()
  let liveCursors = 0
  for (const cursor of PAGE_CURSORS.values()) if (cursor.expires > now && cursor.workspace === path.resolve(workspace)) liveCursors++
  return {
    snapshots: metas.length,
    configurations: new Set(metas.map(meta => meta.configKey)).size,
    liveCursors,
    newest: metas.length ? metas[metas.length - 1].createdAt : null,
  }
}

/** Drop every stored snapshot (tests and explicit cache resets). */
export function resetTraceSnapshots(): void {
  SNAPSHOTS.clear()
  PAGE_CURSORS.clear()
}

export type BeforeEvidence =
  | { ok: true; snapshotId: string; rawHash: string; source: 'capture'; createdAt: string }
  | { ok: false; reason: 'unavailable' | 'not_covered' | 'drift' | 'observed_only'; detail: string }

/**
 * Validate a snapshot ID offered as *before* evidence for one file edit (M1.1).
 *
 * The caller is about to write, and an edit that says "verified against
 * snapshot X" is claiming the write happened to the file X described. Three
 * things can make that claim false, and each has its own answer:
 *
 *   - the snapshot is gone or belongs elsewhere → `unavailable`;
 *   - the capture never read this file → `not_covered` (a baseline that did not
 *     see the file cannot have a surprise about it);
 *   - the bytes on disk are not the bytes that were captured → `drift`.
 *
 * An ordinary in-process snapshot (`strength: observed`) is *not* enough: it
 * checked a file set and resolution probes, never the contents, so it has no
 * per-file hash to compare. That is `observed_only`, which points at `capture`.
 *
 * Returning `ok` does not mean the edit is correct — only that the before-hash
 * exists and still matches. Nothing here reads the graph.
 */
export function resolveBeforeEvidence(workspace: string, snapshotId: string, absoluteFile: string): BeforeEvidence {
  const root = path.resolve(workspace)
  const relative = path.relative(root, absoluteFile).split(path.sep).join('/')
  if (relative.startsWith('../') || path.isAbsolute(relative)) {
    return { ok: false, reason: 'not_covered', detail: `文件 ${absoluteFile} 不在工作区 ${root} 内，无法用该快照的基线校验` }
  }
  const inProcess = SNAPSHOTS.get(snapshotId, root)
  const stored = loadBaseline(root, snapshotId)
  if (stored.ok) {
    const baseline = stored.baseline
    const recorded = baseline.files.find(file => file.path === relative)
    if (!recorded) {
      return { ok: false, reason: 'not_covered', detail: `基线 ${snapshotId} 未覆盖 ${relative}（捕获时该文件不存在、被跳过或超限）；请重新捕获或省略 snapshotId` }
    }
    let current: string | null = null
    try { current = sha256Hex(readFileSync(absoluteFile)) } catch { current = null }
    if (current !== recorded.rawHash) {
      return {
        ok: false, reason: 'drift',
        detail: current === null
          ? `${relative} 在捕获后已被删除，不能作为该基线的编辑对象`
          : `${relative} 在捕获后已改变（捕获 ${recorded.rawHash.slice(0, 12)}… ≠ 现在 ${current.slice(0, 12)}…）；请重新捕获或以普通编辑提交`,
      }
    }
    return { ok: true, snapshotId, rawHash: recorded.rawHash, source: 'capture', createdAt: baseline.createdAt }
  }
  if (inProcess.status === 'ok') {
    return {
      ok: false, reason: 'observed_only',
      detail: `快照 ${snapshotId} 是 observed 强度（只校验了文件集合，没有逐文件内容身份），无法校验 beforeHash；请用 fftrace capture=true 生成内容基线`,
    }
  }
  return { ok: false, reason: 'unavailable', detail: `${snapshotId}：${stored.detail}` }
}

/** Rows per page. A reply is re-read by every later call, so a page has to stay
 *  small enough to be worth its bytes; 500 is the ceiling that still fits. */
const PAGE_ROWS_DEFAULT = 100
const PAGE_ROWS_MAX = 500
/** A cursor outlives a slow edit session, not the day. */
const PAGE_CURSOR_TTL = 30 * 60 * 1000
const PAGE_CURSOR_CAP = 64

interface PageCursorEntry {
  workspace: string
  /** The snapshot the rows were computed from. Every later page re-reads it. */
  snapshotId: string
  query: RowQuery
  offset: number
  limit: number
  expires: number
}

/**
 * Live page cursors, keyed by an unguessable ID.
 *
 * Deliberately not an offset the client may send: an arbitrary offset lets a
 * caller skip the range check (and skip past a row cap that was never applied).
 * A cursor names one query against one snapshot; the offset lives here.
 */
const PAGE_CURSORS = new Map<string, PageCursorEntry>()

function pageLimit(value: unknown): number | null {
  if (value === undefined) return PAGE_ROWS_DEFAULT
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null
  return Math.min(value, PAGE_ROWS_MAX)
}

function registerPageCursor(entry: Omit<PageCursorEntry, 'expires'>): string {
  const now = Date.now()
  for (const [id, cursor] of PAGE_CURSORS) if (cursor.expires <= now) PAGE_CURSORS.delete(id)
  while (PAGE_CURSORS.size >= PAGE_CURSOR_CAP) {
    const oldest = [...PAGE_CURSORS].sort((a, b) => a[1].expires - b[1].expires)[0]
    PAGE_CURSORS.delete(oldest[0])
  }
  const id = randomBytes(9).toString('hex')
  PAGE_CURSORS.set(id, { ...entry, expires: now + PAGE_CURSOR_TTL })
  return id
}

function readPageCursor(id: string): PageCursorEntry | null {
  const entry = PAGE_CURSORS.get(id)
  if (!entry) return null
  if (entry.expires <= Date.now()) {
    PAGE_CURSORS.delete(id)
    return null
  }
  return entry
}

/** Whether a cursor addresses the same query a call is asking for. A cursor
 *  reused with a different target is a caller bug, not a page 2. */
function samePageQuery(query: RowQuery, kind: string, value: string, edgeMode: EdgeMode): boolean {
  if (query.kind !== kind || query.value !== value) return false
  if (query.kind === 'exposes') return true
  return query.edgeMode === edgeMode
}

/** The rows the paging layer owns, for kinds whose replies can exceed a page. */
function pageQueryOf(kind: string, value: string, edgeMode: EdgeMode): RowQuery | null {
  if (kind === 'exposes') return { kind: 'exposes', value }
  if (kind === 'impact') return { kind: 'impact', value, edgeMode }
  if (kind === 'file') return { kind: 'file', value, edgeMode }
  return null
}

function renderPage(input: {
  title: string
  rows: RowSet
  limit: number
  offset: number
  /** Cursor for the next page, when one exists. */
  next: string | null
  /** The page came from a graph that is no longer current. */
  stale: { snapshotId: string } | null
  /** Total across all pages; `rows.rows.length`. */
  total: number
}): string {
  const { title, rows, limit, offset, next, stale, total } = input
  const shown = rows.rows.slice(offset, offset + limit)
  const lines = [
    `## ${title}`,
    `- 共 ${total} 行 · 本页 ${shown.length} 行（第 ${offset + 1}–${offset + shown.length} 行，页大小 ${limit}）`,
    `- 遍历：${rows.traversalComplete ? '完成' : '⚠️ 达到遍历预算，仅覆盖已遍历范围'} · 结果：${rows.resultComplete ? '完整' : '⚠️ 受预算限制'}`,
    ...(rows.limitations.length ? [`- 口径：${rows.limitations.map(limit => limit.reason).join('、')}`] : []),
    ...(stale
      ? [`- ⚠️ 本页来自旧快照 \`${stale.snapshotId}\`（stale）：只能用于回顾旧证据，不可作为当前修改计划的依据。需要当前结果请重新查询。`]
      : []),
    '### 行',
    ...shown.map(rowText),
    ...(!shown.length ? ['- 本页为空（偏移已超出结果范围）。'] : []),
    ...(next ? [`- 后续：带上 cursor=${next} 获取下一页。`] : ['- 已是最后一页。']),
  ]
  return lines.join('\n')
}


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
  const capture = options.capture === true
  const decls = await loadPreloadDecls(root, options.declarations, options.signal)
  const scan = await scanFacts(root, options.signal, options.workers, capture)
  // One pass over the facts answers everything the five loaders need to be
  // called or skipped. The JS file-reference map needed a pass of its own
  // anyway, and the other four only ever asked one question each.
  let hasNative = false, hasJs = false, hasRust = false, hasGo = false
  const pythonSources: string[] = []
  const jsRefs = new Map<string, ReturnType<typeof jsReferences>>()
  for (const [rel, entry] of scan.entries) {
    if (entry.kind === 'source') {
      if (entry.lang === 'c' || entry.lang === 'cpp') hasNative = true
      else if (entry.lang === 'python') pythonSources.push(rel)
      else if (entry.lang === 'rust') hasRust = true
      else if (entry.lang === 'go') hasGo = true
    } else if (entry.kind === 'js') {
      hasJs = true
      // Program membership expands through TS/JS file references only; HTML and
      // component scripts never join a tsc program.
      const refs = jsReferences(entry)
      if (refs.length) jsRefs.set(rel, refs)
    } else if (entry.kind === 'html' || entry.kind === 'component') hasJs = true
  }
  const compilation = hasNative || options.compileCommands ? loadCompilationDatabase(root, options.compileCommands, options.signal) : undefined
  const project = hasJs ? loadJsProject(root, scan.projectFiles, options.signal, new Set(scan.entries.keys()), jsRefs) : undefined
  const cached = GRAPH_CACHE.get(key)
  const declsKey = JSON.stringify(decls)
  const python = pythonSources.length ? loadPythonProject(root, scan.pythonFiles, pythonSources, options.signal) : undefined
  const rust = hasRust && scan.cargoFiles.length ? loadRustProject(root, scan.cargoFiles, options.signal) : undefined
  const go = hasGo && scan.goFiles.length ? loadGoProject(root, scan.goFiles, options.signal) : undefined
  // Fixed slot order: a context that disappears (undefined) must not match one that existed.
  const contexts: Array<ProjectContext | undefined> = [compilation, project, python, rust, go]
  // What was asked for — independent of what the scan happens to find. Digests
  // cover the *effective* inputs the graph used: the parsed declaration table
  // and the compilation database signature (which itself folds file identity
  // and content). Two configurations are never one key.
  const config = configIdentity({
    root,
    declarations: options.declarations ? path.resolve(root, options.declarations) : null,
    declarationsDigest: options.declarations ? sha256Hex(`${decls.status}\0${declsKey}`) : null,
    compileCommands: options.compileCommands ? path.resolve(root, options.compileCommands) : (compilation?.info?.path ?? null),
    compileCommandsDigest: compilation ? sha256Hex(compilation.signature) : null,
    contexts: {
      compilation: compilation?.signature,
      project: project?.signature,
      python: python?.signature,
      rust: rust?.signature,
      go: go?.signature,
    },
  })
  const configKey = configKeyOf(config)
  const native = !capture && indexerTraceWanted() && await indexerReady({ signal: options.signal })
  // A capture must never answer from a cached graph: its whole product is a hash
  // of the bytes it read *now*. The fast path is unaffected.
  if (!capture && cached && cached.signature === scan.signature && cached.decls === declsKey
    && cached.assembled.snapshot.configKey === configKey
    && contexts.every((context, index) => cached.contexts[index]?.signature === context?.signature && cached.contexts[index]?.valid() !== false)
    && scan.walkErrors === 0 && !scan.truncated) {
    // Resolution may probe ignored/non-JS files or missing paths. Revalidate
    // those too, so adding an asset or an index file invalidates the graph.
    // The sidecar decides when it can: the listings behind it are its kind of
    // work, and it reports "unavailable" (null) rather than guessing.
    const remote = native ? await indexerProbesUnchanged(root, cached.probes, options.signal) : null
    if (remote ?? probesUnchanged(root, cached.probes)) {
      // Same graph, same identity: keep its snapshot resolvable so the reply's
      // token does not point at a slot evicted while this query was running.
      SNAPSHOTS.restore(cached.assembled.snapshot, cached.assembled)
      return cached.assembled
    }
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
  const captured = capture ? (scan as { captures: Map<string, CapturedFile>; capturedBytes: number }).captures : undefined
  // A capture is only content-bound when every file it listed was read cleanly.
  // Truncation, a partial parse or an unstable read downgrade the claim instead
  // of being papered over by the files that happened to succeed.
  const contentBound = capture && captured !== undefined && !scan.truncated && scan.partialFiles === 0
  const assembled: AssembledTrace = { graph, decls, scanned: scan.scanned, truncated: scan.truncated, parseErrors: scan.parseErrors, partialFiles: scan.partialFiles, walkErrors: scan.walkErrors,
    diagnostics: [...scan.diagnostics, ...project?.issues ?? [], ...python?.issues ?? [], ...rust?.issues ?? [], ...go?.issues ?? []],
    ...(project ? { project: { configs: project.configs, workspacePackages: project.workspacePackages } } : {}),
    ...(compilation?.info ? { compilation: compilation.info } : {}),
    // Announced before the object exists (it carries its own ID) and committed
    // right after. A truncated scan still answers this query honestly; it is
    // simply not reusable, and the meta says so.
    snapshot: SNAPSHOTS.announce({
      config,
      configKey,
      files: scan.entries.keys(),
      probes: probes.size,
      scanned: scan.scanned,
      truncated: scan.truncated,
      strength: contentBound ? 'content-bound' : 'observed',
      // Capture never trusts the sidecar for facts: it has to hash the same
      // bytes it parsed, and the sidecar reports no content identity for its
      // input yet.
      provider: !capture && native ? 'native' : 'wasm',
    }),
  }
  SNAPSHOTS.put(assembled.snapshot, assembled)
  if (captured) {
    assembled.capture = {
      files: captured.size,
      bytes: (scan as { capturedBytes: number }).capturedBytes,
      persisted: false,
    }
    if (contentBound) {
      const files = [...captured.values()].sort((a, b) => a.path.localeCompare(b.path))
      const baseline: CaptureBaseline = {
        schema: 'trace-capture/1',
        snapshotId: assembled.snapshot.snapshotId,
        workspaceId: root,
        configKey,
        config,
        provider: 'wasm',
        providerVersion: 'wasm-content-bound',
        createdAt: assembled.snapshot.createdAt,
        strength: 'content-bound',
        files,
        fileSetDigest: fileSetDigestOf(files),
        probes: probes.size,
        scanned: scan.scanned,
        truncated: false,
        partialFiles: 0,
        capturedBytes: assembled.capture.bytes,
        facts: Object.fromEntries(scan.entries),
      }
      const saved = saveBaseline(baseline)
      if (saved.ok) {
        assembled.capture = { ...assembled.capture, persisted: true, path: saved.path, ...(saved.evicted ? { evicted: saved.evicted } : {}) }
      } else {
        assembled.capture = { ...assembled.capture, persisted: false, saveError: saved.detail }
      }
    } else {
      assembled.capture = {
        ...assembled.capture,
        saveError: `捕获不完整（截断=${scan.truncated}，部分解析=${scan.partialFiles}），不能作为内容基线保存`,
      }
    }
  }
  if (!capture && !scan.truncated && scan.walkErrors === 0) {
    GRAPH_CACHE.delete(key)
    GRAPH_CACHE.set(key, { signature: scan.signature, decls: declsKey, contexts, probes, assembled })
    if (GRAPH_CACHE.size > 4) GRAPH_CACHE.delete(GRAPH_CACHE.keys().next().value!)
  }
  return assembled
}

/** The most recently assembled graph for `root`, if one is still cached.
 *
 *  Deliberately no IO and no staleness check. Callers that must never block —
 *  the post-edit audit — want the graph *as it was*, and a snapshot taken one
 *  edit ago is exactly the right one for "who else references this file", since
 *  the edit changed this file, not its importers.
 *
 *  @returns the cached assembly, or `undefined` when no graph has been built.
 *    Never builds one: a cold audit is silently skipped, not paid for. */
export function peekTraceGraph(root: string): AssembledTrace | undefined {
  let found: AssembledTrace | undefined
  for (const [key, entry] of GRAPH_CACHE) {
    try {
      if (JSON.parse(key)[0] === root) found = entry.assembled
    } catch { /* a key this module did not write */ }
  }
  return found
}

/** Share overlapping scans, while each caller retains its own cancellation.
 *  Cancel shared work only when no caller is still waiting for it. */
export function assembleTraceGraph(root: string, options: TraceAssemblyOptions = {}): Promise<AssembledTrace> {
  options.signal?.throwIfAborted()
  root = path.resolve(root)
  const key = JSON.stringify([root, options.declarations ? path.resolve(root, options.declarations) : null, options.compileCommands ? path.resolve(root, options.compileCommands) : null, options.capture === true ? 'capture' : 'fast'])
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
      'Trace dependencies before changing code; read-only, never runs workspace code. Answers who breaks if a file changes, what a file imports, how A reaches B, where an IPC channel registers or a preload API lands, which globals preloads expose and who uses them, which scripts a page loads, where a name is defined, and FFI/binary exports. Targets: see the target parameter. Resolves tsconfig/jsconfig paths, baseUrl, project references, package exports/imports, re-export barrels and TS program membership; bare TS require() never joins a program. Covers JS/TS, HTML/Vue/Svelte, Python, Rust, C/C++, Go, Java, Lua and TS ambient declarations. Dynamic paths, external packages and generated code stay unresolved; edgeMode=certain drops candidates. ' +
      'ffi:<name> reports source declarations and PE/ELF/WASM exports as separate evidence, never a verified call chain. Optional compile_commands.json supplies C/C++ include flags, never running commands.',
    parameters: {
      target: { type: 'string', required: true, description: 'file:<path>, impact:<path>, path:<a> -> <b>, ipc:<channel>, api:<name>, global:<name>, page:<file.html>, exposes:<global-or-file> (empty = all), symbol:<name>, ffi:<name>.' },
      declarations: { type: 'string', description: 'Absolute or workspace-relative JSON file, ≤256KiB: {apis:[{name,channel,kind,roles}],roleGlobals?:{role:global}}; kind=query/command/subscription.' },
      compileCommands: { type: 'string', description: 'Compilation database JSON (≤8MiB); defaults to workspace compile_commands.json for C/C++. Reads include flags without executing commands.' },
      edgeMode: { type: 'string', enum: ['all', 'certain'], description: 'File dependency edges for file:/impact:/path:. all (default) includes labelled candidates; certain excludes them. Static certainty does not prove runtime execution.' },
      format: { type: 'string', enum: ['auto', 'summary', 'detail'], description: 'exposes: 视图：auto（默认）按规模分档，survey 折叠为每个 expose 一行，小桥接保留逐键站点；detail 展开全部逐键站点。' },
      limit: { type: 'integer', description: 'symbol: 最多返回的定义数（1-200，默认 50）；file:/impact:/exposes: 每页行数（1-500，默认 100）。' },
      cursor: { type: 'string', description: 'file:/impact:/exposes: 的后续页游标，取自上一页的 nextCursor；只能与同一 target/edgeMode 和同一 limit 一起使用，过期或换查询需重新发起。' },
      capture: { type: 'boolean', description: '正式捕获路径：逐文件读取字节、按同一份内容提取事实并保存内容基线（跨进程可用于改动前后比较）。绕过缓存与 sidecar，比普通查询慢；不完整时明确报错而不谎称基线。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          target: { type: 'string', required: true },
          edgeMode: { type: 'string' },
          snapshot: {
            type: 'object', additionalProperties: false, properties: {
              snapshotId: { type: 'string', required: true },
              configKey: { type: 'string', required: true },
              strength: { type: 'string', required: true, enum: ['observed', 'content-bound'] },
              provider: { type: 'string', required: true, enum: ['wasm', 'native'] },
              providerVersion: { type: 'string', required: true },
              files: { type: 'integer', required: true },
            },
          },
          capture: {
            type: 'object', additionalProperties: false, properties: {
              files: { type: 'integer', required: true },
              bytes: { type: 'integer', required: true },
              persisted: { type: 'boolean', required: true },
              path: { type: 'string' },
              evicted: { type: 'string' },
              saveError: { type: 'string' },
            },
          },
          text: { type: 'string', required: true },
          page: {
            type: 'object', additionalProperties: false, properties: {
              offset: { type: 'integer', required: true },
              returned: { type: 'integer', required: true },
              total: { type: 'integer', required: true },
              limit: { type: 'integer', required: true },
              nextCursor: { type: 'string' },
              stale: { type: 'boolean', required: true },
              snapshotId: { type: 'string', required: true },
              traversalComplete: { type: 'boolean', required: true },
              resultComplete: { type: 'boolean', required: true },
              limitations: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                reason: { type: 'string', required: true }, count: { type: 'integer' },
              } } },
            },
          },
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
        if (args.format !== undefined && args.format !== 'auto') return failure('format 不适用于 symbol: 查询。')
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
      if (args.format !== undefined && args.format !== 'auto' && args.format !== 'summary' && args.format !== 'detail') return failure('format 仅接受 auto / summary / detail。')
      const format: ExposesFormat = args.format === 'summary' || args.format === 'detail' ? args.format : 'auto'
      if (format !== 'auto' && target.kind !== 'exposes') return failure('format 只影响 exposes: 查询的视图。')
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
      // ---- paging: resolve the cursor before building anything -------------
      // A cursor names one query against one snapshot, and that snapshot is
      // looked up (and held) before the fresh assembly runs: an assembly may
      // evict the oldest snapshot in this workspace, and a page request must not
      // lose the very graph it was asked to continue.
      const pageSize = pageLimit(args.limit)
      if (pageSize === null) return failure('limit 必须是 1–500 的整数。')
      const pageQuery = pageQueryOf(target.kind, value, edgeMode)
      const cursorArg = typeof args.cursor === 'string' ? args.cursor.trim() : ''
      let cursorPage: { cursor: PageCursorEntry; stored: { meta: TraceSnapshotMeta; payload: AssembledTrace } } | null = null
      if (cursorArg) {
        if (!pageQuery) return failure('cursor 只适用于 file:/impact:/exposes: 的分页结果。')
        const cursor = readPageCursor(cursorArg)
        if (!cursor) return failure('分页游标不存在或已过期（30 分钟）；请重新发起查询。')
        if (cursor.workspace !== root) return failure('分页游标属于另一个工作区。')
        if (!samePageQuery(cursor.query, target.kind, value, edgeMode)) {
          return failure('分页游标属于另一个查询；请用原来的 target/edgeMode 重试，或重新发起查询。')
        }
        if (args.limit !== undefined && args.limit !== cursor.limit) {
          return failure('分页游标已固定页大小；继续翻页时不要改变 limit。')
        }
        const stored = lookupTraceSnapshot(root, cursor.snapshotId)
        if (stored.status !== 'ok') return failure('分页所用的快照已不可用（可能已被淘汰）；请重新发起查询。')
        cursorPage = { cursor, stored }
      }
      const assembled = await assembleTraceGraph(root, { declarations, compileCommands, signal: exec?.signal, workers, capture: args.capture === true })
      const { graph, decls, scanned, truncated, parseErrors, partialFiles, walkErrors, compilation, project } = assembled
      const result = trace(graph, target.kind, value, edgeMode, format)
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
      // Two lines, not eight. The scan scope, the confidence legend and the
      // candidate-edge policy are identical in every reply on a given repo, so
      // repeating them per call is a constant tax on a question that cannot
      // change them — and the same facts already travel in the structured
      // fields (scanned / decls / diagnostics / incomplete). Keep what the
      // answer depends on: coverage (so "not found" is never mistaken for
      // "absent"), edgeMode (the caller chose it), and anything that limits
      // trust in THIS answer.
      const scopeBits = [
        `${graph.stats.withFacts} 文件`,
        `${graph.stats.pages} 页面`,
        describeDecls(decls.status, decls.apis.length, decls.error),
        ...(derivedKeys ? [`${derivedKeys} 推导键`] : []),
        ...(truncated ? ['⚠️ 扫描截断'] : []),
        edgeMode === 'certain' ? '仅确定边' : '含候选边',
      ]
      const caveats = [
        ...(localUnresolved.length || externalUnresolved || issues.length
          ? [`${localUnresolved.length} 项本地未解析${externalUnresolved ? `（另有 ${externalUnresolved} 项外部包）` : ''}，${issues.length} 项文件/工程问题`]
          : []),
        ...(incomplete
          ? [`读取/解析失败 ${parseErrors} 处，部分解析 ${partialFiles} 文件，遍历失败 ${walkErrors} 处${truncated ? '，候选截断' : ''}${result.analysis?.complete === false ? '，查询遍历受限' : ''}${resolutionIncomplete ? '，存在配置或归属限制' : ''}${compilation?.status === 'failed' || compilation?.unsupported ? '，编译元数据不全' : ''}`]
          : []),
        ...(compilation ? [`编译数据库 ${compilation.status} · ${compilation.entries} 条${compilation.unsupported ? ` · ${compilation.unsupported} 条不支持` : ''}`] : []),
        ...(graph.resolutionLimited ? ['模块归属或 Java 继承成员解析达预算，推断已停止'] : []),
      ]
      // Issue paths stay: they name the files whose facts are unreliable, which
      // is actionable. The per-issue message is the same sentence every time, so
      // it is dropped — except on a collapsed row, where the message is the only
      // place the hidden count lives.
      const issueRows = collapseIssues(issues).slice(0, 3).map(issue =>
        `  - \`${issue.path}\` · ${issue.reason}${issue.path.endsWith('/…') ? ` · ${issue.message}` : ''}`)
      const header = [
        `- 范围：${scopeBits.join(' · ')}`,
        ...(caveats.length ? [`- 限制：${caveats.join('；')}。未找到仅表示已分析范围内无命中。`] : []),
        ...issueRows,
      ].join('\n')
      const [title, ...rest] = result.text.split('\n')
      const snapshotInfo = (meta: TraceSnapshotMeta) => ({
        snapshotId: meta.snapshotId,
        configKey: meta.configKey,
        strength: meta.strength,
        provider: meta.provider,
        providerVersion: meta.providerVersion,
        files: meta.files,
      })
      // ---- paging: rows, not text -----------------------------------------
      // A page must never be a re-slice of an already-truncated reply, and every
      // page reads the same snapshot so offsets stay aligned while the workspace
      // moves underneath.
      let paged: { text: string; page: Record<string, unknown>; snapshot: ReturnType<typeof snapshotInfo>; stale: boolean } | null = null
      if (cursorPage) {
        const { cursor, stored } = cursorPage
        // Pages after the first may only come from the snapshot the cursor
        // names. If the workspace has moved on, say so instead of merging the
        // two states into something that was never true.
        const stale = cursor.snapshotId !== assembled.snapshot.snapshotId
        // Keep the old snapshot retained while it is being browsed: the next
        // page request must find it again, not a fresh graph standing in.
        SNAPSHOTS.restore(stored.meta, stored.payload)
        const rows = collectRows(stored.payload.graph, cursor.query)
        const nextOffset = cursor.offset + cursor.limit
        const next = nextOffset < rows.rows.length
          ? registerPageCursor({ workspace: root, snapshotId: cursor.snapshotId, query: cursor.query, offset: nextOffset, limit: cursor.limit })
          : null
        const returned = Math.max(0, Math.min(cursor.limit, rows.rows.length - cursor.offset))
        paged = {
          text: renderPage({ title: title.replace(/^##\s*/, ''), rows, limit: cursor.limit, offset: cursor.offset, next, stale: stale ? { snapshotId: cursor.snapshotId } : null, total: rows.rows.length }),
          snapshot: snapshotInfo(stored.meta),
          stale,
          page: {
            offset: cursor.offset, returned, total: rows.rows.length, limit: cursor.limit,
            ...(next ? { nextCursor: next } : {}), stale,
            snapshotId: cursor.snapshotId,
            traversalComplete: rows.traversalComplete, resultComplete: rows.resultComplete,
            limitations: rows.limitations,
          },
        }
      } else if (pageQuery && !(target.kind === 'exposes' && format === 'summary')) {
        // An explicit format=summary asks for the collapsed view; overriding it
        // with rows would be answering a different question. An explicit `limit`
        // asks for rows, so it always gets them — even when they would fit in a
        // single page, because the overview is a summary, not the row list.
        const rows = collectRows(graph, pageQuery)
        if (args.limit !== undefined || rows.rows.length > pageSize) {
          const next = pageSize < rows.rows.length
            ? registerPageCursor({ workspace: root, snapshotId: assembled.snapshot.snapshotId, query: pageQuery, offset: pageSize, limit: pageSize })
            : null
          paged = {
            text: renderPage({ title: title.replace(/^##\s*/, ''), rows, limit: pageSize, offset: 0, next, stale: null, total: rows.rows.length }),
            snapshot: snapshotInfo(assembled.snapshot),
            stale: false,
            page: {
              offset: 0, returned: Math.min(pageSize, rows.rows.length), total: rows.rows.length, limit: pageSize,
              ...(next ? { nextCursor: next } : {}), stale: false,
              snapshotId: assembled.snapshot.snapshotId,
              traversalComplete: rows.traversalComplete, resultComplete: rows.resultComplete,
              limitations: rows.limitations,
            },
          }
        }
      }
      if (paged) {
        return {
          found: result.found,
          target: `${target.kind}:${value}`,
          edgeMode,
          text: paged.text,
          snapshot: paged.snapshot,
          ...(assembled.capture ? { capture: assembled.capture } : {}),
          page: paged.page,
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
          // A stale page describes a graph the workspace has left; pairing it
          // with the current analysis would assert a state that never existed.
          ...(!paged.stale && result.analysis ? { analysis: result.analysis } : {}),
          ...(!paged.stale && result.ffi ? { ffi: result.ffi } : {}),
          ...(truncated ? { truncated: true } : {}),
        }
      }
      return {
        found: result.found,
        target: `${target.kind}:${value}`,
        edgeMode,
        text: [title, captureHeader(assembled.capture), header, ...rest].filter(Boolean).join('\n'),
        snapshot: snapshotInfo(assembled.snapshot),
        ...(assembled.capture ? { capture: assembled.capture } : {}),
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
