/**
 * dsh-forge construction tools (stage 3): ff_edit (ticket replies included) / ff_history /
 * ff_rollback. Thin factories — the pure engine lives in src/edit-engine.ts,
 * persistence in src/ledger.ts, tickets in src/tickets.ts.
 *
 * Governance decisions implemented here (user-confirmed):
 * - reason is MANDATORY on every write call; the missing-reason error quotes a
 *   copy-paste-ready parameter shape.
 * - Tickets persist under ~/.dsh/forge/tickets/ (24h TTL) — restart-safe.
 * - Snapshots live centrally under ~/.dsh/forge/snapshots/<workspace-key>/ —
 *   zero repository pollution, rollback independent of git.
 * - actor = the DSH session id (exec.agent.session.header.id); subagents
 *   carry their own ids, so attribution filters work per agent.
 * - Every edit re-derives coordinates from CURRENT content; the ledger's
 *   last-known hash tripwires external modifications into `external` nodes.
 * - After a successful edit the file is fed back into fff's query-history
 *   DB (trackQuery) using the search query that actually surfaced it.
 *
 * @module dsh-forge/tools-edit
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { EditOptions, EditStep, StepReport, StepCandidate } from './edit-engine.ts'
import { applyEditSteps, stripLinePrefixes, targetCandidateMatches } from './edit-engine.ts'
import {
  type LedgerNode,
  detectEncoding,
  commitFiles,
  encodeText,
  prepareWorkspace,
  getBlob,
  looksBinary,
  putBlob,
  readKnownState,
  readLedgerTail,
  recordBatch,
  recordExternalState,
  searchHistory,
  storeFor,
  workspaceForFile,
  type TextEncoding,
} from './ledger.ts'
import { createTicket, deleteTicket, loadTicket } from './tickets.ts'
import { canonicalWorkspace, isSymbolicLink } from './fs-paths.ts'
import { historyContentMatches, nodeId, readNode, snapshot, snapshotDiff } from './history.ts'
import { applicabilityOf, listRecords, readRevision } from './verification.ts'
import { detectLanguage, enclosingSymbol, findSymbol, normalizeText, parseFile, symbolSpan, syntaxValid } from './ast.ts'
import { AUDIT_REASONS, AUDIT_STATUSES, auditCommit, renderAudit, type EditAudit } from './edit-audit.ts'
import { runStaticCheck, type CheckSelector } from './check-static.ts'
import { resolveBeforeEvidence } from './tools-trace.ts'

/** The refusal half of {@link resolveBeforeEvidence}: only failures reach the reply. */
type BeforeRejection = Extract<Awaited<ReturnType<typeof resolveBeforeEvidence>>, { ok: false }>
import {
  type FinderPool,
  type ForgeExec,
  type ToolFailure,
  clampInt,
  takeQueryFor,
  withFileLock,
  withFileLocks,
  observedRead,
  withNativeWrite,
  workdirOf,
} from './core.ts'

function failure(error: string): ToolFailure {
  return { error }
}

function text(value: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value }]
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function actorOf(exec: ForgeExec | undefined): string {
  const id = exec?.agent?.session?.header?.id
  return typeof id === 'string' && id !== '' ? id : 'unknown'
}

function resolveFilePath(exec: ForgeExec | undefined, raw: string): string {
  const candidate = path.normalize(path.isAbsolute(raw) ? raw : path.resolve(workdirOf(exec), raw))
  if (existsSync(candidate)) return realpathSync(candidate)
  const parent = path.dirname(candidate)
  return existsSync(parent) ? path.join(realpathSync(parent), path.basename(candidate)) : candidate
}

function relForward(workspace: string, abs: string): string {
  return path.relative(workspace, abs).split(path.sep).join('/')
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

const MAX_STEPS = 50

interface SymbolEdit {
  sourceSymbol: string
  edit: 'replace' | 'delete' | 'insert_before' | 'insert_after'
  content?: string
  includeLeadingComment?: boolean
}

/** Offline replay migration for retired ff_file action=edit_symbol. */
export function normalizeLegacySymbolEditArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { action, symbol, body, ...canonical } = args
  if (action !== undefined && action !== 'edit_symbol') throw new Error('expected legacy action=edit_symbol')
  if (symbol !== undefined) {
    if (canonical.sourceSymbol !== undefined) throw new Error('symbol conflicts with sourceSymbol')
    canonical.sourceSymbol = symbol
  }
  if (body !== undefined) {
    if (typeof body !== 'boolean') throw new Error('body must be boolean')
    if (canonical.includeLeadingComment !== undefined) throw new Error('body conflicts with includeLeadingComment')
    canonical.includeLeadingComment = !body
  }
  return canonical
}

/** Offline migration of the old history substring key. */
export function normalizeLegacyHistoryArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { path: legacyPath, ...canonical } = args
  if (legacyPath !== undefined) {
    if (canonical.pathContains !== undefined) throw new Error('path conflicts with pathContains')
    canonical.pathContains = legacyPath
  }
  return canonical
}

/** Offline migration of string batch ids and the retired last selector. */
export function normalizeLegacyRollbackArgs(args: Record<string, unknown>): Record<string, unknown> {
  const canonical = { ...args }
  if (canonical.batch === 'last') { delete canonical.batch; if (canonical.latest !== undefined) throw new Error('batch conflicts with latest'); canonical.latest = true }
  else if (typeof canonical.batch === 'string' && /^[1-9]\d*$/.test(canonical.batch)) canonical.batch = Number(canonical.batch)
  return canonical
}


// ---------------------------------------------------------------------------
// Core write pipeline (shared by the edit path and the ticket path)
// ---------------------------------------------------------------------------

interface ApplyParams {
  exec?: ForgeExec
  abs: string
  workdir: string
  steps: EditStep[]
  reason: string
  actor: string
  mode: 'atomic' | 'bestEffort'
  /** Refuse the write when the planned text introduces syntax errors into a file that parsed cleanly. */
  revertOnSyntaxError?: boolean
  verify?: CheckSelector[]
  symbolEdit?: SymbolEdit
  /** Ticket reply: verified target coordinates. */
  pinned?: Array<StepCandidate & { stepIndex: number }>
  noWrite?: boolean
}

interface ApplyOk {
  ok: true
  workspace?: string
  batchId: number
  externalBatchId?: number
  applied: number
  skipped: number
  reports: StepReport[]
  hash: string
  created: boolean
  noChange?: boolean
  syntaxWarning?: string
}

interface ApplyTicket {
  ok: false
  ticket: string
  reason: string
  candidates: Array<{ index: number; start: number; end: number; symbol?: string | null; preview: string }>
  reports: StepReport[]
}

interface ApplyErr {
  ok: false
  error: string
  reports: StepReport[]
}

type ApplyResult = ApplyOk | ApplyTicket | ApplyErr

async function planSymbolEdit(abs: string, original: string, selection: SymbolEdit): Promise<ReturnType<typeof applyEditSteps>> {
  const parsed = await parseFile(abs)
  if (!parsed.value || parsed.value.partial) throw new Error(parsed.error ?? 'symbol edit requires a syntax-valid original parse')
  if (parsed.value.text !== original) throw new Error('source changed during symbol planning; nothing written')
  const matches = findSymbol(parsed.value.symbols, selection.sourceSymbol, true)
  if (matches.length !== 1) throw new Error(`symbol must be unique (${matches.length} matches); use an exact qualified name`)
  const symbol = matches[0]
  if (symbol.sharedDeclaration) throw new Error('symbol shares a declaration with other names; use an explicit text target for the whole declaration')
  if (selection.edit === 'delete' && symbol.listMember) throw new Error('symbol is a list member requiring separator handling; use an explicit target including its separator')
  const span = symbolSpan(parsed.value, symbol, selection.includeLeadingComment === false)
  const content = selection.edit === 'delete' ? '' : normalizeText(selection.content!)
  const start = selection.edit === 'insert_after' ? span.end : span.start
  const end = selection.edit === 'insert_before' || selection.edit === 'insert_after' ? start : span.end
  const result = original.slice(0, start) + content + original.slice(end)
  if (!await syntaxValid(result, parsed.value.lang)) throw new Error('symbol edit would produce invalid syntax; nothing written')
  const line = (text: string, offset: number) => text.slice(0, offset).split('\n').length
  return { ok: true, text: result, reports: [{ index: 0, op: selection.edit === 'delete' ? 'delete' : selection.edit.startsWith('insert') ? 'insert' : 'replace', status: 'applied', symbol: symbol.qualifiedName,
    originalRange: { start: line(original, start), end: line(original, end) }, newRange: { start: line(result, start), end: line(result, start + content.length) } }] }
}

async function applyBatch(pool: FinderPool, params: ApplyParams): Promise<ApplyResult> {
  const { abs, workdir, steps, reason, actor, mode } = params
  const store = storeFor(workspaceForFile(abs, workdir))
  const workspace = store.root
  await prepareWorkspace(store, params.exec)
  const rel = relForward(workspace, abs)
  const exists = existsSync(abs)

  let rawBuf: Buffer | null = null
  let bodyText = ''
  let enc: TextEncoding = { eol: 'LF', bom: false }
  let hash = ''
  if (exists) {
    let raw: string
    try {
      rawBuf = await observedRead<Buffer>(params.exec, abs, (file) => readFileSync(file))
      raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rawBuf)
    } catch (cause) {
      return { ok: false, error: `cannot read ${abs}: ${causeMessage(cause)}`, reports: [] }
    }
    if (looksBinary(raw)) {
      return { ok: false, error: `${path.basename(abs)} looks binary or UTF-16 — text editing refused`, reports: [] }
    }
    enc = detectEncoding(raw)
    const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    bodyText = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    hash = sha256(rawBuf)
  } else if (params.symbolEdit || !steps.some((s) => (s.op ?? (s.after !== undefined ? 'insert' : undefined)) === 'insert')) {
    return { ok: false, error: `file not found: ${abs} — create it with an insert step ({"after": 0, "text": ...})`, reports: [] }
  }

  // External-modification tripwire: disk content differs from the ledger's
  // last-known state → snapshot it first so rollback never swallows it.
  let externalBatchId: number | undefined
  const options: EditOptions = { mode, pinnedTargets: params.pinned }
  const planned = params.symbolEdit ? await planSymbolEdit(abs, bodyText, params.symbolEdit) : applyEditSteps(bodyText, steps, options)
  if (!planned.ok) {
    if (planned.ambiguity) {
      const lines = bodyText.split('\n')
      const parsed = exists ? await parseFile(abs) : { value: undefined }
      const candidates = planned.ambiguity.candidates.map((c) => {
        const sym = parsed.value ? enclosingSymbol(parsed.value.symbols, c.start) : null
        return {
          ...c,
          start: c.start,
          end: c.end,
          ...(sym ? { symbol: sym.qualifiedName } : {}),
          preview: (lines[c.start - 1] ?? '').trim().slice(0, 160),
        }
      })
      const ticket = createTicket({
        file: abs,
        steps,
        stepIndex: planned.ambiguity.stepIndex,
        candidates,
        reason,
        mode: 'atomic',
        ...(params.revertOnSyntaxError ? { revertOnSyntaxError: true } : {}),
        ...(params.verify?.length ? { verify: [...params.verify] } : {}),
        sourceHash: hash,
        workdir,
        decisions: params.pinned ?? [],
      })
      return {
        ok: false,
        ticket: ticket.id,
        reason: planned.reason,
        candidates: candidates.map((c, i) => ({ ...c, index: i })),
        reports: planned.reports,
      }
    }
    return { ok: false, error: planned.reason, reports: planned.reports }
  }

  // Enclosing-symbol annotation for the applied ranges (parse the ORIGINAL
  // content — still on disk at this point). The same parse yields the
  // pre-edit syntax baseline for revertOnSyntaxError attribution; a created
  // file's baseline is "clean" by definition, an unparseable one unknown.
  let originalPartial: boolean | undefined = exists ? undefined : false
  if (exists) {
    const parsed = await parseFile(abs)
    if (parsed.value) {
      originalPartial = parsed.value.partial
      for (const report of planned.reports) {
        if (report.originalRange) {
          const sym = enclosingSymbol(parsed.value.symbols, report.originalRange.start)
          if (sym) report.symbol = sym.qualifiedName
        }
      }
    }
  }

  const newRaw = Buffer.from(encodeText(planned.text, enc), 'utf8')
  const newHash = sha256(newRaw)
  const applied = planned.reports.filter((r) => r.status === 'applied' || r.status === 'drifted').length
  const skipped = planned.reports.filter((r) => r.status === 'skipped').length
  if (newHash === hash) {
    return { ok: true, batchId: 0, applied, skipped, reports: planned.reports, hash, created: false, noChange: true }
  }

  if (params.noWrite) {
    return { ok: false, error: 'ticket invalidated: current content requires a fresh decision; nothing written', reports: planned.reports }
  }

  // revertOnSyntaxError: refuse before any write when the planned text has
  // syntax errors and the pre-edit file parsed cleanly. A file that was
  // already dirty (or a language tree-sitter cannot parse) stays report-only
  // — the binary hasError signal cannot attribute individual diagnostics.
  if (params.revertOnSyntaxError) {
    const lang = detectLanguage(abs)
    if (lang) {
      const plannedClean = await syntaxValid(planned.text, lang)
      if (!plannedClean && originalPartial === false) {
        return { ok: false, error: 'revertOnSyntaxError: the edit introduces syntax errors into a file that previously parsed cleanly — nothing written; fix the steps or drop the flag', reports: planned.reports }
      }
    }
  }

  const before = exists && rawBuf ? putBlob(store, rawBuf).id : null
  const op: LedgerNode['op'] = exists ? 'update' : 'create'
  let batch: ReturnType<typeof recordBatch>
  try {
    batch = await withNativeWrite(params.exec, [abs], () => {
      if ((existsSync(abs) ? sha256(readFileSync(abs)) : '') !== hash) throw new Error('file changed while planning; nothing written')
      if (rawBuf) {
        const known = readKnownState(store, rel)
        if (known && known.hash !== hash) externalBatchId = recordExternalState(store, rel, rawBuf, enc.eol, enc.bom).batch.id
      }
      const after = putBlob(store, newRaw).id
      return commitFiles(store, {
        kind: 'edit', reason, actor,
        nodes: [{ file: rel, op, before, after, bytes: newRaw.length, eol: enc.eol, bom: enc.bom }],
      }, [{ file: abs, before: rawBuf, after: newRaw }])
    })
  } catch (cause) {
    return { ok: false, error: `write failed for ${abs}: ${causeMessage(cause)}`, reports: planned.reports }
  }

  // Post-edit syntax check (report-only — grammar lag makes rejection risky).
  let syntaxWarning: string | undefined
  const parsedNew = await parseFile(abs)
  if (parsedNew.value?.partial) {
    syntaxWarning = (originalPartial === false || !exists)
      ? 'edit introduced tree-sitter syntax errors — content was written, verify the file'
      : 'post-edit tree-sitter parse reports syntax errors (pre-existing ones may be included) — content was written, verify the file'
  }

  // Ledger → fff feedback: replay the query that surfaced this file into the
  // finder's query-history DB (only for finders that persist learning data).
  const query = takeQueryFor(abs)
  if (query) {
    const finder = pool.peekMain(workspace)
    if (finder) {
      try {
        finder.trackQuery(query, rel)
      } catch {
        // learning is best-effort, never a write failure
      }
    }
  }

  return {
    ok: true,
    workspace: store.root,
    batchId: batch.id,
    externalBatchId,
    applied,
    skipped,
    reports: planned.reports,
    hash: newHash.slice(0, 12),
    created: !exists,
    syntaxWarning,
  } as const
}

// ---------------------------------------------------------------------------
// ff_edit
// ---------------------------------------------------------------------------

const STEP_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    op: { type: 'string', enum: ['replace', 'insert', 'delete', 'target'], description: 'Optional; inferred from find/after/start and presence of text.' },
    start: { type: 'integer', description: 'Required for replace/delete: first line, 1-based.' },
    end: { type: 'integer', description: 'replace/delete: inclusive last line; default start.' },
    after: { type: 'integer', description: 'Required for insert: original line to insert after; 0 = file start.' },
    find: { type: 'string', description: 'Required for target: nonempty literal block.' },
    replaceWith: { type: 'string', description: 'Required for target: replacement; empty deletes.' },
    text: { type: 'string', description: 'Required for replace/insert: newline-separated text.' },
    expect: { type: 'string', description: 'Expected start/after line; re-anchor within ±20 lines.' },
    inline: { type: 'boolean', description: 'target: force single-line substring match (auto when whole-line fails); requires atomic mode.' },
  },
} as const

/** ffgrep-style tolerance for trailing whitespace on a target probe. */
function verifyCandidateStillMatches(abs: string, find: string, start: number, end: number): boolean {
  try {
    const raw = readFileSync(abs, 'utf8')
    const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    const lines = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
    return targetCandidateMatches(lines, find, start, end)
  } catch {
    return false
  }
}

export function createEditTool(pool: FinderPool) {
  return {
    name: 'ff_edit',
    description:
      'Edit text after reading it. For one literal replacement pass find/replaceWith directly; multi-step edits use steps. All steps use ORIGINAL snapshot lines; overlaps fail. Prefer expect anchors or target matching. An ambiguous target writes nothing: it returns a ticket, and you apply the saved batch by resending ff_edit with that ticket plus choice (never steps). ' +
      'Replacement text quoting the range\'s first and last lines keeps them. Create files with insert after=0. ' +
      'Preserves UTF-8 CRLF/LF/BOM; refuses binary files. Exact sourceSymbol edits share this commit, audit and verify pipeline; code transfers use ff_file.',
    parameters: {
      path: { type: 'string', description: 'File path (absolute or workspace-relative). Required unless answering a ticket.' },
      sourceSymbol: { type: 'string', description: 'Exact symbol name or qualified name. Exclusive with steps and find/replaceWith.' },
      includeLeadingComment: { type: 'boolean', description: 'Include leading comment in selected symbol span. Default true; requires sourceSymbol.' },
      edit: { type: 'string', enum: ['replace', 'delete', 'insert_before', 'insert_after'], description: 'Required with sourceSymbol.' },
      content: { type: 'string', description: 'Required for symbol edit except delete; literal UTF-8 text.' },
      find: { type: 'string', description: 'Shorthand for one step: literal block to locate (whole-line match).' },
      replaceWith: { type: 'string', description: 'Replacement for find; empty deletes the block.' },
      steps: { type: 'array', items: STEP_ITEM_SCHEMA, description: '1–50 steps; omit with the find/replaceWith shorthand.' },
      reason: { type: 'string', description: 'Why this change; recorded in history. Required unless answering a ticket.' },
      revertOnSyntaxError: { type: 'boolean', description: 'Default false: reject introduced syntax errors in a clean file; dirty files stay report-only.' },
      ticket: { type: 'string', description: 'Ticket id from an ambiguous ff_edit. Applies that saved batch; requires a path-less resend carrying choice.' },
      choice: { type: 'string', description: 'Ticket only: one candidate index ("2"), several unique indexes ("2,3" or "#2 #3"), or "all" for every candidate.' },
      snapshotId: { type: 'string', description: 'Optional: a content-bound baseline from ff_trace capture=true. Validated (same workspace, file covered, bytes unchanged); a mismatch refuses the write instead of editing a file that is no longer what the baseline saw. Omit for an ordinary edit.' },
      verify: { type: 'array', items: { type: 'string', enum: ['bridge', 'ipc', 'syntax'] }, description: 'After this batch lands, run these static checks over it and append a verdict with coverage (bridge: expose/IPC member surface compared by identity; syntax: the changed files parse; ipc: endpoint pairing). The verdict is archived, so ff_history checks=true can show it later. Costs a workspace scan — the [audit] line already covers the changed files, so ask for this when a formal verdict for the whole batch is wanted.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          workspace: { type: 'string' },
          batch: { type: 'integer' },
          file: { type: 'string' },
          applied: { type: 'integer' },
          skipped: { type: 'integer' },
          created: { type: 'boolean' },
          externalBatch: { type: 'integer' },
          syntaxWarning: { type: 'string' },
          hash: { type: 'string' },
          reason: { type: 'string' },
          ticket: { type: 'string' },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                start: { type: 'integer', required: true },
                end: { type: 'integer', required: true },
                startOffset: { type: 'integer' }, endOffset: { type: 'integer' },
                symbol: { type: 'string' },
                preview: { type: 'string', required: true },
              },
            },
          },
          reports: { type: 'array', items: { type: 'object', additionalProperties: true } },
          audit: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', required: true, enum: AUDIT_STATUSES },
              reason: {
                type: 'string',
                required: true,
                enum: AUDIT_REASONS,
              },
              detail: { type: 'string' },
              verdict: { type: 'string' },
              coverage: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  requested: { type: 'array', items: { type: 'string' } },
                  analyzed: { type: 'integer' },
                  traversalComplete: { type: 'boolean' },
                  resultComplete: { type: 'boolean' },
                  limitations: { type: 'array', items: { type: 'object', additionalProperties: true } },
                },
              },
              baseline: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  source: { type: 'string', enum: ['cached-graph', 'none'] },
                  snapshot: { type: 'string', enum: ['pre-write'] },
                  snapshotId: { type: 'string' },
                  strength: { type: 'string', enum: ['observed', 'content-bound'] },
                  scanned: { type: 'integer' },
                  truncated: { type: 'boolean' },
                },
              },
              globals: { type: 'array', items: { type: 'object', additionalProperties: true } },
              rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
          },
          beforeEvidence: {
            type: 'object',
            additionalProperties: false,
            properties: {
              snapshotId: { type: 'string', required: true },
              verified: { type: 'boolean', required: true },
            },
          },
          verification: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', required: true, enum: ['passed', 'failed', 'partial', 'not_run', 'stale'] },
              text: { type: 'string', required: true },
              id: { type: 'string' },
              persisted: { type: 'boolean' },
            },
          },
          note: { type: 'string' },
        },
      },
      render: (_args: unknown, value: { status: string; batch?: number; applied?: number; skipped?: number; created?: boolean; externalBatch?: number; syntaxWarning?: string; ticket?: string; candidates?: Array<{ index: number; start: number; end: number; symbol?: string | null; preview: string }>; reports?: StepReport[]; audit?: EditAudit; beforeEvidence?: { snapshotId: string; verified: boolean }; verification?: { status: string; text: string; id?: string; persisted?: boolean }; note?: string }) => {
        const lines: string[] = []
        if (value.status === 'ticket') {
          lines.push(`ambiguous target — nothing written; ticket ${value.ticket} signed. Apply it with ff_edit {ticket: "${value.ticket}", choice: <index>} (no path, no steps)`)
          for (const c of value.candidates ?? []) {
            lines.push(`  [${c.index}] L${c.start}-${c.end}${c.symbol ? ` in ${c.symbol}` : ''}: ${c.preview}`)
          }
        } else {
          lines.push(`applied ${value.applied ?? 0} step(s)${value.skipped ? `, skipped ${value.skipped}` : ''}${value.created ? ' (file created)' : ''}${value.batch ? ` — batch #${value.batch} in the ledger` : ''}${value.externalBatch ? ` (external change snapshotted as batch #${value.externalBatch} first)` : ''}`)
          for (const r of value.reports ?? []) {
            if (r.status === 'skipped' && !r.reason) continue
            const bits: string[] = [r.op, r.status]
            if (r.drift) bits.push(`drift ${r.drift > 0 ? '+' : ''}${r.drift}`)
            if (r.anchorsPreserved) bits.push('anchors kept')
            if (r.indentShifted) bits.push('re-indented')
            if (r.symbol) bits.push(`in ${r.symbol}`)
            if (r.originalRange) bits.push(`orig L${r.originalRange.start}-${r.originalRange.end}`)
            if (r.newRange) bits.push(`new L${r.newRange.start}-${r.newRange.end}`)
            lines.push(`  step ${r.index}: ${bits.join(', ')}${r.reason ? ` — ${r.reason}` : ''}`)
          }
        }
        if (value.beforeEvidence) lines.push(`before-evidence: ${value.beforeEvidence.snapshotId} (content-bound, bytes unchanged at write time)`)
        if (value.syntaxWarning) lines.push(`[warn] ${value.syntaxWarning}`)
        if (value.audit) lines.push(...renderAudit(value.audit as Parameters<typeof renderAudit>[0]))
        if (value.verification) lines.push(value.verification.text)
        if (value.note) lines.push(`[${value.note}]`)
        return text(lines.join('\n'))
      },
    },
    // 空串语义不能删；symbol 编辑的三个字段只在给了 sourceSymbol 时成立，
    // 缺失时它们只可能是补全产物——按缺省形态删，非缺省值仍是误用。
    hygiene: {
      keepEmpty: ['content', 'replaceWith'],
      requires: {
        edit: 'sourceSymbol',
        content: 'sourceSymbol',
        includeLeadingComment: 'sourceSymbol',
        // 空 replaceWith 只有在 find 成立时才是「删除匹配块」；没有 find 时它
        // 只是补全产物，留着会和 steps 抢同一批参数。
        replaceWith: 'find',
      },
      defaults: { edit: 'replace', content: '', includeLeadingComment: true, replaceWith: '' },
    },
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      const allowed = new Set(['path', 'find', 'replaceWith', 'steps', 'reason', 'revertOnSyntaxError', 'ticket', 'choice', 'snapshotId', 'verify', 'sourceSymbol', 'includeLeadingComment', 'edit', 'content'])
      for (const key of Object.keys(args)) if (!allowed.has(key)) return failure(`${key} is not a parameter of ff_edit`)
      for (const key of ['revertOnSyntaxError', 'includeLeadingComment']) if (args[key] !== undefined && typeof args[key] !== 'boolean') return failure(`${key} must be boolean`)
      for (const key of ['path', 'reason', 'snapshotId']) if (args[key] !== undefined && typeof args[key] !== 'string') return failure(`${key} must be a string`)
      const ticketId = typeof args.ticket === 'string' ? args.ticket.trim() : ''
      if (ticketId !== '') {
        // Answering a ticket is the same tool, a different job: the saved batch
        // is replayed against the original snapshot, so a resend that also
        // carries steps would apply two intents at once. Any other argument is
        // refused by name — a silently ignored `all` is how a caller ends up
        // believing it answered a question it did not answer.
        const foreign = Object.keys(args).filter((key) => args[key] !== undefined && key !== 'ticket' && key !== 'choice')
        if (foreign.length > 0) {
          return failure(`a ticket reply takes only {ticket, choice} — drop ${foreign.map((key) => `"${key}"`).join(', ')}`)
        }
        return decideTicket(pool, ticketId, args, exec)
      }
      const rawPath = typeof args.path === 'string' ? args.path.trim() : ''
      if (rawPath === '') return failure('path is required unless you are answering a ticket')
      const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
      if (reason === '') {
        return failure('reason is required for every construction step (development-history ledger). Re-send with e.g. {"path": ..., "steps": [...], "reason": "fix: guard empty token in putBlob"}')
      }
      if (args.choice !== undefined) {
        return failure('choice only applies to a ticket reply — pass ticket with it')
      }
      if (args.steps !== undefined && (args.find !== undefined || args.replaceWith !== undefined)) {
        return failure('provide either steps or the find/replaceWith single-step shorthand, not both')
      }
      let symbolEdit: SymbolEdit | undefined
      if (args.sourceSymbol !== undefined) {
        if (typeof args.sourceSymbol !== 'string' || !args.sourceSymbol.trim()) return failure('sourceSymbol must be a nonempty exact name')
        if (args.steps !== undefined || args.find !== undefined || args.replaceWith !== undefined) return failure('sourceSymbol is exclusive with steps and find/replaceWith')
        if (!['replace', 'delete', 'insert_before', 'insert_after'].includes(String(args.edit))) return failure('symbol edit requires edit=replace|delete|insert_before|insert_after')
        if (args.edit === 'delete' ? args.content !== undefined : typeof args.content !== 'string') return failure('symbol delete takes no content; other symbol edits require content')
        symbolEdit = { sourceSymbol: args.sourceSymbol.trim(), edit: args.edit as SymbolEdit['edit'], ...(typeof args.content === 'string' ? { content: args.content } : {}), ...(args.includeLeadingComment !== undefined ? { includeLeadingComment: args.includeLeadingComment as boolean } : {}) }
      } else if (['edit', 'content', 'includeLeadingComment'].some(key => args[key] !== undefined)) return failure('edit, content and includeLeadingComment require sourceSymbol')
      let steps: EditStep[]
      if (symbolEdit) { steps = [] } else if (args.steps === undefined) {
        // Single-step sugar mirroring the built-in edit's shape: a flat
        // find/replaceWith call is lowered to one target step, so the common
        // one-block replacement needs no steps array. Ambiguity still returns
        // a ticket — sugar never bypasses the governance path.
        if (typeof args.find !== 'string' || args.find === '') return failure('steps requires 1-50 step objects (or a single find/replaceWith pair)')
        if (typeof args.replaceWith !== 'string') return failure('replaceWith is required with find — use an empty string to delete the matched block')
        steps = [{ op: 'target', find: args.find, replaceWith: args.replaceWith }]
      } else {
        if (!Array.isArray(args.steps) || args.steps.length === 0) return failure('steps requires 1-50 step objects')
        if (args.steps.length > MAX_STEPS) return failure(`steps accepts at most ${MAX_STEPS} steps`)
        steps = args.steps.filter((s): s is EditStep => typeof s === 'object' && s !== null)
        if (steps.length !== args.steps.length) return failure('every step must be an object')
      }
      // One contract, not a knob: a batch either lands whole or writes nothing.
      // `bestEffort` exists in the engine for internal callers, but exposing it
      // here let a caller ask for a half-applied file, which is the opposite of
      // what a ledger-backed edit tool promises.
      if (args.mode !== undefined) {
        return failure('mode is not a parameter: ff_edit is atomic — a batch that cannot land whole writes nothing. Split it into separate calls instead.')
      }
      const abs = resolveFilePath(exec, rawPath)
      const workdir = canonicalWorkspace(workdirOf(exec))
      const snapshotId = typeof args.snapshotId === 'string' ? args.snapshotId.trim() : ''
      const verify = normaliseVerify(args.verify)
      if ('error' in verify) return failure(verify.error)
      // The write lock covers the batch only. Auditing after it releases keeps a
      // slow graph read from holding construction back; the post-write hash is
      // carried out of the lock so a later writer becomes `stale`, not a finding.
      // The before-evidence check runs *inside* the lock: hashing outside it
      // would let another writer land between the check and the write, which is
      // exactly the window the check exists to close.
      const committed: ApplyResult | { throwable: string } | { beforeRejected: BeforeRejection } = await withFileLock(storeFor(workdir).dir, () => withFileLock(abs, async () => {
        try {
          if (snapshotId !== '') {
            await prepareWorkspace(storeFor(workspaceForFile(abs, workdir)), exec)
            const before = resolveBeforeEvidence(workdir, snapshotId, abs)
            if (!before.ok) return { beforeRejected: before }
          }
          return await applyBatch(pool, { abs, workdir, steps, reason, actor: actorOf(exec), mode: 'atomic', exec, verify: verify.checks, symbolEdit, revertOnSyntaxError: symbolEdit !== undefined || args.revertOnSyntaxError === true })
        } catch (cause) { return { throwable: causeMessage(cause) } }
      }))
      if ('throwable' in committed) return failure(committed.throwable)
      if ('beforeRejected' in committed) {
        const before = committed.beforeRejected
        // Nothing was written. Say which of the three ways the baseline failed,
        // and that plain editing is still available — an unusable baseline must
        // not read as "this edit is forbidden".
        return failure(`snapshot ${snapshotId} rejected before writing (${before.reason}): ${before.detail}`)
      }
      return await shapeCommitted(committed, { workdir, abs, steps, exec, verify: verify.checks, ...(snapshotId !== '' ? { beforeSnapshot: snapshotId } : {}) })
    },
  } as const
}

// ---------------------------------------------------------------------------
// Ticket decisions — ff_edit's second half, deliberately not a second tool
// ---------------------------------------------------------------------------

/**
 * Read a ticket selection: one index, a comma/space separated list, or `all`.
 *
 * Three parameters used to say this (`choice`, `choices`, `all`). One string
 * says it with the same reach, and matches how `ff_rollback` already takes a
 * batch id — the caller writes what it sees in the candidate list verbatim.
 *
 * @param raw - `choice` as supplied; integers and integer arrays stay accepted
 *   so a stored replay of an older call keeps working.
 * @param total - candidate count, used to expand `all`.
 * @returns the selected indexes, or an error message to hand back unchanged.
 */
function parseTicketChoice(raw: unknown, total: number): number[] | string {
  const list = (text: string): number[] | string => {
    const parts = text.split(/[\s,、]+/).map((part) => part.replace(/^#/, '')).filter(Boolean)
    if (parts.length === 0) return `choice must be an index, a list of unique indexes ("2,3"), or "all" — got: ${JSON.stringify(raw)}`
    const indexes = parts.map(Number)
    if (indexes.some((value) => !Number.isInteger(value))) return `choice must be indexes — got: ${JSON.stringify(raw)}`
    return indexes
  }
  if (typeof raw === 'number' && Number.isInteger(raw)) return [raw]
  if (Array.isArray(raw) && raw.every((value) => Number.isInteger(value))) return raw as number[]
  if (typeof raw !== 'string') return `choice must be an index, a list of unique indexes ("2,3"), or "all" — got: ${JSON.stringify(raw)}`
  const text = raw.trim().toLowerCase()
  return text === 'all' ? Array.from({ length: total }, (_, index) => index) : list(text)
}

/**
 * Apply the batch a ticket parked, measured against the snapshot its candidates
 * came from. A stale snapshot or an overlapping selection fails instead of
 * half-applying; a fresh ambiguity supersedes the ticket with a new one.
 */
async function decideTicket(pool: FinderPool, id: string, args: Record<string, unknown>, exec: ForgeExec | undefined) {
  const ticket = loadTicket(id)
  if ('error' in ticket) return failure(ticket.error)
  const choices = parseTicketChoice(args.choice, ticket.candidates.length)
  if (typeof choices === 'string') return failure(choices)
  if (choices.length < 1 || new Set(choices).size !== choices.length || choices.some(choice => !Number.isInteger(choice) || Number(choice) < 0 || Number(choice) >= ticket.candidates.length)) {
    return failure(`choice must be unique integers from 0-${ticket.candidates.length - 1}`)
  }
  const chosen = choices.map(choice => ticket.candidates[Number(choice)])
  const step = ticket.steps[ticket.stepIndex]
  const abs = ticket.file
  const workdir = ticket.workdir
  await exec?.authorizeNativePaths?.([workdir, abs])
  // Same split as a fresh batch: commit under the lock, audit after it. A
  // ticket reply must not produce a different audit story than the same edit
  // sent directly — that difference is how "I answered the ticket" ends up
  // looking checked when it was not.
  const committed: { result: ApplyResult } | { fresh: ApplyResult } | { throwable: string } = await withFileLock(storeFor(workdir).dir, () => withFileLock(abs, async () => {
    try {
      const live = loadTicket(id)
      if ('error' in live) return { throwable: live.error }
      await prepareWorkspace(storeFor(workspaceForFile(abs, workdir)), exec)
      // All choices refer to one original snapshot; any drift requires a new decision.
      const stillThere = existsSync(abs) && sha256(readFileSync(abs)) === ticket.sourceHash
        && chosen.every(candidate => candidate.startOffset !== undefined ? new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(abs)).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').slice(candidate.startOffset, candidate.endOffset) === step.find
          : verifyCandidateStillMatches(abs, step.find ?? '', candidate.start, candidate.end))
      if (stillThere) {
        const result = await applyBatch(pool, {
          abs,
          workdir,
          steps: ticket.steps,
          reason: ticket.reason,
          actor: actorOf(exec),
          mode: 'atomic',
          ...(ticket.revertOnSyntaxError === true ? { revertOnSyntaxError: true } : {}),
          verify: ticket.verify,
          exec,
          pinned: [...ticket.decisions, ...chosen.map(candidate => ({ ...candidate, stepIndex: ticket.stepIndex }))],
        })
        if (result.ok || 'ticket' in result) {
          // Success consumes the ticket; a NEW ambiguity (another target step
          // of the same batch) supersedes it with the fresh ticket.
          deleteTicket(id)
        }
        return { result }
      }
      // Invalidated — re-plan against current content.
      deleteTicket(id)
      const fresh = await applyBatch(pool, { abs, workdir, steps: ticket.steps, reason: ticket.reason,
        actor: actorOf(exec), mode: 'atomic', noWrite: true, exec, verify: ticket.verify,
        ...(ticket.revertOnSyntaxError === true ? { revertOnSyntaxError: true } : {}) })
      return { fresh }
    } catch (cause) { return { throwable: causeMessage(cause) } }
  }))
  if ('throwable' in committed) return failure(committed.throwable)
  if ('fresh' in committed) {
    return 'ticket' in committed.fresh
      ? shapeCommitted(committed.fresh, { workdir, abs, steps: ticket.steps, kind: 'ticket', verify: ticket.verify, exec })
      : failure(!committed.fresh.ok && 'error' in committed.fresh ? committed.fresh.error : 'ticket invalidated; re-send ff_edit against current content')
  }
  return shapeCommitted(committed.result, { workdir, abs, steps: ticket.steps, kind: 'ticket', verify: ticket.verify, exec })
}

/** Project the engine result onto the tool output shape. Hard failures keep
 *  the { error } convention; the first failing step's suggestions travel in
 *  the message so the model can correct in one resend. */
function shapeApplyResult(result: ApplyResult): Record<string, unknown> {
  if (result.ok) {
    return {
      status: 'applied',
      ...(result.workspace ? { workspace: result.workspace } : {}),
      ...(result.batchId ? { batch: result.batchId } : {}),
      applied: result.applied,
      ...(result.skipped ? { skipped: result.skipped } : {}),
      ...(result.created ? { created: true } : {}),
      ...(result.externalBatchId ? { externalBatch: result.externalBatchId } : {}),
      ...(result.syntaxWarning ? { syntaxWarning: result.syntaxWarning } : {}),
      hash: result.hash,
      reports: result.reports,
      ...(result.noChange ? { note: 'content identical — nothing written, nothing recorded' } : {}),
    }
  }
  if ('ticket' in result) {
    return {
      status: 'ticket',
      ticket: result.ticket,
      reason: result.reason,
      candidates: result.candidates,
      reports: result.reports,
    }
  }
  const detail = result.reports
    .filter((r) => (r.status === 'failed' || r.status === 'skipped') && r.reason)
    .slice(0, 3)
    .map((r) => {
      const sug = r.suggestions?.length
        ? ` — did you mean ${r.suggestions.map((s) => `L${s.line} (${Math.round(s.score * 100)}%): ${s.text.slice(0, 80)}`).join(' | ')}?`
        : ''
      return `step ${r.index} (${r.op}): ${r.reason}${sug}`
    })
    .join('; ')
  return { error: detail ? `${result.error} — ${detail}` : result.error }
}

/**
 * The one place a landable batch turns into a tool reply, audit included.
 *
 * Both ff_edit paths (a fresh batch and a ticket reply) go through here, so the
 * same bytes produce the same audit sentence regardless of which entry point
 * wrote them. A no-change batch and an ambiguity ticket wrote nothing, so they
 * carry no audit at all: pretending to recheck untouched bytes is exactly the
 * "unrun looks like passed" failure the audit status vocabulary exists to stop.
 */
async function shapeCommitted(result: ApplyResult, context: { workdir: string; abs: string; steps: readonly EditStep[]; kind?: 'edit' | 'ticket'; beforeSnapshot?: string; verify?: readonly CheckSelector[]; exec?: ForgeExec }): Promise<Record<string, unknown>> {
  const shaped = shapeApplyResult(result)
  // Reported even when nothing changed: the caller asked "was this file still
  // the one the baseline described", and that answer is independent of whether
  // the batch turned out to be a no-op.
  const evidence = context.beforeSnapshot ? { snapshotId: context.beforeSnapshot, verified: true } : undefined
  const checks = context.verify ?? []
  if (!result.ok || result.noChange) {
    // A verification asked for on a batch that wrote nothing has no scope; say
    // so instead of returning an empty verdict that reads like a pass.
    const skipped = checks.length > 0
      ? { verification: { status: 'not_run' as const, text: '[verify] not_run: this call wrote nothing, so there is no batch to check' } }
      : undefined
    return { ...shaped, ...(evidence ? { beforeEvidence: evidence } : {}), ...(skipped ?? {}) }
  }
  const audit = await auditCommit({
    workspace: context.workdir,
    batchId: result.batchId,
    kind: context.kind ?? 'edit',
    changed: [{ rel: relForward(context.workdir, context.abs), abs: context.abs }],
    steps: context.steps,
    hash: result.hash,
    syntaxWarning: result.syntaxWarning !== undefined,
  })
  const verification = checks.length > 0 ? await verifyBatch(result.batchId, checks, context.exec) : undefined
  return { ...shaped, ...(evidence ? { beforeEvidence: evidence } : {}), audit, ...(verification ? { verification } : {}) }
}

/** Which static checks `verify` accepts. The order is the report order. */
const VERIFY_CHECKS: readonly CheckSelector[] = ['bridge', 'ipc', 'syntax']

/**
 * Read `verify` before the write, not after: a typo discovered once the bytes
 * have landed would leave a committed batch and a failed call.
 */
function normaliseVerify(raw: unknown): { checks: CheckSelector[] } | { error: string } {
  if (raw === undefined || raw === null) return { checks: [] }
  if (!Array.isArray(raw)) return { error: 'verify must be a list of check names (bridge, ipc, syntax) — omit it to keep the audit line only' }
  const checks: CheckSelector[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || !VERIFY_CHECKS.includes(item as CheckSelector)) {
      return { error: `verify takes ${VERIFY_CHECKS.join(', ')} — got: ${JSON.stringify(item)}` }
    }
    if (!checks.includes(item as CheckSelector)) checks.push(item as CheckSelector)
  }
  return { checks }
}

/**
 * The batch-level verdict that used to be a separate tool.
 *
 * `ffcheck action=static` had zero calls in 149 recorded sessions: nobody asks
 * a second question about a write they just made. The same engine runs here, on
 * the batch this call created, and archives its record for ff_history — reached
 * at the moment the caller is already looking at the diff.
 */
async function verifyBatch(
  batchId: number | undefined,
  checks: readonly CheckSelector[],
  exec: ForgeExec | undefined,
): Promise<{ status: string; text: string; id?: string; persisted?: boolean }> {
  try {
    const result = await runStaticCheck({ batches: batchId === undefined ? [] : [batchId], checks: [...checks] }, exec)
    if ('error' in result) return { status: 'not_run', text: `[verify] not_run: ${result.error}` }
    return {
      status: result.status,
      text: result.text,
      ...(result.verification ? { id: result.verification.id, persisted: result.verification.persisted } : {}),
    }
  } catch (cause) {
    // The write stands. A check that could not run must never read as an edit
    // that failed, so it comes back as not_run with its own sentence.
    return { status: 'not_run', text: `[verify] not_run: ${cause instanceof Error ? cause.message : String(cause)}` }
  }
}

// ---------------------------------------------------------------------------
// ff_history
// ---------------------------------------------------------------------------

export function createHistoryTool() {
  return {
    name: 'ff_history',
    description:
      'Search persistent change history, newest first: what changed, when, by which actor and why. ' +
      'Pass batch or node for that batch\'s immutable snapshot diffs instead of a listing (independent of the files and of Git). ' +
      'Returns IDs for ff_rollback. Filters combine; narrow project/path if content scanning is truncated.',
    parameters: {
      batch: { type: 'integer', description: 'Positive batch ID from a previous call: return its nodes\' snapshot diffs, not a listing.' },
      node: { type: 'string', description: 'One node address, e.g. b12:n0: return just that node\'s diff. Mutually exclusive with batch.' },
      pathContains: { type: 'string', description: 'Substring filter on file paths; not a filesystem path.' },
      keyword: { type: 'string', description: 'Case-insensitive substring filter on reasons.' },
      actor: { type: 'string', description: 'Exact actor (session id) filter.' },
      kind: { type: 'string', enum: ['edit', 'rollback', 'external', 'project'], description: 'Batch-kind filter.' },
      content: { type: 'string', description: 'Case-insensitive literal in UTF-8 before/after snapshots; 32MB scan budget.' },
      limit: { type: 'integer', description: 'Max batches (default 20, max 100).' },
      checks: { type: 'boolean', description: 'Attach the archived verification records and their CURRENT applicability. A record that no longer matches its inputs is shown as stale; the recorded verdict itself never changes.' },
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
                batch: { type: 'integer', required: true },
                ts: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                actor: { type: 'string', required: true },
                reason: { type: 'string', required: true },
                files: { type: 'array', required: true, items: { type: 'string' } },
                diffs: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      node: { type: 'string', required: true },
                      file: { type: 'string', required: true },
                      before: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                      after: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                      diff: { type: 'string', required: true },
                      binary: { type: 'boolean', required: true },
                      truncated: { type: 'boolean', required: true },
                    },
                  },
                },
                checks: {
                  type: 'array',
                  items: {
                    type: 'object', additionalProperties: false, properties: {
                      id: { type: 'string', required: true },
                      recorded: { type: 'string', required: true },
                      applicable: { type: 'boolean', required: true },
                      effective: { type: 'string', required: true },
                      provenance: { type: 'string', required: true },
                      finishedAt: { type: 'string', required: true },
                      drifted: { type: 'array', items: { type: 'string' } },
                      detail: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          checksNote: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args: unknown, value: { items: Array<{ batch: number; ts: string; kind: string; actor: string; reason: string; files: string[]; diffs?: Array<{ node: string; diff: string; truncated: boolean }>; checks?: Array<{ id: string; recorded: string; applicable: boolean; effective: string; provenance: string; finishedAt: string; drifted?: string[]; detail?: string }> }>; note?: string; checksNote?: string }) => {
        if (value.items.length === 0) return text('no ledger entries matched')
        const lines = value.items.map((b) => {
          const head = `#${b.batch} ${b.ts} ${b.kind} by ${b.actor.slice(0, 12)}… — ${b.reason}\n    ${b.files.join(', ')}`
          // A recorded verdict and its present applicability are printed as two
          // separate facts. Collapsing them into one word would let an old pass
          // read as current.
          const checks = (b.checks ?? []).map((c) => {
            const drift = c.drifted?.length ? ` — drifted: ${c.drifted.join(', ')}` : ''
            return `    [check ${c.id}] recorded ${c.recorded} (${c.provenance}, ${c.finishedAt}); now: ${c.effective}${c.applicable ? '' : ' (not applicable)'}${drift}${c.detail ? ` — ${c.detail}` : ''}`
          })
          const body = b.diffs?.length ? b.diffs.map((d) => `${d.node}${d.truncated ? ' [truncated]' : ''}\n${d.diff}`) : []
          return [head, ...checks, ...body].join('\n')
        })
        if (value.note) lines.push(`[${value.note}]`)
        return text(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      const allowed = new Set(['batch', 'node', 'pathContains', 'keyword', 'actor', 'kind', 'content', 'limit', 'checks'])
      for (const key of Object.keys(args)) if (!allowed.has(key)) return failure(`${key} is not a parameter of ff_history`)
      for (const key of ['node', 'pathContains', 'keyword', 'actor', 'content']) if (args[key] !== undefined && typeof args[key] !== 'string') return failure(`${key} must be a string`)
      if (args.checks !== undefined && typeof args.checks !== 'boolean') return failure('checks must be boolean')
      if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 100)) return failure('limit must be an integer between 1 and 100')
      if (args.kind !== undefined && !['edit', 'rollback', 'external', 'project'].includes(String(args.kind))) return failure('invalid history kind')
      if ((args.batch !== undefined || args.node !== undefined) && ['pathContains', 'keyword', 'actor', 'kind', 'content', 'limit'].some(key => args[key] !== undefined)) return failure('batch/node diff selection is exclusive with listing filters')
      const store = storeFor(canonicalWorkspace(workdirOf(exec)))
      const wantChecks = args.checks === true
      const checksFor = (batchId: number) => {
        if (!wantChecks) return undefined
        return listRecords(store, { batchIds: [batchId], limit: 50 }).records.map(record => {
          const now = applicabilityOf(record, store.root)
          return {
            id: record.id.slice(0, 8), recorded: now.verdict.status, applicable: now.applicable,
            effective: now.effective, provenance: record.provenance,
            finishedAt: record.finishedAt.replace('T', ' ').slice(0, 19),
            ...(now.drifted.length === 0 ? {} : { drifted: now.drifted }),
            ...(now.reason === 'evidence_schema' ? { detail: 'older evidence format; run a fresh check' } : now.verdict.reason === undefined ? {} : { detail: now.verdict.reason }),
          }
        })
      }
      const revision = wantChecks ? readRevision(store) : undefined
      const checksNote = wantChecks
        ? revision!.records === 0
          ? 'no verification records archived for this workspace yet'
          : `verification revision ${revision!.revision} over ${revision!.records} record(s); "recorded" is history, "now" is recomputed against the current files`
        : undefined
      // Diff mode, absorbed from the former ff_diff: one batch (or one node of
      // it) resolved from the same ledger this tool already searches, with the
      // immutable snapshots attached to the batch entry. Listing filters do
      // not apply here — the address is the selector.
      if (args.batch !== undefined || args.node !== undefined) {
        if (args.batch !== undefined && args.node !== undefined) return failure('provide exactly one of batch or node')
        try {
          const pick = (): { batch: NonNullable<ReturnType<typeof readLedgerTail>[number]>; picks: Array<{ node: LedgerNode; index: number }> } | ToolFailure => {
            if (typeof args.node === 'string') {
              const read = readNode(store, args.node)
              return { batch: read.batch, picks: [{ node: read.node, index: read.index }] }
            }
            if (!Number.isSafeInteger(args.batch) || Number(args.batch) < 1) return failure('batch must be a positive integer')
            const found = readLedgerTail(store, Number.MAX_SAFE_INTEGER).find((b) => b.id === args.batch)
            if (!found) return failure(`batch ${String(args.batch)} not found`)
            if (found.nodes.length > 50) return failure('batch has more than 50 nodes; query individual nodes')
            return { batch: found, picks: found.nodes.map((node, index) => ({ node, index })) }
          }
          const selected = pick()
          if ('error' in selected) return selected
          const b = selected.batch
          return {
            items: [{
              batch: b.id,
              ts: new Date(b.ts).toISOString().replace('T', ' ').slice(0, 19),
              kind: b.kind,
              actor: b.actor,
              reason: b.reason,
              files: b.nodes.map((n) => `${n.file} (${n.op}, ${n.bytes}B)`),
              diffs: selected.picks.map(({ node, index }) => ({
                node: nodeId(b.id, index),
                file: node.file,
                before: node.before,
                after: node.after,
                ...snapshotDiff(snapshot(store, node.before), snapshot(store, node.after), node.file),
              })),
              ...(wantChecks ? { checks: checksFor(b.id) ?? [] } : {}),
            }],
            ...(checksNote === undefined ? {} : { checksNote }),
          }
        } catch (cause) { return failure(causeMessage(cause)) }
      }
      const limit = clampInt(args.limit, 20, 1, 100)
      const content = typeof args.content === 'string' && args.content.trim() ? args.content : undefined
      const budget = { remaining: 32 * 1024 * 1024 }
      let batches = searchHistory(store, {
        path: typeof args.pathContains === 'string' && args.pathContains.trim() !== '' ? args.pathContains.trim() : undefined,
        keyword: typeof args.keyword === 'string' && args.keyword.trim() !== '' ? args.keyword.trim() : undefined,
        actor: typeof args.actor === 'string' && args.actor.trim() !== '' ? args.actor.trim() : undefined,
        kind: args.kind === 'edit' || args.kind === 'rollback' || args.kind === 'external' || args.kind === 'project' ? args.kind : undefined,
        limit: content ? Number.MAX_SAFE_INTEGER : limit,
      })
      if (content) {
        try { batches = batches.filter(batch => historyContentMatches(store, batch, content, budget)).slice(0, limit) }
        catch (cause) { return failure(causeMessage(cause)) }
      }
      if (!existsSync(store.ledgerFile)) {
        return { items: [], note: `no ledger yet for this workspace (${store.dir})` }
      }
      return {
        items: batches.map((b) => ({
          batch: b.id,
          ts: new Date(b.ts).toISOString().replace('T', ' ').slice(0, 19),
          kind: b.kind,
          actor: b.actor,
          reason: b.reason,
          files: b.nodes.map((n) => `${n.file} (${n.op}, ${n.bytes}B)`),
          ...(wantChecks ? { checks: checksFor(b.id) ?? [] } : {}),
        })),
        ...(checksNote === undefined ? {} : { checksNote }),
      }
    },
  } as const
}

// ---------------------------------------------------------------------------
// ff_rollback
// ---------------------------------------------------------------------------

interface RollbackPlanItem {
  rel: string
  abs: string
  action: 'restore' | 'delete' | 'skip'
  targetBlob: string | null
  currentBlob: string | null
  bytes: number
  eol: TextEncoding['eol']
  bom: boolean
  detail: string
}

export function createRollbackTool(pool: FinderPool) {
  return {
    name: 'ff_rollback',
    description:
      'Restore full file snapshots, overwriting later changes; files created after the selected state are deleted. Current bytes are saved for redo. ' +
      'Provide exactly one of batch, latest=true or throughBatch. Project/task records remain. Inspect the default dry run, then resend with dryRun=false.',
    parameters: {
      batch: { type: 'integer', description: 'Undo this positive integer batch id; exclusive with latest=true and throughBatch.' },
      latest: { type: 'boolean', description: 'Select the latest non-project batch when true. Exclusive with batch and throughBatch.' },
      throughBatch: { type: 'integer', description: 'Restore files to the state after this batch; 0 = initial state.' },
      path: { type: 'string', description: 'Restrict files by path substring.' },
      dryRun: { type: 'boolean', description: 'Default true (plan only); false writes the rollback.' },
      reason: { type: 'string', required: true, description: 'Why this rollback; recorded in history.' },
      node: { type: 'string', description: 'With batch only: one node (e.g. b12:n0) that belongs to that batch.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          revertedBatch: { type: 'integer' },
          newBatch: { type: 'integer' },
          dryRun: { type: 'boolean' },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string', required: true },
                action: { type: 'string', required: true },
                detail: { type: 'string', required: true },
              },
            },
          },
          note: { type: 'string' },
        },
      },
      render: (_args: unknown, value: { status: string; revertedBatch?: number; newBatch?: number; dryRun?: boolean; items: Array<{ file: string; action: string; detail: string }>; note?: string }) => {
        const lines = [`${value.dryRun ? 'rollback plan (dry run — re-send with dryRun: false to execute)' : 'rolled back'}${value.revertedBatch ? ` batch #${value.revertedBatch}` : ''}${value.newBatch ? ` — recorded as batch #${value.newBatch}` : ''}`]
        for (const item of value.items) {
          lines.push(`  ${item.action.toUpperCase()} ${item.file}${item.detail ? ` — ${item.detail}` : ''}`)
        }
        if (value.note) lines.push(`[${value.note}]`)
        return text(lines.join('\n'))
      },
    },
    // 两个选择器补成 0 与「没选」同义；宁可要求重选，也不拿 0 去回滚。
    hygiene: { zeroMeansAbsent: ['batch', 'throughBatch'] },
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
      if (reason === '') {
        return failure('reason is required for every construction step (development-history ledger). Re-send with e.g. {"batch": "last", "dryRun": false, "reason": "revert: approach X broke login"}')
      }
      const allowed = new Set(['batch', 'latest', 'throughBatch', 'path', 'dryRun', 'reason', 'node'])
      for (const key of Object.keys(args)) if (!allowed.has(key)) return failure(`${key} is not a parameter of ff_rollback`)
      for (const key of ['latest', 'dryRun']) if (args[key] !== undefined && typeof args[key] !== 'boolean') return failure(`${key} must be boolean`)
      if (args.batch !== undefined && (!Number.isSafeInteger(args.batch) || Number(args.batch) < 1)) return failure('batch must be a positive integer')
      if (args.throughBatch !== undefined && (!Number.isSafeInteger(args.throughBatch) || Number(args.throughBatch) < 0)) return failure('throughBatch must be a nonnegative integer')
      if ([args.batch !== undefined, args.latest === true, args.throughBatch !== undefined].filter(Boolean).length !== 1) return failure('provide exactly one of batch, latest=true or throughBatch')
      if (args.latest !== undefined && args.latest !== true && (args.batch !== undefined || args.throughBatch !== undefined)) return failure('omit latest when selecting batch or throughBatch')
      for (const key of ['path', 'node']) if (args[key] !== undefined && typeof args[key] !== 'string') return failure(`${key} must be a string`)
      const dryRun = args.dryRun !== false
      const pathFilter = typeof args.path === 'string' && args.path.trim() !== '' ? args.path.trim() : undefined
      const workdir = canonicalWorkspace(workdirOf(exec))
      const store = storeFor(workdir)
      if (!existsSync(store.ledgerFile)) return failure(`no ledger for this workspace (${store.dir}) — nothing to roll back`)

      return withFileLock(store.dir, async () => {
        await prepareWorkspace(store, exec)
        const batches = readLedgerTail(store, Number.MAX_SAFE_INTEGER)
        const rawBatch = args.batch
        let target = null as (typeof batches)[number] | null

        if (args.throughBatch !== undefined) {
          const boundary = Number(args.throughBatch)
          if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary > (batches.at(-1)?.id ?? 0)) return failure('throughBatch must be an existing ledger boundary or 0')
          if (args.node !== undefined) return failure('node cannot be combined with throughBatch')
          const later = batches.filter(batch => batch.id > boundary && batch.kind !== 'project')
          const selected = new Map<string, { node: LedgerNode; batch: (typeof batches)[number] }>()
          const atBoundary = new Map<string, LedgerNode>()
          for (const batch of batches) {
            if (batch.id > boundary) break
            for (const node of batch.nodes) atBoundary.set(node.file, node)
          }
          for (const batch of later) {
            for (const node of batch.nodes) {
              if ((!pathFilter || node.file.includes(pathFilter)) && !selected.has(node.file)) {
                const previous = atBoundary.get(node.file)
                selected.set(node.file, { node: { ...node, op: 'update', before: previous ? previous.after : node.before }, batch })
              }
            }
          }
          // Boundary history wins over a later edit's baseline, which may already
          // contain an external modification. With no earlier node, use baseline.
          target = { t: 'b', id: boundary, ts: Date.now(), kind: 'rollback', reason, actor: actorOf(exec),
            nodes: [...selected.values()].map(item => item.node) }
        } else if (args.latest === true) {
          target = batches.filter(batch => batch.kind !== 'project').at(-1) ?? null
        } else {
          const id = Number(rawBatch)
          if (Number.isInteger(id)) target = batches.find((b) => b.id === id) ?? null
        }
        if (!target) return failure(`batch not found: ${String(rawBatch)} — use ff_history to list ledger batches`)
  
        let nodeIndex: number | undefined
        if (args.node !== undefined) {
          try {
            if (typeof args.node !== 'string') throw new Error('node must be a stable address')
            const selected = readNode(store, args.node)
            if (selected.batch.id !== target.id) throw new Error('node does not belong to the selected batch')
            nodeIndex = selected.index
          } catch (cause) { return failure(causeMessage(cause)) }
        }
        const nodes = target.nodes.filter((n, index) => (nodeIndex === undefined || nodeIndex === index) && (!pathFilter || n.file.includes(pathFilter)))
        if (nodes.length === 0) {
          return failure(`batch #${target.id} has no nodes matching path="${pathFilter ?? ''}"`)
        }
        await exec?.authorizeNativePaths?.(nodes.map(node => path.resolve(store.root, node.file)))
  
        return withFileLocks(nodes.map(n => path.resolve(store.root, n.file)), async () => {
          // Snapshot current content under all affected file locks.
          const plan: RollbackPlanItem[] = []
          for (const node of nodes) {
            const abs = path.resolve(store.root, node.file)
            if (isSymbolicLink(abs)) return failure(`rollback refuses symbolic link identity: ${abs}`)
            const exists = existsSync(abs)
            if (node.op === 'external') {
              plan.push({ rel: node.file, abs, action: 'skip', targetBlob: null, currentBlob: null, bytes: 0, eol: 'LF', bom: false, detail: 'external marker — nothing to restore' })
              continue
            }
            let currentBlob: string | null = null
            let curEol: TextEncoding['eol'] = 'LF'
            let curBom = false
            if (exists) {
              try {
                const bytes = readFileSync(abs)
                const raw = bytes.toString('utf8')
                const enc = detectEncoding(raw)
                curEol = enc.eol
                curBom = enc.bom
                currentBlob = putBlob(store, bytes).id
              } catch (cause) {
                return failure(`cannot read ${abs}: ${causeMessage(cause)}`)
              }
            }
            if (node.before === null) {
              plan.push({ rel: node.file, abs, action: 'delete', targetBlob: null, currentBlob, bytes: 0, eol: curEol, bom: curBom, detail: `file was created by batch #${target.id}` })
              continue
            }
            const restored = getBlob(store, node.before)
            if (!restored) {
              return failure(`snapshot blob for ${node.file} (batch #${target.id}) is missing — was the store pruned?`)
            }
            const targetEnc = detectEncoding(restored.toString('utf8'))
            plan.push({
              rel: node.file, abs,
              action: 'restore',
              targetBlob: node.before,
              currentBlob,
              bytes: restored.length,
              eol: targetEnc.eol,
              bom: targetEnc.bom,
              detail: `restore ${restored.length}B snapshot`,
            })
          }
    
          if (dryRun) {
            return {
              status: 'plan',
              revertedBatch: target.id,
              dryRun: true,
              items: plan.map((p) => ({ file: p.rel, action: p.action, detail: p.detail })),
              note: 'current content will be snapshotted before any write',
            }
          }
    
          try {
            return await withNativeWrite(exec, plan.filter(item => item.action !== 'skip').map(item => item.abs), () => {
              const changes = plan.filter(p => p.action !== 'skip').map(item => {
                const before = item.currentBlob === null ? null : getBlob(store, item.currentBlob)
                const after = item.targetBlob === null ? null : getBlob(store, item.targetBlob)
                if (item.currentBlob !== null && !before || item.targetBlob !== null && !after) throw new Error('snapshot disappeared before commit')
                return { file: item.abs, before, after }
              })
              const ledgerNodes: LedgerNode[] = plan.filter(p => p.action !== 'skip').map(item => ({
                file: item.rel, op: item.action === 'delete' ? 'delete' : 'update',
                before: item.currentBlob, after: item.targetBlob, bytes: item.bytes, eol: item.eol, bom: item.bom,
              }))
              const batch = commitFiles(store, { kind: 'rollback', reason, actor: actorOf(exec), reverted: target.id, nodes: ledgerNodes }, changes)
              return { status: 'applied', revertedBatch: target.id, newBatch: batch.id, dryRun: false,
                items: plan.map(p => ({ file: p.rel, action: p.action, detail: p.detail })) }
            })
          } catch (cause) {
            return failure('rollback commit failed: ' + causeMessage(cause))
          }
        })
      })
    },
  } as const
}
