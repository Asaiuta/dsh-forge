// Baseline Todo contracts for the plan-per-turn rule. The turn-specific
// scenarios live in run-todo-turns.mjs; this file keeps the identity, isolation,
// validation and durability guarantees that must hold regardless of turns.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const home = mkdtempSync(path.join(os.tmpdir(), 'forge-todo-'))
process.env.DSH_FORGE_DATA_DIR = path.join(home, 'private')
const { installTodoProjects } = await import('../src/todo-projects.ts')
const { listProjects } = await import('../src/projects.ts')

const listeners = {}
const warnings = []
const host = {
  on(event, fn) { listeners[event] = fn; return () => { listeners[event] = undefined } },
  get(name) { if (name === 'workingDirectory') return { ensure: async () => home } },
  logger: { warn: m => warnings.push(m) },
}
const off = installTodoProjects(host)
const result = payload => listeners['tools/result'](payload.exec, payload.result)
const exec = (session, call) => ({ name: 'todo_write', callId: call, agent: { session: { header: { id: session } } } })
const list = items => ({ isError: false, value: { todos: items.map(([content, status]) => ({ content, status })) } })
const projects = () => listProjects({ workspace: home })

// Status mapping is the only translation: pending/in_progress/completed -> pending/doing/done.
await result({ exec: exec('s1', 'c1'), result: list([['one', 'pending'], ['two', 'in_progress'], ['three', 'completed']]) })
let all = projects()
assert.equal(all.length, 1)
assert.deepEqual(all[0].tasks.map(t => t.status), ['pending', 'doing', 'done'])
assert.equal(all[0].todoSource.sessionId, 's1')

// A different plan in the same session is its own project (titles are unrelated).
await result({ exec: exec('s1', 'c2'), result: list([['完全不同的任务', 'pending']]) })
assert.equal(projects().length, 2, 'unrelated titles open a new plan')

// The same call is never captured twice.
await result({ exec: exec('s1', 'c1'), result: list([['one', 'pending'], ['two', 'in_progress'], ['three', 'completed']]) })
assert.equal(projects().length, 2, 'a replayed call is idempotent')

// Call ids are scoped by session: the same id under another session is a new plan.
await result({ exec: exec('s2', 'c1'), result: list([['one', 'pending'], ['two', 'in_progress'], ['three', 'completed']]) })
assert.equal(projects().length, 3, 'call ids are isolated per session')

// Failures, other tools, and missing identity never write.
await result({ exec: exec('s1', 'bad'), result: { isError: true } })
await result({ exec: { ...exec('s1', 'ignored'), name: 'read' }, result: list([['x', 'pending']]) })
await result({ exec: { name: 'todo_write' }, result: list([['x', 'pending']]) })
assert.equal(projects().length, 3, 'no write happened for any of those')

// An empty list is a legitimate plan state, not an error.
await result({ exec: exec('s1', 'empty'), result: { isError: false, value: { todos: [] } } })
assert.equal(projects().length, 4, 'an empty successful list still records the plan')

// A malformed status is refused rather than coerced.
await result({ exec: exec('s1', 'invalid'), result: { isError: false, value: { todos: [{ content: 'bad', status: 'invalid' }] } } })
assert.equal(projects().length, 4, 'a malformed status writes nothing')

// Long content: the plan keeps the full text, the task title is capped by the store limit.
await result({ exec: exec('s1', 'long'), result: { isError: false, value: { todos: [{ content: 'x'.repeat(21000), status: 'pending' }] } } })
const long = projects().find(p => p.todoSource.callId === 'long')
assert.equal(long.tasks[0].title.length, 20000)
assert.equal(long.todoSource.todos[0].content.length, 21000)

// Concurrent writes of different plans both land, one project each.
await Promise.all([
  result({ exec: exec('s1', 'parallel1'), result: list([['并行甲', 'pending']]) }),
  result({ exec: exec('s1', 'parallel2'), result: list([['并行乙', 'pending']]) }),
])
// Five plans exist by now (c1, c2, s2/c1, empty, long); the two parallel writes add one each.
assert.equal(projects().length, 7, 'two independent plans both persist')

assert.ok(warnings.length >= 1 && warnings.every(w => w.startsWith('dsh-forge: Todo plan capture failed')), 'warnings keep the capture prefix')
off()
assert.equal(listeners['tools/result'], undefined, 'dispose removes the listener')
assert.equal(listeners['session/event'], undefined, 'dispose removes the turn listener')
console.log('10 Todo baseline contracts passed; 0 failed')
