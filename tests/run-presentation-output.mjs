import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'forge-presentation-'))
process.env.DSH_FORGE_DATA_DIR=path.join(temp,'data')
const {defineForgeTool}=await import('../src/host.ts')
const {storeFor,putBlob,recordBatch}=await import('../src/ledger.ts')
const {ToolRuntime}=await import('@deepseek-ai/dsh-tools')
const runtimes=[['development',ToolRuntime,false]]
if(process.env.DSH_FORGE_DSH_MODULES) {
 const sdk=await import(pathToFileURL(path.join(process.env.DSH_FORGE_DSH_MODULES,'dsh-tools/lib/pipeline.js')))
 runtimes.push(['installed',sdk.ToolExecutionPipeline,true])
} else console.log('installed SDK projection SKIPPED (set DSH_FORGE_DSH_MODULES)')
let count=0
try {
 for(const [label,Runtime,parentMeta] of runtimes) {
  const roots=['a','b'].map(n=>path.join(temp,`${label}-${n}`));roots.forEach(p=>fs.mkdirSync(p))
  const records=roots.map((root,i)=>{const store=storeFor(root),before=`old ${i}\n`,after=`new ${i}\n`;fs.writeFileSync(path.join(root,'file.txt'),after)
   return recordBatch(store,{kind:'edit',actor:'test',reason:'test',nodes:[{file:'file.txt',op:'update',before:putBlob(store,Buffer.from(before)).id,after:putBlob(store,Buffer.from(after)).id,bytes:6,eol:'LF',bom:false}]})})
  const observed=[]
  const provider={resolve:async absolute=>({absolute}),stat:async()=>({version:'committed'})}
  const factory={name:'ff_edit',description:'fixture',parameters:{},isConcurrencySafe:()=>true,
   output:{schema:{type:'object',additionalProperties:false,properties:{batch:{type:'integer',required:true},status:{type:'string',required:true}}},render:()=>[{type:'text',text:'applied'}]},
   execute:async(_args,exec)=>({status:'applied',batch:records[roots.indexOf(exec.agent.session.header.cwd)].id})}
  const tool=defineForgeTool(factory,undefined,{fs:provider,events:{emit:(...args)=>observed.push(args)}})
  const runtime=Object.create(Runtime.prototype);runtime.canonicalResults=new WeakMap();runtime.concludingExecutions=new WeakSet()
  const sharedArgs={}
  const entries=await Promise.all(roots.map(async(root)=>{const args=sharedArgs,exec={arguments:args,token:{},agent:{session:{header:{cwd:root}}}};return {args,exec,value:await tool.execute(args,exec)}}))
  // Deliberately project in reverse after both executions have finished. SDK clones each body value.
  for(const [i,entry] of [...entries.entries()].reverse()) {
   const result=runtime.createSuccessResult(entry.exec,tool,entry.value)
   assert.notEqual(result.value,entry.value);assert.deepEqual(result.value,{status:'applied',batch:1,workspace:roots[i]})
   assert.equal(result.meta.diffs[0].oldText,`old ${i}\n`);assert.equal(result.meta.diffs[0].newText,`new ${i}\n`)
   assert.ok(!JSON.stringify(tool.output.schema).includes('forgePresentation'))
   const saved=JSON.parse(JSON.stringify(result));fs.writeFileSync(path.join(roots[i],'file.txt'),'changed live\n')
   const replay=tool.presentResult(entry.args,saved);assert.equal(replay.diffs[0].newText,`new ${i}\n`)
   const freshTool=defineForgeTool(factory);assert.deepEqual(freshTool.presentResult({},saved),replay)
   assert.equal(runtime.createSuccessResult(entry.exec,tool,entry.value).meta.diffs[0].newText,`new ${i}\n`)
   const parent=runtime.createSuccessResult({...entry.exec,parent:{}},tool,entry.value)
   assert.equal(Boolean(parent.meta),parentMeta);assert.ok(!JSON.stringify(parent.value).includes('oldText'))
  }
  assert.equal(observed.length,2);assert.ok(observed.every(e=>e[0]==='fs/observed'))
  console.log('PASS',label,'cloned values, concurrent metadata, parent context, observation, restart replay');count++
 }
 console.log(`${count} presentation output groups passed, 0 failed`)
} finally {fs.rmSync(temp,{recursive:true,force:true})}
