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
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

mkdirSync('lib', { recursive: true })
// Remove only generated shared chunks, so packages never accumulate old code.
for (const name of readdirSync('lib')) {
  if (/^chunk-[A-Z0-9]+\.js(?:\.map)?$/.test(name)) unlinkSync(join('lib', name))
}

await build({
  entryPoints: ['src/index.ts', 'src/core.ts', 'src/tools.ts', 'src/tools-symbol.ts', 'src/ast.ts', 'src/edit-engine.ts', 'src/ledger.ts', 'src/tickets.ts', 'src/tools-edit.ts', 'src/projects.ts', 'src/tools-project.ts', 'src/history.ts', 'src/tools-history.ts', 'src/tools-files.ts', 'src/tools-read.ts', 'src/facts.ts', 'src/decls.ts', 'src/linkgraph.ts', 'src/tools-trace.ts', 'src/ast-worker.ts', 'src/ast-pool.ts'],
  outdir: 'lib',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  external: ['@deepseek-ai/*', '@ff-labs/*', 'ffi-rs', 'web-tree-sitter'],
  logLevel: 'info',
})

// The package exports `types` entries under lib/types/*.d.ts; esbuild cannot
// emit declarations, so run tsc's declaration-only pass after bundling.
const tsc = spawn(process.execPath, [
  join('node_modules', 'typescript', 'bin', 'tsc'),
  '-p', 'tsconfig.json',
  '--emitDeclarationOnly',
], { stdio: 'inherit' })
tsc.on('exit', (code) => {
  if (code !== 0) {
    console.error(`declaration emit failed (exit ${code})`)
    process.exitCode = code ?? 1
  }
})
