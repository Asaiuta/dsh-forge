/** Original snapshot inline/elided target decisions and persistent multi-pick tickets. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { applyEditSteps } from '../lib/edit-engine.js'
import { createEditTool, createResolveTool, createRollbackTool } from '../lib/tools-edit.js'
import { FinderPool } from '../lib/core.js'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'forge-targets-'))
process.env.DSH_FORGE_DATA_DIR = path.join(sandbox, 'data')
const exec = { agent: { session: { header: { cwd: sandbox, id: 'targets' } } }, token: {} }
const pool = new FinderPool(), edit = createEditTool(pool), resolve = createResolveTool(pool), undo = createRollbackTool(pool)
let passed = 0
const ok = label => console.log(`ok ${++passed} - ${label}`)
try {
  const inline = applyEditSteps('const value = OLD;\n', [{ find:'OLD',replaceWith:'NEW' }])
  assert.equal(inline.ok,true); assert.equal(inline.text,'const value = NEW;\n')
  const mixed = applyEditSteps('first OLD;\nsecond\n', [{find:'OLD',replaceWith:'NEW'}, {start:2,text:'changed'}])
  assert.equal(mixed.ok,true); assert.equal(mixed.text,'first NEW;\nchanged\n')
  assert.equal(applyEditSteps('first OLD;\n', [{find:'OLD',replaceWith:'NEW'},{start:1,text:'changed'}]).ok,false)
  ok('literal inline fallback and disjoint line edits share one original snapshot and refuse overlap')
  assert.match(applyEditSteps('first OLD;\n', [{ find:'OLD',replaceWith:'NEW' }], { mode:'bestEffort' }).reason, /require atomic/)
  assert.match(applyEditSteps('prefix '+ 'a'.repeat(102), [{ find:'a',replaceWith:'b',inline:true }]).reason, /100 candidates/)
  ok('inline bestEffort is explicitly refused rather than silently changing atomicity')
  const elided = applyEditSteps('function f() {\n  A\n  B\n}\n', [{find:'function f() {\n...\n}',replaceWith:'function g() {}'}])
  assert.equal(elided.ok,true); assert.equal(elided.text,'function g() {}\n')
  const overlapping = applyEditSteps('begin\none\nend\nend\n', [{find:'begin\n...\nend',replaceWith:'replacement'}])
  assert.equal(overlapping.ok,false); assert.equal(overlapping.ambiguity.candidates.length,2)
  ok('elided whole-block targets bind first/last anchors and expose alternative end matches as ambiguity')
  const file=path.join(sandbox,'same.txt');fs.writeFileSync(file,'prefix OLD + OLD suffix\r\n')
  const result=await edit.execute({path:'same.txt',steps:[{find:'OLD',replaceWith:'NEW'}],reason:'inline'},exec)
  assert.equal(result.status,'ticket');assert.equal(result.candidates.length,2)
  const runtime=Object.create(ToolRuntime.prototype);runtime.canonicalResults=new WeakMap();runtime.concludingExecutions=new WeakSet()
  runtime.createSuccessResult(exec,defineTool(edit),result)
  const changed=await resolve.execute({ticket:result.ticket,all:true},exec)
  assert.equal(changed.status,'applied',changed.error);assert.equal(changed.applied,2)
  runtime.createSuccessResult(exec,defineTool(resolve),changed)
  assert.equal(fs.readFileSync(file,'utf8'),'prefix NEW + NEW suffix\r\n')
  await undo.execute({batch:String(changed.batch),dryRun:false,reason:'undo'},exec)
  assert.equal(fs.readFileSync(file,'utf8'),'prefix OLD + OLD suffix\r\n')
  ok('same-line ambiguity carries exact offsets; all=true applies disjoint candidates and byte rollback')
  fs.writeFileSync(file,'same\nsame\nsame\n')
  const ticket=await edit.execute({path:'same.txt',steps:[{find:'same',replaceWith:'changed'}],reason:'multi'},exec)
  const selected=await resolve.execute({ticket:ticket.ticket,choices:[0,2]},exec)
  assert.equal(selected.status,'applied',selected.error);assert.equal(fs.readFileSync(file,'utf8'),'changed\nsame\nchanged\n')
  ok('multiple choices replace selected whole-line candidates while preserving the unchosen one')
  fs.writeFileSync(file,'aaaa\n')
  const overlap=await edit.execute({path:'same.txt',steps:[{find:'aa',replaceWith:'x'}],reason:'overlap'},exec)
  assert.equal(overlap.status,'ticket');assert.equal(overlap.candidates.length,3)
  assert.match((await resolve.execute({ticket:overlap.ticket,all:true},exec)).error,/overlap/)
  assert.equal(fs.readFileSync(file,'utf8'),'aaaa\n')
  assert.match((await resolve.execute({ticket:overlap.ticket,choice:0,all:true},exec)).error,/exactly one/)
  fs.writeFileSync(file,'aa\n')
  assert.ok((await resolve.execute({ticket:overlap.ticket,choice:0},exec)).error)
  assert.equal(fs.readFileSync(file,'utf8'),'aa\n')
  ok('overlapping all-selection, conflicting selectors and stale raw-byte identities never write')
  console.log(`${passed} target groups passed`)
} finally {pool.disposeAll();fs.rmSync(sandbox,{recursive:true,force:true})}
