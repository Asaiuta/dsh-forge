/** Bounded tool views of private projects. Storage and HTTP keep their full records. */
import { createHash, randomBytes } from 'node:crypto'
import type { Project, ProjectOverview, ProjectReport } from './projects.ts'
import { boundedOutput, outputFragment, outputPreview, outputRows, OUTPUT_PAGE_BYTES } from './output-budget.ts'

export type ProjectPayload = Record<string, unknown>
type Detail = 'summary' | 'tasks' | 'reports' | 'evidence' | 'record'
export interface ProjectView {
 detail: Detail
 limit?: number
 cursor?: string
 taskId?: string
 reportId?: string
}
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const CURSOR_TTL = 30 * 60_000
const CURSOR_CAP = 128
interface Cursor { query: string; snapshot: string; offset: number; limit: number; expires: number }

/** Validate output-only arguments before a mutation can commit. */
export function projectView(args: Record<string, unknown>): { view: ProjectView; serviceArgs: Record<string, unknown> } {
 const detail = args.detail ?? 'summary'
 if (typeof detail !== 'string' || !['summary', 'tasks', 'reports', 'evidence', 'record'].includes(detail)) throw new Error('detail must be summary, tasks, reports, evidence or record')
 if (args.detail !== undefined && args.action !== 'get') throw new Error('detail is only used by get')
 const rows = args.action === 'list' || (args.action === 'get' && ['tasks', 'reports'].includes(detail))
 const paged = rows || (args.action === 'get' && ['evidence', 'record'].includes(detail))
 if (args.limit !== undefined && (!rows || typeof args.limit !== 'number' || !Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > MAX_LIMIT)) throw new Error('limit requires a list/tasks/reports page and must be an integer between 1 and 100')
 if (args.cursor !== undefined && (!paged || typeof args.cursor !== 'string' || !args.cursor.trim())) throw new Error('cursor requires a paged query and must be a nonempty string')
 if (args.reportId !== undefined && (args.action !== 'get' || !['reports', 'evidence', 'record'].includes(detail) || typeof args.reportId !== 'string' || !args.reportId.trim())) throw new Error('reportId requires get detail=reports/evidence/record and a nonempty ID')
 if (args.action === 'get' && args.taskId !== undefined && (!['tasks', 'record'].includes(detail) || typeof args.taskId !== 'string' || !args.taskId.trim())) throw new Error('taskId requires get detail=tasks/record and a nonempty ID')
 if (args.action === 'get' && args.taskId !== undefined && args.reportId !== undefined) throw new Error('taskId and reportId are exclusive')
 if (detail === 'evidence' && args.reportId === undefined) throw new Error('detail=evidence requires reportId')
 const serviceArgs = { ...args }
 for (const key of ['detail', 'limit', 'cursor', 'reportId']) delete serviceArgs[key]
 if (args.action === 'get') delete serviceArgs.taskId
 return { serviceArgs, view: {
  detail: detail as Detail,
  ...(args.limit === undefined ? {} : { limit: args.limit as number }),
  ...(args.cursor === undefined ? {} : { cursor: args.cursor as string }),
  ...(args.action !== 'get' || args.taskId === undefined ? {} : { taskId: (args.taskId as string).trim() }),
  ...(args.reportId === undefined ? {} : { reportId: (args.reportId as string).trim() }),
 } }
}

function digest(text: string): string { return createHash('sha256').update(text).digest('hex') }
function preview(value: string, key: string, truncated: string[], limit = 240): string {
 const text = outputPreview(value, limit)
 if (text !== value) truncated.push(key)
 return text
}
function taskCounts(tasks: ProjectOverview['tasks']) {
 const counts = { total: tasks.length, pending: 0, doing: 0, done: 0, blocked: 0, archived: 0 }
 for (const task of tasks) { counts[task.status]++; if (task.archived) counts.archived++ }
 return counts
}
function taskSummary(task: ProjectOverview['tasks'][number]) {
 const truncated: string[] = []
 return { id: task.id, title: preview(task.title, 'title', truncated), status: task.status, archived: task.archived,
  ...(task.note ? { note: preview(task.note, 'note', truncated) } : {}), ...(truncated.length ? { truncated } : {}) }
}
function projectSummary(project: Project, withWorkspace = false) {
 const truncated: string[] = []
 const last = project.reports.at(-1)
 return { id: project.id, name: preview(project.name, 'name', truncated, 160), status: project.status, revision: project.revision,
  ...(withWorkspace ? { workspace: project.workspace } : {}), tasks: taskCounts(project.tasks),
  links: project.links.length, reports: project.reports.length,
  ...(last ? { latestReport: { id: last.id, status: last.status } } : {}), ...(truncated.length ? { truncated } : {}) }
}
function reportSummary(report: ProjectReport) {
 const truncated: string[] = []
 return { id: report.id, createdAt: report.createdAt, status: report.status,
  conclusion: preview(report.conclusion, 'conclusion', truncated), issues: report.issues.length,
  tasks: taskCounts(report.summary.tasks), batches: report.summary.batches,
  evidence: report.evidence ? { available: true, capturedAt: report.evidence.capturedAt,
   batches: report.evidence.batches.length, verification: report.evidence.verification.length } : { available: false },
  ...(truncated.length ? { truncated } : {}) }
}
export function projectOverviewSummary(overview: ProjectOverview): ProjectPayload {
 return { overview: { batches: overview.batches, tasks: taskCounts(overview.tasks),
  actors: overview.actors.length, files: overview.files.length, lineChanges: overview.lineChanges } }
}

/** Cursors hold coordinates only, never copies of user records. Every page revalidates content. */
export class ProjectOutput {
 private readonly cursors = new Map<string, Cursor>()
 private readonly now: () => number
 constructor(now: () => number = Date.now) { this.now = now }

 private position(query: string, source: string, view: ProjectView): Cursor {
  const now = this.now()
  for (const [key, cursor] of this.cursors) if (cursor.expires <= now) this.cursors.delete(key)
  const snapshot = digest(source)
  if (view.cursor !== undefined) {
   const cursor = this.cursors.get(view.cursor)
   if (!cursor) throw new Error('cursor expired or unknown; restart the query without cursor')
   if (cursor.query !== query || (view.limit !== undefined && cursor.limit !== view.limit)) throw new Error('cursor does not match workspace/query/limit; restart the query')
   if (cursor.snapshot !== snapshot) throw new Error('cursor snapshot changed; restart the query without cursor')
   return cursor
  }
  return { query, snapshot, offset: 0, limit: view.limit ?? DEFAULT_LIMIT, expires: now + CURSOR_TTL }
 }
 private continuation(cursor: Cursor, offset: number): string {
  while (this.cursors.size >= CURSOR_CAP) this.cursors.delete(this.cursors.keys().next().value!)
  const key = randomBytes(18).toString('base64url')
  this.cursors.set(key, { ...cursor, offset })
  return key
 }
 private rows<T>(key: string, rows: readonly T[], project: ProjectPayload, query: string, source: string, view: ProjectView, shape: (row: T) => unknown): ProjectPayload {
  const cursor = this.position(query, source, view)
  const items = outputRows(rows.slice(cursor.offset, cursor.offset + cursor.limit).map(shape), 0, cursor.limit,
   () => 'one result exceeds the page budget; narrow the query and use detail=record')
  const end = cursor.offset + items.length, complete = end === rows.length
  return this.bounded({ ...project, [key]: items, total: rows.length, returned: items.length, complete,
   snapshot: cursor.snapshot, ...(complete ? {} : { nextCursor: this.continuation(cursor, end) }) })
 }
 private bounded(payload: ProjectPayload): ProjectPayload {
  return boundedOutput(payload, 'narrow the project query', OUTPUT_PAGE_BYTES - 128)
 }
 private record(record: unknown, coordinate: ProjectPayload, query: string, view: ProjectView): ProjectPayload {
  const source = JSON.stringify(record), cursor = this.position(query, source, view)
  const { text, end } = outputFragment(source, cursor.offset)
  const complete = end === source.length
  return this.bounded({ ...coordinate, format: 'json-fragment', text,
   offset: cursor.offset, totalChars: source.length, complete, snapshot: cursor.snapshot,
   ...(complete ? {} : { nextCursor: this.continuation(cursor, end) }) })
 }
 list(projects: Project[], workspace: unknown, query: unknown, view: ProjectView): ProjectPayload {
  return this.rows('projects', projects, {}, JSON.stringify(['list', workspace ?? null, query ?? '']), JSON.stringify(projects), view, p => projectSummary(p, true))
 }
 project(project: Project, action: string, args: Record<string, unknown>, view: ProjectView): ProjectPayload {
  if (action !== 'get') {
   const payload: ProjectPayload = { project: { id: project.id, revision: project.revision, status: project.status } }
   if (action === 'create' || action === 'update') payload.project = projectSummary(project, action === 'create')
   if (action === 'task_add' || action === 'task_update') {
    const task = action === 'task_add' ? project.tasks.at(-1)! : project.tasks.find(t => t.id === String(args.taskId).trim())!
    payload.task = taskSummary(task); payload.tasks = taskCounts(project.tasks)
   }
   if (action === 'task_delete') { payload.deletedTaskId = String(args.taskId).trim(); payload.tasks = taskCounts(project.tasks) }
   if (action === 'link' || action === 'unlink') payload.link = { taskId: String(args.taskId).trim(), batchId: args.batchId, linked: action === 'link' }
   if (action === 'report') payload.report = reportSummary(project.reports.at(-1)!)
   // Output overflow cannot undo a mutation. Extreme display metadata stays
   // available through the lossless record reader, with a truthful receipt.
   try { return this.bounded(payload) }
   catch {
    return { project: { id: project.id, revision: project.revision, status: project.status }, receiptComplete: false,
     ...(action.startsWith('task_') ? { taskId: action === 'task_add' ? project.tasks.at(-1)!.id : args.taskId, tasks: taskCounts(project.tasks) } : {}),
     ...(action === 'report' ? { reportId: project.reports.at(-1)!.id } : {}),
     note: 'mutation committed; display metadata omitted by budget; get detail=record retrieves the complete project' }
   }
  }
  if (view.detail === 'summary') return this.bounded({ project: projectSummary(project) })
  const task = view.taskId === undefined ? undefined : project.tasks.find(t => t.id === view.taskId)
  const report = view.reportId === undefined ? undefined : project.reports.find(r => r.id === view.reportId)
  if (view.taskId !== undefined && !task) throw new Error('task not found in project')
  if (view.reportId !== undefined && !report) throw new Error('report not found in project')
  const query = JSON.stringify([project.workspace, project.id, view.detail, view.taskId ?? null, view.reportId ?? null])
  const coordinate = { projectId: project.id, ...(task ? { taskId: task.id } : {}), ...(report ? { reportId: report.id } : {}) }
  if (view.detail === 'record') return this.record(task ?? report ?? project, coordinate, query, view)
  if (view.detail === 'evidence') {
   if (!report!.evidence) {
    if (view.cursor) throw new Error('report has no evidence; cursor is not applicable')
    return { ...coordinate, available: false }
   }
   return this.record(report!.evidence, { ...coordinate, available: true, historical: true }, query, view)
  }
  if (view.detail === 'tasks') return this.rows('tasks', task ? [task] : project.tasks, coordinate, query, JSON.stringify(project), view, taskSummary)
  return this.rows('reports', report ? [report] : [...project.reports].reverse(), coordinate, query,
   JSON.stringify(report ?? project.reports), view, reportSummary)
 }
}
