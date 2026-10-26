// Python package roots from pyproject.toml / setup.cfg and layout conventions.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assembleTraceGraph, resetTraceFactsCache } from '../lib/tools-trace.js'

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }
const roots = []
const workspace = (files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-python-'))
  roots.push(root)
  for (const [rel, text] of Object.entries(files)) write(root, rel, text)
  return root
}
const write = (root, rel, text) => {
  const abs = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}
const graphOf = async (root) => { resetTraceFactsCache(); return (await assembleTraceGraph(root)).graph }
const edges = (graph, file) => (graph.deps.get(file) ?? []).map(edge => [edge.to, edge.evidence.confidence])
const unresolved = (graph, file, spec) => graph.unresolvedModules.find(ref => ref.path === file && ref.spec === spec)

try {
  {
    const root = workspace({
      'proj/pyproject.toml': '[project]\nname = "mypkg"\n',
      'proj/src/mypkg/__init__.py': '',
      'proj/src/mypkg/core.py': 'import os\n',
      'proj/tests/test_core.py': 'from mypkg import core\nimport os\n',
    })
    const graph = await graphOf(root)
    assert.deepEqual(edges(graph, 'proj/tests/test_core.py'), [['proj/src/mypkg/__init__.py', 'candidate'], ['proj/src/mypkg/core.py', 'candidate']])
    assert.equal(unresolved(graph, 'proj/tests/test_core.py', 'os').reason, 'external_package')
    ok('src/ layout without explicit configuration resolves as candidate edges; stdlib stays external')
  }

  {
    const root = workspace({
      'svc/pyproject.toml': '[tool.setuptools]\npackage-dir = { "" = "lib", "extra" = "vendor/extra_pkg" }\n',
      'svc/lib/svcpkg/__init__.py': '',
      'svc/lib/svcpkg/api.py': '',
      'svc/vendor/extra_pkg/__init__.py': '',
      'svc/vendor/extra_pkg/tool.py': '',
      'svc/app.py': 'import svcpkg.api\nimport extra.tool\n',
    })
    const graph = await graphOf(root)
    assert.deepEqual(edges(graph, 'svc/app.py'), [['svc/lib/svcpkg/api.py', 'certain'], ['svc/vendor/extra_pkg/tool.py', 'certain']])
    ok('setuptools package-dir maps the root package and named packages as certain edges')
  }

  {
    const root = workspace({
      'a/pyproject.toml': '[tool.setuptools.packages.find]\nwhere = ["code"]\n',
      'a/code/alpha/__init__.py': '',
      'b/pyproject.toml': '[tool.poetry]\nname = "b"\npackages = [{ include = "beta", from = "source" }]\n',
      'b/source/beta/__init__.py': '',
      'c/pyproject.toml': '[tool.hatch.build.targets.wheel]\npackages = ["pysrc/gamma"]\n',
      'c/pysrc/gamma/__init__.py': '',
      'd/setup.cfg': '[options]\npackage_dir =\n    =py\n    delta = other/delta_impl\n\n[options.packages.find]\nwhere = py\n',
      'd/py/epsilon/__init__.py': '',
      'd/other/delta_impl/__init__.py': '',
      'main.py': 'import alpha\nimport beta\nimport gamma\nimport delta\nimport epsilon\n',
    })
    const graph = await graphOf(root)
    assert.deepEqual(edges(graph, 'main.py').map(([to]) => to).sort(), [
      'a/code/alpha/__init__.py', 'b/source/beta/__init__.py', 'c/pysrc/gamma/__init__.py', 'd/other/delta_impl/__init__.py', 'd/py/epsilon/__init__.py'])
    assert.ok(edges(graph, 'main.py').every(([, confidence]) => confidence === 'certain'))
    ok('packages.find.where, poetry from, hatch wheel packages and setup.cfg package_dir all declare roots')
  }

  {
    const root = workspace({
      'one/pyproject.toml': '[tool.setuptools]\npackage-dir = { "" = "src" }\n',
      'one/src/common/__init__.py': '',
      'two/pyproject.toml': '[tool.setuptools]\npackage-dir = { "" = "src" }\n',
      'two/src/common/__init__.py': '',
      'use.py': 'import common\n',
    })
    const graph = await graphOf(root)
    assert.equal(unresolved(graph, 'use.py', 'common').reason, 'ambiguous_target')
    assert.deepEqual(edges(graph, 'use.py'), [])
    ok('the same module under two declared roots is ambiguous, never an arbitrary edge')
  }

  {
    const root = workspace({
      'bad/pyproject.toml': '[tool.setuptools\n',
      'esc/pyproject.toml': '[tool.setuptools]\npackage-dir = { "" = "../../outside" }\n',
      'x.py': 'import os\n',
    })
    resetTraceFactsCache()
    const assembled = await assembleTraceGraph(root)
    assert.ok(assembled.diagnostics.some(issue => issue.path === 'bad/pyproject.toml' && issue.reason === 'metadata_parse'))
    assert.ok(assembled.diagnostics.some(issue => issue.path === 'esc/pyproject.toml' && issue.reason === 'unsupported_config'))
    ok('invalid TOML and roots escaping the workspace are reported as diagnostics')
  }

  {
    const root = workspace({
      'pkgproj/pyproject.toml': '[project]\nname = "p"\n',
      'pkgproj/first/mod_a/__init__.py': '',
      'pkgproj/second/mod_a/__init__.py': '',
      'run.py': 'import mod_a\n',
    })
    resetTraceFactsCache()
    const before = await assembleTraceGraph(root)
    assert.equal(unresolved(before.graph, 'run.py', 'mod_a').reason, 'external_package')
    write(root, 'pkgproj/pyproject.toml', '[tool.setuptools]\npackage-dir = { "" = "second" }\n')
    const after = await assembleTraceGraph(root)
    assert.notEqual(after.graph, before.graph)
    assert.deepEqual(edges(after.graph, 'run.py'), [['pkgproj/second/mod_a/__init__.py', 'certain']])
    ok('editing pyproject.toml invalidates the cached graph')
  }
} finally {
  for (const root of roots) try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* tmpdir cleanup fallback */ }
}

console.log(`\n${passed} Trace Python project groups passed`)
