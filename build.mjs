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
  entryPoints: ['src/index.ts', 'src/http-plugin.ts', 'src/config-api.ts', 'src/core.ts', 'src/tools.ts', 'src/absence.ts', 'src/overlay.ts', 'src/delegate.ts', 'src/tools-symbol.ts', 'src/ast.ts', 'src/edit-engine.ts', 'src/ledger.ts', 'src/tickets.ts', 'src/tools-edit.ts', 'src/history.ts', 'src/tools-files.ts', 'src/tools-read.ts', 'src/facts.ts', 'src/trace-facts.ts', 'src/decls.ts', 'src/linkgraph.ts', 'src/tools-trace.ts', 'src/edit-audit.ts', 'src/tools-cards.ts', 'src/cards.ts', 'src/distill.ts', 'src/ast-worker.ts', 'src/ast-pool.ts', 'src/indexer-client.ts', 'src/config.ts', 'src/registration.ts', 'src/guidance.ts', 'src/trace-capabilities.ts', 'src/source-evidence.ts', 'src/trace-snapshot.ts', 'src/trace-rows.ts', 'src/trace-capture.ts', 'src/bridge-check.ts', 'src/bridge-scan.ts', 'src/tools-check.ts', 'src/check-host.ts', 'src/check-plan.ts', 'src/verification.ts', 'src/tap.ts', 'src/types-check.ts'],
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

// ---------------------------------------------------------------------------
// Browser half: the settings page.
//
// The shell loads a client bundle through `window.__ModuleLoader__`, so it is
// emitted as CJS wrapped in a `load({ id, factory })` call — the same shape the
// shipped bundles carry. `react`, its jsx runtimes and the ui primitives stay
// external because the shell supplies them from its frozen platform table; a
// bundle that inlined its own React would render into a different dispatcher
// than the page it lives in.
//
// `src/client` is excluded from tsconfig.json on purpose: react and the
// primitives are not installable here (they ship inside the app), so a local
// stub would only confirm the stub. esbuild catches the mechanical errors and
// the assertions below catch the contract ones.
// ---------------------------------------------------------------------------
const CLIENT_ID = 'dsh-forge'

const platformExternal = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'scheduler',
  '@deepseek-ai/dsh-client-*',
  '@deepseek-ai/cordis',
]

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  sourcemap: true,
  // The comment header the shipped bundles carry; the loader keys modules by
  // `id`, and other bundles reach this one by that same id.
  banner: {
    js: `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(CLIENT_ID)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
  },
  footer: { js: '\t\treturn module.exports;\n\t}\n});' },
  external: platformExternal,
  logLevel: 'info',
})

// ---------------------------------------------------------------------------
// Browser-half contract gate.
//
// Four failures are silent at runtime and expensive to diagnose from a
// screenshot, so they are asserted here instead: a missing slot registration
// (page never appears), a wrong row key (it appears on no plane at all), a route
// typo (the page renders "读取中…" forever while the host is healthy), and a
// `node:` import (throws at module evaluation inside the shell, before `apply`).
// ---------------------------------------------------------------------------
const clientBundle = readFileSync('lib/client.js', 'utf8')
for (const marker of [
  '__ModuleLoader__',
  'settings.section',
  'plugins.row.config',
  'dsh-forge#dsh-forge',
  '/forge-config',
]) {
  if (!clientBundle.includes(marker)) {
    throw new Error(`lib/client.js is missing ${JSON.stringify(marker)} — the settings page cannot mount`)
  }
}
if (/require\("node:/.test(clientBundle)) {
  throw new Error('lib/client.js imports a node: builtin — the browser half must stay DOM-only')
}
// `require("react")` is expected (that is what "external" means: the shell's
// loader supplies it). *Inlined* React is the failure — it would carry its own
// dispatcher and render into a different one than the page it lives in.
if (clientBundle.includes('ReactCurrentDispatcher') || clientBundle.includes('Symbol.for("react.element")')) {
  throw new Error('lib/client.js inlines react — the shell must supply it from its platform table')
}
if (!clientBundle.includes('require("react/jsx-runtime")')) {
  throw new Error('lib/client.js does not resolve react/jsx-runtime through the shell loader')
}

const written = new Set(Object.keys(result.metafile.outputs).map((p) => p.replace(/\\/g, '/').replace(/^lib\//, '')))
let pruned = 0
let stale = 0
for (const name of readdirSync('lib')) {
  if (/^chunk-[A-Z0-9]+\.js(?:\.map)?$/.test(name)) {
    if (!written.has(name)) { unlinkSync(join('lib', name)); pruned++ }
    continue
  }
  if (!name.endsWith('.js')) continue
  // The browser half has no `src/client.ts` to compare against — its source is
  // `src/client/index.tsx`. Without this guard the stale-entry sweep deletes the
  // page it was just written, and the failure surfaces as a plugin whose row
  // simply has no Configure button.
  if (name === 'client.js') continue
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
