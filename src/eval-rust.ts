/** Existing Cargo tests only. Discover artifacts, then select one exact libtest name. */
import path from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import type { ForgeExec } from './core.ts'
import type { EvalProcesses } from './eval-process.ts'

export async function evalRust(processes: EvalProcesses, file: string, symbol: string, runtime: string, root: string, exec: ForgeExec | undefined, signal: AbortSignal, targetName?: string) {
  let directory = path.dirname(file)
  while (!existsSync(path.join(directory, 'Cargo.toml'))) {
    if (directory === root || path.dirname(directory) === directory) throw new Error('no Cargo.toml inside workspace')
    directory = path.dirname(directory)
  }
  await exec?.authorizeNativePaths?.([path.join(directory, 'Cargo.toml')])
  const manifest = path.join(directory, 'Cargo.toml')
  const metadata = await processes.run([runtime, 'metadata', '--offline', '--no-deps', '--format-version', '1', '--manifest-path', manifest], root, '', exec, signal)
  if (metadata.exitCode !== 0 || metadata.stdoutLossy) return { status: 'build_failed', phase: 'metadata', ...metadata }
  const packages = JSON.parse(metadata.stdout).packages as Array<{ id: string; manifest_path: string; targets: Array<{ name: string; src_path: string }> }>
  const belongs = (base: string, candidate: string) => { const relative = path.relative(base, candidate); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) }
  const candidates = packages.filter(p => belongs(path.dirname(p.manifest_path), file)).sort((a, b) => b.manifest_path.length - a.manifest_path.length)
  const pkg = candidates[0]
  if (!pkg) throw new Error('source does not belong to a Cargo package')
  const build = await processes.run([runtime, 'test', '--offline', '--no-run', '--message-format=json', '--manifest-path', manifest, '-p', pkg.id], root, '', exec, signal)
  if (build.exitCode !== 0 || build.stdoutLossy) return { status: 'build_failed', phase: 'build', ...build }
  const choices: Array<{ executable: string; test: string; target: string }> = []
  const discovery: unknown[] = []
  let discoveryBytes = 0
  for (const row of build.stdout.split(/\r?\n/).filter(Boolean)) {
    let artifact
    try { artifact = JSON.parse(row) } catch { continue }
    if (artifact.reason !== 'compiler-artifact' || !artifact.executable || !artifact.profile?.test || artifact.package_id !== pkg.id) continue
    if (targetName && artifact.target?.name !== targetName) continue
    if (discovery.length >= 16) return { status: 'not_executed', message: 'more than 16 candidate test artifacts; narrow testTarget', build, discovery }
    const src = realpathSync(artifact.target.src_path)
    if (!belongs(path.dirname(src), file)) continue
    const relative = file === src ? '' : path.relative(path.dirname(src), file).replace(/\.rs$/, '').replace(/[\\/]/g, '::').replace(/(^|::)mod$/, '')
    const name = [relative, symbol.replace(/\./g, '::')].filter(Boolean).join('::')
    await exec?.authorizeNativePaths?.([artifact.executable])
    const listed = await processes.run([artifact.executable, '--list', '--format', 'terse'], root, '', exec, signal)
    discovery.push({ target: artifact.target.name, ...listed })
    discoveryBytes += Buffer.byteLength(JSON.stringify(listed))
    if (discoveryBytes > 2 * 1024 * 1024) return { status: 'not_executed', message: 'test discovery exceeds 2 MiB; narrow testTarget', build, discovery }
    if (listed.exitCode === 0 && !listed.stdoutLossy && listed.stdout.split(/\r?\n/).includes(`${name}: test`)) choices.push({ executable: artifact.executable, test: name, target: artifact.target.name })
  }
  if (choices.length !== 1) return { status: 'not_executed', message: choices.length ? 'test is present in multiple targets; specify testTarget' : 'no exact existing test for this source symbol; custom #[path], include!, and generated tests need a standard wrapper', build, discovery }
  const chosen = choices[0]
  const result = await processes.run([chosen.executable, chosen.test, '--exact', '--nocapture', '--test-threads=1'], root, '', exec, signal)
  const summaries = [...result.stdout.matchAll(/^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/gm)]
  const last = summaries.at(-1)
  const passed = result.exitCode === 0 && !result.stdoutLossy && summaries.length === 1 && last?.[1] === 'ok' && last[2] === '1' && last[3] === '0' && last[4] === '0'
  const status = passed ? 'passed' : result.exitCode !== 0 ? 'failed' : 'not_executed'
  return { status, test: chosen.test, target: chosen.target, executable: chosen.executable, result, build, discovery }
}
