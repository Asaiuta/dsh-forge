import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { jsonBytes, outputFragment, outputRows, outputPreview, OUTPUT_PAGE_BYTES } from '../src/output-budget.ts'
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-budget-'))
const workspace = path.join(temp, 'work'); fs.mkdirSync(workspace)
process.env.DSH_FORGE_DATA_DIR = path.join(temp, 'private')
const { createEditTool, createHistoryTool } = await import('../src/tools-edit.ts')
const { FinderPool } = await import('../src/core.ts')
const { storeFor, putBlob, recordBatch, gcStoreBlobs } = await import('../src/ledger.ts')
const { defineForgeTool } = await import('../src/host.ts')
const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
const pool = new FinderPool(), edit = defineForgeTool(createEditTool(pool)), history = defineForgeTool(createHistoryTool())
const runtime = Object.create(ToolRuntime.prototype); runtime.canonicalResults = new WeakMap(); runtime.concludingExecutions = new WeakSet()
const exec = {agent:{session:{header:{cwd:workspace,id:'budget-test'}}}}
let count = 0
async function test(name,fn) { await fn(); console.log('PASS',name); count++ }
async function call(tool,args) {
 const context = {...exec, arguments:args, token:{}, parent:{}}
 const value = await tool.execute(args,context), result = runtime.createSuccessResult(context,tool,value)
 assert.ok(jsonBytes(result.value) <= OUTPUT_PAGE_BYTES)
 assert.ok(Buffer.byteLength(result.content.map(p=>p.text).join('\n')) <= OUTPUT_PAGE_BYTES)
 assert.ok(!('forgePresentation' in result.value))
 return result.value
}
async function record(args) {
 let cursor, text = '', snapshot, pages = 0
 do {
  const value = await call(history,{...args,...(cursor?{cursor}:{})}), page = value.page
  assert.equal(page.offset,text.length); assert.ok(page.record.isWellFormed())
  snapshot ??= page.snapshot; assert.equal(page.snapshot,snapshot)
  text += page.record; cursor = page.nextCursor; pages++
  assert.equal(page.complete,!cursor)
 } while(cursor)
 return {value:JSON.parse(text),pages}
}
try {
 await test('JSON-escaped multilingual fragments reconstruct every character within byte limits',()=>{
  const source = ('中😀\n\r\t"\\\u0000').repeat(3000)
  let text='',offset=0
  while(offset<source.length) { const part=outputFragment(source,offset,257);assert.ok(jsonBytes(part.text)<=257);assert.ok(part.text.isWellFormed());assert.ok(part.end>offset);text+=part.text;offset=part.end }
  assert.equal(text,source)
  assert.throws(()=>outputFragment('😀',0,3),/code point/)
  const preview=outputPreview(source,240,100);assert.ok(jsonBytes(preview)<=100);assert.ok(preview.endsWith('…'));assert.ok(preview.isWellFormed())
 })
 await test('row limits bound both count and bytes, and never truncate IDs',()=>{
  const rows=Array.from({length:500},(_,i)=>({id:`id-${i}`,name:'中😀'.repeat(150)}))
  const seen=[]
  while(seen.length<rows.length) {const page=outputRows(rows,seen.length,3,()=> 'oversize');assert.ok(page.length<=3);assert.ok(jsonBytes(page)<=8192);seen.push(...page)}
  assert.deepEqual(seen,rows)
  assert.throws(()=>outputRows([{id:'x'.repeat(9000)}],0,1,()=> 'identity too large'),/identity too large/)
 })
 await test('long history metadata is explicit and losslessly reachable through bounded record pages',async()=>{
  const store=storeFor(workspace),before=putBlob(store,Buffer.from('old\n')).id,after=putBlob(store,Buffer.from('new\n')).id
  const reason=('long "reason" 中😀\n').repeat(3000)
  const batch=recordBatch(store,{kind:'edit',reason,actor:'budget-test',nodes:[{file:'record.txt',op:'update',before,after,bytes:4,eol:'LF',bom:false}]})
  const value=await call(history,{batch:batch.id});assert.match(value.note,/truncated/);assert.ok(value.page.complete)
  const full=await record({batch:batch.id,detail:'record'});assert.ok(full.pages>1);assert.deepEqual(full.value,batch)
 })
 await test('large successful edit receipt stays successful and full diagnostics remain reachable',async()=>{
  const names=Array.from({length:50},(_,i)=>`f${i}_${'X'.repeat(220)}`)
  const before=names.map(n=>`function ${n}(){ return 1 }`).join('\n')+'\n'
  fs.writeFileSync(path.join(workspace,'receipt.js'),before)
  const steps=names.map((n,i)=>({start:i+1,end:i+1,text:`function ${n}(){ return 2 }`}))
  const value=await call(edit,{path:'receipt.js',steps,reason:'large receipt fixture',receipt:'diff'})
  assert.equal(value.status,'applied');assert.equal(value.applied,50);assert.equal(value.receiptComplete,false);assert.match(value.receiptRef,/^[a-f0-9]{64}$/)
  gcStoreBlobs(storeFor(workspace))
  const full=await record({batch:value.batch,detail:'receipt',receiptRef:value.receiptRef})
  assert.ok(full.pages>1);assert.equal(full.value.reports.length,50);assert.equal(full.value.hash,value.hash)
  assert.ok(fs.readFileSync(path.join(workspace,'receipt.js'),'utf8').includes('return 2'))
  await assert.rejects(call(history,{batch:value.batch-1,detail:'receipt',receiptRef:value.receiptRef}),/does not identify/)
  await assert.rejects(call(history,{batch:value.batch,receiptRef:value.receiptRef}),/requires detail/)
 })
 console.log(`${count} output budget groups passed, 0 failed`)
} finally {pool.disposeAll();fs.rmSync(temp,{recursive:true,force:true})}
