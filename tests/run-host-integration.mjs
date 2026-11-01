// Registered SDK tools against the installed DSH provider + observation policy.
// No model, approval UI, upstream traffic, or installed profile changes.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { apply, Config, inject } from '../lib/index.js'
import { createStatusCommand } from '../lib/status.js'
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
    for (const dispose of apply(host, { surface: 'full' })) if (typeof dispose === 'function') disposers.push(dispose)
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
    const activation = new Context(), scope = new Context(), globalDefinitions = [], sections = []
    // The scope's `read` is the host built-in: the file#Symbol line follows it.
    activation.provide('tools', { register(definition) { globalDefinitions.push(definition); return () => {} },
      get(name, gotScope) { return globalDefinitions.find(d=>d.name===name) ?? (gotScope === scope && name === 'read' ? { name: 'read' } : undefined) } })
    activation.provide('commands', { register() { return () => {} } })
    activation.provide('fs', { observeNativeRead() {} })
    activation.provide('systemPrompt', { section(section) { sections.push(section); return () => {} } })
    const mounted = activation.plugin({ name:'forge-loader-regression', Config, inject, apply }, { surface:'full' })
    await new Promise(resolve=>setImmediate(resolve))
    // Augmentation registers no built-in name. The indexed specialist rows
    // remain global because their fuzzy/multi-pattern modes have no host
    // equivalent; the full Forge surface includes verification and project tools.
    assert.equal(globalDefinitions.length,10)
    assert.ok(!globalDefinitions.some(tool => ['read','grep','glob'].includes(tool.name)))
    // Per-tool schema shape (mode enums, parameter sets) is anchored in
    // run-registration; this test only proves the loader activated the surface.
    assert.ok(!globalDefinitions.some(tool => tool.name === 'ffcheck' || tool.name === 'ff_cards'), 'retired rows must not come back')
    assert.equal(sections.length,1)
    const activationGuidance = sections[0].text({scope})
    assert.match(activationGuidance,/ff_symbols view=outline/)
    assert.match(activationGuidance,/read with file_path=<file>#<Symbol>/)
    // This host provides only a built-in `read`, so the augmentation answers
    // read alone and the routing lines must not send the model to a built-in
    // grep/glob that is not there. The "built-in grep for plain/regex" wording
    // belongs to a host that also exposes them (run-mount covers that shape).
    assert.match(activationGuidance, /Find files → ff_find: fuzzy names and typos/)
    assert.match(activationGuidance, /Search contents → ff_grep: fuzzy by default/)
    assert.doesNotMatch(activationGuidance, /built-in (glob|grep) for/)
    mounted.dispose(); await new Promise(resolve=>setImmediate(resolve))
    ok('the installed Cordis loader validates the plugin Config and activates the full Forge surface')
    for (const defaultMode of ['read-only', 'workspace-write', 'danger-full-access']) {
      const { call } = mount(defaultMode)
      for (const mode of [undefined, 'read-only', 'workspace-write', 'danger-full-access']) {
        put('one.js')
        const exec = execFor(mode), effective = mode || defaultMode
        for (const [name, args] of [ ['ff_symbols',{view:'outline',path:'one.js'}], ['ff_trace',{target:'file:one.js'}], ['ff_grep',{pattern:'One'}],
          ['ff_find',{pattern:'one.js'}], ['ff_grep',{patterns:['One','return']}],
          ['ff_symbols',{view:'definitions',symbol:'One'}], ['ff_history',{}] ]) {
          await call(name,args,exec)
        }
        const mutation = () => call('ff_edit', {path:'one.js',steps:[{start:1,text:'function One() { return 2; }'}],reason:'sandbox integration'},exec)
        if (effective === 'read-only') {
          await assert.rejects(mutation,/read-only/)
          assert.match(fs.readFileSync(path.join(root,'one.js'),'utf8'),/return 1/)
        } else assert.equal((await mutation()).status,'applied')
        ok(`installed sandbox default=${defaultMode}, session=${mode || 'default'}: every advertised read plus write policy`)
      }
    }
    const { call, provider, host } = mount('workspace-write'), exec = execFor('workspace-write')
    // ff_read answers structure only (view=outline|definitions). Source windows,
    // `paths`/`glob` batching and `file#Symbol` reads moved to the built-in
    // `read`, which this harness does not mount; those observation cases are
    // covered where that seam exists (run-augment).
    ok('ff_read answers structure only; source reads belong to the built-in read')

    put('ticket.txt','A\nA\n')
    const ticket=await call('ff_edit',{path:'ticket.txt',steps:[{find:'A',replaceWith:'B'}],reason:'host ticket'},exec)
    assert.equal(ticket.status,'ticket')
    const resolved=await call('ff_edit',{ticket:ticket.ticket,choice:'0'},exec)
    assert.equal(resolved.status,'applied')
    assert.ok((await call('ff_history',{batch:resolved.batch},exec)).items.length)
    const rollback=await call('ff_rollback',{batch:resolved.batch,dryRun:false,reason:'host rollback'},exec)
    assert.ok(rollback.newBatch)
    assert.equal(fs.readFileSync(path.join(root,'ticket.txt'),'utf8'),'A\nA\n')
    ok('every registered read tool success contract, including ticket resolution, immutable diff and rollback, materialize in the actual SDK')

    put('sdk-check.js', 'const value = 1\n')
    const checkedEdit = await call('ff_edit', {path:'sdk-check.js',find:'value = 1',replaceWith:'value = 2',reason:'installed SDK verification',verify:['syntax']}, exec)
    assert.equal(checkedEdit.status, 'applied')
    assert.equal(checkedEdit.verification.status, 'passed')
    assert.equal(checkedEdit.verification.persisted, true)
    const checkedHistory = await call('ff_history', {batch:checkedEdit.batch,checks:true}, exec)
    assert.ok(checkedHistory.items.length > 0)
    assert.ok(checkedHistory.items[0].diffs.length > 0)
    assert.ok(checkedHistory.items[0].checks.some(record => checkedEdit.verification.id.startsWith(record.id)))
    // A verdict asked for on a call that wrote nothing has no batch to speak
    // for; it must say so rather than return a silent pass.
    const noChange = await call('ff_edit', {path:'sdk-check.js',find:'value = 2',replaceWith:'value = 2',reason:'no-op with a verdict request',verify:['syntax']}, exec)
    assert.equal(noChange.verification.status, 'not_run')
    const checkedDelete = await call('ff_file', {action:'remove',path:'sdk-check.js',reason:'installed SDK removed input'}, exec)
    assert.equal(typeof checkedDelete.batch, 'number')
    ok('installed SDK materializes the ffedit verify verdict and its history record, and refuses to invent one for a call that wrote nothing')


    // Race and symlink-observation regressions exercised ff_read's own read
    // path. That path is gone (the built-in read owns it) and this harness
    // mounts no built-in read, so the cases are retired with it.
    put('alias-one.js','function First() {}\n');put('alias-two.js','function Second() {}\n')
    const alias=path.join(root,'alias.js');fs.symlinkSync(path.join(root,'alias-one.js'),alias)
    const originalStat=provider.stat.bind(provider)

    const aliasOutline=await call('ff_symbols',{view:'outline',path:'alias.js'},execFor('workspace-write'))
    assert.match(JSON.stringify(aliasOutline),/First/)
    ok('a structural read follows a symlink to its canonical target')

    put('backing','export function Typed(value: number): number { return value; }\n')
    fs.symlinkSync(path.join(root,'backing'),path.join(root,'typed.ts'))
    const typedOutline = await call('ff_symbols',{view:'outline',path:'typed.ts'},execFor('workspace-write'))
    assert.match(JSON.stringify(typedOutline),/Typed/)
    ok('an extensionless symlink keeps its address language for structural reads')

    put('shared-lock.txt','BEFORE\n')
    const concurrentExec=execFor('workspace-write')
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
    const forge=call('ff_edit',{path:'shared-lock.txt',steps:[{start:1,text:'FORGE'}],reason:'provider concurrency'},concurrentExec)
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
    await assert.rejects(()=>call('ff_edit',{path:'escape.js',steps:[{start:1,text:'changed'}],reason:'escape'},exec),/workspace-write/)
    assert.match(fs.readFileSync(external,'utf8'),/External/)
    ok('workspace-write uses canonical target containment and rejects a symlink escaping the session workspace')

    const local = mount(), localExec = execFor()
    put('local.js')
    assert.equal((await local.call('ff_edit',{path:'local.js',steps:[{start:1,text:'function Local() {}'}],reason:'local'},localExec)).status,'applied')
    local.provider.processPathFromHostPath = () => undefined
    await assert.rejects(()=>local.call('ff_edit',{path:'local.js',steps:[{start:1,text:'function Remote() {}'}],reason:'unshared'},localExec),/not shared/)
    ok('shared local provider works; a remote/unshared mapping fails closed')

    fs.mkdirSync(path.join(root,'preloads/core'),{recursive:true})
    fs.writeFileSync(path.join(root,'preloads/core/registry.js'),"require('node:fs').writeFileSync('unexpected-execution','bad'); exports.describeApis=()=>[];")
    const traced = await call('ff_trace',{target:'file:one.js'},exec)
    assert.equal(traced.decls,'absent'); assert.equal(fs.existsSync(path.join(root,'unexpected-execution')),false)
    fs.writeFileSync(path.join(root,'declarations.json'),JSON.stringify({apis:[],roleGlobals:{app:'appBridge'}}))
    assert.equal((await call('ff_trace',{target:'file:one.js',declarations:'declarations.json'},exec)).decls,'ok')
    fs.writeFileSync(path.join(root,'declarations.json'),JSON.stringify({apis:[{name:'bad',roles:5}]}))
    assert.equal((await call('ff_trace',{target:'file:one.js',declarations:'declarations.json'},exec)).decls,'failed')
    const abort = new AbortController()
    const pending = call('ff_trace',{target:'file:one.js'},{...exec,signal:abort.signal})
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
    const ffi = await call('ff_trace', {target:'ffi:shared'}, exec)
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
    // Teardown must not be able to fail the run. On Windows a provider may still
    // hold a handle in `workspace/` for a moment, and `rmSync` then throws
    // ENOTEMPTY even with retries — measured with the safe-delete shim disabled.
    // The directory is disposable; a leftover temp tree is not a test result.
    try { fs.rmSync(base,{recursive:true,force:true,maxRetries:5,retryDelay:100}) } catch { /* leftover temp tree */ }
  }
}
