/**
 * Cold-scan helper for the ProjectForge comparison: fresh process, walks a
 * directory and parseFile()s every code file exactly the way the definitions view
 * does (sequential, content-anchored cache cold), then prints the timing.
 *
 * Usage: node tests/lib/cold-scan.mjs <rootDir>
 */

import { readdirSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseFile } from '../../lib/ast.js'

const root = process.argv[2]
if (!root) {
  console.error('usage: node cold-scan.mjs <rootDir>')
  process.exit(1)
}

const IGNORE = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', '__pycache__', '.next'])
let files = 0

async function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!IGNORE.has(e.name)) await walk(abs)
    } else if (/\.(js|mjs|cjs|jsx|ts|tsx|py|rs|go)$/.test(e.name)) {
      files++
      await parseFile(abs)
    }
  }
}

const start = performance.now()
await walk(root)
const elapsed = performance.now() - start
console.log(JSON.stringify({ files, elapsedMs: Math.round(elapsed) }))
process.exit(0)
