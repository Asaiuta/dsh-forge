import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { dataDir, withFileLock } from './core.ts'
import { canonicalWorkspace } from './fs-paths.ts'
import { atomicWrite, getBlob, readLedgerTail, storeFor, type LedgerBatch } from './ledger.ts'

export type ProjectStatus = 'active' | 'review' | 'accepted' | 'archived'
export type TaskStatus = 'pending' | 'doing' | 'done' | 'blocked'
export interface ProjectTask { id: string; title: string; note: string; status: TaskStatus; archived: boolean; createdAt: number; updatedAt: number }
export interface ProjectLink { taskId: string; batchId: number }
export interface ProjectOverview {
  batches: number; tasks: Array<{ id: string; title: string; note: string; status: TaskStatus; archived: boolean }>
  actors: Array<{ actor: string; batches: number }>; files: Array<{ file: string; count: number }>
  lineChanges: { added: number; deleted: number; unavailable: number; method: string }
}
export interface ProjectReport { id: string; createdAt: number; status: 'draft' | 'review' | 'accepted'; conclusion: string; issues: string[]; summary: ProjectOverview }
export interface Project { id: string; name: string; workspace: string; status: ProjectStatus; createdAt: number; updatedAt: number; revision: number; tasks: ProjectTask[]; links: ProjectLink[]; reports: ProjectReport[] }
interface ProjectStore { version: 1; workspace: string; projects: Project[] }
const projectStatuses = ['active', 'review', 'accepted', 'archived'] as const
const taskStatuses = ['pending', 'doing', 'done', 'blocked'] as const
const fields: Record<string, readonly string[]> = {
 create: ['name'], list: ['query'], get: ['projectId'], overview: ['projectId'],
 update: ['projectId','revision','name','status'],
 task_add: ['projectId','revision','title','status','note'],
 task_update: ['projectId','revision','taskId','title','status','archived','note'],
 task_delete: ['projectId','revision','taskId'],
 link: ['projectId','revision','taskId','batchId'], unlink: ['projectId','revision','taskId','batchId'],
 report: ['projectId','revision','conclusion','issues','status'],
}
function object(value: unknown): asserts value is Record<string, unknown> {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object')
}
function text(value: unknown, label: string): string {
 if (typeof value !== 'string' || !value.trim() || value.length > 20000) throw new Error(`${label} must be a nonempty string (max 20000 characters)`)
 return value.trim()
}
function optionalText(value: unknown, label: string): string {
 if (typeof value !== 'string' || value.length > 20000) throw new Error(`${label} must be a string (max 20000 characters)`)
 return value.trim()
}
function integer(value: unknown, label: string): number {
 if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive safe integer`)
 return value as number
}
function choice<T extends string>(value: unknown, values: readonly T[], label: string): T {
 if (!values.includes(value as T)) throw new Error(`invalid ${label}: ${String(value)}`)
 return value as T
}
function complete(p: Project): void {
 if (p.tasks.some(t => t.status !== 'done')) throw new Error('accepted requires all tasks done, including archived tasks')
}
function validateProject(p: Project, workspace: string): void {
 object(p); text(p.id,'id'); text(p.name,'name'); integer(p.revision,'revision'); choice(p.status,projectStatuses,'status')
 if (p.workspace !== workspace || !Number.isFinite(p.createdAt) || !Number.isFinite(p.updatedAt) || !Array.isArray(p.tasks) || !Array.isArray(p.links) || !Array.isArray(p.reports)) throw new Error('invalid project storage')
 const ids = new Set<string>()
 for (const t of p.tasks) {
  object(t); text(t.id,'task id'); text(t.title,'title'); optionalText(t.note,'note'); choice(t.status,taskStatuses,'task status')
  if (ids.has(t.id) || typeof t.archived !== 'boolean' || !Number.isFinite(t.createdAt) || !Number.isFinite(t.updatedAt)) throw new Error('invalid task storage')
  ids.add(t.id)
 }
 const links = new Set<string>()
 for (const l of p.links) {
  object(l); integer(l.batchId,'batchId'); const key = `${l.taskId}:${l.batchId}`
  if (!ids.has(l.taskId) || links.has(key)) throw new Error('dangling or duplicate task link')
  links.add(key)
 }
 const reports = new Set<string>()
 for (const r of p.reports) {
  object(r); text(r.id,'report id'); text(r.conclusion,'conclusion'); choice(r.status,['draft','review','accepted'],'report status')
  if (reports.has(r.id) || !Number.isFinite(r.createdAt) || !Array.isArray(r.issues) || r.issues.some(i => typeof i !== 'string' || !i.trim())) throw new Error('invalid report storage')
  object(r.summary); reports.add(r.id)
 }
 if (p.status === 'accepted') complete(p)
}
function load(file: string, workspace?: string): ProjectStore {
 if (!existsSync(file)) {
  if (!workspace) throw new Error('missing project store')
  return { version: 1, workspace, projects: [] }
 }
 const state = JSON.parse(readFileSync(file,'utf8')) as ProjectStore
 object(state)
 if (state.version !== 1 || typeof state.workspace !== 'string' || (workspace && state.workspace !== workspace) || !Array.isArray(state.projects)) throw new Error('invalid project store')
 const ids = new Set<string>()
 for (const p of state.projects) { validateProject(p,state.workspace); if (ids.has(p.id)) throw new Error('duplicate project id'); ids.add(p.id) }
 return state
}
function location(workspace: string) {
 const requested = text(workspace,'workspace')
 if (!path.isAbsolute(requested)) throw new Error('workspace must be an absolute path')
 const root = canonicalWorkspace(requested); const store = storeFor(root)
 return { root, store, file: path.join(store.dir,'projects.json') }
}
export function getProject(workspace: string, projectId: string): Project {
 const loc = location(workspace); const p = load(loc.file,loc.root).projects.find(p => p.id === text(projectId,'projectId'))
 if (!p) throw new Error('project not found')
 return p
}
/** Enumerates only forge private store files, never traverses user workspaces. */
export function listProjects(filter: { workspace?: string; query?: string } = {}): Project[] {
 const query = filter.query === undefined ? '' : optionalText(filter.query,'query').toLocaleLowerCase()
 let projects: Project[]
 if (filter.workspace !== undefined) { const loc = location(filter.workspace); projects = load(loc.file,loc.root).projects }
 else {
  const base = path.join(dataDir(),'snapshots'); projects = []
  if (existsSync(base)) for (const entry of readdirSync(base,{withFileTypes:true})) {
   if (!entry.isDirectory()) continue
   const file = path.join(base,entry.name,'projects.json')
   if (existsSync(file)) projects.push(...load(file).projects)
  }
 }
 return projects.filter(p => !query || `${p.id} ${p.name} ${p.workspace} ${p.tasks.map(t=>t.title).join(' ')}`.toLocaleLowerCase().includes(query)).sort((a,b)=>b.updatedAt-a.updatedAt || a.id.localeCompare(b.id))
}
function linkedBatches(p: Project): LedgerBatch[] {
 const ids = new Set(p.links.map(l=>l.batchId)); const all = readLedgerTail(storeFor(p.workspace),Number.MAX_SAFE_INTEGER)
 const selected = all.filter(b=>ids.has(b.id))
 if (selected.length !== ids.size) throw new Error('linked batch no longer exists')
 return selected
}
/** Exact line LCS under a bounded work budget; binary/missing/large pairs are explicitly unavailable. */
function lineDelta(before: Buffer | null, after: Buffer | null): { added: number; deleted: number } | null {
 if ((before?.includes(0)) || (after?.includes(0))) return null
 const lines = (b: Buffer | null) => { if (!b?.length) return []; const s=b.toString('utf8').replace(/\r\n?/g,'\n'); const a=s.split('\n'); if(a.at(-1)==='') a.pop(); return a }
 let a=lines(before), b=lines(after)
 let start=0; while(start<a.length && start<b.length && a[start]===b[start]) start++
 a=a.slice(start); b=b.slice(start)
 while(a.length && b.length && a.at(-1)===b.at(-1)) { a.pop(); b.pop() }
 if(a.length*b.length>1_000_000) return null
 const row=new Uint32Array(b.length+1)
 for(const x of a) { let diagonal=0; for(let j=1;j<=b.length;j++) { const old=row[j]; row[j]=x===b[j-1]?diagonal+1:Math.max(row[j],row[j-1]); diagonal=old } }
 return { added:b.length-row[b.length], deleted:a.length-row[b.length] }
}
function overview(p: Project): ProjectOverview {
 const batches=linkedBatches(p), actors=new Map<string,number>(), files=new Map<string,number>()
 const lineChanges={added:0,deleted:0,unavailable:0,method:'Exact textual line LCS per unique batch node; not semantic contribution; binary/missing/large nodes unavailable'}
 const store=storeFor(p.workspace)
 for(const b of batches) {
  actors.set(b.actor,(actors.get(b.actor)??0)+1)
  for(const n of b.nodes) {
   files.set(n.file,(files.get(n.file)??0)+1)
   const before=n.before===null?null:getBlob(store,n.before), after=n.after===null?null:getBlob(store,n.after)
   const delta=(n.before!==null && before===null)||(n.after!==null && after===null)?null:lineDelta(before,after)
   if(delta) { lineChanges.added+=delta.added; lineChanges.deleted+=delta.deleted } else lineChanges.unavailable++
  }
 }
 return {batches:batches.length,tasks:p.tasks.map(({id,title,note,status,archived})=>({id,title,note,status,archived})),actors:[...actors].map(([actor,batches])=>({actor,batches})),files:[...files].map(([file,count])=>({file,count})),lineChanges}
}
export function projectOverview(workspace: string, projectId: string): ProjectOverview { return overview(getProject(workspace,projectId)) }

/** HTTP/tool shared service. All mutation actions except create require projectId + current revision.
 * Unknown fields fail before IO. Returned records are detached disk snapshots. Human states are not machine checks.
 * Locking shares forge's workspace lock (single host process); each successful mutation replaces one JSON atomically.
 */
export async function projectAction(input: unknown, defaultWorkspace?: string): Promise<Project | Project[] | ProjectOverview> {
 object(input)
 const action=text(input.action,'action'); const allowed=fields[action]
 if(!allowed) throw new Error(`unknown action: ${action}`)
 for(const key of Object.keys(input)) if(!['action','workspace',...allowed].includes(key)) throw new Error(`unknown field for ${action}: ${key}`)
 const workspace=input.workspace===undefined?defaultWorkspace:text(input.workspace,'workspace')
 if(action==='list') return listProjects({workspace,query:input.query===undefined?undefined:optionalText(input.query,'query')})
 if(!workspace) throw new Error('workspace is required')
 const loc=location(workspace)
 if(action==='get') return getProject(loc.root,text(input.projectId,'projectId'))
 if(action==='overview') return projectOverview(loc.root,text(input.projectId,'projectId'))
 return withFileLock(loc.store.dir,()=>{
  const state=load(loc.file,loc.root); const now=Date.now()
  let p: Project
  if(action==='create') {
   p={id:randomUUID(),name:text(input.name,'name'),workspace:loc.root,status:'active',createdAt:now,updatedAt:now,revision:1,tasks:[],links:[],reports:[]}; state.projects.push(p)
  } else {
   const id=text(input.projectId,'projectId'); const found=state.projects.find(p=>p.id===id)
   if(!found) throw new Error('project not found')
   p=found
   if(integer(input.revision,'revision')!==p.revision) throw new Error(`revision conflict: expected ${p.revision}`)
   if(action==='update') {
    if(input.name===undefined && input.status===undefined) throw new Error('update requires name or status')
    if(input.name!==undefined) p.name=text(input.name,'name')
    if(input.status!==undefined) p.status=choice(input.status,projectStatuses,'status')
   } else if(action==='task_add') {
    p.tasks.push({id:randomUUID(),title:text(input.title,'title'),note:input.note===undefined?'':optionalText(input.note,'note'),status:input.status===undefined?'pending':choice(input.status,taskStatuses,'task status'),archived:false,createdAt:now,updatedAt:now})
   } else if(action==='report') {
    const status=choice(input.status,['draft','review','accepted'],'report status')
    if(!Array.isArray(input.issues)) throw new Error('issues must be a string array')
    const issues=input.issues.map(i=>text(i,'issue')); const conclusion=text(input.conclusion,'conclusion')
    if(status==='accepted') complete(p)
    p.reports.push({id:randomUUID(),createdAt:now,status,conclusion,issues,summary:overview(p)})
    if(status!=='draft') p.status=status
   } else {
    const taskId=text(input.taskId,'taskId'); const task=p.tasks.find(t=>t.id===taskId)
    if(!task) throw new Error('task not found')
    if(action==='task_update') {
     if(input.title===undefined && input.status===undefined && input.archived===undefined && input.note===undefined) throw new Error('task_update requires a change')
     if(input.note!==undefined) task.note=optionalText(input.note,'note')
     if(input.title!==undefined) task.title=text(input.title,'title')
     if(input.status!==undefined) task.status=choice(input.status,taskStatuses,'task status')
     if(input.archived!==undefined) { if(typeof input.archived!=='boolean') throw new Error('archived must be boolean'); task.archived=input.archived }
     task.updatedAt=now
    } else if(action==='task_delete') {
     p.tasks=p.tasks.filter(t=>t.id!==taskId); p.links=p.links.filter(l=>l.taskId!==taskId)
    } else {
     const batchId=integer(input.batchId,'batchId')
     if(!readLedgerTail(loc.store,Number.MAX_SAFE_INTEGER).some(b=>b.id===batchId)) throw new Error('batch not found in project workspace')
     const index=p.links.findIndex(l=>l.taskId===taskId && l.batchId===batchId)
     if(action==='link') { if(index!==-1) throw new Error('batch already linked to task'); p.links.push({taskId,batchId}) }
     else { if(index===-1) throw new Error('link not found'); p.links.splice(index,1) }
    }
   }
   p.revision++; p.updatedAt=now
  }
  validateProject(p,loc.root)
  linkedBatches(p)
  mkdirSync(loc.store.dir,{recursive:true}); atomicWrite(loc.file,JSON.stringify(state))
  return p
 })
}
