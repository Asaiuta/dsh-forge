/**
 * Everything backend: unit behaviour + the one wiring rule that matters —
 * a machine-index hit must answer **without** building an fff lease, because
 * that lease is the 28-second cold scan we are trying to avoid.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { everythingSearch, parseEsOutput } from '../lib/global-index.js'
import { createFindTool } from '../lib/tools.js'

const ok = (msg) => console.log(`  ok  ${msg}`)

const HERE = import.meta.dirname
const REPO = path.resolve(HERE, '..')

// --- parse ------------------------------------------------------------------
{
  assert.deepEqual(parseEsOutput('C:\\a\\b.md\r\n\r\nC:\\a\\b.md\r\nD:\\c\\'), ['C:\\a\\b.md', 'D:\\c\\'])
  ok('es output parsing drops blanks and duplicates')
}

// --- hit --------------------------------------------------------------------
{
  const seen = []
  const run = async (esPath, args) => {
    seen.push({ esPath, args })
    return { code: 0, stdout: `${path.join(REPO, 'package.json')}\r\n${REPO}\r\n`, stderr: '' }
  }
  const result = await everythingSearch('package', {
    mode: 'everything', platform: 'win32', esPath: process.execPath, run, limit: 5, root: REPO,
  })
  assert.equal(result.status, 'hit')
  assert.equal(result.hits.length, 2)
  assert.equal(result.hits[0].isDirectory, false)
  assert.ok(result.hits[0].size > 0, 'size comes from stat, not the index')
  assert.match(result.hits[0].modified, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(result.hits[1].isDirectory, true)
  assert.ok(result.hits[1].path.endsWith(path.sep), 'directories keep their trailing separator')
  assert.deepEqual(seen[0].args.slice(0, 4), ['-n', '5', '-path', REPO])
  assert.equal(seen[0].args.at(-1), 'package')
  ok('literal hit: paths hydrated with stat, -path/-n forwarded, query last')
}

// --- miss / unavailable -----------------------------------------------------
{
  const miss = await everythingSearch('nothing-here', {
    mode: 'everything', platform: 'win32', esPath: process.execPath,
    run: async () => ({ code: 0, stdout: '\r\n', stderr: '' }),
  })
  assert.equal(miss.status, 'miss')

  const stopped = await everythingSearch('x', {
    mode: 'everything', platform: 'win32', esPath: process.execPath,
    run: async () => ({ code: 8, stdout: '', stderr: 'Everything is not running.\r\n' }),
  })
  assert.equal(stopped.status, 'unavailable')
  assert.match(stopped.reason, /not running/)

  const off = await everythingSearch('x', { mode: 'off' })
  assert.equal(off.status, 'unavailable')
  assert.equal(off.reason, 'disabled')

  const posix = await everythingSearch('x', { mode: 'auto', platform: 'linux' })
  assert.equal(posix.status, 'unavailable')
  assert.match(posix.reason, /windows only/)
  ok('miss vs unavailable are distinct (stopped service, disabled, wrong platform)')
}

// --- wiring: a hit must not touch the finder pool ---------------------------
{
  const explodingPool = {
    main: async () => { throw new Error('pool must not be used when Everything answers') },
    aux: async () => { throw new Error('pool must not be used when Everything answers') },
  }
  const tool = createFindTool(explodingPool, {
    globalSearch: async () => ({
      status: 'hit',
      hits: [{ path: 'C:\\Users\\someone\\.agents\\skills\\reverse-workbench-skill', size: 0, modified: '2026-10-18', isDirectory: true }],
    }),
  })
  const out = await tool.execute({ pattern: 'reverse-workbench', path: 'C:\\Users' }, undefined)
  assert.equal(out.error, undefined)
  assert.equal(out.items.length, 1)
  assert.equal(out.items[0].match, 'everything')
  assert.ok(out.items[0].path.endsWith('/'), 'dir results are marked with a trailing slash')
  assert.equal(out.totalMatched, 1)
  ok('Everything hit answers without creating an fff lease')
}

// --- wiring: miss falls back to fff ----------------------------------------
{
  const failingPool = {
    main: async () => ({ error: 'POOL_USED' }),
    aux: async () => ({ error: 'POOL_USED' }),
  }
  const tool = createFindTool(failingPool, { globalSearch: async () => ({ status: 'miss' }) })
  const out = await tool.execute({ pattern: 'no-such-name', path: 'C:\\Users' }, undefined)
  assert.equal(out.error, 'POOL_USED', 'a machine-index miss must fall through to the fuzzy index')
  ok('Everything miss falls back to fff')
}

// --- wiring: glob-ish and glob mode never consult the machine index ---------
{
  let asked = 0
  const tool = createFindTool(
    { main: async () => ({ error: 'POOL_USED' }), aux: async () => ({ error: 'POOL_USED' }) },
    { globalSearch: async () => { asked++; return { status: 'miss' } } },
  )
  await tool.execute({ pattern: '*.md' }, undefined)
  await tool.execute({ mode: 'glob', pattern: '**/*.md' }, undefined)
  assert.equal(asked, 0)
  ok('globs and mode=glob stay on fff')
}

// --- wiring: a weak fuzzy page is annotated, never replaced ----------------
// Replacing it was measured and reverted (tests/eval-quality.mjs floor 6:
// `utls` → `utils.py`): a literal backend answers an abbreviation with every
// unrelated path that contains the substring (`gnutls/`), which buries the file
// the caller asked for. The fuzzy ranking is the better answer; the note adds
// the doubt signal plus where the machine index saw the name.
{
  const rows = [
    ['archive/p0-adoption-baseline-2026-10-26.md', 96],
    ['few-shots-work/pylibs/torch/include/ATen/ops/_dispatch.h', 88],
    ['archive/acl-recovery/report-8d9f2d2b.jsonl', 84],
    ['archive/p0-adoption-prompts-2026-10-26.md', 82],
    ['archive/p0-adoption-prompts-round3-2026-10-26.md', 80],
    ['archive/p0-adoption-round3-partial-2026-10-26.md', 80],
  ]
  const pool = {
    main: async () => ({
      basePath: REPO,
      warming: false,
      aux: true,
      finder: {
        isDestroyed: false,
        isScanning: () => false,
        fileSearch: () => ({
          ok: true,
          value: {
            items: rows.map(([rel]) => ({
              relativePath: rel, fileName: path.basename(rel), gitStatus: '', totalFrecencyScore: 0, size: 10, modified: 0,
            })),
            scores: rows.map(([, score]) => ({ total: score, matchType: 'fuzzy_path' })),
            totalMatched: rows.length,
          },
        }),
        glob: () => ({ ok: true, value: { items: [] } }),
      },
    }),
    aux: async () => ({ error: 'AUX_MUST_NOT_BE_USED' }),
  }
  const tool = createFindTool(pool, {
    globalSearch: async () => ({
      status: 'hit',
      hits: [{ path: 'C:\\Users\\someone\\.agents\\skills\\reverse-workbench-skill', size: 0, modified: '2026-10-18', isDirectory: true }],
    }),
  })
  const out = await tool.execute({ pattern: 'reverse-workbench' }, undefined)
  assert.equal(out.error, undefined)
  assert.equal(out.items.length, rows.length, 'the fuzzy page must survive the machine-index hint')
  assert.equal(out.items[0].match, 'fuzzy_path')
  assert.match(out.note ?? '', /fuzzy only/, `doubt signal missing: ${out.note}`)
  assert.match(out.note ?? '', /reverse-workbench-skill/, `hint must name what the machine index found: ${out.note}`)
  ok('weak fuzzy page keeps its rows and gains a machine-index hint')
}

// --- wiring: a strong fuzzy page is left alone -----------------------------
{
  const pool = {
    main: async () => ({
      basePath: REPO, warming: false, aux: true,
      finder: {
        isDestroyed: false,
        isScanning: () => false,
        fileSearch: () => ({
          ok: true,
          value: {
            items: [{ relativePath: 'src/utils.py', fileName: 'utils.py', gitStatus: '', totalFrecencyScore: 0, size: 10, modified: 0 }],
            scores: [{ total: 240, matchType: 'fuzzy_filename' }],
            totalMatched: 1,
          },
        }),
        glob: () => ({ ok: true, value: { items: [] } }),
      },
    }),
    aux: async () => ({ error: 'AUX_MUST_NOT_BE_USED' }),
  }
  let asked = 0
  const tool = createFindTool(pool, { globalSearch: async () => { asked++; return { status: 'miss' } } })
  const out = await tool.execute({ pattern: 'utls' }, undefined)
  assert.equal(out.items.length, 1)
  assert.equal(asked, 0, 'a ranked fuzzy hit at 240 must not trigger a machine-index round trip')
  assert.equal(out.note, undefined)
  ok('a strong fuzzy page stays silent and offline')
}

// --- wiring: a stale index is rebuilt before absence is claimed -------------
// The engine's watcher loses events (measured: a file created inside the
// workspace stayed invisible for 2.5 s while `scanFiles()` listed it at once),
// so an empty page is only trustworthy after the disk agrees. The disk walk that
// produces the absence note is also the check — it must run exactly once.
{
  const dir = path.join(HERE, '.fixture', '.heal-probe')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'zz-heal-check.md'), '# probe\n')
  let scans = 0
  let stale = true
  const row = {
    relativePath: 'zz-heal-check.md', fileName: 'zz-heal-check.md', gitStatus: '', totalFrecencyScore: 0, size: 9, modified: 0,
  }
  const lease = {
    basePath: dir, warming: false, aux: true, scannedAt: 0,
    finder: {
      isDestroyed: false,
      isScanning: () => false,
      fileSearch: (query) => ({
        ok: true,
        value: !stale && 'zz-heal-check'.includes(query)
          ? { items: [row], scores: [{ total: 610, matchType: 'exact_filename' }], totalMatched: 1 }
          : { items: [], scores: [], totalMatched: 0 },
      }),
      glob: () => ({ ok: true, value: { items: [] } }),
    },
  }
  // The rebuild is the pool's job now (it owns the throttle and the scan clock),
  // so the fake has to model it rather than the finder method.
  const pool = {
    main: async () => lease,
    aux: async () => lease,
    rescan: async () => { scans++; stale = false; return true },
  }
  const tool = createFindTool(pool, { globalSearch: async () => ({ status: 'miss' }) })

  const out = await tool.execute({ pattern: 'zz-heal-check' }, undefined)
  assert.equal(scans, 1, 'an empty page with a matching file on disk must rebuild the index')
  assert.equal(out.items.length, 1, 'the retry after the rebuild must answer')
  assert.ok(out.items[0].path.endsWith('zz-heal-check.md'))
  assert.equal(out.note, undefined, 'a rebuilt page is an answer, not an absence')

  const absent = await tool.execute({ pattern: 'zz-nothing-like-this' }, undefined)
  assert.equal(scans, 1, 'a name the disk does not have must not pay for a rebuild')
  assert.equal(absent.items.length, 0)

  fs.rmSync(dir, { recursive: true, force: true })
  ok('stale index is rebuilt on evidence, once, and only when the disk agrees')
}

console.log('find-global: all checks passed')
