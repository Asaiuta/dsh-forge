/** Model-facing project registry; project tasks are durable across sessions. */
import { allStores, storeFor, readLedgerTail } from './ledger.ts'
import { canonicalWorkspace, getProject, listProjects, parseTodoPatches, ProjectRegistry } from './projects.ts'
import { workdirOf, type ForgeExec } from './core.ts'

const TODO_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  id: { type: 'string', required: true }, content: { type: 'string', required: true },
  status: { type: 'string', required: true }, note: { type: 'string', required: true },
} } as const
const PROJECT_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  id: { type: 'string', required: true }, name: { type: 'string', required: true }, root: { type: 'string', required: true },
  description: { type: 'string', required: true }, status: { type: 'string', required: true }, revision: { type: 'integer', required: true },
  createdAt: { type: 'number', required: true }, createdBy: { type: 'string', required: true }, updatedAt: { type: 'number', required: true },
  deletedAt: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true }, todos: { type: 'array', items: TODO_SCHEMA, required: true },
  report: { oneOf: [{ type: 'object', additionalProperties: false, properties: {
    conclusion: { type: 'string', required: true }, issues: { type: 'string', required: true }, actor: { type: 'string', required: true },
    ts: { type: 'number', required: true }, throughBatch: { type: 'integer', required: true }, content: { type: 'string', required: true },
  } }, { type: 'null' }], required: true },
} } as const
function required(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}
function revision(args: Record<string, unknown>): number {
  if (!Number.isSafeInteger(args.revision) || Number(args.revision) < 1) throw new Error('revision is required; use the current project revision to avoid overwriting another session')
  return Number(args.revision)
}
export function createProjectTool(registry = new ProjectRegistry()) {
  return {
    name: 'ff_project',
    description: 'Manage durable projects/tasks across sessions; DSH todo_write tracks current-turn progress. Link file changes with projectId/todoId. ' +
      'todos patches stable task IDs. Fetch get before todos/report for the current revision. delete/restore affect records only, preserving files/history.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list_workspaces', 'create', 'list', 'search', 'get', 'todos', 'report', 'delete', 'restore'], description: 'Operation in the current workspace.' },
      projectId: { type: 'string', description: 'Required for get/todos/report/delete/restore.' },
      root: { type: 'string', description: 'create: existing directory inside workspace; default workspace root.' },
      name: { type: 'string', description: 'Required for create: project name.' },
      description: { type: 'string', description: 'create: project description; default empty.' },
      query: { type: 'string', description: 'Required for search: case-insensitive substring of name/description/root.' },
      includeDeleted: { type: 'boolean', description: 'list/search/get: include deleted records. Default false.' },
      revision: { type: 'integer', description: 'Required for todos/report: current revision from get.' },
      todos: { type: 'array', description: 'Required for todos: 1–100 task patches; resets project status to active.', items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', description: 'Existing task ID; omit to create a task.' },
        content: { type: 'string', description: 'Task text; required for a new task.' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'], description: 'Task status; new tasks default pending.' },
        note: { type: 'string', description: 'Task note.' },
        remove: { type: 'boolean', description: 'Delete task; requires id and no history referencing it.' },
      } } },
      conclusion: { type: 'string', description: 'Required for report: conclusion text.' },
      issues: { type: 'string', description: 'report: unresolved issues; default empty.' },
      status: { type: 'string', enum: ['active', 'review', 'accepted'], description: 'report: default review; accepted requires every task completed.' },
      reason: { type: 'string', description: 'Required for create/todos/report/delete/restore; recorded in history.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      projects: { type: 'array', items: PROJECT_SCHEMA, required: true },
      workspaces: { type: 'array', items: { type: 'string' }, required: true },
      batches: { type: 'array', items: { type: 'integer' }, required: true },
    } }, render: (_args: unknown, value: { projects: Array<{ id: string; name: string; status: string; revision: number; todos: unknown[] }>; workspaces: string[]; batches: number[] }) => [{
      type: 'text' as const,
      text: JSON.stringify(value, null, 2),
    }] },
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      try {
        const workspace = canonicalWorkspace(workdirOf(exec))
        const store = storeFor(workspace)
        const action = required(args, 'action')
        const readOnly = ['list_workspaces', 'list', 'search', 'get'].includes(action)
        const reason = readOnly ? '' : required(args, 'reason')
        const actor = exec?.agent?.session?.header?.id ?? 'unknown'
        let projects
        switch (action) {
          case 'list_workspaces': return { projects: [], workspaces: [...new Set([workspace, ...allStores().map(store => store.root)])], batches: [] }
          case 'list':
          case 'search': {
            const query = action === 'search' ? required(args, 'query').toLowerCase() : ''
            projects = listProjects(store).filter(project => (args.includeDeleted === true || project.deletedAt === null)
              && (!query || `${project.name}\n${project.description}\n${project.root}`.toLowerCase().includes(query)))
            break
          }
          case 'get': projects = [getProject(store, required(args, 'projectId'), args.includeDeleted === true)]; break
          case 'create': projects = [await registry.create(workspace, typeof args.root === 'string' ? args.root : '.', required(args, 'name'),
            typeof args.description === 'string' ? args.description : '', actor, reason, exec)]; break
          case 'todos': projects = [await registry.todos(workspace, required(args, 'projectId'), parseTodoPatches(args.todos), revision(args), actor, reason, exec)]; break
          case 'report': {
            if (args.status !== undefined && !['active', 'review', 'accepted'].includes(String(args.status))) throw new Error('invalid report status')
            projects = [await registry.report(workspace, required(args, 'projectId'), required(args, 'conclusion'), typeof args.issues === 'string' ? args.issues : '',
              args.status === 'active' || args.status === 'accepted' ? args.status : 'review', revision(args), actor, reason, exec)]
            break
          }
          case 'delete':
          case 'restore': projects = [await registry.setDeleted(workspace, required(args, 'projectId'), action === 'delete', actor, reason, exec)]; break
          default: throw new Error(`unknown project action: ${action}`)
        }
        const ids = new Set(projects.map(project => project.id))
        return { projects, workspaces: [workspace], batches: readLedgerTail(store, Number.MAX_SAFE_INTEGER)
          .filter(batch => batch.projectId && ids.has(batch.projectId) && batch.nodes.length > 0).map(batch => batch.id) }
      } catch (cause) { return { error: cause instanceof Error ? cause.message : String(cause) } }
    },
  } as const
}
