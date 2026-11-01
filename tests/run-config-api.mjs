import assert from 'node:assert/strict'
import { CONFIG_PATH, ConfigEditError, FORGE_ROW_ID, nextConfig, readSettings } from '../lib/config-api.js'

let passed = 0
const ok = (label) => console.log(`  ok ${++passed} - ${label}`)
const rejects = (run, pattern) => assert.throws(run, (error) => error instanceof ConfigEditError && pattern.test(error.message))

assert.deepEqual(readSettings(undefined), { surface: 'retrieval' })
assert.deepEqual(readSettings({ surface: 'unknown' }), { surface: 'retrieval' })
assert.deepEqual(readSettings({ surface: 'full' }), { surface: 'full' })
ok('config reads retrieval by default and preserves full')

const foreign = { legacy: { endpoint: 'secret' } }
assert.deepEqual(nextConfig(foreign, { surface: 'full' }), { ...foreign, surface: 'full' })
ok('unknown config keys survive a save')
assert.deepEqual(nextConfig({}, { surface: 'retrieval' }), { surface: 'retrieval' })
rejects(() => nextConfig({}, { surface: 'replace' }), /surface/)
rejects(() => nextConfig({}, ['full']), /surface/)
ok('invalid surfaces are rejected')

assert.equal(FORGE_ROW_ID, 'dsh-forge')
assert.equal(CONFIG_PATH, '/forge-config')
ok('route path and row id are pinned')
console.log(`\n${passed} checks passed`)
