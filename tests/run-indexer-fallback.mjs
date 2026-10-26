// The sidecar's silent-empty rule.
//
// The Rust indexer answers per-file read failures by parsing nothing and still
// reporting `ok`, so `findSymbols` comes back as `items: [], parsed: 0`. Read as
// a normal answer that means "this symbol does not exist anywhere", which ends
// the search — and the caller never reaches the WASM path that would have found
// it. Observed on a real machine: a `Mandatory Label\Low Mandatory Level` on the
// binary starts a LOW process, and No-Write-Up then denies every read of an
// ordinary source file (`OS Error 5`); `ff_read view=definitions` returned
// "scanned 0 code files in 1033ms (rust sidecar)" on a repo full of the symbol.
//
// So the contract pinned here: `null` means "the sidecar did not search", and
// only a reply that actually parsed something may be reported as an answer.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findDefinitions } from '../lib/tools-symbol.js'

const { indexerFindSymbols, indexerFindSymbolsRoot, indexerReady, resetIndexer, setIndexerTransportForTest } = await import(
  new URL('../lib/indexer-client.js', import.meta.url).href
)

let passed = 0
const ok = (name) => console.log(`ok ${++passed} - ${name}`)
const previousIndexer = process.env.DSH_FORGE_INDEXER
process.env.DSH_FORGE_INDEXER = '1'

/** Install a transport that answers one method and fails the rest. */
const answer = (method, reply) => setIndexerTransportForTest(async (called) => {
  if (called !== method) throw new Error(`unexpected ${called}`)
  return reply
})

// --- findSymbols -----------------------------------------------------------
{
  answer('findSymbols', { ok: true, items: [], parsed: 0, reparsed: 5 })
  assert.equal(
    await indexerFindSymbols(['/w/a.ts', '/w/b.ts'], 'createReadTool', null),
    null,
    'a sidecar that parsed none of the files it was handed must report unavailability',
  )
  ok('every file failing to parse is unavailability, not an empty result')
}
{
  // The control that makes the rule safe: a genuine miss on a parsed corpus
  // stays an answer, so the WASM fallback is not paid for nothing.
  answer('findSymbols', { ok: true, items: [], parsed: 3, reparsed: 0 })
  const reply = await indexerFindSymbols(['/w/a.ts'], 'noSuchSymbol', null)
  assert.deepEqual(reply, { items: [], parsed: 3, reparsed: 0 })
  ok('a real miss on a parsed corpus is still an answer')
}
{
  // Nothing to scan is not a failure either: the caller filtered the list down
  // to zero supported files and should not be sent down the fallback path.
  answer('findSymbols', { ok: true, items: [], parsed: 0, reparsed: 0 })
  assert.deepEqual(await indexerFindSymbols([], 'x', null), { items: [], parsed: 0, reparsed: 0 })
  ok('an empty file list is not a read failure')
}
{
  setIndexerTransportForTest(async () => { throw new Error('indexer unavailable') })
  assert.equal(await indexerFindSymbols(['/w/a.ts'], 'x', null), null)
  ok('a transport error still reports unavailability')
}

// --- request budgets and cancellation --------------------------------------
{
  let sent = 0
  setIndexerTransportForTest(async () => { sent++; return new Promise(() => {}) })
  assert.equal(await indexerFindSymbols(['/w/a.ts'], 'x', null, { deadline: Date.now() - 1 }), null)
  assert.equal(sent, 0, 'an exhausted budget must not send more work')
  assert.equal(await indexerFindSymbols(['/w/a.ts'], 'x', null, { deadline: Date.now() + 20 }), null)
  const controller = new AbortController()
  const query = indexerFindSymbols(['/w/a.ts'], 'x', null, { signal: controller.signal })
  const cancelled = assert.rejects(query, /cancel-native-query/)
  controller.abort(new Error('cancel-native-query'))
  await cancelled
  assert.equal(sent, 1, 'cancelling before dispatch must not send another request')
  answer('findSymbols', { ok: true, items: [], parsed: 1 })
  assert.ok(await indexerFindSymbols(['/w/a.ts'], 'x', null))
  ok('native request waits respect the caller budget and abort without poisoning later calls')
}

{
  let sent = 0, release
  setIndexerTransportForTest(async method => {
    assert.equal(method, 'ping')
    sent++
    return new Promise(resolve => { release = resolve })
  })
  assert.equal(await indexerReady({ deadline: Date.now() - 1 }), false)
  assert.equal(sent, 0)
  const controller = new AbortController()
  const first = indexerReady({ signal: controller.signal })
  const second = indexerReady()
  const rejected = assert.rejects(first, /cancel-readiness/)
  await Promise.resolve()
  controller.abort(new Error('cancel-readiness'))
  await rejected
  assert.equal(await indexerReady({ deadline: Date.now() + 20 }), false)
  release({ ok: true })
  assert.equal(await second, true)
  assert.equal(await indexerReady(), true)
  assert.equal(sent, 1, 'caller cancellation/budgets must not cancel or duplicate the shared ping')
  ok('readiness waits honour caller cancellation and budgets while sharing one ping')
}
{
  let started, release
  const pingStarted = new Promise(resolve => { started = resolve })
  setIndexerTransportForTest(async method => {
    assert.equal(method, 'ping')
    started()
    return new Promise(resolve => { release = resolve })
  })
  const controller = new AbortController()
  const query = findDefinitions({ signal: controller.signal }, { name: 'request', path: fileURLToPath(new URL('../src/indexer-client.ts', import.meta.url)) })
  const rejected = assert.rejects(query, /cancel-definitions-readiness/)
  await pingStarted
  controller.abort(new Error('cancel-definitions-readiness'))
  await rejected
  release({ ok: true })
  assert.equal(await indexerReady(), true)
  ok('definitions pass their cancellation through the initial readiness wait')
}

// --- findSymbolsRoot --------------------------------------------------------
{
  // `reparsed` is what separates "walked files and parsed none" from "a tree
  // with no code in it": the sidecar reparsed 5470 files and produced 0.
  answer('findSymbolsRoot', { ok: true, allSupported: true, items: [], parsed: 0, reparsed: 9 })
  assert.equal(await indexerFindSymbolsRoot('/w', 'createReadTool', null), null)
  ok('a root walk that reparsed files but parsed none is unavailability')
}
{
  answer('findSymbolsRoot', { ok: true, allSupported: true, items: [], parsed: 0, reparsed: 0 })
  assert.deepEqual(await indexerFindSymbolsRoot('/empty', 'x', null), { allSupported: true, items: [], parsed: 0 })
  ok('a tree with no code files stays a real empty answer')
}

setIndexerTransportForTest(null)
if (previousIndexer === undefined) delete process.env.DSH_FORGE_INDEXER
else process.env.DSH_FORGE_INDEXER = previousIndexer
{
  // Node without arguments reads stdin as JavaScript, rejects the JSON-lines
  // protocol and closes its pipe while the parent is still writing. Exercise
  // the actual stream error event in a child so an unhandled EPIPE is visible.
  const client = new URL('../lib/indexer-client.js', import.meta.url).href
  const source = fileURLToPath(new URL('../src/indexer-client.ts', import.meta.url))
  const script = `const {indexerFindSymbols}=await import(${JSON.stringify(client)}); process.stdout.write(JSON.stringify(await indexerFindSymbols(Array(10000).fill(${JSON.stringify(source)}), 'x', null, {deadline:Date.now()+2000})))`
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, DSH_FORGE_INDEXER_BIN: process.execPath }, encoding: 'utf8', timeout: 5000, windowsHide: true,
  })
  assert.equal(run.status, 0, run.error?.message ?? run.stderr)
  assert.equal(run.stdout, 'null')
  ok('a helper that closes stdin falls back without crashing the host on a pipe error')
}
if (await indexerReady()) {
  for (let i = 0; i < 4; i++) {
    await resetIndexer()
    assert.equal(await indexerReady(), true, 'old process exit must not disable its successor')
  }
  await resetIndexer()
  ok('actual sidecar survives immediate reset/restart without stale exit events')
} else console.log('native reset/restart: optional sidecar unavailable — SKIPPED')

console.log(`\n${passed} indexer-fallback groups passed`)
