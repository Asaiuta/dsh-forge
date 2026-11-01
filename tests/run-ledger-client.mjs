import assert from 'node:assert/strict'
import { build } from 'esbuild'
import vm from 'node:vm'

// A deterministic hook renderer runs the real transformed TSX and event handlers.
// No DOM styling claims: these tests cover component state, requests and controls.
let active
const React = {
  createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity).filter(x => x !== null && x !== false && x !== undefined) } } },
  Fragment: 'fragment',
  useState(initial) { const h = active, i = h.i++; if (!(i in h.state)) h.state[i] = typeof initial === 'function' ? initial() : initial; return [h.state[i], value => { h.state[i] = typeof value === 'function' ? value(h.state[i]) : value; h.dirty = true }] },
  useRef(initial) { const h = active, i = h.i++; return h.state[i] ??= { current: initial } },
  useEffect(fn, deps) { const h = active, i = h.i++; if (!h.state[i] || !deps || deps.some((v,j) => v !== h.state[i].deps[j])) { h.effects.push(() => { h.state[i]?.cleanup?.(); h.state[i] = { deps, cleanup: fn() } }) } },
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
}
const pending = []
const fetch = (url, options = {}) => new Promise((resolve, reject) => pending.push({ url, options, resolve: body => resolve({ ok: body.ok !== false, status: body.ok === false ? 409 : 200, text: async () => JSON.stringify(body) }), reject }))
const output = await build({ entryPoints: ['src/client/ledger-tab.tsx','src/client/project-panel.tsx'], bundle: true, write: false, outdir: 'unused', format: 'cjs', jsx: 'transform', plugins: [{ name:'react-test', setup(b) { b.onResolve({filter:/^react$/},()=>({path:'react',namespace:'test'})); b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'module.exports = globalThis.__React',loader:'js'})) } }] })
function load(name) { const file = output.outputFiles.find(f => f.path.endsWith(name+'.js')); const context = { module: { exports:{} }, exports: {}, __React: React, React, fetch, AbortController, URLSearchParams, URL, Date, console, setTimeout, clearTimeout }; context.exports = context.module.exports; vm.runInNewContext(file.text, context); return context.module.exports }
const { LedgerTab } = load('ledger-tab')
const { ProjectPanel } = load('project-panel')
function mount(component, props) { const h = { state:[], effects:[], props, dirty:true, i:0, children:new Map() }; function expand(node,path='root') { if(!node||typeof node!=='object')return node; if(typeof node.type==='function') { const key=path+':'+(node.props.key??node.type.name); let child=h.children.get(key); if(!child){child={state:[],effects:[],i:0};h.children.set(key,child)} child.i=0;active=child;const result=node.type(node.props); const effects=child.effects.splice(0);effects.forEach(f=>f());return expand(result,key) } return {...node,props:{...node.props,children:(node.props?.children??[]).map((n,i)=>expand(n,path+'.'+i))}} } h.render = () => { active=h; h.i=0; h.tree=expand(component(h.props)); h.dirty=false; const effects=h.effects.splice(0); effects.forEach(f=>f()); return h.tree }; h.render(); return h }
function nodes(tree) { if (!tree || typeof tree !== 'object') return []; return [tree,...(tree.props?.children??[]).flatMap(nodes)] }
function control(h, label) { const n=nodes(h.tree).find(n=> n.props?.['aria-label']===label || (n.type==='button' && n.props.children.join('')===label)); assert.ok(n,`control ${label}`); return n }
function text(h) { return nodes(h.tree).flatMap(n=>n.props?.children?.filter(x=>typeof x==='string'||typeof x==='number')??[]).join(' ') }
async function flush(h) { for(let i=0;i<8;i++) { await new Promise(r=>setImmediate(r)); if(h.dirty) h.render() } }
function take(route) { const i=pending.findIndex(p=>p.url.includes(route)&&!p.options.signal?.aborted); assert.notEqual(i,-1,route); return pending.splice(i,1)[0] }
const batch = id => ({ id, ts:1, kind:'edit', actor:'agent', reason:'change '+id, files:[] })
const h=mount(LedgerTab,{scope:{cwd:'/a'},visible:true})
let req=take('/forge-ledger'); req.resolve({ok:true,workspace:'/a',batches:[batch(7)],total:23,nextCursor:'stable-1'}); await flush(h)
assert.match(text(h),/23/)
control(h,'关键词').props.onChange({target:{value:'needle'}}); control(h,'文件路径包含').props.onChange({target:{value:'src/'}}); control(h,'贡献者').props.onChange({target:{value:'agent'}}); control(h,'批次类型').props.onChange({target:{value:'edit'}}); h.render()
// The form, not a synthetic DOM submit, invokes the exact submit handler.
const form=nodes(h.tree).find(n=>n.type==='form'&&n.props['aria-label']==='台账筛选'); form.props.onSubmit({preventDefault(){}}); await flush(h)
req=take('/forge-ledger'); assert.match(req.url,/keyword=needle/); assert.match(req.url,/pathContains=src%2F/); assert.match(req.url,/actor=agent/); assert.match(req.url,/kind=edit/); assert.equal(control(h,'关键词').props.value,'needle'); req.resolve({ok:true,workspace:'/a',batches:[batch(7)],total:23,nextCursor:'stable-1'}); await flush(h)
control(h,'下一页').props.onClick(); await flush(h); req=take('/forge-ledger'); assert.match(req.url,/cursor=stable-1/); assert.match(req.url,/keyword=needle/); req.resolve({ok:true,workspace:'/a',batches:[batch(6)],total:23,nextCursor:null}); await flush(h)
control(h,'查看批次 #6').props.onClick(); await flush(h); const old=take('/forge-ledger'); h.props={scope:{cwd:'/b'},visible:true}; h.render(); await flush(h); assert.equal(old.options.signal.aborted,true); old.resolve({ok:true,batch:batch(6),nodes:[{node:'b6:n0',file:'OLD',diff:'old'}]}); await flush(h); assert.doesNotMatch(text(h),/OLD/)
req=take('/forge-ledger'); req.resolve({ok:true,workspace:'/b',batches:[batch(8)],total:1,nextCursor:null}); await flush(h)
control(h,'查看批次 #8').props.onClick(); await flush(h); take('/forge-ledger').resolve({ok:true,batch:batch(8),nodes:[{node:'b8:n0',file:'x',op:'edit',diff:'+x'}]}); await flush(h)
control(h,'回退整个批次').props.onClick(); h.render(); assert.equal(control(h,'预览回退').props.disabled,true)
control(h,'回退理由').props.onChange({target:{value:'repair'}}); h.render(); control(h,'预览回退').props.onClick(); await flush(h); req=take('/forge-ledger'); const body=JSON.parse(req.options.body); assert.equal(body.action,'preview'); assert.equal(body.selection.batch,8); assert.equal(body.selection.pathContains,undefined,'entire batch must not inherit the active path filter'); assert.equal(body.reason,'repair'); req.resolve({ok:true,token:'t',expiresAt:new Date(Date.now()+60000).toISOString(),preview:{status:'plan',items:[{file:'x',action:'restore',detail:'replace'}]}}); await flush(h)
control(h,'确认回退').props.onClick(); await flush(h); req=take('/forge-ledger'); assert.equal(JSON.parse(req.options.body).token,'t'); req.resolve({ok:false,error:'token expired'}); await flush(h); assert.match(text(h),/重新预览/); assert.equal(control(h,'确认回退').props.disabled,true)

// A node rollback cannot announce success before the confirmed server result.
control(h,'回退节点 b8:n0').props.onClick(); h.render(); control(h,'预览回退').props.onClick(); await flush(h); req=take('/forge-ledger'); assert.equal(JSON.parse(req.options.body).selection.node,'b8:n0'); req.resolve({ok:true,token:'node-token',expiresAt:new Date(Date.now()+60000).toISOString(),preview:{status:'plan',items:[]}}); await flush(h)
control(h,'确认回退').props.onClick(); await flush(h); assert.doesNotMatch(text(h),/已应用回退/); req=take('/forge-ledger'); req.resolve({ok:true,result:{status:'applied',newBatch:9,dryRun:false}}); await flush(h); assert.match(text(h),/已应用回退/)
// Mounting LedgerTab also mounts its collapsed project disclosure, just as React does.
for(const r of pending.splice(0)) r.resolve({ok:true,projects:[]});
const p=mount(ProjectPanel,{workspace:'/b',onWorkspace(){}}); req=take('/forge-projects'); req.resolve({ok:true,projects:[]}); await flush(p)
control(p,'工程名称').props.onChange({target:{value:'Workbench'}}); p.render(); control(p,'创建工程').props.onClick(); await flush(p); req=take('/forge-projects'); assert.equal(JSON.parse(req.options.body).action,'create'); const project={id:'p1',workspace:'/b',name:'Workbench',revision:1,status:'active',tasks:[{id:'t1',title:'Inspect',status:'pending'}],links:[],reports:[]}; req.resolve({ok:true,project}); await flush(p)
// Overview reads are asynchronous and must not clear the editable task list.
for(const r of pending.splice(0)) r.resolve({ok:true,project,overview:{actors:[],files:[],batches:0,lineChanges:{added:0,deleted:0,unavailable:0,method:'LCS'}}}); await flush(p)
assert.match(text(p),/人工验收/); assert.match(text(p),/机器检查/)
control(p,'任务状态 Inspect').props.onChange({target:{value:'done'}}); await flush(p); req=take('/forge-projects'); const update=JSON.parse(req.options.body); assert.equal(update.action,'task_update'); assert.equal(update.revision,1); assert.equal(update.status,'done'); req.resolve({ok:false,error:'revision conflict'}); await flush(p); assert.match(text(p),/revision conflict/)
let latest={...project,revision:2,tasks:[{id:'t1',title:'Inspect',note:'',status:'done'},{id:'t2',title:'Verify',note:'',status:'done'}]}
const overview={actors:[{actor:'agent',batches:1}],files:[{file:'src/x.ts',count:1}],batches:1,lineChanges:{added:1,deleted:0,unavailable:0,method:'LCS'}}
async function settleReads(){for(let i=0;i<4;i++){for(const r of pending.splice(0)){if(r.options.signal?.aborted)continue;assert.equal(r.options.body,undefined);r.resolve({ok:true,project:latest,projects:[latest],overview})}await flush(p)}}
control(p,'重新读取当前工程').props.onClick(); await flush(p); await settleReads(); assert.match(text(p),/src\/x.ts/)
control(p,'任务备注 Inspect').props.onChange({target:{value:'evidence kept'}}); p.render(); control(p,'保存任务').props.onClick(); await flush(p); req=take('/forge-projects'); let action=JSON.parse(req.options.body); assert.equal(action.action,'task_update'); assert.equal(action.note,'evidence kept'); assert.equal(action.revision,2); latest={...latest,revision:3,tasks:latest.tasks.map(t=>t.id==='t1'?{...t,note:'evidence kept'}:t)};req.resolve({ok:true,project:latest});await flush(p);await settleReads()
control(p,'关联批次编号').props.onChange({target:{value:'8'}}); control(p,'关联任务 Inspect').props.onChange({target:{checked:true}});control(p,'关联任务 Verify').props.onChange({target:{checked:true}});p.render();control(p,'关联选中任务').props.onClick();await flush(p)
for(const [taskId,revision] of [['t1',3],['t2',4]]){req=take('/forge-projects');action=JSON.parse(req.options.body);assert.equal(action.action,'link');assert.equal(action.taskId,taskId);assert.equal(action.batchId,8);assert.equal(action.revision,revision);latest={...latest,revision:revision+1,links:[...latest.links,{taskId,batchId:8}]};req.resolve({ok:true,project:latest});await flush(p)}await settleReads()
control(p,'报告结论').props.onChange({target:{value:'Ready for review'}});control(p,'报告问题').props.onChange({target:{value:'first issue\n\nsecond issue'}});control(p,'报告状态').props.onChange({target:{value:'review'}});p.render();control(p,'提交报告').props.onClick();await flush(p);req=take('/forge-projects');action=JSON.parse(req.options.body);assert.equal(action.action,'report');assert.equal(action.status,'review');assert.equal(action.revision,5);assert.deepEqual(action.issues,['first issue','second issue']);assert.equal(action.conclusion,'Ready for review');req.resolve({ok:false,error:'revision conflict'});await flush(p);assert.equal(control(p,'报告结论').props.value,'Ready for review')
console.log('run-ledger-client: 18 behavior scenarios passed; 0 failed (real TSX state/events + mocked HTTP, no DOM/layout claims)')
