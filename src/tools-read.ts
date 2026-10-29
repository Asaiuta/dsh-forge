/**
 * ff_read: the forge read tool. One addressing contract (`path`, `path#Symbol`,
 * `lines=`, `paths`, `glob`, `symbol`) under explicit file and byte budgets,
 * and three views over it:
 *
 *   view=body (default)  text of files, ranges or symbol bodies
 *   view=outline         one file's definitions with line ranges + addresses
 *   view=definitions     symbol DEFINITIONS across a whole search root
 *
 * `path` always answers "where to look", `symbol` always answers "which one",
 * and `view` decides whether the result is a **body** or a **definition set**.
 * That is why the outline and definitions views live here rather than in two
 * more tools: they share this module's addressing, and `view=outline` emits
 * exactly the addresses `view=body` consumes (measured 2026-10-15: the three
 * tools were 2,927 chars of schema, 1,027 of which was duplication).
 *
 * Plain reads only: multimodal stays with the built-in read tool, and symbol
 * addressing requires a supported AST language (else use lines=).
 *
 * Line numbers follow the forge contract (1-based, BOM-stripped, LF-normalized),
 * so output can be fed straight into ffedit coordinates.
 *
 * @module dsh-forge/tools-read
 */

import path from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import ignore from 'ignore'
import { findSymbol, parseFile } from './ast.ts'
import { findDefinitions, outlineOf } from './tools-symbol.ts'
import type { AstWorkerPool } from './ast-pool.ts'
import { clampInt, globToRegExp, parseLineRange, workdirOf, type ForgeExec, type ToolFailure } from './core.ts'
import { canonicalize, rangeForLines, rangeForSlice, type SourceRange } from './source-evidence.ts'

const MAX_FILES_DEFAULT = 20
const MAX_FILES_HARD = 100
const PER_FILE_LINE_CAP = 4000
const PER_FILE_BYTE_CAP = 256 * 1024

/**
 * Total bytes of file text one `ff_read` call may return inline.
 *
 * Sized against the host's spill policy, not the context window. The desktop
 * profile mounts `@deepseek-ai/dsh-spill-policy` with `maxInlineTokens: 12500`,
 * and that policy prices a text block as `ceil(chars / 4) + 4`
 * (`@deepseek-ai/dsh-token-meter/estimate`, `CHARS_PER_TOKEN = 4`). Any tool
 * result above ~49,984 characters is therefore rewritten into head and tail
 * halves plus a spill-file pointer. The built-in `read` tool is explicitly
 * exempt from that rewrite (`exec.name === 'read'`); forge's tools are not.
 *
 * Measured 2026-10-17: a five-file `ff_read` batch rendered 107,844 bytes, came
 * back cut at 49,930 with "Omitted 57914 bytes", and cost the model a second
 * call to read the spill — while forge's own skip notes, which say *what* was
 * left out and why, were lost to the host's blunt head/tail cut.
 *
 * 40 KB of source renders near 42 KB (~10.6k estimated tokens at 4 chars/token),
 * inside the 12,500 cap with margin, and still covers a normal multi-file
 * batch. Returning more buys nothing: the host rewrites it anyway.
 */
const TOTAL_BYTE_BUDGET = 40 * 1024

/**
 * Smallest remainder worth returning as a truncated block. Below this the
 * caller skips the target and says so, rather than emitting a stub the model
 * cannot act on.
 */
const MIN_TRUNCATED_BYTES = 1024

/** Human label for the inline budget, used in skip reasons and notes. */
const BUDGET_LABEL = `${Math.round(TOTAL_BYTE_BUDGET / 1024)}KB`
const GLOB_WALK_VISIT_CAP = 50_000

/** Definitions view has its own budget: many small hits, not many big files. */
const DEFINITIONS_LIMIT_DEFAULT = 50
const DEFINITIONS_LIMIT_MAX = 200

const VIEWS = ['body', 'outline', 'definitions'] as const
type ReadView = (typeof VIEWS)[number]

/**
 * Item shape shared by the outline and definitions views. The two produce
 * different subsets — outline carries `name`/`level`, definitions carries
 * `file`/`occurrence`/`signature` — so only the common four are required.
 */
const SYMBOL_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    qualifiedName: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    startLine: { type: 'integer', required: true },
    endLine: { type: 'integer', required: true },
    commentStartLine: { type: 'integer' },
    level: { type: 'integer' },
    file: { type: 'string' },
    occurrence: { type: 'integer' },
    signature: { type: 'string' },
  },
} as const

function isToolFailure(value: unknown): value is ToolFailure {
  return typeof (value as ToolFailure).error === 'string'
}

/** Read the `view` argument. Unknown values fall back to `body`, like an omitted one. */
function viewOf(args: unknown): ReadView {
  const raw = (args as { view?: unknown } | undefined)?.view
  return typeof raw === 'string' && (VIEWS as readonly string[]).includes(raw.trim())
    ? raw.trim() as ReadView
    : 'body'
}

/**
 * Which parameters each view actually honours.
 *
 * These used to be silently ignored when they did not apply — a `lines` window
 * sent with `view=outline` returned the whole outline with no sign the window
 * was dropped. A caller cannot tell a dropped argument from an honoured one, so
 * the window has to be a hard error instead (same rule as ffedit's `reason`).
 */
const VIEW_ARGS: Record<ReadView, readonly string[]> = {
  body: ['view', 'path', 'paths', 'glob', 'symbol', 'lines', 'body', 'context', 'line', 'occurrence', 'limit'],
  outline: ['view', 'path', 'depth', 'kind'],
  definitions: ['view', 'path', 'symbol', 'glob', 'kind', 'limit'],
}

/** Every name the tool knows, including the two built-in-shaped aliases. */
const READ_PARAMS: ReadonlySet<string> = new Set([
  ...VIEW_ARGS.body, ...VIEW_ARGS.outline, ...VIEW_ARGS.definitions, 'file_path', 'offset',
])

/**
 * The first argument this call cannot honour, named precisely enough to fix it.
 *
 * @param args - arguments after the built-in shape has been translated.
 * @param view - the view the call resolved to.
 * @returns an error message, or `null` when every supplied argument applies.
 */
function argumentProblem(args: Record<string, unknown>, view: ReadView): string | null {
  const allowed = new Set(VIEW_ARGS[view])
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue
    if (!READ_PARAMS.has(key)) return `unknown parameter "${key}"; view=${view} accepts ${[...allowed].join(', ')}`
    if (allowed.has(key)) continue
    const homes = VIEWS.filter((candidate) => VIEW_ARGS[candidate].includes(key)).map((candidate) => `view=${candidate}`)
    return `"${key}" does not apply to view=${view}; it is read by ${homes.join(' / ')} — drop it or switch view`
  }
  return null
}

/** One JSON value carries every view; `blocks` is body's, `items` is the symbol views'. */
interface ReadValue {
  blocks?: ReadBlock[]
  items?: Array<Record<string, unknown>>
  skipped: SkippedFile[]
  lang?: string
  stats?: string
  note?: string
}

function failure(error: string): ToolFailure {
  return { error }
}
function text(value: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value }]
}

/** Resolve a tool path parameter to an absolute file path under the workspace. */
function resolveFilePath(exec: ForgeExec | undefined, raw: string): string {
  const abs = path.isAbsolute(raw) ? raw : path.resolve(workdirOf(exec), raw)
  return path.normalize(abs)
}

function looksBinary(raw: Buffer): boolean {
  return raw.subarray(0, 8192).includes(0)
}

/** Strip BOM and normalize EOL to LF — the forge line-number contract. */
function normalizeText(raw: Buffer): string {
  return raw.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

const FENCE_LANG: Record<string, string> = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.ts': 'ts', '.tsx': 'tsx',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.c': 'c', '.h': 'c', '.cpp': 'cpp',
  '.cc': 'cpp', '.hpp': 'cpp', '.java': 'java', '.cs': 'csharp', '.lua': 'lua',
  '.json': 'json', '.md': 'markdown', '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml',
  '.html': 'html', '.css': 'css', '.sh': 'shell', '.sql': 'sql',
}

/** Split `path#Symbol` addressing; `#` never appears in the file part unless escaped. */
function splitPathSymbol(raw: string): { file: string; symbol?: string } {
  const at = raw.lastIndexOf('#')
  if (at <= 0 || at === raw.length - 1) return { file: raw }
  return { file: raw.slice(0, at), symbol: raw.slice(at + 1) }
}

/** Collect candidate files for a glob target: sorted, root-.gitignore-aware, capped. */
function globFiles(workspace: string, pattern: string, limit: number): Array<{ abs: string; rel: string }> {
  const matcher = globToRegExp(pattern)
  const rules = ignore()
  const gitignore = path.join(workspace, '.gitignore')
  if (existsSync(gitignore)) {
    try { rules.add(readFileSync(gitignore, 'utf8')) } catch { /* unreadable rules — fall back to hard skips */ }
  }
  const out: Array<{ abs: string; rel: string }> = []
  let visited = 0
  const walk = (dir: string): void => {
    if (out.length >= limit || visited > GLOB_WALK_VISIT_CAP) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit || visited > GLOB_WALK_VISIT_CAP) return
      visited++
      const abs = path.join(dir, entry.name)
      const rel = path.relative(workspace, abs).split(path.sep).join('/')
      if (rules.ignores(rel)) continue
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.dsh') continue
        walk(abs)
      } else if (entry.isFile() && matcher.test(rel)) {
        out.push({ abs, rel })
      }
    }
  }
  walk(workspace)
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

interface ReadBlock {
  file: string
  text: string
  lines?: string
  truncated?: boolean
  kind?: string
  occurrence?: number
  /**
   * The file's line count, when the block came from a windowed plain read.
   *
   * Carried so the caller can say where to continue (`offset=121`) instead of
   * leaving the model to discover EOF by asking again — the built-in contract
   * reports `totalLines` for the same reason.
   */
  totalLines?: number
  /** Where `text` actually sits in canonical text: 0-based UTF-16 positions,
   *  half-open. Computed from the emitted characters, so a byte-capped or
   *  budget-trimmed block reports what it shows, not what was planned. */
  displayRange?: SourceRange
  /** For a symbol read: the definition's own span, without `context` lines. */
  symbolRange?: SourceRange
}
interface SkippedFile { file: string; reason: string }

/** The slice of a parsed definition this module needs to anchor a symbol read. */
interface SymbolCandidate {
  qualifiedName: string
  kind: string
  startLine: number
  endLine: number
  startOffset: number
  commentStartLine?: number
}

/**
 * Pick one definition out of `findSymbol` candidates.
 *
 * Two layers, in priority order: **occurrence** is the line-independent
 * identity (1-based index in declaration order — stable under line drift,
 * reassigned when declarations reorder), **line** is the positional
 * convenience fallback (nearest match wins). An address that matches a
 * returned qualifiedName exactly is preferred over broad name discovery,
 * because a returned qualifiedName *is* an address.
 *
 * Returns a discriminated outcome rather than throwing, so the caller can
 * report the candidates through the `skipped` channel that ff_read already
 * uses for every other unreadable target.
 */
function resolveSymbolTarget(
  candidates: SymbolCandidate[],
  rawSymbol: string,
  lineHint: number | undefined,
  occurrenceHint: number | undefined,
): { sym: SymbolCandidate; occurrence: number } | { reason: string } {
  const normalized = rawSymbol.trim().replace(/::/g, '.')
  const qualified = candidates.filter((item) => item.qualifiedName.replace(/::/g, '.') === normalized)
  const ordered = [...(qualified.length ? qualified : candidates)].sort((a, b) => a.startOffset - b.startOffset)
  if (ordered.length === 0) return { reason: `symbol "${rawSymbol}" not found` }
  const list = ordered.map((m, i) => `#${i + 1} ${m.qualifiedName} L${m.startLine}`).join(', ')
  if (ordered.length === 1) return { sym: ordered[0], occurrence: 1 }
  if (occurrenceHint !== undefined) {
    const picked = ordered[occurrenceHint - 1]
    if (!picked) {
      return { reason: `occurrence ${occurrenceHint} out of range: "${rawSymbol}" has ${ordered.length} definitions — ${list}` }
    }
    return { sym: picked, occurrence: occurrenceHint }
  }
  if (lineHint !== undefined) {
    const nearest = [...ordered].sort((a, b) => Math.abs(a.startLine - lineHint) - Math.abs(b.startLine - lineHint))[0]
    return { sym: nearest, occurrence: ordered.indexOf(nearest) + 1 }
  }
  return {
    reason: `symbol "${rawSymbol}" is ambiguous (${ordered.length} definitions) — candidates: ${list} — ` +
      're-send with occurrence=<n> (line-independent) or line=<approx line>',
  }
}

/** Read one plain-text target (whole file or line range), applying per-file caps. */
function readPlain(abs: string, display: string, range: { start: number; end: number } | null): ReadBlock | SkippedFile {
  let raw: Buffer
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return { file: display, reason: 'file not found' }
    raw = readFileSync(abs)
  } catch (cause) {
    return { file: display, reason: `unreadable: ${cause instanceof Error ? cause.message : String(cause)}` }
  }
  if (looksBinary(raw)) return { file: display, reason: 'binary file — use the built-in read/attachment path' }
  // Same conversion the edit path uses. A Latin-1 or UTF-16 file must fail the
  // same way here as it would when written, instead of rendering replacement
  // characters whose positions mean nothing.
  let canonical: string
  try {
    canonical = canonicalize(raw).text
  } catch (cause) {
    return { file: display, reason: cause instanceof Error ? cause.message : String(cause) }
  }
  const lines = canonical.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const start = range === null ? 1 : Math.max(1, range.start)
  const end = range === null ? lines.length : Math.min(lines.length, range.end)
  if (range !== null && (range.start > lines.length)) return { file: display, reason: `line range L${range.start}-${range.end} is past EOF (${lines.length} lines)` }
  const slice = lines.slice(start - 1, end)
  const capped = range === null && end - start + 1 > PER_FILE_LINE_CAP
  // Both caps cut the emitted text, so the label and the range come from what is
  // actually handed over. Deriving either from the request was how a truncated
  // block advertised lines it never showed.
  let text = capped ? slice.slice(0, PER_FILE_LINE_CAP).join('\n') : slice.join('\n')
  let truncated = capped
  if (text.length > PER_FILE_BYTE_CAP) {
    text = text.slice(0, PER_FILE_BYTE_CAP)
    truncated = true
  }
  const shownLines = text === '' ? 1 : text.split('\n').length
  return {
    file: display,
    lines: `L${start}-${start + shownLines - 1}`,
    text,
    totalLines: lines.length,
    displayRange: rangeForSlice(canonical, start, text.length),
    ...(truncated ? { truncated: true } : {}),
  }
}

/**
 * Fit one planned block into what is left of the inline budget.
 *
 * A block bigger than the remainder used to be dropped whole. That was
 * survivable at a 512 KB budget and is not at 40 KB: the per-file cap
 * (`PER_FILE_BYTE_CAP`) had already prepared a useful prefix, and skipping it
 * would return *nothing* for a single large file. Trim to the last line break
 * inside the budget, re-point the `lines` label, and flag it truncated; only a
 * remainder too small to carry a line is refused, and the caller says so.
 *
 * @param block - block produced by `readPlain` or the symbol path.
 * @param budget - bytes left of {@link TOTAL_BYTE_BUDGET}.
 * @returns the block fitted to the budget, or null when the remainder is
 *   unusable.
 */
function fitBlock(block: ReadBlock, budget: number): ReadBlock | null {
  if (block.text.length <= budget) return block
  if (budget < MIN_TRUNCATED_BYTES) return null
  const breakAt = block.text.lastIndexOf('\n', budget)
  const text = breakAt > 0 ? block.text.slice(0, breakAt) : block.text.slice(0, budget)
  const label = /^L(\d+)-\d+$/.exec(block.lines ?? '')
  const first = label === null ? undefined : Number(label[1])
  return {
    ...block,
    text,
    ...(first === undefined ? {} : { lines: `L${first}-${first + text.split('\n').length - 1}` }),
    truncated: true,
  }
}

/**
 * Why a target did not fit the inline budget. The two cases are different
 * problems: one says earlier targets consumed the call, the other that only a
 * sliver is left, and both are fixed the same way — call again for this target
 * alone.
 *
 * @param remaining - bytes left of {@link TOTAL_BYTE_BUDGET}.
 * @returns the skip reason.
 */
function budgetReason(remaining: number): string {
  return remaining <= 0
    ? `not read: earlier targets used the whole ${BUDGET_LABEL} inline budget — call again with this target alone`
    : `not read: only ${Math.max(0, Math.floor(remaining / 1024))}KB of the ${BUDGET_LABEL} inline budget was left — call again with this target alone`
}

/**
 * Line range sentinel for "from here to the end of the file".
 *
 * `lines=` cannot express an open range, and an `offset` without a `limit` means
 * exactly that in the built-in contract. `readPlain` clamps the end to the file
 * length, so one very large bound is the whole implementation — no second
 * addressing mode, and the emitted label still reports the real last line.
 */
const END_OF_FILE = 9_999_999_999

/**
 * Interpret the built-in `read` contract, when it is the one being spoken.
 *
 * `takeover` serves this tool as `read`, and the built-in `TOOL_READ` prompt
 * section keeps saying "use offset and limit to continue reading large files"
 * for as long as any tool called `read` exists. Serving `path`/`lines` only
 * would therefore leave the model with correct instructions and a tool that
 * rejects them. Both contracts are accepted; forge's own arguments are never
 * rewritten.
 *
 * The one genuine conflict is `limit`: forge's body view reads it as **how many
 * files**, the built-in as **how many lines**. The addressing form decides,
 * which is the only rule that cannot surprise a caller — `file_path` means a
 * built-in call, `path` means a forge call:
 *
 *   read(file_path, offset, limit)   → one file, lines `offset … offset+limit-1`
 *   read(path, lines="L10-20")       → unchanged
 *
 * @param args - the raw tool arguments.
 * @returns the arguments to execute with; the same object when it is already a
 *   forge-shaped call.
 */
function withNativeReadArgs(args: Record<string, unknown>): Record<string, unknown> {
  const filePath = typeof args.file_path === 'string' && args.file_path.trim() !== '' ? args.file_path : undefined
  if (filePath === undefined) return args

  const next: Record<string, unknown> = { ...args, path: args.path ?? filePath }
  delete next.file_path
  delete next.offset

  const offset = Number.isSafeInteger(args.offset) && Number(args.offset) > 0 ? Number(args.offset) : undefined
  const limit = Number.isSafeInteger(args.limit) && Number(args.limit) > 0 ? Number(args.limit) : undefined
  // `limit` is a line count here, never a file count: one file was addressed.
  delete next.limit
  if (args.lines === undefined && (offset !== undefined || limit !== undefined)) {
    const start = offset ?? 1
    next.lines = `L${start}-${limit === undefined ? END_OF_FILE : start + limit - 1}`
  }
  return next
}

/**
 * The window a built-in-shaped call asked for, used only to tell the caller
 * where to continue. `undefined` for a forge-shaped call.
 */
function nativeReadWindow(args: Record<string, unknown>): { start: number } | undefined {
  if (typeof args.file_path !== 'string' || args.file_path.trim() === '') return undefined
  const offset = Number.isSafeInteger(args.offset) && Number(args.offset) > 0 ? Number(args.offset) : 1
  return { start: offset }
}

/**
 * @param workers - AST pool for the symbol views, when the host has one.
 * @param nativeName - the built-in name this definition will be registered
 *   under (`takeover`), or `undefined` for the additive `ff_read`. Only the
 *   native case advertises the built-in arguments, so the additive schema and
 *   its token cost stay exactly as they were.
 */
export function createReadTool(workers?: AstWorkerPool, nativeName?: string) {
  const native = nativeName !== undefined
  return {
    name: 'ff_read',
    description: native
      ? 'Read source — one addressing contract, three views. view=body (default) returns TEXT, selected by file_path/offset/limit (the built-in arguments) or by path, paths, glob and symbol+path. ' +
        'view=outline returns ONE file\'s definitions with line ranges and qualifiedName addresses (depth/kind narrow it). ' +
        'view=definitions returns symbol DEFINITIONS across a search root (symbol selects it; path re-roots the search anywhere on the host — node_modules, another drive and another checkout included). ' +
        'Symbol views: JS/TS/TSX/Python/Rust/Go/C/C++/Java/C#/Lua; for other types use ffgrep or view=body with lines=. ' +
        'Returns 1-based LF-normalized lines for ffedit. Refuses binary and image files. Whole-file reads cap at 4000 lines; text budgets may truncate or skip targets — check skipped/truncated.'
      : 'Read source — one addressing contract, three views. view=body (default) returns TEXT, selected by path, paths, glob or symbol+path. ' +
        'view=outline returns ONE file\'s definitions with line ranges and qualifiedName addresses (depth/kind narrow it). ' +
        'view=definitions returns symbol DEFINITIONS across a search root (symbol selects it; path re-roots the search anywhere on the host — node_modules, another drive and another checkout included). ' +
        'Symbol views: JS/TS/TSX/Python/Rust/Go/C/C++/Java/C#/Lua; for other types use ffgrep or view=body with lines=. ' +
        'Returns 1-based LF-normalized lines for ffedit. Refuses binary files. Whole-file reads cap at 4000 lines; text budgets may truncate or skip targets — check skipped/truncated.',
    parameters: {
      view: { type: 'string', enum: ['body', 'outline', 'definitions'], description: 'Default body. Each view honours its own arguments only: body reads path/paths/glob/symbol/lines/body/context/line/occurrence/limit, outline reads path/depth/kind, definitions reads path/symbol/glob/kind/limit. Passing an argument another view owns is an error, not a hint.' },
      // Built-in addressing, advertised only while serving the built-in name:
      // `file_path` plus a line window is how every other `read` on the host is
      // called, and the built-in prompt section keeps recommending it.
      ...(native
        ? {
            file_path: { type: 'string' as const, description: 'Whole file to read; same as path. Pair with offset and limit.' },
            offset: { type: 'integer' as const, description: '1-based first line to return; default 1. Continue with the offset from a previous page.' },
          }
        : {}),
      path: { type: 'string', description: 'body: file, optionally #Qualified.Symbol. outline: the file. definitions: optional root — absolute re-roots, a file narrows to it.' },
      paths: { type: 'array', items: { type: 'string' }, description: 'body: files in the same path[#Symbol] form.' },
      glob: { type: 'string', description: 'body: workspace-relative glob of files, e.g. "src/**/*.test.ts". definitions: glob filter under the search root.' },
      symbol: { type: 'string', description: 'body: read this definition out of path (same as path#Symbol); requires path. definitions: the definition to locate under the search root.' },
      lines: { type: 'string', description: 'body only. Inclusive 1-based range ("L10-20", "L10-L20", "L10"); ignored for #Symbol.' },
      body: { type: 'boolean', description: 'body only; #Symbol: drop leading comment, keep signature. Default false.' },
      context: { type: 'integer', description: 'body only; #Symbol: surrounding lines, 0–20; default 0.' },
      line: { type: 'integer', description: 'body/definitions: 1-based line hint; nearest declaration wins.' },
      occurrence: { type: 'integer', description: 'body/definitions: 1-based same-name index; overrides line. Re-query once declarations change.' },
      depth: { type: 'integer', description: 'outline only. Max nesting levels; 1=top level, omitted=all.' },
      kind: { type: 'string', description: 'outline/definitions: comma-separated kinds ("function,method").' },
      limit: native
        ? ({ type: 'integer', description: `lines to return for a file_path target (default: to end of file). Also: files in a path/paths/glob read (${MAX_FILES_DEFAULT} default, max ${MAX_FILES_HARD}); definitions (${DEFINITIONS_LIMIT_DEFAULT} default, max ${DEFINITIONS_LIMIT_MAX}).` } as const)
        : ({ type: 'integer', description: `body: files (${MAX_FILES_DEFAULT} default, max ${MAX_FILES_HARD}). definitions: definitions (${DEFINITIONS_LIMIT_DEFAULT} default, max ${DEFINITIONS_LIMIT_MAX}).` } as const),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          blocks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string', required: true },
                lines: { type: 'string' },
                text: { type: 'string', required: true },
                truncated: { type: 'boolean' },
                kind: { type: 'string' },
                occurrence: { type: 'integer' },
                totalLines: { type: 'integer' },
                displayRange: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    start: { type: 'object', additionalProperties: false, properties: { line: { type: 'integer', required: true }, character: { type: 'integer', required: true } } },
                    end: { type: 'object', additionalProperties: false, properties: { line: { type: 'integer', required: true }, character: { type: 'integer', required: true } } },
                  },
                },
                symbolRange: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    start: { type: 'object', additionalProperties: false, properties: { line: { type: 'integer', required: true }, character: { type: 'integer', required: true } } },
                    end: { type: 'object', additionalProperties: false, properties: { line: { type: 'integer', required: true }, character: { type: 'integer', required: true } } },
                  },
                },
              },
            },
          },
          items: { type: 'array', items: SYMBOL_ITEM_SCHEMA },
          skipped: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { file: { type: 'string', required: true }, reason: { type: 'string', required: true } },
            },
          },
          lang: { type: 'string' },
          stats: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (args: unknown, value: ReadValue) => {
        const view = viewOf(args)
        const items = value.items ?? []
        if (view === 'definitions') {
          if (items.length === 0) return text(`no definitions matched${value.stats ? ` (${value.stats})` : ''}`)
          const lines = items.map((s) =>
            `${s.file}#${s.qualifiedName} (${s.kind}) L${s.startLine}-${s.endLine}${Number(s.occurrence) > 1 ? ` #${s.occurrence}` : ''}`,
          )
          if (value.stats) lines.push(`[${value.stats}]`)
          if (value.note) lines.push(`[${value.note}]`)
          return text(lines.join('\n'))
        }
        if (view === 'outline') {
          if (items.length === 0) return text(`no symbols found${value.lang ? ` (${value.lang})` : ''}`)
          const lines = items.map((s) => {
            const pad = '  '.repeat(Number(s.level ?? 1) - 1)
            const range = s.commentStartLine !== undefined ? `L${s.commentStartLine}-${s.endLine}` : `L${s.startLine}-${s.endLine}`
            return `${pad}${s.qualifiedName} (${s.kind}) ${range}`
          })
          if (value.note) lines.push(`[${value.note}]`)
          return text(lines.join('\n'))
        }
        const parts = (value.blocks ?? []).map((block) => {
          const lang = FENCE_LANG[path.extname(block.file)] ?? ''
          const head = `#### ${block.file}${block.lines ? ` · ${block.lines}` : ''}${block.occurrence !== undefined ? ` · #${block.occurrence}` : ''}${block.truncated ? ' · truncated' : ''}`
          return `${head}\n\`\`\`${lang}\n${block.text}\n\`\`\``
        })
        for (const skip of value.skipped) parts.push(`- ${skip.file}: ${skip.reason}`)
        if (value.note) parts.push(`[${value.note}]`)
        return text(parts.join('\n\n') || 'nothing read')
      },
    },
    isConcurrencySafe: () => true,
    async execute(rawArgs: Record<string, unknown>, exec: ForgeExec | undefined) {
      // A built-in-shaped call (`file_path`/`offset`/`limit`) is translated up
      // front so every branch below keeps reading one argument shape.
      const nativeWindow = nativeReadWindow(rawArgs)
      const args = withNativeReadArgs(rawArgs)
      // Silently treating a typo as `body` would return file text for what the
      // model meant as an outline — name the accepted values instead.
      if (typeof args.view === 'string' && args.view.trim() !== '' && !(VIEWS as readonly string[]).includes(args.view.trim())) {
        return failure(`view must be one of ${VIEWS.join(', ')} (or omitted for body) — got: ${args.view}`)
      }
      const view = viewOf(args)
      const problem = argumentProblem(args, view)
      if (problem) return failure(problem)
      if (view === 'outline') {
        const result = await outlineOf(exec, args.path, args.depth, args.kind)
        if (isToolFailure(result)) return result
        return {
          items: result.items, lang: result.lang, skipped: [],
          ...(result.partial ? { note: 'parse had errors — ranges best-effort' } : {}),
        }
      }
      if (view === 'definitions') {
        const wanted = typeof args.symbol === 'string' ? args.symbol.trim() : ''
        if (wanted === '') return failure('view=definitions requires symbol')
        const result = await findDefinitions(exec, {
          name: wanted, path: args.path, kind: args.kind, glob: args.glob, limit: args.limit,
        }, workers)
        if (isToolFailure(result)) return result
        return {
          items: result.items, stats: result.stats, skipped: [],
          ...(result.truncated ? { note: 'result truncated — narrow with path/glob/kind or raise limit' } : {}),
        }
      }
      const workspace = path.resolve(workdirOf(exec))
      const limit = clampInt(args.limit, MAX_FILES_DEFAULT, 1, MAX_FILES_HARD)
      const range = typeof args.lines === 'string' && args.lines.trim() !== '' ? parseLineRange(args.lines) : null
      if (typeof args.lines === 'string' && args.lines.trim() !== '' && range === null) {
        return failure(`lines must look like "L10-20", "L10-L20" or "L10", got: ${args.lines}`)
      }
      const entries: Array<{ raw: string; symbol?: string; range: { start: number; end: number } | null }> = []
      const pushPath = (raw: string): void => {
        const split = splitPathSymbol(raw.trim())
        if (split.symbol !== undefined) entries.push({ raw: split.file, symbol: split.symbol, range: null })
        else entries.push({ raw: split.file, range })
      }
      const symbolArg = typeof args.symbol === 'string' && args.symbol.trim() !== '' ? args.symbol.trim() : undefined
      const pathArg = typeof args.path === 'string' && args.path.trim() !== '' ? args.path : undefined
      if (symbolArg !== undefined) {
        if (pathArg === undefined) return failure('symbol requires path')
        entries.push({ raw: splitPathSymbol(pathArg.trim()).file, symbol: symbolArg, range: null })
      } else if (pathArg !== undefined) {
        pushPath(pathArg)
      }
      if (Array.isArray(args.paths)) {
        for (const entry of args.paths) {
          if (typeof entry === 'string' && entry.trim() !== '') pushPath(entry)
        }
      }
      if (typeof args.glob === 'string' && args.glob.trim() !== '') {
        for (const found of globFiles(workspace, args.glob.trim(), limit)) {
          entries.push({ raw: found.abs, range })
        }
      }
      if (entries.length === 0) return failure('nothing to read — view=body needs path, paths, glob or symbol+path')

      const blocks: ReadBlock[] = []
      const skipped: SkippedFile[] = []
      let budget = TOTAL_BYTE_BUDGET
      const body = args.body === true
      const context = clampInt(args.context, 0, 0, 20)
      const lineHint = args.line === undefined ? undefined : clampInt(args.line, 0, 0, 10_000_000)
      const occurrenceHint = args.occurrence === undefined ? undefined : clampInt(args.occurrence, 0, 0, 1_000_000)
      const notes: string[] = []
      let overflow = 0
      let cut = 0

      for (const entry of entries) {
        exec?.signal?.throwIfAborted()
        if (blocks.length >= limit) { overflow++; continue }
        const abs = resolveFilePath(exec, entry.raw)
        const observed = await exec?.beginNativeRead?.(abs)
        const display = path.isAbsolute(entry.raw) ? path.relative(workspace, entry.raw).split(path.sep).join('/') || entry.raw : entry.raw
        // Before the read, not after: a starved target must not be loaded only
        // to be discarded, and it is not a file-cap overflow — it needs the
        // budget's own reason so the model re-calls narrowly instead of raising
        // `limit`, which cannot help.
        if (budget < MIN_TRUNCATED_BYTES) { skipped.push({ file: display, reason: budgetReason(budget) }); continue }
        if (entry.symbol !== undefined) {
          const parsed = await parseFile(abs, { readPath: observed?.path })
          if (parsed.error) { skipped.push({ file: display, reason: parsed.error }); continue }
          const file = parsed.value!
          const pick = resolveSymbolTarget(findSymbol(file.symbols, entry.symbol, false), entry.symbol, lineHint, occurrenceHint)
          if ('reason' in pick) { skipped.push({ file: display, reason: pick.reason }); continue }
          const sym = pick.sym
          const start = body || sym.commentStartLine === undefined ? sym.startLine : sym.commentStartLine
          const from = Math.max(0, start - 1 - context)
          const to = Math.min(file.text.split('\n').length, sym.endLine + context)
          const blockText = file.text.split('\n').slice(from, to).join('\n')
          const fittedSymbol = fitBlock({
            file: `${display}#${sym.qualifiedName}`,
            lines: `L${start}-${sym.endLine}`,
            kind: sym.kind, occurrence: pick.occurrence,
            text: blockText,
            // The body block now spans `context` lines too, so its own label
            // (the symbol span) and the range of the emitted text are different
            // facts and are reported separately.
            displayRange: rangeForSlice(file.text, from + 1, blockText.length),
            symbolRange: rangeForLines(file.text, sym.startLine, sym.endLine),
          }, budget)
          if (fittedSymbol === null) { skipped.push({ file: display, reason: budgetReason(budget) }); continue }
          budget -= fittedSymbol.text.length
          if (fittedSymbol.truncated) cut++
          blocks.push(fittedSymbol)
          await observed?.finish()
          continue
        }
        const outcome = readPlain(observed?.path ?? abs, display, entry.range)
        if ('reason' in outcome) { skipped.push(outcome); if (outcome.reason === 'file not found') await observed?.finish(); continue }
        const fitted = fitBlock(outcome, budget)
        if (fitted === null) { skipped.push({ file: display, reason: budgetReason(budget) }); continue }
        budget -= fitted.text.length
        if (fitted.truncated) cut++
        blocks.push(fitted)
        await observed?.finish()
      }
      // Where to continue, in the caller's own vocabulary: a built-in-shaped
      // read that stopped short of EOF has to say so, or the model asks again
      // from the top and pays for the same lines twice.
      if (nativeWindow !== undefined && blocks.length === 1) {
        const only = blocks[0]
        const span = /^L(\d+)-(\d+)$/.exec(only.lines ?? '')
        if (span !== null && only.totalLines !== undefined && Number(span[2]) < only.totalLines) {
          notes.push(`showing L${span[1]}-${span[2]} of ${only.totalLines} — continue with offset=${Number(span[2]) + 1}`)
        }
      }
      if (cut > 0) notes.push(`${cut} target(s) trimmed to the ${BUDGET_LABEL} inline budget — re-call with lines=, symbol or fewer targets for the rest`)
      if (overflow > 0) notes.push(`${overflow} target(s) beyond the ${limit}-file cap were skipped — raise limit or split the call`)
      return { blocks, skipped, ...(notes.length ? { note: notes.join('; ') } : {}) }
    },
  } as const
}
