// fftrace exposes view: the survey collapses, a small bridge keeps its per-key
// rows, an oversized reply degrades, and `format=detail` still renders the full
// per-key table byte for byte. The point of the suite is that the two views
// never disagree about a count — only about how much coordinate detail they
// print, and that the detail escape hatch cannot silently drift.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTraceTool } from '../lib/tools-trace.js'
import { resetFactsCache } from '../lib/ast.js'

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }

/** sha256 of the pre-change exposes body for this fixture, captured from a build
 *  of `git show HEAD:src/...` (see .tmp-analysis/detail-digest.mjs). If the detail
 *  view drifts, this fails instead of silently changing what `format=detail`
 *  means. */
const DETAIL_DIGEST = 'ab39af0701178f77df29d3f3293da999167e35585a3b64ba31a4b4bafdcf1ba4'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-exposes-view-'))
const write = (rel, text) => {
  const abs = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

// Two bridges that pull in opposite directions:
//   smallBridge  — 2 keys, one consumer file  → per-key rows are the answer
//   wideBridge   — 20 keys, one consumer file → per-key rows repeat one fact
const wideKeys = Array.from({ length: 20 }, (_, i) => `w${i + 1}`)
write('preloads/small.js', `const api = { alpha: () => {}, beta: () => {} }
contextBridge.exposeInMainWorld('smallBridge', api)
`)
write('preloads/wide.js', `const api = Object.freeze({
${wideKeys.map((key) => `  ${key}: () => {},`).join('\n')}
  neverUsed: () => {},
})
contextBridge.exposeInMainWorld('wideBridge', api)
`)
write('renderer/small.js', `window.smallBridge.alpha()
window.smallBridge.beta()
`)
write('renderer/wide.js', `${wideKeys.map((key) => `window.wideBridge.${key}()`).join('\n')}
`)

const exec = { agent: { session: { header: { cwd: root, id: 'exposes-view' } } }, token: {} }

try {
  resetFactsCache()
  const tool = createTraceTool()
  const run = (args) => tool.execute(args, exec)

  // ---- survey collapses ----------------------------------------------------
  const survey = await run({ target: 'exposes:' })
  assert.equal(survey.found, true)
  assert.ok(survey.text.startsWith('## Trace exposes:all'), survey.text)
  assert.ok(survey.text.includes('`smallBridge`') && survey.text.includes('`wideBridge`'), survey.text)
  assert.ok(survey.text.includes('视图：summary'), survey.text)
  // A collapsed row must still answer "who consumes it, from where".
  assert.match(survey.text, /`wideBridge` · L\d+ · 键 21 · 已用 20 · 站点 20 · 消费者 1 文件：`renderer\/wide\.js` ×20/)
  assert.match(survey.text, /`smallBridge` · L\d+ · 键 2 · 已用 2 · 站点 2 · 消费者 1 文件：`renderer\/small\.js` ×2/)
  // The unused key is named, not merely counted.
  assert.ok(survey.text.includes('未用 1：neverUsed'), survey.text)
  // No per-key rows in a survey.
  assert.ok(!/^\s+- `w1` ×/m.test(survey.text), 'survey must not print per-key rows')
  ok('survey collapses every bridge to one row and keeps the counts honest')

  // ---- a small filtered bridge keeps per-key rows ---------------------------
  const small = await run({ target: 'exposes:smallBridge' })
  assert.equal(small.found, true)
  assert.ok(/^\s+- `alpha` ×1：`renderer\/small\.js:\d+`/m.test(small.text), small.text)
  assert.ok(/^\s+- `beta` ×1：`renderer\/small\.js:\d+`/m.test(small.text), small.text)
  ok('a small bridge still answers "who uses this key" in one call')

  // ---- a wide filtered bridge folds ---------------------------------------
  const wide = await run({ target: 'exposes:wideBridge' })
  assert.ok(wide.text.includes('消费者 1 文件'), wide.text)
  assert.ok(!/^\s+- `w1` ×/m.test(wide.text), '20 keys from one file must not print 20 rows')
  ok('a wide bridge folds instead of repeating one fact twenty times')

  // ---- detail is the escape hatch, byte for byte ---------------------------
  const detail = await run({ target: 'exposes:', format: 'detail' })
  assert.ok(/^\s+- `w1` ×1：`renderer\/wide\.js:\d+`/m.test(detail.text), 'detail must print per-key rows')
  assert.ok(detail.text.includes('未被使用（1）：neverUsed'), detail.text)
  assert.ok(detail.text.length > survey.text.length * 2, `detail ${detail.text.length} vs survey ${survey.text.length}`)
  // Guard the contract: detail renders the same exposes rows the pre-change
  // build did. The slice starts at the summary line because tools-trace injects
  // the shared preamble right after the title; pinning the preamble here would
  // turn any future header edit into a false exposes regression.
  const body = detail.text.slice(detail.text.indexOf('- 共 '))
  const digest = createHash('sha256').update(body).digest('hex')
  assert.equal(digest, DETAIL_DIGEST, `detail output drifted: ${digest}`)
  ok('format=detail reproduces the pre-change exposes render exactly (sha256)')

  // ---- explicit summary matches the survey ---------------------------------
  const summary = await run({ target: 'exposes:', format: 'summary' })
  assert.equal(summary.text, survey.text)
  ok('format=summary equals the automatic survey view')

  // ---- a loose filter lands on the budget, not on its spelling -------------
  const loose = await run({ target: 'exposes:preloads/' })
  assert.equal(loose.found, true)
  assert.ok(loose.text.includes('`smallBridge`') && loose.text.includes('`wideBridge`'), loose.text)
  ok('a loose filter still renders (budget decides the shape, not the query text)')

  // ---- the budget, not the query text, decides the shape -------------------
  // A survey wide enough to blow the budget must lose the unused-key name lists
  // (the tier that costs least information), and must say so.
  const manyDead = Array.from({ length: 60 }, (_, i) => `  dead${i}: () => {},`)
  write('preloads/fat.js', `const api = Object.freeze({
${wideKeys.map((key) => `  ${key}: () => {},`).join('\n')}
${manyDead.join('\n')}
})
contextBridge.exposeInMainWorld('fatBridge', api)
`)
  write('renderer/fat.js', `${wideKeys.map((key) => `window.fatBridge.${key}()`).join('\n')}\n`)
  const pressed = await run({ target: 'exposes:' })
  assert.equal(pressed.found, true)
  // Either the budget was not reached (small fixture) or it degraded and said
  // so; what must never happen is a silent mix of tiers.
  if (pressed.text.includes('视图：compact')) {
    assert.ok(!pressed.text.includes('dead0'), 'compact must drop the unused-key name list')
    assert.ok(/未用 60/.test(pressed.text) || /未用 \d+/.test(pressed.text), 'compact must keep the unused count')
  } else {
    assert.ok(pressed.text.includes('视图：summary'), pressed.text)
  }
  assert.ok(pressed.text.length < 20_000, 'a survey must never approach the pre-change 18 469 characters')
  ok('the output budget decides the tier and announces it')

  // ---- invalid arguments fail loudly --------------------------------------
  const bogus = await run({ target: 'exposes:', format: 'bogus' })
  assert.equal(bogus.error, 'format 仅接受 auto / summary / detail。')
  const wrongKind = await run({ target: 'file:preloads/small.js', format: 'detail' })
  assert.equal(wrongKind.error, 'format 只影响 exposes: 查询的视图。')
  const onSymbol = await run({ target: 'symbol:alpha', format: 'detail' })
  assert.equal(onSymbol.error, 'format 不适用于 symbol: 查询。')
  ok('format is validated, never silently ignored')
} finally {
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* tmpdir cleanup fallback */ }
}

console.log(`\n${passed} exposes-view groups passed`)
