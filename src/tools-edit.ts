/**
 * dsh-forge construction tools (stage 3): ffedit / ffresolve / ffhistory /
 * ffrollback. Thin factories — the pure engine lives in src/edit-engine.ts,
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
import { isSymbolicLink } from './fs-paths.ts'
import { canonicalWorkspace, resolveProjectLink } from './projects.ts'
import type { ProjectLink } from './project-model.ts'
import { historyContentMatches, nodeId, readNode } from './history.ts'
import { detectLanguage, enclosingSymbol, parseFile, syntaxValid } from './ast.ts'
import {
  type FinderPool,
  type ForgeExec,
  type ToolFailure,
  clampInt,
  takeQueryFor,
  withFileLock,
  withFileLocks,
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

// ---------------------------------------------------------------------------
// Core write pipeline (shared by ffedit and ffresolve)
// ---------------------------------------------------------------------------

interface ApplyParams {
  exec?: ForgeExec
  abs: string
  workdir: string
  steps: EditStep[]
  reason: string
  actor: string
  mode: 'atomic' | 'bestEffort'
  link?: ProjectLink
  /** Refuse the write when the planned text introduces syntax errors into a file that parsed cleanly. */
  revertOnSyntaxError?: boolean
  /** ffresolve: ticket-verified target coordinates. */
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

async function applyBatch(pool: FinderPool, params: ApplyParams): Promise<ApplyResult> {
  const { abs, workdir, steps, reason, actor, mode } = params
  const store = storeFor(workspaceForFile(abs, workdir))
  const workspace = store.root
  await prepareWorkspace(store, params.exec)
  if (params.link) resolveProjectLink(store, params.link.projectId, params.link.todoId, abs)
  const rel = relForward(workspace, abs)
  const exists = existsSync(abs)

  let rawBuf: Buffer | null = null
  let bodyText = ''
  let enc: TextEncoding = { eol: 'LF', bom: false }
  let hash = ''
  if (exists) {
    let raw: string
    try {
      rawBuf = readFileSync(abs)
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
  } else if (!steps.some((s) => (s.op ?? (s.after !== undefined ? 'insert' : undefined)) === 'insert')) {
    return { ok: false, error: `file not found: ${abs} — create it with an insert step ({"after": 0, "text": ...})`, reports: [] }
  }

  // External-modification tripwire: disk content differs from the ledger's
  // last-known state → snapshot it first so rollback never swallows it.
  let externalBatchId: number | undefined
  const options: EditOptions = { mode, pinnedTargets: params.pinned }
  const planned = applyEditSteps(bodyText, steps, options)
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
        sourceHash: hash,
        workdir,
        decisions: params.pinned ?? [],
        ...params.link,
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
        if (known && known.hash !== hash) externalBatchId = recordExternalState(store, rel, rawBuf, enc.eol, enc.bom, params.link).batch.id
      }
      const after = putBlob(store, newRaw).id
      return commitFiles(store, {
        kind: 'edit', reason, actor,
        ...params.link,
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
// ffedit
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
    replaceWith: { type: 'string', description: 'Required for target: replacement; empty string deletes.' },
    text: { type: 'string', description: 'Required for replace/insert: text with newline separators.' },
    expect: { type: 'string', description: 'Expected start/after line; re-anchor within ±20 lines if shifted.' },
    inline: { type: 'boolean', description: 'target: force single-line substring match. Also auto-selected if whole-line matching fails; requires atomic mode.' },
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
    name: 'ffedit',
    description:
      'Edit text after reading it. All steps use ORIGINAL snapshot lines; overlaps fail. Prefer expect anchors or target matching; ambiguity returns a ticket for ffresolve. ' +
      'Replacement text that quotes the range\'s first and last lines preserves those boundary lines. Create files with insert after=0. ' +
      'Preserves UTF-8 CRLF/LF/BOM; refuses binary files. Changes are snapshotted for ffrollback. For symbol edits or code transfers use ff_file.',
    parameters: {
      path: { type: 'string', required: true, description: 'File path (absolute or workspace-relative).' },
      steps: { type: 'array', required: true, items: STEP_ITEM_SCHEMA, description: '1–50 steps in original snapshot coordinates.' },
      reason: { type: 'string', required: true, description: 'Why this change; recorded in history.' },
      mode: { type: 'string', enum: ['atomic', 'bestEffort'], description: 'Default atomic: failure writes nothing. bestEffort skips failed steps; inspect reports.' },
      revertOnSyntaxError: { type: 'boolean', description: 'Reject new syntax errors in previously clean files. Default false; already-invalid files remain report-only.' },
      projectId: { type: 'string', description: 'Associate with a durable project; file must be inside its root.' },
      todoId: { type: 'string', description: 'Associate with a project task; requires projectId.' },
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
          note: { type: 'string' },
        },
      },
      render: (_args: unknown, value: { status: string; batch?: number; applied?: number; skipped?: number; created?: boolean; externalBatch?: number; syntaxWarning?: string; ticket?: string; candidates?: Array<{ index: number; start: number; end: number; symbol?: string | null; preview: string }>; reports?: StepReport[]; note?: string }) => {
        const lines: string[] = []
        if (value.status === 'ticket') {
          lines.push(`ambiguous target — ticket ${value.ticket} signed; pick a candidate with ffresolve {ticket: "${value.ticket}", choice: <index>}`)
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
        if (value.syntaxWarning) lines.push(`[warn] ${value.syntaxWarning}`)
        if (value.note) lines.push(`[${value.note}]`)
        return text(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      const rawPath = typeof args.path === 'string' ? args.path.trim() : ''
      if (rawPath === '') return failure('path is required')
      const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
      if (reason === '') {
        return failure('reason is required for every construction step (development-history ledger). Re-send with e.g. {"path": ..., "steps": [...], "reason": "fix: guard empty token in putBlob"}')
      }
      if (!Array.isArray(args.steps) || args.steps.length === 0) return failure('steps requires 1-50 step objects')
      if (args.steps.length > MAX_STEPS) return failure(`steps accepts at most ${MAX_STEPS} steps`)
      const steps: EditStep[] = args.steps.filter((s): s is EditStep => typeof s === 'object' && s !== null)
      if (steps.length !== args.steps.length) return failure('every step must be an object')
      const mode = args.mode === 'bestEffort' ? 'bestEffort' : 'atomic'
      const abs = resolveFilePath(exec, rawPath)
      const workdir = canonicalWorkspace(workdirOf(exec))
      return withFileLock(storeFor(workdir).dir, () => withFileLock(abs, async () => {
        try {
          const link = resolveProjectLink(storeFor(workdir), args.projectId, args.todoId, abs)
          return shapeApplyResult(await applyBatch(pool, { abs, workdir, steps, reason, actor: actorOf(exec), mode, link, exec, revertOnSyntaxError: args.revertOnSyntaxError === true }))
        } catch (cause) { return failure(causeMessage(cause)) }
      }))
    },
  } as const
}

// ---------------------------------------------------------------------------
// ffresolve
// ---------------------------------------------------------------------------

export function createResolveTool(pool: FinderPool) {
  return {
    name: 'ffresolve',
    description:
      'Resolve an ffedit ticket and apply the full saved batch; do not resend steps. Provide exactly one of choice, choices, all=true. Overlapping selections fail. ' +
      'If stale or another step is ambiguous, follow the returned ticket/error; re-read before a fresh ffedit.',
    parameters: {
      ticket: { type: 'string', required: true, description: 'Ticket ID from ffedit/ffresolve.' },
      choice: { type: 'integer', description: 'One candidate index, 0-based.' },
      choices: { type: 'array', items: { type: 'integer' }, description: 'Nonempty list of candidate indexes, 0-based.' },
      all: { type: 'boolean', description: 'true selects every candidate.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          workspace: { type: 'string' },
          batch: { type: 'integer' },
          hash: { type: 'string' },
          created: { type: 'boolean' },
          externalBatch: { type: 'integer' },
          reason: { type: 'string' },
          applied: { type: 'integer' },
          skipped: { type: 'integer' },
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
          syntaxWarning: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args: unknown, value: { status: string; batch?: number; applied?: number; skipped?: number; ticket?: string; candidates?: Array<{ index: number; start: number; end: number; symbol?: string | null; preview: string }>; reports?: StepReport[]; syntaxWarning?: string; note?: string }) => {
        if (value.status === 'ticket') {
          const lines = [`another decision is required — ticket ${value.ticket}; pick with ffresolve {ticket: "${value.ticket}", choice: <index>}`]
          for (const c of value.candidates ?? []) {
            lines.push(`  [${c.index}] L${c.start}-${c.end}${c.symbol ? ` in ${c.symbol}` : ''}: ${c.preview}`)
          }
          return text(lines.join('\n'))
        }
        const lines = [`resolved — applied ${value.applied ?? 0} step(s)${value.batch ? `, batch #${value.batch}` : ''}`]
        for (const r of value.reports ?? []) {
          const bits: string[] = [r.op, r.status]
          if (r.drift) bits.push(`drift ${r.drift > 0 ? '+' : ''}${r.drift}`)
          if (r.symbol) bits.push(`in ${r.symbol}`)
          if (r.reason) bits.push(r.reason)
          lines.push(`  step ${r.index}: ${bits.join(', ')}`)
        }
        if (value.syntaxWarning) lines.push(`[warn] ${value.syntaxWarning}`)
        if (value.note) lines.push(`[${value.note}]`)
        return text(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      const id = typeof args.ticket === 'string' ? args.ticket.trim() : ''
      if (id === '') return failure('ticket is required')
      const ticket = loadTicket(id)
      if ('error' in ticket) return failure(ticket.error)
      if ([args.choice !== undefined, args.choices !== undefined, args.all === true].filter(Boolean).length !== 1) return failure('provide exactly one of choice, choices or all=true')
      const choices = args.all === true ? ticket.candidates.map((_, index) => index) : Array.isArray(args.choices) ? args.choices : [args.choice]
      if (choices.length < 1 || new Set(choices).size !== choices.length || choices.some(choice => !Number.isInteger(choice) || Number(choice) < 0 || Number(choice) >= ticket.candidates.length)) {
        return failure(`choice must be unique integers from 0-${ticket.candidates.length - 1}`)
      }
      const chosen = choices.map(choice => ticket.candidates[Number(choice)])
      const step = ticket.steps[ticket.stepIndex]
      const abs = ticket.file
      const workdir = ticket.workdir
      await exec?.authorizeNativePaths?.([workdir, abs])
      return withFileLock(storeFor(workdir).dir, () => withFileLock(abs, async () => {
        let link: ProjectLink | undefined
        try { link = resolveProjectLink(storeFor(workdir), ticket.projectId, ticket.todoId, abs) }
        catch (cause) { return failure(causeMessage(cause)) }
        const live = loadTicket(id)
        if ('error' in live) return failure(live.error)
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
            exec,
            link,
            pinned: [...ticket.decisions, ...chosen.map(candidate => ({ ...candidate, stepIndex: ticket.stepIndex }))],
          })
          if (result.ok || 'ticket' in result) {
            // Success consumes the ticket; a NEW ambiguity (another target step
            // of the same batch) supersedes it with the fresh ticket.
            deleteTicket(id)
          }
          return shapeApplyResult(result)
        }
        // Invalidated — re-plan against current content.
        deleteTicket(id)
        const fresh = await applyBatch(pool, { abs, workdir, steps: ticket.steps, reason: ticket.reason,
          actor: actorOf(exec), mode: 'atomic', noWrite: true, link })
        return 'ticket' in fresh ? shapeApplyResult(fresh) : failure(!fresh.ok && 'error' in fresh ? fresh.error : 'ticket invalidated; re-send ffedit against current content')
      }))
    },
  } as const
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

// ---------------------------------------------------------------------------
// ffhistory
// ---------------------------------------------------------------------------

export function createHistoryTool() {
  return {
    name: 'ffhistory',
    description:
      'Search persistent change history, newest first. Returns batch/node IDs for ff_diff or ffrollback. Filters combine; narrow project/path if content scanning is truncated.',
    parameters: {
      path: { type: 'string', description: 'Substring filter on file paths.' },
      keyword: { type: 'string', description: 'Case-insensitive substring filter on reasons.' },
      actor: { type: 'string', description: 'Exact actor (session id) filter.' },
      kind: { type: 'string', enum: ['edit', 'rollback', 'external', 'project'], description: 'Batch-kind filter.' },
      projectId: { type: 'string', description: 'Exact durable project ID filter.' },
      todoId: { type: 'string', description: 'Exact durable task ID filter.' },
      content: { type: 'string', description: 'Case-insensitive literal in UTF-8 before/after snapshots; 32MB scan budget.' },
      limit: { type: 'integer', description: 'Max batches (default 20, max 100).' },
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
                projectId: { type: 'string' }, todoId: { type: 'string' },
                files: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          note: { type: 'string' },
        },
      },
      render: (_args: unknown, value: { items: Array<{ batch: number; ts: string; kind: string; actor: string; reason: string; files: string[] }>; note?: string }) => {
        if (value.items.length === 0) return text('no ledger entries matched')
        const lines = value.items.map((b) =>
          `#${b.batch} ${b.ts} ${b.kind} by ${b.actor.slice(0, 12)}… — ${b.reason}\n    ${b.files.join(', ')}`,
        )
        if (value.note) lines.push(`[${value.note}]`)
        return text(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      const store = storeFor(canonicalWorkspace(workdirOf(exec)))
      const limit = clampInt(args.limit, 20, 1, 100)
      const content = typeof args.content === 'string' && args.content.trim() ? args.content : undefined
      const budget = { remaining: 32 * 1024 * 1024 }
      let batches = searchHistory(store, {
        path: typeof args.path === 'string' && args.path.trim() !== '' ? args.path.trim() : undefined,
        keyword: typeof args.keyword === 'string' && args.keyword.trim() !== '' ? args.keyword.trim() : undefined,
        actor: typeof args.actor === 'string' && args.actor.trim() !== '' ? args.actor.trim() : undefined,
        kind: args.kind === 'edit' || args.kind === 'rollback' || args.kind === 'external' || args.kind === 'project' ? args.kind : undefined,
        projectId: typeof args.projectId === 'string' ? args.projectId : undefined,
        todoId: typeof args.todoId === 'string' ? args.todoId : undefined,
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
          ...(b.projectId ? { projectId: b.projectId } : {}), ...(b.todoId ? { todoId: b.todoId } : {}),
          files: b.nodes.map((n) => `${n.file} (${n.op}, ${n.bytes}B)`),
        })),
      }
    },
  } as const
}

// ---------------------------------------------------------------------------
// ffrollback
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
    name: 'ffrollback',
    description:
      'Restore full file snapshots, overwriting later changes; files created after the selected state are deleted. Current bytes are saved for redo via ffrollback. ' +
      'Provide exactly one of batch or throughBatch. Project/task records remain. Inspect the default dry run, then resend with dryRun=false.',
    parameters: {
      batch: { type: 'string', description: 'Undo this batch: string ID from ffhistory, e.g. "12", or "last".' },
      throughBatch: { type: 'integer', description: 'Restore files to the state after this batch; 0 = initial state.' },
      projectId: { type: 'string', description: 'Scope throughBatch to this project; ignored with batch.' },
      path: { type: 'string', description: 'Restrict files by path substring.' },
      dryRun: { type: 'boolean', description: 'Default true: plan only. false writes the rollback.' },
      reason: { type: 'string', required: true, description: 'Why this rollback; recorded in history.' },
      node: { type: 'string', description: 'With batch only: select one node, e.g. b12:n0; must belong to that batch.' },
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
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
      if (reason === '') {
        return failure('reason is required for every construction step (development-history ledger). Re-send with e.g. {"batch": "last", "dryRun": false, "reason": "revert: approach X broke login"}')
      }
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
        if ((args.throughBatch === undefined) === (args.batch === undefined)) return failure('provide exactly one of batch or throughBatch')
        if (args.throughBatch !== undefined) {
          const boundary = Number(args.throughBatch)
          if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary > (batches.at(-1)?.id ?? 0)) return failure('throughBatch must be an existing ledger boundary or 0')
          if (args.node !== undefined) return failure('node cannot be combined with throughBatch')
          const later = batches.filter(batch => batch.id > boundary && batch.kind !== 'project')
          const linkedFiles = new Set(later.filter(batch => args.projectId === undefined || batch.projectId === args.projectId).flatMap(batch => batch.nodes.map(node => node.file)))
          const selected = new Map<string, { node: LedgerNode; batch: (typeof batches)[number] }>()
          const atBoundary = new Map<string, LedgerNode>()
          for (const batch of batches) {
            if (batch.id > boundary) break
            for (const node of batch.nodes) atBoundary.set(node.file, node)
          }
          for (const batch of later) {
            for (const node of batch.nodes) {
              if (linkedFiles.has(node.file) && (!pathFilter || node.file.includes(pathFilter)) && !selected.has(node.file)) {
                const previous = atBoundary.get(node.file)
                selected.set(node.file, { node: { ...node, op: 'update', before: previous ? previous.after : node.before }, batch })
              }
            }
          }
          // Boundary history wins over a later edit's baseline, which may already
          // contain an external modification. With no earlier node, use baseline.
          const projectIds = new Set(later.filter(batch => batch.nodes.some(node => selected.has(node.file))).map(batch => batch.projectId))
          if (projectIds.size > 1) return failure('point rollback spans multiple project links; restrict path to files with one consistent project link')
          const first = [...selected.values()][0]
          target = { t: 'b', id: boundary, ts: Date.now(), kind: 'rollback', reason, actor: actorOf(exec),
            ...(first?.batch.projectId ? { projectId: first.batch.projectId } : {}), nodes: [...selected.values()].map(item => item.node) }
        } else if (rawBatch === 'last') {
          target = batches.filter(batch => batch.kind !== 'project').at(-1) ?? null
        } else {
          const id = typeof rawBatch === 'number' ? rawBatch : Number(typeof rawBatch === 'string' ? rawBatch : NaN)
          if (Number.isInteger(id)) target = batches.find((b) => b.id === id) ?? null
        }
        if (!target) return failure(`batch not found: ${String(rawBatch)} — use ffhistory to list ledger batches`)
  
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
              const link = resolveProjectLink(store, target.projectId, target.todoId)
              const batch = commitFiles(store, { kind: 'rollback', reason, actor: actorOf(exec), reverted: target.id, nodes: ledgerNodes, ...link }, changes)
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
