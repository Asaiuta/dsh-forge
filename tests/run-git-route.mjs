// Route-level contracts for /forge-git: method gate, missing capability,
// workspace validation, and the escape refusal reaching HTTP as 400.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { Readable } from 'node:stream'
import { createGitHandler } from '../src/http-plugin.ts'

let count = 0
async function test(name, run) { await run(); console.log(`ok ${++count} - ${name}`) }

/** A subprocess stand-in that really runs git, mirroring the host service shape. */
const realService = {
  spawn(spec) {
    return new Promise(resolve => {
      // The service returns a handle synchronously; this stand-in resolves output eagerly into the shape the adapter reads.
      const child = execFile('git', spec.argv.slice(1), { cwd: spec.cwd ?? process.cwd(), maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout, stderr) => resolve({ exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' }))
      void child
    })
  },
}
// The adapter calls spawn synchronously and awaits `.done`; adapt the promise into that shape.
const asyncService = {
  spawn(spec) {
    const done = realService.spawn(spec)
    const buffers = { stdout: '', stderr: '' }
    void done.then(r => { buffers.stdout = r.stdout; buffers.stderr = r.stderr })
    return {
      done: done.then(r => ({ exitCode: r.exitCode })),
      collected: {
        stdout: { readFrom: () => ({ text: buffers.stdout, lossy: false }) },
        stderr: { readFrom: () => ({ text: buffers.stderr, lossy: false }) },
      },
    }
  },
}

function request(url, method = 'GET') {
  const req = Readable.from([])
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:20014', origin: 'http://127.0.0.1:20014' }
  req.socket = { localAddress: '127.0.0.1', localPort: 20014 }
  return req
}
async function call(handler, url, method = 'GET') {
  const out = {}
  await handler(request(url, method), { writeHead(status) { out.status = status }, end(value) { out.body = JSON.parse(value) } })
  return out
}

const here = process.cwd()
const withService = createGitHandler(() => asyncService)

await test('read-only route answers a real repository with branch and changes', async () => {
  const out = await call(withService, `/forge-git?workspace=${encodeURIComponent(here)}`)
  assert.equal(out.status, 200)
  assert.equal(out.body.ok, true)
  assert.equal(out.body.repo.isRepo, true)
  assert.ok(out.body.repo.branch.head)
  assert.ok(Array.isArray(out.body.repo.changes))
})

await test('a directory outside any repository answers isRepo false, not an error', async () => {
  const driveRoot = here.slice(0, 3)
  const out = await call(withService, `/forge-git?workspace=${encodeURIComponent(driveRoot)}`)
  assert.equal(out.status, 200)
  assert.deepEqual(out.body.repo, { isRepo: false })
})

await test('mutations are refused with 405 — the route has no write surface', async () => {
  const out = await call(withService, `/forge-git?workspace=${encodeURIComponent(here)}`, 'POST')
  assert.equal(out.status, 405)
  assert.match(out.body.error, /只读/)
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const each = await call(withService, `/forge-git?workspace=${encodeURIComponent(here)}`, method)
    assert.equal(each.status, 405, `${method} must be refused`)
  }
})

await test('a host without a subprocess capability answers 503 instead of spawning outside the sandbox', async () => {
  const out = await call(createGitHandler(() => undefined), `/forge-git?workspace=${encodeURIComponent(here)}`)
  assert.equal(out.status, 503)
  assert.match(out.body.error, /子进程/)
})

await test('relative workspace and escaping file paths are rejected before any read', async () => {
  const relative = await call(withService, '/forge-git?workspace=not%2Fabsolute')
  assert.equal(relative.status, 400)
  const escape = await call(withService, `/forge-git?workspace=${encodeURIComponent(here)}&file=${encodeURIComponent('../outside.ts')}`)
  assert.equal(escape.status, 400)
  assert.match(escape.body.error, /超出仓库根目录/)
  const dotgit = await call(withService, `/forge-git?workspace=${encodeURIComponent(here)}&file=${encodeURIComponent('.git/config')}`)
  assert.equal(dotgit.status, 400)
  assert.match(dotgit.body.error, /\.git/)
  const empty = await call(withService, `/forge-git?workspace=${encodeURIComponent(here)}&file=`)
  assert.equal(empty.status, 400)
})

await test('a real file diff returns both text sides', async () => {
  const status = await call(withService, `/forge-git?workspace=${encodeURIComponent(here)}`)
  const candidate = [...status.body.repo.staged, ...status.body.repo.changes].find(e => e.status !== 'D' && !e.binary)
  if (candidate === undefined) { console.log('   (working tree clean: diff covered by the unit contract)'); return }
  const out = await call(withService, `/forge-git?workspace=${encodeURIComponent(here)}&file=${encodeURIComponent(candidate.path)}`)
  assert.equal(out.status, 200)
  assert.equal(out.body.diff.path, candidate.path)
  assert.equal(typeof out.body.diff.after.text === 'string' || out.body.diff.after.binary, true)
})

console.log(`git-route: ${count} checks passed; 0 failed`)
