/**
 * ESM host build for dsh-forge.
 *
 * Same shape as dsh-blackhole's build: plain ESM bundle for the Node host,
 * externalizing the @deepseek-ai/dsh-* profile packages (the profile's
 * node_modules provides them at load time). @ff-labs/fff-node stays external
 * too — it loads the libfff_c native library and the ffi-rs NAPI addon at
 * runtime from node_modules, neither of which can be bundled.
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

mkdirSync('lib', { recursive: true })

// Chunks are pruned AFTER the build, against esbuild's own output list. Deleting
// every chunk up front looks equivalent but is not: a delete loop is a pile of
// filesystem operations that can be interrupted (sandbox delete guards, locked
// files) — and an interrupted cleanup leaves lib/ half-stripped, so an entry
// points at a chunk that no longer exists. Pruning against the metafile touches
// only genuinely stale chunks, which is normally zero to a handful.
const result = await build({
  // `src/absence.ts` is an entry (not just an import of tools.ts) so the
  // empty-page diagnosis can be unit-tested against a synthetic `canList`
  // without standing up the native finder. `src/overlay.ts` is an entry for the
  // same reason: its TTL and matching rules have to be testable without a
  // finder, and they are the part that can silently disagree with the engine.
  entryPoints: ['src/index.ts', 'src/core.ts', 'src/tools.ts', 'src/absence.ts', 'src/overlay.ts', 'src/delegate.ts', 'src/tools-symbol.ts', 'src/ast.ts', 'src/edit-engine.ts', 'src/ledger.ts', 'src/tickets.ts', 'src/tools-edit.ts', 'src/history.ts', 'src/tools-files.ts', 'src/tools-read.ts', 'src/facts.ts', 'src/trace-facts.ts', 'src/decls.ts', 'src/linkgraph.ts', 'src/tools-trace.ts', 'src/tools-cards.ts', 'src/cards.ts', 'src/distill.ts', 'src/ast-worker.ts', 'src/ast-pool.ts', 'src/indexer-client.ts', 'src/config.ts', 'src/registration.ts', 'src/guidance.ts'],
  outdir: 'lib',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  external: ['@deepseek-ai/*', '@ff-labs/*', 'ffi-rs', 'web-tree-sitter'],
  logLevel: 'info',
  metafile: true,
})

// Prune chunks the build did not write (content hashes change when the graph
// does), then drop entry outputs whose source is gone, then assert every chunk
// reference resolves so a broken build fails here instead of as
// ERR_MODULE_NOT_FOUND at first import.
const written = new Set(Object.keys(result.metafile.outputs).map((p) => p.replace(/\\/g, '/').replace(/^lib\//, '')))
let pruned = 0
let stale = 0
for (const name of readdirSync('lib')) {
  if (/^chunk-[A-Z0-9]+\.js(?:\.map)?$/.test(name)) {
    if (!written.has(name)) { unlinkSync(join('lib', name)); pruned++ }
    continue
  }
  if (!name.endsWith('.js')) continue
  if (existsSync(join('src', `${name.slice(0, -3)}.ts`))) continue
  unlinkSync(join('lib', name))
  if (existsSync(join('lib', `${name}.map`))) unlinkSync(join('lib', `${name}.map`))
  stale++
}
let dangling = 0
for (const name of readdirSync('lib')) {
  if (!name.endsWith('.js')) continue
  const text = readFileSync(join('lib', name), 'utf8')
  for (const match of text.matchAll(/["']\.\/(chunk-[A-Z0-9]+\.js)["']/g)) {
    if (existsSync(join('lib', match[1]))) continue
    console.error(`dangling chunk reference: ${name} -> ${match[1]}`)
    dangling++
  }
}
if (dangling > 0) {
  console.error(`build produced ${dangling} dangling chunk reference(s)`)
  process.exitCode = 1
} else if (pruned > 0 || stale > 0) {
  console.log(`pruned ${pruned} stale chunk(s), removed ${stale} stale entry output(s)`)
}

// The package exports `types` entries under lib/types/*.d.ts; esbuild cannot
// emit declarations, so run tsc's declaration-only pass after bundling.
// `tsc` leaves declarations behind when a source module is deleted. Prune
// those only after a successful emit, leaving cleanup skipped on compilation failure.
function pruneDeclarations(dir, sourceDir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) { pruneDeclarations(file, join(sourceDir, entry.name)); continue }
    if (!entry.isFile() || !entry.name.endsWith('.d.ts')) continue
    if (!existsSync(join(sourceDir, entry.name.slice(0, -5) + '.ts'))) unlinkSync(file)
  }
}
const tsc = spawn(process.execPath, [
  join('node_modules', 'typescript', 'bin', 'tsc'),
  '-p', 'tsconfig.json',
  '--emitDeclarationOnly',
], { stdio: 'inherit' })
tsc.on('exit', (code) => {
  if (code !== 0) {
    console.error(`declaration emit failed (exit ${code})`)
    process.exitCode = code ?? 1
  } else pruneDeclarations('lib/types', 'src')
})
