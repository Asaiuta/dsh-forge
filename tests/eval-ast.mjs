/**
 * Stage-2 quality floors for dsh-forge AST layer — asserted, exit 1 on miss,
 * tighten-only (same policy as eval-quality).
 *
 * The oracle here is hand-derived fixture ground truth (generation-time line
 * numbers from make-fixture), independent of the extraction logic.
 */

import assert from 'node:assert/strict'
import { writeFileSync, rmSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { FinderPool } from '../lib/core.js'
import { createGrepTool } from '../lib/tools.js'
import { createReadTool } from '../lib/tools-read.js'
import { outlineView, definitionsView } from './lib/read-views.mjs'
import { symbolReader } from './lib/symbol-read.mjs'
import { parseFile, flattenSymbols } from '../lib/ast.js'
import { buildFixture, FIXTURE_DIR } from './make-fixture.mjs'

const truth = buildFixture()
const pool = new FinderPool()
const exec = { agent: { session: { header: { cwd: FIXTURE_DIR } } } }
const outline = outlineView(createReadTool())
const findSymbolTool = definitionsView(createReadTool())
const readSymbol = symbolReader(createReadTool)
const grep = createGrepTool(pool)

let floors = 0
function floor(label, detail) {
  floors++
  console.log(`  FLOOR ${floors} PASS - ${label}: ${detail}`)
}

async function main() {
  // Floor 1: outline ground truth — exact {file → qualifiedName/kind/range}
  // sets, hand-derived from the fixture generator.
  {
    const expected = {
      'src/store.js': [
        ['Store', 'class', 2, 16],
        ['Store.hasBlob', 'method', 3, 5],
        ['Store.putBlob', 'method', 7, 11],
        ['Store.getBlob', 'method', 13, 15],
      ],
      'src/doced.js': [
        ['greet', 'function', 2, 4],
        ['shout', 'function', 7, 7],
      ],
      'lib/scoring.rs': [
        ['Config', 'struct', 1, 3],
        ['Config::weight', 'field', 2, 2],
        ['compute_score', 'function', 5, 7],
        ['impl Config', 'impl', 9, 14],
        ['Config::default_weight', 'function', 11, 13],
      ],
      'cmd/server.go': [
        ['Greeter', 'struct', 5, 7],
        ['Greeter.Name', 'field', 6, 6],
        ['Greeter.Greet', 'method', 9, 11],
        ['main', 'function', 13, 16],
      ],
    }
    for (const [file, syms] of Object.entries(expected)) {
      const r = await outline.execute({ path: file }, exec)
      assert.ok(!r.error, `outline ${file}: ${r.error}`)
      const got = r.items.map((i) => [i.qualifiedName, i.kind, i.startLine, i.endLine])
      assert.deepEqual(got, syms, `outline ground truth drift for ${file}`)
    }
  }
  floor('outline-truth', '4 files × exact qualified names, kinds, ranges')

  // Floor 2: range invariants — three properties that must hold for every
  // symbol: (a) the signature line names the symbol, (b) child ranges nest
  // inside the parent, (c) top-level definitions' slices re-parse standalone
  // and re-derive the symbol (methods are excluded: a lone method body is not
  // valid standalone syntax in most grammars).
  {
    const files = ['src/store.js', 'src/doced.js', 'lib/scoring.rs', 'cmd/server.go', 'lib/utils.py', 'src/nested/deep.ts']
    let checked = 0
    let roundtripped = 0
    for (const file of files) {
      const parsed = await parseFile(path.join(FIXTURE_DIR, file))
      assert.ok(parsed.value, `parse ${file}`)
      const lines = parsed.value.text.split('\n')
      const all = flattenSymbols(parsed.value.symbols)
      for (const sym of all) {
        const sigLine = lines[sym.startLine - 1] ?? ''
        // go receiver methods write `func (g Greeter) Greet()` — the qualified
        // name's parts all appear on the signature line, just not contiguously.
        const nameParts = sym.name.split('.')
        assert.ok(nameParts.every((p) => sigLine.includes(p)),
          `signature line of ${sym.qualifiedName} (${file}) must name it; got "${sigLine}"`)
        assert.ok(sym.endLine >= sym.startLine, `${sym.qualifiedName} range ordered`)
        if (sym.commentStartLine !== undefined) {
          assert.ok(sym.commentStartLine < sym.startLine, 'comment precedes signature')
        }
        checked++
      }
      // nesting: parent ranges contain their children
      for (const sym of all) {
        for (const child of sym.children) {
          assert.ok(child.startLine >= sym.startLine && child.endLine <= sym.endLine,
            `child ${child.qualifiedName} must nest inside ${sym.qualifiedName}`)
        }
      }
      // standalone round-trip for top-level definitions
      for (const sym of parsed.value.symbols) {
        if (!['class', 'function', 'struct', 'interface'].includes(sym.kind)) continue
        const slice = lines.slice(sym.startLine - 1, sym.endLine).join('\n')
        const tmp = path.join(FIXTURE_DIR, 'src', '.slice-probe' + path.extname(file))
        writeFileSync(tmp, slice, 'utf8')
        const re = await parseFile(tmp)
        rmSync(tmp)
        assert.ok(re.value, `slice of ${sym.qualifiedName} must parse`)
        const names = flattenSymbols(re.value.symbols).map((s) => s.name)
        assert.ok(names.includes(sym.name),
          `re-parsed slice of ${sym.qualifiedName} must contain the symbol; got ${names.join(',')}`)
        roundtripped++
      }
    }
    assert.ok(checked >= 15 && roundtripped >= 5, `coverage too thin: ${checked} symbols, ${roundtripped} roundtrips`)
    floor('range-invariants', `${checked} symbols: signature names, children nest; ${roundtripped} top-level slices round-trip`)
  }

  // Floor 3: comment semantics — default includes the leading comment,
  // body=true trims to the signature, and both stay within true content.
  {
    const def = await readSymbol.execute({ path: 'src/doced.js', symbol: 'greet' }, exec)
    assert.equal(def.startLine, truth.docedGreetComment)
    assert.match(def.text, /Format a greeting/)
    const body = await readSymbol.execute({ path: 'src/doced.js', symbol: 'greet', body: true }, exec)
    assert.equal(body.startLine, truth.docedGreet)
    const raw = readFileSync(path.join(FIXTURE_DIR, 'lib/scoring.rs'), 'utf8').split('\n')
    const rs = await readSymbol.execute({ path: 'lib/scoring.rs', symbol: 'Config::default_weight' }, exec)
    assert.equal(rs.startLine, truth.rsDefaultWeightComment)
    assert.equal(rs.endLine, truth.rsDefaultWeight + 2)
    for (const line of rs.text.split('\n')) {
      if (line.trim() === '') continue
      assert.ok(raw.includes(line), 'lines come from real content')
      void line
    }
    floor('comment-semantics', 'JSDoc default-in, body trims, rust doc comment anchored to ground truth')
  }

  // Floor 4: staleness — modify then immediately query; ranges must track
  // current content with zero manual invalidation.
  {
    const tmp = path.join(FIXTURE_DIR, 'src', '.staleness.js')
    writeFileSync(tmp, 'function alpha() {\n  return 1;\n}\n', 'utf8')
    const before = await outline.execute({ path: 'src/.staleness.js' }, exec)
    assert.equal(before.items.length, 1)
    writeFileSync(tmp, 'function alpha() {\n  return 1;\n}\n\nfunction beta() {\n  return 2;\n}\n', 'utf8')
    const after = await outline.execute({ path: 'src/.staleness.js' }, exec)
    assert.equal(after.items.length, 2, 'new symbol visible immediately')
    const beta = await readSymbol.execute({ path: 'src/.staleness.js', symbol: 'beta' }, exec)
    assert.equal(beta.startLine, 5, 'addressed read uses fresh ranges')
    rmSync(tmp)
    floor('staleness', 'content-anchored: edit → immediate correct re-parse')
  }

  // Floor 5: FindSymbol recall across languages.
  {
    const cases = [
      { name: 'putBlob', file: 'src/store.js', qualified: 'Store.putBlob', start: 7 },
      { name: 'Store::put_blob', file: null, qualified: null, start: null }, // rust-style spelling of a JS name: no match expected
      { name: 'putUser', file: 'src/nested/deep.ts', qualified: 'UserService.putUser', start: 9 },
      { name: 'compute_score', file: 'lib/scoring.rs', qualified: 'compute_score', start: 5 },
      { name: 'Greeter.Greet', file: 'cmd/server.go', qualified: 'Greeter.Greet', start: 9 },
      { name: 'normalize_path', file: 'lib/utils.py', qualified: 'normalize_path', start: 4 },
    ]
    for (const c of cases) {
      const r = await findSymbolTool.execute({ name: c.name }, exec)
      assert.ok(!r.error, `find ${c.name}: ${r.error}`)
      if (c.file === null) {
        assert.equal(r.items.length, 0, `${c.name} should not match across languages`)
        continue
      }
      const hit = r.items.find((i) => i.file === c.file && i.qualifiedName === c.qualified)
      assert.ok(hit, `${c.name} → ${c.file}#${c.qualified}; got ${JSON.stringify(r.items.map((i) => i.file + '#' + i.qualifiedName))}`)
      assert.equal(hit.startLine, c.start)
    }
    floor('find-symbol-recall', '5 cross-language hits exact; JS name not matched by rust spelling')
  }

  // Floor 6: degradation and filters.
  {
    const md = await outline.execute({ path: 'docs/guide.md' }, exec)
    assert.match(md.error, /ffgrep/)
    const missing = await readSymbol.execute({ path: 'src/store.js', symbol: 'definitelyNotHere' }, exec)
    assert.match(missing.error, /not found/)
    const kindFiltered = await findSymbolTool.execute({ name: 'Blob', kind: 'method' }, exec)
    assert.ok(!kindFiltered.error && kindFiltered.items.length > 0)
    assert.ok(kindFiltered.items.every((i) => i.kind === 'method'))
    floor('degrade-and-filter', 'unsupported ext → ffgrep pointer; missing symbol → clean error; kind filter exact')
  }

  // Floor 7: weld correctness — annotations carry enclosing ranges that
  // contain the hit, and the fixture ground truth matches exactly.
  {
    const r = await grep.execute({ pattern: 'putBlob', enclosing: true }, exec)
    assert.ok(!r.error)
    assert.ok(r.items.length >= 3, 'definition + call site + prose present')
    let annotated = 0
    for (const item of r.items) {
      if (!item.in) continue
      annotated++
      assert.ok(item.in.startLine <= item.line && item.line <= item.in.endLine,
        `${item.file}:${item.line} inside ${item.in.name}`)
    }
    assert.ok(annotated >= 2, `weld annotated ≥2 hits, got ${annotated}`)
    const storeHit = r.items.find((i) => i.file === 'src/store.js' && i.line === 7)
    assert.equal(storeHit.in.name, 'Store.putBlob')
    const loginHit = r.items.find((i) => i.file === 'src/login.js')
    assert.equal(loginHit.in.name, 'submit')
    floor('weld-correctness', `${annotated} hits annotated, ground-truth enclosing symbols exact`)
  }

  // Floor 8: determinism.
  {
    const a = await outline.execute({ path: 'lib/scoring.rs' }, exec)
    const b = await outline.execute({ path: 'lib/scoring.rs' }, exec)
    assert.deepEqual(a.items, b.items)
    const c = await findSymbolTool.execute({ name: 'put' }, exec)
    const d = await findSymbolTool.execute({ name: 'put' }, exec)
    assert.deepEqual(c.items, d.items)
    floor('determinism', 'outline and find_symbol byte-identical across runs')
  }

  pool.disposeAll()
  console.log(`\nall ${floors} AST floors passed`)
  process.exitCode = 0
}

main().catch((error) => {
  console.error('EVAL FAILURE:', error?.message ?? error)
  process.exitCode = 1
})
