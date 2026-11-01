import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const run = promisify(execFile)
const corpus = path.resolve(process.env.BENCH_CORPUS ?? process.cwd())
const { indexerGlobSearch, indexerGrepSearch, resetIndexer } = await import('../lib/indexer-client.js')

const rg = process.env.DSH_FORGE_RG ?? 'rg'
const exclude = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']
const rgArgs = (...args) => ['--no-config', '--no-ignore', '--hidden', ...exclude.flatMap(name => [`--glob=!**/${name}`, `--glob=!**/${name}/**`]), ...args]
const rgGrepArgs = (...args) => ['--no-config', '--hidden', ...exclude.flatMap(name => [`--glob=!**/${name}`, `--glob=!**/${name}/**`]), ...args]
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const ms = async fn => { const start = performance.now(); const value = await fn(); return { value, elapsed: performance.now() - start } }

async function builtinGlob(pattern) {
  const result = await run(rg, rgArgs('--files', `--glob=${pattern}`, '--sort=modified'), { cwd: corpus, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  return result.stdout.split(/\r?\n/).filter(Boolean).slice(0, 100)
}

async function builtinGrep(pattern) {
  let stdout = ''
  try {
    ({ stdout } = await run(rg, rgGrepArgs('--json', pattern), { cwd: corpus, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }))
  } catch (error) {
    if (error.code !== 1) throw error
    stdout = error.stdout
  }
  return stdout.split(/\r?\n/).filter(Boolean).flatMap(line => {
    const event = JSON.parse(line)
    if (event.type !== 'match') return []
    return [{
      path: event.data.path.text,
      lineNumber: event.data.line_number,
      line: event.data.lines.text.replace(/\r?\n$/, '').replace(/\r$/, ''),
    }]
  }).sort((a, b) => a.path.localeCompare(b.path) || a.lineNumber - b.lineNumber).slice(0, 250)
}

function compareResults(left, right) {
  const normalize = value => typeof value === 'string'
    ? value.replaceAll('\\', '/')
    : { ...value, path: value.path.replaceAll('\\', '/') }
  return JSON.stringify(left.map(normalize)) === JSON.stringify(right.map(normalize))
}

async function sample(label, builtin, native, query) {
  const b = [], n = [], results = []
  for (let i = 0; i < 5; i++) {
    const calls = i % 2 === 0
      ? [() => ms(() => builtin(query)), () => ms(() => native(query))]
      : [() => ms(() => native(query)), () => ms(() => builtin(query))]
    const [first, second] = await Promise.all(calls.map(call => call()))
    const built = i % 2 === 0 ? first : second
    const fast = i % 2 === 0 ? second : first
    b.push(built.elapsed); n.push(fast.elapsed)
    results.push(compareResults(built.value, fast.value))
  }
  const bm = median(b), nm = median(n)
  console.log(`${label}\tbuiltin=${bm.toFixed(1)}ms\tnative=${nm.toFixed(1)}ms\tspeedup=${(bm / nm).toFixed(2)}x\tresult=${results.every(Boolean) ? 'same' : 'different'}`)
}

console.log(`corpus=${corpus}`)
await resetIndexer()
const coldGlob = await ms(() => indexerGlobSearch(corpus, corpus, '*.ts'))
await resetIndexer()
const coldGrep = await ms(() => indexerGrepSearch(corpus, corpus, 'TODO'))
console.log(`cold native (sidecar start included)\tglob=${coldGlob.elapsed.toFixed(1)}ms\tgrep=${coldGrep.elapsed.toFixed(1)}ms`)
await sample('glob *.ts warm', builtinGlob, pattern => indexerGlobSearch(corpus, corpus, pattern), '*.ts')
await sample('grep TODO warm', builtinGrep, pattern => indexerGrepSearch(corpus, corpus, pattern), 'TODO')
await resetIndexer()
