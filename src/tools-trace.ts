/**
 * fftrace: ProjectForge-Trace-style link-graph queries over the session
 * workspace. Scans JS-family + HTML files for static link facts (facts.ts),
 * optionally reads a JSON declaration table, assembles the four maps
 * (linkgraph.ts), and answers ipc:/api:/global:/page:/file: queries with
 * `path:line` rows that feed straight back into ffedit / ff_read coordinates.
 *
 * Read-only: never executes workspace code or mutates the ledger.
 *
 * @module dsh-forge/tools-trace
 */

import path from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import ignore from 'ignore'
import { fileFacts, factsFromText } from './ast.ts'
import { bridgeGlobalsOf, loadPreloadDecls } from './decls.ts'
import { buildGraph, parseTarget, trace, type TraceGraph } from './linkgraph.ts'
import { topLevelAliasNames, scanHtmlFacts, emptyFacts, mergeFacts, type TraceFileFacts, type FileFacts } from './facts.ts'
import { workdirOf, type ForgeExec, type ToolFailure } from './core.ts'
import { readBoundedFile } from './fs-paths.ts'

const SCAN_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.html'])
const FILE_CAP = 20_000
const PER_FILE_BYTES = 2 * 1024 * 1024
const WALK_VISIT_CAP = 200_000

function failure(error: string): ToolFailure {
  return { error }
}

function text(value: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value }]
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

/** Collect scan candidates: JS family + HTML, root-.gitignore-aware, capped. */
function collectCandidates(root: string, signal?: AbortSignal): { files: Array<{ abs: string; rel: string }>; truncated: boolean } {
  const rules = ignore()
  const gitignore = path.join(root, '.gitignore')
  if (existsSync(gitignore)) {
    try { rules.add(readFileSync(gitignore, 'utf8')) } catch { /* unreadable rules — hard skips only */ }
  }
  const files: Array<{ abs: string; rel: string }> = []
  let visited = 0
  let truncated = false
  const walk = (dir: string): void => {
    signal?.throwIfAborted()
    if (files.length >= FILE_CAP || visited > WALK_VISIT_CAP) {
      truncated = true
      return
    }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= FILE_CAP || visited > WALK_VISIT_CAP) {
        truncated = true
        return
      }
      visited++
      const abs = path.join(dir, entry.name)
      const rel = toPosix(path.relative(root, abs))
      if (rules.ignores(rel)) continue
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.dsh') continue
        walk(abs)
      } else if (entry.isFile() && SCAN_EXTS.has(path.extname(entry.name).toLowerCase())) {
        files.push({ abs, rel })
      }
    }
  }
  walk(root)
  return { files: files.sort((a, b) => a.rel.localeCompare(b.rel)), truncated }
}

/** Scan one root: per-file facts (HTML scanner + AST extractor). */
async function scanFacts(root: string, bridge: readonly string[], signal?: AbortSignal): Promise<{ entries: Map<string, TraceFileFacts>; scanned: number; truncated: boolean; parseErrors: number }> {
  const { files, truncated } = collectCandidates(root, signal)
  const entries = new Map<string, TraceFileFacts>()
  let parseErrors = 0
  for (const { abs, rel } of files) {
    signal?.throwIfAborted()
    await new Promise<void>(resolve => setImmediate(resolve))
    signal?.throwIfAborted()
    const ext = path.extname(abs).toLowerCase()
    try {
      if (ext === '.html') {
        const raw = readBoundedFile(abs, PER_FILE_BYTES).toString('utf8')
        if (Buffer.byteLength(raw, 'utf8') > PER_FILE_BYTES) {
          parseErrors++
          continue
        }
        const html = scanHtmlFacts(raw)
        // Inline script bodies are parsed as JS so their IPC/bridge/globals
        // facts land on the page (PF parity). Module bodies keep only
        // explicit `window.X` globals — their top-level declarations are
        // scoped, never global.
        let merged: FileFacts | undefined
        for (const body of html.inline) {
          const parsed = await factsFromText(body.text, bridge)
          if (!parsed) continue
          if (!merged) merged = emptyFacts()
          if (body.module) {
            const scoped = emptyFacts()
            mergeFacts(scoped, parsed.facts, body.line - 1)
            scoped.globalsDefined = scoped.globalsDefined.filter(d => d.how === 'window')
            mergeFacts(merged, scoped, 0)
          } else {
            mergeFacts(merged, parsed.facts, body.line - 1)
          }
        }
        entries.set(rel, merged ? { ...html, facts: merged } : html)
      } else {
        const parsed = await fileFacts(abs, bridge)
        if (!parsed.value) {
          parseErrors++
          continue
        }
        entries.set(rel, { kind: 'js', lang: parsed.value.lang, ...parsed.value.facts })
      }
    } catch {
      signal?.throwIfAborted()
      parseErrors++
    }
  }
  return { entries, scanned: files.length, truncated, parseErrors }
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
}

/**
 * Scan a root for facts, read the declaration table, run the two-pass alias
 * extension, and assemble the graph. Shared by the fftrace tool and the
 * oracle evaluation harness (tests/eval-trace.mjs) so both measure the same
 * pipeline end to end.
 */
export async function assembleTraceGraph(root: string, options: { declarations?: string; signal?: AbortSignal } = {}): Promise<AssembledTrace> {
  const decls = await loadPreloadDecls(root, options.declarations, options.signal)
  // Bridge list = role globals + compat global; top-level aliases discovered
  // on the first scan extend it and trigger exactly one rescan (PF parity).
  let bridge = bridgeGlobalsOf(decls)
  let scan = await scanFacts(root, bridge, options.signal)
  const aliases = topLevelAliasNames([...scan.entries.values()].map((entry) => ({ facts: entry.kind === 'js' ? entry : entry.facts ?? null })))
  const extended = [...new Set([...bridge, ...aliases])]
  if (extended.length > bridge.length) {
    bridge = extended
    scan = await scanFacts(root, bridge, options.signal)
  }
  options.signal?.throwIfAborted()
  const graph = buildGraph(root, scan.entries, decls)
  return { graph, decls, scanned: scan.scanned, truncated: scan.truncated, parseErrors: scan.parseErrors }
}

export function createTraceTool() {
  return {
    name: 'fftrace',
    description:
      'Trace JS/TS/JSX/TSX+HTML imports, IPC handlers/preload APIs/callers, or page globals/load order. Returns path:line for ff_read/ffedit. ' +
      'Read-only static analysis; dynamic channels/package imports remain unresolved. Declaration registries are loaded only when supplied.',
    parameters: {
      target: { type: 'string', required: true, description: 'ipc:<channel>, api:<name>, global:<name>, page:<file.html>, or file:<path>.' },
      declarations: { type: 'string', description: 'Absolute/workspace-relative JSON file, ≤256KiB: {apis:[{name,channel,kind,roles}],roleGlobals?:{role:global}}; kind=query/command/subscription.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          target: { type: 'string', required: true },
          text: { type: 'string', required: true },
          scanned: { type: 'integer' },
          pages: { type: 'integer' },
          decls: { type: 'string' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args: unknown, value: { text: string }) => text(value.text),
    },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      const raw = typeof args.target === 'string' ? args.target : ''
      const target = parseTarget(raw)
      if (!target) {
        return failure('fftrace needs a target like ipc:通道名 (or API 名), global:名称, page:xxx.html, or file:相对路径.')
      }
      const root = path.resolve(workdirOf(exec))
      const declarations = typeof args.declarations === 'string' ? args.declarations : undefined
      if (declarations) await exec?.authorizeNativePaths?.([path.resolve(root, declarations)])
      const { graph, decls, scanned, truncated } = await assembleTraceGraph(root, { declarations, signal: exec?.signal })

      let value = target.value
      if (target.kind === 'file' || target.kind === 'page') {
        const abs = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, ...value.split(/[\\/]+/))
        const rel = toPosix(path.relative(root, abs))
        if (!rel.startsWith('..')) value = rel
      }
      const result = trace(graph, target.kind, value)
      const header = [
        `- 范围：${graph.stats.withFacts} 个 JS/HTML 文件 · ${graph.stats.pages} 个页面 · ${describeDecls(decls.status, decls.apis.length, decls.error)}${truncated ? ' · ⚠️ 扫描已截断' : ''}`,
        '- 置信度：literal / const / wrapper 为字面量、同文件常量或包装函数直连，declared 经 preload 声明表；动态参数不入边。结果中的 `路径:行` 可直接回填 ffedit / ff_read。',
      ].join('\n')
      const [title, ...rest] = result.text.split('\n')
      return {
        found: result.found,
        target: `${target.kind}:${value}`,
        text: [title, header, ...rest].join('\n'),
        scanned,
        pages: graph.stats.pages,
        decls: decls.status,
        ...(truncated ? { truncated: true } : {}),
      }
    },
  } as const
}
