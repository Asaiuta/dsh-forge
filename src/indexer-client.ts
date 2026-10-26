/**
 * Thin client for the Rust tree-sitter sidecar (`rust_indexer/`, MIT). The
 * sidecar speaks the same stdio JSON-lines protocol as the WASM path's symbol
 * shape, so the TS view/search helpers consume its output unchanged.
 *
 * The sidecar is OPT-IN and degrades silently: if the binary is missing, the
 * env var disables it, or the spawn/ping fails, `indexerReady()` resolves
 * false and callers fall back to the existing WASM/worker parse paths.
 *
 * Gate: `DSH_FORGE_INDEXER=0|false|off` disables; `1|true|on` forces;
 * otherwise auto (enabled when the prebuilt binary is present). An absolute
 * `DSH_FORGE_INDEXER_BIN` overrides the resolved binary path.
 *
 * @module dsh-forge/indexer-client
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectLanguage, factsFromText, type SymbolParse } from './ast.ts'
import type { TextFactsParser, TraceFileOutcome } from './trace-facts.ts'
import type { FileFacts } from './facts.ts'

/**
 * Languages the sidecar parses natively. This mirrors the sidecar's own
 * `lang::supported` table and the WASM path's language set exactly: every
 * language dsh-forge knows is served by the Rust sidecar, and anything else
 * stays on the WASM path.
 */
const SUPPORTED = new Set([
  'javascript', 'typescript', 'tsx',
  'python', 'rust', 'go', 'c', 'cpp', 'java', 'c_sharp', 'lua',
])

let child: ChildProcess | null = null
let seq = 1
let disabled = false
let readyPromise: Promise<boolean> | null = null
const pending = new Map<number, { resolve(value: unknown): void; reject(cause: Error): void }>()

function binaryPath(): string | null {
  const override = process.env.DSH_FORGE_INDEXER_BIN?.trim()
  if (override) return path.resolve(override)
  const name = process.platform === 'win32' ? 'dsh_forge_indexer.exe' : 'dsh_forge_indexer'
  const fromLib = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'rust_indexer', 'bin', name)
  if (existsSync(fromLib)) return fromLib
  const fromCwd = path.resolve(process.cwd(), 'rust_indexer', 'bin', name)
  return existsSync(fromCwd) ? fromCwd : null
}

function wanted(): boolean {
  const raw = process.env.DSH_FORGE_INDEXER?.trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'off') return false
  if (raw === '1' || raw === 'true' || raw === 'on') return true
  return true // auto: enabled when the binary exists (checked in ready())
}

/** Whether the sidecar can natively parse this language. */
export function indexerCanParse(lang: string | null): boolean {
  return lang !== null && SUPPORTED.has(lang)
}

function ensureChild(): ChildProcess | null {
  if (child || disabled) return child
  const exe = binaryPath()
  if (!exe) { disabled = true; return null }
  try {
    child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  } catch {
    disabled = true
    return null
  }
  // The sidecar is a persistent helper; it must not keep a short-lived host
  // (tests, one-shot tool runs) alive after its own work is done. Unref the
  // process and its stdio so the parent can exit; stdin EOF then stops the
  // sidecar cleanly.
  const spawned = child
  spawned.unref()
  ;(spawned.stdin as { unref?: () => void } | null)?.unref?.()
  ;(spawned.stdout as { unref?: () => void } | null)?.unref?.()
  ;(spawned.stderr as { unref?: () => void } | null)?.unref?.()
  const failed = (cause: Error) => {
    // A reset may already have installed a new child. Old events belong only
    // to the previous process and must not reject its successor's requests.
    if (child !== spawned) return
    for (const p of pending.values()) p.reject(cause)
    pending.clear()
    child = null
    disabled = true
  }
  spawned.on('error', failed)
  spawned.on('exit', () => failed(new Error('indexer exited')))
  spawned.stdin!.on('error', failed)
  spawned.stdout!.setEncoding('utf8')
  // A traceFacts reply is one long line: search only the newly arrived text
  // so assembling it stays linear in its size.
  const parts: string[] = []
  spawned.stdout!.on('data', (chunk: string) => {
    if (child !== spawned) return
    let nl = chunk.indexOf('\n')
    if (nl < 0) { parts.push(chunk); return }
    let rest = chunk
    while (nl >= 0) {
      parts.push(rest.slice(0, nl))
      const line = parts.join('')
      parts.length = 0
      rest = rest.slice(nl + 1)
      nl = rest.indexOf('\n')
      if (!line.trim()) continue
      let msg: { id?: number; ok?: boolean; error?: string }
      try { msg = JSON.parse(line) } catch { continue }
      const p = pending.get(msg.id as number)
      if (!p) continue
      pending.delete(msg.id as number)
      if (msg.ok) p.resolve(msg)
      else p.reject(new Error(msg.error ?? 'indexer error'))
    }
    if (rest) parts.push(rest)
  })
  spawned.stderr!.on('data', () => { /* swallow diagnostics */ })
  return spawned
}

interface RequestOptions { signal?: AbortSignal; deadline?: number }

function request(method: string, params: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<unknown> {
  if (options.signal?.aborted) return Promise.reject(options.signal.reason)
  const timeoutMs = Math.min(30_000, (options.deadline ?? Date.now() + 30_000) - Date.now())
  if (timeoutMs <= 0) return Promise.reject(new Error('indexer request budget exhausted'))
  const currentTransport = transport
  const c = currentTransport === null ? ensureChild() : null
  if (currentTransport === null && !c) return Promise.reject(new Error('indexer unavailable'))
  const id = seq++
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (cause?: unknown, value?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      pending.delete(id)
      if (cause !== undefined) reject(cause)
      else resolve(value)
    }
    const abort = () => finish(options.signal?.reason ?? new Error('indexer request aborted'))
    const timer = setTimeout(() => finish(new Error('indexer request timed out')), timeoutMs)
    pending.set(id, {
      resolve: value => finish(undefined, value),
      reject: cause => finish(cause),
    })
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) { abort(); return }
    if (currentTransport !== null) {
      Promise.resolve().then(() => settled ? undefined : currentTransport(method, params)).then(value => finish(undefined, value), cause => finish(cause))
    } else {
      try {
        c!.stdin!.write(JSON.stringify({ id, method, ...params }) + '\n', cause => { if (cause) finish(cause) })
      } catch (cause) { finish(cause) }
    }
  })
}

/**
 * Transport seam for tests.
 *
 * The rule the callers below enforce — a sidecar that answers `ok` while having
 * parsed nothing is a read failure, not an empty search — cannot be exercised by
 * a stub executable: on Windows `spawn` refuses a `.cmd`/`.bat` without a shell,
 * and the real cause (an integrity label on the binary) does not exist on a
 * clean machine. Installing a transport is therefore the only way to pin it.
 */
let transport: ((method: string, params: Record<string, unknown>) => Promise<unknown>) | null = null

/** Test hook: answer protocol calls in-process instead of over stdio. */
export function setIndexerTransportForTest(
  fn: ((method: string, params: Record<string, unknown>) => Promise<unknown>) | null,
): void {
  transport = fn
  readyPromise = null
  disabled = false
}

/** Spawn + ping once; cached. Caller budgets/cancellation bound only their
 *  own wait, leaving the shared ping available to other callers. */
export function indexerReady(options: RequestOptions = {}): Promise<boolean> {
  if (options.signal?.aborted) return Promise.reject(options.signal.reason)
  if (options.deadline !== undefined && options.deadline <= Date.now()) return Promise.resolve(false)
  if (!wanted()) return Promise.resolve(false)
  readyPromise ??= (async () => {
    try {
      const reply = (await request('ping', {}, { deadline: Date.now() + 2_000 })) as { ok?: boolean }
      return reply.ok === true
    } catch {
      return false
    }
  })()
  if (!options.signal && options.deadline === undefined) return readyPromise
  const shared = readyPromise
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (cause?: unknown, value = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (cause !== undefined) reject(cause)
      else resolve(value)
    }
    const abort = () => finish(options.signal?.reason ?? new Error('indexer readiness aborted'))
    if (options.deadline !== undefined) timer = setTimeout(() => finish(), Math.max(0, options.deadline - Date.now()))
    options.signal?.addEventListener('abort', abort, { once: true })
    shared.then(value => finish(undefined, value), cause => finish(cause))
    if (options.signal?.aborted) abort()
  })
}

/**
 * Batch-parse supported-language files through the sidecar in ONE round trip.
 * Files of unsupported languages are skipped (not sent); a missing key in the
 * returned map means "caller should fall back to the WASM path".
 */
export async function indexerParseBatch(
  paths: string[],
): Promise<Map<string, SymbolParse>> {
  const out = new Map<string, SymbolParse>()
  const targets: string[] = []
  for (const abs of paths) {
    if (indexerCanParse(detectLanguage(abs))) targets.push(abs)
  }
  if (targets.length === 0) return out
  let reply: { results?: Array<Record<string, unknown>> }
  try {
    reply = (await request('parseBatch', { files: targets })) as typeof reply
  } catch {
    return out
  }
  for (const item of reply.results ?? []) {
    const abs = item.absPath as string | undefined
    if (!abs) continue
    if (item.error || typeof item.lang !== 'string') continue
    const signatures = new Map<number, string>()
    for (const [k, v] of Object.entries((item.signatures as Record<string, string>) ?? {})) {
      signatures.set(Number(k), v)
    }
    out.set(abs, {
      absPath: abs,
      lang: item.lang as SymbolParse['lang'],
      hash: '',
      symbols: (item.symbols as SymbolParse['symbols']) ?? [],
      signatures,
      partial: (item.partial as boolean) ?? false,
    })
  }
  return out
}

/** Languages whose Trace facts the sidecar extracts (rust_indexer/src/facts). */
const TRACE_LANGS = new Set(['javascript', 'typescript', 'tsx', 'python', 'rust', 'c', 'cpp', 'go', 'java', 'lua'])
const TRACE_CHUNK = 2000

/** Gate: `DSH_FORGE_TRACE_NATIVE=0|false|off` keeps Trace facts on the WASM path. */
export function indexerTraceWanted(): boolean {
  const raw = process.env.DSH_FORGE_TRACE_NATIVE?.trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

export function indexerTraceLang(abs: string): boolean {
  const lang = detectLanguage(abs)
  return lang !== null && TRACE_LANGS.has(lang)
}

/**
 * Trace facts for source files, aligned with `paths`. `null` means "re-extract
 * on the WASM path" (files over the size cap, trees too deep for the native
 * walk, an older binary), keeping its diagnostics. Cleanly parsed files match
 * the WASM path exactly (rust_indexer/parity-facts.mjs); a partially parsed
 * file keeps the newer native grammar's error recovery rather than loading
 * WASM for it — one WASM fallback costs ~1 GB of V8 compilation memory.
 */
export async function indexerTraceFacts(paths: string[], signal?: AbortSignal): Promise<Array<TraceFileOutcome | null>> {
  const out: Array<TraceFileOutcome | null> = paths.map(() => null)
  for (let start = 0; start < paths.length; start += TRACE_CHUNK) {
    signal?.throwIfAborted()
    const files = paths.slice(start, start + TRACE_CHUNK)
    let reply: { results?: unknown }
    try {
      reply = (await request('traceFacts', { files }, { signal })) as typeof reply
    } catch {
      signal?.throwIfAborted()
      return out // older binary or sidecar failure: the rest falls back
    }
    const results = reply.results
    if (!Array.isArray(results) || results.length !== files.length) return out
    results.forEach((item: Partial<TraceFileOutcome> & { error?: string }, offset) => {
      if (item && !item.error && item.value && item.parseErrors === 0) out[start + offset] = item as TraceFileOutcome
    })
  }
  return out
}

/** Inline script facts through the sidecar (partial parses included, as for
 *  source files); only a sidecar failure uses the WASM parser. */
export const indexerTextFacts: TextFactsParser = async (text, syntax) => {
  try {
    const reply = (await request('textFacts', { text, syntax })) as { facts?: FileFacts; partial?: boolean }
    if (reply.facts && typeof reply.partial === 'boolean') return { facts: reply.facts, partial: reply.partial }
  } catch { /* fall through to WASM */ }
  return factsFromText(text, null, syntax)
}

export interface IndexerHit {
  absPath: string
  qualifiedName: string
  kind: string
  occurrence: number
  startLine: number
  endLine: number
  commentStartLine?: number
  signature: string
}

/**
 * Name search across a file list in ONE round trip: the sidecar matches and
 * assigns occurrences (in Rust), returning only hits — no full-tree
 * serialization, which keeps warm queries near the cost of a per-file stat.
 *
 * `parsed` is the number of code files scanned (a property of the corpus, so
 * warm and cold agree); `reparsed` is how many actually had to be parsed, i.e.
 * the genuine cache-miss count — 0 on a fully warm query. Returns null on any
 * failure (caller falls back to the WASM path).
 */
export async function indexerFindSymbols(
  files: string[],
  name: string,
  kinds: string[] | null,
  options: RequestOptions = {},
): Promise<{ items: IndexerHit[]; parsed: number; reparsed: number } | null> {
  try {
    const reply = (await request('findSymbols', { files, name, kinds }, options)) as {
      items?: IndexerHit[]; parsed?: number; reparsed?: number
    }
    const parsed = reply.parsed ?? 0
    // `ok` with nothing parsed is not a search, it is a total read failure: every
    // supported file this caller filtered and handed over failed to open. The
    // observed cause is an integrity label on the binary — a Low-IL image starts
    // a LOW process, and No-Write-Up then denies reads of ordinary source files
    // (`OS Error 5` inside the sidecar). Returning `items: []` would be
    // indistinguishable from "that symbol does not exist" and would end the
    // search with an empty answer, so report unavailability and let the caller
    // take the WASM path instead.
    if (files.length > 0 && parsed === 0) return null
    return { items: reply.items ?? [], parsed, reparsed: reply.reparsed ?? 0 }
  } catch {
    options.signal?.throwIfAborted()
    return null
  }
}

/**
 * Root-walk native search: the sidecar walks `root` (gitignore + ignore-dirs),
 * parses, and matches in one process, so a warm query never ships a file list
 * over stdio and never walks in JS. Returns null on any failure.
 */
export async function indexerFindSymbolsRoot(
  root: string,
  name: string,
  kinds: string[] | null,
): Promise<{ allSupported: boolean; items: IndexerHit[]; parsed: number } | null> {
  try {
    const reply = (await request('findSymbolsRoot', { root, name, kinds })) as { allSupported?: boolean; items?: IndexerHit[]; parsed?: number; reparsed?: number }
    const parsed = reply.parsed ?? 0
    // Same rule as {@link indexerFindSymbols}, keyed on `reparsed`: the sidecar
    // walked files and parsed none of them, which is a read failure rather than
    // an empty tree. A root with genuinely no code files reports both as 0 and
    // still falls through as a real empty answer.
    if ((reply.reparsed ?? 0) > 0 && parsed === 0) return null
    return { allSupported: reply.allSupported === true, items: reply.items ?? [], parsed }
  } catch {
    return null
  }
}

/** Test hook: drop the sidecar process and its in-process cache. */
export async function resetIndexer(): Promise<void> {
  try { await request('resetCache', {}) } catch { /* ignore */ }
  const previous = child
  child = null
  for (const p of pending.values()) p.reject(new Error('indexer reset'))
  pending.clear()
  previous?.kill()
  readyPromise = null
  disabled = false
}
