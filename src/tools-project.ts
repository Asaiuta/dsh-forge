import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { workdirOf, type ForgeExec } from './core.ts'
import { projectAction, type Project, type ProjectOverview } from './projects.ts'

export interface ProjectToolResult {
 ok: boolean
 action: string
 payload: { project?: Project; projects?: Project[]; overview?: ProjectOverview }
 error?: string
}

export function createProjectTool() {
 return {
  name: 'ff_project',
  description: 'Manage forge-private projects, tasks, immutable batch associations and report snapshots. Actions: create(name); list(query?; omit workspace to search all private stores); get/overview(projectId); update(projectId,revision,name?/status?); task_add(projectId,revision,title,status?,note?); task_update(projectId,revision,taskId,title?/status?/archived?/note?); task_delete(projectId,revision,taskId); link/unlink(projectId,revision,taskId,batchId); report(projectId,revision,conclusion,issues,status=draft|review|accepted). Non-list actions default workspace to session cwd. Every mutation except create requires current revision. Unknown or irrelevant action fields are rejected. Acceptance is human workflow state, never machine verification passed. Accepted requires every task done, including archived tasks; note is an independent string field, not a status. Task deletion cascades live links; reports retain historical snapshots.',
  parameters: {
   action: {type:'string',required:true,enum:['create','list','get','overview','update','task_add','task_update','task_delete','link','unlink','report'],description:'Explicit operation; each action rejects unrelated fields.'},
   workspace: {type:'string',description:'Existing workspace directory; list omission searches all private stores.'},
   projectId: {type:'string',description:'Project UUID, required except create/list.'},
   revision: {type:'integer',description:'Current project revision, required for every mutation except create.'},
   name: {type:'string',description:'Project name for create/update.'},
   query: {type:'string',description:'Case-insensitive private project search, list only.'},
   status: {type:'string',description:'Project: active/review/accepted/archived. Task: pending/doing/done/blocked. Report: draft/review/accepted.'},
   title: {type:'string',description:'Task title.'},
   note: {type:'string',description:'Independent task note, default empty; task_add/task_update only. Not a task status.'},
   taskId: {type:'string',description:'Existing task UUID for task_update/delete/link/unlink.'},
   archived: {type:'boolean',description:'Task archive flag; does not waive acceptance completion requirements.'},
   batchId: {type:'integer',description:'Existing positive batch ID in the same workspace.'},
   conclusion: {type:'string',description:'Nonempty report conclusion.'},
   issues: {type:'array',items:{type:'string'},description:'Report issue strings; empty array allowed.'},
  } satisfies ParameterSchemaSpec,
  output: {
   schema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
     ok: { type: 'boolean' as const, required: true },
     action: { type: 'string' as const, required: true },
     payload: { type: 'object' as const, required: true, additionalProperties: true, description: 'Action variant: {project} for mutations/get, {projects} for list, {overview} for overview; empty on error.' },
     error: { type: 'string' as const },
    },
    } as const,
   render: (_args: unknown, result: ProjectToolResult) => [{ type: 'text' as const, text: result.ok ? JSON.stringify(result.payload, null, 2) : result.error ?? 'Project action failed' }],
  },
  isConcurrencySafe: () => false,
  async execute(args: Record<string,unknown>, exec?: ForgeExec): Promise<ProjectToolResult> {
   const action = typeof args.action === 'string' ? args.action : ''
   try {
    const value = await projectAction(args,action==='list'?undefined:workdirOf(exec))
    const payload: ProjectToolResult['payload'] = action === 'list' ? { projects: value as Project[] } : action === 'overview' ? { overview: value as ProjectOverview } : { project: value as Project }
    return { ok: true, action, payload }
   } catch(cause) { return {ok:false,action,payload:{},error:cause instanceof Error?cause.message:String(cause)} }
  },
 }
}
