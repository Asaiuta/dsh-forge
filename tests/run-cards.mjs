// Knowledge cards (sedimentation stage 1): deterministic ledger distillation,
// the freshness anchor, and the ff_cards surface. Runs against a REAL ledger
// store built through recordBatch — the same append path ffedit commits
// through — redirected to a temp data dir via DSH_FORGE_DATA_DIR, so the
// anchor and the alias resolution are exercised the way production sees them.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

const dataRoot = mkdtempSync(path.join(tmpdir(), 'forge-cards-'))
process.env.DSH_FORGE_DATA_DIR = dataRoot

const { recordBatch, storeFor } = await import(new URL('../lib/ledger.js', import.meta.url).href)
const { ensureCards, CARD_NAMES } = await import(new URL('../lib/cards.js', import.meta.url).href)
const { createCardsTool } = await import(new URL('../lib/tools-cards.js', import.meta.url).href)

let passed = 0
function ok(label) { passed++; console.log(`  ok ${passed} - ${label}`) }

// --- fixtures ---------------------------------------------------------------

function editBatch(store, reason, actor, file, op, content) {
  const bytes = Buffer.from(content, 'utf8')
  const sha = createHash('sha256').update(bytes).digest('hex')
  return recordBatch(store, {
    kind: 'edit', reason, actor,
    nodes: [{ file, op, before: op === 'create' ? null : sha, after: op === 'delete' ? null : sha, bytes: op === 'delete' ? 0 : bytes.length, eol: 'LF', bom: false }],
  })
}

const work = path.join(dataRoot, 'ws')
mkdirSync(path.join(work, 'src'), { recursive: true })
const calcPath = path.join(work, 'src', 'calc.ts')
const calcSource = 'export function add(a: number, b: number): number {\n  return a + b\n}\nexport function sub(a: number, b: number): number {\n  return a - b\n}\n'
writeFileSync(calcPath, calcSource)
writeFileSync(path.join(work, 'README.md'), '# readme\n')

const store = storeFor(work)
const exec = { agent: { session: { header: { cwd: work, id: 'cards-test' } } } }
const cardBytes = (name) => readFileSync(path.join(dataRoot, 'cards', path.basename(store.dir), `${name}.md`), 'utf8')

// --- empty workspace ---------------------------------------------------------

{
  const empty = mkdtempSync(path.join(tmpdir(), 'forge-cards-empty-'))
  const result = await ensureCards(empty)
  assert.equal(result.empty, true, 'a workspace without a ledger reports empty')
  assert.equal(result.cards.length, 0)
  assert.match(result.note ?? '', /no construction ledger/)
  ok('empty workspace reports empty with the after-first-write note')
}

// --- first build -------------------------------------------------------------

editBatch(store, 'add calc module 新增', 'sess_a', 'src/calc.ts', 'create', calcSource)
editBatch(store, 'fix 修复 sub 溢出', 'sess_a', 'src/calc.ts', 'update', calcSource)
editBatch(store, 'docs 注释补齐', 'sess_b', 'README.md', 'update', '# readme\n')

{
  const result = await ensureCards(work)
  assert.equal(result.empty, undefined)
  assert.deepEqual(result.regenerated.sort(), ['hotspot', 'overview', 'structure', 'timeline'], 'first build regenerates every card')
  assert.deepEqual(result.cards.map((c) => c.name).sort(), [...CARD_NAMES].sort())
  const stateFile = path.join(dataRoot, 'cards', path.basename(store.dir), 'state.json')
  assert.ok(existsSync(stateFile), 'state.json is the commit marker')
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(state.version, 1)
  assert.equal(state.anchor.batches, 3, 'anchor pins the ledger length')
  assert.equal(state.anchor.lastId, 3, 'anchor pins the last batch id')
  assert.notEqual(state.anchor.files, 'none', 'a structure-backed anchor carries a file digest')
  ok('first build produces four cards and a complete anchor')
}

// --- freshness: a second call must not rebuild --------------------------------

{
  const result = await ensureCards(work)
  assert.deepEqual(result.regenerated, [], 'a fresh anchor must not rebuild')
  ok('fresh anchor serves the cache without rebuilding')
}

// --- determinism: same ledger → byte-identical cards --------------------------

{
  const before = Object.fromEntries(CARD_NAMES.map((name) => [name, cardBytes(name)]))
  const result = await ensureCards(work, { refresh: true })
  assert.equal(result.regenerated.length, 4, 'refresh forces a full rebuild')
  for (const name of CARD_NAMES) {
    assert.equal(cardBytes(name), before[name], `${name} bytes are ledger-determined`)
  }
  ok('refresh rebuild is byte-identical to the first build (determinism floor)')
}

// --- anchor move: new batch → auto rebuild, content follows -------------------

{
  editBatch(store, 'fix 修复 add 负数边界', 'sess_b', 'src/calc.ts', 'update', calcSource)
  const result = await ensureCards(work)
  assert.equal(result.regenerated.length, 4, 'an appended batch moves the anchor and rebuilds')
  const overview = cardBytes('overview')
  assert.match(overview, /fix 修复 add 负数边界/, 'the new reason appears in the overview')
  assert.match(overview, /external 0|kinds: edit 4/, 'kind counts reflect the ledger')
  assert.ok(!overview.includes('generatedAt'), 'card bytes carry no wall-clock timestamp')
  const hotspot = cardBytes('hotspot')
  assert.match(hotspot, /src\/calc\.ts/, 'hotspot ranks the touched file')
  assert.match(hotspot, /sess_b/, 'hotspot carries the last actor')
  ok('anchor move on append rebuilds and the content follows the ledger')
}

// --- external batches are ledger history too ----------------------------------

{
  const bytes = Buffer.from(calcSource, 'utf8')
  recordBatch(store, {
    kind: 'external',
    reason: 'external modification detected before edit (hash mismatch vs ledger)',
    actor: 'system:external',
    nodes: [{ file: 'src/calc.ts', op: 'external', before: null, after: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, eol: 'LF', bom: false }],
  })
  const result = await ensureCards(work)
  assert.equal(result.regenerated.length, 4)
  const overview = cardBytes('overview')
  assert.match(overview, /external 1/, 'the external batch is counted as its own kind')
  ok('external batches are classified, not hidden')
}

// --- structure card: AST skeleton of constructed files -------------------------

{
  const structure = cardBytes('structure')
  assert.match(structure, /## src\/calc\.ts/, 'the constructed file heads a section')
  assert.match(structure, /add \(function\) L1-3/, 'top-level symbols with line ranges')
  assert.match(structure, /sub \(function\) L4-6/)
  assert.match(structure, /outside the AST languages/, 'unsupported files are noted, not silently dropped')
  ok('structure card carries the AST skeleton of recent construction')
}

// --- anchor move: external edit to a covered file (no ledger append) ----------

{
  const freshState = JSON.parse(readFileSync(path.join(dataRoot, 'cards', path.basename(store.dir), 'state.json'), 'utf8'))
  await ensureCards(work)
  const now = Date.now() + 5000
  utimesSync(calcPath, new Date(now), new Date(now))
  assert.equal((await ensureCards(work)).regenerated.length, 0, 'unchanged content keeps its identity despite a timestamp change')
  writeFileSync(calcPath, readFileSync(calcPath, 'utf8') + '\n// external content edit\n')
  const result = await ensureCards(work)
  assert.equal(result.regenerated.length, 4, 'changed content on a covered file must invalidate the anchor')
  const state = JSON.parse(readFileSync(path.join(dataRoot, 'cards', path.basename(store.dir), 'state.json'), 'utf8'))
  assert.notEqual(state.anchor.files, freshState.anchor.files, 'the file digest moved')
  ok('external file edit moves the file digest and rebuilds without a ledger append')
}

// --- ff_cards tool -------------------------------------------------------------

{
  // distill: 'off' keeps this suite about the stage-1 surface — the polish
  // flows and their notes have their own suite (run-distill.mjs).
  const tool = createCardsTool({ distill: 'off' })
  const listed = await tool.execute({}, exec)
  assert.equal(listed.cards.length, 4)
  assert.equal(listed.note, undefined, 'a quiet list carries no note')
  const rendered = tool.output.render({}, listed)
  assert.match(rendered[0].text, /- overview — /)
  assert.match(rendered[0].text, /- structure — /)
  ok('ff_cards lists the card directory')

  const read = await tool.execute({ card: 'hotspot' }, exec)
  assert.equal(read.card, 'hotspot')
  assert.match(read.body, /# Hot files/)
  const readRender = tool.output.render({ card: 'hotspot' }, read)
  assert.match(readRender[0].text, /#### card hotspot/)
  ok('ff_cards reads one card body')

  const unknown = await tool.execute({ card: 'nope' }, exec)
  assert.match(unknown.error, /unknown card "nope"/)
  ok('an unknown card names the valid set')

  const refreshed = await tool.execute({ refresh: true }, exec)
  assert.equal(refreshed.cards.length, 4)
  ok('refresh passes through to a full rebuild')
}

// --- verification evidence on the overview card ---------------------------------

{
  const { appendRecord, newRecordId, VERIFICATION_SCHEMA } = await import(new URL('../lib/verification.js', import.meta.url).href)
  const { createHash } = await import('node:crypto')
  const hashOf = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

  const evidenceStore = storeFor(work)
  const beforeAnchor = (await ensureCards(work)).anchor
  assert.equal(beforeAnchor.verification, 0, 'a workspace with no records anchors at zero')

  // One archived pass covering calc.ts as it is right now.
  await appendRecord(evidenceStore, work, {
    schema: VERIFICATION_SCHEMA,
    id: newRecordId(),
    workspaceId: 'ws',
    batchIds: [1],
    afterHashes: [{ file: 'src/calc.ts', hash: hashOf(calcPath) }],
    checks: [{ id: 'bridge', kind: 'bridge', status: 'passed', coverage: { files: 1 }, findings: [] }],
    requiredChecks: ['bridge'],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    provenance: 'internal-static',
  })

  // A new check with NO new ledger batch must still move the cards.
  const afterEvidence = await ensureCards(work)
  assert.equal(afterEvidence.anchor.verification, 1)
  assert.equal(afterEvidence.anchor.lastId, beforeAnchor.lastId, 'no code batch was appended')
  assert.ok(afterEvidence.regenerated.includes('overview'), 'the overview must refresh for new evidence alone')

  const overview = readFileSync(path.join(afterEvidence.dir, 'overview.md'), 'utf8')
  assert.match(overview, /## Verification/)
  assert.match(overview, /revision 1, 1 record\(s\)/)
  assert.match(overview, /\| record \| batch \| recorded \| now \| provenance \| when \| note \|/)
  assert.match(overview, /\| [0-9a-f]{8} \| #1 \| passed \| passed \| internal-static \|/)
  assert.match(overview, /`recorded` is the historical verdict and never changes/)
  ok('a new check with no new code batch refreshes the overview and shows recorded vs now')

  // Same record, different content: recorded stays passed, now becomes stale.
  writeFileSync(calcPath, calcSource.replace('a + b', 'a + b + 0'))
  const stale = await ensureCards(work)
  const staleCard = readFileSync(path.join(stale.dir, 'overview.md'), 'utf8')
  assert.match(staleCard, /\| [0-9a-f]{8} \| #1 \| passed \| stale \| internal-static \|/)
  assert.match(staleCard, /inputs changed: src\/calc\.ts/)
  ok('a changed input turns the current column stale while the recorded column stays passed')
}
{
  const { appendRecord, newRecordId, VERIFICATION_SCHEMA } = await import(new URL('../lib/verification.js', import.meta.url).href)
  const evidenceStore = storeFor(work)
  // An external claim of a pass must not appear as an automatic pass.
  await appendRecord(evidenceStore, work, {
    schema: VERIFICATION_SCHEMA,
    id: newRecordId(),
    workspaceId: 'ws',
    batchIds: [1],
    afterHashes: [],
    checks: [{ id: 'tests', kind: 'tests', status: 'passed', coverage: { files: 0 }, findings: [] }],
    requiredChecks: ['tests'],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    provenance: 'external-report',
  })
  const built = await ensureCards(work)
  const card = readFileSync(path.join(built.dir, 'overview.md'), 'utf8')
  assert.match(card, /external-report/, 'an external report is labelled as such')
  // The claim is listed, and the recorded column shows what it actually
  // demonstrated: nothing. A report is not a check.
  const externalRow = card.split('\n').find((line) => line.includes('external-report'))
  assert.ok(externalRow !== undefined)
  assert.match(externalRow, /\| not_run \|/, 'an external claim is recorded as not_run in the recorded column')
  assert.ok(!/\| tests-passed \|/.test(card))
  ok('an externally supplied pass is shown as external-report and recorded not_run')
}

// --- signal + workspace resolution ---------------------------------------------

{
  const tool = createCardsTool()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => tool.execute({}, { agent: exec.agent, signal: controller.signal }),
    /abort/i,
    'an aborted execution must stop before touching the ledger',
  )
  ok('aborted signal refuses the call')
}

console.log(`run-cards: ${passed} checks across ${CARD_NAMES.length} cards — OK`)
