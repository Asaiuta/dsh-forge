// Takeover by augmentation (src/augment.ts).
//
// The native search backend is checked against explicit fixture contracts, and
// every unsupported call must reach the built-in exactly once.
//
//   glob   includes hidden/ignored files and orders ties by relative path.
//   grep   native matches preserve line and file data; long direct-call lines
//          are excerpted while programmatic callers receive full lines.
//   read   `file#Symbol` answers in the built-in value shape and emits the
//          observation the edit policy needs; a real `a#b` file is the
//          built-in's.
//   host   the value travels through the real dsh-tools registry: validated and
//          rendered by the built-in's own output contract.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const { installAugmentation, excerptLine, lineWindow, pickSymbol, toWorkdirRelative } = await import(new URL('../lib/augment.js', import.meta.url).href)

let passed = 0
const ok = (name) => console.log(`ok ${++passed} - ${name}`)
const BASE = path.join(HERE, '.augment-probe')

// The built-ins as the registry hands them out: the description head is part of
// what identifies them (a same-shaped tool from another plugin is not answered for).
const NATIVE = {
  glob: { name: 'glob', description: 'Find files, not directories, whose paths match a glob pattern, including hidden and ignored files. Returns up to 100 paths.', output: { schema: { type: 'object', properties: { root: { type: 'string' }, paths: { type: 'array' } } } } },
  grep: { name: 'grep', description: 'Search file contents with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file. Returns up to 250 matches.', output: { schema: { type: 'object', properties: { matches: { type: 'array' } } } } },
  read: { name: 'read', description: 'Read a UTF-8 text file and return line-numbered content.', output: { schema: { type: 'object', properties: { path: {}, offset: {}, lines: {}, totalLines: {} } } } },
}

/** A file provider with the built-in decode rules (strict UTF-8, NUL sniff). */
function localFs(base) {
  return {
    async resolve(file, options) {
      const absolute = path.resolve(options?.cwd ?? base, file)
      return { targetKey: absolute, displayPath: absolute }
    },
    async stat(target) {
      try {
        const info = statSync(target.targetKey)
        return { version: `${info.mtimeMs}:${info.size}`, type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', size: info.size }
      } catch {
        return undefined
      }
    },
    async readText(target) {
      const raw = readFileSync(target.targetKey)
      if (raw.subarray(0, 8192).includes(0)) throw new Error('binary file')
      return new TextDecoder('utf-8', { fatal: true }).decode(raw)
    },
    processPath(target) { return String(target.targetKey) },
  }
}

/** A structural host: one listener slot, an observation log, an optional working directory. */
function world({ workdir, tools = { get: (name) => NATIVE[name] }, names = ['read', 'glob', 'grep'], fs = localFs(workdir), withDirectory = true, hostServices = {}, agentServices } = {}) {
  let listener
  const emitted = []
  const warnings = []
  const host = {
    on(event, fn) { assert.equal(event, 'tools/execute'); listener = fn; return () => { listener = undefined } },
    get(name) { return name === 'workingDirectory' && withDirectory ? { ensure: async () => workdir } : hostServices[name] },
    emit(event, ...args) { emitted.push({ event, args }) },
    fs,
    tools,
    logger: { warn: (message) => warnings.push(message) },
  }
const augmentation = installAugmentation(host, { names })
  const agent = { session: { header: { cwd: workdir } }, ...(agentServices === undefined ? {} : { ctx: { get: (name) => agentServices[name] } }) }
  const call = async (name, args, { next, parent } = {}) => {
    let nextCalls = 0
    const builtin = async () => { nextCalls++; return next ? next() : { isError: false, value: { builtin: true } } }
    const result = await listener({ name, arguments: args, agent, ...(parent === undefined ? {} : { parent }), signal: new AbortController().signal }, builtin)
    return { result, nextCalls }
  }
  return { augmentation, call, emitted, warnings, host }
}

const put = (root, rel, data) => {
  const absolute = path.join(root, rel)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, data)
  return absolute
}

async function main() {
  rmSync(BASE, { recursive: true, force: true })

  // --- plumbing -------------------------------------------------------------
  {
    assert.equal(installAugmentation({}, { names: ['glob'] }), undefined, 'no around-dispatch seam, nothing installed')
    assert.equal(installAugmentation({ on() {} }, { names: [] }), undefined, 'nothing to augment, nothing installed')
    const ws = path.join(BASE, 'plumbing')
    mkdirSync(ws, { recursive: true })
    const { call } = world({ workdir: ws, names: ['glob'] })
    const passthrough = await call('edit', { file_path: 'x' })
    assert.deepEqual(passthrough.result, { isError: false, value: { builtin: true } })
    assert.equal(passthrough.nextCalls, 1, 'an un-augmented name reaches the built-in once')
    const notEnabled = await call('grep', { pattern: 'x' })
    assert.equal(notEnabled.nextCalls, 1, 'a built-in not listed in takeover is untouched')
    ok('the listener passes every call it does not own straight to the built-in')
  }

  // --- glob: native traversal, stable mtime/path order ----------------------
  {
    const ws = path.join(BASE, 'glob')
    const names = ['Alpha/x.txt', 'beta/x.txt', '_under/x.txt', 'Zeta/x.txt', 'zz/x.txt', '10.txt', '9.txt', 'ä.txt', '-dash.txt',
      'deep/a/b/c.txt', 'deep/a.txt', 'deep/a/z.txt', 'deep/A b/q.txt', '.hidden/h.txt', 'node_modules/pkg/m.txt',
      'src/one.ts', 'src/two.ts', 'src/sub/three.ts', 'docs/readme.md', 'docs/Guide.MD']
    for (const name of names) put(ws, name, `${name}\n`)
    put(ws, '.gitignore', 'node_modules/\n')
    put(ws, '.git/HEAD', 'ref: refs/heads/main\n')
    // Every file shares one timestamp: the order is then pure walk order, the
    // case an in-process sort is most likely to get wrong.
    const tie = new Date('2021-02-03T04:05:06.789Z')
    for (const name of names) utimesSync(path.join(ws, name), tie, tie)
    const { call, augmentation } = world({ workdir: ws })
    for (const [pattern, rawPath] of [['*.txt', undefined], ['**/*.ts', undefined], ['*.md', undefined], ['*.txt', 'deep'], ['*.txt', path.join(ws, 'deep')], ['*.txt', './deep'], ['*.{txt,md}', undefined]]) {
      const { result, nextCalls } = await call('glob', rawPath === undefined ? { pattern } : { pattern, path: rawPath })
      assert.equal(nextCalls, 0, `fast path expected for ${pattern} ${rawPath ?? ''}`)
      assert.equal(result.value.root, rawPath === undefined ? '.' : toWorkdirRelative(rawPath, ws))
    }
    const tiePaths = (await call('glob', { pattern: '*.txt' })).result.value.paths.map(item => item.replaceAll('\\', '/'))
    assert.deepEqual(tiePaths, process.platform === 'win32'
      ? ['-dash.txt', '.hidden/h.txt', '10.txt', '9.txt', '_under/x.txt', 'Alpha/x.txt', 'beta/x.txt', 'deep/a/b/c.txt', 'deep/a/z.txt', 'deep/A b/q.txt', 'deep/a.txt', 'node_modules/pkg/m.txt', 'Zeta/x.txt', 'zz/x.txt', 'ä.txt']
      : ['-dash.txt', '.hidden/h.txt', '10.txt', '9.txt', 'Alpha/x.txt', 'Zeta/x.txt', '_under/x.txt', 'beta/x.txt', 'deep/A b/q.txt', 'deep/a/b/c.txt', 'deep/a/z.txt', 'deep/a.txt', 'node_modules/pkg/m.txt', 'zz/x.txt', 'ä.txt'])
    ok('glob includes hidden and ignored files, with stable mtime/path order')

    // Distinct timestamps, some shared, some out of name order.
    const stamps = names.map((name, i) => [name, new Date(Date.UTC(2022, 0, 1, 0, 0, (i * 7) % 5))])
    for (const [name, when] of stamps) utimesSync(path.join(ws, name), when, when)
    for (const pattern of ['*.txt', '**/*', 'src/**']) {
      assert.equal((await call('glob', { pattern })).nextCalls, 0)
    }
    ok('glob with mixed timestamps remains locally served')

    const empty = await call('glob', { pattern: '*.nothing' })
    assert.deepEqual(empty.result.value, { root: '.', paths: [] })
    assert.equal(empty.nextCalls, 0, 'an empty result is an answer, not a failure')
    const missing = await call('glob', { pattern: '*.txt', path: 'no-such-dir' })
    assert.equal(missing.nextCalls, 1, 'a missing root belongs to the built-in')
    const badGlob = await call('glob', { pattern: '{a,b' })
    assert.equal(badGlob.nextCalls, 1, 'an invalid glob is reported by the built-in')
    const blank = await call('glob', { pattern: '   ' })
    assert.equal(blank.nextCalls, 1, 'the built-in owns its own argument errors')
    const stats = augmentation.stats()
    assert.ok(stats.served.glob >= 10, JSON.stringify(stats))
    assert.ok(stats.declined.glob['native-search-unavailable'] >= 2 && stats.declined.glob['invalid-arguments'] === 1, JSON.stringify(stats.declined.glob))
    ok('glob declines exactly where the built-in has something else to say')

    const previousSearch = process.env.DSH_FORGE_SEARCH_NATIVE
    process.env.DSH_FORGE_SEARCH_NATIVE = '0'
    const nativeOff = world({ workdir: ws })
    assert.equal((await nativeOff.call('glob', { pattern: '*.txt' })).nextCalls, 1)
    assert.equal(nativeOff.augmentation.stats().declined.glob['native-search-unavailable'], 1)
    if (previousSearch === undefined) delete process.env.DSH_FORGE_SEARCH_NATIVE
    else process.env.DSH_FORGE_SEARCH_NATIVE = previousSearch
    const otherShape = world({ workdir: ws, tools: { get: () => ({ name: 'glob', output: { schema: { properties: { files: {} } } } }) } })
    assert.equal((await otherShape.call('glob', { pattern: '*.txt' })).nextCalls, 1, 'an unknown built-in shape is left alone')
    const forgeOwned = world({ workdir: ws, tools: { get: () => ({ ...NATIVE.glob, dshForgeName: 'ff_find' }) } })
    assert.equal((await forgeOwned.call('glob', { pattern: '*.txt' })).nextCalls, 1, 'a forge definition is never answered for')
    const noDirectory = world({ workdir: ws, withDirectory: false })
    assert.equal((await noDirectory.call('glob', { pattern: '*.txt' })).nextCalls, 1, 'an agent call without workingDirectory cannot know the built-in cwd')
    ok('glob with native search disabled, a different built-in, or no working directory defers')

    // A preset that swaps in its own process runner (confined, remote) makes a
    // local sidecar list a different world. Handles are compared by
    // implementation: cordis gives every `get` a fresh proxy of one service.
    class LocalRunner {}
    class RemoteRunner {}
    const sameRunner = world({ workdir: ws, hostServices: { subprocess: new LocalRunner() }, agentServices: { subprocess: new LocalRunner() } })
    assert.equal((await sameRunner.call('glob', { pattern: '*.txt' })).nextCalls, 0, 'the agent runs where the host runs')
    const otherRunner = world({ workdir: ws, hostServices: { subprocess: new LocalRunner() }, agentServices: { subprocess: new RemoteRunner() } })
    assert.equal((await otherRunner.call('glob', { pattern: '*.txt' })).nextCalls, 1)
    assert.equal(otherRunner.augmentation.stats().declined.glob['agent-subprocess-differs'], 1)
    const plainObjectRunner = world({ workdir: ws, hostServices: { subprocess: {} }, agentServices: { subprocess: {} } })
    assert.equal((await plainObjectRunner.call('glob', { pattern: '*.txt' })).nextCalls, 1, 'different plain-object runners cannot be identified by their shared prototype')
    assert.equal(plainObjectRunner.augmentation.stats().declined.glob['agent-subprocess-differs'], 1)
    const scopedOnlyRunner = world({ workdir: ws, agentServices: { subprocess: {} } })
    assert.equal((await scopedOnlyRunner.call('glob', { pattern: '*.txt' })).nextCalls, 1, 'a scoped runner without a host counterpart is not assumed local')
    assert.equal(scopedOnlyRunner.augmentation.stats().declined.glob['agent-subprocess-differs'], 1)
    // The same value shape from another plugin is not the built-in.
    const lookalike = world({ workdir: ws, tools: { get: () => ({ ...NATIVE.glob, description: 'List remote files over SSH.' }) } })
    assert.equal((await lookalike.call('glob', { pattern: '*.txt' })).nextCalls, 1)
    assert.equal(lookalike.augmentation.stats().declined.glob['not-builtin'], 1)
    ok('glob defers for an agent-scoped runner and for a same-shaped tool that is not the built-in')
  }

  // --- grep: excerpt only what the built-in would have cut -------------------
  {
    const ws = path.join(BASE, 'grep')
    mkdirSync(ws, { recursive: true })
    const long = `var a="${'x'.repeat(30_000)}";function needleHere(){return 1};var b="${'y'.repeat(30_000)}"`
    const short = 'const needleHere = 1'
    put(ws, 'min.js', `${long}\n`)
    put(ws, 'src/a.ts', `${short}\n`)
    const { call, augmentation } = world({ workdir: ws })
    const fullResult = { isError: false, value: { matches: [{ path: 'min.js', lineNumber: 1, line: long }, { path: 'src/a.ts', lineNumber: 1, line: short }] } }
    const { result, nextCalls } = await call('grep', { pattern: 'needle\\w+' }, { next: async () => fullResult })
    assert.equal(nextCalls, 1, 'long direct-call lines defer to the host render/spill owner')
    assert.equal(result, fullResult, 'the complete host value must remain intact for spill')
    assert.equal(augmentation.stats().served.grep, 0)

    const nested = await call('grep', { pattern: 'needle\\w+' }, { parent: {} })
    assert.equal(nested.result.value.matches[0].line, long, 'programmatic callers get full lines')
    assert.equal((await call('grep', { pattern: 'needle', include: '*.ts' })).result.value.matches[0].line, short, 'short lines stay unchanged')
    const failed = { isError: true, error: { message: 'boom' }, content: [] }
    const previousSearch = process.env.DSH_FORGE_SEARCH_NATIVE
    process.env.DSH_FORGE_SEARCH_NATIVE = '0'
    assert.equal((await call('grep', { pattern: 'x' }, { next: async () => failed })).result, failed)
    let rejectedDispatches = 0
    await assert.rejects(
      () => call('grep', { pattern: 'x' }, { next: async () => { rejectedDispatches++; throw new Error('built-in failed') } }),
      /built-in failed/,
    )
    assert.equal(rejectedDispatches, 1, 'a rejected built-in dispatch must not be replayed by the augmentation fallback')
    if (previousSearch === undefined) delete process.env.DSH_FORGE_SEARCH_NATIVE
    else process.env.DSH_FORGE_SEARCH_NATIVE = previousSearch
    ok('grep preserves a rejected built-in dispatch without invoking it twice')
    const jsUnfriendly = await call('grep', { pattern: '(?P<n>needle)' }, { next: async () => fullResult })
    assert.equal(jsUnfriendly.nextCalls, 1, 'long-line fallback must not depend on JavaScript regex compatibility')
    assert.equal(jsUnfriendly.result.value.matches[0].line, long)
    ok('grep preserves complete canonical values and delegates long direct-call render/spill')

    assert.equal(excerptLine('a'.repeat(5000), /zzz/), undefined, 'no located match, no excerpt')
    assert.equal(excerptLine('short line', /short/), undefined)
    const astral = `${'😀'.repeat(1500)}needle${'😀'.repeat(1500)}`
    const cut = excerptLine(astral, /needle/u)
    assert.ok(cut !== undefined && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut), 'a cut never splits a surrogate pair')
    // The match itself is what fills the budget: an excerpt that would still be
    // over the preview is dropped, so the caller keeps the built-in's head.
    assert.equal(excerptLine(`x${'y'.repeat(3000)}`, /y{3000}/), undefined, 'an over-budget excerpt is dropped, not double-truncated')
    ok('excerptLine: no match, short line, and surrogate-safe cuts')
  }

  // --- read: file#Symbol in the built-in value shape -------------------------
  {
    const ws = path.join(BASE, 'read')
    put(ws, 'src/store.ts', [
      'import { x } from "./x"',
      '',
      '/** Keeps blobs. */',
      'export class Store {',
      '  save(blob: string) {',
      '    return blob',
      '  }',
      '',
      '  load() {',
      '    return 1',
      '  }',
      '}',
      '',
      'export function save() { return 2 }',
      '',
      'class Cache {',
      '  load() { return 3 }',
      '}',
      '',
    ].join('\n'))
    put(ws, 'src/crlf.ts', 'export function one() {\r\n  return 1\r\n}\r\n')
    put(ws, 'src/cr.ts', 'export function one() {\r  return 1\r}\r')
    put(ws, 'docs/x#y.md', '# literal file with a hash\n')
    put(ws, 'docs/notes.md', '# Notes\n')
    const { call, emitted } = world({ workdir: ws })

    const plain = await call('read', { file_path: 'src/store.ts' })
    assert.equal(plain.nextCalls, 1, 'a read without # is the built-in')

    const method = await call('read', { file_path: 'src/store.ts#Store.save' })
    assert.equal(method.nextCalls, 0)
    assert.deepEqual(method.result.value, {
      path: path.join(ws, 'src', 'store.ts'),
      offset: 5,
      lines: [{ number: 5, text: '  save(blob: string) {' }, { number: 6, text: '    return blob' }, { number: 7, text: '  }' }],
      // The file ends with a newline, which opens no line (`buildWindow`).
      totalLines: 18,
    })
    const observation = emitted.find((entry) => entry.event === 'fs/observed')
    assert.ok(observation && observation.args[1].kind === 'present', 'the edit policy must see this read')
    ok('read file#Class.method: the definition window in the built-in value shape, observed')

    const klass = await call('read', { file_path: 'src/store.ts#Store' })
    assert.equal(klass.result.value.offset, 3, 'a leading doc comment belongs to the definition')
    assert.equal(klass.result.value.lines.at(-1).number, 12)
    const crlf = await call('read', { file_path: 'src/crlf.ts#one' })
    assert.deepEqual(crlf.result.value.lines.map((line) => line.text), ['export function one() {', '  return 1', '}'], 'CRLF is stripped per line like the built-in')

    // An exact qualified name is an address: `save` is the top-level function,
    // the method is `Store.save`.
    const exact = await call('read', { file_path: 'src/store.ts#save' })
    assert.equal(exact.result.value.offset, 14)
    const ambiguous = await call('read', { file_path: 'src/store.ts#load' })
    assert.equal(ambiguous.result.isError, true)
    assert.match(ambiguous.result.error.message, /names 2 definitions/)
    assert.match(ambiguous.result.error.message, /Store\.load .*Cache\.load/)
    assert.match(ambiguous.result.content[0].text, /^Error: /)
    const unknown = await call('read', { file_path: 'src/store.ts#Nope' })
    assert.match(unknown.result.error.message, /no definition named "Nope"/)
    ok('read file#Name: ambiguity and absence are explained, never guessed')

    for (const [args, reason] of [
      [{ file_path: 'docs/x#y.md' }, 'literal-path-exists'],
      [{ file_path: 'docs/notes.md#Notes' }, 'unsupported-language'],
      [{ file_path: 'src/cr.ts#one' }, 'lone-carriage-return'],
      [{ file_path: 'src/store.ts#Store', offset: 2 }, 'window-arguments'],
      [{ file_path: 'src/missing.ts#X' }, 'not-a-file'],
    ]) {
      const declined = await call('read', args)
      assert.equal(declined.nextCalls, 1, `${JSON.stringify(args)} must reach the built-in`)
    }
    for (const edge of [{ file_path: '#Foo' }, { file_path: 'src/store.ts#' }]) {
      assert.equal((await call('read', edge)).nextCalls, 1)
    }
    ok('read: a real a#b file, other languages, lone CR, windows and missing files stay with the built-in')

    // The filesystem is the one the agent's scope resolves, as for the built-in.
    let scopedReads = 0
    const scopedFs = { ...localFs(ws), async readText(target) { scopedReads++; return localFs(ws).readText(target) } }
    const scoped = world({ workdir: ws, agentServices: { fs: scopedFs } })
    assert.equal((await scoped.call('read', { file_path: 'src/store.ts#Store.save' })).nextCalls, 0)
    assert.equal(scopedReads, 1, 'the agent-scoped provider served the bytes')
    const remote = world({ workdir: ws, tools: { get: () => ({ ...NATIVE.read, description: 'Read a file on the remote host.' }) } })
    assert.equal((await remote.call('read', { file_path: 'src/store.ts#Store.save' })).nextCalls, 1, 'a same-shaped read from another plugin is not answered with local bytes')
    ok('read: agent-scoped filesystem, and a same-shaped non-built-in read is left alone')

    const window = lineWindow(`${'a'.repeat(2500)}\nshort\n`, 1, 2)
    assert.match(window.lines[0].text, /\.\.\. \(line truncated to 2000 chars\)$/)
    assert.equal(window.totalLines, 2)
    assert.deepEqual(pickSymbol([{ qualifiedName: 'A.b', kind: 'method', startLine: 1, endLine: 2, startOffset: 0 }, { qualifiedName: 'C.b', kind: 'method', startLine: 3, endLine: 4, startOffset: 10 }], 'C.b').symbol.startLine, 3)
    ok('lineWindow and pickSymbol follow the built-in caps and exact qualified names')
  }

  // --- through the real registry --------------------------------------------
  {
    const { Context } = require('@deepseek-ai/cordis')
    const { ToolRuntime, defineTool } = await import('@deepseek-ai/dsh-tools')
    const ws = path.join(BASE, 'glob')
    const root = new Context()
    root.provide('systemPrompt', { tools() { return () => {} }, section() { return () => {} }, context() { return () => {} }, getSectionOrder() { return 0 }, getContextOrder() { return 0 } })
    root.plugin(ToolRuntime)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const registry = root.get('tools')
    let builtinRuns = 0
    registry.register(defineTool({
      name: 'glob',
      description: NATIVE.glob.description,
      parameters: { pattern: { type: 'string', required: true }, path: { type: 'string' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { root: { type: 'string', required: true }, paths: { type: 'array', required: true, items: { type: 'string' } } } },
        render: (_args, value) => [{ type: 'text', text: value.paths.length === 0 ? 'No files found' : value.paths.join('\n') }],
      },
      async execute() { builtinRuns++; return { root: '.', paths: ['from-builtin'] } },
    }))
    const agent = { session: { header: { cwd: ws } } }
    installAugmentation({
      on: (event, listener) => root.on(event, listener),
      get: (name) => (name === 'workingDirectory' ? { ensure: async () => ws } : undefined),
      tools: registry,
      fs: localFs(ws),
      emit() {},
    }, { names: ['glob'] })
    const result = await registry.execute({ callId: 'c1', name: 'glob', agent, arguments: { pattern: '*.md' }, signal: new AbortController().signal })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(builtinRuns, 0, 'the fast path answered')
    assert.deepEqual(result.value.paths.map(item => item.replaceAll('\\', '/')), ['docs/readme.md'])
    assert.equal(result.content[0].text.split('\n').length, 1, 'rendered by the built-in render')
    const fallback = await registry.execute({ callId: 'c2', name: 'glob', agent, arguments: { pattern: '*.md', path: 'no-such-dir' }, signal: new AbortController().signal })
    assert.equal(builtinRuns, 1, 'a declined call runs the built-in body')
    assert.deepEqual(fallback.value.paths, ['from-builtin'])
    ok('through dsh-tools: the value is validated and rendered by the built-in contract; declines run the built-in')
  }

  rmSync(BASE, { recursive: true, force: true })
  console.log(`\n${passed} augmentation groups passed`)
}

await main()
