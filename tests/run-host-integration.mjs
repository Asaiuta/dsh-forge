// Registered SDK tools against the installed DSH provider + observation policy.
// No model, approval UI, upstream traffic, or installed profile changes.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { syncBuiltinESMExports } from 'node:module'
import { apply, Config, inject } from '../lib/index.js'
import { createStatusCommand } from '../lib/tools.js'
import { withFileLock } from '../lib/core.js'
import { storeFor, recordBatch, readLedgerTail } from '../lib/ledger.js'
import { createTraceTool, resetTraceFactsCache } from '../lib/tools-trace.js'
import { localEnv } from '../scripts/local-env.mjs'

const modules = localEnv('DSH_FORGE_DSH_MODULES')
if (!modules || !fs.existsSync(path.join(modules, 'dsh-fs-sandbox/lib/index.js'))) {
  console.log('run-host-integration: installed DSH unavailable; SKIPPED (set DSH_FORGE_DSH_MODULES)')
} else {
  const load = name => import(pathToFileURL(path.join(modules, name, 'lib/index.js')))
  const { LocalFileSystem } = await load('dsh-fs-local')
  const { SandboxedFileSystem } = await load('dsh-fs-sandbox')
  const { SandboxPolicyService } = await load('dsh-sandbox-policy')
  const observationPolicy = await load('dsh-fs-observation-policy')
  const { ToolRuntime } = await load('dsh-tools')
  const { Context } = await load('cordis')
  const runtime = Object.create(ToolRuntime.prototype)
  runtime.canonicalResults = new WeakMap(); runtime.concludingExecutions = new WeakSet()
  // DSH intentionally permits platform temp roots under workspace-write.
  // Place the escape fixture outside temp so it exercises a real denial.
  const base = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '.host-fixture-'))
  const previousData = process.env.DSH_FORGE_DATA_DIR
  process.env.DSH_FORGE_DATA_DIR = path.join(base, 'data')
  const root = path.join(base, 'workspace'), outside = path.join(base, 'outside')
  fs.mkdirSync(root); fs.mkdirSync(outside)
  const execFor = mode => ({ agent: { session: { header: { cwd: root, id: 'host' }, mode } }, signal: new AbortController().signal })
  const disposers = []
  let passed = 0
  const ok = message => console.log(`ok ${++passed} - ${message}`)
  const mount = (defaultMode, checkSeams = {}) => {
    const provider = Object.create(defaultMode ? SandboxedFileSystem.prototype : LocalFileSystem.prototype)
    provider.config = { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 }
    provider.locks = new Map(); provider.internals = {}; provider.defaultMode = defaultMode
    const listeners = new Map(), tools = [], observations = []
    const policy = { resolve({ session }) {
      return SandboxPolicyService.prototype.resolve.call({ defaultMode, workspaceRoot: outside, overrideOf: value => value.mode }, { session })
    } }
    const host = { fs: provider, get: name => name === 'sandboxPolicy' ? policy : checkSeams[name],
      on: (name, fn) => listeners.set(name, fn),
      waterfall: (name, ...args) => listeners.get(name)?.(...args),
      emit(name, ...args) { observations.push({ path: args[0].displayPath, targetKey: args[0].targetKey, value: args[1] }); listeners.get(name)?.(...args) },
      effect(fn) { disposers.push(fn()) },
      tools: { register: tool => { tools.push(tool) } }, commands: { register() {} } }
    observationPolicy.apply(host)
    for (const dispose of apply(host)) if (typeof dispose === 'function') disposers.push(dispose)
    const call = async (name, args, exec) => {
      const tool = tools.find(value => value.name === name)
      const value = await tool.execute(args, exec)
      runtime.createSuccessResult({ ...exec, arguments: args }, tool, value)
      return value
    }
    return { provider, host, call, observations }
  }
  const put = (file, text = 'function One() { return 1; }\n') => fs.writeFileSync(path.join(root, file), text)
  try {
    const activation = new Context(), scope = new Context(), globalDefinitions = [], scopedDefinitions = [], sections = []
    activation.provide('tools', { register(definition) { globalDefinitions.push(definition); return () => {} },
      get(name, gotScope) { return (gotScope === scope ? scopedDefinitions.find(d=>d.name===name) : undefined) ?? globalDefinitions.find(d=>d.name===name) } })
    scope.provide('tools', { register(definition) { scopedDefinitions.push(definition); return () => {} } })
    activation.provide('commands', { register() { return () => {} } })
    activation.provide('fs', { observeNativeRead() {} })
    activation.provide('systemPrompt', { section(section) { sections.push(section); return () => {} } })
    activation.provide('agents', { list: () => [{ctx:scope}] })
    const mounted = activation.plugin({ name:'forge-loader-regression', Config, inject, apply }, { registration:'takeover', takeover:['read','glob','grep'], prewarm:false })
    await new Promise(resolve=>setImmediate(resolve))
    assert.equal(globalDefinitions.length,7); assert.equal(scopedDefinitions.length,3)
    assert.ok(globalDefinitions.some(tool => tool.name === 'ffcheck'))
    assert.equal(sections.length,1)
    const activationGuidance = sections[0].text({scope})
    assert.match(activationGuidance,/read view=outline/)
    assert.match(activationGuidance,/Find files by path → glob with pattern/)
    assert.match(activationGuidance,/Search file contents → grep with a regular-expression pattern/)
    assert.ok(!activationGuidance.includes('mode=name') && !activationGuidance.includes('patterns for'))
    mounted.dispose(); await new Promise(resolve=>setImmediate(resolve))
    ok('the installed Cordis loader validates the complete plugin Config and activates all 10 takeover tools including ffcheck')
    for (const defaultMode of ['read-only', 'workspace-write', 'danger-full-access']) {
      const { call } = mount(defaultMode)
      for (const mode of [undefined, 'read-only', 'workspace-write', 'danger-full-access']) {
        put('one.js')
        const exec = execFor(mode), effective = mode || defaultMode
        for (const [name, args] of [ ['ff_read',{path:'one.js'}], ['ff_read',{path:'one.js',symbol:'One'}],
          ['ff_read',{view:'outline',path:'one.js'}], ['fftrace',{target:'file:one.js'}], ['ffgrep',{pattern:'One'}],
          ['fffind',{pattern:'one.js'}], ['ffgrep',{patterns:['One','return']}],
          ['ff_read',{view:'definitions',symbol:'One'}], ['ffhistory',{}] ]) {
          await call(name,args,exec)
        }
        const mutation = () => call('ffedit', {path:'one.js',steps:[{start:1,text:'function One() { return 2; }'}],reason:'sandbox integration'},exec)
        if (effective === 'read-only') {
          await assert.rejects(mutation,/read-only/)
          assert.match(fs.readFileSync(path.join(root,'one.js'),'utf8'),/return 1/)
        } else assert.equal((await mutation()).status,'applied')
        ok(`installed sandbox default=${defaultMode}, session=${mode || 'default'}: 9 registered reads + write policy`)
      }
    }
    const { call, observations, provider, host } = mount('workspace-write'), exec = execFor('workspace-write')
    for (const file of ['batch-a.js','batch-b.js','glob.js','symbol.js']) put(file)
    await call('ff_read',{paths:['batch-a.js','batch-b.js']},exec)
    await call('ff_read',{glob:'glob.js'},exec)
    await call('ff_read',{path:'symbol.js#One'},exec)
    for (const file of ['batch-a.js','batch-b.js','glob.js','symbol.js']) {
      assert.equal((await call('ffedit',{path:file,steps:[{start:1,text:'function One() { return 3; }'}],reason:'read then edit'},exec)).status,'applied')
    }
    await call('ff_read',{path:'absent.js'},exec)
    assert.ok(observations.some(item=>item.path.endsWith('absent.js') && item.value.kind==='absent'))
    assert.ok((await call('ff_file',{action:'create',path:'absent.js',content:'created',reason:'absence'},exec)).batch > 0)
    ok('path/symbol/paths/glob and missing-file observations satisfy the actual DSH policy')

    put('ticket.txt','A\nA\n')
    await call('ff_read',{path:'ticket.txt'},exec)
    const ticket=await call('ffedit',{path:'ticket.txt',steps:[{find:'A',replaceWith:'B'}],reason:'host ticket'},exec)
    assert.equal(ticket.status,'ticket')
    const resolved=await call('ffedit',{ticket:ticket.ticket,choice:'0'},exec)
    assert.equal(resolved.status,'applied')
    assert.ok((await call('ffhistory',{batch:resolved.batch},exec)).items.length)
    const rollback=await call('ffrollback',{batch:String(resolved.batch),dryRun:false,reason:'host rollback'},exec)
    assert.ok(rollback.newBatch)
    assert.equal(fs.readFileSync(path.join(root,'ticket.txt'),'utf8'),'A\nA\n')
    ok('every registered read tool success contract, including ticket resolution, immutable diff and rollback, materialize in the actual SDK')

    put('sdk-check.js', 'const value = 1\n')
    await call('ff_read', {path:'sdk-check.js'}, exec)
    const checkedEdit = await call('ffedit', {path:'sdk-check.js',find:'value = 1',replaceWith:'value = 2',reason:'installed SDK verification'}, exec)
    assert.equal(checkedEdit.status, 'applied')
    const checkedBatch = await call('ffcheck', {action:'static',batches:[checkedEdit.batch],checks:['syntax']}, exec)
    assert.equal(checkedBatch.status, 'passed')
    assert.equal(checkedBatch.verification.persisted, true)
    const checkedHistory = await call('ffhistory', {batch:checkedEdit.batch,checks:true}, exec)
    assert.ok(checkedHistory.items.length > 0)
    assert.ok(checkedHistory.items[0].diffs.length > 0)
    assert.ok(checkedHistory.items[0].checks.some(record => checkedBatch.verification.id.startsWith(record.id)))
    const checkedDelete = await call('ff_file', {action:'remove',path:'sdk-check.js',reason:'installed SDK zero-check evidence'}, exec)
    const zeroChecked = await call('ffcheck', {action:'static',batches:[checkedDelete.batch],checks:['syntax']}, exec)
    assert.equal(zeroChecked.status, 'not_run')
    assert.equal(zeroChecked.syntax.checked, 0)
    ok('installed SDK validates ffcheck and history results, including a deleted input with zero executed syntax checks')

    // Only the SDK output validator is real here; approval/process seams are
    // controlled fixtures, and this case sends no command to the desktop.
    const emptyStream = {readFrom: () => ({text:'',nextOffset:0,lossy:false})}
    const stoppedHost = mount('workspace-write', {
      approval: {request: async () => 'allowed-once'},
      subprocess: {spawn: () => ({done:Promise.resolve({exitCode:null,signal:'SIGTERM'}),collected:{stdout:emptyStream,stderr:emptyStream}})},
    })
    const stoppedExec = {...execFor('workspace-write'),callId:'offline-sdk-terminated'}
    const stoppedPlan = await stoppedHost.call('ffcheck', {action:'plan',inputs:['ticket.txt'],checks:[],recipes:[{id:'stopped',kind:'process',program:process.execPath,argv:[]}]}, stoppedExec)
    const stoppedRun = await stoppedHost.call('ffcheck', {action:'run',checkPlanId:stoppedPlan.checkPlanId}, stoppedExec)
    assert.equal(stoppedRun.status, 'failed')
    assert.equal(stoppedRun.reason, 'nonzero_exit')
    assert.equal(stoppedRun.runs[0].exitCode, null)
    ok('installed SDK accepts a nullable exit from a controlled signal-termination seam without fabricating exit zero')

    let deniedSpawned = false
    const deniedHost = mount('workspace-write', {
      approval: {request: async () => 'rejected'},
      subprocess: {spawn: () => {deniedSpawned = true; throw new Error('denied command must not start')}},
    })
    const deniedExec = {...execFor('workspace-write'),callId:'offline-sdk-denied'}
    const deniedPlan = await deniedHost.call('ffcheck', {action:'plan',inputs:['ticket.txt'],checks:[],recipes:[{id:'denied',kind:'process',program:process.execPath,argv:[]}]}, deniedExec)
    const deniedRun = await deniedHost.call('ffcheck', {action:'run',checkPlanId:deniedPlan.checkPlanId}, deniedExec)
    assert.equal(deniedRun.status, 'denied')
    assert.equal(deniedRun.runs[0].status, 'denied')
    assert.equal(deniedSpawned, false)
    assert.equal(deniedRun.verification.persisted, true)
    ok('installed SDK materializes a controlled approval denial and its archived result without starting a process')

    put('race.js')
    const raced = execFor('workspace-write'), before = observations.length
    const originalRead = fs.readSync
    let injected = false
    fs.readSync = (fd,...args) => {
      const n = originalRead(fd,...args)
      if (!injected && fs.fstatSync(fd).ino === fs.statSync(path.join(root,'race.js')).ino) {
        injected = true; queueMicrotask(()=>put('race.js','function Human() {}\n'))
      }
      return n
    }
    syncBuiltinESMExports()
    try { await call('ff_read',{path:'race.js#One'},raced) }
    finally { fs.readSync = originalRead; syncBuiltinESMExports() }
    assert.equal(observations.slice(before).filter(item=>item.path.endsWith('race.js')).length,0)
    // ffedit performs its own observed planning read. Check the interrupted
    // read's policy state directly, before another operation can refresh it.
    const raceTarget = await provider.resolve(path.join(root,'race.js'))
    const raceIntent = await host.waterfall('fs/write-intent', raceTarget, raced, () => undefined)
    assert.equal(raceIntent.kind, 'createIfAbsent')
    assert.match(fs.readFileSync(path.join(root,'race.js'),'utf8'),/Human/)
    ok('a changing file is never marked observed; its write intent still refuses replacing existing bytes')

    put('alias-one.js','function First() {}\n');put('alias-two.js','function Second() {}\n')
    const alias=path.join(root,'alias.js');fs.symlinkSync(path.join(root,'alias-one.js'),alias)
    const originalStat=provider.stat.bind(provider), aliasStart=observations.length
    let swapped=false
    provider.stat=async (...args)=>{
      const value=await originalStat(...args)
      if(!swapped && args[0].targetKey===path.join(root,'alias-one.js')){
        swapped=true;fs.unlinkSync(alias);fs.symlinkSync(path.join(root,'alias-two.js'),alias)
      }
      return value
    }
    try {
      const aliasRead=await call('ff_read',{path:'alias.js'},execFor('workspace-write'))
      assert.match(aliasRead.blocks[0].text,/First/)
    } finally {provider.stat=originalStat}
    assert.equal(observations.length,aliasStart)
    ok('a redirected symlink reads its fixed canonical target and does not observe a changed alias')

    for (const [name,args] of [['ff_read',{path:'alias.js'}],['ff_read',{path:'alias.js#First'}],
      ['ff_read',{view:'outline',path:'alias.js'}],['ff_read',{path:'alias.js',symbol:'First'}]]) {
      fs.unlinkSync(alias);fs.symlinkSync(path.join(root,'alias-one.js'),alias)
      let redirected=false,restored=false
      const readFile=fs.readFileSync,readFd=fs.readSync,mark=observations.length
      const restore=()=>{if(redirected && !restored){restored=true;fs.unlinkSync(alias);fs.symlinkSync(path.join(root,'alias-one.js'),alias)}}
      provider.stat=async (...values)=>{
        const value=await originalStat(...values)
        if(!redirected && values[0].targetKey===path.join(root,'alias-one.js')){
          redirected=true;fs.unlinkSync(alias);fs.symlinkSync(path.join(root,'alias-two.js'),alias)
        }
        return value
      }
      fs.readFileSync=(file,...values)=>{const raw=readFile(file,...values);if([alias,path.join(root,'alias-one.js')].includes(String(file)))restore();return raw}
      fs.readSync=(fd,...values)=>{const n=readFd(fd,...values);if([fs.statSync(path.join(root,'alias-one.js')).ino,fs.statSync(path.join(root,'alias-two.js')).ino].includes(fs.fstatSync(fd).ino))restore();return n}
      syncBuiltinESMExports()
      try {
        const value=await call(name,args,execFor('workspace-write'))
        assert.ok(redirected && restored)
        assert.match(JSON.stringify(value),/First/);assert.doesNotMatch(JSON.stringify(value),/Second/)
      } finally {provider.stat=originalStat;fs.readFileSync=readFile;fs.readSync=readFd;syncBuiltinESMExports()}
      assert.equal(observations.length,mark+1)
      assert.equal(observations.at(-1).targetKey,path.join(root,'alias-one.js'))
    }
    ok('alias ABA during plain/symbol/outline/ff_read#Symbol reads cannot observe bytes from another target')

    put('backing','export function Typed(value: number): number { return value; }\n')
    fs.symlinkSync(path.join(root,'backing'),path.join(root,'typed.ts'))
    for (const [name,args] of [['ff_read',{view:'outline',path:'typed.ts'}],['ff_read',{path:'typed.ts',symbol:'Typed'}],
      ['ff_read',{path:'typed.ts#Typed'}]]) {
      const value=await call(name,args,execFor('workspace-write'))
      assert.match(JSON.stringify(value),/Typed/)
    }
    ok('a typed symlink address keeps its source language while reading extensionless canonical bytes')

    put('shared-lock.txt','BEFORE\n')
    const concurrentExec=execFor('workspace-write')
    await call('ff_read',{path:'shared-lock.txt'},concurrentExec)
    const target=await provider.resolve(path.join(root,'shared-lock.txt'))
    const version=(await provider.stat(target)).version
    let staged,release,waiting
    const ready=new Promise(resolve=>{staged=resolve}), blocked=new Promise(resolve=>{release=resolve})
    const lockRequested=new Promise(resolve=>{waiting=resolve}), originalWithLock=provider.withLock
    provider.internals.inspectTemp=async()=>{staged();await blocked}
    const dsh=provider.writeText(target,'DSH\n',{kind:'replaceIfVersion',version},undefined,{mode:'workspace-write',workspaceRoot:root})
    await ready
    provider.withLock=function(key,operation){if(key===target.targetKey)waiting();return originalWithLock.call(this,key,operation)}
    let forgeFinished=false
    const forge=call('ffedit',{path:'shared-lock.txt',steps:[{start:1,text:'FORGE'}],reason:'provider concurrency'},concurrentExec)
      .then(value=>({value}),error=>({error})).finally(()=>{forgeFinished=true})
    let outcome
    try {
      await lockRequested
      assert.equal(forgeFinished,false)
      release();await dsh
      outcome=await forge
    } finally {release();provider.withLock=originalWithLock}
    assert.match(outcome.error?.message || '',/write-intent refused|file changed/)
    assert.equal(fs.readFileSync(path.join(root,'shared-lock.txt'),'utf8'),'DSH\n')
    provider.internals={}
    ok('Forge shares the real DSH provider write lock and rejects a stale plan after a staged built-in write')

    const external = path.join(outside,'external.js'); fs.writeFileSync(external,'function External() {}\n')
    fs.symlinkSync(external,path.join(root,'escape.js'))
    await call('ff_read',{path:'escape.js'},exec)
    await assert.rejects(()=>call('ffedit',{path:'escape.js',steps:[{start:1,text:'changed'}],reason:'escape'},exec),/workspace-write/)
    assert.match(fs.readFileSync(external,'utf8'),/External/)
    ok('workspace-write uses canonical target containment and rejects a symlink escaping the session workspace')

    const local = mount(), localExec = execFor()
    put('local.js'); await local.call('ff_read',{path:'local.js'},localExec)
    assert.equal((await local.call('ffedit',{path:'local.js',steps:[{start:1,text:'function Local() {}'}],reason:'local'},localExec)).status,'applied')
    local.provider.processPathFromHostPath = () => undefined
    await assert.rejects(()=>local.call('ff_read',{path:'local.js'},localExec),/not shared/)
    ok('shared local provider works; a remote/unshared mapping fails closed')

    fs.mkdirSync(path.join(root,'preloads/core'),{recursive:true})
    fs.writeFileSync(path.join(root,'preloads/core/registry.js'),"require('node:fs').writeFileSync('unexpected-execution','bad'); exports.describeApis=()=>[];")
    const traced = await call('fftrace',{target:'file:one.js'},exec)
    assert.equal(traced.decls,'absent'); assert.equal(fs.existsSync(path.join(root,'unexpected-execution')),false)
    fs.writeFileSync(path.join(root,'declarations.json'),JSON.stringify({apis:[],roleGlobals:{app:'appBridge'}}))
    assert.equal((await call('fftrace',{target:'file:one.js',declarations:'declarations.json'},exec)).decls,'ok')
    fs.writeFileSync(path.join(root,'declarations.json'),JSON.stringify({apis:[{name:'bad',roles:5}]}))
    assert.equal((await call('fftrace',{target:'file:one.js',declarations:'declarations.json'},exec)).decls,'failed')
    const abort = new AbortController()
    const pending = call('fftrace',{target:'file:one.js'},{...exec,signal:abort.signal})
    setImmediate(()=>abort.abort(new Error('trace cancelled')))
    await assert.rejects(()=>pending,/trace cancelled|resolve aborted/)
    const scanAbort=new AbortController()
    resetTraceFactsCache() // Ensure there is an in-flight scan to cancel.
    const scanning=createTraceTool().execute({target:'file:one.js'},{...exec,signal:scanAbort.signal})
    setImmediate(()=>scanAbort.abort(new Error('scan cancelled')))
    await assert.rejects(()=>scanning,/scan cancelled/)
    assert.equal(fs.existsSync(path.join(root,'unexpected-execution')),false)
    ok('Trace defaults to static facts, accepts validated JSON data, never executes registry, and honors cancellation')
    put('native.rs', '#[no_mangle]\npub extern "C" fn shared() {}\n')
    fs.writeFileSync(path.join(root,'native.wasm'), Buffer.from('0061736d01000000010401600000020c0103656e7604726561640000070a01067368617265640000','hex'))
    const ffi = await call('fftrace', {target:'ffi:shared'}, exec)
    assert.equal(ffi.ffi.total, 2); assert.ok(ffi.ffi.matches.some(ref=>ref.lang==='binary'))
    assert.ok(ffi.ffi.matches.some(ref=>ref.kind==='source-export'))
    ok('FFI source and binary evidence materialize through the installed SDK output schema')

    const roots = ['A','B'].map(name=>{const dir=path.join(base,name);fs.mkdirSync(dir);return dir})
    const stores = roots.map(storeFor)
    stores.forEach(store=>recordBatch(store,{kind:'edit',reason:'scope',actor:'test',nodes:[]}))
    const status = createStatusCommand({live:()=>roots.map(basePath=>({basePath,aux:false,finder:{healthCheck:()=>({ok:false,error:'test'})}}))})
    assert.equal((await status.handler({rawInput:'purge confirm=yes'})).kind,'error')
    let unlock
    const lock = withFileLock(stores[1].dir,()=>new Promise(resolve=>{unlock=resolve}))
    await new Promise(resolve=>setImmediate(resolve))
    let finished=false
    const purge = status.handler({rawInput:'purge confirm=yes',agent:{session:{header:{cwd:roots[1]}}}}).then(value=>{finished=true;return value})
    await new Promise(resolve=>setImmediate(resolve)); assert.equal(finished,false)
    unlock(); await lock; assert.equal((await purge).kind,'success')
    assert.equal(readLedgerTail(stores[0]).length,1); assert.equal(fs.existsSync(stores[1].dir),false)
    ok('purge is session-bound, refuses missing context, and waits for the workspace transaction lock')
    console.log(`${passed} host integration groups passed; runtime=${process.version}, electron=${process.versions.electron || 'none'}`)
  } finally {
    for (const dispose of disposers.reverse()) await dispose?.()
    if (previousData === undefined) delete process.env.DSH_FORGE_DATA_DIR; else process.env.DSH_FORGE_DATA_DIR=previousData
    fs.rmSync(base,{recursive:true,force:true,maxRetries:5,retryDelay:100})
  }
}
