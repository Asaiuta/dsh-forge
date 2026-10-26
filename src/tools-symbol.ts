/**
 * dsh-forge symbol implementations (stage 2): the outline and
 * workspace-definition searches that back `ff_read`'s `outline` and
 * `definitions` views, plus the grep→symbol weld. Thin over src/ast.ts — the
 * AST module owns all tree-sitter interaction; these only shape the values.
 *
 * These were two separate tools (`ff_outline` / `ff_find_symbol`) until the
 * 2026-10-15 surface merge. They shared `./ast.ts`, `path` and `symbol`
 * addresses, and `ff_outline`'s output *was* `ff_read`'s address format — so
 * they are now views of one read tool. The item shapes below are unchanged,
 * which keeps the model-facing text and the test assertions identical.
 *
 * Editing stays stage 3.
 *
 * @module dsh-forge/tools-symbol
 */

import path from 'node:path'
import { astWorkerAuto, astWorkerCount, parallelFind, type AstWorkerPool } from './ast-pool.ts'
import { indexerCanParse, indexerFindSymbols, indexerParseBatch, indexerReady } from './indexer-client.ts'
import ignore, { type Ignore } from 'ignore'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import {
  type SymbolParse,
  detectLanguage,
  enclosingSymbol,
  findSymbol,
  outlineView,
  parseFile,
  parseFileSearch,
  symbolOccurrences,
} from './ast.ts'
import {
  type ForgeExec,
  type ToolFailure,
  clampInt,
  globToRegExp,
  workdirOf,
  LINE_MAX_CHARS,
} from './core.ts'

function failure(error: string): ToolFailure {
  return { error }
}

function isFailure(value: unknown): value is ToolFailure {
  return typeof (value as ToolFailure).error === 'string'
}

function clip(text: string): string {
  return text.length > LINE_MAX_CHARS ? `${text.slice(0, LINE_MAX_CHARS)}…` : text
}

/** Resolve a tool path parameter to an absolute file path under the workspace. */
function resolveFilePath(exec: ForgeExec | undefined, raw: string): string {
  const abs = path.isAbsolute(raw) ? raw : path.resolve(workdirOf(exec), raw)
  return path.normalize(abs)
}

/**
 * Resolve the definitions view's search root. Mirrors the two branches of
 * `resolveScope` in src/tools.ts, but without the fff index: this tool walks
 * the disk itself, so `path` moves the walk rather than re-rooting a finder.
 *
 * A directory re-roots the walk (note `walkFiles` still refuses to DESCEND
 * into `node_modules` — point at that subtree directly to search it). A file
 * narrows the walk to that one file, which makes `glob` moot.
 */
function resolveSymbolRoot(
  exec: ForgeExec | undefined,
  raw: unknown,
): { root: string; only?: string } | ToolFailure {
  if (typeof raw !== 'string' || raw.trim() === '') return { root: workdirOf(exec) }
  const abs = resolveFilePath(exec, raw.trim())
  let st: { isDirectory(): boolean; isFile(): boolean }
  try {
    st = statSync(abs)
  } catch {
    return failure(`path not found: ${abs}`)
  }
  if (st.isDirectory()) return { root: abs }
  if (st.isFile()) return { root: path.dirname(abs), only: abs }
  return failure(`unsupported path kind: ${abs}`)
}

// ---------------------------------------------------------------------------
// Workspace walk (for the definitions view — independent of the fff index)
// ---------------------------------------------------------------------------

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor',
  'coverage', '.next', '__pycache__', '.venv', 'venv', 'tmp', '.cache',
])

/** Gitignore rules at each traversed directory, including file negations. */
function loadIgnorePatterns(root: string): Ignore | null {
  const patterns = ignore()
  const gitignore = path.join(root, '.gitignore')
  if (existsSync(gitignore)) {
    try {
      const content = readFileSync(gitignore, 'utf8')
      if (!content.trim()) return null
      patterns.add(content)
    } catch {
      // unreadable .gitignore → default ignores only
    }
  }
  return existsSync(gitignore) ? patterns : null
}

const FIND_SYMBOL_BUDGET_MS = 15_000

interface WalkHit {
  absPath: string
}

function* walkFiles(root: string, ignores: Ignore | null, deadline: number, base = root,
  inherited: Array<{ base: string; rules: Ignore }> = []): Generator<WalkHit | { skipped: true }> {
  const localRules = root === base ? ignores : loadIgnorePatterns(root)
  const rules = localRules ? [...inherited, { base: root, rules: localRules }] : inherited
  let entries: Array<import('node:fs').Dirent>
  try {
    entries = readdirSync(root, { withFileTypes: true }) as Array<import('node:fs').Dirent>
  } catch {
    return
  }
  for (const entry of entries) {
    if (performance.now() > deadline) {
      yield { skipped: true }
      return
    }
    const abs = path.join(root, entry.name)
    let ignored = false
    for (const scope of rules) {
      const local = path.relative(scope.base, abs).split(path.sep).join('/') + (entry.isDirectory() ? '/' : '')
      const test = scope.rules.test(local)
      if (test.ignored) ignored = true
      if (test.unignored) ignored = false
    }
    if (ignored) continue
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue
      yield* walkFiles(abs, ignores, deadline, base, rules)
    } else if (entry.isFile()) {
      if (!detectLanguage(abs)) continue
      yield { absPath: abs }
    }
  }
}

// ---------------------------------------------------------------------------
// outline view
// ---------------------------------------------------------------------------

/**
 * `ff_read view=outline`: definitions of ONE file, with current line ranges
 * and qualifiedName addresses that `view=body` accepts back. The item shape is
 * the one the former `ff_outline` tool returned, so the rendered text and the
 * existing assertions are unchanged.
 */
export async function outlineOf(
  exec: ForgeExec | undefined,
  rawPath: unknown,
  depthArg: unknown,
  kindArg: unknown,
): Promise<{ items: Array<Record<string, unknown>>; lang: string; partial?: boolean } | ToolFailure> {
  const raw = typeof rawPath === 'string' ? rawPath : ''
  if (raw.trim() === '') return failure('view=outline requires path')
  const abs = resolveFilePath(exec, raw)
  const observed = await exec?.beginNativeRead?.(abs)
  const parsed = await parseFile(abs, { readPath: observed?.path })
  if (parsed.error) return failure(parsed.error)
  const value = parsed.value!
  const depth = depthArg === undefined ? undefined : clampInt(depthArg, 99, 1, 20)
  const kind = typeof kindArg === 'string' && kindArg.trim() !== '' ? kindArg : undefined
  const items: Array<Record<string, unknown>> = outlineView(value.symbols, { depth, kind })
    .map(({ children, startOffset, endOffset, sharedDeclaration, listMember, commentStartOffset, ...item }) => item)
  await observed?.finish()
  return { items, lang: value.lang, ...(value.partial ? { partial: true } : {}) }
}

// ---------------------------------------------------------------------------
// definitions view
// ---------------------------------------------------------------------------

/**
 * Identity annotation: #occurrence = 1-based index of a definition among the
 * SAME (file, qualifiedName) group before kind/limit filtering. It survives
 * line drift, but declaration reordering changes occurrence numbers.
 *
 * `ff_read view=definitions`: symbol DEFINITIONS (not references) across a
 * search root. `path` re-roots that search anywhere on the host, including
 * subtrees the workspace excludes — node_modules, another drive, another
 * checkout. Item shape unchanged from the former `ff_find_symbol` tool.
 */
export async function findDefinitions(
  exec: ForgeExec | undefined,
  args: Record<string, unknown>,
  workers?: AstWorkerPool,
): Promise<{ items: Array<Record<string, unknown>>; stats: string; truncated?: boolean } | ToolFailure> {
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  if (name === '') return failure('name is required')
  const limit = clampInt(args.limit, 50, 1, 200)
  const kindFilter = typeof args.kind === 'string' && args.kind.trim() !== ''
    ? args.kind.split(',').map((k) => k.trim())
    : null
  const scope = resolveSymbolRoot(exec, args.path)
  if (isFailure(scope)) return scope
  const root = scope.root
  // A file scope is already maximally specific — a glob on top of it would
  // be tested against the bare basename and silently match nothing.
  const glob = scope.only === undefined && typeof args.glob === 'string' && args.glob.trim() !== ''
    ? globToRegExp(args.glob.trim())
    : null
  const ignores = loadIgnorePatterns(root)
  const started = performance.now()
  const deadline = started + FIND_SYMBOL_BUDGET_MS

  // Collect candidates once, then decide sequential vs parallel. Auto
  // parallelism engages only above a corpus floor so tiny workspaces never
  // pay worker-spawn latency; an explicit DSH_FORGE_AST_WORKERS value is
  // honoured regardless of size.
  const PARALLEL_MIN_FILES = 16
  const files: string[] = []
  let truncated = false
  for (const hit of walkFiles(root, ignores, deadline)) {
    if ('skipped' in hit) { truncated = true; break }
    if (scope.only !== undefined && hit.absPath !== scope.only) continue
    const relative = path.relative(root, hit.absPath).split(path.sep).join('/')
    if (!glob || glob.test(relative)) files.push(hit.absPath)
  }

  const items: Array<Record<string, unknown>> = []
  let filesScanned = 0
  const nativeOptions = { signal: exec?.signal, deadline: Date.now() + Math.max(0, deadline - performance.now()) }

  // Rust sidecar fast path: the sidecar matches the sidecar-supported subset
  // natively (one round trip, only hits serialized — a warm query pays a stat
  // per file, no re-parse), while any future unsupported languages keep
  // the WASM parse. Hits are merged back in walk order so the result lines up
  // exactly with the pure-WASM paths below. Any failure → fall through.
  if (await indexerReady(nativeOptions)) {
    const supported: string[] = []
    const unsupported = new Set<string>()
    for (const f of files) {
      if (indexerCanParse(detectLanguage(f))) supported.push(f)
      else unsupported.add(f)
    }
    if (supported.length > 0) {
      const result = await indexerFindSymbols(supported, name, kindFilter, nativeOptions)
      if (result) {
        const hitsByPath = new Map<string, Array<typeof result.items[number]>>()
        for (const hit of result.items) {
          const row = hitsByPath.get(hit.absPath)
          if (row) row.push(hit)
          else hitsByPath.set(hit.absPath, [hit])
        }
        let scanned = result.parsed
        outer:
        for (const abs of files) {
          exec?.signal?.throwIfAborted()
          if (performance.now() > deadline) { truncated = true; break }
          const rel = path.relative(root, abs).split(path.sep).join('/')
          const hits = hitsByPath.get(abs)
          if (hits) {
            for (const hit of hits) {
              items.push({
                file: rel,
                qualifiedName: hit.qualifiedName,
                kind: hit.kind,
                occurrence: hit.occurrence,
                startLine: hit.startLine,
                endLine: hit.endLine,
                ...(hit.commentStartLine !== undefined ? { commentStartLine: hit.commentStartLine } : {}),
                signature: clip(hit.signature),
              })
              if (items.length >= limit) { truncated = true; break outer }
            }
          } else if (unsupported.has(abs)) {
            const parsed = await parseFileSearch(abs)
            if (parsed.error || !parsed.value) continue
            scanned++
            const occurrences = symbolOccurrences(parsed.value.symbols)
            for (const sym of findSymbol(parsed.value.symbols, name, false)) {
              if (kindFilter && !kindFilter.includes(sym.kind)) continue
              items.push({
                file: rel,
                qualifiedName: sym.qualifiedName,
                kind: sym.kind,
                occurrence: occurrences.get(sym)!,
                startLine: sym.startLine,
                endLine: sym.endLine,
                ...(sym.commentStartLine !== undefined ? { commentStartLine: sym.commentStartLine } : {}),
                signature: clip(parsed.value.signatures.get(sym.startLine) ?? ''),
              })
              if (items.length >= limit) { truncated = true; break outer }
            }
          }
        }
        const elapsed = Math.round(performance.now() - started)
        return { items, stats: `scanned ${scanned} code files in ${elapsed}ms (rust sidecar)${truncated ? ', result truncated' : ''}`, ...(truncated ? { truncated: true } : {}) }
      }
    }
  }

  const useParallel = astWorkerCount() > 0 && (files.length >= PARALLEL_MIN_FILES || !astWorkerAuto())

  if (useParallel) {
    try {
      const search = workers ? workers.find.bind(workers) : parallelFind
      const result = await search(files, name, kindFilter, Date.now() + Math.max(1, deadline - performance.now()), exec?.signal)
      for (const row of result.results) {
        if (row.parsed) filesScanned++
        for (const item of row.items) items.push({ ...item, file: path.relative(root, row.file).split(path.sep).join('/') })
      }
      truncated ||= result.timedOut || items.length > limit
      const elapsed = Math.round(performance.now() - started)
      const page = items.slice(0, limit)
      return { items: page, stats: `scanned ${filesScanned} code files in ${elapsed}ms (parallel WASM)${truncated ? ', result truncated' : ''}`, ...(truncated ? { truncated: true } : {}) }
    } catch (cause) { return failure(`parallel AST failed: ${cause instanceof Error ? cause.message : String(cause)}; set DSH_FORGE_AST_WORKERS=0 for sequential parsing`) }
  }

  outer:
  for (const abs of files) {
    exec?.signal?.throwIfAborted()
    if (performance.now() > deadline) { truncated = true; break }
    const rel = path.relative(root, abs).split(path.sep).join('/')
    const parsed = await parseFileSearch(abs)
    if (parsed.error || !parsed.value) continue
    filesScanned++
    const value = parsed.value
    const occurrences = symbolOccurrences(value.symbols)
    const matched = findSymbol(value.symbols, name, false)
    for (const sym of matched) {
      if (kindFilter && !kindFilter.includes(sym.kind)) continue
      items.push({
        file: rel,
        qualifiedName: sym.qualifiedName,
        kind: sym.kind,
        occurrence: occurrences.get(sym)!,
        startLine: sym.startLine,
        endLine: sym.endLine,
        ...(sym.commentStartLine !== undefined ? { commentStartLine: sym.commentStartLine } : {}),
        signature: clip(value.signatures.get(sym.startLine) ?? ''),
      })
      if (items.length >= limit) {
        truncated = true
        break outer
      }
    }
  }
  const elapsed = Math.round(performance.now() - started)
  const stats = `scanned ${filesScanned} code files in ${elapsed}ms${truncated ? ', result truncated' : ''}`
  return { items, stats, ...(truncated ? { truncated: true } : {}) }
}

// ---------------------------------------------------------------------------
// grep → symbol weld
// ---------------------------------------------------------------------------

/**
 * Attach the innermost enclosing symbol to each grep hit whose file is in a
 * supported language. Uses the search-track mtime+cache parse path, so repeated
 * hits in the same file cost one stat. Failures degrade silently (no annotation).
 */
export async function attachEnclosingSymbols(
  items: Array<{ file: string; line: number; in?: { name: string; startLine: number; endLine: number } }>,
  basePath: string,
): Promise<void> {
  const unique = [...new Set(items.map((i) => path.resolve(basePath, i.file)))]
  let sidecar: Map<string, SymbolParse> | null = null
  if (await indexerReady()) sidecar = await indexerParseBatch(unique)
  const parsedByPath = new Map<string, SymbolParse | null>()
  for (const item of items) {
    const key = item.file
    if (!parsedByPath.has(key)) {
      const abs = path.resolve(basePath, item.file)
      let value = sidecar?.get(abs) ?? null
      if (!value) {
        const parsed = await parseFileSearch(abs)
        value = parsed.value ?? null
      }
      parsedByPath.set(key, value)
    }
    const parsed = parsedByPath.get(key)
    if (!parsed) continue
    const enclosing = enclosingSymbol(parsed.symbols, item.line)
    if (enclosing) {
      item.in = { name: enclosing.qualifiedName, startLine: enclosing.startLine, endLine: enclosing.endLine }
    }
  }
}
