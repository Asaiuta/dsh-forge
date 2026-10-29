/**
 * dsh-forge knowledge cards (sedimentation stage 1): a deterministic,
 * zero-model distillation of the construction ledger into cached overview
 * cards, served by ff_cards.
 *
 * Position (user decisions, 2026-10-24): cards are a CACHE, not an artifact.
 * They live outside the workspace under `~/.dsh/forge/cards/<workspace-key>/`
 * — the same key space as the snapshot stores, so an anchor can never point
 * at a different ledger than the one that produced it — they are regenerated
 * in full whenever the anchor moves, they are not hand-edited, and nothing
 * here writes into the workspace, so the ffedit governance pipeline is not
 * involved.
 *
 * The distillation is deliberately deterministic: ledger batches plus
 * content-anchored AST outlines of the files construction touched. The
 * model-polish layer (stage 2) is planned to sit on top of these skeletons
 * and to fall back to them; nothing in this module may depend on it.
 *
 * Freshness includes source contents, the verification revision and freshly
 * recomputed applicability. These are checked before either cache-return path;
 * size/mtime never decides whether an archived pass still applies.
 *
 * No in-process cache: everything is derived from disk and the ledger view is
 * cached one level down (ledger.ts). A missing reset hook is therefore honest
 * here — `refresh: true` is the forced-cold path.
 *
 * @module dsh-forge/cards
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { dataDir, withFileLock, type ToolFailure } from './core.ts'
import { atomicWrite, readLedgerTail, storeFor, type LedgerBatch, type StorePaths } from './ledger.ts'
import { detectLanguage, outlineView, parseFile, MAX_AST_FILE_BYTES } from './ast.ts'
import { readBoundedFile } from './fs-paths.ts'
import type { PolishFacts } from './distill.ts'
import { applicabilityOf, listRecords, readRevision } from './verification.ts'

// ---------------------------------------------------------------------------
// Card set
// ---------------------------------------------------------------------------

export const CARD_NAMES = ['overview', 'hotspot', 'timeline', 'structure'] as const
export type CardName = (typeof CARD_NAMES)[number]

const CARD_TITLES: Record<CardName, string> = {
  overview: 'project construction overview',
  hotspot: 'hot files by construction activity',
  timeline: 'recent construction by day',
  structure: 'symbol skeleton of recently constructed files',
}

/** Hotspot rows kept; beyond this the card says how many were dropped. */
const HOTSPOT_ROWS = 60
/** Days of activity the timeline covers, counted back from the last batch. */
const TIMELINE_DAYS = 14
/** Recent batches the structure card samples its files from. */
const STRUCTURE_BATCH_WINDOW = 30
const STRUCTURE_FILES = 12
const STRUCTURE_DEPTH = 2
const STRUCTURE_SYMBOLS_PER_FILE = 24
/** Reason excerpts are clipped; a card is a pointer, not an archive. */
const REASON_MAX = 120

export interface CardAnchor {
  batches: number
  lastId: number
  files: string
  /**
   * Committed verification revision.
   *
   * Part of the anchor because a check can be archived without any code batch:
   * new evidence moves this and nothing else, and the cards must refresh to show
   * it.
   */
  verification: number
  /** Digest of current applicability, rechecked before serving cached cards. */
  applicability: string
}

export interface CardInfo {
  name: string
  title: string
  batches: number
  bytes: number
}

export interface CardsStateFile {
  version: 1
  generatedAt: string
  anchor: CardAnchor
  cards: CardInfo[]
}

export interface CardsResult {
  root: string
  dir: string
  anchor?: CardAnchor
  cards: CardInfo[]
  regenerated: string[]
  /** Cards whose polished draft is valid at the current anchor. */
  polished: string[]
  /** Usage counts, for the distill offer's suggested target. */
  reads: CardReadStats
  empty?: boolean
  note?: string
}

function failure(error: string): ToolFailure {
  return { error }
}

/** Cards live beside the snapshot stores, keyed by the store's own key: an
 *  alias-resolved store and its cards can never diverge. */
export function cardsDirFor(workspaceRoot: string): string {
  return path.join(dataDir(), 'cards', path.basename(storeFor(workspaceRoot).dir))
}

// ---------------------------------------------------------------------------
// Aggregation (deterministic — same ledger bytes, same card bytes)
// ---------------------------------------------------------------------------

interface FileActivity {
  file: string
  batches: number
  creates: number
  updates: number
  deletes: number
  externals: number
  lastTs: number
  lastActor: string
  lastReason: string
}

interface LedgerAggregate {
  files: Map<string, FileActivity>
  kinds: Record<string, number>
  reasons: Record<string, number>
  actors: Map<string, number>
  firstTs: number
  lastTs: number
}

/**
 * Reason buckets, first match wins. Heuristic by design — the classifier only
 * feeds a distribution row, never a coordinate. `test` is checked before
 * `feat` so "add tests" lands as test; kind is checked before any pattern so
 * a rollback is never misfiled by its reason text.
 */
const REASON_BUCKETS: ReadonlyArray<readonly [string, RegExp]> = [
  ['fix', /(?:\bfix|bug\b|hotfix|修复|修正|报错|错误)/i],
  ['refactor', /(?:refactor|重构|清理|cleanup|rename|重命名|拆分|合并)/i],
  ['docs', /(?:\bdoc|文档|readme|注释)/i],
  ['test', /(?:\btest|测试|spec\b)/i],
  ['feat', /(?:\badd|新增|接入|支持|implement|实现|feat|迁移|移植)/i],
  ['chore', /(?:chore|config|配置|依赖|构建|\bbuild\b|\bdeps?\b)/i],
]

export function reasonBucket(batch: LedgerBatch): string {
  if (batch.kind === 'rollback') return 'rollback'
  if (batch.kind === 'external') return 'external'
  if (batch.kind === 'project') return 'legacy'
  for (const [bucket, pattern] of REASON_BUCKETS) {
    if (pattern.test(batch.reason)) return bucket
  }
  return 'other'
}

function aggregateBatches(batches: readonly LedgerBatch[]): LedgerAggregate {
  const files = new Map<string, FileActivity>()
  const kinds: Record<string, number> = {}
  const reasons: Record<string, number> = {}
  const actors = new Map<string, number>()
  let firstTs = Number.POSITIVE_INFINITY
  let lastTs = 0
  for (const batch of batches) {
    kinds[batch.kind] = (kinds[batch.kind] ?? 0) + 1
    reasons[reasonBucket(batch)] = (reasons[reasonBucket(batch)] ?? 0) + 1
    actors.set(batch.actor, (actors.get(batch.actor) ?? 0) + 1)
    if (batch.ts < firstTs) firstTs = batch.ts
    if (batch.ts > lastTs) lastTs = batch.ts
    const touched = new Set<string>()
    for (const node of batch.nodes) {
      let entry = files.get(node.file)
      if (entry === undefined) {
        entry = { file: node.file, batches: 0, creates: 0, updates: 0, deletes: 0, externals: 0, lastTs: 0, lastActor: '', lastReason: '' }
        files.set(node.file, entry)
      }
      if (node.op === 'create') entry.creates++
      else if (node.op === 'update') entry.updates++
      else if (node.op === 'delete') entry.deletes++
      else entry.externals++
      if (!touched.has(node.file)) {
        touched.add(node.file)
        entry.batches++
        if (batch.ts >= entry.lastTs) {
          entry.lastTs = batch.ts
          entry.lastActor = batch.actor
          entry.lastReason = batch.reason
        }
      }
    }
  }
  return { files, kinds, reasons, actors, firstTs, lastTs }
}

/** Plain code-point order: locale-aware comparison would make card bytes
 *  machine-dependent, which the determinism floor forbids. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function day(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

function clip(text: string, max = REASON_MAX): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** Count-desc, then name-asc — a stable distribution rendering. */
function distribution(record: Record<string, number>): string {
  return Object.entries(record)
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
    .map(([name, count]) => `${name} ${count}`)
    .join(', ')
}

function sortedFiles(agg: LedgerAggregate): FileActivity[] {
  return [...agg.files.values()].sort((a, b) =>
    b.batches - a.batches || b.lastTs - a.lastTs || cmp(a.file, b.file))
}

function frontmatter(card: CardName, anchor: CardAnchor, span: string): string {
  return [
    '---',
    `card: ${card}`,
    `title: ${CARD_TITLES[card]}`,
    anchorLine(anchor),
    `span: ${span}`,
    '---',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Card builders
// ---------------------------------------------------------------------------

function overviewCard(batches: readonly LedgerBatch[], agg: LedgerAggregate, anchor: CardAnchor, evidence: EvidenceSummary): string {
  const span = `${day(agg.firstTs)}..${day(agg.lastTs)}`
  return [
    frontmatter('overview', anchor, span),
    '# Project construction overview',
    '',
    `- ledger: ${anchor.batches} batches, ${agg.files.size} files touched, ${agg.actors.size} actor(s), span ${span} (UTC)`,
    `- kinds: ${distribution(agg.kinds)}`,
    `- reason mix: ${distribution(agg.reasons)}`,
    '',
    '## Hot files (top 10 by batches)',
    '',
    ...sortedFiles(agg).slice(0, 10).map((row) => `- \`${row.file}\` — ${row.batches} batches, last ${day(row.lastTs)}`),
    '',
    '## Recent batches (last 5)',
    '',
    ...batches.slice(-5).reverse().map((batch) => `- #${batch.id} ${day(batch.ts)} ${batch.kind} — ${clip(batch.reason)}`),
    '',
    ...verificationSection(evidence),
  ].join('\n')
}


/** One archived verdict as a card row, with its applicability recomputed now. */
interface EvidenceRow {
  id: string
  batch: number
  recorded: string
  effective: string
  provenance: string
  finishedAt: string
  drifted: string[]
  reason?: string
}

interface EvidenceSummary {
  /** Committed record count — the anchor's verification input. */
  records: number
  revision: number
  digest: string
  rows: EvidenceRow[]
  /** Records whose files could not be read or parsed. */
  unreadable: number
}

/**
 * Read the archived evidence and re-derive its applicability.
 *
 * Recomputed before the anchor comparison: cached cards cannot certify current
 * applicability using the record count or file timestamps.
 */
function verificationSummary(store: StorePaths): EvidenceSummary {
  const listed = listRecords(store)
  const revision = readRevision(store)
  const current = listed.records.map(record => applicabilityOf(record, store.root))
  const rows: EvidenceRow[] = current.map((now) => {
    const record = now.record
    return {
      id: record.id.slice(0, 8),
      batch: record.batchIds[0] ?? 0,
      recorded: now.verdict.status,
      effective: now.effective,
      provenance: record.provenance,
      finishedAt: record.finishedAt.replace('T', ' ').slice(0, 16),
      drifted: now.drifted,
      ...(now.reason === 'evidence_schema' ? { reason: 'older evidence format; run a fresh check' } : now.verdict.reason === undefined ? {} : { reason: now.verdict.reason }),
    }
  })
  const digest = createHash('sha256').update(JSON.stringify([
    current.map(now => [now.record.id, now.applicable, now.effective, now.drifted, now.reason]), listed.unreadable,
  ])).digest('hex').slice(0, 16)
  return { records: listed.records.length, revision: revision.revision, digest, rows, unreadable: listed.unreadable }
}

/**
 * The verification section of the overview card.
 *
 * Two columns, never one: `recorded` is history and cannot change, `now` is the
 * applicability against the tree as it stands. A reader who saw only one word
 * would be unable to tell a live pass from a stale one, which is the whole
 * failure mode M1.5 names.
 */
function verificationSection(evidence: EvidenceSummary): string[] {
  const lines: string[] = ['## Verification', '']
  if (evidence.records === 0) {
    lines.push('- no archived verification records (revision 0); no check has been recorded for this workspace')
    lines.push('')
    return lines
  }
  lines.push(`- revision ${evidence.revision}, ${evidence.records} record(s)${evidence.unreadable > 0 ? `, ${evidence.unreadable} unreadable` : ''}`)
  lines.push('')
  lines.push('| record | batch | recorded | now | provenance | when | note |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const row of evidence.rows.slice(0, 20)) {
    const note = row.drifted.length > 0
      ? `inputs changed: ${row.drifted.slice(0, 3).join(', ')}${row.drifted.length > 3 ? `, +${row.drifted.length - 3}` : ''}`
      : (row.reason ?? '')
    lines.push(`| ${row.id} | #${row.batch} | ${row.recorded} | ${row.effective} | ${row.provenance} | ${row.finishedAt} | ${clip(note)} |`)
  }
  if (evidence.rows.length > 20) lines.push('', `(${evidence.rows.length - 20} more record(s) — use ffhistory checks=true.)`)
  lines.push('')
  lines.push('`recorded` is the historical verdict and never changes; `now` is recomputed from the current file contents.')
  lines.push('')
  return lines
}

function opsLabel(row: FileActivity): string {
  const parts: string[] = []
  if (row.creates > 0) parts.push(`+${row.creates}`)
  if (row.updates > 0) parts.push(`~${row.updates}`)
  if (row.deletes > 0) parts.push(`-${row.deletes}`)
  if (row.externals > 0) parts.push(`x${row.externals}`)
  return parts.join(' ')
}

function hotspotCard(agg: LedgerAggregate, anchor: CardAnchor): string {
  const rows = sortedFiles(agg)
  const kept = rows.slice(0, HOTSPOT_ROWS)
  const lines = [
    frontmatter('hotspot', anchor, `${day(agg.firstTs)}..${day(agg.lastTs)}`),
    '# Hot files',
    '',
    `Ranked by construction batches; ops are +create ~update -delete xexternal node counts. ${rows.length} file(s) touched, showing ${kept.length}.`,
    '',
    ...kept.map((row) =>
      `- \`${row.file}\` — ${row.batches} batch(es) (${opsLabel(row)}), last ${day(row.lastTs)} by ${row.lastActor} — "${clip(row.lastReason, 100)}"`),
    ...(rows.length > kept.length ? ['', `(${rows.length - kept.length} more files below the ${HOTSPOT_ROWS}-row cap — narrow with ffhistory.)`] : []),
    '',
  ]
  return lines.join('\n')
}

function timelineCard(batches: readonly LedgerBatch[], agg: LedgerAggregate, anchor: CardAnchor): string {
  const cutoff = agg.lastTs - TIMELINE_DAYS * 86_400_000
  const window = batches.filter((batch) => batch.ts >= cutoff)
  const byDay = new Map<string, { batches: number; files: Set<string>; reasons: string[] }>()
  for (const batch of window) {
    const key = day(batch.ts)
    let entry = byDay.get(key)
    if (entry === undefined) {
      entry = { batches: 0, files: new Set<string>(), reasons: [] }
      byDay.set(key, entry)
    }
    entry.batches++
    for (const node of batch.nodes) entry.files.add(node.file)
    const reason = clip(batch.reason, 100)
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason)
  }
  const days = [...byDay.entries()].sort((a, b) => cmp(b[0], a[0]))
  const lines = [
    frontmatter('timeline', anchor, `${day(Math.max(cutoff, agg.firstTs))}..${day(agg.lastTs)}`),
    '# Recent construction (last 14 days of activity)',
    '',
    `Ledger spans ${day(agg.firstTs)}..${day(agg.lastTs)}; this card covers the most recent ${TIMELINE_DAYS} days — ${window.length} batch(es), ${new Set(window.flatMap((b) => b.nodes.map((n) => n.file))).size} file(s).`,
    '',
    ...days.flatMap(([key, entry]) => [
      `## ${key} — ${entry.batches} batch(es), ${entry.files.size} file(s)`,
      '',
      `- ${entry.reasons.slice(0, 8).map((reason) => `"${reason}"`).join(' / ')}`,
      '',
    ]),
  ]
  if (days.length === 0) lines.push('(no batches in the window)', '')
  return lines.join('\n')
}

interface StructureFile {
  abs: string
  rel: string
}

/** Files the structure card covers, most recently constructed first — also the
 *  anchor's freshness input. Ledger rel paths are forward-slash; disk paths are
 *  the host's. */
function structureCandidates(root: string, batches: readonly LedgerBatch[]): { files: StructureFile[]; missing: number; unsupported: number } {
  const seen = new Set<string>()
  const recent: string[] = []
  for (let i = batches.length - 1; i >= 0 && recent.length < STRUCTURE_BATCH_WINDOW * 4; i--) {
    for (const node of batches[i].nodes) {
      if (!seen.has(node.file)) {
        seen.add(node.file)
        recent.push(node.file)
      }
    }
  }
  const files: StructureFile[] = []
  let missing = 0
  let unsupported = 0
  for (const rel of recent) {
    if (files.length >= STRUCTURE_FILES) break
    const abs = path.join(root, ...rel.split('/'))
    let stat
    try {
      stat = statSync(abs)
    } catch {
      missing++
      continue
    }
    if (!stat.isFile() || detectLanguage(abs) === null) {
      unsupported++
      continue
    }
    files.push({ abs, rel })
  }
  return { files, missing, unsupported }
}

/** Bounded content digest of the structure card's covered files. */
function digestFiles(files: readonly StructureFile[]): string {
  if (files.length === 0) return 'none'
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => cmp(a.rel, b.rel))) {
    try {
      const content = createHash('sha256').update(readBoundedFile(file.abs, MAX_AST_FILE_BYTES)).digest('hex')
      hash.update(`${file.rel}:${content}\n`)
    } catch {
      hash.update(`${file.rel}:gone\n`)
    }
  }
  return hash.digest('hex').slice(0, 16)
}

async function structureCard(root: string, picked: { files: StructureFile[]; missing: number; unsupported: number }, anchor: CardAnchor): Promise<string> {
  const lines = [
    frontmatter('structure', anchor, 'current disk content'),
    '# Symbol skeleton — recently constructed files',
    '',
    `Top-level declarations (depth ${STRUCTURE_DEPTH}) of the files the last ${STRUCTURE_BATCH_WINDOW} batches touched, parsed from current disk content (content-anchored). Caps: ${STRUCTURE_FILES} files, ${STRUCTURE_SYMBOLS_PER_FILE} symbols per file.`,
    '',
  ]
  const skipped: string[] = []
  for (const file of picked.files) {
    const parsed = await parseFile(file.abs)
    if (parsed.error !== undefined || parsed.value === undefined) {
      skipped.push(`${file.rel}: ${parsed.error ?? 'unreadable'}`)
      continue
    }
    const view = outlineView(parsed.value.symbols, { depth: STRUCTURE_DEPTH }).slice(0, STRUCTURE_SYMBOLS_PER_FILE)
    lines.push(`## ${file.rel}`, '')
    if (view.length === 0) lines.push('(no declarations found)', '')
    else {
      for (const sym of view) {
        lines.push(`${'  '.repeat(sym.level - 1)}- ${sym.qualifiedName} (${sym.kind}) L${sym.startLine}-${sym.endLine}`)
      }
      lines.push('')
    }
  }
  if (picked.files.length === 0) lines.push('(no AST-supported files among the recently constructed ones)', '')
  const notes: string[] = []
  if (picked.missing > 0) notes.push(`${picked.missing} file(s) no longer on disk`)
  if (picked.unsupported > 0) notes.push(`${picked.unsupported} file(s) outside the AST languages`)
  if (skipped.length > 0) notes.push(`unparsed: ${skipped.join('; ')}`)
  if (notes.length > 0) lines.push(`(${notes.join('; ')})`, '')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Build + serve
// ---------------------------------------------------------------------------

export interface BuiltCard {
  name: CardName
  title: string
  batches: number
  md: string
}

export interface BuiltCards {
  anchor: CardAnchor
  cards: BuiltCard[]
}

/** Content reads and applicability checks are required; no AST parse. */
function anchorFor(batches: readonly LedgerBatch[], picked: { files: StructureFile[] }, evidence: EvidenceSummary): CardAnchor {
  return {
    batches: batches.length,
    lastId: batches[batches.length - 1]?.id ?? 0,
    files: digestFiles(picked.files),
    verification: evidence.revision,
    applicability: evidence.digest,
  }
}

/** Pure ledger-to-cards compilation. Same ledger (and same covered-file
 *  contents and verification evidence) → byte-identical cards. */
export async function buildCards(store: StorePaths): Promise<BuiltCards | ToolFailure> {
  const batches = readLedgerTail(store, Number.MAX_SAFE_INTEGER)
  if (batches.length === 0) return failure('no construction ledger batches for this workspace')
  const agg = aggregateBatches(batches)
  const picked = structureCandidates(store.root, batches)
  const evidence = verificationSummary(store)
  const anchor = anchorFor(batches, picked, evidence)
  return {
    anchor,
    cards: [
      { name: 'overview', title: CARD_TITLES.overview, batches: anchor.batches, md: overviewCard(batches, agg, anchor, evidence) },
      { name: 'hotspot', title: CARD_TITLES.hotspot, batches: anchor.batches, md: hotspotCard(agg, anchor) },
      { name: 'timeline', title: CARD_TITLES.timeline, batches: anchor.batches, md: timelineCard(batches, agg, anchor) },
      { name: 'structure', title: CARD_TITLES.structure, batches: anchor.batches, md: await structureCard(store.root, picked, anchor) },
    ],
  }
}

function readCardsState(dir: string): CardsStateFile | null {
  const file = path.join(dir, 'state.json')
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as CardsStateFile
    if (parsed?.version === 1 && parsed.anchor !== null && typeof parsed.anchor === 'object'
      && Number.isSafeInteger(parsed.anchor.batches) && Number.isSafeInteger(parsed.anchor.lastId)
      && typeof parsed.anchor.files === 'string' && Number.isSafeInteger(parsed.anchor.verification)
      && typeof parsed.anchor.applicability === 'string' && Array.isArray(parsed.cards)
      && parsed.cards.every((card) => typeof card?.name === 'string' && typeof card?.title === 'string'
        && Number.isSafeInteger(card?.batches) && Number.isSafeInteger(card?.bytes))) {
      return parsed
    }
  } catch {
    // corrupted cache state — rebuild from the ledger
  }
  return null
}

function anchorsEqual(a: CardAnchor, b: CardAnchor): boolean {
  return a.batches === b.batches && a.lastId === b.lastId && a.files === b.files
    && a.verification === b.verification && a.applicability === b.applicability
}

function anchorLine(anchor: CardAnchor): string {
  return `anchor: batches=${anchor.batches} lastId=${anchor.lastId} files=${anchor.files} verification=${anchor.verification} applicability=${anchor.applicability}`
}

function filesComplete(dir: string, state: CardsStateFile): boolean {
  return state.cards.every((card) => existsSync(path.join(dir, `${card.name}.md`)))
}

// ---------------------------------------------------------------------------
// Polished drafts (stage 2)
// ---------------------------------------------------------------------------

/** A polished draft lives beside its skeleton as `<name>.polished.md`, with
 *  the anchor embedded in its own frontmatter — a draft is self-describing,
 *  so validity is one read, no state bookkeeping. */
export function polishedFileFor(dir: string, name: string): string {
  return path.join(dir, `${name}.polished.md`)
}

/** Store a validated polished draft. The plugin owns the frontmatter: the
 *  draft content is body markdown only (the gate rejects embedded frontmatter). */
export function storePolished(dir: string, name: CardName, anchor: CardAnchor, content: string, distilledBy: string): void {
  mkdirSync(dir, { recursive: true })
  const md = [
    '---',
    `card: ${name}`,
    `title: ${CARD_TITLES[name]} (polished)`,
    anchorLine(anchor),
    `distilled-by: ${distilledBy}`,
    '---',
    '',
    content.endsWith('\n') ? content : `${content}\n`,
  ].join('\n')
  atomicWrite(polishedFileFor(dir, name), md)
}

function stripFrontmatter(text: string): string | null {
  if (!text.startsWith('---\n')) return null
  const end = text.indexOf('\n---\n', 4)
  if (end === -1) return null
  // storePolished joins the closing fence and the body with exactly one
  // separator newline — stripping exactly that byte reconstructs the stored
  // content byte-for-byte, even when the draft itself begins with a blank line.
  return text.slice(end + 5).replace(/^\n/, '')
}

/** The draft's body when it exists AND is anchored to exactly `anchor`;
 *  null means "skeleton only" (absent, unparsable, or stale). */
export function readPolished(dir: string, name: string, anchor: CardAnchor): string | null {
  const file = polishedFileFor(dir, name)
  if (!existsSync(file)) return null
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const match = /^anchor: batches=(\d+) lastId=(\d+) files=(\S+) verification=(\d+) applicability=(\S+)$/m.exec(text.slice(0, 512))
  if (match === null) return null
  if (!anchorsEqual({ batches: Number(match[1]), lastId: Number(match[2]), files: match[3], verification: Number(match[4]), applicability: match[5] }, anchor)) return null
  return stripFrontmatter(text)
}

/** Polished drafts are cache, not artifact (the D0 decision): any anchor move
 *  discards every draft. There is no protection to reimplement — the skeleton
 *  regenerates and the next distillation starts from facts. */
function dropPolished(dir: string): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.endsWith('.polished.md')) continue
    try {
      rmSync(path.join(dir, entry), { force: true })
    } catch {
      // best-effort; an orphan draft is invisible to readPolished anyway
    }
  }
}

/** The facts a polished draft is gated against — every file the ledger ever
 *  touched, and the last batch id. Built from the ledger's cached view. */
export function polishFacts(store: StorePaths): PolishFacts {
  const files = new Set<string>()
  const batchIds = new Set<number>()
  let lastBatchId = 0
  for (const batch of readLedgerTail(store, Number.MAX_SAFE_INTEGER)) {
    batchIds.add(batch.id)
    for (const node of batch.nodes) files.add(node.file)
    lastBatchId = Math.max(lastBatchId, batch.id)
  }
  return { files, batchIds, lastBatchId }
}

// ---------------------------------------------------------------------------
// Read-count feedback (the second loop: usage → which card is worth distilling)
// ---------------------------------------------------------------------------

export interface CardReadStat {
  count: number
  lastAt: number
}

export type CardReadStats = Record<string, CardReadStat>

interface ReadsFile {
  version: 1
  reads: CardReadStats
}

function readsFileFor(dir: string): string {
  return path.join(dir, 'reads.json')
}

function readCardReads(dir: string): CardReadStats {
  const file = readsFileFor(dir)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ReadsFile
    if (parsed?.version === 1 && parsed.reads !== null && typeof parsed.reads === 'object') return parsed.reads
  } catch {
    // corrupted stats — restart from zero; usage counts are advisory
  }
  return {}
}

/** Record one served card body (polished or skeleton). Deliberately survives
 *  rebuilds and polish drops: usage is history about the reader, not derived
 *  from the ledger, and it is exactly what the distill offer and /forge-status
 *  read back. Advisory only — a lost or zeroed file costs nothing but a nudge. */
export async function recordCardRead(dir: string, name: string): Promise<void> {
  if (!(CARD_NAMES as readonly string[]).includes(name)) return
  await withFileLock(readsFileFor(dir), () => {
    const reads = readCardReads(dir)
    const stat = reads[name] ?? { count: 0, lastAt: 0 }
    reads[name] = { count: stat.count + 1, lastAt: Date.now() }
    atomicWrite(readsFileFor(dir), JSON.stringify({ version: 1, reads }, null, 2))
  })
}

/** The suggested distill target: the most-read card still awaiting polish. */
export function suggestedDistillTarget(reads: CardReadStats, unpolished: readonly string[]): string | null {
  let best: string | null = null
  let bestCount = 0
  for (const name of unpolished) {
    const count = reads[name]?.count ?? 0
    if (count > bestCount || (count === bestCount && count > 0 && best !== null && name < best)) {
      best = name
      bestCount = count
    }
  }
  return bestCount > 0 ? best : null
}

// ---------------------------------------------------------------------------
// Read-only status (for /forge-status — never rebuilds, never parses)
// ---------------------------------------------------------------------------

export interface CardsStatus {
  root: string
  dir: string
  anchor: CardAnchor | null
  cards: CardInfo[]
  polished: string[]
  reads: CardReadStats
  fresh: boolean
}

/** The cards state of one workspace WITHOUT side effects: no rebuild, no AST
 *  parse, no anchor-triggered work. `/forge-status` runs this on the hot path,
 *  so "stale" is reported, never repaired here. Null when the workspace has no
 *  ledger (and therefore no cards). */
export function cardsStatusFor(workspaceRoot: string): CardsStatus | null {
  let store: StorePaths
  try {
    store = storeFor(workspaceRoot)
  } catch {
    return null
  }
  const dir = path.join(dataDir(), 'cards', path.basename(store.dir))
  if (!existsSync(store.ledgerFile)) return null
  const state = readCardsState(dir)
  if (state === null) return { root: store.root, dir, anchor: null, cards: [], polished: [], reads: readCardReads(dir), fresh: false }
  const anchor = currentAnchor(store)
  return {
    root: store.root,
    dir,
    anchor: anchor ?? null,
    cards: state.cards,
    polished: anchor !== undefined && anchorsEqual(state.anchor, anchor) ? polishedNames(dir, anchor, state.cards) : [],
    reads: readCardReads(dir),
    fresh: anchor !== undefined && anchorsEqual(state.anchor, anchor),
  }
}

/**
 * Ensure the cards for a workspace are current, regenerating from the ledger
 * when the anchor moved. Deterministic regeneration is cheap (no model calls),
 * so the freshness check and the rebuild both run inline on demand — no
 * background timer, and nothing here can spend money silently (stage-2 model
 * polish must keep that property).
 *
 * @param workspaceRoot - the session workspace (resolved + alias-matched like
 *   the ledger store).
 * @param opts.refresh - rebuild even when the anchor says current.
 */
export async function ensureCards(workspaceRoot: string, opts: { refresh?: boolean } = {}): Promise<CardsResult | ToolFailure> {
  let store: StorePaths
  try {
    store = storeFor(workspaceRoot)
  } catch (cause) {
    return failure(`cannot resolve the ledger store: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const dir = path.join(dataDir(), 'cards', path.basename(store.dir))
  const emptyNote = 'no construction ledger for this workspace — cards appear after the first ffedit/ff_file write'
  if (!existsSync(store.ledgerFile)) {
    return { root: store.root, dir, cards: [], regenerated: [], polished: [], reads: {}, empty: true, note: emptyNote }
  }
  const state = readCardsState(dir)
  const rebuild = opts.refresh === true || state === null || !filesComplete(dir, state)
  let anchor: CardAnchor | undefined
  if (!rebuild) {
    anchor = currentAnchor(store)
    if (anchor === undefined) return { root: store.root, dir, cards: [], regenerated: [], polished: [], reads: {}, empty: true, note: emptyNote }
    if (anchorsEqual(state!.anchor, anchor)) {
      return { root: store.root, dir, anchor, cards: state!.cards, regenerated: [], polished: polishedNames(dir, anchor, state!.cards), reads: readCardReads(dir) }
    }
  }
  return await withFileLock(path.join(dir, 'state.json'), async (): Promise<CardsResult | ToolFailure> => {
    // Double-check inside the lock: a concurrent call may have just rebuilt.
    const latest = readCardsState(dir)
    if (latest !== null && latest.anchor !== undefined) {
      const now = currentAnchor(store)
      if (now !== undefined && anchorsEqual(latest.anchor, now) && filesComplete(dir, latest) && opts.refresh !== true) {
        return { root: store.root, dir, anchor: now, cards: latest.cards, regenerated: [], polished: polishedNames(dir, now, latest.cards), reads: readCardReads(dir) }
      }
    }
    const built = await buildCards(store)
    if ('error' in built) return built
    mkdirSync(dir, { recursive: true })
    // The anchor moved: every polished draft was gated against the OLD facts,
    // so all of them are discarded with it — cache semantics, no protection.
    dropPolished(dir)
    for (const card of built.cards) {
      atomicWrite(path.join(dir, `${card.name}.md`), card.md)
    }
    const cards: CardInfo[] = built.cards.map((card) => ({
      name: card.name, title: card.title, batches: card.batches, bytes: Buffer.byteLength(card.md, 'utf8'),
    }))
    // state.json is written last: it is the commit marker that says the .md
    // siblings next to it are a complete, anchor-consistent set.
    const stateFile: CardsStateFile = {
      version: 1,
      generatedAt: new Date().toISOString(),
      anchor: built.anchor,
      cards,
    }
    atomicWrite(path.join(dir, 'state.json'), JSON.stringify(stateFile, null, 2))
    return {
      root: store.root, dir, anchor: built.anchor, cards,
      regenerated: built.cards.map((card) => card.name),
      polished: [],
      reads: readCardReads(dir),
    }
  })
}

/** Cards whose polished draft is present and anchored to exactly this anchor. */
function polishedNames(dir: string, anchor: CardAnchor, cards: readonly CardInfo[]): string[] {
  return cards.filter((card) => readPolished(dir, card.name, anchor) !== null).map((card) => card.name)
}

/** Current anchor from the ledger's cached view — no parsing, no card build.
 *  Undefined when there is nothing to anchor (no batches). */
function currentAnchor(store: StorePaths): CardAnchor | undefined {
  const batches = readLedgerTail(store, Number.MAX_SAFE_INTEGER)
  if (batches.length === 0) return undefined
  return anchorFor(batches, structureCandidates(store.root, batches), verificationSummary(store))
}
