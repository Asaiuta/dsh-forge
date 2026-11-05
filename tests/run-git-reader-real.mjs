// Real git integration for the read-only reader: the runner here uses
// node:child_process because the TEST owes that, not the plugin — production
// goes through the host subprocess capability (src/git-subprocess.ts).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { readGitDiff, readGitStatus } from '../src/git-reader.ts'
import { readWorktreeText } from '../src/git-subprocess.ts'

const run = (args, options = {}) => new Promise(resolve => {
  execFile('git', args, { cwd: options.cwd ?? process.cwd(), maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
    (error, stdout, stderr) => resolve({ exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' }))
})

const here = process.cwd()
const status = await readGitStatus(here, run)
assert.equal(status.isRepo, true, 'the plugin repository is a git repository')
assert.equal(path.resolve(status.toplevel), path.resolve(here))
assert.ok(status.branch.head, 'a branch head was read')
assert.ok(Array.isArray(status.staged) && Array.isArray(status.changes) && Array.isArray(status.conflicts))
assert.ok(status.total >= 0)

// Every listed path must be repository-relative and inside the root.
for (const entry of [...status.staged, ...status.changes, ...status.conflicts]) {
  assert.ok(!path.isAbsolute(entry.path), `absolute path leaked: ${entry.path}`)
  assert.ok(!entry.path.split('/').includes('..'), `escaping path leaked: ${entry.path}`)
}

// Cross-check the count against git itself, independently of the parser.
const porcelain = await run(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], { cwd: here })
const rawLines = porcelain.stdout.split('\0').filter(Boolean).filter(r => !r.startsWith('#'))
const renameExtra = rawLines.filter(r => r.startsWith('2 ')).length
const rawCount = rawLines.length - renameExtra
assert.equal(status.total, rawCount, `total must match git: parsed ${status.total} vs raw ${rawCount}`)

// A modified file that exists in the index yields two text sides.
const candidate = [...status.changes, ...status.staged].find(e => e.status !== 'D' && !e.binary)?.path
if (candidate) {
  const diff = await readGitDiff(here, candidate, run, readWorktreeText)
  assert.equal(diff.path, candidate)
  assert.equal(diff.after.exists, true, 'a present worktree file has an after side')
  assert.equal(diff.after.binary, false)
  assert.ok(typeof diff.after.text === 'string')
}

// Escape attempts are refused against the real repository too.
await assert.rejects(() => readGitDiff(here, '../outside.ts', run, readWorktreeText), /超出仓库根目录/)
await assert.rejects(() => readGitDiff(here, '.git/config', run, readWorktreeText), /不能指向 \.git/)

// A directory outside any repository is a fact, not an error.
const outside = await readGitStatus(path.parse(here).root, run)
assert.equal(outside.isRepo, false, 'a drive root is not inside a repository')

console.log(`git-reader real: ${status.total} entries cross-checked against git, ${candidate ? 'one real diff' : 'no diff'} verified; 0 failed`)
