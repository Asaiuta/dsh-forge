// Differential check against the INSTALLED host: the real dsh-tool-fs /
// dsh-tool-fs-search code, the real dsh-tools registry and its search baseline,
// with and without forge's augmentation, compared call by call.
//
// This is the only suite that can prove "the augmented answer IS the built-in
// answer" — every other suite compares against forge's reading of the
// built-in. It needs the host's packages on disk (DSH ships them inside
// app.asar), so it is machine-local and skips without them:
//
//   python tools/asar-closure.py "<DSH>/resources/app.asar" <dir> \
//     @deepseek-ai/cordis @deepseek-ai/dsh-tools @deepseek-ai/dsh-tool-fs \
//     @deepseek-ai/dsh-tool-fs-search @deepseek-ai/dsh-fs-local \
//     @deepseek-ai/dsh-subprocess-local @vscode/ripgrep
//   copy <DSH>/resources/app.asar.unpacked/node_modules/{@vscode/ripgrep-*,koffi}
//     into <dir>/node_modules/
//   DSH_FORGE_HOST_MODULES=<dir>/node_modules
//
// Corpora: this repository, plus any directories in DSH_FORGE_AUGMENT_CORPORA
// (path-delimiter separated). Each query runs built-in-only first, then
// augmented, and the value, the rendered text and the presentation meta must be
// identical — for grep, except that over-budget lines are excerpted.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { localEnv } from '../scripts/local-env.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const modules = localEnv('DSH_FORGE_HOST_MODULES')
if (!modules || !existsSync(path.join(modules, '@deepseek-ai', 'dsh-tool-fs-search', 'lib', 'index.js'))) {
  console.log('run-augment-host: installed host packages unavailable; SKIPPED (set DSH_FORGE_HOST_MODULES)')
  process.exit(0)
}

const load = (name) => import(pathToFileURL(path.join(modules, ...name.split('/'), 'lib', 'index.js')).href)
const { Context } = await load('@deepseek-ai/cordis')
const { ToolRuntime } = await load('@deepseek-ai/dsh-tools')
const fsSearch = await load('@deepseek-ai/dsh-tool-fs-search')
const toolFs = await load('@deepseek-ai/dsh-tool-fs')
const { LocalFileSystem } = await load('@deepseek-ai/dsh-fs-local')
const { LocalSubprocessRuntime } = await load('@deepseek-ai/dsh-subprocess-local')
const { installAugmentation } = await import(new URL('../lib/augment.js', import.meta.url).href)

let passed = 0
const ok = (name) => console.log(`ok ${++passed} - ${name}`)
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

const root = new Context()
root.provide('systemPrompt', {
  tools() { return () => {} }, section() { return () => {} }, context() { return () => {} },
  getSectionOrder() { return 0 }, getContextOrder() { return 0 },
})
root.provide('workingDirectory', { ensure: async (agent) => agent.session.header.cwd })
root.plugin(ToolRuntime)
root.plugin(LocalFileSystem, { cwd: REPO })
root.plugin(LocalSubprocessRuntime)
await settle()
root.plugin(fsSearch, { sampleOverCapGlobResults: false })
root.plugin(toolFs, {})
await settle()
const registry = root.get('tools')
for (const name of ['read', 'grep', 'glob']) assert.ok(registry.get(name), `installed built-in ${name} did not register`)

const augmentHost = {
  on: (event, listener) => root.on(event, listener),
  get: (name) => root.get(name),
  emit: (event, ...args) => root.emit(event, ...args),
  fs: root.get('fs'),
  tools: registry,
  logger: { warn: (message) => console.log(`  warn: ${message}`) },
}

let call = 0
async function run(name, args, cwd) {
  const agent = { session: { header: { cwd, id: 'augment-host' } } }
  const start = performance.now()
  const result = await registry.execute({ callId: `c${++call}`, name, agent, arguments: args, signal: new AbortController().signal })
  return { result, ms: performance.now() - start }
}

/** Run once built-in only, once augmented; return both. */
async function pair(name, args, cwd) {
  const builtin = await run(name, args, cwd)
  const augmentation = installAugmentation(augmentHost, { names: [name] })
  try {
    const augmented = await run(name, args, cwd)
    return { builtin, augmented, stats: augmentation.stats() }
  } finally {
    augmentation.dispose()
  }
}

const corpora = [REPO, ...(localEnv('DSH_FORGE_AUGMENT_CORPORA') ?? '').split(path.delimiter).map((p) => p.trim()).filter((p) => p && existsSync(p))]
const timings = []

for (const corpus of corpora) {
// --- glob: byte-identical ------------------------------------------------
  for (const args of [{ pattern: '*.md' }, { pattern: '**/*.json' }, { pattern: 'src/**/*.ts' }, { pattern: '*.ts', path: 'src' }, { pattern: '*.js' }, { pattern: '*.{md,json}', path: corpus }]) {
    const { builtin, augmented, stats } = await pair('glob', args, corpus)
    if (builtin.result.isError) {
      // The built-in has an error to report (a missing `path`, a bad glob): the
      // augmentation must hand the call over and the error must be its own.
      assert.equal(stats.served.glob, 0, `glob ${JSON.stringify(args)} answered where the built-in fails`)
      assert.deepEqual(augmented.result.content, builtin.result.content, 'the built-in error, verbatim')
      continue
    }
    assert.equal(stats.served.glob, 1, `glob ${JSON.stringify(args)} declined in ${corpus}: ${JSON.stringify(stats.declined.glob)}`)
    assert.deepEqual(augmented.result.value, builtin.result.value, `glob ${JSON.stringify(args)} value differs in ${corpus}`)
    assert.deepEqual(augmented.result.content, builtin.result.content, `glob ${JSON.stringify(args)} render differs`)
    assert.deepEqual(augmented.result.meta, builtin.result.meta, `glob ${JSON.stringify(args)} card meta differs`)
    timings.push({ corpus, tool: 'glob', args, builtin: builtin.ms, augmented: augmented.ms, n: builtin.result.value?.paths?.length })
  }
  ok(`glob on ${path.basename(corpus)}: value, render and card identical to the installed built-in`)

  // --- grep: identical except excerpted over-budget lines -------------------
  for (const args of [{ pattern: 'TODO' }, { pattern: 'import' }, { pattern: 'function\\s+\\w+\\(' }, { pattern: 'export', include: '*.ts' }, { pattern: 'const', path: 'src' }]) {
    const { builtin, augmented } = await pair('grep', args, corpus)
    // Two ripgrep runs are compared, and its parallel walk emits files in no
    // fixed order — so matches are compared as a keyed set, not by position.
    const key = (m) => `${m.path}\u0000${m.lineNumber}`
    const a = new Map((builtin.result.value?.matches ?? []).map((m) => [key(m), m]))
    const b = new Map((augmented.result.value?.matches ?? []).map((m) => [key(m), m]))
    assert.equal(b.size, a.size, `grep ${JSON.stringify(args)} match count differs`)
    for (const [k, m] of a) {
      const other = b.get(k)
      assert.ok(other, `grep ${JSON.stringify(args)} lost ${k}`)
      if (Buffer.byteLength(m.line) <= 2000) assert.equal(other.line, m.line, 'a line inside the preview budget must be the built-in line')
    }
    timings.push({ corpus, tool: 'grep', args, builtin: builtin.ms, augmented: augmented.ms, n: a.size, chars: [builtin.result.content[0]?.text.length, augmented.result.content[0]?.text.length] })
  }
  ok(`grep on ${path.basename(corpus)}: same matches; lines inside the preview budget untouched`)
}

// --- grep: a minified line delegates to host render without changing value ---
{
  const dir = path.join(HERE, '.augment-host-probe')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'bundle.min.js'), `var a="${'x'.repeat(20_000)}";function needleHere(){};var b="${'y'.repeat(20_000)}"\n`)
  const { builtin, augmented } = await pair('grep', { pattern: 'needle\\w+' }, dir)
  const before = builtin.result.content[0].text
  const after = augmented.result.content[0].text
  assert.ok(!before.includes('needleHere'), 'the installed preview hides a match beyond its head budget')
  assert.equal(after, before, 'without a stable display-only seam long lines use the unchanged installed preview')
  assert.deepEqual(augmented.result.value, builtin.result.value, 'spill/PTC canonical values must retain the complete line')
  assert.ok(augmented.result.value.matches[0].line.includes('needleHere'))
  assert.equal(augmented.result.meta.files[0].matches[0].lineNumber, 1, 'the search card still validates')
  rmSync(dir, { recursive: true, force: true })
  ok(`grep on a minified line: complete canonical value preserved; installed preview unchanged (${after.length} chars)`)
}

// --- read: plain reads untouched, file#Symbol in the built-in envelope -------
{
  const target = path.join('src', 'augment.ts')
  const plain = await pair('read', { file_path: target, offset: 10, limit: 5 }, REPO)
  assert.deepEqual(plain.augmented.result.value, plain.builtin.result.value)
  assert.deepEqual(plain.augmented.result.content, plain.builtin.result.content)
  const symbol = await pair('read', { file_path: `${target}#excerptLine` }, REPO)
  assert.equal(symbol.builtin.result.isError, true, 'the installed built-in cannot read file#Symbol')
  assert.equal(symbol.augmented.result.isError, false, JSON.stringify(symbol.augmented.result.content))
  const text = symbol.augmented.result.content[0].text
  assert.match(text, /^<path>.*augment\.ts<\/path>\n<type>file<\/type>\n<content>\n\d+: /, 'rendered by the installed read envelope')
  assert.match(text, /export function excerptLine/)
  assert.equal(symbol.augmented.result.meta.offset, symbol.augmented.result.value.offset, 'the read card meta is the installed projection')
  ok('read: plain windows identical; file#Symbol renders through the installed read envelope and card')
}

console.log('\ncorpus | tool | args | built-in ms | augmented ms | results')
for (const t of timings) {
  console.log(`${path.basename(t.corpus)} | ${t.tool} | ${JSON.stringify(t.args)} | ${Math.round(t.builtin)} | ${Math.round(t.augmented)} | ${t.n ?? '-'}${t.chars ? ` | chars ${t.chars[0]} → ${t.chars[1]}` : ''}`)
}
console.log(`\n${passed} installed-host groups passed`)
root.registry?.delete?.(ToolRuntime)
process.exit(0)
