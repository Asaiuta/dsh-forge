/**
 * The settings page's write contract: what a saved body is allowed to mean.
 *
 * Every case here guards a way a save could silently change something the user
 * did not ask for. The one worth naming is `takeover` with nothing selected:
 * `config.ts` reads an empty list in takeover mode as "everything forge can
 * serve", so accepting the empty selection would turn "deselect all" into
 * "select all" — the exact opposite, on the one field that decides which tools
 * exist. The rest are about not dropping keys: `configEditor.edit()` replaces the
 * row's whole `config` node, so a `cards` block that is not carried through is
 * deleted from the user's profile patch.
 *
 * Pure functions only — no host, no web server, no browser. Runs against the
 * built lib/ (build first: `node build.mjs`).
 */

import assert from 'node:assert/strict'
import {
  CONFIG_PATH,
  ConfigEditError,
  FORGE_ROW_ID,
  nextConfig,
  readSettings,
} from '../lib/config-api.js'

let passed = 0
function ok(label) {
  passed++
  console.log(`  ok ${passed} - ${label}`)
}

function rejects(label, run, pattern) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof ConfigEditError, `${label}: expected ConfigEditError, got ${error?.name}`)
    assert.match(error.message, pattern)
    return true
  })
  ok(label)
}

// ---------------------------------------------------------------------------
// Reading: a hand-edited row must stay viewable so the page can repair it.
// ---------------------------------------------------------------------------
assert.deepEqual(readSettings(undefined), { registration: 'additive', takeover: [], prewarm: true })
ok('no config reads as additive / no takeover / prewarm on')

assert.deepEqual(
  readSettings({ registration: 'nonsense', takeover: ['read', 'bogus', 7, 'read'], prewarm: 'no' }),
  { registration: 'additive', takeover: ['read'], prewarm: true },
)
ok('a malformed row degrades to defaults instead of failing the read')

assert.deepEqual(
  readSettings({ registration: 'takeover', takeover: [' glob ', 'grep'] }),
  { registration: 'takeover', takeover: ['glob', 'grep'], prewarm: true },
)
ok('takeover entries are trimmed and ordered as listed')

assert.deepEqual(readSettings({ prewarm: false }), { registration: 'additive', takeover: [], prewarm: false })
ok('prewarm false survives a read (only a literal false turns it off)')

// ---------------------------------------------------------------------------
// Writing: unknown keys are carried through, never re-derived.
// ---------------------------------------------------------------------------
const cards = { distill: 'endpoint', endpoint: { baseUrl: 'http://x', model: 'm', apiKey: 'sk-secret' } }
const written = nextConfig({ registration: 'additive', cards }, { registration: 'takeover', takeover: ['read'], prewarm: false })
assert.deepEqual(written, { registration: 'takeover', takeover: ['read'], prewarm: false, cards })
ok('cards (and its credential) survive a save untouched')

const additive = nextConfig({ cards }, { registration: 'additive', takeover: [], prewarm: true })
assert.deepEqual(additive.takeover, [])
ok('an empty takeover list is legal while additive — the boxes are just inactive')

assert.equal(nextConfig({}, { registration: 'takeover', takeover: ['grep'], prewarm: true }).registration, 'takeover')
ok('takeover mode with one name is accepted')

// ---------------------------------------------------------------------------
// Refusals: each one is a value the schema or the mode semantics reject.
// ---------------------------------------------------------------------------
rejects(
  'takeover with nothing selected is refused (it would mean "all")',
  () => nextConfig({}, { registration: 'takeover', takeover: [], prewarm: true }),
  /至少/,
)
rejects(
  'a name forge cannot serve in its native shape is refused',
  () => nextConfig({}, { registration: 'takeover', takeover: ['edit'], prewarm: true }),
  /edit/,
)
rejects(
  'a duplicate name is refused',
  () => nextConfig({}, { registration: 'takeover', takeover: ['read', 'read'], prewarm: true }),
  /重复/,
)
rejects(
  'an unknown registration mode is refused',
  () => nextConfig({}, { registration: 'replace', takeover: ['read'], prewarm: true }),
  /并存/,
)
rejects(
  'a non-boolean prewarm is refused',
  () => nextConfig({}, { registration: 'additive', takeover: [], prewarm: 'yes' }),
  /预热/,
)
rejects(
  'a body that is not an object is refused',
  () => nextConfig({}, ['read']),
  /对象/,
)
rejects(
  'a takeover list that is not an array is refused',
  () => nextConfig({}, { registration: 'takeover', takeover: 'read', prewarm: true }),
  /列表/,
)

// ---------------------------------------------------------------------------
// The wire: the route and the row id are spelled in two places (this module and
// the browser half). The client bundle's build asserts its own copy; this pins
// the host's, so a rename cannot land on one side only.
// ---------------------------------------------------------------------------
assert.equal(FORGE_ROW_ID, 'dsh-forge')
assert.equal(CONFIG_PATH, '/forge-config')
ok('route path and row id are pinned')

console.log(`\n${passed} checks passed`)
