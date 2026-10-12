// Report regressions: full symbol identity, bounded reads, and durable ledger append.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { spawnSync } from 'node:child_process'
import { createFindSymbolTool, createReadSymbolTool } from '../lib/tools-symbol.js'
import { AstWorkerPool } from '../lib/ast-pool.js'
import { parseFile, fileFacts, flattenSymbols } from '../lib/ast.js'
import { storeFor, readKnownState, recordBatch, readLedgerTail, atomicWrite, prepareWorkspace } from '../lib/ledger.js'
import { ProjectRegistry, listProjects } from '../lib/projects.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(),'forge-review-regressions-'))
const previousData=process.env.DSH_FORGE_DATA_DIR, previousWorkers=process.env.DSH_FORGE_AST_WORKERS
process.env.DSH_FORGE_DATA_DIR=path.join(root,'data')
const exec={agent:{session:{header:{cwd:root,id:'review'}}}}
const workers=new AstWorkerPool()
let passed=0
const ok=message=>console.log(`ok ${++passed} - ${message}`)
try {
  fs.writeFileSync(path.join(root,'same.ts'),'interface Item { value: number }\nfunction Item() { return 7; }\n')
  const read=createReadSymbolTool(), find=createFindSymbolTool(workers)
  for(const count of ['0','2']) {
    process.env.DSH_FORGE_AST_WORKERS=count
    const result=await find.execute({name:'Item',kind:'function',limit:1},exec)
    assert.equal(result.items[0].occurrence,2)
    const hit=result.items[0]
    const back=await read.execute({path:hit.file,symbol:hit.qualifiedName,occurrence:hit.occurrence},exec)
    assert.equal(back.kind,'function');assert.match(back.text,/return 7/)
    const iface=(await find.execute({name:'Item',kind:'interface',limit:1},exec)).items[0]
    assert.equal(iface.occurrence,1)
  }
  ok('kind filtering and a one-result page preserve full-file occurrence identities in sequential and worker modes')
  fs.writeFileSync(path.join(root,'nested.ts'),'class N { Item() { return "nested"; } }\nexport function Item() { return "top"; }\n')
  const top=(await find.execute({name:'Item',kind:'function',glob:'nested.ts'},exec)).items[0]
  const topRead=await read.execute({path:top.file,symbol:top.qualifiedName,occurrence:top.occurrence},exec)
  assert.equal(topRead.kind,'function');assert.match(topRead.text,/"top"/)
  ok('a top-level qualified address cannot resolve to a nested method with the same simple name')
  for(const [ext,source,name,kind] of [
    ['h','class Widget { public: int size() { return 1; } };','Widget.size','method'],
    ['mts','export function Mts() {}','Mts','function'], ['cts','export function Cts() {}','Cts','function'],
    ['pyi','def stub(x: int) -> str: ...','stub','function'],
    ['cppm','export module widgets;\nclass ModuleWidget {};','ModuleWidget','class'],
    ['ixx','export module widgets;\nclass IxxWidget {};','IxxWidget','class'],
  ]) {
    const file=path.join(root,`sample.${ext}`);fs.writeFileSync(file,source)
    const parsed=await parseFile(file);assert.ok(parsed.value,parsed.error)
    assert.ok(flattenSymbols(parsed.value.symbols).some(symbol=>symbol.qualifiedName===name && symbol.kind===kind),ext)
    if(['h','mts','cts','pyi'].includes(ext)) assert.equal(parsed.value.partial,false,ext)
    if(['mts','cts'].includes(ext)) assert.ok((await fileFacts(file,[])).value)
  }
  ok('C++ headers, module extensions, TS module extensions and Python stubs expose real definitions and Trace facts')

  const huge=path.join(root,'huge.js');fs.writeFileSync(huge,'x'.repeat(32*1024*1024))
  let readBytes=0
  const originalRead=fs.readSync
  fs.readSync=(fd,...args)=>{const n=originalRead(fd,...args); if(fs.fstatSync(fd).ino===fs.statSync(huge).ino) readBytes+=n;return n}
  syncBuiltinESMExports()
  try { assert.match((await parseFile(huge)).error,/cap/);assert.match((await fileFacts(huge,[])).error,/cap/) }
  finally { fs.readSync=originalRead;syncBuiltinESMExports() }
  assert.equal(readBytes,0)
  ok('oversized AST and Trace-facts inputs are rejected before reading any source bytes')

  const store=storeFor(root)
  fs.mkdirSync(store.dir,{recursive:true})
  const batch={kind:'edit',reason:'validated history',actor:'test',nodes:[{file:'one.txt',op:'update',before:null,after:'b'.repeat(64),bytes:1,eol:'LF',bom:false}]}
  const history=Array.from({length:1000},(_,i)=>JSON.stringify({t:'b',id:i+1,ts:1700000000000+i,...batch})+'\n').join('')
  fs.writeFileSync(store.ledgerFile,history)
  assert.equal(readKnownState(store,'one.txt').batch,1000)
  fs.writeFileSync(store.stateFile,JSON.stringify({files:{'one.txt':{hash:'wrong',blob:'wrong',batch:0}}}))
  assert.equal(readKnownState(store,'one.txt').hash,'b'.repeat(64))
  const bytes=fs.readFileSync(store.ledgerFile)
  const committed=recordBatch(store,batch)
  assert.equal(committed.id,1001)
  assert.deepEqual(fs.readFileSync(store.ledgerFile).subarray(0,bytes.length),bytes)
  assert.equal(readKnownState(store,'one.txt').batch,1001)
  assert.throws(()=>{readLedgerTail(store)[0].reason='poisoned'},TypeError)
  ok('incremental append preserves prefix bytes, updates derived state, ignores forged state checkpoints and protects cached records')

  // Same size and restored mtime: ctime/identity must still invalidate validation.
  const valid=fs.readFileSync(store.ledgerFile,'utf8'),st=fs.statSync(store.ledgerFile)
  fs.writeFileSync(store.ledgerFile,valid.replace('"t":"b"','"t":"x"'))
  fs.utimesSync(store.ledgerFile,st.atime,st.mtime)
  assert.throws(()=>readKnownState(store,'one.txt'),/invalid ledger record/)
  assert.throws(()=>recordBatch(store,batch),/invalid ledger record/)
  fs.writeFileSync(store.ledgerFile,valid)
  assert.equal(readLedgerTail(store,Number.MAX_SAFE_INTEGER).length,1001)
  ok('external corruption anywhere in a warm ledger is fully revalidated even when size and mtime match')

  const write=fs.writeSync, prefix=fs.readFileSync(store.ledgerFile)
  let fail=true
  fs.writeSync=(fd,buffer,offset,length,position)=>{
    if(fail && fs.fstatSync(fd).ino===fs.statSync(store.ledgerFile).ino){fail=false;write(fd,buffer,offset,17,position);throw new Error('partial append')}
    return write(fd,buffer,offset,length,position)
  }
  syncBuiltinESMExports()
  try {assert.throws(()=>recordBatch(store,batch),/partial append/)}
  finally {fs.writeSync=write;syncBuiltinESMExports()}
  assert.deepEqual(fs.readFileSync(store.ledgerFile),prefix)
  assert.equal(recordBatch(store,batch).id,1002)
  ok('partial append failure restores the exact valid prefix and the next commit keeps its identity')

  for (const kind of ['file','project']) for (const phase of ['partial','before-flush','complete']) {
    const work=path.join(root,`${kind}-${phase}`);fs.mkdirSync(work)
    const registry=new ProjectRegistry()
    await registry.create(work,'.','initial','','test','strict project')
    const strictStore=storeFor(work),target=path.join(work,'file.txt'),initial=fs.readFileSync(strictStore.ledgerFile)
    fs.writeFileSync(target,'BEFORE')
    const code=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
      import {commitFiles,storeFor,putBlob} from ${JSON.stringify(new URL('../lib/ledger.js',import.meta.url).href)};
      import {ProjectRegistry} from ${JSON.stringify(new URL('../lib/projects.js',import.meta.url).href)};
      const work=${JSON.stringify(work)},target=${JSON.stringify(target)},store=storeFor(work),write=fs.writeSync,flush=fs.fsyncSync;
      fs.writeSync=(fd,buffer,offset,length,position)=>{
        if(${phase==='partial'} && fs.fstatSync(fd).ino===fs.statSync(store.ledgerFile).ino){write(fd,buffer,offset,17,position);flush(fd);process.exit(77)}
        const count=write(fd,buffer,offset,length,position);
        if(${phase==='before-flush'} && fs.fstatSync(fd).ino===fs.statSync(store.ledgerFile).ino)process.exit(77);
        return count};
      fs.fsyncSync=fd=>{flush(fd);if(${phase==='complete'} && fs.fstatSync(fd).ino===fs.statSync(store.ledgerFile).ino)process.exit(77)};
      syncBuiltinESMExports();
      if(${kind==='project'})await new ProjectRegistry().create(work,'.','second','','child','append crash');
      else {const before=Buffer.from('BEFORE'),after=Buffer.from('AFTER');
        const node={file:'file.txt',op:'update',before:putBlob(store,before).id,after:putBlob(store,after).id,bytes:5,eol:'LF',bom:false};
        commitFiles(store,{kind:'edit',reason:'append crash',actor:'child',nodes:[node]},[{file:target,before,after}])}`
    const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:30000,windowsHide:true})
    assert.equal(child.status,77,child.stderr)
    assert.ok(fs.existsSync(path.join(strictStore.dir,'ledger-append.json')))
    await prepareWorkspace(strictStore)
    const records=readLedgerTail(strictStore)
    assert.equal(records.length,phase==='partial'?1:2)
    assert.deepEqual(fs.readFileSync(strictStore.ledgerFile).subarray(0,initial.length),initial)
    assert.equal(fs.readFileSync(target,'utf8'),kind==='file' && phase!=='partial'?'AFTER':'BEFORE')
    assert.equal(listProjects(strictStore).length,kind==='project' && phase!=='partial'?2:1)
    assert.equal(fs.existsSync(path.join(strictStore.dir,'ledger-append.json')),false)
    assert.equal(fs.existsSync(path.join(strictStore.dir,'transaction.json')),false)
  }
  ok('real hard exits mid-append, before flush and after flush recover strict project/file transactions with exact committed identities')

  const protectedWork=path.join(root,'strict-unknown');fs.mkdirSync(protectedWork)
  await new ProjectRegistry().create(protectedWork,'.','protected','','test','strict unknown')
  const protectedStore=storeFor(protectedWork),protectedPrefix=fs.readFileSync(protectedStore.ledgerFile)
  fs.appendFileSync(protectedStore.ledgerFile,'{"t":"b"')
  await assert.rejects(()=>prepareWorkspace(protectedStore),/corrupt project ledger tail/)
  const unknown=fs.readFileSync(protectedStore.ledgerFile)
  const {createHash}=await import('node:crypto')
  const intentFile=path.join(protectedStore.dir,'ledger-append.json')
  fs.writeFileSync(intentFile,JSON.stringify({version:1,offset:protectedPrefix.length,prefixHash:createHash('sha256').update(protectedPrefix).digest('hex'),line:JSON.stringify({t:'b',id:2,ts:Date.now(),...batch})+'\n'}))
  // The actual suffix is a valid prefix of the intended record, so disturb it.
  fs.appendFileSync(protectedStore.ledgerFile,'UNKNOWN')
  const mismatched=fs.readFileSync(protectedStore.ledgerFile)
  await assert.rejects(()=>prepareWorkspace(protectedStore),/do not match intent/)
  assert.deepEqual(fs.readFileSync(protectedStore.ledgerFile),mismatched)
  assert.ok(fs.existsSync(intentFile));assert.ok(unknown.length>protectedPrefix.length)
  ok('strict tails without proof and unknown bytes conflicting with append intent remain preserved and fail closed')

  if(process.platform==='win32') {
    const rename=fs.renameSync,file=path.join(root,'rename.txt')
    fs.writeFileSync(file,'before');let calls=0
    fs.renameSync=(from,to)=>{if(to===file && ++calls<3)throw Object.assign(new Error('sharing violation'),{code:'EPERM'});return rename(from,to)}
    syncBuiltinESMExports()
    try {atomicWrite(file,'after')}finally{fs.renameSync=rename;syncBuiltinESMExports()}
    assert.equal(calls,3);assert.equal(fs.readFileSync(file,'utf8'),'after')
    fs.renameSync=(from,to)=>{if(to===file)throw Object.assign(new Error('persistent denial'),{code:'EPERM'});return rename(from,to)}
    syncBuiltinESMExports()
    try {assert.throws(()=>atomicWrite(file,'lost'),/persistent denial/)}finally{fs.renameSync=rename;syncBuiltinESMExports()}
    assert.equal(fs.readFileSync(file,'utf8'),'after')
    assert.equal(fs.readdirSync(root).some(name=>name.startsWith('rename.txt.forge-')),false)
    ok('bounded Windows rename retries recover transient sharing failures and preserve bytes on persistent denial')
  }
  console.log(`${passed} review regression groups passed`)
} finally {
  await workers.dispose()
  if(previousData===undefined)delete process.env.DSH_FORGE_DATA_DIR;else process.env.DSH_FORGE_DATA_DIR=previousData
  if(previousWorkers===undefined)delete process.env.DSH_FORGE_AST_WORKERS;else process.env.DSH_FORGE_AST_WORKERS=previousWorkers
  fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})
}
