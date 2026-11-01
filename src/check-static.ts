/**
 * Ledger-backed static verification for ffcheck.
 *
 * This module reconstructs before-state from recorded blobs, verifies the
 * current after-state, and compares bridge facts without depending on command
 * execution or tool registration.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { detectLanguage, syntaxValid } from './ast.ts'
import { workdirOf, type ForgeExec } from './core.ts'
import { scriptFacts, type TraceFileFacts } from './facts.ts'
import { getBlob, lastBatchId, readLedgerTail, storeFor, type LedgerBatch, type StorePaths } from './ledger.ts'
import { bridgeModel, diffBridges, type CheckResult, type Limitation } from './bridge-check.ts'
import { assembleTraceGraph } from './tools-trace.ts'
import { candidateSetDrift } from './trace-candidates.ts'
import { extractTraceFileFromBytes, selectBridgeFacts } from './trace-facts.ts'
import { aggregateChecks, hashWorkspaceFile, type CheckFinding, type CheckStatus, type CheckResult as VerificationCheckResult } from './verification.ts'
import { persistRecord } from './check-record.ts'

export type StaticStatus = 'passed' | 'failed' | 'partial' | 'not_run' | 'stale'

/** Which check produced an item. `syntax` lives here rather than in CheckKind:
 *  the bridge engine has no syntax model, and pretending otherwise would make
 *  `ffcheck` look like it runs one engine when it runs two. */
export type CheckSelector = 'bridge' | 'ipc' | 'syntax'

/**
 * One reportable item, flattened out of the bridge `Finding` and the syntax pass.
 *
 * A single shape is what lets the reply print findings from two engines in one
 * list without either one having to know about the other.
 */
export interface StaticFinding {
  check: 'bridge' | 'ipc' | 'syntax'
  kind: string
  /** `new` — this batch; `existing` — already broken; `unknown` — undecidable. */
  attribution: 'new' | 'existing' | 'unknown'
  /** The consumer that would now fail to resolve. */
  file: string
  line: number
  /** The file whose change is responsible, when the diff names one. Attribution
   *  is about the *cause*, so a broken chain on the consumer's side is not the
   *  same question as a broken chain on the provider's. */
  cause?: string
  object?: string
  member?: string
  channel?: string
  detail?: string
}

export interface FileCheckRow {
  /** Workspace-relative path. */
  file: string
  /** Ledger blob id of the earliest before-state, null for a created file. */
  before: string | null
  /** Ledger blob id of the latest after-state, null for a deleted file. */
  after: string | null
  /** SHA-256 of the bytes on disk now, null when the file is absent. */
  current: string | null
  state: 'unchanged' | 'stale' | 'deleted' | 'created' | 'missing'
  /** Do the intermediate batches for this file connect end to end? */
  chain: boolean
}

export interface StaticCheck {
  action: 'static'
  status: StaticStatus
  reason: 'checked' | 'no_batches' | 'no_files' | 'stale' | 'cancelled' | 'no_baseline' | 'not_applicable'
  detail?: string
  checks: CheckSelector[]
  findings: StaticFinding[]
  limitations: Limitation[]
  files: FileCheckRow[]
  /** Batches whose evidence produced this answer, ascending. */
  batches: number[]
  /** Files syntax-checked, and which were skipped with a reason. */
  syntax: { checked: number; failures: string[]; skipped: Array<{ file: string; reason: string }> }
  coverage: { changed: number; bridgeFiles: number; providers: number; consumers: number }
  /**
   * The archived evidence for this verdict. `persisted: false` is a real answer:
   * the check ran, the code write stands, and history cannot claim the record.
   */
  verification?: { id: string; revision?: number; persisted: boolean; detail?: string }
  results?: VerificationCheckResult[]
  text: string
}

const DEFAULT_CHECKS: CheckSelector[] = ['bridge', 'syntax']
const KNOWN_CHECKS = new Set<string>(['bridge', 'syntax', 'ipc'])

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Languages the syntax gate can actually parse, by `LangName` (not by file
 *  extension: `.jsx` and `.js` are both `javascript`). */
const SYNTAX_LANGS = new Set(['javascript', 'typescript', 'tsx'])

interface FileChain {
  before: string | null
  after: string | null
  chain: boolean
  /** Highest batch id that touched the file, for the message. */
  batch: number
}

/**
 * Per-file earliest-before / latest-after across the selected batches.
 *
 * The chain check compares each batch's `before` against the previous batch's
 * `after`. When they differ, a batch in between touched the file without being
 * selected — the diff would then attribute the *unselected* change to this one,
 * which is exactly the false accusation this tool exists to avoid.
 */
export function collectChains(batches: readonly LedgerBatch[]): Map<string, FileChain> {
  const chains = new Map<string, FileChain>()
  for (const batch of [...batches].sort((a, b) => a.id - b.id)) {
    for (const node of batch.nodes) {
      const seen = chains.get(node.file)
      if (!seen) {
        chains.set(node.file, { before: node.before, after: node.after, chain: true, batch: batch.id })
        continue
      }
      // `node.before === seen.after` is what "the chain connects" means: this
      // batch started from the state the previous one left behind.
      if (node.before !== seen.after) seen.chain = false
      seen.after = node.after
      seen.batch = batch.id
    }
  }
  return chains
}

/** Read a ledger blob and extract its facts, or explain why that failed. */
async function factsOfBlob(store: StorePaths, rel: string, blob: string): Promise<{ ok: true; facts: TraceFileFacts } | { ok: false; detail: string }> {
  const bytes = getBlob(store, blob)
  if (!bytes) return { ok: false, detail: `批次记录的 blob ${blob.slice(0, 12)}… 不在账本中（可能已被回收）` }
  const outcome = await extractTraceFileFromBytes(path.join(store.root, ...rel.split('/')), bytes, { strict: true })
  if (!outcome.value || outcome.parseErrors > 0 || outcome.partialFiles > 0) return { ok: false, detail: `before 内容无法完整提取事实：${outcome.diagnostics?.[0]?.reason ?? 'partial_parse'}` }
  return { ok: true, facts: outcome.value }
}

/** Which globals the before-state provided, so a deleted provider keeps its
 *  consumers visible during the after scan. */
function providerGlobalsOf(files: Iterable<TraceFileFacts>): string[] {
  const names = new Set<string>()
  for (const facts of files) {
    const own = scriptFacts(facts)
    for (const expose of own?.exposes ?? []) names.add(expose.name)
    for (const alias of own?.bridgeAliases ?? []) names.add(alias.name)
  }
  return [...names]
}

/**
 * Resolve the batches named by the caller, defaulting to the newest one.
 * Rejecting an unknown id is deliberate: checking "whatever is newest" when the
 * caller named a batch that is not here would answer a different question.
 */
export function resolveBatches(store: StorePaths, ids: readonly number[]): { ok: true; batches: LedgerBatch[] } | { ok: false; detail: string } {
  const tail = readLedgerTail(store, ids.length === 0 ? 1 : Number.MAX_SAFE_INTEGER)
  if (ids.length === 0) {
    const newest = tail.at(-1)
    if (!newest) return { ok: false, detail: '账本为空：这个工作区还没有任何可检查的批次' }
    return { ok: true, batches: [newest] }
  }
  const wanted = [...new Set(ids)].sort((a, b) => a - b)
  const found: LedgerBatch[] = []
  for (const id of wanted) {
    const batch = tail.find(item => item.id === id)
    if (!batch) return { ok: false, detail: `批次 #${id} 不在这个工作区的账本中（最新为 #${lastBatchId(store)}）` }
    found.push(batch)
  }
  return { ok: true, batches: found }
}

export function normaliseChecks(raw: unknown): { ok: true; checks: CheckSelector[] } | { ok: false; detail: string } {
  if (raw === undefined) return { ok: true, checks: [...DEFAULT_CHECKS] }
  const list = Array.isArray(raw) ? raw : [raw]
  if (list.length === 0) return { ok: false, detail: 'checks 不能为空数组；省略即检查 bridge 与 syntax' }
  const checks: CheckSelector[] = []
  for (const item of list) {
    if (typeof item !== 'string' || !KNOWN_CHECKS.has(item)) {
      return { ok: false, detail: `未知的检查项 ${JSON.stringify(item)}；可用：bridge, syntax, ipc` }
    }
    // `tests` and `types` are deliberately absent: this tool proves static facts
    // only. Accepting them as names would imply a capability the check lacks.
    if (item === 'ipc') {
      // IPC rides inside the bridge diff (channels are resolved there), so it is
      // accepted as a narrower selector rather than a second engine.
      checks.push('ipc')
      continue
    }
    checks.push(item as CheckSelector)
  }
  return { ok: true, checks: [...new Set(checks)] }
}

export function normaliseBatchIds(raw: unknown): { ok: true; ids: number[] } | { ok: false; detail: string } {
  if (raw === undefined) return { ok: true, ids: [] }
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, detail: 'batches must be a non-empty array of ledger batch ids' }
  if (raw.some(item => typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1)) return { ok: false, detail: 'batches must be positive integer ids' }
  return { ok: true, ids: [...new Set(raw as number[])].sort((a, b) => a - b) }
}

/** Both explicit static calls and saved plans use one evidence pipeline. */
export async function runStaticCheck(args: Record<string, unknown>, exec: ForgeExec | undefined, checkPlanId?: string): Promise<StaticCheck | { error: string }> {
  const checksResult = normaliseChecks(args.checks)
  if (!checksResult.ok) return { error: checksResult.detail }
  const checks = checksResult.checks

  const idsResult = normaliseBatchIds(args.batches)
  if (!idsResult.ok) return { error: idsResult.detail }
  const ids = idsResult.ids

  const workspace = path.resolve(workdirOf(exec))
  const store = storeFor(workspace)
  const startedAt = new Date().toISOString()
  const resolved = resolveBatches(store, ids)
  if (!resolved.ok) {
    return {
      action: 'static', status: 'not_run', reason: 'no_batches', detail: resolved.detail, checks,
      batches: ids, findings: [], limitations: [], files: [],
      syntax: { checked: 0, failures: [], skipped: [] },
      coverage: { changed: 0, bridgeFiles: 0, providers: 0, consumers: 0 },
      text: `[check] not_run (no_batches): ${resolved.detail}`,
    } satisfies StaticCheck
  }
  const batches = resolved.batches
  const batchIds = batches.map(batch => batch.id)
  const chains = collectChains(batches)

  if (chains.size === 0) {
    const detail = `批次 ${batchIds.map(id => `#${id}`).join(', ')} 没有改动任何文件，因此没有可复查的范围`
    return {
      action: 'static', status: 'not_run', reason: 'no_files', detail, checks, batches: batchIds,
      findings: [], limitations: [], files: [],
      syntax: { checked: 0, failures: [], skipped: [] },
      coverage: { changed: 0, bridgeFiles: 0, providers: 0, consumers: 0 },
      text: `[check] not_run (no_files): ${detail}`,
    } satisfies StaticCheck
  }

  try {
    exec?.signal?.throwIfAborted()
    // ---- 1. current bytes: hash, syntax and after-facts from one read ----
    const files: FileCheckRow[] = []
    const afterFacts = new Map<string, TraceFileFacts>()
    const syntaxFailures: string[] = []
    const syntaxSkipped: Array<{ file: string; reason: string }> = []
    let syntaxChecked = 0
    const stale: string[] = []
    const limitations: Limitation[] = []

    for (const [rel, chain] of chains) {
      const abs = path.join(workspace, ...rel.split('/'))
      const present = existsSync(abs)
      const bytes = present ? readFileSync(abs) : null
      const current = bytes ? sha256(bytes) : null
      let state: FileCheckRow['state']
      if (chain.after === null) state = present ? 'stale' : 'deleted'
      else if (!bytes) state = 'missing'
      else if (current !== chain.after) state = 'stale'
      else state = chain.before === null ? 'created' : 'unchanged'
      files.push({ file: rel, before: chain.before, after: chain.after, current, state, chain: chain.chain })
      if (state === 'stale' || state === 'missing') stale.push(rel)
      if (!bytes) continue
      // Parse the exact bytes that were hashed. This is what makes the
      // syntax verdict and the diff describe the same file, and it is why a
      // mismatch is reported as stale above instead of silently re-read.
      const outcome = await extractTraceFileFromBytes(abs, bytes, { strict: true })
      if (outcome.value) afterFacts.set(rel, outcome.value)

      const lang = detectLanguage(abs)
      if (!lang || !SYNTAX_LANGS.has(lang)) {
        syntaxSkipped.push({ file: rel, reason: 'language_not_supported' })
        continue
      }
      if (checks.includes('syntax')) {
        syntaxChecked++
        if (outcome.parseErrors > 0 || !await syntaxValid(bytes.toString('utf8'), lang)) syntaxFailures.push(rel)
      }
    }

    exec?.signal?.throwIfAborted()
    const staleText = `当前文件与批次记录的 after 不一致：${stale.join(', ')}。这可能是后续写入造成的，静态检查不会把别人的改动算到这个批次头上；请检查最新批次或重新捕获基线。`
    if (stale.length > 0) {
      const result: StaticCheck = {
        action: 'static', status: 'stale', reason: 'stale', detail: staleText, checks, batches: batchIds,
        findings: [], limitations, files,
        syntax: { checked: syntaxChecked, failures: syntaxFailures, skipped: syntaxSkipped },
      coverage: { changed: chains.size, bridgeFiles: chainFileCount(afterFacts, chains), providers: 0, consumers: 0 },
        text: `[check] stale: ${staleText}`,
      }
      return result
    }

    // ---- 2. before-facts from the ledger blobs --------------------------
    const beforeFacts = new Map<string, TraceFileFacts>()
    const blobFailures: string[] = []
    for (const [rel, chain] of chains) {
      if (chain.before === null) continue
      const facts = await factsOfBlob(store, rel, chain.before)
      if (!facts.ok) { blobFailures.push(`${rel}: ${facts.detail}`); continue }
      beforeFacts.set(rel, facts.facts)
    }
    exec?.signal?.throwIfAborted()

    // ---- 3. the rest of the workspace, scanned cold ---------------------
    const beforeGlobals = providerGlobalsOf(beforeFacts.values())
    const wantsBridge = checks.includes('bridge') || checks.includes('ipc')
    const assembled = wantsBridge ? await assembleTraceGraph(workspace, {
      capture: true, persistCapture: false,
      ...(beforeGlobals.length > 0 ? { extraGlobals: beforeGlobals } : {}),
      ...(exec?.signal ? { signal: exec.signal } : {}),
    }) : undefined
    const afterEntries = new Map(assembled?.graph.files ?? [])
    for (const [rel, facts] of afterFacts) afterEntries.set(rel, facts)
    // The cold scan must agree with the earlier read of every changed file.
    // Otherwise the syntax, diff and archived hash would describe different
    // versions of the same input.
    const inputHashes = new Map(assembled?.inputHashes ?? [])
    const scanDrift = files.filter(row => inputHashes.has(row.file) && inputHashes.get(row.file) !== row.current)
    if (scanDrift.length > 0) {
      const detail = `检查期间输入变化：${scanDrift.map(row => row.file).join(', ')}`
      return {
        action: 'static', status: 'stale', reason: 'stale', detail, checks, batches: batchIds,
        findings: [], limitations: [], files,
        syntax: { checked: syntaxChecked, failures: syntaxFailures, skipped: syntaxSkipped },
        coverage: { changed: chains.size, bridgeFiles: afterEntries.size, providers: 0, consumers: 0 },
        text: `[check] stale: ${detail}`,
      } satisfies StaticCheck
    }
    for (const row of files) inputHashes.set(row.file, row.current)

    // The before model starts from the current tree and rewinds only the
    // files this batch touched — the other files were not part of the change.
    const globals = new Set<string>(beforeGlobals)
    for (const facts of [...afterEntries.values(), ...beforeFacts.values()]) {
      const own = scriptFacts(facts)
      for (const expose of own?.exposes ?? []) globals.add(expose.name)
      for (const alias of own?.bridgeAliases ?? []) globals.add(alias.name)
    }
    const beforeEntries = new Map<string, TraceFileFacts>()
    for (const [rel, facts] of afterEntries) {
      // A file the batch created had no before-state at all.
      if (chains.has(rel)) continue
      beforeEntries.set(rel, facts)
    }
    // Rewind by the ledger's file set, including paths absent from after.
    for (const [rel, facts] of beforeFacts) beforeEntries.set(rel, selectBridgeFacts(facts, [...globals]))
    const after = bridgeModel({ workspace, files: new Map([...afterEntries].map(([rel, facts]) => [rel, selectBridgeFacts(facts, [...globals])])) })
    const before = bridgeModel({ workspace, files: beforeEntries })

    // ---- 4. diff --------------------------------------------------------
    const diff: CheckResult | null = wantsBridge
      ? diffBridges({
        workspace,
        before,
        after,
        changed: [...chains.keys()],
        // `ipc` alone narrows the bridge engine to channel pairing; the two
        // share one model, so this is a filter, not a second pass.
        checks: checks.includes('bridge') ? ['bridge', 'ipc'] : ['ipc'],
      })
      : null

    // Chain breaks and missing before-evidence make `new` unattributable:
    // downgrade rather than accuse a batch of someone else's change.
    const unattributable = new Set([...chains].filter(([, chain]) => !chain.chain).map(([rel]) => rel))
    const findings: StaticFinding[] = []
    for (const finding of diff?.findings ?? []) {
      const cause = finding.provider?.file
      const attribution = finding.attribution === 'new' && ((cause !== undefined && unattributable.has(cause)) || unattributable.has(finding.consumer.file)) ? 'unknown' : finding.attribution
      findings.push({
        check: finding.channel !== undefined ? 'ipc' : 'bridge',
        kind: finding.kind,
        attribution,
        file: finding.consumer.file,
        line: finding.consumer.line,
        ...(cause !== undefined ? { cause } : {}),
        ...(finding.expected.object ? { object: finding.expected.object } : {}),
        ...(finding.expected.member ? { member: finding.expected.member } : {}),
        ...(finding.channel ? { channel: finding.channel } : {}),
        detail: finding.detail,
      })
    }
    for (const failure of syntaxFailures) {
      findings.push({ check: 'syntax', kind: 'syntax_error', attribution: 'new', file: failure, line: 1, detail: `${failure} 在当前状态下无法解析：语法错误` })
    }

    const allLimitations: Limitation[] = [...diff?.limitations ?? []]
    if (assembled && (assembled.truncated || assembled.parseErrors > 0 || assembled.partialFiles > 0 || assembled.walkErrors > 0)) {
      allLimitations.push({ code: 'incomplete_scan', detail: `范围不完整：读取/解析失败 ${assembled.parseErrors}，部分解析 ${assembled.partialFiles}，遍历失败 ${assembled.walkErrors}，截断 ${assembled.truncated}` })
    }
    if (assembled?.diagnostics.some(issue => issue.reason === 'metadata_read' || issue.reason === 'metadata_parse')) {
      allLimitations.push({ code: 'incomplete_scan', detail: '参与图构建的工程元数据读取或解析失败' })
    }
    for (const item of blobFailures) allLimitations.push({ code: 'no_baseline', detail: `before 证据缺失，只能按当前状态判断：${item}` })
    for (const [rel, chain] of chains) {
      if (!chain.chain) allLimitations.push({ code: 'no_baseline', file: rel, detail: '这个文件的中间批次没有全部选中，before→after 不是一条连续链；本次结论只做当前检查，新增归因降级' })
    }
    if (syntaxSkipped.length > 0) allLimitations.push({ code: 'unsupported_file', detail: `${syntaxSkipped.length} 个文件不在可解析语言范围内，未做语法检查` })

    const introduced = findings.filter(item => item.attribution === 'new')
    const undecided = findings.filter(item => item.attribution === 'unknown')
    // `passed` needs the check to have been able to decide, not merely to
    // have found nothing. Some limitations cannot hide a *membership* answer:
    // `no_spans` only merges two sites on one line (counts, not existence),
    // and `unsupported_file` is already confined to the syntax check by the
    // `checks` selection. Those stay in `limitations` and out of this gate —
    // otherwise `no_spans` alone would make `passed` unreachable everywhere.
    const BLOCKING = new Set(['ambiguous_provider', 'unknown_binding', 'dynamic_member', 'dynamic_channel', 'no_baseline', 'no_spans', 'incomplete_scan'])
    // A skipped syntax target is a hole in a check the caller asked for. The
    // bridge half may be perfect, but `passed` would then speak for a check
    // that never ran on the one file this batch actually changed.
    const complete = allLimitations.every(item => !BLOCKING.has(item.code))

    const coverage = {
      changed: chains.size,
      bridgeFiles: after.files,
      providers: after.providers.length,
      consumers: after.consumers.length,
    }
    const syntax = { checked: syntaxChecked, failures: syntaxFailures, skipped: syntaxSkipped }
    const checkResults = staticCheckResults({ checks, findings, introduced, syntax, bridgeFiles: after.files, complete })
    const verdict = aggregateChecks(checks, checkResults, 'internal-static')
    const status: StaticStatus = verdict.status === 'unavailable' ? 'not_run' : verdict.status
    // Bind every parsed input, rather than only the files the batch changed.
    const afterHashes = [...inputHashes].map(([file, hash]) => ({ file, hash }))
    const driftDuringCheck = afterHashes.filter(entry => hashWorkspaceFile(workspace, entry.file) !== entry.hash)
    const discoveryDrift = assembled?.traceFiles === undefined ? [] : candidateSetDrift(workspace, assembled.traceFiles)
    if (driftDuringCheck.length > 0 || discoveryDrift.length > 0) {
      const detail = `检查期间输入变化：${[...driftDuringCheck.map(entry => entry.file), ...discoveryDrift].join(', ')}`
      return {
        action: 'static', status: 'stale', reason: 'stale', detail, checks, batches: batchIds,
        findings: [], limitations: allLimitations, files, syntax, coverage,
        text: `[check] stale: ${detail}`,
      } satisfies StaticCheck
    }
    const verification = await persistRecord(
      workspace, store, 'internal-static', batchIds, checks,
      checkResults,
      afterHashes, startedAt,
      { ...(checkPlanId === undefined ? {} : { checkPlanId }), ...(assembled?.traceFiles === undefined ? {} : { traceFiles: [...assembled.traceFiles] }) },
    )
    const archived = verification.persisted
      ? `[check] recorded as verification ${verification.id.slice(0, 8)}… (revision ${verification.revision})`
      : `[check] NOT recorded — ${verification.detail}. The code write stands; history cannot claim this check was archived.`
    return {
      action: 'static',
      status,
      reason: status === 'not_run' ? 'not_applicable' : 'checked',
      ...(status === 'not_run' ? { detail: verdict.reason } : {}),
      checks,
      findings,
      limitations: allLimitations,
      files,
      batches: batchIds,
      syntax,
      coverage,
      results: checkResults,
      verification: {
        id: verification.id,
        ...(verification.revision === undefined ? {} : { revision: verification.revision }),
        persisted: verification.persisted,
        ...(verification.detail === undefined ? {} : { detail: verification.detail }),
      },
      text: `${renderStatic({ status, batchIds, checks, findings, introduced, undecided, limitations: allLimitations, syntax, coverage })}\n${archived}`,
    } satisfies StaticCheck
  } catch (cause) {
    // A cancelled run must not look like a completed one. Cancellation is not
    // a failure of the code under test, so it is reported as `not_run`.
    const aborted = (cause as { name?: string } | null)?.name === 'AbortError'
    const detail = aborted
      ? '检查在完成前被取消，未产生任何通过结论'
      : `检查过程抛出：${cause instanceof Error ? cause.message : String(cause)}`
    return {
      action: 'static', status: 'not_run', reason: aborted ? 'cancelled' : 'not_applicable', detail, checks, batches: batchIds,
      findings: [], limitations: [], files: [],
      syntax: { checked: 0, failures: [], skipped: [] },
      coverage: { changed: 0, bridgeFiles: 0, providers: 0, consumers: 0 },
      text: `[check] not_run (${aborted ? 'cancelled' : 'not_applicable'}): ${detail}`,
    } satisfies StaticCheck
  }
}

/** Static findings carry structure; the record keeps the part a reader needs. */
function toFinding(finding: StaticFinding): CheckFinding {
  const what = finding.channel !== undefined
    ? `${finding.kind} ${finding.channel}`
    : `${finding.kind} ${finding.object ?? ''}${finding.member ? `.${finding.member}` : ''}`.trim()
  return {
    code: finding.kind,
    message: finding.detail ?? what,
    ...(finding.file === undefined ? {} : { source: { file: finding.file, ...(finding.line === undefined ? {} : { line: finding.line }) } }),
  }
}

/**
 * One CheckResult per requested static check.
 *
 * The split exists because the aggregate verdict is per required check: a bridge
 * finding must not make the syntax check look failed, and a skipped syntax
 * target must not be hidden behind a clean bridge run.
 */
function staticCheckResults(input: {
  checks: readonly CheckSelector[]
  findings: readonly StaticFinding[]
  introduced: readonly StaticFinding[]
  syntax: { checked: number; failures: string[]; skipped: Array<{ file: string; reason: string }> }
  bridgeFiles: number
  complete: boolean
}): VerificationCheckResult[] {
  const results: VerificationCheckResult[] = []
  for (const check of input.checks) {
    if (check === 'syntax') {
      const failures = input.syntax.failures.map(file => ({ code: 'syntax_error', message: 'the file does not parse', source: { file } }))
      const status: CheckStatus = failures.length > 0
        ? 'failed'
        : input.syntax.skipped.length > 0
          ? 'partial'
          : input.syntax.checked === 0 ? 'not_run' : 'passed'
      results.push({
        id: 'syntax',
        kind: 'syntax',
        status,
        ...(status === 'passed' ? {} : { reason: status === 'not_run' ? 'no source file was syntax-checked' : status === 'partial' ? `${input.syntax.skipped.length} target(s) skipped` : `${failures.length} parse failure(s)` }),
        coverage: { files: input.syntax.checked, ...(input.syntax.skipped.length > 0 ? { limitation: `${input.syntax.skipped.length} target(s) skipped` } : {}) },
        findings: failures,
      })
      continue
    }
    const relevant = input.findings.filter(finding => (check === 'ipc' ? finding.channel !== undefined : finding.check === check || finding.channel !== undefined))
    const introduced = input.introduced.filter(finding => (check === 'ipc' ? finding.channel !== undefined : finding.check === check || finding.channel !== undefined))
    const status: CheckStatus = introduced.length > 0
      ? 'failed'
      : relevant.length > 0 || !input.complete
        ? 'partial'
        : input.bridgeFiles === 0 ? 'not_run' : 'passed'
    results.push({
      id: check,
      kind: check,
      status,
      ...(status === 'passed' ? {} : { reason: introduced.length > 0 ? `${introduced.length} finding(s) introduced by this batch` : relevant.length > 0 ? `${relevant.length} pre-existing finding(s)` : 'coverage is incomplete' }),
      coverage: { files: input.bridgeFiles, ...(input.complete ? {} : { limitation: 'some sites could not be resolved statically' }) },
      findings: relevant.map(toFinding),
    })
  }
  return results
}

function chainFileCount(facts: ReadonlyMap<string, TraceFileFacts>, chains: ReadonlyMap<string, unknown>): number {
  let count = 0
  for (const rel of facts.keys()) if (chains.has(rel)) count++
  return count
}

function renderStatic(input: {
  status: StaticStatus
  batchIds: number[]
  checks: CheckSelector[]
  findings: readonly StaticFinding[]
  introduced: readonly StaticFinding[]
  undecided: readonly StaticFinding[]
  limitations: readonly Limitation[]
  syntax: { checked: number; failures: string[]; skipped: Array<{ file: string; reason: string }> }
  coverage: { changed: number; bridgeFiles: number; providers: number; consumers: number }
}): string {
  const lines = [`[check] ${input.status} — ${input.checks.join('+')} over batch ${input.batchIds.map(id => `#${id}`).join(', ')}`]
  lines.push(`  files: ${input.coverage.changed} changed, ${input.coverage.bridgeFiles} facts-bearing; surface: ${input.coverage.providers} provider(s), ${input.coverage.consumers} consumer site(s); syntax: ${input.syntax.checked} parsed${input.syntax.skipped.length ? `, ${input.syntax.skipped.length} skipped` : ''}`)
  for (const finding of input.findings.slice(0, 20)) {
    const what = finding.kind === 'syntax_error'
      ? 'syntax error'
      : finding.channel !== undefined
        ? `${finding.kind} ${finding.channel}`
        : `${finding.kind} ${finding.object ?? ''}${finding.member ? `.${finding.member}` : ''}`
    lines.push(`  [${finding.attribution}] ${finding.file}:${finding.line} — ${what}`)
  }
  if (input.findings.length > 20) lines.push(`  … ${input.findings.length - 20} more finding(s)`)
  if (input.limitations.length > 0) {
    const codes = [...new Set(input.limitations.map(item => item.code))]
    lines.push(`  limitations: ${codes.join(', ')} — ${input.limitations.length} item(s)`)
  }
  if (input.status === 'passed') lines.push('  every changed file matched its recorded after-hash and no statically visible consumer was left broken')
  if (input.status === 'failed') lines.push(`  ${input.introduced.length} finding(s) introduced by this batch`)
  if (input.status === 'partial' && input.undecided.length > 0) lines.push(`  ${input.undecided.length} finding(s) could not be attributed to this batch`)
  return lines.join('\n')
}

