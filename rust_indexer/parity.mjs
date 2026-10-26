/**
 * Parity harness: sidecar (Rust tree-sitter) vs the WASM parse path in lib/ast.js.
 * For each JS-family file, both sides produce a symbol tree + signature map and
 * the two must match exactly (offsets, comment capture, qualification, children).
 *
 * Requires: `node build.mjs` already run (lib/ current), and the sidecar binary
 * at rust_indexer/bin/dsh_forge_indexer.exe.
 *
 * Run under full access (child_process spawn + piped stdio): the sidecar is a
 * stdio JSON-lines process.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFileSearch, detectLanguage, findSymbol, symbolOccurrences, outlineView } from '../lib/ast.js'

const EXE = fileURLToPath(new URL('./bin/dsh_forge_indexer.exe', import.meta.url))

// --- sidecar client ---------------------------------------------------------
class Sidecar {
  #child
  #seq = 1
  #pending = new Map()
  #buf = ''
  #stderr = ''
  #err = null
  #exit = null
  constructor(exe) {
    this.#child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.#child.stderr.on('data', (d) => { this.#stderr += d })
    this.#child.stdout.on('data', (d) => {
      this.#buf += d
      let nl
      while ((nl = this.#buf.indexOf('\n')) >= 0) {
        const line = this.#buf.slice(0, nl)
        this.#buf = this.#buf.slice(nl + 1)
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        const resolve = this.#pending.get(msg.id)
        if (resolve) { this.#pending.delete(msg.id); resolve(msg) }
      }
    })
    this.#child.on('error', (e) => { this.#err = e })
    this.#child.on('exit', (code) => { this.#exit = code })
  }
  request(method, params = {}) {
    const id = this.#seq++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, (m) => m.ok ? resolve(m) : reject(new Error(m.error)))
      this.#child.stdin.write(JSON.stringify({ id, method, ...params }) + '\n')
    })
  }
  async parseBatch(files) {
    const r = await this.request('parseBatch', { files })
    const byPath = new Map()
    for (const item of r.results) byPath.set(item.absPath, item)
    return byPath
  }
  async findSymbols(files, name, kinds = null) {
    return this.request('findSymbols', { files, name, kinds })
  }
  close() { try { this.#child.kill() } catch { /* already gone */ } }
}

// --- canonical projection (undefined == absent) -----------------------------
function proj(sym) {
  const out = {
    name: sym.name,
    qualifiedName: sym.qualifiedName,
    kind: sym.kind,
    startLine: sym.startLine,
    endLine: sym.endLine,
    startOffset: sym.startOffset,
    endOffset: sym.endOffset,
    children: (sym.children ?? []).map(proj),
  }
  if (sym.commentStartLine !== undefined) out.commentStartLine = sym.commentStartLine
  if (sym.commentStartOffset !== undefined) out.commentStartOffset = sym.commentStartOffset
  if (sym.sharedDeclaration !== undefined) out.sharedDeclaration = sym.sharedDeclaration
  if (sym.listMember !== undefined) out.listMember = sym.listMember
  return out
}

function sigObj(signatures) {
  const out = {}
  for (const [k, v] of signatures) out[k] = v
  return out
}

/** Project a whole symbol list (`proj` maps ONE symbol). */
const projTree = (symbols) => symbols.map(proj)

// --- extra coverage samples -------------------------------------------------
const cases = mkdtempSync(path.join(tmpdir(), 'dsh-forge-parity-'))
writeFileSync(path.join(cases, 'extra.ts'), [
  'export enum Color { Red, Green, Blue }',
  'export type ID = string | number;',
  'export abstract class Base {',
  '  abstract run(): void;',
  '}',
  'export interface Api {',
  '  start(): void;',
  '  readonly name: string;',
  '}',
].join('\n') + '\n')
writeFileSync(path.join(cases, 'extra.js'), [
  'export const handlers = {',
  '  onClick() { return 1; },',
  '  count: 5,',
  '};',
  'class Counter {',
  '  count = 0;',
  '  *gen() { yield 1; }',
  '}',
].join('\n') + '\n')
writeFileSync(path.join(cases, 'extra.tsx'), [
  'import React from "react";',
  'export const View: React.FC = (props) => {',
  '  return <div>{props.children}</div>;',
  '};',
].join('\n') + '\n')

// The exact hand-authored truth samples from tests/run-languages.mjs, written
// with the same BOM + CRLF normalization that suite exercises, so the sidecar
// is checked against the same bytes the WASM path is certified on.
const LANG_SAMPLES = [
  ['sample.js', 'const obj = { field: 1, method() {}, fn: () => 1 };\nlet value=1;\n'],
  ['sample.ts', 'interface I { field:string; method():void; }\nclass C { field=1; }\ntype Alias = I;\n'],
  ['sample.tsx', 'export function View() { return <div />; }\n'],
  ['sample.py', 'value = 1\nclass C:\n field = 1\n def method(self):\n  local = 1\n'],
  ['sample.rs', 'const X:i32=1;\nstatic Y:i32=2;\nstruct S { field:i32 }\nimpl S { fn run() {} }\n'],
  ['sample.go', 'package p\ntype S struct { Field int }\nvar Value int\nconst X=1\ntype I interface { Run() }\n'],
  ['sample.c', '// doc\nstruct S { int field; };\ntypedef struct S Alias;\nenum E { One, Two };\nint value;\nint add(int a) { int local=1; return a+local; }\n'],
  ['sample.cpp', 'namespace N {\nclass C { public: int field; C() {} int run() { return field; } };\nusing Alias = C;\nint value=1;\nint C::outside() { return 1; }\n}\n'],
  ['Sample.java', '/** doc */\nclass C {\n int field;\n C() {}\n void run() {}\n interface I { void method(); }\n enum E { A, B }\n}\n'],
  ['Sample.cs', 'namespace N {\n class C {\n int field;\n public int Property { get; set; }\n C() {}\n void Run() {}\n }\n interface I { void Method(); }\n}\n'],
  ['sample.lua', '-- doc\nlocal value = 1\nlocal function add(x)\n return x\nend\nfunction Obj:run()\n return self.x\nend\nlocal Obj = { method = function(x) return x end, field=1 }\n'],
]
for (const [name, source] of LANG_SAMPLES) {
  writeFileSync(path.join(cases, name), '\uFEFF' + source.replaceAll('\n', '\r\n'))
}

const fixture = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', 'tests', '.fixture')
const files = [
  path.join(fixture, 'src/store.js'),
  path.join(fixture, 'src/validate.js'),
  path.join(fixture, 'src/login.js'),
  path.join(fixture, 'src/doced.js'),
  path.join(fixture, 'src/nested/deep.ts'),
  path.join(cases, 'extra.ts'),
  path.join(cases, 'extra.js'),
  path.join(cases, 'extra.tsx'),
  ...LANG_SAMPLES.map(([name]) => path.join(cases, name)),
]

const sidecar = new Sidecar(EXE)
const side = await sidecar.parseBatch(files)

let passed = 0
try {
  for (const file of files) {
    const lang = detectLanguage(file)
    const wasm = await parseFileSearch(file)
    assert.ok(wasm.value, `WASM parse failed for ${path.basename(file)}: ${wasm.error}`)
    const sideItem = side.get(file)
    if (!sideItem) {
      console.log(`\nFAIL ${path.basename(file)}: sidecar missing result for ${file}`)
      process.exitCode = 1
      continue
    }
    if (sideItem.error) {
      console.log(`\nFAIL ${path.basename(file)}: sidecar error ${sideItem.error}`)
      process.exitCode = 1
      continue
    }
    try {
      assert.deepStrictEqual(projTree(sideItem.symbols), projTree(wasm.value.symbols))
      assert.deepStrictEqual(sideItem.signatures ?? {}, sigObj(wasm.value.signatures))
      assert.equal(sideItem.lang, lang)
      assert.equal(sideItem.partial ?? false, wasm.value.partial ?? false)
      passed++
      console.log(`  ok ${path.basename(file)} (${sideItem.symbols.length} symbols, kind=${lang})`)
    } catch (e) {
      console.log(`\nFAIL ${path.basename(file)}: ${e.message.split('\n')[0]}`)
      console.log('  wasm   :', JSON.stringify(projTree(wasm.value.symbols)))
      console.log('  sidecar:', JSON.stringify(projTree(sideItem.symbols)))
      console.log('  sig wasm   :', JSON.stringify(sigObj(wasm.value.signatures)))
      console.log('  sig sidecar:', JSON.stringify(sideItem.signatures ?? {}))
      process.exitCode = 1
    }
  }

  // --- findSymbols parity: match + occurrence items must line up 1:1 -------
  const queries = ['greet', 'Store', 'putBlob', 'name', 'default', 'run', 'Color',
    'value', 'field', 'Obj', 'add', 'X', 'Alias', 'C', 'method', 'Run', 'outside']
  for (const q of queries) {
    const sideR = await sidecar.findSymbols(files, q, null)
    const ref = []
    for (const file of files) {
      const wasm = await parseFileSearch(file)
      if (!wasm.value) continue
      const occ = symbolOccurrences(wasm.value.symbols)
      for (const sym of findSymbol(wasm.value.symbols, q, false)) {
        ref.push({
          absPath: file,
          qualifiedName: sym.qualifiedName,
          kind: sym.kind,
          occurrence: occ.get(sym),
          startLine: sym.startLine,
          endLine: sym.endLine,
          ...(sym.commentStartLine !== undefined ? { commentStartLine: sym.commentStartLine } : {}),
          signature: wasm.value.signatures.get(sym.startLine) ?? '',
        })
      }
    }
    try {
      assert.deepStrictEqual(sideR.items, ref, `findSymbols mismatch for "${q}"`)
      passed++
      console.log(`  ok findSymbols "${q}" (${sideR.items.length} hits)`)
    } catch (e) {
      console.log(`\nFAIL findSymbols "${q}"`)
      console.log('  wasm   :', JSON.stringify(ref))
      console.log('  sidecar:', JSON.stringify(sideR.items))
      process.exitCode = 1
    }
  }
// --- outline parity: outlineOf is a pure projection of the (equal) trees --
  {
    const file = path.join(fixture, 'src/store.js')
    const wasm = await parseFileSearch(file)
    const sideItem = side.get(file)
    const strip = (items) => items.map(({ children, startOffset, endOffset, sharedDeclaration, listMember, commentStartOffset, ...item }) => item)
    for (const opt of [{}, { depth: 1 }, { kind: 'method' }]) {
      const w = strip(outlineView(wasm.value.symbols, opt))
      const s = strip(outlineView(sideItem.symbols, opt))
      try {
        assert.deepStrictEqual(s, w, `outline parity ${JSON.stringify(opt)}`)
        passed++
        console.log(`  ok outline store.js ${JSON.stringify(opt)} (${w.length} rows)`)
      } catch (e) {
        console.log(`\nFAIL outline store.js ${JSON.stringify(opt)}`)
        console.log('  wasm   :', JSON.stringify(w))
        console.log('  sidecar:', JSON.stringify(s))
        process.exitCode = 1
      }
    }
  }
} finally {
  sidecar.close()
  rmSync(cases, { recursive: true, force: true })
}
console.log(`\n${passed} checks passed (${files.length} file trees + findSymbols + outline views)`)
// Rely on process.exitCode (set on failure) + natural event-loop drain: a
// forced process.exit() races the sidecar child handle teardown on Windows.