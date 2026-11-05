import assert from 'node:assert/strict'
import { build } from 'esbuild'
import vm from 'node:vm'
let active
const React = {
 createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity).filter(x => x !== null && x !== false && x !== undefined) } } }, Fragment: 'fragment',
 useState(initial) { const h=active,i=h.i++; if(!(i in h.state))h.state[i]=typeof initial==='function'?initial():initial;return [h.state[i],v=>{h.state[i]=typeof v==='function'?v(h.state[i]):v}] },
 useRef(initial) { const h=active,i=h.i++;return h.state[i]??={current:initial} },
 useEffect(fn,deps) { const h=active,i=h.i++;if(!h.state[i]||!deps||deps.some((v,j)=>v!==h.state[i].deps[j]))h.effects.push(()=>{h.state[i]?.cleanup?.();h.state[i]={deps,cleanup:fn()}}) }, useCallback(fn){return fn}, useMemo(fn){return fn()},
}
const pending=[]
const fetch=(url,options={})=>new Promise(resolve=>pending.push({url,options,resolve:body=>resolve({ok:body.ok!==false,status:body.ok===false?409:200,text:async()=>JSON.stringify(body)})}))
const output=await build({entryPoints:['src/client/ledger-tab.tsx'],bundle:true,write:false,format:'cjs',jsx:'transform',plugins:[{name:'react-test',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:process.cwd()+'/tests/native-ui-fixture.cjs'}));b.onResolve({filter:/^react$/},()=>({path:'react',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'module.exports=globalThis.__React',loader:'js'}))}}]})
const context={module:{exports:{}},exports:{},__React:React,React,fetch,AbortController,URLSearchParams,URL,Date,console,setTimeout,clearTimeout};context.exports=context.module.exports;vm.runInNewContext(output.outputFiles[0].text,context)
function mount(component,props){const instances=new Map();const h={props};function expand(node,key){if(!node||typeof node!=='object')return node;if(typeof node.type==='function'){key+=':'+(node.props.key??node.type.name);let inst=instances.get(key);if(!inst){inst={state:[],effects:[],i:0};instances.set(key,inst)}inst.i=0;active=inst;const value=node.type(node.props);inst.effects.splice(0).forEach(f=>f());return expand(value,key)}return {...node,props:{...node.props,children:(node.props?.children??[]).map((n,i)=>expand(n,key+'.'+i))}}}h.render=()=>{h.tree=expand(React.createElement(component,h.props),'root')};h.render();return h}
function nodes(t){return !t||typeof t!=='object'?[]:[t,...(t.props?.children??[]).flatMap(nodes)]}
function control(h,label){const n=nodes(h.tree).find(n=>n.props?.['aria-label']===label||(n.type==='button'&&n.props.children.join('')===label));assert.ok(n,'control '+label);return n}
// A stand-in for better-sidebar's openTab: records the seed so the contract can
// assert WHICH tab the Git page asks for, and can be told to fail.
let openCalls=[]
const fakeOpenGit=(ok=true)=>()=>{openCalls.push('git'); return ok}
function take(route){const i=pending.findIndex(p=>p.url.includes(route)&&!p.options.signal?.aborted);assert.notEqual(i,-1,route);return pending.splice(i,1)[0]}

async function flush(h){for(let i=0;i<5;i++){await new Promise(r=>setImmediate(r));h.render()}}
const project={id:'p1',workspace:'/w',name:'Project',revision:1,status:'active',tasks:[{id:'t1',title:'Inspect',status:'pending'}],links:[{taskId:'t1',batchId:8}],reports:[{id:'r1',status:'review',conclusion:'Ready',issues:[],evidence:{version:1,projectRevision:1,batches:[{id:8,nodes:[{node:'b8:n0',file:'src/x.ts',before:'a',after:'b'}]}],verification:[{id:'v1',recorded:'passed',effective:'stale',applicable:false,drifted:['src/x.ts']}]}}]}
project.todoSource={sessionId:'session-todo',callId:'call-todo',capturedAt:1,todos:[{content:'Original Todo task',status:'in_progress'}]}
const overview={actors:[{actor:'agent',batches:1}],files:[{file:'src/x.ts',count:1}],batches:1,lineChanges:{added:1,deleted:0,unavailable:0,method:'LCS'}}
const batch={id:8,ts:1,kind:'edit',actor:'agent',reason:'change',files:[],membership:'direct',attribution:{projectId:'p1',taskId:'t1'}}
const h=mount(context.module.exports.LedgerTab,{scope:{cwd:'/w'},visible:true,openGitTab:fakeOpenGit()})
// Layout contracts run before network data: navigation exists for empty workspaces.
assert.ok(nodes(h.tree).some(n => n.props?.['aria-label'] === '工程索引'), 'project index exists outside an accordion')
for (const value of ['plan','timeline','files','detail','git']) assert.ok(nodes(h.tree).some(n => n.props?.id === `forge-panel-${value}`), `panel ${value} exists`)
assert.ok(nodes(h.tree).some(n => n.props?.['data-native-tabs'] === '工程视图'), 'host SegmentedTabs owns navigation')
assert.deepEqual(nodes(h.tree).filter(n=>n.props?.role==='tab').map(n=>n.props.children.join('')), ['计划','施工线','改动文件','详情','Git'])
for (const value of ['plan','timeline','files','detail','git','timeline']) {
 const tab=nodes(h.tree).find(n=>n.props?.id===`forge-tab-${value}`); tab.props.onClick(); await flush(h)
 const visible=nodes(h.tree).filter(n=>n.props?.role==='tabpanel'&&!n.props.hidden)
 assert.equal(visible.length,1,'only one project page is visible'); assert.equal(visible[0].props.id,`forge-panel-${value}`)
 assert.ok(!pending.some(p=>p.options.body),'tab changes never mutate data')
}
take('/forge-projects').resolve({ok:true,projects:[project]});take('/forge-ledger').resolve({ok:true,batches:[batch],total:1});await flush(h)
nodes(h.tree).find(n=>n.props?.id==='forge-tab-plan').props.onClick(); await flush(h)
assert.ok(!nodes(h.tree).some(n=>n.props?.['aria-label']==='最近计划'),'no second selection surface: the menu is the only entry')
assert.ok(!nodes(h.tree).some(n=>n.type==='button'&&[...(n.props.children??[])].join('').includes('打开这份计划')),'no duplicate open action in the plan page')
assert.ok(control(h,'最新计划任务').props.children.length===1,'the newest plan content is shown before any selection')
assert.ok(nodes(h.tree).some(n=>n.props?.['aria-label']==='最新计划'),'plan preview owns the space the list used to take')
h.props={...h.props,visible:false}; h.render(); h.props={...h.props,visible:true}; h.render(); await flush(h)
assert.ok(take('/forge-projects'),'showing the tab again reloads plans')

control(h,'选择工程').props.onChange({target:{value:'p1'}});await flush(h)
let req=take('/forge-ledger');assert.equal(new URL(req.url,'http://test').searchParams.get('projectId'),'p1');req.resolve({ok:true,batches:[batch],total:1})
for(const r of pending.splice(0))if(!r.options.signal?.aborted)r.resolve({ok:true,project,overview});await flush(h)
assert.equal(control(h,'引用的 Todo 快照').props.children.length,1,'plan references Todo snapshot')
assert.ok(nodes(h.tree).some(n=>n.type==='p'&&n.props.children.join('').includes('session-todo')),'Todo source session is visible')
control(h,'任务备注 Inspect').props.onChange({target:{value:'unsaved task draft'}}); h.render()
for(const value of ['detail','files','plan']) { nodes(h.tree).find(n=>n.props?.id===`forge-tab-${value}`).props.onClick(); await flush(h) }
assert.equal(control(h,'任务备注 Inspect').props.value,'unsaved task draft','task draft survives page switching')
nodes(h.tree).find(n=>n.props?.id==='forge-tab-detail').props.onClick(); await flush(h)
control(h,'报告结论').props.onChange({target:{value:'unsaved report draft'}}); h.render()
for(const value of ['plan','detail']) { nodes(h.tree).find(n=>n.props?.id===`forge-tab-${value}`).props.onClick(); await flush(h) }
assert.equal(control(h,'报告结论').props.value,'unsaved report draft','report draft survives page switching')
assert.ok(!pending.some(p=>p.options.body),'editing drafts and navigating never submit them')
control(h,'查看任务施工 Inspect').props.onClick();await flush(h);req=take('/forge-ledger');assert.match(req.url,/taskId=t1/);assert.match(req.url,/projectId=p1/);req.resolve({ok:true,batches:[batch],total:1});await flush(h)
control(h,'查看文件历史 src/x.ts').props.onClick();await flush(h);req=take('/forge-ledger');assert.match(req.url,/file=src%2Fx.ts/);assert.doesNotMatch(req.url,/taskId=/);req.resolve({ok:true,batches:[batch],total:1});await flush(h)
control(h,'查看批次 #8').props.onClick();await flush(h);take('/forge-ledger').resolve({ok:true,batch,nodes:[{node:'b8:n0',file:'src/x.ts',op:'update',diff:'+new',truncated:true}]});await flush(h)
control(h,'恢复节点 b8:n0 完成后版本').props.onClick();await flush(h);control(h,'回退理由').props.onChange({target:{value:'restore after'}});h.render();control(h,'预览回退').props.onClick();await flush(h);req=take('/forge-ledger');assert.equal(JSON.parse(req.options.body).selection.version,'after');assert.equal(JSON.parse(req.options.body).selection.node,'b8:n0');req.resolve({ok:true,token:'t',expiresAt:new Date(Date.now()+60000).toISOString(),preview:{status:'plan',items:[]}});await flush(h)
control(h,'查看完整快照 b8:n0').props.onClick();await flush(h)
for(const side of ['before','after']){req=take('/forge-ledger');assert.match(req.url,/node=b8%3An0/);assert.equal(new URL(req.url,'http://test').searchParams.get('side'),side);req.resolve({ok:true,snapshot:{node:'b8:n0',file:'src/x.ts',side,status:'text',hash:side,bytes:70000,total:70000,offset:0,nextOffset:32768,text:side}})}await flush(h)
control(h,'after 快照下一页').props.onClick();await flush(h);req=take('/forge-ledger');assert.match(req.url,/offset=32768/)
req.resolve({ok:true,snapshot:{node:'b8:n0',file:'src/x.ts',side:'after',status:'text',hash:'after',bytes:70000,total:70000,offset:32768,nextOffset:65536,text:'next'}});await flush(h)
control(h,'← 返回台账').props.onClick();await flush(h);control(h,'仅看未归属批次').props.onChange({target:{checked:true}});await flush(h);req=take('/forge-ledger');assert.match(req.url,/unassigned=true/);assert.doesNotMatch(req.url,/projectId=/);req.resolve({ok:true,batches:[],total:0});await flush(h)
// --- Git page: the door to better-sidebar's own Git tab, with a read-only fallback ---
// Regression for the crash: better-sidebar's openTab reduces its store
// SYNCHRONOUSLY, which re-renders us. If the opener is re-created on every
// render (as `openBuiltinGitTab(sidebar)` was, inline in the tab factory), the
// effect's dependency changes each pass and the open recurs forever until React
// aborts with "Maximum update depth exceeded".
openCalls=[]
{
 const fresh=()=>()=>{openCalls.push('git');return true}
 const looping=mount(context.module.exports.LedgerTab,{scope:{cwd:'/w'},visible:true,openGitTab:fresh()})
 nodes(looping.tree).find(n=>n.props?.id==='forge-tab-git').props.onClick(); await flush(looping)
 const afterFirst=openCalls.length
 for(let i=0;i<5;i++){ looping.props={...looping.props,openGitTab:fresh()}; looping.render(); await flush(looping) }
 assert.equal(openCalls.length,afterFirst,'a re-created opener must not re-open on every render')
 assert.equal(afterFirst,1,'entering the Git page opens it exactly once')
}
openCalls=[]
nodes(h.tree).find(n=>n.props?.id==='forge-tab-git').props.onClick(); await flush(h)
assert.equal(openCalls.length,1,'arriving on the Git page asks better-sidebar for its Git tab')
assert.equal(openCalls[0],'git','the requested tab is the builtin git tab, not our own page')
assert.ok(nodes(h.tree).some(n=>n.props?.['aria-label']==='Git 委派'),'the page reports the delegation')
assert.ok(!pending.some(p=>p.url.includes('/forge-git')),'delegation does not also fetch our read-only data')

const fallback=mount(context.module.exports.LedgerTab,{scope:{cwd:'/w'},visible:true,openGitTab:fakeOpenGit(false)})
nodes(fallback.tree).find(n=>n.props?.id==='forge-tab-git').props.onClick(); await flush(fallback)
assert.ok(nodes(fallback.tree).some(n=>n.props?.['aria-label']==='Git 委派'),'a refused open keeps the page')
assert.ok(nodes(fallback.tree).some(n=>n.type==='button'&&[...(n.props.children??[])].join('').includes('再试一次')),'and offers a retry')
assert.ok(!pending.some(p=>p.url.includes('/forge-git')),'a refused open does not silently take the fallback')

control(fallback,'改用插件的只读 Git 视图').props.onClick(); await flush(fallback)
const gitReq=take('/forge-git'); assert.match(gitReq.url,/workspace=/,'the fallback reads the read-only route')
gitReq.resolve({ok:true,repo:{isRepo:true,toplevel:'/w',prefix:'',branch:{head:'master',upstream:'origin/master',ahead:2,behind:0,detached:false,initial:false},remotes:['origin'],staged:[{path:'src/a.ts',origPath:null,status:'M',added:3,removed:1,binary:false}],changes:[{path:'src/b.ts',origPath:null,status:'U',added:null,removed:null,binary:false}],conflicts:[],total:2}}); await flush(fallback)
const f=label=>control(fallback,label), has=pred=>nodes(fallback.tree).some(pred)
assert.ok(has(n=>n.props?.children?.join('')==='master'),'branch is visible')
assert.ok(has(n=>n.props?.children?.join('')==='↑2 ↓0'),'ahead/behind is visible')
assert.ok(f('查看差异 src/a.ts'),'staged entry is listed')
assert.ok(f('查看差异 src/b.ts'),'working-tree entry is listed')
f('收起目录 src').props.onClick(); fallback.render()
assert.ok(!has(n=>n.props?.['aria-label']==='查看差异 src/a.ts'),'a collapsed directory hides its files')
assert.ok(has(n=>n.props?.['aria-label']==='展开目录 src'),'the row now offers to expand')
f('展开目录 src').props.onClick(); fallback.render()
assert.ok(f('查看差异 src/a.ts'),'expanding brings the file back')
for(const verb of ['暂存','提交','推送','丢弃','stage','commit','push','discard'])
 assert.ok(!has(n=>n.type==='button'&&[...(n.props.children??[])].join('')===verb),`read-only view offers no ${verb} action`)
f('查看差异 src/a.ts').props.onClick(); await flush(fallback)
const diffReq=take('/forge-git'); assert.match(diffReq.url,/file=src%2Fa.ts/)
diffReq.resolve({ok:true,diff:{path:'src/a.ts',before:{exists:true,binary:false,oversized:false,text:'const a = 1;',bytes:20},after:{exists:true,binary:false,oversized:false,text:'const a = 2;',bytes:20}}}); await flush(fallback)
const rowsAll=nodes(fallback.tree).filter(n=>n.props?.role==='row')
assert.equal(rowsAll.length,1,'one aligned row, not two raw panes')
assert.equal(rowsAll[0].props['data-kind'],'mod','a one-for-one rewrite is a mod row')
const marks=nodes(fallback.tree).filter(n=>n.type==='mark')
assert.equal(marks.length,1,'exactly one intraline span is marked')
assert.equal(marks[0].props.children.join(''),'2','only the changed character is marked')
assert.ok(!pending.some(p=>p.options.body),'the Git surfaces never post a body')

console.log('run-ledger-navigation: 7 navigation scenarios + 2 page-structure groups + Git delegation passed; 0 failed (real TSX; mocked native controls/HTTP; no browser layout claims)')
