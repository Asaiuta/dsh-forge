/** Optional local sidecar install. The portable npm package uses WASM by default. */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const configuredCargo = process.env.CARGO_HOME ? path.join(process.env.CARGO_HOME, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo') : undefined
const cargo = configuredCargo && existsSync(configuredCargo) ? configuredCargo : 'cargo'
const version = spawnSync(cargo, ['-vV'], { cwd: root, encoding: 'utf8', windowsHide: true })
if (version.error) throw version.error
if (version.status !== 0) throw new Error(`cargo -vV failed: ${version.stderr}`)
const host = /^host:\s*(\S+)\s*$/m.exec(version.stdout)?.[1]
if (!host) throw new Error('Cargo did not report its host target')
// This installs a helper for the current machine, even when a user's Cargo
// config/environment defaults to cross-compiling another target.
const cargoArgs = ['build', '--locked', '--release', '--target', host, '--message-format=json-render-diagnostics', '--manifest-path', path.join(root, 'rust_indexer', 'Cargo.toml')]
const result = spawnSync(cargo, cargoArgs, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
const name = process.platform === 'win32' ? 'dsh_forge_indexer.exe' : 'dsh_forge_indexer'
const messages = result.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
const executable = messages.find(message => message.reason === 'compiler-artifact' && message.target?.name === 'dsh_forge_indexer' && message.target.kind.includes('bin') && typeof message.executable === 'string')?.executable
if (!executable) throw new Error('Cargo did not report a sidecar executable; nothing was installed')
const installDir = path.join(root, 'rust_indexer', 'bin')
mkdirSync(installDir, { recursive: true })
copyFileSync(executable, path.join(installDir, name))
console.log(`Installed optional sidecar: ${path.join(installDir, name)}`)
