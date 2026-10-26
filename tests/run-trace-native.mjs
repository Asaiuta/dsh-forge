/** Independent byte-layout fixtures for native boundary evidence. No binary is executed. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { extractTraceFile } from '../lib/trace-facts.js'
import { assembleTraceGraph, createTraceTool, resetTraceFactsCache } from '../lib/tools-trace.js'
import { AstWorkerPool } from '../lib/ast-pool.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-native-'))
const previous = process.env.DSH_FORGE_AST_WORKERS, pool = new AstWorkerPool()
const exec = { agent: { session: { header: { cwd: root } } } }
const put = (name, bytes) => { const file = path.join(root, name); fs.writeFileSync(file, bytes); return file }
const read = async (name, bytes) => {
  const result = await extractTraceFile(put(name, bytes))
  assert.equal(result.parseErrors, 0, name); assert.equal(result.value?.kind, 'binary', name)
  return result.value.metadata
}
let passed = 0
const ok = message => console.log(`ok ${++passed} - ${message}`)

// PE32/PE32+: one .rdata section, a named forwarder, one ordinal-only export,
// one missing address, and a terminated import descriptor array.
function pe(wide = true) {
  const b = Buffer.alloc(1536), header = 0x80, optional = header + 24
  const size = wide ? 240 : 224, dirs = optional + (wide ? 112 : 96), section = optional + size
  b.write('MZ'); b.writeUInt32LE(header, 0x3c); b.writeUInt32LE(0x4550, header)
  b.writeUInt16LE(wide ? 0x8664 : 0x14c, header + 4); b.writeUInt16LE(1, header + 6); b.writeUInt16LE(size, header + 20)
  b.writeUInt16LE(wide ? 0x20b : 0x10b, optional); b.writeUInt32LE(512, optional + 60); b.writeUInt32LE(16, dirs - 4)
  b.writeUInt32LE(0x1000, dirs); b.writeUInt32LE(256, dirs + 4); b.writeUInt32LE(0x1200, dirs + 8); b.writeUInt32LE(40, dirs + 12)
  b.write('.rdata', section); b.writeUInt32LE(0x1000, section + 12); b.writeUInt32LE(1024, section + 16); b.writeUInt32LE(512, section + 20)
  b.writeUInt32LE(7, 512 + 16); b.writeUInt32LE(3, 512 + 20); b.writeUInt32LE(1, 512 + 24)
  b.writeUInt32LE(0x1040, 512 + 28); b.writeUInt32LE(0x1050, 512 + 32); b.writeUInt32LE(0x1060, 512 + 36)
  b.writeUInt32LE(0x1080, 576); b.writeUInt32LE(0x1300, 580); b.writeUInt32LE(0, 584)
  b.writeUInt32LE(0x1070, 592); b.writeUInt16LE(0, 608); b.write('shared\0', 624); b.write('KERNEL32.Sleep\0', 640)
  b.writeUInt32LE(0x1240, 1024 + 12); b.writeUInt32LE(0x1280, 1024 + 16); b.write('KERNEL32.dll\0', 1088)
  return b
}

// ELF: null / .dynstr / .dynsym / .dynamic / ordinary .symtab sections.
// The static-only global, undefined import, hidden and local symbols are decoys.
function elf(wide = true, little = true) {
  const b = Buffer.alloc(2048), sh = 256, stride = wide ? 64 : 40, symbol = wide ? 24 : 16
  const u16 = (n, at) => b[little ? 'writeUInt16LE' : 'writeUInt16BE'](n, at)
  const u32 = (n, at) => b[little ? 'writeUInt32LE' : 'writeUInt32BE'](n, at)
  const word = (n, at) => wide ? b[little ? 'writeBigUInt64LE' : 'writeBigUInt64BE'](BigInt(n), at) : u32(n, at)
  b.set([127, 69, 76, 70, wide ? 2 : 1, little ? 1 : 2, 1]); u16(3, 16); u16(wide ? 62 : 3, 18)
  word(sh, wide ? 40 : 32); u16(stride, wide ? 58 : 46); u16(5, wide ? 60 : 48)
  const section = (i, type, offset, size, link, entry) => {
    const at = sh + stride * i; u32(type, at + 4); word(offset, at + (wide ? 24 : 16)); word(size, at + (wide ? 32 : 20)); u32(link, at + (wide ? 40 : 24)); word(entry, at + (wide ? 56 : 36))
  }
  const strings = '\0shared\0undefined\0hidden\0local\0libdemo.so\0static_only\0'
  b.write(strings, 768)
  section(1, 3, 768, Buffer.byteLength(strings), 0, 0); section(2, 11, 896, symbol * 5, 1, symbol)
  section(3, 6, 1152, wide ? 32 : 16, 1, wide ? 16 : 8); section(4, 2, 1280, symbol * 2, 1, symbol)
  const entry = (at, name, info = 0x12, visibility = 0, defined = 1) => {
    u32(strings.indexOf(name), at); b[at + (wide ? 4 : 12)] = info; b[at + (wide ? 5 : 13)] = visibility; u16(defined, at + (wide ? 6 : 14))
  }
  entry(896 + symbol, 'shared'); entry(896 + symbol * 2, 'undefined', 0x12, 0, 0)
  entry(896 + symbol * 3, 'hidden', 0x12, 2); entry(896 + symbol * 4, 'local', 0x02)
  word(1, 1152); word(strings.indexOf('libdemo.so'), 1152 + (wide ? 8 : 4)); entry(1280 + symbol, 'static_only')
  return b
}
const wasm = Buffer.from('0061736d01000000010401600000020c0103656e7604726561640000070a01067368617265640000', 'hex')
try {
  process.env.DSH_FORGE_AST_WORKERS = '0'
  for (const wide of [false, true]) {
    const data = await read(wide ? 'wide.dll' : 'narrow.dll', pe(wide))
    assert.deepEqual(data.exports, [
      { name: 'shared', kind: 'forwarder', ordinal: 7, forwarder: 'KERNEL32.Sleep' },
      { name: '#8', kind: 'export', ordinal: 8 },
    ]); assert.deepEqual(data.imports, ['KERNEL32.dll']); assert.deepEqual(data.limitations, [])
  }
  ok('PE32 and PE32+ distinguish named forwarders, ordinal-only exports, empty slots and library dependencies')
  for (const wide of [false, true]) for (const little of [false, true]) {
    const data = await read(`elf-${wide}-${little}.so`, elf(wide, little))
    assert.deepEqual(data.exports, [{ name: 'shared', kind: 'function' }]); assert.deepEqual(data.imports, ['libdemo.so'])
  }
  ok('ELF32/64 in both byte orders excludes undefined, hidden, local and ordinary symbol-table globals')
  assert.equal(WebAssembly.validate(wasm), true)
  const web = await read('module.wasm', wasm)
  assert.deepEqual(web.exports, [{ name: 'shared', kind: 'function' }]); assert.deepEqual(web.imports, ['env'])
  const req = createRequire(import.meta.url)
  const grammar = await read('grammar.wasm', fs.readFileSync(req.resolve('@tree-sitter-grammars/tree-sitter-lua/tree-sitter-lua.wasm')))
  assert.ok(grammar.exports.some(ref => ref.name === 'tree_sitter_lua'))
  ok('WebAssembly imports/exports parse from a valid fixture and the real Lua grammar without instantiation')
  const peBad = pe(); peBad.writeUInt16LE(99, 608)
  const peString = pe(); peString.writeUInt32LE(0x13fc, 592); peString.fill(65, 1532)
  const peHeader = pe(); peHeader.writeUInt16LE(112, 0x80 + 20)
  const elfBad = elf(); elfBad.writeBigUInt64LE(4n, 256 + 2 * 64 + 56)
  const wasmBad = Buffer.from(wasm); wasmBad[27] = 0xff
  const corrupt = [peBad, peString, peHeader, elfBad, wasmBad, Buffer.from('0061736d01000000078080808010', 'hex'), Buffer.from('not a binary'), pe().subarray(0, 510)]
  for (const [n, bytes] of corrupt.entries()) {
    const result = await extractTraceFile(put(`bad-${n}.dll`, bytes))
    assert.equal(result.value, null, `bad-${n}`); assert.equal(result.parseErrors, 1)
    fs.unlinkSync(path.join(root, `bad-${n}.dll`))
  }
  const stripped = elf(); stripped.writeBigUInt64LE(0n, 40)
  const partial = await read('stripped.elf', stripped); assert.equal(partial.exports.length, 0); assert.equal(partial.limitations.length, 1)
  ok('Malformed ordinals, strings, strides, names, lengths and signatures fail closed; sectionless ELF reports partial metadata')
  const oversized = path.join(root, 'oversized.dll'), fd = fs.openSync(oversized, 'w')
  fs.ftruncateSync(fd, 32 * 1024 * 1024 + 1); fs.closeSync(fd)
  assert.equal((await extractTraceFile(oversized)).parseErrors, 1); fs.unlinkSync(oversized)
  ok('The 32 MiB binary read cap rejects oversized inputs')
  put('native.rs', '#[unsafe(no_mangle)]\npub extern "C" fn shared() {}\n#[export_name = "renamed"]\npub extern "C" fn original() {}\nextern "C" { #[link_name = "external"] fn foreign(); }\nextern "C" fn mangled() {}\nfn normal() {}\n')
  put('native.cpp', 'extern "C" { int declared(), second(); int shared() { return 1; } extern "C++" { int cpp_only() { return 0; } } }\n__declspec(dllexport) int exported() { return 1; }\nint normal() { return 0; }\nNODE_API_MODULE(addon, Init);\n')
  put('native.go', 'package main\nimport "C"\n//export shared\nfunc shared() {}\n//export Wrong\nfunc private() {}\n//export Separated\n\nfunc Separated() {}\n')
  const before = await assembleTraceGraph(root)
  assert.equal(before.parseErrors, 0); assert.equal(before.partialFiles, 1)
  const refs = before.graph.ffi
  assert.ok(refs.get('shared').some(ref => ref.lang === 'rust' && ref.kind === 'source-export' && ref.abi === 'C'))
  assert.ok(refs.get('renamed').some(ref => ref.symbol === 'original'))
  assert.ok(refs.get('external').some(ref => ref.kind === 'foreign-declaration'))
  assert.ok(refs.get('mangled').some(ref => ref.kind === 'c-linkage-definition'))
  assert.ok(refs.get('declared').some(ref => ref.kind === 'c-linkage-declaration'))
  assert.ok(refs.get('second').some(ref => ref.kind === 'c-linkage-declaration'))
  assert.ok(refs.get('shared').some(ref => ref.lang === 'cpp' && ref.kind === 'c-linkage-definition'))
  assert.ok(refs.get('exported').some(ref => ref.kind === 'source-export'))
  assert.ok(refs.get('addon').some(ref => ref.kind === 'module-registration'))
  assert.ok(refs.get('shared').some(ref => ref.abi === 'cgo')); assert.ok(!refs.has('normal') && !refs.has('Wrong') && !refs.has('private') && !refs.has('Separated') && !refs.has('cpp_only'))
  ok('Rust, C/C++, N-API and cgo facts retain declaration kind, ABI and renamed source identities')
  const trace = await createTraceTool().execute({ target: 'ffi:shared' }, exec)
  assert.equal(trace.found, true); assert.equal(trace.ffi.total, 10); assert.equal(trace.ffi.truncated, false)
  assert.match(trace.text, /未验证 ABI/); assert.equal(trace.incomplete, true)
  assert.ok(!before.graph.deps.get('native.rs')?.some(ref => ref.to.endsWith('.dll')))
  const file = await createTraceTool().execute({ target: 'file:wide.dll' }, exec)
  assert.match(file.text, /PE/); assert.match(file.text, /KERNEL32.dll/)
  const absent = await createTraceTool().execute({ target: 'ffi:not_present' }, exec)
  assert.equal(absent.found, false); assert.equal(absent.ffi.total, 0)
  ok('ffi: keeps same-name source and binary evidence separate; file: shows metadata and no cross-language call edge is invented')
  const replacement = pe(); replacement.write('changed\0', 624); put('wide.dll', replacement)
  const changed = await assembleTraceGraph(root)
  assert.notEqual(changed.graph, before.graph); assert.equal(changed.graph.ffi.get('shared').length, 9)
  resetTraceFactsCache(); process.env.DSH_FORGE_AST_WORKERS = '2'
  assert.deepEqual(await assembleTraceGraph(root, { workers: pool }), changed)
  ok('Binary content edits invalidate the graph; sequential and worker metadata agree')
} finally {
  await pool.dispose()
  if (previous === undefined) delete process.env.DSH_FORGE_AST_WORKERS; else process.env.DSH_FORGE_AST_WORKERS = previous
  assert.ok(path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('forge-trace-native-'))
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
console.log(`${passed} Trace native groups passed`)
