// Contract for the Git page's change tree. Pure function, no DOM: the renderer
// only walks the result, so the folding rules are testable without a browser.
import assert from 'node:assert/strict'
import { buildChangeTree, flattenVisible, collectPaths } from '../src/client/change-tree.ts'

const f = (path, status = 'M', extra = {}) => ({ path, origPath: null, status, added: 1, removed: 0, binary: false, ...extra })

// --- single-child chain compression: a chain nobody would click through ---
let tree = buildChangeTree([f('src/client/changes/a.ts'), f('src/client/changes/b.ts')])
assert.equal(tree.length, 1, 'one root')
assert.equal(tree[0].kind, 'dir')
assert.equal(tree[0].name, 'src/client/changes', 'the chain collapses to one label')
assert.equal(tree[0].path, 'src/client/changes', 'the row still knows its deepest directory')
assert.equal(tree[0].changes, 2, 'the row counts every changed file beneath it')

// Compression stops where the path branches.
tree = buildChangeTree([f('src/a.ts'), f('src/b.ts'), f('src/deep/c.ts')])
assert.equal(tree[0].name, 'src', 'a branching directory keeps its own row')
assert.deepEqual(tree[0].children.map(n => n.name), ['deep', 'a.ts', 'b.ts'], 'directories first, then files')

// A directory that has its own file is not compressed away.
tree = buildChangeTree([f('src/readme.md'), f('src/deep/c.ts')])
assert.equal(tree[0].name, 'src', 'a file at this level stops compression')

// --- ordering is pinned, not locale-dependent ---
const shuffled = buildChangeTree([f('src/b.ts'), f('src/A.ts'), f('src/c/d.ts'), f('src/C.ts')])
const names = shuffled[0].children.map(n => n.name)
assert.deepEqual(names, ['c', 'A.ts', 'b.ts', 'C.ts'], `stable case-insensitive order with a code-point tiebreak: ${names}`)
const reversed = buildChangeTree([f('src/C.ts'), f('src/c/d.ts'), f('src/A.ts'), f('src/b.ts')])
assert.deepEqual(reversed[0].children.map(n => n.name), names, 'input order does not change the output order')

// --- a repeated path counts once ---
// The same file can appear on both sides (staged + unstaged); the caller passes
// one group at a time, but a duplicate must still not double-count.
tree = buildChangeTree([f('src/a.ts'), f('src/a.ts')])
assert.equal(tree[0].changes, 1, 'a repeated path is one file')

// --- root-level files and deep-only paths ---
tree = buildChangeTree([f('README.md'), f('src/client/a.ts')])
assert.deepEqual(tree.map(n => n.kind), ['dir', 'file'], 'directories sort before root files')
assert.equal(tree[0].name, 'src/client', 'a deep chain compresses even beside a root file')
assert.equal(tree[1].name, 'README.md')

// --- empty input ---
assert.deepEqual(buildChangeTree([]), [], 'no entries means no rows')

// --- flattenVisible: what the collapsed state hides ---
const nested = buildChangeTree([f('src/client/a.ts'), f('src/client/b.ts'), f('README.md')])
const allOpen = flattenVisible(nested, () => true)
assert.equal(allOpen.length, 4, 'directory row + its two files + the root file')
assert.deepEqual(allOpen.map(r => r.depth), [0, 1, 1, 0], 'depth follows nesting')
assert.deepEqual(allOpen.map(r => r.node.name), ['src/client', 'a.ts', 'b.ts', 'README.md'], 'directories first, then root files')
const allClosed = flattenVisible(nested, () => false)
assert.equal(allClosed.length, 2, 'a closed directory hides its children')
assert.deepEqual(allClosed.map(r => r.node.name), ['src/client', 'README.md'])

// A collapsed parent hides an expanded child too: visibility is the AND of the chain.
const deep = buildChangeTree([f('src/client/a.ts')])
assert.equal(flattenVisible(deep, name => name !== 'src/client').length, 1, 'a closed ancestor wins')

// --- every changed file is reachable, no path is lost in folding ---
const many = buildChangeTree([
  f('a/one.ts'), f('a/two.ts'), f('b/one.ts'), f('c/deep/deeper/x.ts'), f('root.ts'),
])
assert.deepEqual(collectPaths(many).sort(), ['a/one.ts', 'a/two.ts', 'b/one.ts', 'c/deep/deeper/x.ts', 'root.ts'], 'folding preserves every path')

// --- a file carrying an original path keeps it (renames) ---
tree = buildChangeTree([{ ...f('src/new.ts', 'R'), origPath: 'src/old.ts' }])
const leaf = tree[0].children[0]
assert.equal(leaf.origPath, 'src/old.ts', 'the rename source survives folding')

console.log('change-tree: 20 contract assertions passed; 0 failed')
