/**
 * The taken-over `glob` falls back to the built-in walk when the index is blind.
 *
 * The index holds no `.gitignore`d path and no `node_modules` — exactly the two
 * things the built-in `glob` advertises ("including hidden and ignored files").
 * Before this fallback existed, a model that asked for a build artefact got an
 * empty page and no signal that the answer was wrong; the description warned
 * about it, but a description is not a verification.
 *
 * What is pinned here:
 *
 *  1. An index miss delegates, and the answer says the disk supplied it.
 *  2. An index hit does **not** delegate — one extra rg per glob call would be
 *     paid on every ordinary lookup.
 *  3. A host without the built-in keeps its own answer instead of failing.
 *  4. A `path` that is itself a glob goes straight to the built-in (it is an
 *     error there, and re-rooting the index onto it would answer a different
 *     question).
 *  5. A failed or empty disk answer never turns into a fake result.
 */

import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FinderPool } from '../lib/core.js'
import { createFindTool } from '../lib/tools.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROBE_DIR = path.join(HERE, '.glob-delegate-probe')

let passed = 0
function ok(label) {
  passed++
  console.log(`  ok ${passed} - ${label}`)
}

/** A tree with one indexed file and one the index is told to ignore. */
function buildProbeTree() {
  rmSync(PROBE_DIR, { recursive: true, force: true })
  mkdirSync(path.join(PROBE_DIR, 'ignored'), { recursive: true })
  writeFileSync(path.join(PROBE_DIR, '.gitignore'), 'ignored/\n')
  writeFileSync(path.join(PROBE_DIR, 'ignored', 'out.js'), 'export const built = 1\n')
  writeFileSync(path.join(PROBE_DIR, 'kept.ts'), 'export const kept = 2\n')
}

/** A delegate that records every call and answers with a fixed value. */
function fakeDelegate(answer, { available = true } = {}) {
  const calls = []
  return {
    calls,
    available: () => available,
    async run(name, args) {
      calls.push({ name, args })
      return typeof answer === 'function' ? answer(name, args) : answer
    },
  }
}

const pool = new FinderPool()
const exec = { agent: { session: { header: { cwd: PROBE_DIR } } } }

async function run(tool, args) {
  const value = await tool.execute(args, exec)
  assert.ok(value !== undefined && typeof value === 'object', `execute returned ${value}`)
  return value
}

const diskAnswer = { ok: true, value: { root: '.', paths: ['ignored/out.js'] } }

async function main() {
  buildProbeTree()

  // --- 1. index miss -> disk answer, and it says so ------------------------
  {
    const delegate = fakeDelegate(diskAnswer)
    const tool = createFindTool(pool, 'glob', delegate)
    const value = await run(tool, { pattern: 'out.js' })
    assert.ok(delegate.calls.length >= 1, 'an index miss must ask the built-in')
    assert.equal(delegate.calls[0].name, 'glob')
    assert.deepEqual(delegate.calls[0].args, { pattern: 'out.js' }, 'the built-in gets its own argument shape, nothing else')
    assert.equal(value.items.length, 1, JSON.stringify(value))
    assert.ok(String(value.items[0].path).includes('out.js'), JSON.stringify(value.items[0]))
    assert.match(value.note ?? '', /built-in walk on disk/, 'the note must name which side answered')
    assert.match(value.note ?? '', /gitignore/, 'the note must say why the index missed it')
    ok('an index miss delegates and the note names the disk as the source')
  }

  // --- 2. index hit -> no delegation --------------------------------------
  {
    const delegate = fakeDelegate(diskAnswer)
    const tool = createFindTool(pool, 'glob', delegate)
    const value = await run(tool, { pattern: 'kept.ts' })
    assert.equal(delegate.calls.length, 0, 'a hit must not pay for an rg run')
    assert.equal(value.items.length, 1, JSON.stringify(value))
    assert.ok(String(value.items[0].path).includes('kept.ts'))
    assert.equal(value.note, undefined, 'no note when the index answered')
    ok('an index hit does not delegate')
  }

  // --- 3. no built-in -> own answer ---------------------------------------
  {
    const tool = createFindTool(pool, 'glob', fakeDelegate(diskAnswer, { available: false }))
    const value = await run(tool, { pattern: 'out.js' })
    assert.deepEqual(value.items, [])
    assert.ok(!String(value.note ?? '').includes('built-in walk'), 'nothing may claim a fallback that did not run')
    ok('a host without the built-in keeps its own empty answer')
  }

  // --- 4. a glob in `path` goes straight to the built-in ------------------
  {
    const delegate = fakeDelegate({ ok: false, error: 'path must be a directory' })
    const tool = createFindTool(pool, 'glob', delegate)
    const value = await run(tool, { pattern: '*.js', path: 'ignored/**' })
    assert.equal(delegate.calls.length, 1, 'the built-in must be asked, not the index')
    assert.deepEqual(delegate.calls[0].args, { pattern: '*.js', path: 'ignored/**' })
    assert.equal(value.error, 'path must be a directory', JSON.stringify(value))
    ok('a glob path is answered by the built-in, error included')
  }

  // --- 5. failed disk check keeps the index answer, with a reason ---------
  {
    const tool = createFindTool(pool, 'glob', fakeDelegate({ ok: false, error: 'rg is not installed' }))
    const value = await run(tool, { pattern: 'out.js' })
    assert.deepEqual(value.items, [])
    assert.match(value.note ?? '', /could not run/, 'a failed fallback must be visible')
    assert.match(value.note ?? '', /rg is not installed/)
    ok('a failed disk check is reported instead of silently empty')
  }

  // --- 6. empty disk answer -> one honest line ----------------------------
  {
    const tool = createFindTool(pool, 'glob', fakeDelegate({ ok: true, value: { root: '.', paths: [] } }))
    const value = await run(tool, { pattern: 'nothing-matches-this' })
    assert.deepEqual(value.items, [])
    assert.equal(value.note, 'no match in the index and none on disk')
    ok('an empty disk answer says both sides agreed')
  }

  // --- 7. additive fffind never delegates ---------------------------------
  {
    const delegate = fakeDelegate(diskAnswer)
    const tool = createFindTool(pool, undefined, delegate)
    const value = await run(tool, { pattern: 'out.js', mode: 'glob' })
    assert.equal(delegate.calls.length, 0, 'the additive tool answers its own name and answers alone')
    assert.deepEqual(value.items, [])
    ok('the additive fffind keeps the index-only contract')
  }

  pool.disposeAll()
  rmSync(PROBE_DIR, { recursive: true, force: true })
  console.log(`\n${passed} glob-delegation groups passed`)
}

await main()
