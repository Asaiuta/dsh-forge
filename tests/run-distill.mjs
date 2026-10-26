// Card distillation (sedimentation stage 2): the hallucination gate, the
// polished-draft cache (store / serve / drop on anchor move), the session
// roundtrip (directive → polish write → gate), and the endpoint path with a
// stubbed fetch transport — including its skeleton fallback.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

const dataRoot = mkdtempSync(path.join(tmpdir(), 'forge-distill-'))
process.env.DSH_FORGE_DATA_DIR = dataRoot

const { recordBatch, storeFor } = await import(new URL('../lib/ledger.js', import.meta.url).href)
const { ensureCards, storePolished, readPolished, polishFacts, CARD_NAMES } = await import(new URL('../lib/cards.js', import.meta.url).href)
const { createCardsTool } = await import(new URL('../lib/tools-cards.js', import.meta.url).href)
const { validatePolish, stripWrappingFence, polishViaEndpoint, setDistillFetchForTest } = await import(new URL('../lib/distill.js', import.meta.url).href)
const { resolveConfig } = await import(new URL('../lib/config.js', import.meta.url).href)

let passed = 0
function ok(label) { passed++; console.log(`  ok ${passed} - ${label}`) }

// --- fixtures ---------------------------------------------------------------

const work = path.join(dataRoot, 'ws')
mkdirSync(path.join(work, 'src'), { recursive: true })
const calcSource = 'export function add(a: number, b: number): number {\n  return a + b\n}\n'
const calcPath = path.join(work, 'src', 'calc.ts')
writeFileSync(calcPath, calcSource)
const store = storeFor(work)
const sha = createHash('sha256').update(calcSource, 'utf8').digest('hex')
recordBatch(store, { kind: 'edit', reason: 'add calc module 新增', actor: 'sess_a', nodes: [{ file: 'src/calc.ts', op: 'create', before: null, after: sha, bytes: calcSource.length, eol: 'LF', bom: false }] })
recordBatch(store, { kind: 'edit', reason: 'fix 修复 add 边界', actor: 'sess_a', nodes: [{ file: 'src/calc.ts', op: 'update', before: sha, after: sha, bytes: calcSource.length, eol: 'LF', bom: false }] })

const exec = { agent: { session: { header: { cwd: work, id: 'distill-test-session' } }, options: { model: 'test-model' } } }
const off = { distill: 'off' }
const session = { distill: 'session' }

const GOOD_DRAFT = '# Overview\n\nThe workspace has 2 batches so far, all on `src/calc.ts` (#1 created it, #2 fixed its edge case).\n'

// --- config ------------------------------------------------------------------

{
  assert.equal(resolveConfig(undefined).cards.distill, 'session', 'distill defaults to the current session model')
  assert.throws(() => resolveConfig({ cards: { distill: 'endpoint' } }), /needs config\.cards\.endpoint/, 'endpoint mode without an endpoint is a config error')
  assert.throws(() => resolveConfig({ cards: { distill: 'endpoint', endpoint: { baseUrl: 'http://x', model: 'm' } } }), /no key/, 'endpoint without any key is a config error')
  const resolved = resolveConfig({ cards: { distill: 'endpoint', endpoint: { baseUrl: 'http://x/v1/', model: 'm', apiKey: 'k' } } })
  assert.equal(resolved.cards.endpoint.baseUrl, 'http://x/v1', 'trailing slashes are stripped')
  ok('cards config resolves: session default, endpoint validated, off legal')
}

// --- hallucination gate --------------------------------------------------------

{
  const facts = polishFacts(store)
  assert.deepEqual(validatePolish(GOOD_DRAFT, facts), [], 'a faithful draft passes')
  assert.match(validatePolish('see `src/ghost.ts` for details', facts)[0], /not in this workspace's ledger/, 'an invented path is named')
  assert.match(validatePolish('batch #999 did the thing', facts)[0], /not in this workspace's ledger.*last id 2/, 'a future batch id is named')
  assert.match(validatePolish('batch #0 did the thing', facts)[0], /not in this workspace's ledger/, 'zero is not a batch')
  assert.match(validatePolish('batch #1 did the thing', { ...facts, batchIds: new Set([2]) })[0], /not in this workspace's ledger/, 'a missing recovered batch is not accepted')
  assert.deepEqual(validatePolish('src/ghost.ts deletes 999 accounts each day', facts), [], 'prose is deliberately unchecked; callers must see a model-draft label')
  assert.match(validatePolish('---\ncard: overview\n---\nbody', facts)[0], /frontmatter/, 'embedded frontmatter is refused')
  assert.match(validatePolish('   ', facts)[0], /empty/)
  assert.match(validatePolish('x'.repeat(33 * 1024), facts)[0], /polish cap/)
  assert.deepEqual(validatePolish('plain prose, `ff_cards`, `TODO`, no paths', facts), [], 'symbols and non-path tokens are not gated')
  ok('hallucination gate: paths and batch ids checked, wording free')
}

// --- polished-draft cache ------------------------------------------------------

{
  await ensureCards(work)
  const result = await ensureCards(work)
  const anchor = result.anchor
  assert.deepEqual(result.polished, [], 'no drafts at first')
  storePolished(result.dir, 'overview', anchor, GOOD_DRAFT, 'session:test-model')
  assert.equal(readPolished(result.dir, 'overview', anchor), GOOD_DRAFT, 'the draft is served at its own anchor')
  assert.equal(readPolished(result.dir, 'overview', { ...anchor, lastId: anchor.lastId + 1 }), null, 'a moved anchor refuses the draft')
  const after = await ensureCards(work)
  assert.deepEqual(after.polished, ['overview'], 'ensureCards reports the polished set')
  ok('polished draft cache: anchored store and serve')
}

// --- session roundtrip ----------------------------------------------------------

{
  const tool = createCardsTool(session)
  await tool.execute({ refresh: true }, exec) // clear the draft the cache block stored
  const listed = await tool.execute({}, exec)
  assert.match(listed.note ?? '', /await distillation/, 'the list offers distillation while skeletons are unpolished')
  assert.equal(listed.cards.find((c) => c.name === 'overview').polished, false)
  ok('list flags unpolished skeletons and offers the roundtrip')

  const read = await tool.execute({ card: 'overview' }, exec)
  assert.match(read.note ?? '', /polish: "overview"/, 'the read directive names the exact polish call')
  assert.ok(read.body.startsWith('---'), 'an unpolished read serves the skeleton with frontmatter')
  ok('read of a skeleton carries the polish directive')

  const rejected = await tool.execute({ polish: 'overview', content: 'mentions `src/ghost.ts` here' }, exec)
  assert.match(rejected.error, /ledger gate/, 'an inventing draft is rejected with the violation named')

  const stored = await tool.execute({ polish: 'overview', content: GOOD_DRAFT }, exec)
  assert.match(stored.note ?? '', /stored polished "overview"/)
  const reread = await tool.execute({ card: 'overview' }, exec)
  assert.equal(reread.body, GOOD_DRAFT, 'the polished body is served over the skeleton')
  assert.equal(reread.source, 'model')
  assert.match(reread.note, /factual claims unchecked/)
  const source = await tool.execute({ card: 'overview', skeleton: true }, exec)
  assert.equal(source.source, 'ledger')
  assert.ok(source.body.startsWith('---'), 'the deterministic source remains accessible beside a draft')
  assert.match(reread.note ?? '', /polished draft served/, 'serving a distilled card is announced')
  const relisted = await tool.execute({}, exec)
  assert.equal(relisted.cards.find((c) => c.name === 'overview').polished, true, 'the list marks the polished card')
  assert.match(relisted.note ?? '', /3 skeleton\(s\) await distillation/, 'the offer counts only the remaining skeletons')
  ok('session roundtrip: directive → polish write → gate → serve')

  const offTool = createCardsTool(off)
  const refused = await offTool.execute({ polish: 'overview', content: GOOD_DRAFT }, exec)
  assert.match(refused.error, /distill: "off"/, 'off mode refuses polish writes')
  const offRead = await offTool.execute({ card: 'overview' }, exec)
  assert.equal(offRead.body, GOOD_DRAFT, 'off mode still serves the stored draft')
  ok('off mode refuses writes, keeps serving')
}

// --- anchor move drops drafts ---------------------------------------------------

{
  recordBatch(store, { kind: 'edit', reason: 'docs 注释补齐', actor: 'sess_b', nodes: [{ file: 'src/calc.ts', op: 'update', before: sha, after: sha, bytes: calcSource.length, eol: 'LF', bom: false }] })
  const result = await ensureCards(work)
  assert.deepEqual(result.polished, [], 'the anchor moved: drafts are cache, discarded with the old facts')
  const read = await createCardsTool(session).execute({ card: 'overview' }, exec)
  assert.ok(read.body.startsWith('---'), 'the skeleton is back')
  ok('anchor move discards polished drafts (cache semantics, no protection)')
}

// --- endpoint path (stubbed transport) ------------------------------------------

{
  const endpoint = { baseUrl: 'http://distill.test/v1', model: 'polisher-1', apiKeyEnv: 'OPENAI_API_KEY', apiKey: 'k', timeoutMs: 2_000 }
  const tool = createCardsTool({ distill: 'endpoint', endpoint })
  assert.match(tool.description, /may call the configured model endpoint/)
  assert.ok(!tool.description.includes('no model calls'))

  let requested = null
  setDistillFetchForTest(async (url, init) => {
    requested = { url, body: JSON.parse(init.body) }
    return new Response(JSON.stringify({ choices: [{ message: { content: GOOD_DRAFT } }] }), { status: 200 })
  })
  const sourceOnly = await tool.execute({ card: 'overview', skeleton: true }, exec)
  assert.equal(sourceOnly.source, 'ledger')
  assert.equal(requested, null, 'reading the source must never spend an endpoint request')
  const polished = await tool.execute({ card: 'overview' }, exec)
  assert.match(polished.note ?? '', /polished via endpoint polisher-1/)
  assert.equal(polished.body, GOOD_DRAFT)
  assert.equal(requested.url, 'http://distill.test/v1/chat/completions')
  assert.equal(requested.body.model, 'polisher-1')
  assert.match(requested.body.messages[0].content, /skeleton card/)
  ok('endpoint mode polishes inline on read')

  setDistillFetchForTest(async () => {
    return new Response(JSON.stringify({ choices: [{ message: { content: 'invents `src/ghost.ts` badly' } }] }), { status: 200 })
  })
  const gated = await createCardsTool({ distill: 'endpoint', endpoint }).execute({ card: 'hotspot' }, exec)
  assert.match(gated.note ?? '', /endpoint polish failed.*ledger gate/)
  assert.ok(gated.body.startsWith('---'), 'a gated draft falls back to the skeleton')
  ok('endpoint draft that invents a file is gated, skeleton served')

  setDistillFetchForTest(async () => { throw new Error('connection refused') })
  const failed = await createCardsTool({ distill: 'endpoint', endpoint }).execute({ card: 'timeline' }, exec)
  assert.match(failed.note ?? '', /endpoint polish failed.*connection refused/)
  assert.ok(failed.body.startsWith('---'))
  ok('endpoint failure names the reason and falls back')

  setDistillFetchForTest(undefined)
  const listed = await tool.execute({}, exec)
  assert.ok(!/polish/.test(listed.note ?? ''), 'the list never triggers endpoint fetches')
  ok('list stays fetch-free in endpoint mode')
}

// Environment-backed credentials are validated by config and must also reach
// the actual request. Keeping this separate from the inline-key case catches a
// config that passes while silently sending an unauthenticated POST.
{
  const envName = 'DSH_FORGE_DISTILL_TEST_KEY'
  const previous = process.env[envName]
  process.env[envName] = 'env-secret'
  let headers
  try {
    setDistillFetchForTest(async (_url, init) => {
      headers = new Headers(init.headers)
      return new Response(JSON.stringify({ choices: [{ message: { content: GOOD_DRAFT } }] }), { status: 200 })
    })
    const { cards: { endpoint } } = resolveConfig({ cards: { distill: 'endpoint', endpoint: {
      baseUrl: 'http://distill.test/v1', model: 'env-model', apiKeyEnv: envName, timeoutMs: 2_000,
    } } })
    assert.equal(endpoint.apiKey, undefined, 'the environment secret stays out of the resolved config')
    await polishViaEndpoint(endpoint, 'skeleton', undefined)
    assert.equal(headers.get('authorization'), 'Bearer env-secret', 'apiKeyEnv must provide the Authorization header')
    await polishViaEndpoint({ ...endpoint, apiKey: 'inline-secret' }, 'skeleton', undefined)
    assert.equal(headers.get('authorization'), 'Bearer inline-secret', 'an inline key takes precedence over apiKeyEnv')
    ok('endpoint mode sends an environment-backed API key and honours inline precedence')
  } finally {
    if (previous === undefined) delete process.env[envName]
    else process.env[envName] = previous
    setDistillFetchForTest(undefined)
  }
}

// --- fence stripping --------------------------------------------------------------

{
  assert.equal(stripWrappingFence('```markdown\nbody\n```'), 'body')
  assert.equal(stripWrappingFence('plain'), 'plain')
  assert.equal(stripWrappingFence('```\ncode with ``` inside\n````'), '```\ncode with ``` inside\n````')
  ok('wrapping fence stripped; inner fences preserved')
}

// --- stage 3: read-count feedback + status ----------------------------------------

{
  const { suggestedDistillTarget, cardsStatusFor } = await import(new URL('../lib/cards.js', import.meta.url).href)
  const { FinderPool } = await import(new URL('../lib/core.js', import.meta.url).href)
  const { createStatusCommand } = await import(new URL('../lib/tools.js', import.meta.url).href)

  // suggestedDistillTarget: most-read unpolished wins; zero reads → null.
  assert.equal(suggestedDistillTarget({ overview: { count: 3, lastAt: 1 } }, ['overview', 'hotspot']), 'overview')
  assert.equal(suggestedDistillTarget({}, ['overview']), null)
  assert.equal(suggestedDistillTarget({ overview: { count: 2, lastAt: 1 }, hotspot: { count: 5, lastAt: 2 } }, ['overview', 'hotspot']), 'hotspot')
  assert.equal(suggestedDistillTarget({ overview: { count: 4, lastAt: 1 } }, ['hotspot']), null, 'a polished card is never suggested')
  ok('suggestedDistillTarget picks the most-read unpolished card')

  const offTool = createCardsTool(off)
  await offTool.execute({ refresh: true }, exec) // clean slate; drafts dropped, reads kept from earlier blocks
  const served = await offTool.execute({ card: 'timeline' }, exec)
  assert.equal(served.card, 'timeline')

  // Reads survive a full rebuild: usage is reader history, not ledger-derived.
  await ensureCards(work, { refresh: true })
  const status = cardsStatusFor(work)
  assert.equal(status.fresh, true, 'a fresh rebuild reports fresh')
  assert.equal(status.reads.timeline.count >= 1, true, 'the read count survived the rebuild')
  ok('read counts survive rebuilds and land in the status query')

  const listed = await createCardsTool(session).execute({}, exec)
  const timelineRow = listed.cards.find((card) => card.name === 'timeline')
  assert.equal(timelineRow.reads >= 1, true, 'the list carries the read count')
  const unpolished = listed.cards.filter((card) => !card.polished).map((card) => card.name)
  const target = suggestedDistillTarget(listed.cards.reduce((acc, card) => {
    if (card.reads > 0) acc[card.name] = { count: card.reads, lastAt: 0 }
    return acc
  }, {}), unpolished)
  if (target !== null) assert.match(listed.note ?? '', new RegExp(`"${target}" is the most-read`), 'the offer names the most-read skeleton')
  ok('list reads flow into the distill offer')

  // The status command line: read-only, names anchor freshness + reads.
  const statusCommand = createStatusCommand(new FinderPool())
  const report = await statusCommand.handler({ rawInput: '', agent: exec.agent, signal: undefined })
  assert.match(report.text, /知识卡片/, 'the status report carries the cards line')
  assert.match(report.text, /timeline \d+次/, 'the status line carries read counts')
  assert.match(report.text, new RegExp(`润色 \\d+/${CARD_NAMES.length}`))
  ok('/forge-status reports card anchor, polish and reads without rebuilding')

  // stale anchor is reported, not repaired
  const now = Date.now() + 9000
  utimesSync(calcPath, new Date(now), new Date(now))
  const stale = cardsStatusFor(work)
  assert.equal(stale.fresh, false, 'an externally touched file marks the anchor stale in the status view')
  assert.equal(existsSync(readsFileSafe(stale.dir)), true, 'reads.json still sits beside the cards')
  ok('status query reports staleness without repairing it')
}

console.log(`run-distill: ${passed} checks across gate/cache/session/endpoint/feedback — OK`)

function readsFileSafe(dir) {
  return path.join(dir, 'reads.json')
}
