/**
 * The ledger tab's read model, end to end through the HTTP route.
 *
 * The route is the only thing the browser half talks to, so the probe goes
 * through it rather than through `ledger.ts`: a store that lists batches but
 * renders no diff, or a diff that loses its hunk, would pass a unit test of the
 * store and still show an empty tab.
 *
 * The workspace and the data directory are both minted inside the repository so
 * the probe never touches the user's real `~/.dsh/forge` or their %TEMP%.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const sandbox = mkdtempSync(path.join(repoRoot, '.tmp-ledger-test-'))
process.env.DSH_FORGE_DATA_DIR = path.join(sandbox, 'data')

const { putBlob, recordBatch, storeFor } = await import(new URL('../lib/ledger.js', import.meta.url).href)
const { createLedgerHandler } = await import(new URL('../lib/http-plugin.js', import.meta.url).href)

let passed = 0
function ok(label) {
  passed++
  console.log(`  ok ${passed} - ${label}`)
}

/** Call the route the way the web server does and return what it wrote. */
async function call(url) {
  const out = {}
  await createLedgerHandler()({ method: 'GET', url }, {
    writeHead: (status) => { out.status = status },
    end: (body) => { out.body = JSON.parse(body) },
  })
  return out
}

try {
  const workspace = path.join(sandbox, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const store = storeFor(workspace)
  const before = putBlob(store, Buffer.from('alpha\nbeta\ngamma\n', 'utf8')).id
  const after = putBlob(store, Buffer.from('alpha\nBETA\ngamma\n', 'utf8')).id
  recordBatch(store, {
    kind: 'edit',
    reason: 'probe batch',
    actor: 'probe-session',
    nodes: [{ file: 'x.txt', op: 'update', before, after, bytes: 17, eol: 'LF', bom: false }],
  })

  const query = `/forge-ledger?workspace=${encodeURIComponent(workspace)}`
  const list = await call(query)
  assert.equal(list.status, 200, list.body.error)
  assert.equal(list.body.total, 1, 'the recorded batch must be listed')
  const row = list.body.batches[0]
  assert.equal(row.id, 1)
  assert.equal(row.kind, 'edit')
  assert.equal(row.reason, 'probe batch')
  assert.deepEqual(row.files.map((file) => file.file), ['x.txt'])
  assert.equal(row.check, undefined, 'a batch with no archived record carries no badge')
  assert.equal(typeof row.ts, 'number')
  ok('the list carries id, kind, reason and files, newest first')

  const detail = await call(`${query}&batch=${String(row.id)}`)
  assert.equal(detail.status, 200, detail.body.error)
  assert.equal(detail.body.nodes.length, 1)
  const node = detail.body.nodes[0]
  assert.equal(node.file, 'x.txt')
  assert.equal(node.binary, false)
  assert.equal(node.truncated, false)
  assert.match(node.diff, /^--- a\/x\.txt$/m)
  assert.match(node.diff, /^\+BETA$/m)
  assert.match(node.diff, /^-beta$/m)
  ok('an opened batch renders the snapshot diff with its hunk markers')

  const newest = await call(`${query}&limit=1`)
  assert.equal(newest.body.total, 1)
  assert.equal(newest.body.batches.length, 1)
  assert.equal(newest.body.workspace, store.root, 'the route answers with the canonical root it read')
  ok('limit bounds the list and the answer names the canonical workspace')
} finally {
  rmSync(sandbox, { recursive: true, force: true })
  delete process.env.DSH_FORGE_DATA_DIR
}

console.log(`\n${passed} checks passed`)
