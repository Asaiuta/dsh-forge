import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const temp = mkdtempSync(path.join(os.tmpdir(), 'forge-projects-'))
process.env.DSH_FORGE_DATA_DIR = path.join(temp, 'private')
const { projectAction: act, listProjects, getProject, projectOverview } = await import('../src/projects.ts')
const { storeFor, recordBatch, putBlob } = await import('../src/ledger.ts')
const { createProjectTool } = await import('../src/tools-project.ts')
let passed = 0
async function test(name, fn) { await fn(); console.log('PASS', name); passed++ }
const workspace = path.join(temp, 'work'); mkdirSync(workspace)
const other = path.join(temp, 'other'); mkdirSync(other)
const call = args => act({ workspace, ...args })
let p
try {
await test('create normalized workspace; multiple projects and cross-workspace private search', async () => {
 p = await call({ action: 'create', name: 'Alpha' })
 assert.equal(p.status, 'active'); assert.equal(p.revision, 1)
 await call({ action: 'create', name: 'Beta' })
 await act({ action: 'create', workspace: other, name: 'Gamma' })
 assert.equal(listProjects().length, 3); assert.equal(listProjects({ query: 'ALPHA' }).length, 1)
 assert.equal(listProjects({ workspace }).length, 2)
 assert.equal(listProjects({query:''}).length,3)
 assert.equal(getProject(path.join(workspace, '..', 'work'),p.id).workspace,workspace)
})
await test('strong unknown-field/status/revision validation and no storage mutation on failure', async () => {
 const file = path.join(storeFor(workspace).dir, 'projects.json'); const bytes = readFileSync(file)
 for (const input of [
 {action:'update', projectId:p.id, revision:p.revision, status:'passed'},
 {action:'task_add', projectId:p.id, revision:p.revision, title:'x', stray:true},
 {action:'update', projectId:p.id, revision:0, name:'bad'},
 {action:'update', projectId:p.id, revision:p.revision, name:'  '},
 {action:'task_add', projectId:p.id, revision:p.revision, title:'bad',status:'accepted'},
 {action:'update', projectId:p.id, revision:p.revision},
 {action:'report', projectId:p.id, revision:p.revision,conclusion:'x',issues:[1],status:'draft'},
 {action:'create',name:'x',status:'active'},
 {action:'unknown'},
 {action:'create',name:'x',workspace:'.'},
 {action:'task_add',projectId:p.id,revision:p.revision,title:'bad',status:'note'},
 {action:'task_add',projectId:p.id,revision:p.revision,title:'bad',note:1},
 {action:'create',name:'x',workspace:path.join(temp,'missing')},
 {action:'task_delete',projectId:p.id,revision:p.revision,taskId:'not-found'},
 ]) await assert.rejects(call(input))
 assert.deepEqual(readFileSync(file), bytes)
})
await test('optimistic concurrency serializes shared workspace writes', async () => {
 const result = await Promise.allSettled(['One','Two'].map(title => call({action:'task_add', projectId:p.id, revision:p.revision, title})))
 assert.equal(result.filter(x=>x.status==='fulfilled').length,1)
 p = getProject(workspace,p.id); assert.equal(p.tasks.length,1)
 p = await call({action:'task_add',projectId:p.id,revision:p.revision,title:'Second',note:'Independent note'})
 assert.equal(p.tasks[1].note,'Independent note'); assert.equal(p.tasks[0].note,'')
 p=await call({action:'task_update',projectId:p.id,revision:p.revision,taskId:p.tasks[1].id,note:'Changed note'})
 assert.equal(getProject(workspace,p.id).tasks[1].note,'Changed note')
})
let batch
await test('batch links validate existing id and workspace; many tasks share immutable batch', async () => {
 const store=storeFor(workspace); const before=putBlob(store,Buffer.from('a\nb\n')); const after=putBlob(store,Buffer.from('a\nc\nd\n'))
 batch=recordBatch(store,{kind:'edit',reason:'test',actor:'alice',nodes:[{file:'a.ts',op:'update',before:before.id,after:after.id,bytes:6,eol:'LF',bom:false}]})
 const original=readFileSync(store.ledgerFile)
 await assert.rejects(call({action:'link',projectId:p.id,revision:p.revision,taskId:p.tasks[0].id,batchId:999}))
 for(const task of p.tasks) p=await call({action:'link',projectId:p.id,revision:p.revision,taskId:task.id,batchId:batch.id})
 assert.equal(p.links.length,2); assert.deepEqual(readFileSync(store.ledgerFile),original)
 let foreign=await act({action:'create',workspace:other,name:'Foreign'})
 foreign=await act({action:'task_add',workspace:other,projectId:foreign.id,revision:foreign.revision,title:'Foreign task'})
 await assert.rejects(act({action:'link',workspace:other,projectId:foreign.id,revision:foreign.revision,taskId:foreign.tasks[0].id,batchId:batch.id}),/batch not found/)
 const overview=projectOverview(workspace,p.id)
 assert.equal(overview.batches,1); assert.equal(overview.files[0].count,1); assert.equal(overview.actors[0].actor,'alice')
 assert.equal(overview.lineChanges.added,2); assert.equal(overview.lineChanges.deleted,1)
})
await test('reports snapshot summaries; accepted rejects incomplete tasks including archived tasks', async () => {
 await assert.rejects(call({action:'report',projectId:p.id,revision:p.revision,conclusion:'ready',issues:[],status:'accepted'}))
 p=await call({action:'task_update',projectId:p.id,revision:p.revision,taskId:p.tasks[0].id,archived:true})
 await assert.rejects(call({action:'update',projectId:p.id,revision:p.revision,status:'accepted'}))
 p=await call({action:'report',projectId:p.id,revision:p.revision,conclusion:'Review',issues:['remaining'],status:'review'})
 assert.equal(p.status,'review'); assert.equal(p.reports.at(-1).summary.batches,1)
 p=await call({action:'report',projectId:p.id,revision:p.revision,conclusion:'Draft',issues:[],status:'draft'})
 assert.equal(p.status,'review'); assert.equal(p.reports.at(-1).status,'draft')
 for(const task of p.tasks) p=await call({action:'task_update',projectId:p.id,revision:p.revision,taskId:task.id,status:'done'})
 p=await call({action:'report',projectId:p.id,revision:p.revision,conclusion:'Complete',issues:[],status:'accepted'})
 assert.equal(p.status,'accepted'); assert.equal(p.reports.at(-1).status,'accepted')
 await assert.rejects(call({action:'task_add',projectId:p.id,revision:p.revision,title:'unfinished'}))
})
await test('delete tasks cascades links without dangling references; persistent reload', async () => {
 p=await call({action:'task_delete',projectId:p.id,revision:p.revision,taskId:p.tasks[0].id})
 assert.equal(p.links.length,1)
 const reload=await import('../src/projects.ts?reload=1')
 assert.deepEqual(reload.getProject(workspace,p.id),p)
 assert.equal(reload.listProjects().length,4)
})
await test('unlink and manual project archive remain distinct from machine verification', async () => {
 p=await call({action:'unlink',projectId:p.id,revision:p.revision,taskId:p.tasks[0].id,batchId:batch.id})
 assert.equal(p.links.length,0)
 p=await call({action:'update',projectId:p.id,revision:p.revision,name:'Renamed',status:'archived'})
 assert.equal(p.status,'archived'); assert.equal(p.name,'Renamed'); assert.equal('passed' in p,false)
})
await test('tool has ff_project name and strict dispatcher error surface', async () => {
 const tool=createProjectTool(); assert.equal(tool.name,'ff_project')
 assert.equal(tool.isConcurrencySafe(),false)
 assert.equal(tool.output.schema.additionalProperties,false)
 for (const key of ['ok','action','payload']) assert.equal(tool.output.schema.properties[key].required,true)
 const success=await tool.execute({action:'get',workspace,projectId:p.id})
 assert.equal(success.ok,true); assert.equal(success.action,'get'); assert.equal(success.payload.project.id,p.id)
 assert.equal(tool.output.render({},success)[0].type,'text')
 const result=await tool.execute({action:'get',workspace,projectId:p.id,unexpected:true})
 assert.equal(result.ok,false); assert.deepEqual(result.payload,{})
 assert.match(result.error,/unexpected|unknown/i)
 assert.match(tool.output.render({},result)[0].text,/unexpected|unknown/i)
})
console.log(`${passed} passed, 0 failed`)
} finally { rmSync(temp,{recursive:true,force:true}) }
