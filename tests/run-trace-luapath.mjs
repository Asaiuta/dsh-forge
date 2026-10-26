// Lua package.path: literal search patterns extend require() resolution.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assembleTraceGraph, resetTraceFactsCache } from '../lib/tools-trace.js'

let passed = 0
const ok = (label) => { passed++; console.log(`  ok - ${label}`) }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-luapath-'))
const write = (rel, text) => {
  const abs = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}
const targets = (graph, file) => (graph.deps.get(file) ?? []).map(edge => [edge.to, edge.evidence.confidence])
const unresolved = (graph, file, spec) => graph.unresolvedModules.find(ref => ref.path === file && ref.spec === spec)

try {
  write('main.lua', 'package.path = "./lib/?.lua;./vendor/?/init.lua;" .. package.path\nlocal strings = require("util.strings")\nlocal json = require("json")\nlocal socket = require("socket")\n')
  write('lib/util/strings.lua', 'return {}\n')
  write('vendor/json/init.lua', 'return {}\n')
  write('boot.lua', 'package.path = package.path .. ";" .. root .. "/mods/?.lua"\nlocal plugin = require("plugin")\n')
  write('mods/plugin.lua', 'return {}\n')
  write('conf.lua', 'package.path = [[ext/?.lua]]\nlocal extra = require("extra")\n')
  write('ext/extra.lua', 'return {}\n')
  write('a1.lua', 'package.path = "p1/?.lua"\n')
  write('a2.lua', 'package.path = "p2/?.lua"\nlocal dup = require("dup")\n')
  write('p1/dup.lua', 'return 1\n')
  write('p2/dup.lua', 'return 2\n')

  resetTraceFactsCache()
  const { graph } = await assembleTraceGraph(root)
  assert.deepEqual(graph.files.get('main.lua').moduleInfo.luaPaths, ['./lib/?.lua', './vendor/?/init.lua'])
  assert.equal(graph.files.get('boot.lua').moduleInfo, undefined)
  ok('literal package.path segments are extracted; segments joined to non-literal operands are dropped')

  assert.deepEqual(targets(graph, 'main.lua'), [['lib/util/strings.lua', 'candidate'], ['vendor/json/init.lua', 'candidate']])
  assert.equal(unresolved(graph, 'main.lua', 'socket').reason, 'unsupported_resolution')
  assert.deepEqual(targets(graph, 'conf.lua'), [['ext/extra.lua', 'candidate']])
  ok('require() resolves through package.path patterns, including long-bracket strings')

  assert.equal(unresolved(graph, 'boot.lua', 'plugin').reason, 'unsupported_resolution')
  assert.equal(unresolved(graph, 'a2.lua', 'dup').reason, 'ambiguous_target')
  ok('dynamic patterns add nothing; distinct hits from several patterns are ambiguous')
} finally {
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* tmpdir cleanup fallback */ }
}

console.log(`\n${passed} Trace Lua package.path groups passed`)
