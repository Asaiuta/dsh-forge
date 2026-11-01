import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveBatches } from '../src/check-static.ts'
import { storeFor } from '../src/ledger.ts'
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verification-history-'))
process.env.DSH_FORGE_DATA_DIR = path.join(temp, 'data')
try {
  const store = storeFor(temp)
  fs.mkdirSync(store.dir, { recursive: true })
  const batches = Array.from({ length: 4002 }, (_, index) => ({ t: 'b', id: index + 1, ts: Date.now(), kind: 'edit', reason: 'fixture', actor: 'test', nodes: [] }))
  fs.writeFileSync(store.ledgerFile, batches.map(batch => JSON.stringify(batch)).join('\n') + '\n')
  const oldest = resolveBatches(store, [1])
  assert.equal(oldest.ok, true, oldest.detail)
  assert.equal(oldest.batches[0].id, 1)
  assert.equal(resolveBatches(store, []).batches[0].id, 4002)
  assert.equal(resolveBatches(store, [4003]).ok, false)
  console.log('3 historical verification contracts passed; 0 failed')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
