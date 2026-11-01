/**
 * Freshness: an empty page must be proven empty, not assumed empty.
 *
 * The fff watcher demonstrably loses events (a file created inside the workspace
 * stayed invisible to `fileSearch` for the whole 2.5 s probe window while
 * `scanFiles()` listed it at once), so both search paths check the disk first:
 * `fffind` by looking the name up, `ffgrep` by asking whether anything appeared
 * under the root since the last scan.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { walkNewerThan } from '../lib/absence.js'
import { createFindTool, createGrepTool } from '../lib/tools.js'

const ok = (msg) => console.log(`  ok  ${msg}`)
const HERE = import.meta.dirname
const DIR = path.join(HERE, '.fixture', '.freshness')

fs.rmSync(DIR, { recursive: true, force: true })
fs.mkdirSync(path.join(DIR, 'src'), { recursive: true })
fs.writeFileSync(path.join(DIR, 'src', 'old.ts'), 'export const old = 1\n')

// --- walkNewerThan: directory mtimes vs a reference instant ------------------
{
  const future = walkNewerThan(DIR, Date.now() + 60_000)
  assert.deepEqual(future.newer, [], 'nothing can be newer than the future')

  const past = walkNewerThan(DIR, Date.now() - 60_000)
  assert.ok(past.newer.includes('src'), `the freshly created dir must count as new: ${JSON.stringify(past.newer)}`)

  // `node_modules` churn says nothing about the caller's own files.
  fs.mkdirSync(path.join(DIR, 'node_modules'), { recursive: true })
  const withModules = walkNewerThan(DIR, Date.now() - 60_000)
  assert.ok(!withModules.newer.includes('node_modules'), 'node_modules is not evidence of staleness')
  fs.rmSync(path.join(DIR, 'node_modules'), { recursive: true, force: true })
  ok('walkNewerThan reports changed directories, ignores node_modules')
}

// --- ffgrep: an empty page on a stale index is rebuilt and retried -----------
{
  let stale = true
  let rescans = 0
  const hit = {
    relativePath: 'src/old.ts', lineNumber: 1, col: 14,
    lineContent: 'export const zzFreshNeedle = 1', gitStatus: '', totalFrecencyScore: 0,
  }
  const empty = { items: [], totalFilesSearched: 1, filteredFileCount: 1, nextCursor: null }
  const lease = {
    basePath: DIR, warming: false, aux: true, scannedAt: 0,
    finder: {
      isDestroyed: false,
      isScanning: () => false,
      grep: () => ({ ok: true, value: stale ? empty : { ...empty, items: [hit], totalFilesSearched: 1 } }),
      glob: () => ({ ok: true, value: { items: [] } }),
      fileSearch: () => ({ ok: true, value: { items: [], scores: [], totalMatched: 0 } }),
    },
  }
  const pool = {
    main: async () => lease,
    aux: async () => lease,
    rescan: async () => { rescans++; stale = false; lease.scannedAt = Date.now(); return true },
  }
  const grep = createGrepTool(pool)
  const out = await grep.execute({ pattern: 'zzFreshNeedle' }, undefined)
  assert.equal(rescans, 1, 'a changed directory must trigger one rebuild')
  assert.equal(out.items.length, 1, 'the retry after the rebuild must answer')
  assert.equal(out.note, undefined, 'a rebuilt page is an answer, not a miss')
  ok('ffgrep rebuilds a stale index and answers from the retry')
}

// --- ffgrep: a truly absent pattern pays no rebuild --------------------------
{
  let rescans = 0
  const empty = { items: [], totalFilesSearched: 1, filteredFileCount: 1, nextCursor: null }
  const lease = {
    // Nothing has changed since the scan, so the walk finds no evidence.
    basePath: DIR, warming: false, aux: true, scannedAt: Date.now() + 60_000,
    finder: {
      isDestroyed: false,
      isScanning: () => false,
      grep: () => ({ ok: true, value: empty }),
      glob: () => ({ ok: true, value: { items: [] } }),
      fileSearch: () => ({ ok: true, value: { items: [], scores: [], totalMatched: 0 } }),
    },
  }
  const pool = { main: async () => lease, aux: async () => lease, rescan: async () => { rescans++; return true } }
  const grep = createGrepTool(pool)
  const out = await grep.execute({ pattern: 'zzNothingHere' }, undefined)
  assert.equal(rescans, 0, 'a fresh index must not be rebuilt for an absent pattern')
  assert.equal(out.items.length, 0)
  ok('ffgrep leaves a fresh index alone')
}

// --- fffind: name evidence, not directory evidence --------------------------
{
  let rescans = 0
  const lease = {
    basePath: DIR, warming: false, aux: true, scannedAt: 0,
    finder: {
      isDestroyed: false,
      isScanning: () => false,
      fileSearch: () => ({ ok: true, value: { items: [], scores: [], totalMatched: 0 } }),
      glob: () => ({ ok: true, value: { items: [] } }),
      grep: () => ({ ok: true, value: { items: [], totalFilesSearched: 0, filteredFileCount: 0, nextCursor: null } }),
    },
  }
  const pool = { main: async () => lease, aux: async () => lease, rescan: async () => { rescans++; return true } }
  const find = createFindTool(pool, { globalSearch: async () => ({ status: 'miss' }) })
  // `src` is a directory on disk: name search reports files, so this is not
  // evidence that the index is behind.
  await find.execute({ pattern: 'src' }, undefined)
  assert.equal(rescans, 0, 'a directory hit must not trigger a rebuild')
  ok('fffind does not rebuild on a directory hit')
}

fs.rmSync(DIR, { recursive: true, force: true })
console.log('index-freshness: all checks passed')
