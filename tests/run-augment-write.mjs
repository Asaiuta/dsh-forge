// Writes that go through the built-in `edit`/`write` enter the ledger.
//
// The augmentation never intercepts a write: `next()` is the built-in, it runs
// exactly once, and its result is handed back untouched. What the listener adds
// is the record the built-in does not keep — so `ffhistory` and `ffrollback`
// cover the writes the model actually makes, not only the ones that came
// through `ffedit`.
//
//   C1  a successful edit appends one `edit` batch whose blobs are the bytes on disk
//   C2  a write that creates the file records `op: 'create'` with no `before`
//   C3  a built-in failure appends nothing and returns the built-in's error as is
//   C4  a call that leaves the content unchanged appends nothing
//   C5  a file over the snapshot budget appends nothing and still returns success
//   C6  bytes the ledger cannot decode (NUL) append nothing and still return success
//   C7  the listener is invisible: one `next()` call, same result object
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BASE = path.join(HERE, '.augment-write-probe')
const DATA = path.join(BASE, '.forge-data')
process.env.DSH_FORGE_DATA_DIR = DATA

const { AUGMENTED_BUILTINS, installAugmentation } = await import(new URL('../lib/augment.js', import.meta.url).href)
const { getBlob, readLedgerTail, storeFor } = await import(new URL('../lib/ledger.js', import.meta.url).href)
const { createRollbackTool } = await import(new URL('../lib/tools-edit.js', import.meta.url).href)
const { FinderPool } = await import(new URL('../lib/core.js', import.meta.url).href)
const rollbackTool = createRollbackTool(new FinderPool())

let passed = 0
const ok = (name) => console.log(`ok ${++passed} - ${name}`)

/** The built-ins as the registry hands them out. Neither is answered for. */
const NATIVE = {
  edit: { name: 'edit', description: 'Edit an existing UTF-8 text file by replacing literal text.' },
  write: { name: 'write', description: 'Create or fully replace a UTF-8 text file.' },
}

function localFs(base) {
  return {
    async resolve(file, options) {
      return { targetKey: path.resolve(options?.cwd ?? base, file), displayPath: file }
    },
    async stat(target) {
      try {
        const info = statSync(target.targetKey)
        return { version: `${info.mtimeMs}:${info.size}`, type: info.isFile() ? 'file' : 'other', size: info.size }
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

function world({ workdir, names = ['edit', 'write'] }) {
  let listener
  const warnings = []
  const host = {
    on(event, fn) { assert.equal(event, 'tools/execute'); listener = fn; return () => { listener = undefined } },
    get(name) { return name === 'workingDirectory' ? { ensure: async () => workdir } : undefined },
    emit() {},
    fs: localFs(workdir),
    tools: { get: (name) => NATIVE[name] },
    logger: { warn: (message) => warnings.push(message) },
  }
  installAugmentation(host, { names })
  const agent = { session: { header: { id: 'session-test', cwd: workdir } }, ctx: { get: () => undefined } }
  const call = async (name, args, next) => {
    let nextCalls = 0
    const builtin = async () => { nextCalls++; return next() }
    const result = await listener({ name, arguments: args, agent, signal: new AbortController().signal }, builtin)
    return { result, nextCalls }
  }
  return { call, warnings }
}

const put = (root, rel, data) => {
  const absolute = path.join(root, rel)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, data)
  return absolute
}

const batches = (root) => {
  const store = storeFor(root)
  const exists = (() => { try { statSync(store.ledgerFile); return true } catch { return false } })()
  return exists ? readLedgerTail(store) : []
}

async function main() {
  rmSync(BASE, { recursive: true, force: true })

  // --- C0: the names are augmented at all -----------------------------------
  {
    assert.deepEqual([...AUGMENTED_BUILTINS].sort(), ['edit', 'glob', 'grep', 'read', 'write'].sort(),
      'edit and write are augmented alongside the read/search built-ins')
    ok('C0 edit and write are augmented')
  }

  // --- the prompt stops promising what is no longer true --------------------
  {
    const { forgeGuidance } = await import(new URL('../lib/guidance.js', import.meta.url).href)
    const full = forgeGuidance(['find', 'grep', 'read', 'edit', 'file', 'history', 'rollback', 'trace'], { symbolRead: true })
    assert.ok(!full.includes('leaves no batch'), 'the prompt no longer claims a built-in edit is invisible to history')
    assert.ok(full.includes('Edit after reading → ff_edit'), 'guidance routes writes through the replacement available in full mode')
    assert.ok(!full.includes('built-in edit is recorded'), 'guidance must not recommend a potentially hidden built-in')
    ok('C0b the guidance matches what the augmentation now records')
  }

  // --- C1 / C7: a successful edit is recorded, invisibly --------------------
  {
    const ws = path.join(BASE, 'update')
    mkdirSync(ws, { recursive: true })
    const file = put(ws, 'src/a.ts', 'const one = 1\nconst two = 2\n')
    const { call } = world({ workdir: ws })
    const sentinel = { isError: false, value: { builtin: true } }
    const { result, nextCalls } = await call('edit', { file_path: 'src/a.ts', old_string: 'const one = 1', new_string: 'const one = 42' }, async () => {
      writeFileSync(file, 'const one = 42\nconst two = 2\n')
      return sentinel
    })
    assert.equal(nextCalls, 1, 'the built-in runs exactly once')
    assert.equal(result, sentinel, 'the built-in result is handed back untouched')

    const list = batches(ws)
    assert.equal(list.length, 1, 'one batch for one edit')
    const batch = list[0]
    assert.equal(batch.kind, 'edit')
    assert.equal(batch.actor, 'session-test')
    assert.equal(batch.nodes.length, 1)
    const node = batch.nodes[0]
    assert.equal(node.file, 'src/a.ts', 'node carries the workspace-relative path')
    assert.equal(node.op, 'update')
    assert.equal(getBlob(storeFor(ws), node.before).toString('utf8'), 'const one = 1\nconst two = 2\n', 'before is the pre-edit bytes')
    assert.equal(getBlob(storeFor(ws), node.after).toString('utf8'), 'const one = 42\nconst two = 2\n', 'after is the bytes on disk')
    ok('C1 a built-in edit appends one batch with both snapshots')
    ok('C7 the listener does not intercept or reshape the write')
  }

  // --- C2: a write that creates the file ------------------------------------
  {
    const ws = path.join(BASE, 'create')
    mkdirSync(ws, { recursive: true })
    const { call } = world({ workdir: ws })
    await call('write', { file_path: 'docs/new.md', content: '# hi\n' }, async () => {
      put(ws, 'docs/new.md', '# hi\n')
      return { isError: false, value: { builtin: true } }
    })
    const list = batches(ws)
    assert.equal(list.length, 1)
    assert.equal(list[0].nodes[0].op, 'create', 'a file that did not exist is a create')
    assert.equal(list[0].nodes[0].before, null, 'nothing to restore before a create')
    assert.equal(getBlob(storeFor(ws), list[0].nodes[0].after).toString('utf8'), '# hi\n')
    ok('C2 a write that creates the file records a create node')
  }

  // --- C8: the batch a built-in edit produced is a real rollback target -----
  {
    const ws = path.join(BASE, 'rollback')
    mkdirSync(ws, { recursive: true })
    const file = put(ws, 'src/r.ts', 'let before = 1\n')
    const { call } = world({ workdir: ws })
    await call('edit', { file_path: 'src/r.ts', old_string: 'before', new_string: 'after' }, async () => {
      writeFileSync(file, 'let after = 1\n')
      return { isError: false, value: { builtin: true } }
    })
    const [batch] = batches(ws)
    assert.equal(readFileSync(file, 'utf8'), 'let after = 1\n', 'the built-in write landed')
    const exec = { agent: { session: { header: { cwd: ws, id: 'session-test' } } } }
    const applied = await rollbackTool.execute({ batch: batch.id, reason: 'undo the built-in edit', dryRun: false }, exec)
    assert.equal(applied.status, 'applied', `rollback applies: ${JSON.stringify(applied).slice(0, 200)}`)
    assert.equal(readFileSync(file, 'utf8'), 'let before = 1\n', 'the pre-edit bytes are restored')
    ok('C8 a batch recorded from a built-in edit is a working rollback target')
  }

  // --- C3: the built-in's own failure is not recorded -----------------------
  {
    const ws = path.join(BASE, 'failed')
    mkdirSync(ws, { recursive: true })
    put(ws, 'src/b.ts', 'let a = 1\n')
    const { call } = world({ workdir: ws })
    const failure = { isError: true, error: { message: 'file has not been read' }, content: [{ type: 'text', text: 'Error: file has not been read' }] }
    const { result } = await call('edit', { file_path: 'src/b.ts', old_string: 'x', new_string: 'y' }, async () => failure)
    assert.equal(result, failure, 'the built-in failure is returned as is')
    assert.equal(batches(ws).length, 0, 'a failed write appends nothing')
    ok('C3 a failed built-in write appends no batch')
  }

  // --- C4: a call that changes nothing --------------------------------------
  {
    const ws = path.join(BASE, 'noop')
    mkdirSync(ws, { recursive: true })
    put(ws, 'src/c.ts', 'let same = 1\n')
    const { call } = world({ workdir: ws })
    await call('edit', { file_path: 'src/c.ts', old_string: 'same', new_string: 'same' }, async () => ({ isError: false, value: { builtin: true } }))
    assert.equal(batches(ws).length, 0, 'an unchanged file is not a batch')
    ok('C4 an edit that leaves the content unchanged appends nothing')
  }

  // --- C5: over the snapshot budget -----------------------------------------
  {
    const ws = path.join(BASE, 'huge')
    mkdirSync(ws, { recursive: true })
    const big = `${'x'.repeat(9 * 1024 * 1024)}\n`
    put(ws, 'big.txt', 'small\n')
    const { call } = world({ workdir: ws })
    const { result } = await call('edit', { file_path: 'big.txt', old_string: 'small', new_string: 'large' }, async () => {
      writeFileSync(path.join(ws, 'big.txt'), big)
      return { isError: false, value: { builtin: true } }
    })
    assert.equal(result.isError, false, 'the write itself still succeeded')
    assert.equal(batches(ws).length, 0, 'a file past the snapshot budget is left unrecorded')
    ok('C5 a file over the snapshot budget appends nothing')
  }

  // --- C6: bytes the ledger cannot decode -----------------------------------
  {
    const ws = path.join(BASE, 'binary')
    mkdirSync(ws, { recursive: true })
    put(ws, 'blob.bin', 'text\n')
    const { call } = world({ workdir: ws })
    const { result } = await call('write', { file_path: 'blob.bin', content: '' }, async () => {
      writeFileSync(path.join(ws, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]))
      return { isError: false, value: { builtin: true } }
    })
    assert.equal(result.isError, false, 'the write itself still succeeded')
    assert.equal(batches(ws).length, 0, 'a binary result is not snapshotted')
    ok('C6 undecodable bytes append nothing')
  }

  // --- no arguments, no record ----------------------------------------------
  {
    const ws = path.join(BASE, 'noargs')
    mkdirSync(ws, { recursive: true })
    const { call } = world({ workdir: ws })
    const { result, nextCalls } = await call('edit', {}, async () => ({ isError: false, value: { builtin: true } }))
    assert.equal(nextCalls, 1)
    assert.equal(result.isError, false)
    assert.equal(batches(ws).length, 0)
    ok('a call without file_path is passed through and not recorded')
  }

  rmSync(BASE, { recursive: true, force: true })
  console.log(`\n${passed} write-ledger groups passed`)
}

await main()
