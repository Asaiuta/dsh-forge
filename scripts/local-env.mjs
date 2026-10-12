/**
 * Loads machine-local paths from a gitignored `.env` at the repository root.
 *
 * Only the test chain and the maintenance scripts need this — the plugin itself
 * takes no machine-local configuration. Copy `.env.example` to `.env` and fill
 * in the paths that apply to your machine.
 *
 * Real environment variables always win; `.env` only fills the gaps.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = path.join(root, '.env')

if (existsSync(file)) {
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw)
    if (!match) continue
    if (process.env[match[1]] !== undefined) continue
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2')
    if (value) process.env[match[1]] = value
  }
}

/**
 * Read a local setting. Returns `undefined` when unset and not required.
 * `required` exits with a pointer to `.env.example` rather than failing later
 * with a confusing path error.
 */
export function localEnv(name, { required = false } = {}) {
  const value = process.env[name]?.trim()
  if (value) return value
  if (required) {
    console.error(`${name} is not set. Copy .env.example to .env and fill it in.`)
    process.exit(1)
  }
  return undefined
}
