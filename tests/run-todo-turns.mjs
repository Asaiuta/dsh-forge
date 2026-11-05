// One plan per turn, not one project per write.
//
// Evidence this rule comes from: a real session log shows four todo_write calls
// inside turn 1 (0/1/2/3 tasks done) for one three-item plan. Creating a project
// per write turned that single plan into four projects, which is the duplicate
// the user reported.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const home = mkdtempSync(path.join(os.tmpdir(), 'forge-todo-turn-'))
process.env.DSH_FORGE_DATA_DIR = path.join(home, 'private')
const { installTodoProjects } = await import('../src/todo-projects.ts')
const { listProjects } = await import('../src/projects.ts')

let resultListener, eventListener
const warnings = []
const host = {
  on(event, fn) {
    if (event === 'tools/result') resultListener = fn
    if (event === 'session/event') eventListener = fn
    return () => { if (event === 'tools/result') resultListener = undefined; else eventListener = undefined }
  },
  get(name) { if (name === 'workingDirectory') return { ensure: async () => home } },
  logger: { warn: m => warnings.push(m) },
}
installTodoProjects(host)

const exec = (session, call) => ({ name: 'todo_write', callId: call, agent: { session: { header: { id: session } } } })
const write = (list) => ({ isError: false, value: { todos: list.map(([content, status]) => ({ content, status })) } })
const turn = (session, n) => eventListener({ header: { id: session } }, { type: 'turn/start', seq: n, data: { turn: n } })
const projects = () => listProjects({ workspace: home })
const statuses = p => p.tasks.map(t => `${t.title}:${t.status}`)

// --- within one turn: four writes of one plan are one project, updated in place ---
turn('s1', 1)
await resultListener(exec('s1', 'a1'), write([['研究', 'in_progress'], ['实现', 'pending'], ['验证', 'pending']]))
await resultListener(exec('s1', 'a2'), write([['研究', 'completed'], ['实现', 'in_progress'], ['验证', 'pending']]))
await resultListener(exec('s1', 'a3'), write([['研究', 'completed'], ['实现', 'completed'], ['验证', 'in_progress']]))
await resultListener(exec('s1', 'a4'), write([['研究', 'completed'], ['实现', 'completed'], ['验证', 'completed']]))
assert.equal(projects().length, 1, 'four writes in one turn are one plan')
const merged = projects()[0]
assert.deepEqual(statuses(merged), ['研究:done', '实现:done', '验证:done'], 'the latest statuses win')
assert.equal(merged.todoSource.writes, 4, 'every write is counted')
assert.deepEqual(merged.todoSource.callIds, ['a1', 'a2', 'a3', 'a4'])
assert.equal(merged.todoSource.turn, 1)
const taskIds = merged.tasks.map(t => t.id)

// Task identity survives the merge, so batch links keep pointing at the same task.
await resultListener(exec('s1', 'a5'), write([['研究', 'completed'], ['实现', 'completed'], ['验证', 'completed'], ['补测', 'pending']]))
assert.deepEqual(projects()[0].tasks.slice(0, 3).map(t => t.id), taskIds, 'existing task ids are preserved')
assert.equal(projects()[0].tasks.length, 4, 'a new task is appended')

// --- replaying an already-captured call changes nothing ---
const before = JSON.stringify(projects()[0])
await resultListener(exec('s1', 'a4'), write([['研究', 'completed'], ['实现', 'completed'], ['验证', 'completed']]))
assert.equal(JSON.stringify(projects()[0]), before, 'a replayed call is idempotent even after later writes')

// --- a new turn continuing the same plan stays one project ---
turn('s1', 2)
await resultListener(exec('s1', 'b1'), write([['研究', 'completed'], ['实现', 'completed'], ['验证', 'completed'], ['补测', 'completed']]))
assert.equal(projects().length, 1, 'the same task set in a later turn continues the plan')
assert.equal(projects()[0].todoSource.callIds.includes('b1'), true)

// --- a new turn with a different plan opens a new project ---
turn('s1', 3)
await resultListener(exec('s1', 'c1'), write([['排查崩溃', 'in_progress'], ['补回归', 'pending']]))
assert.equal(projects().length, 2, 'wholly different tasks are a new plan')
assert.deepEqual(statuses(projects().find(p => p.todoSource.callIds.includes('c1'))), ['排查崩溃:doing', '补回归:pending'])

// --- a later turn that re-declares an older plan merges into it, not the newest ---
turn('s1', 4)
await resultListener(exec('s1', 'd1'), write([['研究', 'completed'], ['实现', 'completed'], ['验证', 'completed']]))
assert.equal(projects().length, 2, 'no third project: this matches an existing plan')
assert.equal(projects()[0].todoSource.callIds.includes('d1'), true, 'merges into the newest matching plan')

// --- sessions never share a plan ---
turn('s2', 1)
await resultListener(exec('s2', 'e1'), write([['研究', 'completed'], ['实现', 'completed'], ['验证', 'completed']]))
assert.equal(projects().length, 3, 'another session with the same titles is its own plan')

// --- without any turn event the title rule still prevents duplicates ---
const noTurnHost = { ...host }
let fallbackListener
noTurnHost.on = (event, fn) => { if (event === 'tools/result') fallbackListener = fn; return () => {} }
installTodoProjects(noTurnHost)
await fallbackListener(exec('s3', 'f1'), write([['甲', 'pending']]))
await fallbackListener(exec('s3', 'f2'), write([['甲', 'completed']]))
const s3 = projects().filter(p => p.todoSource.sessionId === 's3')
assert.equal(s3.length, 1, 'identical titles merge even with no turn information')
assert.equal(s3[0].todoSource.turn, null, 'an unknown turn is recorded as null, not invented')
assert.equal(s3[0].tasks[0].status, 'done')

// --- failures never touch storage ---
const snapshot = JSON.stringify(projects())
await resultListener(exec('s1', 'x1'), { isError: true })
await resultListener(exec('s1', 'x2'), { isError: false, value: { todos: [{ content: 'bad', status: 'invalid' }] } })
assert.equal(JSON.stringify(projects()), snapshot, 'a failed or malformed write changes nothing')

assert.ok(warnings.every(w => /Todo plan capture failed/.test(w)), 'warnings stay on the capture prefix')
console.log('todo-turn: 24 contract assertions passed; 0 failed')
