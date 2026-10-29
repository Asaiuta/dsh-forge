/** Real host contracts and adversarial local I/O/concurrency regressions. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { spawnSync } from 'node:child_process'
import { apply } from '../lib/index.js'
import { FinderPool, withFileLock } from '../lib/core.js'
import { createEditTool, createRollbackTool, createHistoryTool } from '../lib/tools-edit.js'
import { createGrepTool, createFindTool } from '../lib/tools.js'
import { createReadTool } from '../lib/tools-read.js'
import { outlineView, definitionsView } from './lib/read-views.mjs'
import { singleSymbolView } from './lib/symbol-read.mjs'
import { parseFile, flattenSymbols } from '../lib/ast.js'
import { storeFor, putBlob, getBlob, commitFiles, readLedgerTail, recoverStore, recordBatch, referencedBlobIds, gcStoreBlobs, purgeStore } from '../lib/ledger.js'
import { loadTicket } from '../lib/tickets.js'
import { applyEditSteps } from '../lib/edit-engine.js'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

const sandbox = fs.mkdtempSync(path.join(tmpdir(), 'forge-regressions-'))
const work = path.join(sandbox, 'work')
fs.mkdirSync(work)
process.env.DSH_FORGE_DATA_DIR = path.join(sandbox, '.dsh', 'forge')
const exec = { agent: { session: { header: { cwd: work, id: 'regression' } } }, token: {} }
const pool = new FinderPool()
const edit = createEditTool(pool), resolve = edit, rollback = createRollbackTool(pool)
const store = storeFor(work)
let passed = 0
const ok = name => console.log(`ok ${++passed} - ${name}`)
const file = name => path.resolve(work, name)
const existsSync = p => fs.existsSync(p)
const put = (name, bytes) => { fs.mkdirSync(path.dirname(file(name)), { recursive: true }); fs.writeFileSync(file(name), bytes) }
const read = name => fs.readFileSync(file(name), 'utf8')
const editLine = (name, text) => edit.execute({ path: name, steps: [{ start: 1, text }], reason: 'regression' }, exec)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const runtime = Object.create(ToolRuntime.prototype)
runtime.canonicalResults = new WeakMap()
runtime.concludingExecutions = new WeakSet()
const definitions = [], disposers = []

async function main() {
  for (const disposable of apply({ fs: { resolve: async file => ({ targetKey: file, displayPath: file }), processPath: target => target.targetKey,
      processPathFromHostPath: file => file },
    tools: { register(def) { definitions.push(def) } }, commands: { register(def) { assert.equal(def.name, 'forge-status') } } })) {
    assert.equal(typeof disposable === 'function' || disposable === undefined || disposable === null, true)
  }
  assert.equal(definitions.length, 10)
  assert.deepEqual(new Set(definitions.map(d => d.name)), new Set(['ffgrep','fffind','ffedit','ffhistory','ffrollback','ff_file','ff_read','fftrace','ffcheck','ff_cards']))
  ok('plugin mounts every tool through the installed SDK')
  async function call(name, args) {
    const def = definitions.find(d => d.name === name)
    const ctx = { ...exec, arguments: args, token: {} }
    const value = await def.execute(args, ctx)
    const result = runtime.createSuccessResult(ctx, def, value)
    assert.ok(Array.isArray(result.content)); assert.ok(result.content.every(c => c.type === 'text'))
    return value
  }
  put('one.js', 'function One() {}\nfunction Two() {}\n')
  for (const [name,args] of [
    ['ffgrep',{pattern:'One',enclosing:true}],['fffind',{pattern:'one.js'}],['ffgrep',{patterns:['One','Two']}],
    ['ff_read',{view:'outline',path:'one.js'}],['ff_read',{view:'definitions',symbol:'One'}],['ff_read',{path:'one.js',symbol:'One'}],
    ['ffedit',{path:'one.js',steps:[{start:1,text:'function Uno() {}'}],reason:'host'}],['ffhistory',{}],
    ['ffrollback',{batch:'last',reason:'host'}],['ffrollback',{batch:'last',reason:'host',dryRun:false}],
    ['ffedit',{path:'one.js',steps:[{start:1,text:'function One() {}'}],reason:'no-op'}],
  ]) await call(name,args)
  ok('SDK materializes search/symbol/edit/history/rollback and no-op outputs')
  for (const [name,args] of [['ffgrep',{pattern:''}],['ff_read',{view:'outline',path:'missing.txt'}],['ffedit',{path:'one.js',steps:[{start:1,text:'x'}],reason:''}],['ffedit',{ticket:'bad',choice:'0'}]]) {
    await assert.rejects(() => definitions.find(d => d.name === name).execute(args,exec))
  }
  ok('tool failures use the SDK exception channel')
  put('dup.txt','A\nB\nA\nB\n')
  const ticket = await call('ffedit',{path:'dup.txt',steps:[{find:'A',replaceWith:'AA'},{find:'B',replaceWith:'BB'}],reason:'multiple'})
  const next = await call('ffedit',{ticket:ticket.ticket,choice:'0'})
  assert.equal(next.status,'ticket'); assert.equal(loadTicket(next.ticket).decisions.length,1)
  const done = await call('ffedit',{ticket:next.ticket,choice:'1'})
  assert.equal(done.status,'applied'); assert.equal(read('dup.txt'),'AA\nB\nA\nBB\n')
  ok('multiple ambiguity decisions persist and SDK validates both ticket and resolved result')
  put('stale.txt','TARGET\nother\nTARGET\n')
  const stale = await edit.execute({path:'stale.txt',steps:[{find:'TARGET',replaceWith:'PLUGIN'}],reason:'stale'},exec)
  put('stale.txt','other\nTARGET\n')
  const refused = await resolve.execute({ticket:stale.ticket,choice:'0'},exec)
  assert.ok(refused.error); assert.equal(read('stale.txt'),'other\nTARGET\n')
  ok('stale ticket cannot retarget the remaining unique occurrence')
  put('simultaneous.txt','A\nA\n')
  const simultaneous=await edit.execute({path:'simultaneous.txt',steps:[{find:'A',replaceWith:'B'}],reason:'one decision'},exec)
  const choices=await Promise.all([resolve.execute({ticket:simultaneous.ticket,choice:'0'},exec),resolve.execute({ticket:simultaneous.ticket,choice:'1'},exec)])
  assert.equal(choices.filter(r=>r.status==='applied').length,1);assert.equal(choices.filter(r=>r.error).length,1)
  assert.equal(read('simultaneous.txt'),'B\nA\n')
  ok('concurrent resolution consumes a ticket once')
  put('restart.txt','A\nA\n')
  const restart=await edit.execute({path:'restart.txt',steps:[{find:'A',replaceWith:'B'}],reason:'restart'},exec)
  const restartCode=`import {createEditTool} from ${JSON.stringify(new URL('../lib/tools-edit.js',import.meta.url).href)};
    const result=await createEditTool({peekMain(){return null}}).execute(${JSON.stringify({ticket:restart.ticket,choice:'1'})},${JSON.stringify(exec)});
    if(result.status!=='applied')throw Error(JSON.stringify(result));`
  const restarted=spawnSync(process.execPath,['--input-type=module','-e',restartCode],{encoding:'utf8',timeout:30000})
  assert.equal(restarted.status,0,restarted.stderr);assert.equal(read('restart.txt'),'A\nB\n')
  ok('persisted ambiguity ticket resolves from a fresh process')
  put('bytes.txt',Buffer.from([65,10,66,255,10]))
  assert.ok((await editLine('bytes.txt','changed')).error)
  assert.equal(fs.readFileSync(file('bytes.txt')).toString('hex'),'410a42ff0a')
  put('raw.txt','ORIGINAL\n'); const rawEdit = await editLine('raw.txt','PLUGIN')
  const binary = Buffer.from([65,10,66,255,0,10]); put('raw.txt',binary)
  const back = await rollback.execute({batch:String(rawEdit.batch),dryRun:false,reason:'raw'},exec)
  assert.equal(back.status,'applied'); assert.equal(read('raw.txt'),'ORIGINAL\n')
  await rollback.execute({batch:String(back.newBatch),dryRun:false,reason:'redo raw'},exec)
  assert.deepEqual(fs.readFileSync(file('raw.txt')),binary)
  ok('invalid UTF-8 edits refuse; rollback and redo preserve arbitrary raw bytes')
  const outside = path.join(sandbox,'outside.txt'); fs.writeFileSync(outside,'outside\n')
  const outsideEdit = await editLine(outside,'changed')
  assert.equal(outsideEdit.status,'applied')
  assert.ok((await createHistoryTool().execute({},exec)).items.some(i=>i.batch===outsideEdit.batch))
  await rollback.execute({batch:String(outsideEdit.batch),dryRun:false,reason:'outside'},exec)
  assert.equal(fs.readFileSync(outside,'utf8'),'outside\n')
  ok('outside edits remain addressable through the session history and rollback')
  put('race.txt','ORIGINAL\n'); const seed = await editLine('race.txt','PLUGIN')
  const [writer, undo] = await Promise.all([editLine('race.txt','NEWER'),rollback.execute({batch:String(seed.batch),dryRun:false,reason:'concurrent'},exec)])
  assert.equal(writer.status,'applied');assert.equal(undo.status,'applied')
  await rollback.execute({batch:String(undo.newBatch),dryRun:false,reason:'redo concurrent'},exec)
  assert.equal(read('race.txt'),'NEWER\n')
  ok('concurrent rollback captures the actual latest bytes under the same lock')
  let release; const held = withFileLock(file('race.txt'),()=>new Promise(r=>release=r))
  await new Promise(r=>setImmediate(r))
  const pending = editLine('race.txt','LOCKED'); await new Promise(r=>setImmediate(r))
  assert.equal(read('race.txt'),'NEWER\n'); release();await held;await pending
  ok('separate public modules share one lock registry')
  put('toctou.js','function Original() {}\n')
  const originalRead = fs.readFileSync
  let injected = false
  fs.readFileSync = function(target,...args) {
    const bytes = originalRead(target,...args)
    if (target===file('toctou.js') && !injected) { injected=true;queueMicrotask(()=>put('toctou.js','function Human() {}\n')) }
    return bytes
  }
  syncBuiltinESMExports()
  let raced
  try { raced = await editLine('toctou.js','function Plugin() {}') } finally { fs.readFileSync=originalRead;syncBuiltinESMExports() }
  assert.ok(raced.error);assert.equal(read('toctou.js'),'function Human() {}\n')
  ok('external write during AST await aborts the commit without swallowing bytes')
  put('fault.txt','BEFORE\n')
  const rename = fs.renameSync
  let fail = true
  const flush = fs.fsyncSync
  fs.fsyncSync = function(fd) { if(fail && fs.fstatSync(fd).ino === fs.statSync(store.ledgerFile).ino) { fail=false;throw Error('injected ledger failure') } return flush(fd) }
  syncBuiltinESMExports()
  const beforeCount = readLedgerTail(store).length
  let faulty
  try { faulty=await editLine('fault.txt','AFTER') } finally { fs.fsyncSync=flush;syncBuiltinESMExports() }
  assert.ok(faulty.error);assert.equal(read('fault.txt'),'BEFORE\n');assert.equal(readLedgerTail(store).length,beforeCount)
  ok('ledger flush failure truncates the uncommitted append and compensates file writes')
  put('a.txt','A0');put('b.txt','B0')
  const changes = ['a.txt','b.txt'].map((f,i)=>({file:file(f),before:Buffer.from(i?'B0':'A0'),after:Buffer.from(i?'B1':'A1')}))
  const nodes = changes.map(c=>({file:path.basename(c.file),op:'update',before:putBlob(store,c.before).id,after:putBlob(store,c.after).id,bytes:c.after.length,eol:'LF',bom:false}))
  let secondFail=true
  fs.renameSync=function(from,to){if(to===file('b.txt')&&secondFail){secondFail=false;throw Error('second file failed')}return rename(from,to)}
  syncBuiltinESMExports()
  try { assert.throws(()=>commitFiles(store,{kind:'edit',reason:'two files',actor:'test',nodes},changes)) } finally {fs.renameSync=rename;syncBuiltinESMExports()}
  assert.equal(read('a.txt'),'A0');assert.equal(read('b.txt'),'B0')
  ok('multi-file failure compensates all previously replaced files')
  commitFiles(store,{kind:'edit',reason:'two files',actor:'test',nodes},changes)
  let rollbackFail=true
  fs.renameSync=function(from,to){if(to===file('b.txt')&&rollbackFail){rollbackFail=false;throw Error('rollback second file failed')}return rename(from,to)}
  syncBuiltinESMExports()
  try { assert.ok((await rollback.execute({batch:'last',dryRun:false,reason:'fault'},exec)).error) } finally {fs.renameSync=rename;syncBuiltinESMExports()}
  assert.equal(read('a.txt'),'A1');assert.equal(read('b.txt'),'B1')
  ok('multi-file rollback failure preserves the complete current batch')
  const journal = path.join(store.dir,'transaction.json')
  fs.writeFileSync(journal,JSON.stringify({transaction:'interrupted',nodes:[{file:file('a.txt'),before:nodes[0].before,after:nodes[0].after}]}))
  recoverStore(store);assert.equal(read('a.txt'),'A0');assert.ok(!fs.existsSync(journal))
  fs.writeFileSync(journal,JSON.stringify({transaction:'external-conflict',nodes:[{file:file('a.txt'),before:nodes[0].before,after:nodes[0].after}]}))
  put('a.txt','HUMAN');assert.throws(()=>recoverStore(store),/external modification/);assert.equal(read('a.txt'),'HUMAN')
  put('a.txt','A0');recoverStore(store)
  ok('interrupted commit recovers and unknown external content blocks recovery safely')
  put('private/recovery.txt', 'PARTIAL')
  const privateFile = file('private/recovery.txt')
  const recoveryJournal = { transaction: 'guarded-recovery', nodes: [{ file: privateFile,
    before: putBlob(store, Buffer.from('ORIGINAL')).id, after: putBlob(store, Buffer.from('PARTIAL')).id }] }
  fs.writeFileSync(journal, JSON.stringify(recoveryJournal))
  const guarded = [], writeIntents = []
  let denyPath = true, denyIntent = false
  for (const disposable of apply({ fs: { resolve: async target => ({ targetKey: target, displayPath: target }), processPath: target => target.targetKey,
      processPathFromHostPath: target => denyPath && target === privateFile ? undefined : target,
      stat: async () => ({ version: 'current', type: 'file', size: 7 }) },
    async waterfall(_event, target) { writeIntents.push(target.targetKey); return denyIntent ? {kind:'replaceIfVersion',version:'old'} : undefined },
    tools: { register(def) { guarded.push(def) } }, commands: { register() {} } })) {
    if (typeof disposable === 'function') disposers.push(disposable)
  }
  const guardedCreate = guarded.find(d => d.name === 'ff_file')
  const createArgs = { action: 'create', path: 'recovery-allowed.txt', content: 'allowed', reason: 'guard regression' }
  await assert.rejects(() => guardedCreate.execute(createArgs, exec), /not shared/)
  assert.equal(read('private/recovery.txt'), 'PARTIAL'); assert.ok(fs.existsSync(journal)); assert.equal(fs.existsSync(file('recovery-allowed.txt')), false)
  denyPath = false; denyIntent = true
  await assert.rejects(() => guardedCreate.execute(createArgs, exec), /write-intent refused/)
  assert.equal(read('private/recovery.txt'), 'PARTIAL'); assert.ok(fs.existsSync(journal)); assert.ok(writeIntents.includes(privateFile))
  denyIntent = false
  await guardedCreate.execute(createArgs, exec)
  assert.equal(read('private/recovery.txt'), 'ORIGINAL'); assert.equal(read('recovery-allowed.txt'), 'allowed'); assert.equal(fs.existsSync(journal), false)
  ok('registered SDK tool recovery checks denied paths and write intent before recovery; authorized recovery succeeds')
  for (const phase of ['file', 'ledger']) {
    put('crash.txt','BEFORE')
    const childCode = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
      import {commitFiles,storeFor,putBlob} from ${JSON.stringify(new URL('../lib/ledger.js',import.meta.url).href)};
      const target=${JSON.stringify(file('crash.txt'))},store=storeFor(${JSON.stringify(work)});
      const before=Buffer.from('BEFORE'),after=Buffer.from('AFTER');
      const node={file:'crash.txt',op:'update',before:putBlob(store,before).id,after:putBlob(store,after).id,bytes:5,eol:'LF',bom:false};
      const rename=fs.renameSync,flush=fs.fsyncSync;
      fs.renameSync=(from,to)=>{rename(from,to);if(${phase==='file'?'to===target':'false'})process.exit(9)};
      fs.fsyncSync=fd=>{flush(fd);if(${phase==='ledger'?'fs.fstatSync(fd).ino===fs.statSync(store.ledgerFile).ino':'false'})process.exit(9)};
      syncBuiltinESMExports();
      commitFiles(store,{kind:'edit',reason:'crash ${phase}',actor:'child',nodes:[node]},[{file:target,before,after}]);`
    const child=spawnSync(process.execPath,['--input-type=module','-e',childCode],{encoding:'utf8',timeout:30000})
    assert.equal(child.status,9,child.stderr);assert.equal(read('crash.txt'),'AFTER');assert.ok(fs.existsSync(journal))
    recoverStore(store);assert.equal(read('crash.txt'),phase==='file'?'BEFORE':'AFTER');assert.ok(!fs.existsSync(journal))
  }
  ok('real process termination before/after ledger commit recovers to the corresponding snapshot')
  fs.writeFileSync(store.stateFile,'{broken')
  assert.ok(readLedgerTail(store).length>0)
  const blob = putBlob(store,Buffer.from('HASH'))
  fs.writeFileSync(path.join(store.blobsDir,blob.id+'.gz'),Buffer.from('corrupt'))
  assert.equal(getBlob(store,blob.id),null)
  ok('corrupt snapshot fails closed')
  put('real.txt','BEFORE\n'); const alias=file('alias.txt'); fs.symlinkSync(file('real.txt'),alias)
  const linked=await edit.execute({path:'alias.txt',steps:[{start:1,text:'AFTER'}],reason:'symlink'},exec)
  assert.equal(linked.status,'applied'); assert.equal(read('real.txt'),'AFTER\n'); assert.equal(fs.lstatSync(alias).isSymbolicLink(),true)
  ok('symlink edits resolve the target and preserve link identity')
  put('heal.txt','BEFORE\n')
  const heal=putBlob(store,Buffer.from('BEFORE\n'))
  fs.writeFileSync(path.join(store.blobsDir,heal.id+'.gz'),Buffer.from('damaged'))
  const healed=await editLine('heal.txt','AFTER');assert.equal(healed.status,'applied')
  assert.equal(getBlob(store,heal.id).toString(),'BEFORE\n')
  await rollback.execute({batch:String(healed.batch),dryRun:false,reason:'repair regression'},exec)
  assert.equal(read('heal.txt'),'BEFORE\n')
  ok('existing damaged snapshots repair from verified raw bytes before a new edit')
  const other=path.join(sandbox,'torn');fs.mkdirSync(other);const tornStore=storeFor(other)
  fs.mkdirSync(tornStore.dir,{recursive:true});fs.writeFileSync(tornStore.ledgerFile,'{"t":"b","id":1')
  fs.writeFileSync(path.join(other,'file.txt'),'BEFORE\n')
  const tornExec={...exec,agent:{session:{header:{cwd:other,id:'torn'}}}}
  const tornEdit=await edit.execute({path:'file.txt',steps:[{start:1,text:'AFTER'}],reason:'torn'},tornExec)
  assert.equal(tornEdit.status,'applied');assert.equal(readLedgerTail(tornStore).length,1)
  assert.ok(fs.readdirSync(tornStore.dir).some(n=>n.startsWith('torn-ledger-')))
  await rollback.execute({batch:'last',dryRun:false,reason:'torn rollback'},tornExec)
  assert.equal(fs.readFileSync(path.join(other,'file.txt'),'utf8'),'BEFORE\n')
  const ledgerWithoutNewline=fs.readFileSync(tornStore.ledgerFile,'utf8').trimEnd()
  fs.writeFileSync(tornStore.ledgerFile,ledgerWithoutNewline)
  await edit.execute({path:'file.txt',steps:[{start:1,text:'AGAIN'}],reason:'valid tail'},tornExec)
  assert.equal(readLedgerTail(tornStore).length,3)
  ok('torn ledger tails preserve evidence and valid unseparated tails keep all new batches')
  for(const [name,source,expected] of [
    ['nested.js','const outer=()=>{ function inner(){} }',['outer','outer.inner']],
    ['nested.py','def outer():\n    def inner():\n        pass\n    return inner',['outer','outer.inner']],
    ['nested.rs','mod m { struct S; impl S { fn run() {} } }',['m','m::S','m::impl S','m::S::run']],
    ['generic.go','package p\ntype G[T any] struct{}\nfunc (g G[T]) Run() {}',['G','G.Run']],
  ]) {
    put(name,source);const parsed=await parseFile(file(name));assert.ok(parsed.value,parsed.error)
    const flat=flattenSymbols(parsed.value.symbols);assert.deepEqual(flat.map(s=>s.qualifiedName),expected)
    if(name==='nested.py')assert.equal(flat[1].kind,'function')
  }
  ok('AST preserves function/class scope, nested arrows, Rust modules and Go generic receivers')
  put('comments.py','# detached\n\n@decorator\ndef decorated():\n    pass\n')
  const comment=await outlineView(createReadTool()).execute({path:'comments.py'},exec)
  assert.equal(comment.items[0].startLine,3);assert.equal(comment.items[0].commentStartLine,undefined)
  assert.match(singleSymbolView(await createReadTool().execute({path:'comments.py',symbol:'decorated'},exec)).text,/^@decorator/)
  ok('comments require adjacency and decorated reads include the decorator')
  put('.gitignore','secret/\nignored/*.js\n!ignored/keep.js\n')
  put('secret/private.js','function Secret(){}');put('ignored/drop.js','function Drop(){}');put('ignored/keep.js','function Keep(){}')
  put('nested/.gitignore','hidden.js\n');put('nested/hidden.js','function Hidden(){}')
  const find=definitionsView(createReadTool())
  for(const name of ['Secret','Drop','Hidden'])assert.equal((await find.execute({name},exec)).items.length,0)
  assert.equal((await find.execute({name:'Keep'},exec)).items.length,1)
  ok('symbol walks honor root/nested gitignore and negated files')
  put('scope/same.js','function Scoped(){}');put('scope/nested/same.js','function Scoped(){}')
  const grep=createGrepTool(pool), finder=createFindTool(pool)
  const scoped=await grep.execute({path:'scope/same.js',pattern:'Scoped'},exec)
  assert.deepEqual(scoped.items.map(i=>i.file),['scope/same.js'])
  const found=await finder.execute({path:'scope/same.js',pattern:'same.js'},exec)
  assert.deepEqual(found.items.map(i=>i.path),['scope/same.js'])
  assert.equal(found.totalMatched,1)
  const mockFinder = createFindTool({ async aux(root) { return {basePath:root,aux:true,warming:false,finder:{fileSearch(query,options) {
    const relativePath = options.pageIndex === 1 ? 'same.js' : 'nested/same.js'
    return {ok:true,value:{totalMatched:201,items:[{relativePath,fileName:'same.js',size:1,gitStatus:'',totalFrecencyScore:0,modified:0}],scores:[]}}
  }}} }})
  const later=await mockFinder.execute({path:'scope/same.js',pattern:'same.js',limit:1},exec)
  assert.deepEqual(later.items.map(i=>i.path),['scope/same.js']);assert.equal(later.totalMatched,1)
  const ext=await grep.execute({path:outside,pattern:'outside'},exec)
  assert.equal(ext.items[0].file,outside.split(path.sep).join('/'))
  ok('scoped search returns usable workspace/absolute paths and exact single-file matches')
  const step={find:' X',replaceWith:'   Y'}
  assert.equal(applyEditSteps('    X',[step]).text,applyEditSteps('    X',[step],{pinnedTargets:[{stepIndex:0,start:1,end:1}]}).text)
  ok('pinned and unique targets share indentation semantics')
  assert.equal(applyEditSteps('A\nB\n',[{start:2,text:'  2 | BB'}]).text,'A\nBB\n')
  for (const step of [{op:'replace',start:1},{op:'insert',after:1},{find:'A'}]) {
    assert.equal(applyEditSteps('A\nB\n',[step]).ok,false)
  }
  ok('padded line prefixes strip and explicit edit payloads cannot silently delete content')

  // --- blob GC + purge (PurgeProjects semantics) + ffhistory content search ---
  put('gc-a.txt', 'GC ALPHA\n')
  const gcEdit = await editLine('gc-a.txt', 'GC BETA')
  assert.equal(gcEdit.status, 'applied')
  const stray = createHash('sha256').update(Buffer.from('stray bytes')).digest('hex')
  fs.writeFileSync(path.join(store.blobsDir, `${stray}.gz`), 'not real gzip')
  const reachable = [...referencedBlobIds(store)].filter(id => getBlob(store, id) !== null)
  const freed = gcStoreBlobs(store)
  assert.ok(freed.some(f => f.id === stray))
  assert.ok(reachable.every(id => getBlob(store, id) !== null))
  ok('blob GC recycles only unreferenced snapshots')
  const contentHit = await createHistoryTool().execute({ content: 'GC BETA' }, exec)
  assert.ok(contentHit.items.some(i => i.batch === gcEdit.batch))
  const contentMiss = await createHistoryTool().execute({ content: 'GC-NEVER-WAS' }, exec)
  assert.equal(contentMiss.items.length, 0)
  ok('ffhistory content filter searches snapshot blobs within the 32MB budget')
  fs.writeFileSync(journal, JSON.stringify({ transaction: 'interrupted', nodes: [] }))
  assert.throws(() => purgeStore(store), /recovery journal/)
  fs.rmSync(journal)
  const purgeStats = purgeStore(store)
  assert.ok(purgeStats.batches > 0 && !fs.existsSync(store.dir))
  put('post-purge.txt', 'REBUILT\n')
  const rebuilt = await editLine('post-purge.txt', 'AFTER PURGE')
  assert.equal(rebuilt.status, 'applied')
  ok('purge erases ledger+blobs, refuses pending recovery, store lazily rebuilds')

  // --- revertOnSyntaxError (PF EditCode semantics: refuse introduced errors, tolerate pre-existing) ---
  put('clean.js', 'function A() {}\nfunction B() {}\n')
  const revertRefused = await edit.execute({ path: 'clean.js', steps: [{ start: 1, text: 'function A( {}' }], reason: 'r', revertOnSyntaxError: true }, exec)
  assert.ok(revertRefused.error && revertRefused.error.includes('introduces syntax errors'))
  assert.equal(read('clean.js'), 'function A() {}\nfunction B() {}\n')
  const revertAllowed = await edit.execute({ path: 'clean.js', steps: [{ start: 1, text: 'function A( {}' }], reason: 'r' }, exec)
  assert.equal(revertAllowed.status, 'applied')
  assert.ok(String(revertAllowed.syntaxWarning).includes('introduced'))
  put('dirty.js', 'function X( {}\n')
  const revertTolerated = await edit.execute({ path: 'dirty.js', steps: [{ start: 1, text: 'function Y( {}' }], reason: 'r', revertOnSyntaxError: true }, exec)
  assert.equal(revertTolerated.status, 'applied')
  assert.ok(String(revertTolerated.syntaxWarning).includes('pre-existing'))
  const revertRefusedCreate = await edit.execute({ path: 'new-broken.js', steps: [{ after: 0, text: 'function Z( {}' }], reason: 'r', revertOnSyntaxError: true }, exec)
  assert.ok(revertRefusedCreate.error && revertRefusedCreate.error.includes('introduces syntax errors'))
  assert.ok(!fs.existsSync(file('new-broken.js')))
  ok('revertOnSyntaxError refuses introduced errors, tolerates pre-existing dirt, covers created files')

  // --- multi-file transaction boundaries (WAL semantics) ---
  const journalPath = path.join(store.dir, 'transaction.json')
  const ledgerCount = () => readLedgerTail(store, Number.MAX_SAFE_INTEGER).length

  // Pre-flight abort: a mid-batch target is a directory → throws before any
  // journal exists, earlier files untouched.
  put('txn/a.txt', 'A1\n')
  fs.mkdirSync(file('txn/dir-target'))
  const preflightBase = ledgerCount()
  const dirBefore = putBlob(store, Buffer.from('D\n')).id
  const dirAfter = putBlob(store, Buffer.from('D2\n')).id
  assert.throws(() => commitFiles(store, { kind: 'edit', reason: 'txn-preflight', actor: 't', nodes: [] }, [
    { file: file('txn/a.txt'), before: Buffer.from('A1\n'), after: Buffer.from('A2\n') },
    { file: file('txn/dir-target'), before: dirBefore, after: dirAfter },
  ]), /EISDIR|EPERM|nothing written/)
  assert.equal(read('txn/a.txt'), 'A1\n', 'pre-flight abort must not write earlier files')
  assert.ok(!existsSync(journalPath), 'no journal survives a pre-flight abort')
  assert.equal(ledgerCount(), preflightBase)
  ok('multi-file pre-flight abort writes nothing and leaves no journal')

  // Real mid-transaction failure: second target read-only → atomicWrite
  // cannot create its temp file (EPERM) after the journal exists → catch →
  // recoverStore rolls the first file back to before; ledger has no batch.
  put('txn/b1.txt', 'B1-ORIG\n')
  put('txn/b2.txt', 'B2-ORIG\n')
  const midFailBase = ledgerCount()
  fs.chmodSync(file('txn/b2.txt'), 0o444)
  try {
    assert.throws(() => commitFiles(store, { kind: 'edit', reason: 'txn-midfail', actor: 't', nodes: [] }, [
      { file: file('txn/b1.txt'), before: Buffer.from('B1-ORIG\n'), after: Buffer.from('B1-NEW\n') },
      { file: file('txn/b2.txt'), before: Buffer.from('B2-ORIG\n'), after: Buffer.from('B2-NEW\n') },
    ]), /EPERM|EACCES|rollback|failed|recovery/)
    assert.equal(read('txn/b1.txt'), 'B1-ORIG\n', 'partial write rolled back to exact before-bytes')
    assert.equal(read('txn/b2.txt'), 'B2-ORIG\n')
    assert.ok(!existsSync(journalPath), 'journal consumed by recovery')
    assert.equal(ledgerCount(), midFailBase, 'failed transaction leaves no ledger batch')
  } finally {
    fs.chmodSync(file('txn/b2.txt'), 0o644)
  }
  ok('mid-transaction failure: WAL journal identifies partial state and recovers exactly')

  // Hand-crafted crash (write 1 done, write 2 not, ledger not recorded) —
  // recovery-on-access must restore file 1 to before.
  put('txn/p1.txt', 'P1-ORIG\n')
  put('txn/p2.txt', 'P2-ORIG\n')
  const p1b = putBlob(store, Buffer.from('P1-ORIG\n')).id, p1a = putBlob(store, Buffer.from('P1-NEW\n')).id
  const p2b = putBlob(store, Buffer.from('P2-ORIG\n')).id, p2a = putBlob(store, Buffer.from('P2-NEW\n')).id
  const crashTx = randomUUID()
  fs.writeFileSync(journalPath, JSON.stringify({ transaction: crashTx, nodes: [
    { file: file('txn/p1.txt'), before: p1b, after: p1a },
    { file: file('txn/p2.txt'), before: p2b, after: p2a },
  ] }))
  fs.writeFileSync(file('txn/p1.txt'), 'P1-NEW\n') // simulate: write 1 committed
  recoverStore(store)
  assert.equal(read('txn/p1.txt'), 'P1-ORIG\n', 'half-committed file restored to before')
  assert.equal(read('txn/p2.txt'), 'P2-ORIG\n')
  assert.ok(!existsSync(journalPath))
  ok('crash between writes: journal-driven recovery rolls back the partial commit')

  // Completion path: ledger already carries the transaction (crash after
  // ledger record, before journal removal) → recovery completes files to after.
  const doneTx = randomUUID()
  recordBatch(store, { kind: 'edit', reason: 'txn-complete', actor: 't', transaction: doneTx, nodes: [
    { file: 'txn/p1.txt', op: 'update', before: p1b, after: p1a, bytes: 8, eol: 'LF', bom: false },
    { file: 'txn/p2.txt', op: 'update', before: p2b, after: p2a, bytes: 8, eol: 'LF', bom: false },
  ] })
  fs.writeFileSync(journalPath, JSON.stringify({ transaction: doneTx, nodes: [
    { file: file('txn/p1.txt'), before: p1b, after: p1a },
    { file: file('txn/p2.txt'), before: p2b, after: p2a },
  ] }))
  recoverStore(store) // both files still at BEFORE → completed to after
  assert.equal(read('txn/p1.txt'), 'P1-NEW\n', 'committed transaction completed to after')
  assert.equal(read('txn/p2.txt'), 'P2-NEW\n')
  assert.ok(!existsSync(journalPath))
  ok('crash after ledger record: recovery completes the commit instead of undoing it')

  // Defense in depth: a pending journal is recovered (not clobbered) even
  // when a caller reaches commitFiles without prepareWorkspace.
  put('txn/p1.txt', 'P1-ORIG\n') // back to before, journal gone
  fs.writeFileSync(journalPath, JSON.stringify({ transaction: randomUUID(), nodes: [
    { file: file('txn/p1.txt'), before: p1b, after: p1a },
  ] }))
  fs.writeFileSync(file('txn/p1.txt'), 'P1-NEW\n')
  const guardBase = ledgerCount()
  put('txn/c.txt', 'C1\n')
  commitFiles(store, { kind: 'edit', reason: 'txn-guard', actor: 't', nodes: [
    { file: 'txn/c.txt', op: 'update', before: putBlob(store, Buffer.from('C1\n')).id, after: putBlob(store, Buffer.from('C2\n')).id, bytes: 3, eol: 'LF', bom: false },
  ] }, [{ file: file('txn/c.txt'), before: Buffer.from('C1\n'), after: Buffer.from('C2\n') }])
  assert.equal(read('txn/p1.txt'), 'P1-ORIG\n', 'pending journal recovered before the new commit, not overwritten')
  assert.equal(read('txn/c.txt'), 'C2\n')
  assert.equal(ledgerCount(), guardBase + 1)
  ok('commitFiles never clobbers a pending recovery journal')

  console.log(`\n${passed} regression groups passed`)
}
main().catch(err=>{console.error(err);process.exitCode=1}).finally(()=>{
  pool.disposeAll();disposers.forEach(fn=>fn());try { fs.rmSync(sandbox,{recursive:true,force:true,maxRetries:5,retryDelay:100}) } catch { /* Windows AV handle races — temp dir */ }
})
