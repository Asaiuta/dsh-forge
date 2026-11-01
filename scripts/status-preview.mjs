/**
 * Print the `/forge-status` ledger and ticket section from this machine's real
 * forge data, with no running DSH and no write anywhere.
 *
 * It opens the existing stores under `DSH_FORGE_DATA_DIR` (default
 * `~/.dsh/forge`) and prints exactly what the command appends, which is how to
 * check the section's shape after touching `src/status.ts`. Import is from the
 * built `lib/`, so run `pnpm build` first — the TS source is not loadable here.
 *
 * @module dsh-forge/scripts/status-preview
 */

import { appendLedgerStatus } from '../lib/status.js'

const lines = []
appendLedgerStatus(lines)
console.log(lines.join('\n'))
