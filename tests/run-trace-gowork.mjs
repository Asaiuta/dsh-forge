// Go workspaces: go.work use lists and local-path replace directives.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assembleTraceGraph, resetTraceFactsCache } from '../lib/tools-trace.js'

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-gowork-'))
const write = (rel, text) => {
  const abs = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}
const targets = (graph, file) => (graph.deps.get(file) ?? []).map(edge => edge.to).sort()
const unresolved = (graph, file, spec) => graph.unresolvedModules.find(ref => ref.path === file && ref.spec === spec)
const imports = (...specs) => `package main\n\nimport (\n${specs.map(spec => `\t"${spec}"`).join('\n')}\n)\n`

try {
  write('go.work', 'go 1.22\n\nuse (\n\t./app\n\t./lib // shared library\n)\n\nreplace example.com/ext => ./third_party/ext\n')
  write('app/go.mod', 'module example.com/app\n\ngo 1.22\n\nreplace (\n\texample.com/legacy v1.0.0 => ../legacy\n\tgithub.com/x/y => github.com/z/y v1.2.0\n)\n')
  write('app/main.go', imports('fmt', 'example.com/lib/util', 'example.com/legacy/pkg', 'example.com/ext', 'github.com/x/y', 'example.com/lib/nope', 'example.com/lib/nested/inner'))
  write('lib/go.mod', 'module example.com/lib\n')
  write('lib/util/util.go', 'package util\n')
  write('lib/nested/go.mod', 'module example.com/lib/nested\n')
  write('lib/nested/inner/inner.go', 'package inner\n')
  write('legacy/go.mod', 'module example.com/legacy\n')
  write('legacy/pkg/p.go', 'package pkg\n')
  write('third_party/ext/go.mod', 'module example.com/ext\n')
  write('third_party/ext/e.go', 'package ext\n')
  write('standalone/go.mod', 'module example.com/standalone\n\nreplace example.com/lib => ../lib\n')
  write('standalone/main.go', imports('example.com/lib/util', 'example.com/app'))

  resetTraceFactsCache()
  const { graph, diagnostics } = await assembleTraceGraph(root)
  assert.deepEqual(diagnostics.filter(issue => /go\.(?:mod|work)$/.test(issue.path)), [])
  assert.deepEqual(targets(graph, 'app/main.go'), ['legacy/pkg/p.go', 'lib/util/util.go', 'third_party/ext/e.go'])
  ok('go.work use modules, go.work replace and go.mod replace resolve to local packages')

  assert.equal(unresolved(graph, 'app/main.go', 'fmt').reason, 'external_package')
  assert.equal(unresolved(graph, 'app/main.go', 'github.com/x/y').reason, 'external_package')
  assert.equal(unresolved(graph, 'app/main.go', 'example.com/lib/nope').reason, 'missing_target')
  assert.equal(unresolved(graph, 'app/main.go', 'example.com/lib/nested/inner').reason, 'unsupported_resolution')
  ok('stdlib and version replacements stay external; missing packages and invisible nested modules are explicit')

  assert.deepEqual(targets(graph, 'standalone/main.go'), ['lib/util/util.go'])
  assert.equal(unresolved(graph, 'standalone/main.go', 'example.com/app').reason, 'external_package')
  ok('a module outside go.work uses its own replaces and does not see workspace modules')

  write('go.work', 'go 1.22\n\nuse ./app\n')
  const after = await assembleTraceGraph(root)
  assert.notEqual(after.graph, graph)
  assert.deepEqual(targets(after.graph, 'app/main.go'), ['legacy/pkg/p.go'])
  assert.equal(unresolved(after.graph, 'app/main.go', 'example.com/lib/util').reason, 'external_package')
  ok('editing go.work invalidates the cached graph')
} finally {
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* tmpdir cleanup fallback */ }
}

console.log(`\n${passed} Trace Go workspace groups passed`)
