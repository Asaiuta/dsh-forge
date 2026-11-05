import { captureTodoProject } from './projects.ts'

interface TodoExecution { name: string; callId?: unknown; agent?: { session?: { header?: { id?: unknown } }; ctx?: { get?(name: string): unknown } } }
interface SessionLike { header?: { id?: unknown } }
interface SessionEvent { type?: unknown; data?: { turn?: unknown } }

export interface TodoProjectHost {
  on?(event: 'tools/result', listener: (exec: TodoExecution, result: { isError?: boolean; value?: unknown }) => Promise<void>): (() => void) | void
  on?(event: 'session/event', listener: (session: SessionLike, event: SessionEvent) => void): (() => void) | void
  get?(name: string): unknown
  logger?: { warn(message: string): void }
}

/**
 * Observe authoritative final successes and fold each Todo write into its plan.
 *
 * The turn number is tracked because that is what the host itself resets todos
 * on — `dsh-tool-todo` returns null from its projection at `turn/start` — so one
 * turn is one plan. A real session log shows four writes in one turn (0/1/2/3
 * tasks done) for a single three-item plan; treating each write as its own plan
 * is what duplicated it. Only the latest turn per session is kept: one integer,
 * no history.
 *
 * Nothing here replaces `todo_write`, and a capture failure warns without
 * touching the tool's own result.
 */
export function installTodoProjects(host: TodoProjectHost): () => void {
  const turns = new Map<string, number>()
  const offEvent = host.on?.('session/event', (session, event) => {
    const id = session?.header?.id
    if (typeof id !== 'string' || !id) return
    const turn = event?.data?.turn
    if (event?.type === 'turn/start' && typeof turn === 'number' && Number.isSafeInteger(turn)) turns.set(id, turn)
  })
  const offResult = host.on?.('tools/result', async (exec, result) => {
    if (exec.name !== 'todo_write' || result.isError !== false) return
    try {
      const sessionId = exec.agent?.session?.header?.id
      const callId = exec.callId
      if (typeof sessionId !== 'string' || !sessionId || typeof callId !== 'string' || !callId) throw new Error('missing Todo session/call identity')
      const service = (exec.agent?.ctx?.get?.('workingDirectory') ?? host.get?.('workingDirectory')) as { ensure?(agent: unknown): Promise<string> } | undefined
      if (!service?.ensure) throw new Error('missing workingDirectory service')
      const workspace = await service.ensure(exec.agent)
      const todos = (result.value as { todos?: unknown } | undefined)?.todos
      await captureTodoProject(workspace, { sessionId, turn: turns.get(sessionId) ?? null, callId }, todos)
    } catch (error) {
      host.logger?.warn(`dsh-forge: Todo plan capture failed; original tool result unchanged: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  return () => {
    if (typeof offEvent === 'function') offEvent()
    if (typeof offResult === 'function') offResult()
    turns.clear()
  }
}
