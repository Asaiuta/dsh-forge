import assert from 'node:assert/strict'
import path from 'node:path'
import { parsePorcelainV2, parseNumstat, resolveInside, groupEntries, readGitStatus, readGitDiff, GitReadError } from '../src/git-reader.ts'

// --- porcelain v2: records are NUL-separated; field counts decide where a path starts ---
const status = parsePorcelainV2([
 '# branch.oid 403e6efa63b917ae59374fc343dcd175ed959cc4',
 '# branch.head master',
 '# branch.upstream origin/master',
 '# branch.ab +2 -1',
 '1 .M N... 100644 100644 100644 aaa bbb src/client/ledger-tab.tsx',
 '1 M. N... 100644 100644 100644 ccc ddd README.md',
 '2 R. N... 100644 100644 100644 eee fff R100 src/new name.ts',
 'src/old name.ts',
 'u UU N... 100644 100644 100644 100644 h1 h2 h3 src/conflict.ts',
 '? src/untracked file.ts',
 ''].join('\0'))
assert.equal(status.branch.head, 'master')
assert.equal(status.branch.upstream, 'origin/master')
assert.deepEqual([status.branch.ahead, status.branch.behind], [2, 1])
const byPath = Object.fromEntries(status.entries.map(e => [e.path, e]))
assert.equal(byPath['src/client/ledger-tab.tsx'].x, '.', 'worktree-only change keeps X as .')
assert.equal(byPath['src/client/ledger-tab.tsx'].y, 'M')
assert.equal(byPath['README.md'].x, 'M')
assert.equal(byPath['src/new name.ts'].origPath, 'src/old name.ts', 'rename consumes the next NUL record')
assert.equal(byPath['src/conflict.ts'].kind, 'unmerged', 'unmerged is not reported as staged or changed')
assert.equal(byPath['src/untracked file.ts'].kind, 'untracked')
assert.equal(status.entries.length, 5, 'the rename origPath is not counted as its own entry')

// A path containing a literal space must survive intact.
const spaced = parsePorcelainV2('1 .M N... 100644 100644 100644 a b a b/c d.ts\0')
assert.equal(spaced.entries[0].path, 'a b/c d.ts', 'spaces inside a path are not split')

// --- grouping mirrors the VS Code split: staged / changes / conflicts ---
const grouped = groupEntries(status.entries)
assert.deepEqual(grouped.conflicts.map(e => e.path), ['src/conflict.ts'])
assert.deepEqual(grouped.staged.map(e => e.path), ['README.md', 'src/new name.ts'])
assert.deepEqual(grouped.changes.map(e => e.path), ['src/client/ledger-tab.tsx', 'src/untracked file.ts'], 'a rename whose worktree side is unchanged lands only in staged')

// --- numstat: a dash pair means binary, and must not become NaN ---
const counts = parseNumstat('12\t3\tsrc/a.ts\0-\t-\tassets/logo.png\0')
assert.deepEqual(counts.get('src/a.ts'), { added: 12, removed: 3 })
assert.equal(counts.get('assets/logo.png'), null, 'binary files carry no line counts')

// --- path containment: no escape above the repository root ---
assert.equal(resolveInside('/repo', 'src/a.ts'), 'src/a.ts')
assert.equal(resolveInside('/repo', 'src/../src/a.ts'), 'src/a.ts', 'normalised but still inside')
for (const bad of ['../outside.ts', '/abs/path.ts', 'src/../../x.ts']) {
 assert.throws(() => resolveInside('/repo', bad), GitReadError, `must reject ${bad}`)
}
// NTFS aliases of .git resolve to the same directory (CVE-2014-9390 family).
for (const bad of ['.git/config', '.GIT/config', 'GIT~1/config', '.git./config', '.git /config', '.git::$INDEX_ALLOCATION/config', 'src/.git/HEAD'])
 assert.throws(() => resolveInside('/repo', bad), GitReadError, `must reject ${bad}`)

// --- status: not a repository is a fact, not a failure ---
const notRepo = async () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' })
assert.deepEqual(await readGitStatus('/tmp', notRepo), { isRepo: false })

const failing = async () => ({ exitCode: 1, stdout: '', stderr: 'fatal: something broke' })
await assert.rejects(() => readGitStatus('/repo', failing), /something broke/, 'a real git failure is not silently reported as no-repo')

// --- status: a real repository gets branch, groups, and per-file counts merged in ---
const calls = []
const repoRun = async args => {
 calls.push(args)
 if (args[0] === 'rev-parse') return { exitCode: 0, stdout: '/repo\n', stderr: '' }
 if (args[0] === 'status') return { exitCode: 0, stdout: '# branch.head master\0# branch.oid abc\0' + '1 .M N... 100644 100644 100644 a b src/a.ts\0? new.ts\0', stderr: '' }
 if (args[0] === 'diff') return { exitCode: 0, stdout: '5\t1\tsrc/a.ts\0', stderr: '' }
 if (args[0] === 'remote') return { exitCode: 0, stdout: 'origin\n', stderr: '' }
 throw new Error('unexpected ' + args.join(' '))
}
const live = await readGitStatus('/repo/src', repoRun)
assert.equal(live.isRepo, true)
assert.equal(live.toplevel, path.resolve('/repo'))
assert.equal(live.prefix, 'src')
assert.equal(live.branch.head, 'master')
assert.deepEqual(live.remotes, ['origin'])
assert.equal(live.changes.find(e => e.path === 'src/a.ts').added, 5, 'numstat counts merge onto status entries')
assert.equal(live.changes.find(e => e.path === 'new.ts').added, null, 'untracked files carry no counts')
assert.ok(!calls.some(a => a.includes('-u') || a.includes('--force')), 'read-only status never writes')

// --- diff: both sides are returned as text, binary detected instead of decoded ---
const diffRun = async args => {
 if (args[0] === 'rev-parse') return { exitCode: 0, stdout: '/repo\n', stderr: '' }
 if (args[0] === 'show') return { exitCode: 0, stdout: 'old line 1\nold line 2\n', stderr: '' }
 throw new Error('unexpected ' + args.join(' '))
}
const diff = await readGitDiff('/repo', 'src/a.ts', diffRun, async () => 'new line 1\nnew line 2\n')
assert.equal(diff.before.text, 'old line 1\nold line 2\n')
assert.equal(diff.after.text, 'new line 1\nnew line 2\n')
assert.equal(diff.before.binary, false)

// A NUL byte means binary on either side; the bytes are not shipped as text.
const binaryAfter = await readGitDiff('/repo', 'img.png', diffRun, async () => 'a\0b')
assert.equal(binaryAfter.after.binary, true)
assert.equal(binaryAfter.after.text, null)

// A new file has no index side: that is "absent", not an error.
const absentBefore = await readGitDiff('/repo', 'new.ts', async args => {
 if (args[0] === 'rev-parse') return { exitCode: 0, stdout: '/repo\n', stderr: '' }
 return { exitCode: 128, stdout: '', stderr: "fatal: path 'new.ts' exists on disk, but not in 'HEAD'" }
}, async () => 'brand new\n')
assert.equal(absentBefore.before.exists, false)
assert.equal(absentBefore.after.text, 'brand new\n')

// Oversized sides are refused rather than truncated into a misleading diff.
const big = await readGitDiff('/repo', 'big.txt', diffRun, async () => 'x'.repeat(200), { maxBytes: 100 })
assert.equal(big.after.oversized, true)
assert.equal(big.after.text, null)

// The same containment rule applies to a requested diff path.
await assert.rejects(() => readGitDiff('/repo', '../escape.ts', diffRun, async () => ''), GitReadError)

console.log('git-reader: 34 contract assertions passed; 0 failed')
