// Non-JavaScript unresolved reasons: each language resolver distinguishes
// external / missing / outside-root / dynamic instead of one generic reason.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assembleTraceGraph, resetTraceFactsCache } from '../lib/tools-trace.js'

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-reasons-'))
const write = (rel, text) => {
  const abs = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

try {
  write('app/__init__.py', '')
  write('app/main.py', 'import os\nfrom .nope import x\nfrom ... import escape\nimport app.absent\n')
  write('go.mod', 'module example.com/demo\n')
  write('cmd/main.go', 'package main\nimport (\n  "fmt"\n  "example.com/demo/missing"\n)\n')
  write('src/lib.rs', 'use std::fmt;\nuse crate::nope::deep::Item;\nmod gone;\n')
  write('native/main.c', '#include <stdio.h>\n#include "nope.h"\n')
  write('java/App.java', 'import java.util.List;\nclass App {}\n')
  write('lua/init.lua', 'local name = "x"\nrequire(name)\n')

  resetTraceFactsCache()
  const { graph } = await assembleTraceGraph(root)
  const reason = (file, spec) => {
    const found = graph.unresolvedModules.find(ref => ref.path === file && ref.spec === spec)
    assert.ok(found, `${file} ${spec}: ${JSON.stringify(graph.unresolvedModules.filter(ref => ref.path === file))}`)
    assert.ok(found.detail || found.reason === 'non_literal', `${file} ${spec} carries a detail`)
    return found.reason
  }

  assert.equal(reason('app/main.py', 'os'), 'external_package')
  assert.equal(reason('app/main.py', '.nope'), 'missing_target')
  assert.equal(reason('app/main.py', '...'), 'outside_root')
  assert.equal(reason('app/main.py', 'app.absent'), 'missing_target')
  ok('Python separates stdlib/third-party, missing local modules and root escapes')

  assert.equal(reason('cmd/main.go', 'fmt'), 'external_package')
  assert.equal(reason('cmd/main.go', 'example.com/demo/missing'), 'missing_target')
  ok('Go separates external imports from missing packages inside the module')

  assert.equal(reason('src/lib.rs', 'std::fmt'), 'external_package')
  assert.equal(reason('src/lib.rs', 'crate::nope::deep::Item'), 'missing_target')
  assert.equal(reason('src/lib.rs', 'gone'), 'missing_target')
  ok('Rust separates external crates from missing crate paths and module files')

  assert.equal(reason('native/main.c', 'stdio.h'), 'external_package')
  assert.equal(reason('native/main.c', 'nope.h'), 'missing_target')
  ok('C separates system headers from missing quoted includes')

  assert.equal(reason('java/App.java', 'java.util.List'), 'external_package')
  assert.equal(reason('lua/init.lua', 'name'), 'non_literal')
  ok('Java JDK imports are external and Lua dynamic requires stay non-literal')
} finally {
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* tmpdir cleanup fallback */ }
}

console.log(`\n${passed} Trace unresolved-reason groups passed`)
