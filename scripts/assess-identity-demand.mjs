/**
 * Identity-migration demand assessment (review A.3): measure whether agents
 * actually re-address symbols ACROSS sessions, from real usage data.
 *
 * Evidence sources (all read-only):
 *   1. forge ledger stores (~/.dsh/forge/<workspace>/ledger*) — every real
 *      edit session leaves batches; repeated (path#symbol) edits across
 *      DIFFERENT session ids would be the demand signal.
 *   2. fff query history (~/.dsh/forge/fff/history) — repeated queries are
 *      retrieval demand, not symbol-identity demand; reported for context.
 *
 * Verdict rule: rename-migration (content-hash identity layer) is built only
 * when cross-session symbol re-addressing shows up in the ledger. No ledger
 * data → verdict "no evidence yet, keep deferred" — re-run this script as
 * usage accumulates.
 *
 * @module dsh-forge/scripts/assess-identity-demand
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const forgeDir = process.env.DSH_FORGE_DATA_DIR?.trim() || path.join(os.homedir(), '.dsh', 'forge')

if (!existsSync(forgeDir)) {
  console.log(`no forge data dir at ${forgeDir} — nothing to assess`)
  process.exit(0)
}

// 1. Ledger stores: real edit sessions.
const entries = readdirSync(forgeDir, { withFileTypes: true })
const ledgerDirs = entries.filter((e) => e.isDirectory() && e.name !== 'fff' && e.name !== 'crash')
  .map((e) => path.join(forgeDir, e.name))
  .filter((d) => existsSync(path.join(d, 'workspace.json')) || existsSync(path.join(d, 'ledger.jsonl')))
const ledgerBytes = ledgerDirs.reduce((s, d) => {
  try { return s + statSync(path.join(d, 'workspace.json')).size } catch { return s }
}, 0)

console.log(`forge data dir : ${forgeDir}`)
console.log(`ledger stores  : ${ledgerDirs.length}${ledgerDirs.length ? ` (${ledgerDirs.map((d) => path.basename(d)).join(', ')})` : ' — no real edit sessions recorded'}`)
if (ledgerDirs.length) {
  for (const d of ledgerDirs) {
    console.log(`  ${path.basename(d)}: workspace.json ${statSync(path.join(d, 'workspace.json')).size}B`)
  }
  console.log('next step: mine ledger batches for (path, symbol-bearing reason) repeats across session ids')
} else {
  console.log('cross-session symbol re-addressing: NO EVIDENCE YET')
  console.log('verdict: rename-migration (content-hash identity) stays DEFERRED — revisit when ledger sessions accumulate')
}

// 2. fff history: retrieval demand (context only).
const fffDir = path.join(forgeDir, 'fff')
if (existsSync(fffDir)) {
  const size = (d) => { try { return statSync(path.join(fffDir, d, 'data.mdb')).size } catch { return 0 } }
  console.log(`fff history    : frecency ${size('frecency')}B, query history ${size('history')}B (retrieval demand, not identity demand)`)
}
