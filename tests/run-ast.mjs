/**
 * AST tool-path unit tests for dsh-forge stage 2 — pure Node on built lib/
 * (build first). Covers extraction, symbol addressing, comment capture,
 * content-anchored staleness, the grep→symbol weld, and degradation paths.
 */

import assert from 'node:assert/strict'
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FinderPool } from '../lib/core.js'
import { createGrepTool } from '../lib/tools.js'
import { createReadTool } from '../lib/tools-read.js'
import { singleSymbolView } from './lib/symbol-read.mjs'
import { outlineView, definitionsView } from './lib/read-views.mjs'
import { flattenSymbols, parseFile } from '../lib/ast.js'
import { buildFixture, FIXTURE_DIR } from './make-fixture.mjs'

buildFixture()
const pool = new FinderPool()
const exec = { agent: { session: { header: { cwd: FIXTURE_DIR } } } }
const readTool = createReadTool()
// ff_outline and ff_find_symbol were folded into ff_read's views; these shims
// keep the historic call shape so the assertions stay about behaviour.
const outline = outlineView(readTool)
const findSymbolTool = definitionsView(readTool)
// ff_read_symbol was merged into ff_read; these cases drive the merged tool.
const readSymbol = { execute: async (args, exec) => singleSymbolView(await readTool.execute(args, exec)) }
const grep = createGrepTool(pool)

let passed = 0
function ok(label) {
  passed++
  console.log(`  ok ${passed} - ${label}`)
}

async function main() {
  // --- extraction ----------------------------------------------------------
  {
    const r = await outline.execute({ path: 'src/store.js' }, exec)
    assert.ok(!r.error, `outline store.js: ${r.error}`)
    const names = new Set(r.items.map((i) => i.qualifiedName))
    assert.ok(names.has('Store'), 'class Store present')
    assert.ok(names.has('Store.hasBlob') && names.has('Store.putBlob') && names.has('Store.getBlob'),
      'methods qualified as Store.<method>')
    const putBlob = r.items.find((i) => i.qualifiedName === 'Store.putBlob')
    assert.equal(putBlob.kind, 'method')
    assert.equal(putBlob.startLine, 7)
    assert.equal(putBlob.endLine, 11)
    ok('outline store.js: class + methods with exact ranges')
  }
  {
    const r = await outline.execute({ path: 'lib/scoring.rs' }, exec)
    assert.ok(!r.error)
    const names = new Set(r.items.map((i) => i.qualifiedName))
    assert.ok(names.has('Config') && names.has('compute_score'), 'struct + fn present')
    assert.ok(names.has('Config::default_weight'), `impl fn qualified as Config::default_weight, got ${[...names].join(', ')}`)
    const dw = r.items.find((i) => i.qualifiedName === 'Config::default_weight')
    assert.equal(dw.commentStartLine, 10, 'rust doc comment (///) captured as adjacent comment start')
    ok('outline scoring.rs: Rust impl qualification + /// comment capture')
  }
  {
    const r = await outline.execute({ path: 'cmd/server.go' }, exec)
    assert.ok(!r.error, `outline server.go: ${r.error}`)
    const names = new Set(r.items.map((i) => i.qualifiedName))
    assert.ok(names.has('Greeter'), 'struct Greeter present')
    assert.ok(names.has('Greeter.Greet'), `receiver method qualified, got ${[...names].join(', ')}`)
    assert.ok(names.has('main'), 'func main present')
    ok('outline server.go: Go receiver method qualification')
  }
  {
    const r = await outline.execute({ path: 'src/doced.js' }, exec)
    assert.ok(!r.error)
    const greet = r.items.find((i) => i.name === 'greet')
    assert.ok(greet, 'greet present')
    assert.equal(greet.commentStartLine, 1, 'JSDoc captured')
    const shout = r.items.find((i) => i.name === 'shout')
    assert.ok(shout && shout.kind === 'function', 'const-arrow function extracted')
    ok('outline doced.js: JSDoc + const-arrow function')
  }
  {
    const r = await outline.execute({ path: 'lib/utils.py' }, exec)
    assert.ok(!r.error)
    const names = new Set(r.items.map((i) => i.qualifiedName))
    assert.ok(names.has('normalize_path'), 'python fn present')
    assert.ok(names.has('Cache'), 'python class present')
    assert.ok(names.has('Cache.put'), 'python method qualified')
    ok('outline utils.py: python defs')
  }
  {
    const r = await outline.execute({ path: 'docs/guide.md' }, exec)
    assert.match(r.error, /ffgrep/, 'unsupported language error points back to ffgrep')
    ok('outline degrade: unsupported extension → structured error')
  }

  // --- symbol-addressed read ----------------------------------------------
  {
    const r = await readSymbol.execute({ path: 'src/doced.js', symbol: 'greet' }, exec)
    assert.ok(!r.error, `read greet: ${r.error}`)
    assert.match(r.text, /\/\*\* Format a greeting\. \*\//, 'default includes leading JSDoc')
    assert.match(r.text, /export function greet/, 'includes signature')
    assert.equal(r.startLine, 1)
    const body = await readSymbol.execute({ path: 'src/doced.js', symbol: 'greet', body: true }, exec)
    assert.equal(body.startLine, 2, 'body=true trims to signature')
    assert.doesNotMatch(body.text, /Format a greeting/)
    ok('ff_read#symbol: comment-default vs body=true')
  }
  {
    const r = await readSymbol.execute({ path: 'src/store.js', symbol: 'Store.putBlob' }, exec)
    assert.ok(!r.error)
    assert.match(r.text, /putBlob\(buffer\)/)
    assert.equal(r.startLine, 7)
    const ctx = await readSymbol.execute({ path: 'src/store.js', symbol: 'Store.putBlob', context: 2 }, exec)
    assert.match(ctx.text, /getBlob\(hash\) \{/, 'context lines included')
    ok('ff_read#symbol: qualified address + context')
  }
  {
    const r = await readSymbol.execute({ path: 'src/store.js', symbol: 'noSuchSymbol' }, exec)
    assert.match(r.error, /not found/)
    const rust = await readSymbol.execute({ path: 'lib/scoring.rs', symbol: 'Config::default_weight' }, exec)
    assert.ok(!rust.error, `rust-style address failed: ${rust.error}`)
    assert.match(rust.text, /Default weight for new configs/, 'rust :: address + doc comment')
    ok('ff_read#symbol: not-found + Rust :: addressing')
  }
  {
    const tmp = path.join(FIXTURE_DIR, 'src', 'ambig.js')
    writeFileSync(tmp, 'function resolve() {\n  return 1;\n}\n\nfunction resolve() {\n  return 2;\n}\n', 'utf8')
    const amb = await readSymbol.execute({ path: 'src/ambig.js', symbol: 'resolve' }, exec)
    assert.match(amb.error, /ambiguous/, 'duplicate names return candidates')
    const picked = await readSymbol.execute({ path: 'src/ambig.js', symbol: 'resolve', line: 5 }, exec)
    assert.ok(!picked.error, `line disambiguation failed: ${picked.error}`)
    assert.match(picked.text, /return 2;/, 'line hint picks the nearest definition')
    rmSync(tmp)
    ok('ff_read#symbol: ambiguity → candidates, line hint disambiguates')
  }

  // --- find_symbol across workspace ---------------------------------------
  {
    const r = await findSymbolTool.execute({ name: 'putBlob' }, exec)
    assert.ok(!r.error, `find putBlob: ${r.error}`)
    const hit = r.items.find((i) => i.qualifiedName === 'Store.putBlob')
    assert.ok(hit, 'Store.putBlob found')
    assert.equal(hit.file, 'src/store.js')
    assert.equal(hit.startLine, 7)
    assert.ok(r.stats.includes('code files'), 'stats reported')
    ok('ff_read view=definitions: workspace scan with exact hit')
  }
  {
    const r = await findSymbolTool.execute({ name: 'Config::default_weight' }, exec)
    assert.ok(!r.error)
    assert.ok(r.items.some((i) => i.qualifiedName === 'Config::default_weight'), 'rust-style query resolves')
    const kinds = await findSymbolTool.execute({ name: 'put', kind: 'method' }, exec)
    assert.ok(!kinds.error)
    assert.ok(kinds.items.every((i) => i.kind === 'method'), 'kind filter honored')
    ok('ff_read view=definitions: rust query + kind filter')
  }

  // --- find_symbol: `path` re-roots the walk (the host-wide axis) ----------
  {
    const OUTSIDE = path.join(path.dirname(FIXTURE_DIR), '.findroot-fixture')
    rmSync(OUTSIDE, { recursive: true, force: true })
    const nested = path.join(OUTSIDE, 'pkg')
    mkdirSync(path.join(nested, 'src'), { recursive: true })
    writeFileSync(path.join(nested, 'sym.js'), 'function relocatedSymbol() {\n  return 1;\n}\n', 'utf8')
    writeFileSync(path.join(nested, 'src', 'other.js'), 'function relocatedSymbol() {\n  return 2;\n}\n', 'utf8')

    // Baseline: the default scope is the session workspace, so a tree beside it
    // is genuinely invisible. Without this the re-root assertions prove nothing.
    const inScope = await findSymbolTool.execute({ name: 'relocatedSymbol' }, exec)
    assert.ok(!inScope.error, `baseline find: ${inScope.error}`)
    assert.equal(inScope.items.length, 0, 'workspace scope does not see the outside tree')

    // An absolute directory re-roots the walk onto that tree.
    const rooted = await findSymbolTool.execute({ name: 'relocatedSymbol', path: nested }, exec)
    assert.ok(!rooted.error, `re-rooted find: ${rooted.error}`)
    assert.deepEqual(
      rooted.items.map((i) => i.file).sort(),
      ['src/other.js', 'sym.js'],
      're-rooted walk finds both definitions, paths relative to the new root',
    )

    // glob is resolved against the re-rooted tree, not the workspace.
    const globbed = await findSymbolTool.execute({ name: 'relocatedSymbol', path: nested, glob: 'src/**/*.js' }, exec)
    assert.ok(!globbed.error, `re-rooted glob: ${globbed.error}`)
    assert.deepEqual(globbed.items.map((i) => i.file), ['src/other.js'], 'glob applies relative to the search root')

    // A file path narrows the walk to that file.
    const byFile = await findSymbolTool.execute({ name: 'relocatedSymbol', path: path.join(nested, 'sym.js') }, exec)
    assert.ok(!byFile.error, `file scope: ${byFile.error}`)
    assert.deepEqual(byFile.items.map((i) => i.file), ['sym.js'], 'a file path scans just that file')

    // A bad path must fail loudly rather than silently falling back to the cwd.
    const missing = await findSymbolTool.execute({ name: 'relocatedSymbol', path: path.join(OUTSIDE, 'nope') }, exec)
    assert.match(missing.error ?? '', /path not found/, `missing path names the reason, got ${missing.error}`)

    rmSync(OUTSIDE, { recursive: true, force: true })
    ok('ff_read view=definitions: path re-roots the walk, glob follows the root, file narrows, missing path errors')
  }

  // --- content-anchored staleness (the forge principle) --------------------
  {
    const tmp = path.join(FIXTURE_DIR, 'src', 'staleness.js')
    writeFileSync(tmp, 'function first() {\n  return 1;\n}\n', 'utf8')
    const before = await outline.execute({ path: 'src/staleness.js' }, exec)
    assert.ok(before.items.some((i) => i.name === 'first'))
    // Modify WITHOUT any cache invalidation call — the next query must
    // reflect the new content because ranges anchor to current content.
    writeFileSync(tmp, 'function first() {\n  return 1;\n}\n\nfunction second() {\n  return 2;\n}\n', 'utf8')
    const after = await outline.execute({ path: 'src/staleness.js' }, exec)
    assert.ok(after.items.some((i) => i.name === 'second'), 'modified file re-parsed immediately')
    const stillFirst = after.items.find((i) => i.name === 'first')
    assert.equal(stillFirst.endLine, 3, 'unchanged symbol range stays exact')
    rmSync(tmp)
    ok('staleness floor: content change reflected with zero manual invalidation')
  }

  // --- symbol identity vs position vs content anchor (review line A) -------
  {
    const tmp = path.join(FIXTURE_DIR, 'src', 'identity.js')
    const twin = (ret) => `function resolve() {\n  return "${ret}";\n}`
    writeFileSync(tmp, `${twin('first')}\n\n${twin('second')}\n`, 'utf8')
    // Ambiguity names NUMBERED candidates; occurrence resolves without position.
    const amb = await readSymbol.execute({ path: 'src/identity.js', symbol: 'resolve' }, exec)
    assert.match(amb.error, /#1 .*L1/, `candidates numbered: ${amb.error}`)
    assert.match(amb.error, /#2 .*L5/, `candidates numbered: ${amb.error}`)
    const first = await readSymbol.execute({ path: 'src/identity.js', symbol: 'resolve', occurrence: 1 }, exec)
    assert.ok(!first.error, `occurrence=1: ${first.error}`)
    assert.match(first.text, /"first"/)
    assert.equal(first.occurrence, 1)
    const second = await readSymbol.execute({ path: 'src/identity.js', symbol: 'resolve', occurrence: 2 }, exec)
    assert.match(second.text, /"second"/)
    ok('identity layer: occurrence disambiguates same-name defs without line hints')

    // Line drift: prepend lines — occurrence still resolves the SAME
    // definitions, while the previously correct line hint now mis-resolves.
    writeFileSync(tmp, `// drift 1\n// drift 2\n// drift 3\n${twin('first')}\n\n${twin('second')}\n`, 'utf8')
    const drifted = await readSymbol.execute({ path: 'src/identity.js', symbol: 'resolve', occurrence: 1, body: true }, exec)
    assert.match(drifted.text, /"first"/)
    assert.equal(drifted.startLine, 4, 'position layer reports the fresh range (body=true skips the drift comments captured as adjacent comment block)')
    const staleHint = await readSymbol.execute({ path: 'src/identity.js', symbol: 'resolve', line: 5 }, exec)
    assert.match(staleHint.text, /"first"/, 'stale positional hint mis-resolves (expected: hint is position, not identity)')
    ok('identity vs position: occurrence survives line drift; stale line hints do not')

    // Function move: declaration ORDER is the identity anchor for same-name
    // twins — documented semantics, pinned here so drift is visible.
    writeFileSync(tmp, `${twin('second')}\n\n${twin('first')}\n`, 'utf8')
    const moved = await readSymbol.execute({ path: 'src/identity.js', symbol: 'resolve', occurrence: 2 }, exec)
    assert.match(moved.text, /"first"/, 'occurrence follows declaration order after a move')
    // Renaming the FILE breaks path-scoped identity — documented cut: the
    // identity is (path, name, occurrence); content anchors live in the
    // snapshot/ledger layer, not in symbol addresses.
    writeFileSync(path.join(FIXTURE_DIR, 'src', 'identity2.js'), `${twin('first')}\n`, 'utf8')
    const oldPath = await readSymbol.execute({ path: 'src/identity.js', symbol: 'resolve' }, exec)
    rmSync(tmp)
    assert.ok(oldPath.error || oldPath.text, 'old path addressable until deleted')
    const renamed = await readSymbol.execute({ path: 'src/identity2.js', symbol: 'resolve', occurrence: 1 }, exec)
    assert.match(renamed.text, /"first"/)
    rmSync(path.join(FIXTURE_DIR, 'src', 'identity2.js'))
    ok('identity scope: path-scoped by design (rename = new address); declaration order drives same-name identity')
  }
  {
    // find_symbol items carry occurrence so agents can chain into read_symbol.
    const tmp = path.join(FIXTURE_DIR, 'src', 'occ.js')
    writeFileSync(tmp, 'function helper() {\n  return 1;\n}\n\nfunction helper() {\n  return 2;\n}\n', 'utf8')
    const r = await findSymbolTool.execute({ name: 'helper', glob: 'src/occ.js' }, exec)
    assert.ok(!r.error, `find helper: ${r.error}`)
    assert.deepEqual(r.items.map((i) => i.occurrence), [1, 2], 'find_symbol annotates occurrence per same-name group')
    rmSync(tmp)
    ok('identity chain: view=definitions → occurrence → ff_read#Symbol')
  }
  {
    // Anonymous-by-name bindings stay addressable (const arrow captured as a
    // symbol); unassigned inline callbacks are covered by the grep→symbol
    // weld (enclosingSymbol), not by the symbol table.
    const shout = await readSymbol.execute({ path: 'src/doced.js', symbol: 'shout' }, exec)
    assert.ok(!shout.error, `const-arrow symbol: ${shout.error}`)
    assert.equal(shout.occurrence, 1)
    ok('anonymous coverage: const-arrow bindings addressable; inline callbacks via grep weld')
  }

  // --- grep → symbol weld --------------------------------------------------
  {
    const r = await grep.execute({ pattern: 'putBlob', enclosing: true }, exec)
    assert.ok(!r.error)
    const storeHit = r.items.find((i) => i.file === 'src/store.js' && i.line === 7)
    assert.ok(storeHit?.in, 'store.js definition hit annotated')
    assert.equal(storeHit.in.name, 'Store.putBlob')
    assert.equal(storeHit.in.startLine, 7)
    const loginHit = r.items.find((i) => i.file === 'src/login.js')
    assert.ok(loginHit?.in, 'call-site hit annotated too')
    assert.equal(loginHit.in.name, 'submit')
    assert.ok(loginHit.in.startLine <= loginHit.line && loginHit.line <= loginHit.in.endLine,
      'enclosing range must contain the hit line')
    ok('grep→symbol weld: definitions and call sites annotated with enclosing symbol')
  }
  {
    const r = await grep.execute({ pattern: 'putBlob' }, exec)
    assert.ok(r.items.every((i) => !i.in), 'weld off by default (no annotation without the param)')
    ok('grep→symbol weld: opt-in only')
  }

  // --- determinism ---------------------------------------------------------
  {
    const a = await outline.execute({ path: 'src/store.js' }, exec)
    const b = await outline.execute({ path: 'src/store.js' }, exec)
    assert.deepEqual(a.items, b.items)
    ok('outline determinism')
  }

  // --- parse cache internal consistency ------------------------------------
  {
    const parsed = await parseFile(path.join(FIXTURE_DIR, 'src/store.js'))
    assert.ok(parsed.value, 'parseFile resolves')
    assert.equal(flattenSymbols(parsed.value.symbols).length,
      (await outline.execute({ path: 'src/store.js' }, exec)).items.length,
      'flatten(view) consistent between direct API and tool')
    ok('parse cache API consistent with tool surface')
  }

  {
    // Vite-style query strings on relative dynamic imports resolve to the
    // real file (the real-repo eval caught this gap on VCPChat's tests).
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'forge-query-import-'))
    writeFileSync(path.join(tmpRoot, 'main.js'), "const mod = await import('./helper.js?lifecycle-test=1')\n", 'utf8')
    writeFileSync(path.join(tmpRoot, 'helper.js'), 'export const x = 1\n', 'utf8')
    const { assembleTraceGraph } = await import('../lib/tools-trace.js')
    const { graph } = await assembleTraceGraph(tmpRoot)
    const edges = graph.deps.get('main.js') ?? []
    assert.ok(edges.some((e) => e.to === 'helper.js' && e.kind === 'dynamic_import'),
      `query-string import must resolve to the real file: ${JSON.stringify(edges)}`)
    assert.equal(graph.unresolvedModules.length, 0, 'no unresolved entry for a query-suffixed real file')
    // Bare-identifier dynamic imports stay out of membership (no phantom files).
    writeFileSync(path.join(tmpRoot, 'dyn.js'), "const url = pickUrl()\nimport(url).then(() => {})\n", 'utf8')
    writeFileSync(path.join(tmpRoot, 'page.html'), '<html><body><script src="./dyn.js"></script></body></html>\n', 'utf8')
    const second = await assembleTraceGraph(tmpRoot)
    const keys = [...second.graph.membership.keys()]
    assert.ok(keys.every((k) => k === 'dyn.js' || k === 'page.html' || k.endsWith('.js')),
      `membership must not contain phantom dynamic targets: ${keys.join(', ')}`)
    assert.equal(second.graph.membership.has('url'), false, 'bare identifier target is not a member')
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    ok('module graph: query-suffixed relative imports resolve to the real file')
  }

  pool.disposeAll()
  console.log(`\n${passed} assertion groups passed`)
  process.exitCode = 0
}

main().catch((error) => {
  console.error('FATAL', error)
  process.exitCode = 1
})
