import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
function expand(script) {
  return script.split(' && ').flatMap(command => {
    const nested = /^(?:pnpm|npm) run ([\w:-]+)$/.exec(command)
    if (!nested) return [command]
    if (!pkg.scripts[nested[1]]) throw new Error(`missing script: ${nested[1]}`)
    return expand(pkg.scripts[nested[1]])
  })
}
const commands = expand(pkg.scripts.test)
const results = []
for (const command of commands) {
  const [program, ...args] = command.split(' ')
  if (program !== 'node') throw new Error(`unsupported test command: ${command}`)
  console.log(`\n[SUITE START] ${command}`)
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', timeout: 120000 })
  results.push({ command, status: result.status, signal: result.signal, error: result.error?.message })
  console.log(`[SUITE END] exit=${result.status} ${command}`)
}
const failed = results.filter(result => result.status !== 0)
const report = { passed: results.length - failed.length, failed: failed.length, suites: results }
writeFileSync(new URL('../.dsh/forge-regression-results.json', import.meta.url), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ passed: report.passed, failed: report.failed, failures: failed }, null, 2))
process.exitCode = failed.length ? 1 : 0
