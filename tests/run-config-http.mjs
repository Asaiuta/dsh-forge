/**
 * The settings page's host half, mounted through the real cordis fork.
 *
 * The fake-ctx probes elsewhere in this suite prove the pure functions; they
 * cannot catch the two failures that only appear on a real context:
 *
 *  1. `inject` is a sibling export, not part of `apply`. Mounting `apply` alone
 *     drops it, and a service then reads as missing even though it was provided.
 *  2. `ctx.webServer` goes through the context proxy. A service that is neither
 *     injected nor provided throws on the property read instead of yielding
 *     `undefined`, so the route would never register and nothing would say why.
 *
 * Both are covered by mounting the module namespace (`{ name, inject, apply }`)
 * against a real `Context` with both services provided, then calling the handler
 * the way the web server does.
 */

import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Context } = require('@deepseek-ai/cordis')
const module = await import(new URL('../lib/http-plugin.js', import.meta.url).href)

let passed = 0
function ok(label) {
  passed++
  console.log(`  ok ${passed} - ${label}`)
}

/** A request the handler can `for await` over, with a method on it. */
function request(method, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  return stream
}

/** A response that records what the handler wrote. */
function reply() {
  const seen = { status: 0, headers: null, body: '' }
  return {
    seen,
    res: {
      writeHead(status, headers) {
        seen.status = status
        seen.headers = headers
      },
      end(body) {
        seen.body = body ?? ''
      },
    },
  }
}

const routes = []
const edits = []
let currentConfig = { registration: 'additive', takeover: [], prewarm: true }
let rows = [{ options: { id: 'dsh-forge', name: 'dsh-forge', config: currentConfig } }]

const ctx = new Context()
ctx.provide('webServer', {
  register(route) {
    routes.push(route)
    return () => {}
  },
})
ctx.provide('configEditor', {
  entries: () => rows,
  async edit(entry, change) {
    const written = change(entry.options.config, {})
    edits.push(written)
    currentConfig = written
    rows = [{ options: { id: 'dsh-forge', name: 'dsh-forge', config: written } }]
  },
})

ctx.plugin({ name: module.name, inject: module.inject, apply: module.apply })
await new Promise((resolve) => setImmediate(resolve))

assert.equal(routes.length, 1, `expected one route, got ${routes.length}`)
assert.equal(routes[0].path, '/forge-config')
assert.equal(routes[0].kind, 'exact')
ok('the route is registered on the host web server')

const handler = routes[0].handler

// --- GET ------------------------------------------------------------------
{
  const { seen, res } = reply()
  await handler(request('GET'), res)
  assert.equal(seen.status, 200, seen.body)
  assert.deepEqual(JSON.parse(seen.body).state, { registration: 'additive', takeover: [], prewarm: true })
  ok('GET answers the row’s own values')
}

// --- POST: a legal save reaches configEditor.edit --------------------------
{
  const { seen, res } = reply()
  await handler(request('POST', { registration: 'takeover', takeover: ['glob', 'read'], prewarm: false }), res)
  assert.equal(seen.status, 200, seen.body)
  assert.equal(edits.length, 1, 'the save must go through configEditor.edit')
  assert.deepEqual(edits[0], { registration: 'takeover', takeover: ['glob', 'read'], prewarm: false })
  assert.deepEqual(JSON.parse(seen.body).state, { registration: 'takeover', takeover: ['glob', 'read'], prewarm: false })
  ok('POST persists through the editor and echoes what it wrote')
}

// --- POST: a rejected value is the user's to fix, not a server fault -------
{
  const { seen, res } = reply()
  await handler(request('POST', { registration: 'takeover', takeover: [], prewarm: true }), res)
  assert.equal(seen.status, 400, seen.body)
  assert.match(JSON.parse(seen.body).error, /至少/)
  assert.equal(edits.length, 1, 'a refused body must not reach the editor')
  ok('an empty takeover selection is refused with 400')
}

// --- POST: a missing row is named, not swallowed ---------------------------
{
  const saved = rows
  rows = []
  const { seen, res } = reply()
  await handler(request('POST', { registration: 'additive', takeover: [], prewarm: true }), res)
  assert.equal(seen.status, 400, seen.body)
  assert.match(JSON.parse(seen.body).error, /dsh-forge/)
  rows = saved
  ok('a profile without the row reports which id is missing')
}

// --- POST: an editor failure is a 500, not a bad request -------------------
{
  const saved = ctx.get('configEditor')
  ctx.set('configEditor', {
    entries: () => rows,
    async edit() {
      throw new Error('profile patch is locked')
    },
  })
  const { seen, res } = reply()
  await handler(request('POST', { registration: 'additive', takeover: [], prewarm: true }), res)
  assert.equal(seen.status, 500, seen.body)
  assert.match(JSON.parse(seen.body).error, /locked/)
  ctx.set('configEditor', saved)
  ok('a failed write surfaces as 500 with the host’s message')
}

// --- anything but GET/POST -------------------------------------------------
{
  const { seen, res } = reply()
  await handler(request('DELETE'), res)
  assert.equal(seen.status, 405)
  ok('other methods are refused with 405')
}

console.log(`\n${passed} checks passed`)
