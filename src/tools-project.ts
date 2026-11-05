import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { workdirOf, type ForgeExec } from './core.ts'
import { projectAction, type Project, type ProjectOverview } from './projects.ts'
import { ProjectOutput, projectOverviewSummary, projectView, type ProjectPayload } from './project-output.ts'

export interface ProjectToolResult {
 ok: boolean
 action: string
 payload: ProjectPayload
 error?: string
}

export function createProjectTool() {
 const output = new ProjectOutput()
 return {
  name: 'ff_project',
  description: 'Manage private projects, tasks, batch links and immutable reports. Mutations return receipts; get returns counts. Use detail for paged previews or full records; concatenate record/evidence fragment text before JSON parsing. All mutations except create require current revision. Human acceptance is separate from machine verification; acceptance requires all tasks done, including archived tasks. Deleting tasks removes live links but preserves reports.',
  parameters: {
   action: {type:'string',required:true,enum:['create','list','get','overview','update','task_add','task_update','task_delete','link','unlink','report'],description:'create(name); list(query?); get/overview(projectId); update(name?/status?); task_add(title,status?,note?); task_update(taskId,title?/status?/archived?/note?); task_delete(taskId); link/unlink(taskId,batchId); report(conclusion,issues,status).'},
   workspace: {type:'string',description:'Existing absolute workspace directory; list omission searches all private stores.'},
   projectId: {type:'string',description:'Project UUID, required except create/list.'},
   revision: {type:'integer',description:'Current project revision, required for every mutation except create.'},
   name: {type:'string',description:'Project name for create/update.'},
   query: {type:'string',description:'Case-insensitive private project search, list only.'},
   status: {type:'string',description:'Project: active/review/accepted/archived. Task: pending/doing/done/blocked. Report: draft/review/accepted.'},
   title: {type:'string',description:'Task title.'},
   note: {type:'string',description:'Independent task note; task_add/task_update only. Empty clears the note.'},
   taskId: {type:'string',description:'Task UUID for task_update/delete/link/unlink; optional selector for get detail=tasks/record.'},
   archived: {type:'boolean',description:'Task archive flag; does not waive acceptance completion requirements.'},
   batchId: {type:'integer',description:'Existing positive batch ID in the same workspace.'},
   conclusion: {type:'string',description:'Nonempty report conclusion.'},
   issues: {type:'array',items:{type:'string'},description:'Report issue strings; empty array allowed.'},
   detail: {type:'string',enum:['summary','tasks','reports','evidence','record'],description:'get only; default summary. Preview truncation names fields; record retrieves complete data. evidence is historical, not a fresh verification.'},
   reportId: {type:'string',description:'Required for get detail=evidence; optional selector for reports/record. Exclusive with taskId.'},
   limit: {type:'integer',description:'list or get detail=tasks/reports: rows per page, 1-100, default 20; byte budget can shorten a page.'},
   cursor: {type:'string',description:'nextCursor from the same paged query. Expires after 30 minutes; limit must match or be omitted.'},
  } satisfies ParameterSchemaSpec,
  output: {
   schema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
     ok: { type: 'boolean' as const, required: true },
     action: { type: 'string' as const, required: true },
     payload: { type: 'object' as const, required: true, additionalProperties: true, description: 'Compact summary/change, bounded rows with total/returned/complete/nextCursor, or lossless JSON-fragment text. Empty on error.' },
     error: { type: 'string' as const },
    },
   } as const,
   render: (_args: unknown, result: ProjectToolResult) => [{ type: 'text' as const, text: result.ok ? JSON.stringify(result.payload) : result.error ?? 'Project action failed' }],
  },
  // Empty note clears it; an empty issues list is a valid report.
  hygiene: { keepEmpty: ['note', 'issues'] },
  isConcurrencySafe: () => false,
  async execute(args: Record<string,unknown>, exec?: ForgeExec): Promise<ProjectToolResult> {
   const action = typeof args.action === 'string' ? args.action : ''
   try {
    const { view, serviceArgs } = projectView(args)
    const value = await projectAction(serviceArgs, action === 'list' ? undefined : workdirOf(exec), exec?.agent?.session?.header?.id ?? 'unknown')
    const payload = action === 'list' ? output.list(value as Project[], serviceArgs.workspace, serviceArgs.query, view)
     : action === 'overview' ? projectOverviewSummary(value as ProjectOverview)
     : output.project(value as Project, action, serviceArgs, view)
    return { ok: true, action, payload }
   } catch(cause) { return {ok:false,action,payload:{},error:cause instanceof Error?cause.message:String(cause)} }
  },
 }
}
