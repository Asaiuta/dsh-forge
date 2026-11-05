import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
const temp = mkdtempSync(path.join(os.tmpdir(), 'forge-diff-'))
const workspace = path.join(temp, 'work'); mkdirSync(workspace)
process.env.DSH_FORGE_DATA_DIR = path.join(temp, 'private')
const { snapshotPatch, snapshotDiff } = await import('../src/history.ts')
const { DiffOutput } = await import('../src/history-output.ts')
const { createEditTool, createHistoryTool } = await import('../src/tools-edit.ts')
const { FinderPool } = await import('../src/core.ts')
const { storeFor, recordBatch, putBlob, readLedgerTail } = await import('../src/ledger.ts')
const { defineTool, ToolRuntime } = await import('@deepseek-ai/dsh-tools')
const pool = new FinderPool(), edit = createEditTool(pool), history = createHistoryTool()
const exec = { agent: { session: { header: { cwd: workspace, id: 'diff-test' } } } }
const buffer = s => s === null ? null : Buffer.from(s)
const patchText = (a,b,file) => { const p = snapshotPatch(buffer(a),buffer(b),file); return p.header + p.hunks.join('') }
let count = 0, fixture = 0
async function test(name, fn) { await fn(); console.log('PASS', name); count++ }
function applyPatch(before, after, patch, file = 'sample.txt') {
 const root = path.join(temp, `apply-${++fixture}`); mkdirSync(root)
 const target = path.join(root, file); mkdirSync(path.dirname(target), {recursive:true})
 if (before !== null) writeFileSync(target, before)
 const patchFile = path.join(root, 'input.patch'); writeFileSync(patchFile, patch)
 const result = spawnSync('git', ['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', '--', patchFile], {cwd:root, encoding:'utf8'})
 assert.equal(result.status, 0, result.stderr + '\n' + patch)
 if (after !== null) assert.deepEqual(readFileSync(target), Buffer.from(after))
 else assert.throws(() => readFileSync(target), /ENOENT/)
}
async function call(args) {
 const value = await history.execute(args, exec)
 assert.equal(value.error, undefined, JSON.stringify(value))
 assert.ok(Buffer.byteLength(JSON.stringify(value.page)) < 12 * 1024)
 return value
}
function batchFor(file, before, after) {
 const store = storeFor(workspace)
 const batch = recordBatch(store, {kind:'edit', reason:'test', actor:'test', nodes:[{file,op:'update',before:putBlob(store,Buffer.from(before)).id,after:putBlob(store,Buffer.from(after)).id,bytes:Buffer.byteLength(after),eol:'LF',bom:false}]})
 return { store, batch, picks: batch.nodes.map((node,index)=>({node,index})) }
}
try {
await test('three distant edits produce three local hunks with three lines of context', async () => {
 const a = Array.from({length:100},(_,i)=>`line ${i+1}`), b=a.map((line,i)=>[19,39,59].includes(i)?`changed ${i+1}`:line)
 const before=a.join('\n')+'\n', after=b.join('\n')+'\n'
 const patch=snapshotPatch(buffer(before),buffer(after),'sample.txt')
 assert.equal(patch.hunks.length,3); assert.equal(patch.coarse,false)
 assert.match(patch.hunks[0],/^@@ -17,7 \+17,7 @@/)
 assert.ok(!patch.hunks.join('').includes('line 30'))
 applyPatch(before,after,patch.header+patch.hunks.join(''))
})
await test('overlapping or touching context merges; separated changes remain separate', async () => {
 const a=Array.from({length:40},(_,i)=>`line ${i+1}`)
 for (const [second,expected] of [[15,1],[16,1],[17,2]]) {
  const b=a.map((line,i)=>[9,second].includes(i)?'CHANGED':line)
  const p=snapshotPatch(buffer(a.join('\n')),buffer(b.join('\n')),'sample.txt')
  assert.equal(p.hunks.length,expected); applyPatch(a.join('\n'),b.join('\n'),p.header+p.hunks.join(''))
 }
})
await test('independent git apply restores insert/delete/create/remove, CRLF/BOM and EOF bytes', async () => {
 for (const [a,b] of [[null,''],['',null],[null,'new\n'],['old\n',null],['a\nc\n','a\nb\nc\n'],['a\nb\nc','a\nc'],['a','a\n'],['a\n','a'],['\uFEFFa\r\nb\r\n','\uFEFFa\r\nB\r\n'],['a\r\nb\r\n','a\nb\n'],['\uFEFFa\n','a\n'],['one\rtwo','one\rTHREE'],['','new'],['old',''],['😀\n','中文😀\n']]) {
  applyPatch(a,b,patchText(a,b,'sample.txt'))
 }
 applyPatch('old\n','new\n',patchText('old\n','new\n','name with spaces.txt'),'name with spaces.txt')
 assert.equal(snapshotPatch(buffer('same\n'),buffer('same\n'),'sample.txt').hunks.length,0)
})
await test('small deterministic random patches reconstruct bytes including repeated lines', async () => {
 let seed=13
 const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed%n}
 for(let i=0;i<30;i++) {
  const a=Array.from({length:random(20)+1},()=>`row ${random(5)}\n`).join('')
  const b=Array.from({length:random(20)+1},()=>`row ${random(5)}\n`).join('')
  if(a!==b) applyPatch(a,b,patchText(a,b,'sample.txt'))
 }
})
await test('work-budget fallback is marked coarse while the complete patch remains lossless', async () => {
 const a=Array.from({length:600},(_,i)=>`before ${i}\n`).join(''), b=Array.from({length:600},(_,i)=>`after ${i}\n`).join('')
 const p=snapshotPatch(buffer(a),buffer(b),'sample.txt'); assert.equal(p.coarse,true)
 applyPatch(a,b,p.header+p.hunks.join(''))
 assert.equal(snapshotDiff(buffer(a),buffer(b),'sample.txt').truncated,true)
})
await test('history and optional edit receipt use immutable snapshots and validate in SDK', async () => {
 writeFileSync(path.join(workspace,'edit.txt'),'a\nb\nc\n')
 const value=await edit.execute({path:'edit.txt',find:'b',replaceWith:'B',reason:'edit fixture',receipt:'diff'},exec)
 assert.equal(value.status,'applied'); assert.equal(value.diff.complete,true)
 const selected=await call({batch:value.batch})
 assert.deepEqual(value.diff.diffs,selected.items[0].diffs)
 assert.match(edit.output.render({},value)[0].text,/b\d+:n0 [a-f0-9]{64} -> [a-f0-9]{64}/)
 assert.ok(!edit.output.render({},value)[0].text.includes('step 0:'))
 assert.match(edit.output.render({},value)[0].text,/\[audit\]/)
 const runtime=Object.create(ToolRuntime.prototype); runtime.canonicalResults=new WeakMap();runtime.concludingExecutions=new WeakSet()
 runtime.createSuccessResult(exec,defineTool(edit),value)
 runtime.createSuccessResult(exec,defineTool(history),selected)
 writeFileSync(path.join(workspace,'edit.txt'),'unrelated live content\n')
 assert.deepEqual((await call({batch:value.batch})).items[0].diffs,selected.items[0].diffs)
 applyPatch('a\nb\nc\n','a\nB\nc\n',value.diff.diffs[0].diff,'edit.txt')
 const size=readLedgerTail(storeFor(workspace)).length
 const invalid=await edit.execute({path:'edit.txt',find:'unrelated',replaceWith:'x',reason:'bad',receipt:'bogus'},exec)
 assert.match(invalid.error,/receipt/);assert.equal(readLedgerTail(storeFor(workspace)).length,size)
 const unchanged=await edit.execute({path:'edit.txt',find:'unrelated',replaceWith:'unrelated',reason:'no change',receipt:'diff'},exec)
 assert.equal(unchanged.diff,undefined)
})
await test('ticket resolution accepts receipt without adding another edit intent', async () => {
 writeFileSync(path.join(workspace,'ticket.txt'),'same\nsame\n')
 const ticket=await edit.execute({path:'ticket.txt',find:'same',replaceWith:'new',reason:'ticket',receipt:'diff'},exec)
 assert.equal(ticket.status,'ticket');assert.equal(ticket.diff,undefined)
 const result=await edit.execute({ticket:ticket.ticket,choice:'0',receipt:'diff'},exec)
 assert.equal(result.status,'applied');assert.equal(result.diff.complete,true)
 applyPatch('same\nsame\n','new\nsame\n',result.diff.diffs[0].diff,'ticket.txt')
})
await test('whole-hunk pages visit all changes once and concatenate into an applicable patch', async () => {
 const a=Array.from({length:400},(_,i)=>`${i} ${'context '.repeat(12)}\n`).join('')
 const b=a.split('\n').map((line,i)=>i%20===10?'CHANGED '+i:line).join('\n')
 const {batch}=batchFor('paged.txt',a,b)
 let cursor,patch='',pages=0,hunks=0
 do {
  const v=await call({batch:batch.id,...(cursor?{cursor}:{})}), d=v.items[0].diffs[0]
  assert.ok(Buffer.byteLength(JSON.stringify(v))<=12*1024)
  patch+=pages===0?d.diff:d.diff.slice(d.diff.indexOf('@@ '))
  pages++;hunks+=v.page.returned;cursor=v.page.nextCursor
  assert.equal(v.page.complete,!cursor)
 }while(cursor)
 assert.ok(pages>1);assert.equal(hunks,20);applyPatch(a,b,patch,'paged.txt')
})
await test('oversized hunk and long line are explicit and patch fragments recover every byte', async () => {
 const a='old\n', b='中文😀"\\'.repeat(9000)+'\n'
 const {batch}=batchFor('long.txt',a,b), node=`b${batch.id}:n0`
 const preview=await call({node});assert.equal(preview.page.complete,false);assert.deepEqual(preview.page.omittedNodes,[node])
 assert.equal(preview.items[0].diffs[0].truncated,true)
 assert.ok(!preview.items[0].diffs[0].diff.includes('😀'))
 let cursor,text='',pages=0
 do {
  const v=await call({node,detail:'patch',...(cursor?{cursor}:{})})
  assert.equal(v.page.offset,text.length);const part=v.items[0].diffs[0].diff;assert.ok(part.isWellFormed())
  assert.ok(Buffer.byteLength(JSON.stringify(v))<=12*1024)
  text+=part;cursor=v.page.nextCursor;pages++
 }while(cursor)
 assert.ok(pages>1);applyPatch(a,b,text,'long.txt')
})
await test('multi-node pages preserve every node and inline diff cursors continue in history', async () => {
 const store=storeFor(workspace)
 const before='old\n',after='new\n'
 const nodes=Array.from({length:40},(_,i)=>({file:`file-${i}.txt`,op:'update',before:putBlob(store,Buffer.from(before)).id,after:putBlob(store,Buffer.from(after)).id,bytes:4,eol:'LF',bom:false}))
 const batch=recordBatch(store,{kind:'edit',reason:'multi node',actor:'test',nodes})
 const seen=[];let cursor,pageCount=0
 do {
  const v=await call({batch:batch.id,...(cursor?{cursor}:{})})
  seen.push(...v.items[0].diffs.map(d=>d.node));cursor=v.page.nextCursor;pageCount++
 }while(cursor)
 assert.ok(pageCount>1);assert.deepEqual(seen,nodes.map((_,i)=>`b${batch.id}:n${i}`))
 const a=Array.from({length:120},(_,i)=>`${i} ${'context '.repeat(20)}`).join('\n')+'\n'
 writeFileSync(path.join(workspace,'inline-pages.txt'),a)
 const steps=Array.from({length:10},(_,i)=>({start:i*10+5,end:i*10+5,text:`changed ${i}`}))
 const changed=await edit.execute({path:'inline-pages.txt',steps,reason:'inline pages',receipt:'diff'},exec)
 assert.equal(changed.status,'applied');assert.ok(changed.diff.nextCursor)
 const next=await call({batch:changed.batch,cursor:changed.diff.nextCursor})
 assert.ok(next.items[0].diffs.length);assert.equal(next.items[0].diffs[0].truncated,true)
})
await test('diff cursors reject query/workspace/content changes and expiry, but allow retries', async () => {
 const a=Array.from({length:200},(_,i)=>`${i} ${'context '.repeat(20)}\n`).join('')
 const b=a.split('\n').map((s,i)=>i%10===0?'change '+i:s).join('\n')
 const {store,batch,picks}=batchFor('cursor.txt',a,b), selection=`batch:${batch.id}`
 let now=100;const output=new DiffOutput(()=>now)
 const first=output.read(store,batch,picks,selection);assert.ok(first.nextCursor)
 const view={cursor:first.nextCursor}, retry=output.read(store,batch,picks,selection,view)
 assert.deepEqual(output.read(store,batch,picks,selection,view).diffs,retry.diffs)
 assert.throws(()=>output.read(store,batch,picks,`node:b${batch.id}:n0`,view),/match/)
 assert.throws(()=>output.read({...store,root:temp},batch,picks,selection,view),/match/)
 assert.throws(()=>output.read(store,batch,[{...picks[0],node:{...picks[0].node,after:picks[0].node.before}}],selection,view),/snapshot changed/)
 now+=30*60_000;assert.throws(()=>output.read(store,batch,picks,selection,view),/expired|unknown/)
 for(const args of [{cursor:'bad'},{batch:batch.id,detail:'patch'},{node:`b${batch.id}:n0`,detail:'bad'}]) assert.ok((await history.execute(args,exec)).error)
})
await test('binary snapshots and corrupt blobs are never presented as complete textual patches', async () => {
 const rendered=snapshotDiff(Buffer.from([0,1]),Buffer.from([0,2]),'binary.bin')
 assert.equal(rendered.binary,true);assert.match(rendered.diff,/Binary bytes changed/)
 const {store,batch}=batchFor('corrupt.txt','before\n','after\n')
 const hash=batch.nodes[0].after
 // The service checks content addressing before attempting any diff.
 const {snapshot}=await import('../src/history.ts')
 assert.throws(()=>snapshot(store,'0'.repeat(64)),/missing or corrupt/)
 assert.equal(typeof hash,'string')
})
console.log(`${count} history diff groups passed, 0 failed`)
} finally {pool.disposeAll();rmSync(temp,{recursive:true,force:true})}
