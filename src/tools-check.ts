/**
 * ffcheck: the formal verification entry.
 *
 * The post-edit audit (`edit-audit.ts`) is *advice*: it rides on the write path,
 * so it may only use a graph that is already warm, and its result can never be
 * `passed`. This tool is the other half of that split — called explicitly, it is
 * allowed to scan cold, and it is the only place a check may earn `passed`.
 *
 * `action=static` answers one question with evidence attached: **did this batch
 * (or chain of batches) leave a statically visible consumer broken?**
 *
 * The before-side is reconstructed from the ledger, not from the workspace:
 *
 *   1. Resolve the batches and compute, per file, the earliest `before` and the
 *      latest `after` blob (plus whether the intermediate chain connects).
 *   2. The current bytes must equal the recorded `after`, or the answer is
 *      `stale` — a check must never attribute someone else's later edit to this
 *      batch.
 *   3. Extract before-facts from the ledger blobs, and after-facts from the bytes
 *      that were just hashed and syntax-checked. One read serves the hash, the
 *      parse and the diff, so none of the three can describe a different file.
 *   4. Diff by member identity (`bridge-check.ts`), never by line number.
 *
 * A batch that touched ten files still owes one answer, so `chains` merges per
 * file instead of producing a per-file verdict. Deleting a file is listed as not
 * applicable rather than counted as a clean check, and an empty scope is
 * `not_run` — never a silent `passed`.
 *
 * @module dsh-forge/tools-check
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { detectLanguage, syntaxValid } from './ast.ts'
import { workdirOf, type ForgeExec } from './core.ts'
import { scriptFacts } from './facts.ts'
import { getBlob, lastBatchId, readLedgerTail, storeFor, type LedgerBatch, type StorePaths } from './ledger.ts'
import { bridgeModel, diffBridges, type CheckKind, type CheckResult, type Finding, type Limitation } from './bridge-check.ts'
import { assembleTraceGraph } from './tools-trace.ts'
import { candidateFilesOf, candidateSetDrift, collectCandidatesLocal } from './trace-candidates.ts'
import { extractTraceFileFromBytes, selectBridgeFacts } from './trace-facts.ts'
import { TRACE_SCAN_EXTENSIONS } from './trace-capabilities.ts'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { TraceFileFacts } from './facts.ts'
import { hashInputs, loadPlan, manifestDrift, planId, savePlan, type CheckPlan, type CheckRecipe, type RecipeKind } from './check-plan.ts'
import { hostCheckCapabilities, runHostCheck, type HostCheckResult, type HostCheckServices } from './check-host.ts'
import {
  aggregateChecks, appendRecord, hashWorkspaceFile, newRecordId, VERIFICATION_SCHEMA,
  type CheckFinding, type CheckStatus, type Provenance, type VerificationRecord,
} from './verification.ts'
import { crossCheckReport, interpretTestReport, parseTap } from './tap.ts'
import { interpretTypeReport, parseTypeDiagnostics } from './types-check.ts'
import type { CheckResult as VerificationCheckResult } from './verification.ts'
import { workspaceKey } from './ledger.ts'

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
function resolveBatches(store: StorePaths, ids: readonly number[]): { ok: true; batches: LedgerBatch[] } | { ok: false; detail: string } {
  const tail = readLedgerTail(store, 4000)
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

function normaliseChecks(raw: unknown): { ok: true; checks: CheckSelector[] } | { ok: false; detail: string } {
  if (raw === undefined) return { ok: true, checks: [...DEFAULT_CHECKS] }
  const list = Array.isArray(raw) ? raw : [raw]
  if (list.length === 0) return { ok: false, detail: 'checks 不能为空数组；省略即检查 bridge 与 syntax' }
  const checks: CheckSelector[] = []
  for (const item of list) {
    if (typeof item !== 'string' || !KNOWN_CHECKS.has(item)) {
      return { ok: false, detail: `未知的检查项 ${JSON.stringify(item)}；可用：bridge, syntax${''}` }
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

function normaliseBatchIds(raw: unknown): { ok: true; ids: number[] } | { ok: false; detail: string } {
  if (raw === undefined) return { ok: true, ids: [] }
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, detail: 'batches must be a non-empty array of ledger batch ids' }
  if (raw.some(item => typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1)) return { ok: false, detail: 'batches must be positive integer ids' }
  return { ok: true, ids: [...new Set(raw as number[])].sort((a, b) => a - b) }
}

const CHECK_PARAMETERS: ParameterSchemaSpec = {
      action: { type: 'string', required: true, enum: ['static', 'plan', 'run'], description: 'static: 只做静态复查（桥接/IPC 表面与语法）。plan: 生成受审批约束的检查计划，返回 checkPlanId。run: 只接受已保存的 checkPlanId，经宿主审批后执行；每条 recipe 按计划冻结的 kind 解读（process 只报退出码，tests 解读 Node TAP，types 解读 TypeScript 诊断），无法解读时给 partial 而不是通过。' },
      checkPlanId: { type: 'string', description: 'action=run 必填：action=plan 返回的 32 位十六进制 id。不接受直接传入程序或参数。' },
      inputs: { type: 'array', items: { type: 'string' }, description: 'action=plan：计划所依赖的输入文件（相对工作区）。执行前后都会重新哈希，变化则结果 stale。' },
      recipes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        program: { type: 'string', required: true },
        argv: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
        kind: { type: 'string', enum: ['process', 'tests', 'types'], description: '这条命令的结果允许怎么解读，冻结进计划哈希：process 只报退出码；tests 解读 Node TAP 报告（零测试/全 skip/全 todo/截断/外来报告都拒绝）；types 解读 TypeScript 诊断（安静只在退出 0 时算干净）。省略即 process。' },
        scope: { type: 'array', items: { type: 'string' }, description: 'kind=tests 时可选：这条命令被批准执行的路径。用于把「文件级包装条目」与同名真实测试区分开——注册零测试的文件同样报 ok 和 # pass 1。' },
      } }, description: 'action=plan：要冻结的检查命令列表，argv 为参数数组、不经 shell 解释。kind 决定结果怎么解读，并与 id 一起冻结进 checkPlanId，审批不会顺延到另一个命令或另一种解读。' },
      batches: { type: 'array', items: { type: 'integer' }, description: '要检查的账本批次号（升序合并；每个文件取最早 before、最后 after）。省略则检查最新批次。' },
      checks: { type: 'array', items: { type: 'string', enum: ['bridge', 'syntax', 'ipc'] }, description: '要执行的静态检查项，有批次时默认 bridge+syntax。plan 可传 [] 仅执行命令；没有批次时 plan 默认不含静态项。' },
}

export function createCheckTool(services?: HostCheckServices) {
  return {
    name: 'ffcheck',
    description:
      'Explicit verification of what a batch (or a chain of batches) left behind. action=static reconstructs the before-state from the ledger, re-reads the current files, and diffs bridge/IPC surface plus syntax by member identity — not by line number. Returns a per-check status with coverage, never a bare boolean; refs current bytes against the recorded after-hash and reports stale instead of blaming this batch for a later edit. Deleted files are listed as not applicable; an empty scope is not_run, never passed. action=plan freezes commands and returns a checkPlanId; action=run executes only that id behind host approval, and each recipe is read according to the kind the plan froze: process claims the exit code only, tests interprets a Node TAP report (refusing zero-test, all-skip, all-todo, truncated or foreign reports), types interprets TypeScript diagnostics (silence counts only with exit 0).',
    parameters: CHECK_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['passed', 'failed', 'partial', 'not_run', 'stale', 'completed', 'denied', 'cancelled', 'interrupted', 'unavailable'] },
          reason: { type: 'string', required: true },
          detail: { type: 'string' },
          checks: { type: 'array', required: true, items: { type: 'string' } },
          batches: { type: 'array', required: true, items: { type: 'integer' } },
          findings: {
            type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
              kind: { type: 'string', required: true },
              check: { type: 'string', required: true },
              attribution: { type: 'string', required: true },
              file: { type: 'string' }, line: { type: 'integer' }, cause: { type: 'string' },
              object: { type: 'string' }, member: { type: 'string' }, channel: { type: 'string' },
              detail: { type: 'string' },
            } },
          },
          limitations: {
            type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
              code: { type: 'string', required: true }, detail: { type: 'string', required: true }, file: { type: 'string' }, line: { type: 'integer' },
            } },
          },
          files: {
            type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
              file: { type: 'string', required: true },
              before: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
              after: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
              current: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
              state: { type: 'string', required: true }, chain: { type: 'boolean', required: true },
            } },
          },
          syntax: {
            type: 'object', required: true, additionalProperties: false, properties: {
              checked: { type: 'integer', required: true },
              failures: { type: 'array', required: true, items: { type: 'string' } },
              skipped: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                file: { type: 'string', required: true }, reason: { type: 'string', required: true },
              } } },
            },
          },
          coverage: {
            type: 'object', required: true, additionalProperties: false, properties: {
              changed: { type: 'integer', required: true }, bridgeFiles: { type: 'integer', required: true },
              providers: { type: 'integer', required: true }, consumers: { type: 'integer', required: true },
            },
          },
          checkPlanId: { type: 'string' },
          results: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            id: { type: 'string', required: true }, kind: { type: 'string', required: true },
            status: { type: 'string', required: true }, reason: { type: 'string' },
            coverage: { type: 'object', additionalProperties: false, properties: {
              files: { type: 'integer', required: true }, sites: { type: 'integer' }, limitation: { type: 'string' },
            } },
            findings: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
              code: { type: 'string', required: true }, message: { type: 'string', required: true },
              source: { type: 'object', additionalProperties: false, properties: { file: { type: 'string', required: true }, line: { type: 'integer' } } },
            } } },
          } } },
          staticVerification: {
            type: 'object', additionalProperties: false, properties: {
              id: { type: 'string', required: true }, revision: { type: 'integer' },
              persisted: { type: 'boolean', required: true }, detail: { type: 'string' },
            },
          },
          verification: {
            type: 'object', additionalProperties: false, properties: {
              id: { type: 'string', required: true },
              revision: { type: 'integer' },
              persisted: { type: 'boolean', required: true },
              detail: { type: 'string' },
            },
          },
          planned: { type: 'array', items: { type: 'string' } },
          runs: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            recipe: { type: 'string', required: true },
            status: { type: 'string', required: true },
            exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
            callId: { type: 'string' },
            output: { type: 'string' },
            detail: { type: 'string' },
            kind: { type: 'string', description: 'The recipe kind the plan froze: process, tests or types.' },
            verdict: { type: 'string', description: 'What this run permits the caller to claim: process_ok, process_failed, passed, failed, unverifiable.' },
            verdictDetail: { type: 'string' },
          } } },
          text: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: { text?: string }) => [{ type: 'text' as const, text: typeof value?.text === 'string' ? value.text : 'no result' }],
    },
    // A check reads the workspace cold (git ignores, ledger blobs, WASM parses).
    // Two of them interleaved would only duplicate that work and contend on the
    // parse pool, so the host serialises them.
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined, raw?: ForgeExec) {
      const action = args.action
      if (action === 'plan') return planCheck(args, exec)
      if (action === 'run') return runCheck(args, exec, raw, services)
      if (action !== 'static') return { error: 'action must be "static", "plan" or "run"' }

      return runStaticCheck(args, exec)

    },
  } as const
}


/** Both explicit static calls and saved plans use one evidence pipeline. */
async function runStaticCheck(args: Record<string, unknown>, exec: ForgeExec | undefined, checkPlanId?: string): Promise<StaticCheck | { error: string }> {
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

/**
 * `action=plan` — freeze a checklist and hand back its id.
 *
 * Planning is deliberately inert: it prompts nobody, starts nothing and reads
 * only the declared inputs, because a plan is what a human is *later* asked to
 * approve. A plan that had already done work would make the approval a
 * formality.
 */
function planCheck(args: Record<string, unknown>, exec: ForgeExec | undefined) {
  const workspace = path.resolve(workdirOf(exec))
  const checksResult = Array.isArray(args.checks) && args.checks.length === 0
    ? { ok: true as const, checks: [] as CheckSelector[] }
    : normaliseChecks(args.checks)
  if (!checksResult.ok) return { error: checksResult.detail }
  let staticChecks = checksResult.checks

  const recipesResult = normaliseRecipes(args.recipes, workspace)
  if (!recipesResult.ok) return { error: recipesResult.detail }
  const recipes = recipesResult.recipes
  if (recipes.length === 0) return { error: 'recipes must contain at least one command; a plan with no recipe has nothing to approve' }

  const inputsResult = normaliseInputs(args.inputs)
  if (!inputsResult.ok) return { error: inputsResult.detail }
  const idsResult = normaliseBatchIds(args.batches)
  if (!idsResult.ok) return { error: idsResult.detail }
  const selected = resolveBatches(storeFor(workspace), idsResult.ids)
  if (!selected.ok && args.batches !== undefined) return { error: selected.detail }
  const batchIds = selected.ok ? selected.batches.map(batch => batch.id) : []
  if (batchIds.length === 0) {
    if (args.checks !== undefined && staticChecks.length > 0) return { error: 'static checks in a plan require a ledger batch; use checks: [] for execution only' }
    staticChecks = []
  }
  const chains = collectChains(selected.ok ? selected.batches : [])
  const scopedInputs = normaliseInputs(recipes.flatMap(recipe => (recipe.scope ?? []).map(file => path.relative(workspace, path.resolve(recipe.cwd, file)).replaceAll('\\', '/'))))
  if (!scopedInputs.ok) return { error: `recipe scope: ${scopedInputs.detail}` }
  const candidates = staticChecks.some(check => check === 'bridge' || check === 'ipc') ? collectCandidatesLocal(workspace) : undefined
  if (candidates && (candidates.truncated || candidates.walkErrors > 0)) return { error: 'static plan input discovery is incomplete; cannot freeze the check inputs' }
  const traceFiles = candidates === undefined ? undefined : candidateFilesOf(candidates)
  const inputManifest = hashInputs(workspace, [...new Set([...inputsResult.files, ...scopedInputs.files, ...chains.keys(), ...(traceFiles ?? []), ...(traceFiles ? ['.gitignore'] : [])])])
  for (const [file, chain] of chains) {
    if (inputManifest[file] !== (chain.after ?? 'absent')) return { error: `batch inputs are stale: ${file} no longer matches the selected batch's after content` }
  }

  const context = { workspace, batchIds, inputManifest, ...(traceFiles === undefined ? {} : { traceFiles }) }
  const plan: CheckPlan = {
    checkPlanId: planId(recipes, staticChecks, context),
    workspace,
    createdAt: new Date().toISOString(),
    staticChecks,
    recipes,
    batchIds,
    inputManifest,
    ...(traceFiles === undefined ? {} : { traceFiles }),
  }
  savePlan(plan)

  const planned = [
    ...staticChecks.map(check => `static:${check}`),
    ...recipes.map(recipe => `run:${recipe.id} → ${recipe.program} ${recipe.argv.join(' ')}`.trimEnd()),
  ]
  const lines = [
    `[check] plan ${plan.checkPlanId}`,
    `  static: ${staticChecks.join('+') || 'none (execution only)'}`,
    ...recipes.map(recipe => `  recipe ${recipe.id} [${recipe.kind}]: ${recipe.program} ${recipe.argv.join(' ')}`.trimEnd()),
    // Warnings are shown before approval, never after: the point of a plan is
    // that the human sees what they are agreeing to.
    ...recipesResult.warnings.map(warning => `  [warn] ${warning}`),
    `  inputs: ${Object.keys(inputManifest).length} hashed; batches: ${batchIds.length > 0 ? batchIds.map(id => `#${id}`).join(', ') : 'none (execution only)'}`,
    '  nothing has been approved or executed yet; call action=run with this checkPlanId to request approval',
  ]
  return {
    action: 'plan',
    status: 'not_run',
    reason: 'planned',
    detail: 'check plan saved; approval and execution happen on action=run',
    checks: staticChecks,
    batches: batchIds,
    findings: [],
    limitations: [],
    files: [],
    syntax: { checked: 0, failures: [] as string[], skipped: [] },
    coverage: { changed: 0, bridgeFiles: 0, providers: 0, consumers: 0 },
    checkPlanId: plan.checkPlanId,
    planned,
    text: lines.join('\n'),
  }
}

/**
 * `action=run` — approve, dispatch, and report only what the process proves.
 *
 * The frozen inputs cover static dependencies and recipe scope. Static and
 * host results retain separate records linked by this plan; all required
 * checks participate in the verdict.
 */
async function runCheck(args: Record<string, unknown>, exec: ForgeExec | undefined, raw: ForgeExec | undefined, services: HostCheckServices | undefined) {
  const workspace = path.resolve(workdirOf(exec))
  const startedAt = new Date().toISOString()
  const id = args.checkPlanId
  if (typeof id !== 'string' || id.length === 0) {
    return { error: 'action=run requires checkPlanId from action=plan; programs and arguments are never accepted directly' }
  }
  const loaded = loadPlan(workspace, id)
  if (!loaded.ok) {
    return {
      action: 'run', status: 'not_run', reason: 'unknown_plan', detail: loaded.detail,
      checks: [] as string[], batches: [] as number[], findings: [], limitations: [], files: [],
      syntax: { checked: 0, failures: [] as string[], skipped: [] },
      coverage: { changed: 0, bridgeFiles: 0, providers: 0, consumers: 0 },
      checkPlanId: id, planned: [], runs: [],
      text: `[check] not_run (unknown_plan): ${loaded.detail}`,
    }
  }
  const plan = loaded.plan

  // Before dispatch: the plan is only meaningful for the inputs it was formed
  // against. A drifted input means the answer would describe a tree that no
  // longer exists, so nothing is started.
  const before = manifestDrift(workspace, plan.inputManifest, plan.traceFiles)
  if (before.length > 0) {
    const detail = `plan inputs changed since planning: ${before.join(', ')}`
    return {
      action: 'run', status: 'stale', reason: 'input_drift', detail,
      checks: plan.staticChecks, batches: plan.batchIds, findings: [], limitations: [], files: [],
      syntax: { checked: 0, failures: [] as string[], skipped: [] },
      coverage: { changed: 0, bridgeFiles: 0, providers: 0, consumers: 0 },
      checkPlanId: plan.checkPlanId, planned: [], runs: [],
      text: `[check] stale (input_drift): ${detail}\n  re-plan to describe the current tree; the previous approval does not carry over`,
    }
  }

  if (services === undefined) {
    return {
      action: 'run', status: 'unavailable', reason: 'no_host_services', detail: 'this plugin instance was mounted without host service access',
      checks: plan.staticChecks, batches: plan.batchIds, findings: [], limitations: [], files: [],
      syntax: { checked: 0, failures: [] as string[], skipped: [] },
      coverage: { changed: 0, bridgeFiles: 0, providers: 0, consumers: 0 },
      checkPlanId: plan.checkPlanId, planned: [], runs: [],
      text: '[check] unavailable (no_host_services): this build cannot reach the approval or subprocess seam',
    }
  }
  const capabilities = hostCheckCapabilities(services)
  if (capabilities.status !== 'ok') {
    return {
      action: 'run', status: 'unavailable', reason: 'no_execution_seam', detail: capabilities.reason ?? 'host seams unavailable',
      checks: plan.staticChecks, batches: plan.batchIds, findings: [], limitations: [], files: [],
      syntax: { checked: 0, failures: [] as string[], skipped: [] },
      coverage: { changed: 0, bridgeFiles: 0, providers: 0, consumers: 0 },
      checkPlanId: plan.checkPlanId, planned: [], runs: [],
      text: `[check] unavailable (no_execution_seam): ${capabilities.reason ?? 'host seams unavailable'}`,
    }
  }

  const runs: Array<{
    recipe: string; status: string; exitCode?: number | null; callId?: string; output?: string; detail?: string
    /** The recipe kind the plan froze, echoed so a reader sees what was approved. */
    kind?: string
    /** What this run lets the caller claim: process_ok, passed, failed, unverifiable… */
    verdict?: string
    /** Why the verdict is not a pass. */
    verdictDetail?: string
  }> = []
  const outputs: string[] = []
  const checkResults: VerificationCheckResult[] = []
  const staticOutcome = plan.staticChecks.length > 0
    ? await runStaticCheck({ checks: plan.staticChecks, batches: plan.batchIds }, exec, plan.checkPlanId)
    : undefined
  if (staticOutcome && 'error' in staticOutcome) return { error: staticOutcome.error }
  const staticResult = staticOutcome as StaticCheck | undefined
  for (const recipe of plan.recipes) {
    const drift = manifestDrift(workspace, plan.inputManifest, plan.traceFiles)
    if (drift.length > 0) {
      const reason = `inputs changed before recipe ${recipe.id}: ${drift.join(', ')}`
      runs.push({ recipe: recipe.id, status: 'stale', kind: recipe.kind, detail: reason })
      checkResults.push({ id: recipe.id, kind: recipe.kind, status: 'stale', reason, coverage: { files: 0 }, findings: [] })
      break
    }
    const result: HostCheckResult = await runHostCheck(services, {
      recipeId: recipe.id,
      program: recipe.program,
      argv: recipe.argv,
      cwd: recipe.cwd,
      reason: `run ${recipe.kind} check ${recipe.id} from plan ${plan.checkPlanId} for batches ${plan.batchIds.join(', ') || 'none'}: ${recipe.program} ${recipe.argv.join(' ')}; scope: ${(recipe.scope ?? []).join(', ') || 'unspecified'}`,
      beforeSpawn: () => {
        const drift = manifestDrift(workspace, plan.inputManifest, plan.traceFiles)
        return drift.length > 0 ? `inputs changed while approval was pending: ${drift.join(', ')}` : undefined
      },
      raw: { agent: raw?.agent, callId: (raw as { callId?: string } | undefined)?.callId, signal: raw?.signal ?? exec?.signal },
    }, { toolName: 'ffcheck' })
    if (result.status === 'completed') {
      // The semantic reading is decided by the kind the human approved, never by
      // what the output happens to look like. A `process` recipe stays a process
      // result even if it printed perfect TAP.
      const reading = interpretOutcome(recipe, result)
      runs.push({
        recipe: recipe.id, status: 'completed', exitCode: result.exitCode, callId: result.callId,
        kind: recipe.kind,
        output: result.output.kind === 'spill' ? `spill:${result.output.path}` : `sha256:${result.output.sha256}`,
        ...(reading.verdict === undefined ? {} : { verdict: reading.verdict }),
        ...(reading.detail === undefined ? {} : { verdictDetail: reading.detail }),
      })
      checkResults.push({
        ...reading.result,
        execution: { callId: result.callId, recipeId: recipe.id, exitCode: result.exitCode, output: result.output },
      })
      const head = result.text.split('\n').slice(0, 20).join('\n').trimEnd()
      if (head.length > 0) outputs.push(`--- ${recipe.id} (exit ${result.exitCode}) ---\n${head}`)
      if (reading.line !== undefined) outputs.push(reading.line)
    } else {
      runs.push({ recipe: recipe.id, status: result.status, detail: result.reason })
      checkResults.push({
        id: recipe.id,
        kind: recipe.kind === 'process' ? 'process' : recipe.kind,
        status: result.status === 'stale' ? 'stale' : result.status === 'unavailable' ? 'unavailable' : 'not_run',
        reason: result.reason,
        coverage: { files: 0 },
        findings: [],
      })
    }
  }

  // After the terminal result: an input that changed *during* the run makes the
  // outcome inapplicable even when every process exited 0.
  const after = manifestDrift(workspace, plan.inputManifest, plan.traceFiles)
  if (after.length > 0) {
    for (const result of checkResults) {
      if (result.status !== 'passed' && result.status !== 'failed') continue
      result.reason = `inputs changed during execution (${after.join(', ')}); observed ${result.status}${result.reason ? `: ${result.reason}` : ''}`
      result.status = 'stale'
    }
  }

  const denied = runs.find(run => run.status === 'denied')
  const cancelled = runs.find(run => run.status === 'cancelled')
  const interrupted = runs.find(run => run.status === 'interrupted')
  const unavailable = runs.find(run => run.status === 'unavailable')
  const nonzero = runs.find(run => run.status === 'completed' && run.exitCode !== 0)

  // A semantic failure is decided by the interpreter, not by the exit code: a
  // `types` recipe that printed errors fails even when a wrapper exited 0.
  const failedReading = runs.find(run => run.verdict === 'failed')
  const unverifiable = runs.find(run => run.verdict === 'unverifiable')
  const staticResults = staticResult?.results ?? plan.staticChecks.map(check => ({
    id: check, kind: check as CheckSelector, status: staticResult?.status ?? 'not_run',
    reason: staticResult?.detail ?? staticResult?.reason, coverage: { files: 0 }, findings: [],
  }))
  const combined = aggregateChecks(
    [...plan.staticChecks.map(check => `static:${check}`), ...plan.recipes.map(recipe => recipe.id)],
    [...staticResults.map(result => ({ ...result, id: `static:${result.id}` })), ...checkResults], 'internal-static',
  )

  let status: string
  let reason: string
  if (denied) { status = 'denied'; reason = 'approval_denied' }
  else if (cancelled) { status = 'cancelled'; reason = 'cancelled' }
  else if (unavailable) { status = 'unavailable'; reason = 'seam_unavailable' }
  else if (interrupted) { status = 'interrupted'; reason = 'interrupted' }
  else if (after.length > 0 || runs.some(run => run.status === 'stale')) { status = 'stale'; reason = 'input_drift_during_run' }
  else if (failedReading !== undefined) { status = 'failed'; reason = failedReading.kind === 'tests' ? 'tests_failed' : failedReading.kind === 'types' ? 'type_errors' : 'nonzero_exit' }
  else if (nonzero) { status = 'failed'; reason = 'nonzero_exit' }
  else if (unverifiable !== undefined) {
    // Every process succeeded, but at least one semantic reading could not be
    // taken. Calling that `completed` would let a caller read it as a pass.
    status = 'partial'
    reason = unverifiable.kind === 'tests' ? 'test_report_uninterpretable' : unverifiable.kind === 'types' ? 'type_report_uninterpretable' : 'semantics_unavailable'
  } else if (combined.status !== 'passed') {
    status = combined.status === 'failed' ? 'failed' : combined.status === 'stale' ? 'stale' : 'partial'
    reason = combined.status === 'failed' ? 'static_checks_failed' : 'static_checks_incomplete'
  } else { status = 'completed'; reason = runs.every(run => run.kind === 'process') ? 'process_only' : 'semantic_checks_passed' }

  // The verification record is the run's own claim. `checkResults` was filled by
  // `interpretOutcome`, which knows what each approved kind permits; nothing is
  // re-derived here from the exit code alone.

  const verification = await persistRecord(
    workspace, storeFor(workspace), 'host-execution', plan.batchIds, plan.recipes.map(recipe => recipe.id), checkResults,
    Object.entries(plan.inputManifest).map(([file, hash]) => ({ file, hash: hash === 'absent' ? null : hash })),
    startedAt,
    { checkPlanId: plan.checkPlanId, ...(plan.traceFiles === undefined ? {} : { traceFiles: plan.traceFiles }), ...(runs[0]?.callId === undefined ? {} : { hostCallId: runs[0].callId }) },
  )
  const archived = verification.persisted
    ? `[check] recorded as verification ${verification.id.slice(0, 8)}… (revision ${verification.revision})`
    : `[check] NOT recorded — ${verification.detail}. The run happened; history cannot claim it was archived.`

  const lines = [`[check] ${status} — ${runs.length} recipe(s) from plan ${plan.checkPlanId}`]
  for (const run of runs) {
    lines.push(`  ${run.recipe}: ${run.status}${run.exitCode === undefined ? '' : ` (exit ${run.exitCode})`}${run.detail ? ` — ${run.detail}` : ''}`)
  }
  if (after.length > 0) lines.push(`  inputs changed during the run: ${after.join(', ')} — the result does not describe the current tree`)
  if (status === 'completed') {
    const semantic = runs.filter(run => run.kind === 'tests' || run.kind === 'types').map(run => run.recipe)
    lines.push(semantic.length === 0
      ? '  every recipe exited 0. This is a PROCESS result: no recipe was declared as tests or types, so this is not a claim that tests passed.'
      : `  every recipe succeeded, and the declared semantic readings passed: ${semantic.join(', ')}.`)
  }
  if (status === 'partial') {
    lines.push(unverifiable
      ? `  at least one semantic reading was unavailable (${unverifiable.recipe}); a zero exit does not substitute for it.`
      : `  required static checks did not establish a pass: ${combined.reason}`)
  }
  return {
    action: 'run',
    status,
    reason,
    ...(status === 'completed' ? { detail: runs.every(run => run.kind === 'process') ? 'process results only; no test or type semantics were interpreted' : 'the semantic checks declared by this plan passed' } : {}),
    checks: plan.staticChecks,
    batches: plan.batchIds,
    findings: status === 'stale' ? [] : staticResult?.findings ?? [],
    limitations: staticResult?.limitations ?? [],
    files: staticResult?.files ?? [],
    syntax: staticResult?.syntax ?? { checked: 0, failures: [] as string[], skipped: [] },
    coverage: staticResult?.coverage ?? { changed: 0, bridgeFiles: 0, providers: 0, consumers: 0 },
    ...(staticResult === undefined ? {} : { results: status === 'stale' ? staticResults.map(result => ({ ...result, status: 'stale', reason: `inputs changed during the run; observed ${result.status}` })) : staticResults }),
    ...(staticResult?.verification === undefined ? {} : { staticVerification: staticResult.verification }),
    checkPlanId: plan.checkPlanId,
    planned: [],
    runs,
    verification: {
      id: verification.id,
      ...(verification.revision === undefined ? {} : { revision: verification.revision }),
      persisted: verification.persisted,
      ...(verification.detail === undefined ? {} : { detail: verification.detail }),
    },
    text: [[lines.join('\n'), archived].join('\n'), ...(staticResult ? [staticResult.text] : []), ...outputs].join('\n'),
  }
}


/**
 * Persist one check outcome and report whether it is still there.
 *
 * The failure mode this function is shaped around is requirement 5: a storage
 * failure must not undo the code write, and must not be reported as if the
 * record were archived. So it returns a `persisted` flag for the caller's output
 * instead of throwing, and the caller's text says plainly that history cannot
 * claim this record.
 */
async function persistRecord(
  workspace: string,
  store: StorePaths,
  provenance: Provenance,
  batchIds: readonly number[],
  requiredChecks: readonly string[],
  checkResults: readonly VerificationCheckResult[],
  afterHashes: Array<{ file: string; hash: string | null }>,
  startedAt: string,
  extra: { checkPlanId?: string; hostCallId?: string; recipeId?: string; exitCode?: number; outputRef?: string; traceFiles?: string[] } = {},
): Promise<{ id: string; revision?: number; persisted: boolean; detail?: string }> {
  const record: VerificationRecord = {
    schema: VERIFICATION_SCHEMA,
    id: newRecordId(),
    workspaceId: workspaceKey(workspace),
    batchIds: [...batchIds],
    afterHashes,
    checks: [...checkResults],
    requiredChecks: [...requiredChecks],
    startedAt,
    finishedAt: new Date().toISOString(),
    provenance,
    ...(extra.checkPlanId === undefined ? {} : { checkPlanId: extra.checkPlanId }),
    ...(extra.hostCallId === undefined ? {} : { hostCallId: extra.hostCallId }),
    ...(extra.recipeId === undefined ? {} : { recipeId: extra.recipeId }),
    ...(extra.exitCode === undefined ? {} : { exitCode: extra.exitCode }),
    ...(extra.outputRef === undefined ? {} : { outputRef: extra.outputRef }),
    ...(extra.traceFiles === undefined ? {} : { traceFiles: extra.traceFiles }),
  }
  const appended = await appendRecord(store, workspace, record)
  if (!appended.ok) return { id: record.id, persisted: false, detail: appended.detail }
  return { id: appended.id, revision: appended.revision, persisted: true }
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

function normaliseRecipes(raw: unknown, workspace: string): { ok: true; recipes: CheckRecipe[]; warnings: string[] } | { ok: false; detail: string } {
  if (raw === undefined) return { ok: false, detail: 'action=plan requires recipes: at least one {id, program, argv} to approve' }
  if (!Array.isArray(raw)) return { ok: false, detail: 'recipes must be an array' }
  const recipes: CheckRecipe[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return { ok: false, detail: 'each recipe must be an object' }
    const entry = item as Record<string, unknown>
    const id = entry.id
    if (typeof id !== 'string' || id.length === 0) return { ok: false, detail: 'each recipe needs a non-empty string id' }
    if (seen.has(id)) return { ok: false, detail: `duplicate recipe id "${id}"; ids are the approval'\''s subject and must be unique` }
    seen.add(id)
    const program = entry.program
    if (typeof program !== 'string' || program.length === 0) return { ok: false, detail: `recipe "${id}" needs a non-empty program` }
    const argvRaw = entry.argv
    if (argvRaw !== undefined && !Array.isArray(argvRaw)) return { ok: false, detail: `recipe "${id}": argv must be an array of strings` }
    const argv: string[] = []
    for (const arg of (argvRaw ?? []) as unknown[]) {
      if (typeof arg !== 'string') return { ok: false, detail: `recipe "${id}": every argv entry must be a string (no shell string is accepted)` }
      argv.push(arg)
    }
    const cwdRaw = entry.cwd
    if (cwdRaw !== undefined && typeof cwdRaw !== 'string') return { ok: false, detail: `recipe "${id}": cwd must be a string` }
    // The kind is frozen into the plan hash. Declaring `tests` or `types` asks for
    // a semantic reading; leaving it out asks only for the process outcome.
    const kindRaw = entry.kind
    if (kindRaw !== undefined && kindRaw !== 'process' && kindRaw !== 'tests' && kindRaw !== 'types') {
      return { ok: false, detail: `recipe "${id}": kind must be "process", "tests" or "types"; got ${JSON.stringify(kindRaw)}` }
    }
    const kind: RecipeKind = kindRaw === undefined ? 'process' : kindRaw
    if (kind === 'tests' && !/tap/i.test(argv.join(' ')) && !/--test-reporter/.test(argv.join(' '))) {
      // Not a refusal: an argv may reach the reporter through a config file. But a
      // plan that asks for test semantics and shows no sign of TAP output is
      // usually a mistake, and the caller should hear about it before approving.
      warnings.push(`recipe "${id}" declares kind "tests" but its argv names no TAP reporter; Node's default reporter is not TAP, so the report may be uninterpretable`)
    }
    const scopeRaw = entry.scope
    if (scopeRaw !== undefined && !Array.isArray(scopeRaw)) return { ok: false, detail: `recipe "${id}": scope must be an array of workspace-relative paths` }
    const scope: string[] = []
    for (const path of (scopeRaw ?? []) as unknown[]) {
      if (typeof path !== 'string' || path.length === 0) return { ok: false, detail: `recipe "${id}": every scope entry must be a non-empty string` }
      scope.push(path)
    }
    recipes.push({
      id, kind, program, argv,
      cwd: cwdRaw === undefined ? workspace : path.resolve(workspace, cwdRaw),
      ...(scope.length === 0 ? {} : { scope }),
    })
  }
  return { ok: true, recipes, warnings }
}


/** The reading of one completed recipe: what it lets the caller claim. */
interface RecipeReading {
  /** `tests`/`types`/`process` — the only vocabulary a caller may repeat upward. */
  verdict: string
  /** Why the verdict is not a pass; present whenever it is not. */
  detail?: string
  /** One human-readable line for the tool's text output. */
  line?: string
  /** The check result archived in the verification record. */
  result: VerificationCheckResult
}

/**
 * Interpret one completed run according to the kind the plan froze.
 *
 * The three branches exist because each kind can and cannot claim different
 * things, and the boundaries are what M1.4 is about:
 *
 * - `process` asks only for the process outcome. It is **never** upgraded, even
 *   when the output parses as TAP, because nobody approved a semantic reading.
 * - `tests` requires a genuine TAP report for *this* callId, untruncated and
 *   consistent. Every failure mode of `interpretTestReport` is surfaced.
 * - `types` requires the diagnostic protocol; silence counts only with exit 0.
 *
 * A recipe whose kind says `tests` but whose output is not TAP is `unavailable`,
 * not `passed` and not `failed`: the command was approved, it ran, and the report
 * cannot be read — which is a fact about the evidence, not about the code.
 */
function interpretOutcome(recipe: CheckRecipe, result: Extract<HostCheckResult, { status: 'completed' }>): RecipeReading {
  const truncated = result.output.truncated
  const coverage = { files: 0, ...(truncated ? { limitation: 'the output stream was truncated' } : {}) }

  if (recipe.kind === 'tests') {
    const report = parseTap(result.stdout)
    const cross = crossCheckReport(report)
    if (report.recognised && !cross.ok) {
      return {
        verdict: 'unverifiable',
        detail: cross.detail,
        line: `[tests] ${recipe.id}: unverifiable — ${cross.detail}`,
        result: {
          id: recipe.id, kind: 'tests', status: 'not_run',
          reason: `the TAP report is internally inconsistent: ${cross.detail}`,
          coverage, findings: [],
        },
      }
    }
    const verdict = interpretTestReport(report, {
      callId: result.callId,
      expectedCallId: result.callId,
      truncated,
      scope: recipe.scope ?? [],
    })
    if (verdict.status === 'passed') {
      return {
        verdict: 'passed',
        line: `[tests] ${recipe.id}: passed — ${verdict.executed} test(s) executed and all passed`,
        result: { id: recipe.id, kind: 'tests', status: 'passed', coverage: { files: 0, sites: verdict.executed }, findings: [] },
      }
    }
    if (verdict.status === 'failed') {
      return {
        verdict: 'failed',
        detail: `${verdict.failures.length} failing test(s)`,
        line: `[tests] ${recipe.id}: failed — ${verdict.failures.map(f => f.name).slice(0, 5).join(', ')}`,
        result: {
          id: recipe.id, kind: 'tests', status: 'failed',
          reason: `${verdict.failures.length} failing test(s)`,
          coverage: { files: 0, sites: verdict.executed },
          // The failure list is the finding. A name is enough to act on; the
          // assertion text is included when the reporter gave one.
          findings: verdict.failures.map(failure => ({ code: 'test_failed', message: `${failure.name}${failure.error === undefined ? '' : `: ${failure.error}`}` })),
        },
      }
    }
    return {
      verdict: 'unverifiable',
      detail: verdict.detail,
      line: `[tests] ${recipe.id}: unverifiable — ${verdict.detail}`,
      result: {
        id: recipe.id, kind: 'tests',
        status: verdict.reason === 'not_tap' ? 'unavailable' : 'not_run',
        reason: verdict.detail, coverage, findings: [],
      },
    }
  }

  if (recipe.kind === 'types') {
    const report = parseTypeDiagnostics(result.text)
    const verdict = interpretTypeReport(report, { exitCode: result.exitCode, truncated })
    if (verdict.status === 'passed') {
      return {
        verdict: 'passed',
        line: `[types] ${recipe.id}: passed — no error diagnostics and exit 0`,
        result: { id: recipe.id, kind: 'types', status: 'passed', coverage: { files: verdict.files }, findings: [] },
      }
    }
    if (verdict.status === 'failed') {
      return {
        verdict: 'failed',
        detail: `${verdict.errors.length} type error(s)`,
        line: `[types] ${recipe.id}: failed — ${verdict.errors.length} error(s), first at ${verdict.errors[0]?.file}:${verdict.errors[0]?.line}`,
        result: {
          id: recipe.id, kind: 'types', status: 'failed',
          reason: `${verdict.errors.length} type error(s)`,
          coverage: { files: new Set(verdict.errors.map(error => error.file)).size },
          findings: verdict.errors.slice(0, 50).map(error => ({
            code: error.code,
            message: error.message,
            source: { file: error.file, line: error.line },
          })),
        },
      }
    }
    return {
      verdict: 'unverifiable',
      detail: verdict.detail,
      line: `[types] ${recipe.id}: unverifiable — ${verdict.detail}`,
      result: {
        id: recipe.id, kind: 'types',
        // `unrecognised` output means the command did not speak the protocol we
        // approved it for; that is unavailable evidence, not a failed check.
        status: verdict.reason === 'compiler_output_not_recognised' ? 'unavailable' : 'not_run',
        reason: verdict.detail, coverage, findings: [],
      },
    }
  }

  // `process`: exit 0 is a process fact and nothing more. Saying so explicitly is
  // the point — a caller reading `passed` would otherwise assume a test verdict.
  return {
    verdict: result.exitCode === 0 ? 'process_ok' : 'process_failed',
    detail: 'exit code only — no test or type semantics were interpreted',
    line: `[process] ${recipe.id}: exit ${result.exitCode ?? 'null'} — no semantic verdict was derived`,
    result: {
      id: recipe.id, kind: 'process',
      status: result.exitCode === 0 ? 'passed' : 'failed',
      reason: 'exit code only — this recipe was not declared as tests or types',
      coverage,
      findings: [],
    },
  }
}

function normaliseInputs(raw: unknown): { ok: true; files: string[] } | { ok: false; detail: string } {
  if (raw === undefined) return { ok: true, files: [] }
  if (!Array.isArray(raw)) return { ok: false, detail: 'inputs must be an array of workspace-relative paths' }
  const files: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.length === 0) return { ok: false, detail: 'every inputs entry must be a non-empty string' }
    files.push(item)
  }
  return { ok: true, files }
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
