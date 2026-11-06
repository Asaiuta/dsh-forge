// Standalone worker. Loaded in a fresh host-managed Node process for each call.
const fs = require('node:fs')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const request = JSON.parse(fs.readFileSync(0, 'utf8'))
const write = process.stdout.write.bind(process.stdout)
const digest = () => crypto.createHash('sha256').update(fs.readFileSync(request.file)).digest('hex')
let count = 0
function encode(value, stack = new Set(), depth = 0) {
  if (++count > 50000 || depth > 100) throw new Error('result exceeds structural limit')
  if (value === null) return { type: 'null' }
  const type = typeof value
  if (['string', 'boolean'].includes(type)) return { type, value }
  if (type === 'number') return { type, value: Number.isFinite(value) && !Object.is(value, -0) ? value : String(Object.is(value, -0) ? '-0' : value) }
  if (type === 'bigint') return { type, value: String(value) }
  if (type === 'undefined') return { type }
  if (type !== 'object') throw new Error(`unsupported result type: ${type}`)
  if (stack.has(value)) throw new Error('cyclic result')
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('result requires a plain object or array')
  if (Object.getOwnPropertySymbols(value).length) throw new Error('symbol-keyed result is unsupported')
  stack.add(value)
  let encoded
  if (Array.isArray(value)) {
    const keys = Object.keys(value)
    if (keys.some(k => !/^(0|[1-9]\d*)$/.test(k) || Number(k) >= value.length)) throw new Error('array properties are unsupported')
    if (value.length > 50000) throw new Error('array exceeds structural limit')
    encoded = { type: 'array', items: Array.from({ length: value.length }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(value, String(i))
      if (!d) return { type: 'hole' }
      if (!('value' in d)) throw new Error('accessor result is unsupported')
      return encode(d.value, stack, depth + 1)
    }) }
  } else {
    encoded = { type: 'object', entries: Object.getOwnPropertyNames(value).map(k => {
      const d = Object.getOwnPropertyDescriptor(value, k)
      if (!('value' in d)) throw new Error('accessor result is unsupported')
      return [k, encode(d.value, stack, depth + 1)]
    }) }
  }
  stack.delete(value)
  return encoded
}
async function run() {
  if (digest() !== request.snapshot) throw new Error('source changed before import')
  const mod = await import(pathToFileURL(request.file).href)
  const pieces = request.symbol.split('.')
  function resolve(root) {
    let owner = root, value = root
    for (const piece of pieces) {
      owner = value
      const d = value != null && Object.getOwnPropertyDescriptor(value, piece)
      if (!d || !('value' in d)) return null
      value = d.value
    }
    return typeof value === 'function' ? { owner, value } : null
  }
  const target = resolve(mod) || (mod.default && resolve(mod.default)) || (typeof mod.default === 'function' && mod.default.name === request.symbol ? { owner: undefined, value: mod.default } : null)
  if (!target) throw new Error('symbol is not an exported callable; instance/local functions require an explicit exported wrapper')
  const printed = Function.prototype.toString.call(target.value).replace(/\r\n?/g, '\n').trim()
  if (!request.declaration.includes(printed)) throw new Error('runtime export does not match the selected source declaration')
  let args = request.args
  if (request.setup !== undefined) {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    args = await new AsyncFunction(request.setup)()
    if (!Array.isArray(args)) throw new Error('setup must return an argument array')
  }
  const result = await Reflect.apply(target.value, target.owner, args)
  if (digest() !== request.snapshot) throw new Error('source changed during execution')
  let value
  try { value = encode(result) } catch (e) { return { status: 'unserializable', message: String(e.message) } }
  const output = { status: 'returned', value }
  if (Buffer.byteLength(JSON.stringify(output)) > 1024 * 1024) return { status: 'unserializable', message: 'result exceeds 1 MiB' }
  return output
}
run().catch(e => ({ status: 'threw', message: String(e?.stack || e).slice(0, 65536) })).then(value => {
  write(`\n${request.marker}${JSON.stringify({ ...value, runtime: process.version })}\n`)
})
