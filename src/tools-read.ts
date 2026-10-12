/**
 * ff_read: DSH batched source read with one
 * unified addressing contract — path (#Symbol or lines=L10-20 suffixes),
 * multiple paths, or a gitignore-aware glob — under explicit file and byte
 * budgets. Plain reads only: multimodal stays with the built-in read tool,
 * and symbol addressing requires a supported AST language (else use lines=).
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
import { clampInt, globToRegExp, parseLineRange, workdirOf, type ForgeExec, type ToolFailure } from './core.ts'

const MAX_FILES_DEFAULT = 20
const MAX_FILES_HARD = 100
const PER_FILE_LINE_CAP = 4000
const PER_FILE_BYTE_CAP = 256 * 1024
const TOTAL_BYTE_BUDGET = 512 * 1024
const GLOB_WALK_VISIT_CAP = 50_000

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

interface ReadBlock { file: string; text: string; lines?: string; truncated?: boolean }
interface SkippedFile { file: string; reason: string }

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
  const lines = normalizeText(raw).split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const start = range === null ? 1 : Math.max(1, range.start)
  const end = range === null ? lines.length : Math.min(lines.length, range.end)
  if (range !== null && (range.start > lines.length)) return { file: display, reason: `line range L${range.start}-${range.end} is past EOF (${lines.length} lines)` }
  const slice = lines.slice(start - 1, end)
  let out = slice.join('\n')
  let truncated = false
  if (out.length > PER_FILE_BYTE_CAP) {
    out = out.slice(0, PER_FILE_BYTE_CAP)
    truncated = true
  }
  const capped = range === null && end - start + 1 > PER_FILE_LINE_CAP
  return {
    file: display,
    lines: `L${start}-${capped ? start + PER_FILE_LINE_CAP - 1 : end}`,
    text: capped ? slice.slice(0, PER_FILE_LINE_CAP).join('\n') : out,
    ...(truncated || capped ? { truncated: true } : {}),
  }
}

export function createReadTool() {
  return {
    name: 'ff_read',
    description:
      'Read text files/ranges or batch symbols. Provide at least one of path/paths/glob; they may combine. For ambiguous symbols use ff_read_symbol with occurrence. Symbol languages: see ff_outline. ' +
      'Returns 1-based LF-normalized lines for ffedit. Refuses binary files. Whole-file reads cap at 4000 lines; text budgets may truncate/skip targets. Check skipped/truncated.',
    parameters: {
      path: { type: 'string', description: 'Absolute/workspace-relative file, optionally #Qualified.Symbol.' },
      paths: { type: 'array', items: { type: 'string' }, description: 'File entries in the same path[#Symbol] form.' },
      glob: { type: 'string', description: 'Workspace-relative glob, e.g. "src/**/*.test.ts".' },
      lines: { type: 'string', description: 'Inclusive 1-based range, e.g. "L10-20" or "L10"; ignored for #Symbol.' },
      body: { type: 'boolean', description: '#Symbol: drop leading comment, keep signature. Default false.' },
      context: { type: 'integer', description: '#Symbol: surrounding lines, 0–20; default 0.' },
      limit: { type: 'integer', description: `Max files (${MAX_FILES_DEFAULT} default, max ${MAX_FILES_HARD}).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          blocks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string', required: true },
                lines: { type: 'string' },
                text: { type: 'string', required: true },
                truncated: { type: 'boolean' },
              },
            },
          },
          skipped: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { file: { type: 'string', required: true }, reason: { type: 'string', required: true } },
            },
          },
          note: { type: 'string' },
        },
      },
      render: (_args: unknown, value: { blocks: ReadBlock[]; skipped: SkippedFile[]; note?: string }) => {
        const parts = value.blocks.map((block) => {
          const lang = FENCE_LANG[path.extname(block.file)] ?? ''
          const head = `#### ${block.file}${block.lines ? ` · ${block.lines}` : ''}${block.truncated ? ' · truncated' : ''}`
          return `${head}\n\`\`\`${lang}\n${block.text}\n\`\`\``
        })
        for (const skip of value.skipped) parts.push(`- ${skip.file}: ${skip.reason}`)
        if (value.note) parts.push(`[${value.note}]`)
        return text(parts.join('\n\n') || 'nothing read')
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      const workspace = path.resolve(workdirOf(exec))
      const limit = clampInt(args.limit, MAX_FILES_DEFAULT, 1, MAX_FILES_HARD)
      const range = typeof args.lines === 'string' && args.lines.trim() !== '' ? parseLineRange(args.lines) : null
      if (typeof args.lines === 'string' && args.lines.trim() !== '' && range === null) {
        return failure(`lines must look like "L10-20" or "L10", got: ${args.lines}`)
      }
      const entries: Array<{ raw: string; symbol?: string; range: { start: number; end: number } | null }> = []
      const pushPath = (raw: string): void => {
        const split = splitPathSymbol(raw.trim())
        if (split.symbol !== undefined) entries.push({ raw: split.file, symbol: split.symbol, range: null })
        else entries.push({ raw: split.file, range })
      }
      if (typeof args.path === 'string' && args.path.trim() !== '') pushPath(args.path)
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
      if (entries.length === 0) return failure('nothing to read — provide path, paths, or glob')

      const blocks: ReadBlock[] = []
      const skipped: SkippedFile[] = []
      let budget = TOTAL_BYTE_BUDGET
      const body = args.body === true
      const context = clampInt(args.context, 0, 0, 20)
      const notes: string[] = []
      let overflow = 0

      for (const entry of entries) {
        exec?.signal?.throwIfAborted()
        if (blocks.length >= limit) { overflow++; continue }
        if (budget <= 0) { overflow++; continue }
        const abs = resolveFilePath(exec, entry.raw)
        const observed = await exec?.beginNativeRead?.(abs)
        const display = path.isAbsolute(entry.raw) ? path.relative(workspace, entry.raw).split(path.sep).join('/') || entry.raw : entry.raw
        if (entry.symbol !== undefined) {
          const parsed = await parseFile(abs, { readPath: observed?.path })
          if (parsed.error) { skipped.push({ file: display, reason: parsed.error }); continue }
          const file = parsed.value!
          const matches = findSymbol(file.symbols, entry.symbol, false)
          if (matches.length === 0) { skipped.push({ file: display, reason: `symbol "${entry.symbol}" not found` }); continue }
          if (matches.length > 1) {
            skipped.push({ file: display, reason: `symbol "${entry.symbol}" is ambiguous (${matches.length} definitions): ` +
              matches.slice(0, 5).map((m) => `${m.qualifiedName} L${m.startLine}`).join(', ') })
            continue
          }
          const sym = matches[0]
          const start = body || sym.commentStartLine === undefined ? sym.startLine : sym.commentStartLine
          const from = Math.max(0, start - 1 - context)
          const to = Math.min(file.text.split('\n').length, sym.endLine + context)
          const blockText = file.text.split('\n').slice(from, to).join('\n')
          if (blockText.length > budget) { skipped.push({ file: display, reason: 'exceeds remaining 512KB budget' }); continue }
          budget -= blockText.length
          blocks.push({ file: `${display}#${sym.qualifiedName}`, lines: `L${start}-${sym.endLine}`, text: blockText })
          await observed?.finish()
          continue
        }
        const outcome = readPlain(observed?.path ?? abs, display, entry.range)
        if ('reason' in outcome) { skipped.push(outcome); if (outcome.reason === 'file not found') await observed?.finish(); continue }
        if (outcome.text.length > budget) { skipped.push({ file: display, reason: 'exceeds remaining 512KB budget' }); continue }
        budget -= outcome.text.length
        blocks.push(outcome)
        await observed?.finish()
      }
      if (overflow > 0) notes.push(`${overflow} target(s) beyond the ${limit}-file cap were skipped — raise limit or split the call`)
      return { blocks, skipped, ...(notes.length ? { note: notes.join('; ') } : {}) }
    },
  } as const
}
