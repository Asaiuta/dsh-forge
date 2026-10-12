/** Hand-authored truth for all 11 grammars and declared symbol kinds. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { parseFile, flattenSymbols, sliceSymbol } from '../lib/ast.js'
const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'forge-languages-'))
const cases = [
  ['sample.js', 'const obj = { field: 1, method() {}, fn: () => 1 };\nlet value=1;\n', [['obj','object'],['obj.field','field'],['obj.method','method'],['obj.fn','method'],['value','variable']]],
  ['sample.ts', 'interface I { field:string; method():void; }\nclass C { field=1; }\ntype Alias = I;\n', [['I','interface'],['I.field','field'],['I.method','method'],['C','class'],['C.field','field'],['Alias','type']]],
  ['sample.tsx', 'export function View() { return <div />; }\n', [['View','function']]],
  ['sample.py', 'value = 1\nclass C:\n field = 1\n def method(self):\n  local = 1\n', [['value','variable'],['C','class'],['C.field','field'],['C.method','method']]],
  ['sample.rs', 'const X:i32=1;\nstatic Y:i32=2;\nstruct S { field:i32 }\nimpl S { fn run() {} }\n', [['X','variable'],['Y','variable'],['S','struct'],['S::field','field'],['impl S','impl'],['S::run','function']]],
  ['sample.go', 'package p\ntype S struct { Field int }\nvar Value int\nconst X=1\ntype I interface { Run() }\n', [['S','struct'],['S.Field','field'],['Value','variable'],['X','variable'],['I','interface'],['I.Run','method']]],
  ['sample.c', '// doc\nstruct S { int field; };\ntypedef struct S Alias;\nenum E { One, Two };\nint value;\nint add(int a) { int local=1; return a+local; }\n', [['S','struct'],['S.field','field'],['Alias','type'],['E','enum'],['E.One','field'],['E.Two','field'],['value','variable'],['add','function']]],
  ['sample.cpp', 'namespace N {\nclass C { public: int field; C() {} int run() { return field; } };\nusing Alias = C;\nint value=1;\nint C::outside() { return 1; }\n}\n', [['N','module'],['N.C','class'],['N.C.field','field'],['N.C.C','method'],['N.C.run','method'],['N.Alias','type'],['N.value','variable'],['N.C.outside','function']]],
  ['Sample.java', '/** doc */\nclass C {\n int field;\n C() {}\n void run() {}\n interface I { void method(); }\n enum E { A, B }\n}\n', [['C','class'],['C.field','field'],['C.C','method'],['C.run','method'],['C.I','interface'],['C.I.method','method'],['C.E','enum'],['C.E.A','field'],['C.E.B','field']]],
  ['Sample.cs', 'namespace N {\n class C {\n int field;\n public int Property { get; set; }\n C() {}\n void Run() {}\n }\n interface I { void Method(); }\n}\n', [['N','module'],['N.C','class'],['N.C.field','field'],['N.C.Property','field'],['N.C.C','method'],['N.C.Run','method'],['N.I','interface'],['N.I.Method','method']]],
  ['sample.lua', '-- doc\nlocal value = 1\nlocal function add(x)\n return x\nend\nfunction Obj:run()\n return self.x\nend\nlocal Obj = { method = function(x) return x end, field=1 }\n', [['value','variable'],['add','function'],['Obj.run','method'],['Obj','object'],['Obj.method','method'],['Obj.field','field']]],
]
let passed = 0
try {
  for (const [name, source, expected] of cases) {
    const file = path.join(sandbox, name)
    fs.writeFileSync(file, '\uFEFF' + source.replaceAll('\n', '\r\n'))
    const parsed = await parseFile(file)
    assert.ok(parsed.value, parsed.error); assert.equal(parsed.value.partial, false, name)
    const flat = flattenSymbols(parsed.value.symbols)
    assert.deepEqual(flat.map(item => [item.qualifiedName,item.kind]), expected, name)
    for (const item of flat) {
      assert.ok(item.startLine <= item.endLine)
      assert.ok(sliceSymbol(parsed.value, item, true).includes(item.name.replace(/^impl /, '').split('.').at(-1)), item.qualifiedName)
      for (const child of item.children) assert.ok(child.startLine >= item.startLine && child.endLine <= item.endLine)
    }
    if (['Sample.java','sample.c'].includes(name)) assert.equal(flat[0].commentStartLine, 1)
    console.log(`ok ${++passed} - ${name}: exact names/kinds and normalized ranges`)
  }
  const refs = path.join(sandbox, 'references.cpp'); fs.writeFileSync(refs, 'void call() { Other obj; obj.run(); }\n')
  assert.deepEqual(flattenSymbols((await parseFile(refs)).value.symbols).map(item=>item.name), ['call'])
  console.log(`ok ${++passed} - references, parameter identifiers and function locals do not become definitions`)
  console.log(`${passed} language groups passed`)
} finally { fs.rmSync(sandbox, { recursive: true, force: true }) }
