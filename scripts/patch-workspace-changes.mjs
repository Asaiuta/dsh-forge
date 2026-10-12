// Idempotent adapter patch: teaches dsh-workspace-changes' mutationPath()
// about forge's mutating tools, so ffedit/ff_file writes get the same
// pre-execute turn captures as first-party file tools. This is the only seam
// that makes forge edits visible in the existing workspace-changes UI for
// non-Git workspaces, Gitignored files, and paths outside the repository —
// inside Git repos the turn numstat already covers every tool's changes.
//
// Re-run after every DSH app update (the patch lives in first-party code):
//   node scripts/patch-workspace-changes.mjs          # apply
//   node scripts/patch-workspace-changes.mjs --restore  # restore backup
// Target install must be given: DSH_APP_DIR (see .env.example) or argv[2].
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { localEnv } from './local-env.mjs'

const restore = process.argv.includes('--restore')
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const appDir = localEnv('DSH_APP_DIR') ?? positional[0]
if (!appDir) {
  console.error('patch-workspace-changes: pass the DSH app dir as argv[2] or set DSH_APP_DIR in .env')
  process.exit(1)
}
const target = resolve(appDir, 'node_modules/@deepseek-ai/dsh-workspace-changes/lib/index.js')
const backup = `${target}.pre-forge.bak`

if (!existsSync(target)) {
  console.error(`patch-workspace-changes: target not found: ${target}`)
  process.exit(1)
}

if (restore) {
  if (!existsSync(backup)) { console.error(`no backup to restore: ${backup}`); process.exit(1) }
  copyFileSync(backup, target)
  console.log(`restored ${target}`)
  process.exit(0)
}

const source = readFileSync(target, 'utf8')
if (source.includes('case "ffedit":')) {
  console.log('already patched — nothing to do')
  process.exit(0)
}

const anchor = 'case "str_replace_editor": return record.command === "create" || record.command === "str_replace" || record.command === "insert" ? text(record.path) : void 0;'
if (!source.includes(anchor)) {
  console.error('anchor not found — the installed dsh-workspace-changes has changed; re-derive the patch')
  process.exit(1)
}

// ffedit: one file per call, mutating only when steps are present.
// ff_file: every action mutates `path` (move/copy also touch `destination`,
// whose before-state stays covered by forge's own snapshot ledger and, in
// Git repos, by numstat).
const patch = anchor + `
		case "ffedit": return typeof record.steps !== "undefined" ? text(record.path) : void 0;
		case "ff_file": return text(record.path);`

copyFileSync(target, backup)
writeFileSync(target, source.replace(anchor, patch))
console.log(`patched ${target} (backup at ${backup})`)
console.log('note: DSH app updates overwrite this file — re-run this script after updates.')
