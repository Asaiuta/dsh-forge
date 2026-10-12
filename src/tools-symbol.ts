/**
 * dsh-forge symbol tools (stage 2): Outline / FindSymbol / symbol-addressed
 * read, plus the grep→symbol weld. Thin factories over src/ast.ts — the AST
 * module owns all tree-sitter interaction; these only shape tool I/O.
 *
 * Tool names carry the ff- prefix like the fff tools: one retrieval suite,
 * two engines. Editing stays stage 3.
 *
 * @module dsh-forge/tools-symbol
 */

import path from 'node:path'
import { astWorkerCount, parallelFind, type AstWorkerPool } from './ast-pool.ts'
import ignore, { type Ignore } from 'ignore'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import {
  type AstSymbol,
  type ParsedFile,
  detectLanguage,
  enclosingSymbol,
  findSymbol,
  outlineView,
  parseFile,
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

function text(value: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value }]
}

// ---------------------------------------------------------------------------
// Workspace walk (for FindSymbol — independent of the fff index)
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
// ff_outline
// ---------------------------------------------------------------------------

const SYMBOL_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    qualifiedName: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    startLine: { type: 'integer', required: true },
    endLine: { type: 'integer', required: true },
    commentStartLine: { type: 'integer' },
    level: { type: 'integer', required: true },
  },
} as const

export function createOutlineTool() {
  return {
    name: 'ff_outline',
    description:
      'List one file\'s definitions with current line ranges and qualifiedName addresses for ff_read_symbol. ' +
      'For workspace definitions use ff_find_symbol. Symbol tools support JS/TS/TSX/Python/Rust/Go/C/C++/Java/C#/Lua; other types use ffgrep/ff_read.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute/workspace-relative file.' },
      depth: { type: 'integer', description: 'Max nesting levels; 1=top level, omitted=all.' },
      kind: { type: 'string', description: 'Comma-separated kinds, e.g. "function,method".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: { type: 'array', required: true, items: SYMBOL_ITEM_SCHEMA },
          lang: { type: 'string', required: true },
          partial: { type: 'boolean' },
        },
      },
      render: (_args: unknown, value: { items: Array<AstSymbol & { level: number }>; lang: string; partial?: boolean }) => {
        if (value.items.length === 0) return text('no symbols found')
        const lines = value.items.map((s) => {
          const pad = '  '.repeat(s.level - 1)
          const range = s.commentStartLine !== undefined ? `L${s.commentStartLine}-${s.endLine}` : `L${s.startLine}-${s.endLine}`
          return `${pad}${s.qualifiedName} (${s.kind}) ${range}`
        })
        if (value.partial) lines.push('[parse had errors — ranges best-effort]')
        return text(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      const rawPath = typeof args.path === 'string' ? args.path : ''
      if (rawPath === '') return failure('path is required')
      const abs = resolveFilePath(exec, rawPath)
      const observed = await exec?.beginNativeRead?.(abs)
      const parsed = await parseFile(abs, { readPath: observed?.path })
      if (parsed.error) return failure(parsed.error)
      const value = parsed.value!
      const depth = args.depth === undefined ? undefined : clampInt(args.depth, 99, 1, 20)
      const kind = typeof args.kind === 'string' && args.kind.trim() !== '' ? args.kind : undefined
      const items = outlineView(value.symbols, { depth, kind }).map(({ children, startOffset, endOffset, sharedDeclaration, listMember, commentStartOffset, ...item }) => item)
      await observed?.finish()
      return { items, lang: value.lang, ...(value.partial ? { partial: true } : {}) }
    },
  } as const
}

// ---------------------------------------------------------------------------
// ff_find_symbol
// ---------------------------------------------------------------------------

/**
 * Identity annotation: #occurrence = 1-based index of a definition among the
 * SAME (file, qualifiedName) group before kind/limit filtering. It survives
 * line drift, but declaration reordering changes occurrence numbers.
 */
export function createFindSymbolTool(workers?: AstWorkerPool) {
  return {
    name: 'ff_find_symbol',
    description:
      'Find workspace symbol DEFINITIONS, not references (use ffgrep). Returns current ranges, signatures and occurrence addresses. ' +
      'Read hits with ff_read_symbol, or ff_read for a batch. Same languages as ff_outline.',
    parameters: {
      name: { type: 'string', required: true, description: 'Simple/qualified name, e.g. putBlob, Store.putBlob or Store::put_blob.' },
      kind: { type: 'string', description: 'Comma-separated kinds, e.g. "function,method".' },
      glob: { type: 'string', description: 'File glob, e.g. "src/**/*.ts"; omitted=whole workspace.' },
      limit: { type: 'integer', description: 'Max definitions; default 50, max 200.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string', required: true },
                qualifiedName: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                startLine: { type: 'integer', required: true },
                endLine: { type: 'integer', required: true },
                commentStartLine: { type: 'integer' },
                occurrence: { type: 'integer', required: true },
                signature: { type: 'string', required: true },
              },
            },
          },
          stats: { type: 'string', required: true },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args: unknown, value: { items: Array<Record<string, unknown>>; stats: string; truncated?: boolean }) => {
        if (value.items.length === 0) return text(`no definitions matched (${value.stats})`)
        const lines = value.items.map((s) =>
          `${s.file}#${s.qualifiedName} (${s.kind}) L${s.startLine}-${s.endLine}${Number(s.occurrence) > 1 ? ` #${s.occurrence}` : ''}`,
        )
        lines.push(`[${value.stats}]`)
        return text(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (name === '') return failure('name is required')
      const limit = clampInt(args.limit, 50, 1, 200)
      const kindFilter = typeof args.kind === 'string' && args.kind.trim() !== ''
        ? args.kind.split(',').map((k) => k.trim())
        : null
      const glob = typeof args.glob === 'string' && args.glob.trim() !== '' ? globToRegExp(args.glob.trim()) : null
      const root = workdirOf(exec)
      const ignores = loadIgnorePatterns(root)
      const deadline = performance.now() + FIND_SYMBOL_BUDGET_MS

      const items: Array<Record<string, unknown>> = []
      let filesScanned = 0
      let truncated = false
      if (astWorkerCount() > 0) {
        const files: string[] = []
        for (const hit of walkFiles(root, ignores, deadline)) {
          if ('skipped' in hit) { truncated = true; break }
          const relative = path.relative(root, hit.absPath).split(path.sep).join('/')
          if (!glob || glob.test(relative)) files.push(hit.absPath)
        }
        try {
          const search = workers ? workers.find.bind(workers) : parallelFind
          const result = await search(files, name, kindFilter, Date.now() + Math.max(1, deadline - performance.now()), exec?.signal)
          for (const row of result.results) {
            if (row.parsed) filesScanned++
            for (const item of row.items) items.push({ ...item, file: path.relative(root, row.file).split(path.sep).join('/') })
          }
          truncated ||= result.timedOut || items.length > limit
          const elapsed = Math.round(performance.now() - (deadline - FIND_SYMBOL_BUDGET_MS))
          const page = items.slice(0, limit)
          return { items: page, stats: `scanned ${filesScanned} code files in ${elapsed}ms (parallel WASM)${truncated ? ', result truncated' : ''}`, ...(truncated ? { truncated: true } : {}) }
        } catch (cause) { return failure(`parallel AST failed: ${cause instanceof Error ? cause.message : String(cause)}; set DSH_FORGE_AST_WORKERS=0 for sequential parsing`) }
      }

      outer:
      for (const hit of walkFiles(root, ignores, deadline)) {
        exec?.signal?.throwIfAborted()
        if ('skipped' in hit) {
          truncated = true
          break
        }
        const rel = path.relative(root, hit.absPath).split(path.sep).join('/')
        if (glob && !glob.test(rel)) continue
        const parsed = await parseFile(hit.absPath)
        if (parsed.error || !parsed.value) continue
        filesScanned++
        const file = parsed.value
        const occurrences = symbolOccurrences(file.symbols)
        const matched = findSymbol(file.symbols, name, false)
        for (const sym of matched) {
          if (kindFilter && !kindFilter.includes(sym.kind)) continue
          const lines = file.text.split('\n')
          items.push({
            file: rel,
            qualifiedName: sym.qualifiedName,
            kind: sym.kind,
            occurrence: occurrences.get(sym)!,
            startLine: sym.startLine,
            endLine: sym.endLine,
            ...(sym.commentStartLine !== undefined ? { commentStartLine: sym.commentStartLine } : {}),
            signature: clip(lines[sym.startLine - 1] ?? ''),
          })
          if (items.length >= limit) {
            truncated = true
            break outer
          }
        }
      }
      const elapsed = Math.round(performance.now() - (deadline - FIND_SYMBOL_BUDGET_MS))
      const stats = `scanned ${filesScanned} code files in ${elapsed}ms${truncated ? ', result truncated' : ''}`
      return { items, stats, ...(truncated ? { truncated: true } : {}) }
    },
  } as const
}

// ---------------------------------------------------------------------------
// ff_read_symbol
// ---------------------------------------------------------------------------

export function createReadSymbolTool() {
  return {
    name: 'ff_read_symbol',
    description:
      'Read one current definition with its leading comment. Use occurrence/line to resolve same-name candidates; use ff_read for batches or line ranges. ' +
      'Same languages as ff_outline. Read before editing.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute/workspace-relative file.' },
      symbol: { type: 'string', required: true, description: 'Simple/qualified name from ff_find_symbol/ff_outline.' },
      body: { type: 'boolean', description: 'Drop leading comment, keeping signature; default false.' },
      context: { type: 'integer', description: 'Lines around definition, 0-20; default 0.' },
      line: { type: 'integer', description: '1-based declaration line hint; nearest match wins.' },
      occurrence: { type: 'integer', description: '1-based same-name declaration index; overrides line. Re-query after declarations reorder.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', required: true },
          qualifiedName: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          startLine: { type: 'integer', required: true },
          endLine: { type: 'integer', required: true },
          occurrence: { type: 'integer', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: { file: string; qualifiedName: string; startLine: number; endLine: number; occurrence: number; text: string }) =>
        text(`${value.file}#${value.qualifiedName} L${value.startLine}-${value.endLine} (#${value.occurrence})\n${value.text}`),
    },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      const rawPath = typeof args.path === 'string' ? args.path : ''
      const symbol = typeof args.symbol === 'string' ? args.symbol : ''
      if (rawPath === '') return failure('path is required')
      if (symbol === '') return failure('symbol is required')
      const abs = resolveFilePath(exec, rawPath)
      const observed = await exec?.beginNativeRead?.(abs)
      const parsed = await parseFile(abs, { readPath: observed?.path })
      if (parsed.error) return failure(parsed.error)
      const file = parsed.value!
      const body = args.body === true
      const context = clampInt(args.context, 0, 0, 20)
      const lineHint = args.line === undefined ? undefined : clampInt(args.line, 0, 0, 10_000_000)
      const occurrenceHint = args.occurrence === undefined ? undefined : clampInt(args.occurrence, 0, 0, 1_000_000)

      const candidates = findSymbol(file.symbols, symbol, false)
      // A returned qualifiedName is an address, including top-level names.
      // Prefer its exact group before falling back to broad name discovery.
      const qualified = candidates.filter(item => item.qualifiedName.replace(/::/g, '.') === symbol.trim().replace(/::/g, '.'))
      let matches = qualified.length ? qualified : candidates
      if (matches.length === 0) return failure(`symbol "${symbol}" not found in ${rawPath}`)
      // Identity layer: occurrence indexes same-name definitions by declaration
      // order — stable under line drift, reassigned when declaration order
      // changes. Positional layer: line hint stays as
      // the convenience alternative.
      const ordered = [...matches].sort((a, b) => a.startOffset - b.startOffset)
      if (ordered.length > 1 && occurrenceHint !== undefined) {
        const picked = ordered[occurrenceHint - 1]
        if (!picked) {
          return failure(`occurrence ${occurrenceHint} out of range: "${symbol}" has ${ordered.length} definitions in ${rawPath} — ` +
            ordered.map((m, i) => `#${i + 1} ${m.qualifiedName} L${m.startLine}`).join(', '))
        }
        matches = [picked]
      } else if (matches.length > 1 && lineHint !== undefined) {
        const nearest = [...matches].sort((a, b) => Math.abs(a.startLine - lineHint) - Math.abs(b.startLine - lineHint))[0]
        matches = [nearest]
      }
      if (matches.length > 1) {
        return {
          error: `symbol "${symbol}" is ambiguous in ${rawPath} (${matches.length} definitions) — candidates: ` +
            ordered.map((m, i) => `#${i + 1} ${m.qualifiedName} L${m.startLine}`).join(', ') +
            ' — re-send with occurrence=<n> (line-independent) or line=<approx line> to pick one',
        }
      }
      const sym = matches[0]
      const resolvedOccurrence = ordered.length > 1 ? ordered.indexOf(sym) + 1 : 1
      const start = body || sym.commentStartLine === undefined ? sym.startLine : sym.commentStartLine
      const lines = file.text.split('\n')
      const from = Math.max(0, start - 1 - (context > 0 ? context : 0))
      const to = Math.min(lines.length, sym.endLine + context)
      const textOut = lines.slice(from, to).join('\n')
      await observed?.finish()
      return {
        file: rawPath,
        qualifiedName: sym.qualifiedName,
        kind: sym.kind,
        startLine: start,
        endLine: sym.endLine,
        occurrence: resolvedOccurrence,
        text: textOut,
      }
    },
  } as const
}

// ---------------------------------------------------------------------------
// grep → symbol weld
// ---------------------------------------------------------------------------

/**
 * Attach the innermost enclosing symbol to each grep hit whose file is in a
 * supported language. Uses the content-anchored parse cache, so repeated hits
 * in the same file cost one parse. Failures degrade silently (no annotation).
 */
export async function attachEnclosingSymbols(
  items: Array<{ file: string; line: number; in?: { name: string; startLine: number; endLine: number } }>,
  basePath: string,
): Promise<void> {
  const parsedByPath = new Map<string, ParsedFile | null>()
  for (const item of items) {
    const key = item.file
    if (!parsedByPath.has(key)) {
      const abs = path.resolve(basePath, item.file)
      const parsed = await parseFile(abs)
      parsedByPath.set(key, parsed.value ?? null)
    }
    const parsed = parsedByPath.get(key)
    if (!parsed) continue
    const enclosing = enclosingSymbol(parsed.symbols, item.line)
    if (enclosing) {
      item.in = { name: enclosing.qualifiedName, startLine: enclosing.startLine, endLine: enclosing.endLine }
    }
  }
}
