/** The sidecar's candidate walk and the JS walk must agree entry for entry.
 *
 *  Discovery decides what gets scanned at all, so a rule that drifts on one
 *  side of the boundary changes every downstream answer silently: a file the
 *  JS walk kept and the sidecar dropped simply stops existing for `trace`, and
 *  a file the sidecar kept and the JS walk dropped turns into evidence that
 *  was never on disk. Hence a list-against-list comparison, not a count — a
 *  count is exactly what swapping two paths survives.
 *
 *  The fixture carries the rules the two matchers could read differently:
 *  a directory-only pattern, `**`, an anchored pattern, a character class, a
 *  negation, an escaped `#`, a path pattern that applies at two depths, the
 *  ts/js config family, an unknown extension, and the `_dsh`-marked
 *  dot-directory that is skipped whole.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { indexerCollectCandidates, indexerReady, setIndexerTransportForTest } = await import(
  new URL('../lib/indexer-client.js', import.meta.url).href
)
const { collectCandidatesLocal } = await import(new URL('../lib/tools-trace.js', import.meta.url).href)

let passed = 0
const ok = name => console.log(`ok ${++passed} - ${name}`)

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-candidates-'))
const put = (rel, body = '') => {
  const abs = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

put('.gitignore', [
  'dist/',
  '/gen/*.js',
  '!/gen/keep.js',
  '/src/gen/**',
  '[ab].js',
  '\\#hash.js',
  'sub/only.js',
  '**/cache',
  '',
].join('\n'))
// a directory-only pattern prunes the children, not the visit
put('dist/bundle.js')
put('dist/deep/nested.js')
// a negation has to win for exactly one path
put('gen/drop.js')
put('gen/keep.js')
put('keep.js')
// anchored: `/src/gen/**` must not reach `other/src/gen`
put('src/live.js')
put('src/gen/x.js')
put('other/src/gen/y.js')
// a character class is `[ab]`, not `[a-b]`
put('a.js')
put('b.js')
put('c.js')
// an escaped `#` is a literal name, not a comment
put('#hash.js')
// a path pattern that also matches at another depth
put('sub/only.js')
put('other/sub/only.js')
// `**/cache` at two depths
put('cache/c.js')
put('a/cache/y.js')
// the ts/js config family, and one lookalike that must stay out of it
put('package.json', '{}')
put('sub/tsconfig.app.json', '{}')
put('tsconfigX.json', '{}')
// manifests and binaries
put('pyproject.toml')
put('Cargo.toml')
put('go.mod', 'module x')
put('lib/x.dll')
put('noext')
// a dot-directory is walked; one carrying the _dsh marker is skipped whole
put('.plain/y.js')
put('.artifact/z.js')
put('.artifact/_dsh/asar-out/y.js')
// a blacklisted name is skipped wherever it appears
put('node_modules/ignored.js')
put('.git/config.js')
// depth
put('deep/a/b/c/d.ts')

try {
  const local = collectCandidatesLocal(root)
  const remote = await indexerCollectCandidates(root)

  if (!remote) {
    console.log('candidate parity: optional sidecar unavailable — SKIPPED')
  } else {
    const rel = list => [...list].sort((a, b) => a.localeCompare(b))
    const localFiles = rel(local.files.map(file => file.rel))
    assert.deepEqual(rel(remote.files), localFiles, 'files')
    for (const field of ['projectFiles', 'pythonFiles', 'cargoFiles', 'goFiles']) {
      assert.deepEqual(rel(remote[field]), rel(local[field]), field)
    }
    assert.equal(remote.truncated, local.truncated, 'truncated')
    assert.equal(remote.walkErrors, local.walkErrors, 'walkErrors')
    ok('both walks keep the same files, in the same order, and report the same caps')
  }

  // The comparison above is only worth anything if the fixture reaches the
  // rules, so pin what each one is supposed to do — against the JS walk when
  // the sidecar is absent, against both when it is present.
  const rows = local.files.map(file => file.rel)
  assert.ok(rows.length >= 8, `the fixture kept only ${rows.length} files, so parity proves little`)
  const kept = name => assert.ok(rows.includes(name), `${name} should be scanned`)
  const dropped = name => assert.ok(!rows.includes(name), `${name} should be ignored`)
  for (const name of ['keep.js', 'gen/keep.js', 'src/live.js', 'other/src/gen/y.js', 'c.js', 'other/sub/only.js', 'lib/x.dll', 'deep/a/b/c/d.ts', '.plain/y.js']) kept(name)
  for (const name of ['gen/drop.js', 'a.js', 'b.js', '#hash.js', 'sub/only.js', 'noext']) dropped(name)
  for (const prefix of ['dist/', 'src/gen/', 'cache/', 'a/cache/', 'node_modules/', '.git/', '.artifact/']) {
    assert.ok(!rows.some(rel => rel.startsWith(prefix)), `${prefix} stays out`)
  }
  assert.deepEqual([...local.projectFiles].sort(), ['package.json', 'sub/tsconfig.app.json'])
  assert.deepEqual([...local.pythonFiles].sort(), ['pyproject.toml'])
  assert.deepEqual([...local.cargoFiles].sort(), ['Cargo.toml'])
  assert.deepEqual([...local.goFiles].sort(), ['go.mod'])
  ok('the fixture reaches every rule the two walks have to read the same way')

  // A `.gitignore` an editor saved with a BOM still has to apply. The npm
  // package strips the BOM per pattern; a sidecar that does not leaves the
  // first rule as `\uFEFFignored/`, which matches nothing — and the only
  // visible symptom is files that should be ignored quietly coming back.
  const bommed = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-candidates-bom-'))
  try {
    fs.writeFileSync(path.join(bommed, '.gitignore'), '\uFEFFignored/\r\n*.gen.js\r\n')
    for (const rel of ['ignored/miss.py', 'drop.gen.js', 'kept.py']) {
      const abs = path.join(bommed, ...rel.split('/'))
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, '')
    }
    assert.deepEqual(collectCandidatesLocal(bommed).files.map(file => file.rel).sort(), ['kept.py'])
    if (await indexerReady()) {
      assert.deepEqual([...(await indexerCollectCandidates(bommed)).files].sort(), ['kept.py'])
    }
    ok('a .gitignore saved with a BOM applies on both sides')
  } finally {
    fs.rmSync(bommed, { recursive: true, force: true })
  }

  // A tree with nothing in it and a tree that is not there are the two cases
  // where "empty" and "failed" are easy to confuse.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-candidates-empty-'))
  try {
    const emptyLocal = collectCandidatesLocal(empty)
    assert.equal(emptyLocal.files.length, 0)
    assert.equal(emptyLocal.walkErrors, 0)
    if (await indexerReady()) {
      const emptyRemote = await indexerCollectCandidates(empty)
      assert.deepEqual(emptyRemote?.files, [])
      assert.equal(emptyRemote?.walkErrors, 0)
      const missingRemote = await indexerCollectCandidates(path.join(empty, 'absent'))
      assert.deepEqual(missingRemote?.files, [])
      assert.equal(missingRemote?.walkErrors, 1)
    }
    const missingLocal = collectCandidatesLocal(path.join(empty, 'absent'))
    assert.deepEqual(missingLocal.files, [])
    assert.equal(missingLocal.walkErrors, 1)
    ok('an empty tree is an empty answer and a missing root is one walk error, on both sides')
  } finally {
    fs.rmSync(empty, { recursive: true, force: true })
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

// A walk that answers `ok` with something that is not a list of paths must not
// be read as "this tree has no files": the caller would then scan nothing and
// report a clean, empty result for a repo full of source.
{
  const reply = fields => setIndexerTransportForTest(async method => {
    assert.equal(method, 'collectCandidates')
    return { ok: true, ...fields }
  })
  const complete = { files: [], projectFiles: [], pythonFiles: [], cargoFiles: [], goFiles: [], truncated: false, walkErrors: 0 }
  reply({ ...complete, files: 'a.js' })
  assert.equal(await indexerCollectCandidates('/w'), null, 'a string is not a file list')
  reply({ ...complete, files: [1, 2] })
  assert.equal(await indexerCollectCandidates('/w'), null, 'a list of numbers is not a file list')
  reply({ ...complete, truncated: 'no' })
  assert.equal(await indexerCollectCandidates('/w'), null, 'truncated has to be a boolean')
  reply({ files: [], projectFiles: [], pythonFiles: [], cargoFiles: [] })
  assert.equal(await indexerCollectCandidates('/w'), null, 'a missing list is not an empty list')
  reply(complete)
  assert.deepEqual(await indexerCollectCandidates('/w'), complete, 'a complete empty answer is still an answer')
  setIndexerTransportForTest(null)
  ok('a malformed walk reply reports unavailability instead of an empty tree')
}

console.log(`\n${passed} candidate-walk groups passed`)
