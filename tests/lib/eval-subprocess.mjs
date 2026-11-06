/** Local test adapter only. Production uses the calling DSH subprocess service. */
import { spawn } from 'node:child_process'
export function testSubprocess() {
  let launches = 0
  return { get launches() { return launches }, spawn(spec) {
    launches++
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const values = { stdout: { bytes: Buffer.alloc(0), lossy: false }, stderr: { bytes: Buffer.alloc(0), lossy: false } }
    for (const key of ['stdout', 'stderr']) child[key].on('data', b => {
      const state = values[key], cap = spec.stdio[key].maxBytes
      state.bytes = Buffer.concat([state.bytes, b]); if (state.bytes.length > cap) { state.lossy = true; state.bytes = state.bytes.subarray(-cap) }
    })
    const abort = () => child.kill('SIGKILL')
    spec.signal?.addEventListener('abort', abort, { once: true })
    child.stdin.on('error', () => {}); child.stdin.end(spec.stdio.stdin.data)
    const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (exitCode, signal) => resolve({ exitCode, signal })) }).finally(() => spec.signal?.removeEventListener('abort', abort))
    return { done, waitForExit: () => done.catch(() => {}), collected: Object.fromEntries(['stdout', 'stderr'].map(k => [k, { readFrom: () => ({ text: values[k].bytes.toString('utf8'), lossy: values[k].lossy }) }])) }
  } }
}
