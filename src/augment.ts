/**
 * Takeover by augmentation: the built-in `read`, `grep` and `glob` stay the
 * registered definitions, and forge works inside the host's around-dispatch
 * seam (`tools/execute`) instead of shadowing them.
 *
 * Why not shadow. A scoped registration under the built-in name replaces the
 * definition the host renders, validates, presents, spills and times out, and
 * every one of those then has to be re-implemented to stay equal — measured
 * against DSH 0.2.1-rc.3, the shadowing design lost the read/search UI cards,
 * the spill of complete results, the 30 s timeout, the session working
 * directory, and (because the built-ins moved into agent presets) the per-call
 * fallback to the built-in as well. Here none of that is touched: a listener
 * either calls `next()` — which IS the built-in — or returns `{ isError: false,
 * value }` in the built-in's own value shape, which the registry normalizes
 * through the owning definition ("an around-dispatch wrapper's authored
 * result", `ToolRuntime.normalizeDispatchResult`): same schema check, same
 * render, same presentation meta, same post-execute spill.
 *
 * Glob and grep use the resident Rust sidecar. Unsupported arguments, remote
 * subprocesses and unavailable sidecars go to the built-in.
 *
 *   glob  Enumerates and filters paths in parallel, then sorts by modification
 *         time and path.
 *   grep  Uses the resident Rust regex/search engine in parallel. Values stay complete;
 *         long direct-call lines defer to the owning host's preview and spill.
 *   read  `file_path` of the form `file#Symbol`, which the built-in can only
 *         answer with "not found", is served as a line window over that
 *         definition, in the built-in's value shape. A real file whose name
 *         contains `#` is always read by the built-in.
 *
 * Unsupported arguments, invalid patterns, unreadable paths and an unavailable
 * sidecar defer to the built-in.
 *
 *   edit   Never answered. The built-in writes; the listener snapshots the file
 *   write   before and after and appends one `edit` batch, so `ffhistory` and
 *          `ffrollback` cover the writes the model actually makes instead of
 *          only the ones that came through `ffedit`. Bookkeeping never fails a
 *          write that landed.
 *
 * @module dsh-forge/augment
 */

import path from 'node:path'
import { detectLanguage, findSymbol, normalizeText, parseFile } from './ast.ts'
import { FORGE_DEFINITION_TAG } from './host.ts'
import { indexerGlobSearch, indexerGrepSearch, indexerSearchWanted } from './indexer-client.ts'
import { detectEncoding, putBlob, recordBatch, storeFor, workspaceForFile } from './ledger.ts'
export const AUGMENTED_BUILTINS = ['read', 'glob', 'grep', 'edit', 'write'] as const
export type AugmentName = (typeof AUGMENTED_BUILTINS)[number]

// ---------------------------------------------------------------------------
// Host slice
// ---------------------------------------------------------------------------

/** One tool call as the registry hands it to `tools/execute` listeners. */
export interface ToolExecution {
  name: string
  arguments?: Record<string, unknown>
  agent?: unknown
  /** Set for a nested (PTC) dispatch: the value is consumed by code, not rendered. */
  parent?: unknown
  signal?: AbortSignal
}

/** A dispatch outcome. Forge authors only the two shapes the registry normalizes. */
export type DispatchResult =
  | { isError: false; value: unknown; additionalContexts?: unknown }
  | { isError: true; error: { message: string }; content: Array<{ type: 'text'; text: string }> }
  | { isError: boolean; [key: string]: unknown }

type Next = () => Promise<DispatchResult>

/** A filesystem target as the provider resolves it. Opaque except for these two. */
interface FsTarget { targetKey: unknown; displayPath: string }

/** The provider calls the built-in read makes, and nothing else. */
export interface AugmentFileSystem {
  resolve(file: string, options: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
  stat?(target: FsTarget, signal?: AbortSignal): Promise<{ version: unknown; type: string; size?: number } | undefined>
  readText?(target: FsTarget, signal?: AbortSignal): Promise<string>
  processPath(target: FsTarget): string
}

/** What augmentation needs from the plugin context. Structural for tests. */
export interface AugmentHost {
  on?(event: 'tools/execute', listener: (exec: ToolExecution, next: Next) => Promise<DispatchResult>): (() => void) | void
  /** Optional services (`workingDirectory`) are read without the inject requirement. */
  get?(name: string): unknown
  emit?(event: 'fs/observed', target: FsTarget, observation: unknown, actor: unknown): unknown
  fs?: AugmentFileSystem
  tools?: { get?(name: string, scope?: unknown): unknown }
  logger?: { warn(message: string): void }
}

interface WorkingDirectories { ensure(agent: unknown, signal?: AbortSignal): Promise<string> }

// ---------------------------------------------------------------------------
// Built-in constants this module has to agree with (dsh-tool-fs-search / dsh-tool-fs)
// ---------------------------------------------------------------------------

/** `GREP_MAX_LINE_BYTES`: the built-in preview budget for one matched line. */
const GREP_PREVIEW_BYTES = 2000
/** Bytes of context kept on each side of a match when a long line is excerpted. */
const EXCERPT_CONTEXT = 160
/** `READ_MAX_LINE_LENGTH`, `READ_MAX_BYTES`, `READ_LIMIT`: the built-in read window caps. */
const READ_MAX_LINE_LENGTH = 2000
const READ_MAX_BYTES = 50 * 1024
const READ_LIMIT = 2000

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

/** Per-tool counters for `/forge-status`: what forge answered and why it declined. */
export interface AugmentStats {
  served: Record<AugmentName, number>
  declined: Record<AugmentName, Record<string, number>>
  failed: Record<AugmentName, number>
}

function emptyStats(): AugmentStats {
  return {
    served: { read: 0, glob: 0, grep: 0, edit: 0, write: 0 },
    declined: { read: {}, glob: {}, grep: {}, edit: {}, write: {} },
    failed: { read: 0, glob: 0, grep: 0, edit: 0, write: 0 },
  }
}

/** A decline carries its reason so status output can say why the fast path was not taken. */
class Decline {
  constructor(readonly reason: string) {}
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export interface AugmentOptions {
  /** Built-in names to augment. */
  names: readonly AugmentName[]
}

export interface Augmentation {
  dispose(): void
  stats(): AugmentStats
  nativeSearchEnabled(): boolean
}

/**
 * Install one `tools/execute` listener serving the listed built-in names.
 *
 * @param host - the plugin context (host plane), or a structural stand-in.
 * @param options - built-in names to augment.
 * @returns the disposer and live counters; `undefined` when the host has no
 *   around-dispatch seam (an older registry), in which case nothing changes.
 */
export function installAugmentation(host: AugmentHost, options: AugmentOptions): Augmentation | undefined {
  if (typeof host.on !== 'function' || options.names.length === 0) return undefined
  const enabled = new Set<string>(options.names)
  const stats = emptyStats()

  const handlers: Record<AugmentName, (call: Call) => Promise<DispatchResult>> = {
    glob: serveGlob,
    grep: serveGrep,
    read: serveSymbolRead,
    // edit/write are never answered by forge: the built-in performs the write
    // and the listener only records it. No output-shape check is needed for a
    // call forge does not produce a value for.
    edit: serveLedgerWrite,
    write: serveLedgerWrite,
  }

  const listener = async (exec: ToolExecution, next: Next): Promise<DispatchResult> => {
    const name = exec?.name as AugmentName
    if (!enabled.has(name)) return next()
    let nextResult: Promise<DispatchResult> | undefined
    const nextOnce = (): Promise<DispatchResult> => nextResult ??= Promise.resolve().then(next)
    // `served` is counted by the handlers themselves: a transform that leaves
    // the built-in result unchanged is not a served call.
    const call: Call = { host, exec, next: nextOnce, served: () => { stats.served[name]++ } }
    try {
      return await handlers[name](call)
    } catch (cause) {
      if (nextResult !== undefined) return nextResult
      if (cause instanceof Decline) {
        const bucket = stats.declined[name]
        bucket[cause.reason] = (bucket[cause.reason] ?? 0) + 1
      } else {
        stats.failed[name]++
        host.logger?.warn(`dsh-forge: ${name} augmentation failed, the built-in answers instead: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
      // An aborted call goes to the built-in too: it reports its own abort.
      return nextOnce()
    }
  }

  const off = host.on('tools/execute', listener)
  return {
    dispose: () => { if (typeof off === 'function') off() },
    stats: () => stats,
    nativeSearchEnabled: indexerSearchWanted,
  }
}

/** Everything one augmented call needs; `next` is the built-in. */
interface Call {
  host: AugmentHost
  exec: ToolExecution
  next: Next
  served: () => void
}

// ---------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------

/**
 * The opening of each built-in's description (dsh-tool-fs / dsh-tool-fs-search
 * 0.2.x). A plugin that registers its own `read` with the same value shape — a
 * remote filesystem, say — must not be answered with local bytes, and the
 * output schema alone cannot tell them apart. The caps embedded later in these
 * descriptions are deployment config, so only the fixed head is compared.
 *
 * `edit`/`write` have no entry: forge never authors their value, so there is no
 * shape to agree with.
 */
const BUILTIN_DESCRIPTION: Partial<Record<AugmentName, RegExp>> = {
  read: /^Read a UTF-8 text file and return line-numbered content\./,
  grep: /^Search file contents with a ripgrep regular expression\. Returns matching lines with line numbers, grouped by file\./,
  glob: /^Find files, not directories, whose paths match a glob pattern, including hidden and ignored files\./,
}

/**
 * The definition this call will execute, when it is the built-in this module
 * knows how to answer for. A forge definition under the same name, a built-in
 * whose output schema lacks the properties the fast path produces, or another
 * plugin's tool under the built-in name declines — answering it would either
 * fail the registry's schema check or answer for a different tool.
 */
function requireBuiltin(host: AugmentHost, exec: ToolExecution, properties: readonly string[]): void {
  const get = host.tools?.get
  if (typeof get !== 'function') throw new Decline('registry-unreadable')
  let definition: unknown
  try {
    definition = get.call(host.tools, exec.name, exec.agent)
  } catch {
    throw new Decline('registry-unreadable')
  }
  if (typeof definition !== 'object' || definition === null) throw new Decline('no-builtin')
  if ((definition as Record<string, unknown>)[FORGE_DEFINITION_TAG] !== undefined) throw new Decline('not-builtin')
  const description = (definition as { description?: unknown }).description
  const expected = BUILTIN_DESCRIPTION[exec.name as AugmentName]
  if (typeof description !== 'string' || expected === undefined || !expected.test(description)) throw new Decline('not-builtin')
  const schema = (definition as { output?: { schema?: { properties?: Record<string, unknown> } } }).output?.schema
  const own = schema?.properties ?? {}
  if (!properties.every((key) => key in own) || Object.keys(own).length !== properties.length) {
    throw new Decline('unknown-builtin-shape')
  }
}

/**
 * A service as the calling agent's own plugins resolve it.
 *
 * The built-ins live in agent presets, so their `ctx` is scoped; a preset that
 * isolates its own `fs` or `subprocess` must be honoured the way the built-in
 * honours it. `agent.ctx.get` reads that scope's store; the host's is the
 * fallback for agent-less calls.
 */
function agentService<T>(host: AugmentHost, exec: ToolExecution, name: string): T | undefined {
  const scoped = (exec.agent as { ctx?: { get?(service: string): unknown } } | undefined)?.ctx
  let value: unknown
  try {
    value = typeof scoped?.get === 'function' ? scoped.get(name) : undefined
  } catch {
    value = undefined
  }
  return (value ?? host.get?.(name)) as T | undefined
}

/**
 * Whether two service handles are the same implementation.
 *
 * Not always `===`: cordis hands every `ctx.get` caller a fresh traceable proxy
 * of the service (measured: two `get('subprocess')` calls on one context
 * compare unequal). For class instances, the prototype identifies the
 * implementation. Plain objects share `Object.prototype`, so their prototypes
 * cannot establish that two runners execute in the same world.
 */
function sameImplementation(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  const prototype = Object.getPrototypeOf(a)
  return prototype !== Object.prototype && prototype !== null && prototype === Object.getPrototypeOf(b)
}

/** The directory the built-in tools resolve against: `workingDirectory.ensure(agent)`. */
async function sessionDirectory(host: AugmentHost, exec: ToolExecution): Promise<string | undefined> {
  if (exec.agent === undefined) return undefined
  const service = agentService<WorkingDirectories>(host, exec, 'workingDirectory')
  if (service === undefined || typeof service.ensure !== 'function') throw new Decline('no-working-directory')
  return service.ensure(exec.agent, exec.signal)
}

/** `toWorkdirRelative` from dsh-tool-fs-search, verbatim in behaviour. */
export function toWorkdirRelative(file: string, workdir: string): string {
  if (!path.isAbsolute(file)) return file
  const rel = path.relative(workdir, file)
  if (rel.length === 0) return '.'
  if (rel === '..' || rel.startsWith(`..${path.sep}`)) return file
  return rel
}

// ---------------------------------------------------------------------------
// glob / grep — resident native search, built-in fallback
// ---------------------------------------------------------------------------

async function searchTarget(host: AugmentHost, exec: ToolExecution, output: readonly string[]) {
  const rawPath = exec.arguments?.path
  if (rawPath !== undefined && (typeof rawPath !== 'string' || rawPath.trim() === '')) throw new Decline('invalid-arguments')
  requireBuiltin(host, exec, output)
  // A scoped subprocess may address a remote or confined filesystem.
  const hostRunner = host.get?.('subprocess')
  const agentRunner = agentService(host, exec, 'subprocess')
  if ((hostRunner === undefined) !== (agentRunner === undefined)
    || (hostRunner !== undefined && !sameImplementation(agentRunner, hostRunner))) {
    throw new Decline('agent-subprocess-differs')
  }
  const cwd = (await sessionDirectory(host, exec)) ?? process.cwd()
  const root = path.resolve(cwd, typeof rawPath === 'string' ? rawPath : '.')
  const pathPrefix = typeof rawPath === 'string' && rawPath.startsWith(`.${path.sep}`) ? `.${path.sep}`
    : typeof rawPath === 'string' && rawPath.startsWith('./') ? './' : ''
  return { cwd, root, pathPrefix, displayRoot: typeof rawPath === 'string' ? toWorkdirRelative(rawPath, cwd) : '.' }
}

async function serveGlob({ host, exec, served }: Call): Promise<DispatchResult> {
  const pattern = exec.arguments?.pattern
  if (typeof pattern !== 'string' || pattern.trim() === '') throw new Decline('invalid-arguments')
  const target = await searchTarget(host, exec, ['root', 'paths'])
  let paths = await indexerGlobSearch(target.root, target.cwd, pattern, { signal: exec.signal })
  if (paths === null) throw new Decline('native-search-unavailable')
  if (target.pathPrefix) paths = paths.map((item) => `${target.pathPrefix}${item}`)
  served()
  return { isError: false, value: { root: target.displayRoot, paths } }
}

// ---------------------------------------------------------------------------
// grep — keep the built-in answer, excerpt overlong lines for the render
// ---------------------------------------------------------------------------

/**
 * A JavaScript view of a ripgrep pattern, good enough to *locate* a match that
 * ripgrep already found on this line. Never used to decide whether a line
 * matches: a pattern this cannot compile, or a line it finds nothing on, keeps
 * the built-in preview.
 */
function locator(pattern: string): RegExp | undefined {
  let source = pattern
  let flags = ''
  const inline = /^\(\?([imsx]+)\)/.exec(source)
  if (inline !== null) {
    if (/[x]/.test(inline[1])) return undefined
    source = source.slice(inline[0].length)
    if (inline[1].includes('i')) flags += 'i'
    if (inline[1].includes('s')) flags += 's'
  }
  for (const extra of ['u', '']) {
    try {
      return new RegExp(source, flags + extra)
    } catch {
      // try the next dialect
    }
  }
  return undefined
}

/** Clamp a UTF-16 index so a cut never splits a surrogate pair. */
function safeCut(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return Math.max(0, Math.min(text.length, index))
  const code = text.charCodeAt(index)
  return code >= 0xdc00 && code <= 0xdfff ? index - 1 : index
}

/**
 * Replace a line longer than the preview budget by an excerpt around its first
 * match, or return `undefined` to keep the built-in preview.
 */
export function excerptLine(line: string, re: RegExp | undefined): string | undefined {
  if (Buffer.byteLength(line, 'utf8') <= GREP_PREVIEW_BYTES || re === undefined) return undefined
  re.lastIndex = 0
  const found = re.exec(line)
  if (found === null || found[0].length === 0) return undefined
  const start = safeCut(line, found.index - EXCERPT_CONTEXT)
  const end = safeCut(line, found.index + found[0].length + EXCERPT_CONTEXT)
  const excerpt = `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''} (line truncated)`
  // An excerpt as long as the built-in preview saves nothing and loses its head.
  return Buffer.byteLength(excerpt, 'utf8') < GREP_PREVIEW_BYTES ? excerpt : undefined
}

async function serveGrep({ host, exec, served }: Call): Promise<DispatchResult> {
  const args = exec.arguments ?? {}
  const pattern = args.pattern
  if (typeof pattern !== 'string') throw new Decline('invalid-arguments')
  if (args.include !== undefined && typeof args.include !== 'string') throw new Decline('invalid-arguments')
  const target = await searchTarget(host, exec, ['matches'])
  const matches = await indexerGrepSearch(target.root, target.cwd, pattern, args.include as string | undefined, { signal: exec.signal })
  if (matches === null) throw new Decline('native-search-unavailable')

  // The registry re-renders authored values and the host spills from that same
  // canonical value. Excerpting it would silently corrupt the complete result.
  if (exec.parent === undefined && matches.some(match => Buffer.byteLength(match.line, 'utf8') > GREP_PREVIEW_BYTES)) {
    throw new Decline('long-line-render-owned-by-host')
  }
  served()
  return { isError: false, value: { matches } }
}

// ---------------------------------------------------------------------------
// read — `file#Symbol` as a line window, in the built-in's value shape
// ---------------------------------------------------------------------------

interface SymbolLike {
  qualifiedName: string
  kind: string
  startLine: number
  endLine: number
  startOffset: number
  commentStartLine?: number
}

/** Pick one definition, preferring an exact qualified-name address; ambiguity is reported, never guessed. */
export function pickSymbol(candidates: readonly SymbolLike[], wanted: string): { symbol: SymbolLike } | { problem: string } {
  const normalized = wanted.trim().replace(/::/g, '.')
  const exact = candidates.filter((item) => item.qualifiedName.replace(/::/g, '.') === normalized)
  const pool = [...(exact.length > 0 ? exact : candidates)].sort((a, b) => a.startOffset - b.startOffset)
  if (pool.length === 1) return { symbol: pool[0] }
  if (pool.length === 0) return { problem: `no definition named "${wanted}"` }
  const list = pool.slice(0, 8).map((item) => `${item.qualifiedName} (${item.kind}) L${item.startLine}`).join(', ')
  return { problem: `"${wanted}" names ${pool.length} definitions — ${list}${pool.length > 8 ? ', …' : ''}. Address a unique qualified name (file#Outer.Name); for overloads sharing that name, use ff_symbols view=outline and read the desired line range with the built-in read.` }
}

/** The built-in `buildWindow` over one decoded text, limited to [first, last]. */
export function lineWindow(text: string, first: number, last: number): { lines: Array<{ number: number; text: string }>; totalLines: number } {
  const lines: Array<{ number: number; text: string }> = []
  let bytes = 0
  let capped = false
  let total = 0
  const rows = text.split('\n')
  // A trailing newline does not open another line (`buildWindow` flushes only a
  // non-empty remainder).
  if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop()
  for (const raw of rows) {
    total++
    if (capped || total < first || total > last || lines.length >= READ_LIMIT) continue
    const stripped = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const shown = stripped.length > READ_MAX_LINE_LENGTH
      ? `${stripped.substring(0, READ_MAX_LINE_LENGTH)}... (line truncated to ${READ_MAX_LINE_LENGTH} chars)`
      : stripped
    const size = Buffer.byteLength(shown, 'utf8') + (lines.length > 0 ? 1 : 0)
    if (bytes + size > READ_MAX_BYTES) { capped = true; continue }
    bytes += size
    lines.push({ number: total, text: shown })
  }
  return { lines, totalLines: total }
}

function errorResult(message: string): DispatchResult {
  return { isError: true, error: { message }, content: [{ type: 'text', text: `Error: ${message}` }] }
}

async function serveSymbolRead({ host, exec, next, served }: Call): Promise<DispatchResult> {
  const args = exec.arguments ?? {}
  const filePath = args.file_path
  if (typeof filePath !== 'string') return next()
  const at = filePath.lastIndexOf('#')
  // The overwhelmingly common call: no `#`, nothing to do.
  if (at <= 0 || at === filePath.length - 1) return next()
  // A window inside a symbol has no unambiguous meaning; the built-in answers.
  if (args.offset !== undefined || args.limit !== undefined) throw new Decline('window-arguments')
  // The filesystem the built-in reads through is the one its agent resolves.
  const fs = agentService<AugmentFileSystem>(host, exec, 'fs') ?? host.fs
  if (fs === undefined || typeof fs.stat !== 'function' || typeof fs.readText !== 'function') throw new Decline('no-filesystem')
  requireBuiltin(host, exec, ['path', 'offset', 'lines', 'totalLines'])
  const cwd = await sessionDirectory(host, exec)
  const options = { ...(cwd === undefined ? {} : { cwd }), signal: exec.signal }

  // A file that really is named `a#b` belongs to the built-in.
  const literal = await fs.resolve(filePath, options).catch(() => undefined)
  if (literal !== undefined && (await fs.stat(literal, exec.signal).catch(() => undefined)) !== undefined) {
    throw new Decline('literal-path-exists')
  }
  const file = filePath.slice(0, at)
  const wanted = filePath.slice(at + 1)
  const target = await fs.resolve(file, options).catch(() => undefined)
  if (target === undefined) throw new Decline('unresolvable')
  const info = await fs.stat(target, exec.signal)
  if (info === undefined || info.type !== 'file') throw new Decline('not-a-file')
  const absolute = fs.processPath(target)
  if (detectLanguage(absolute) === null) throw new Decline('unsupported-language')

  // The built-in's decode: strict UTF-8, NUL sniff — its refusal is its error.
  const text = await fs.readText(target, exec.signal)
  // The AST numbers lines after folding a lone CR into a break; the built-in does
  // not. Such a file has no shared line numbering, so it is left alone.
  if (/\r(?!\n)/.test(text)) throw new Decline('lone-carriage-return')
  const parsed = await parseFile(absolute)
  if (parsed.value === undefined) throw new Decline('unparsable')
  // Parsed bytes and served bytes must be the same file version.
  if (parsed.value.text !== normalizeText(text)) throw new Decline('changed-while-reading')

  const pick = pickSymbol(findSymbol(parsed.value.symbols, wanted, false), wanted)
  if ('problem' in pick) {
    served()
    return errorResult(`cannot read "${filePath}": ${pick.problem} in ${target.displayPath}`)
  }
  const first = pick.symbol.commentStartLine ?? pick.symbol.startLine
  const window = lineWindow(text, first, pick.symbol.endLine)
  host.emit?.('fs/observed', target, { kind: 'present', version: info.version }, exec)
  served()
  return { isError: false, value: { path: absolute, offset: first, lines: window.lines, totalLines: window.totalLines } }
}

// ---------------------------------------------------------------------------
// edit / write — never answered, only recorded
// ---------------------------------------------------------------------------

/**
 * Largest file this listener will snapshot. The built-in happily rewrites a
 * 200 MB log; gzip'ing two copies of it on every call buys nothing and would
 * make the write pay for the bookkeeping.
 */
const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024

type Capture =
  | { state: 'bytes'; bytes: Buffer }
  /** The file is not there — the normal case before a create. */
  | { state: 'missing' }
  /** Over budget, not a plain file, undecodable, unreadable: proceed unrecorded. */
  | { state: 'skip' }

async function captureBytes(fs: AugmentFileSystem, target: FsTarget, signal?: AbortSignal): Promise<Capture> {
  if (typeof fs.stat !== 'function' || typeof fs.readText !== 'function') return { state: 'skip' }
  const info = await fs.stat(target, signal).catch(() => undefined)
  if (info === undefined) return { state: 'missing' }
  if (info.type !== 'file' || (info.size ?? 0) > SNAPSHOT_MAX_BYTES) return { state: 'skip' }
  try {
    // Same decode the built-in applies to its own read; bytes it rejects here
    // are bytes it would have refused to edit.
    const bytes = Buffer.from(await fs.readText(target, signal), 'utf8')
    return bytes.length > SNAPSHOT_MAX_BYTES ? { state: 'skip' } : { state: 'bytes', bytes }
  } catch {
    return { state: 'skip' }
  }
}

function actorOf(exec: ToolExecution): string {
  const id = (exec.agent as { session?: { header?: { id?: unknown } } } | undefined)?.session?.header?.id
  return typeof id === 'string' && id !== '' ? id : 'unknown'
}

/**
 * Append one `edit` batch for a write the built-in already performed.
 *
 * Nothing here touches the file: the batch points at the bytes read before and
 * after `next()`, so `ffrollback` restores by the same path a `ffedit` batch
 * uses. A concurrent write to the same file between the two captures would make
 * the `after` blob someone else's content — recorded, still reviewable, and the
 * rollback still snapshots the disk before restoring.
 */
function recordBuiltinWrite(exec: ToolExecution, workdir: string, absolute: string, before: Capture, after: Capture): void {
  const store = storeFor(workspaceForFile(absolute, workdir))
  const sample = after.state === 'bytes' ? after.bytes : before.state === 'bytes' ? before.bytes : undefined
  if (sample === undefined) return
  const encoding = detectEncoding(sample.toString('utf8'))
  const beforeId = before.state === 'bytes' ? putBlob(store, before.bytes).id : null
  const afterId = after.state === 'bytes' ? putBlob(store, after.bytes).id : null
  const size = after.state === 'bytes' ? after.bytes.length : before.state === 'bytes' ? before.bytes.length : 0
  recordBatch(store, {
    kind: 'edit',
    reason: `built-in ${exec.name}`,
    actor: actorOf(exec),
    nodes: [{
      file: path.relative(store.root, absolute).split(path.sep).join('/'),
      op: beforeId === null ? 'create' : afterId === null ? 'delete' : 'update',
      before: beforeId,
      after: afterId,
      bytes: size,
      eol: encoding.eol,
      bom: encoding.bom,
    }],
  })
}

/**
 * Run the built-in write, then record it.
 *
 * The built-in is the only writer: this listener never rewrites the file, never
 * changes the value, and hands the built-in's result back by identity — a
 * failing ledger entry warns and the write still returns exactly what it did.
 */
async function serveLedgerWrite({ host, exec, next, served }: Call): Promise<DispatchResult> {
  const filePath = exec.arguments?.file_path
  if (typeof filePath !== 'string' || filePath.trim() === '') return next()
  const fs = agentService<AugmentFileSystem>(host, exec, 'fs') ?? host.fs
  if (fs === undefined || typeof fs.readText !== 'function') throw new Decline('no-filesystem')
  // The store is keyed by the session workspace, which is what the built-in
  // resolves against; without it the batch would land where no rollback looks.
  const workdir = await sessionDirectory(host, exec)
  if (workdir === undefined) throw new Decline('no-working-directory')
  const target = await fs.resolve(filePath, { cwd: workdir, signal: exec.signal }).catch(() => undefined)
  if (target === undefined) throw new Decline('unresolvable')

  const before = await captureBytes(fs, target, exec.signal)
  // Decided before the write so an unsnapshottable file costs the call nothing.
  if (before.state === 'skip') return next()
  const result = await next()
  if ((result as { isError?: unknown }).isError === true) return result
  const after = await captureBytes(fs, target, exec.signal)
  if (after.state === 'skip') return result
  if (before.state === 'missing' && after.state === 'missing') return result
  if (before.state === 'bytes' && after.state === 'bytes' && before.bytes.equals(after.bytes)) return result

  try {
    recordBuiltinWrite(exec, workdir, fs.processPath(target), before, after)
    served()
  } catch (cause) {
    host.logger?.warn(`dsh-forge: ${exec.name} landed but the ledger entry did not: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  return result
}
