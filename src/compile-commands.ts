/** Read compilation metadata as data. Never run a compiler, shell or response file. */
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { canonicalTarget, readBoundedFile, within } from './fs-paths.ts'

export interface CompilationInfo {
  status: 'ok' | 'failed'
  path: string
  entries: number
  unsupported: number
  message?: string
}
export type IncludeResolver = (from: string, spec: string, mode: 'quote' | 'system' | 'dynamic', isFile: (rel: string) => boolean) => string[] | null
interface IncludeConfig { quote: string[]; include: string[]; system: string[]; supported: boolean }
export interface CompilationDatabase {
  signature: string
  info?: CompilationInfo
  resolve?: IncludeResolver
  valid: () => boolean
}

const CACHE = new Map<string, { digest: string; configs: Map<string, IncludeConfig[]>; info: CompilationInfo }>()
const BYTE_CAP = 8 * 1024 * 1024
const ENTRY_CAP = 20_000
export function resetCompilationCache(): void { CACHE.clear() }

const pathKey = (value: string): string => {
  const clean = value.replaceAll('\\', '/')
  return process.platform === 'win32' ? clean.toLowerCase() : clean
}

/** Conservative native-platform command tokenizer. Unsupported shell syntax
 *  stays unsupported; structured arguments is preferred and has no quoting loss. */
function commandArgs(command: string): string[] | null {
  const windows = process.platform === 'win32'
  const args: string[] = []
  let token = '', quote = '', active = false
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (char === '\0' || char === '\n' || char === '\r' || char === '$' || char === '`' || windows && (char === '%' || char === '^')) return null
    if (!quote && /[;&|<>]/.test(char)) return null
    if (windows && char === '\\') {
      let end = i
      while (command[end] === '\\') end++
      const count = end - i
      if (command[end] === '"') {
        token += '\\'.repeat(Math.floor(count / 2))
        if (count % 2) token += '"'
        else quote = quote ? '' : '"'
        i = end
      } else { token += '\\'.repeat(count); i = end - 1 }
      active = true
    } else if (!windows && char === '\\' && quote !== "'") {
      const next = command[++i]
      if (next === undefined || next === '\n' || next === '\r') return null
      token += quote === '"' && !['\\', '"', '$', '`'].includes(next) ? '\\' + next : next
      active = true
    } else if (char === '"' || !windows && char === "'") {
      if (!quote) quote = char
      else if (quote === char) quote = ''
      else token += char
      active = true
    } else if (!quote && /\s/.test(char)) {
      if (active) args.push(token)
      token = ''; active = false
    } else { token += char; active = true }
  }
  if (quote) return null
  if (active) args.push(token)
  return args.length ? args : null
}

function includeConfig(args: string[] | null, directory: string): IncludeConfig {
  const config: IncludeConfig = { quote: [], include: [], system: [], supported: Boolean(args?.length) }
  if (!args || args.length > 20_000) return { ...config, supported: false }
  // Environment launchers and explicit path environment assignments can put
  // additional directories ahead of the visible flags. We do not evaluate
  // them, so a later local -I/-isystem match would be a guess.
  const launcher = path.basename(args[0]).toLowerCase()
  if (launcher === 'env' || launcher === 'env.exe'
    || args.some(arg => /^(?:CPATH|C_INCLUDE_PATH|CPLUS_INCLUDE_PATH|OBJC_INCLUDE_PATH|INCLUDE|SDKROOT)=/i.test(arg))) config.supported = false
  const normal: string[] = [], system: string[] = []
  const add = (list: string[], value: string | undefined): void => {
    // sysroot-relative, environment-expanded and drive-relative directories
    // cannot be interpreted as a local absolute search path here.
    if (!value || value === '-' || /^[=$]/.test(value) || /[$%\0]/.test(value) || /^[a-z]:[^\\/]/i.test(value)) config.supported = false
    else list.push(path.resolve(directory, value))
  }
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg === '/link') break
    if (arg.startsWith('@') || /^(?:-I-|--sysroot(?:=|$)|-isysroot|-idirafter|-iprefix|-iwithprefix|-ivfsoverlay|-working-directory|-isystem-after|-iframework|-F|\/external:env:)/.test(arg)) {
      config.supported = false
    } else if (/^-X/.test(arg) || arg === '-mllvm' || arg.startsWith('-mllvm=')
      || /^(?:-Wa,|-Wl,|-Wp,|\/clang:)/.test(arg)) {
      // These options forward their following token (or a comma payload) to
      // another tool. Its `-I...` text is not a compiler include directory.
      config.supported = false
      if (!arg.includes('=') && !/^(?:-Wa,|-Wl,|-Wp,|\/clang:)/.test(arg)) i++
    } else if (arg === '-I' || arg === '/I') add(normal, args[++i])
    else if (arg.startsWith('-I') || arg.startsWith('/I')) add(normal, arg.slice(2))
    else if (arg === '--include-directory') add(normal, args[++i])
    else if (arg.startsWith('--include-directory=')) add(normal, arg.slice(20))
    else if (arg === '-iquote') add(config.quote, args[++i])
    else if (arg.startsWith('-iquote')) add(config.quote, arg.slice(7))
    else if (arg === '-isystem' || arg === '-imsvc' || arg === '/external:I') add(system, args[++i])
    else if (arg.startsWith('-isystem')) add(system, arg.slice(8))
    else if (arg.startsWith('-imsvc')) add(system, arg.slice(6))
    else if (arg.startsWith('/external:I')) add(system, arg.slice(11))
    else if (['-o', '-x', '-D', '-U', '-include', '-imacros', '-MF', '-MT', '-MQ'].includes(arg)) i++
  }
  // Preserve the classes until resolution: GCC/Clang ignore -I aliases of an
  // -isystem directory based on physical identity, which can change without
  // the compilation database changing.
  config.include = normal
  config.system = system
  return config
}

const relativeFile = (root: string, absolute: string): string | null => within(root, absolute) ? path.relative(root, absolute).split(path.sep).join('/') : null
const identity = (absolute: string): string | null => { try { return canonicalTarget(absolute) } catch { return null } }

export function loadCompilationDatabase(root: string, file?: string, signal?: AbortSignal): CompilationDatabase {
  signal?.throwIfAborted()
  const absolute = path.resolve(root, file ?? 'compile_commands.json')
  const databaseIdentity = identity(absolute)
  let bytes: Buffer
  try { bytes = readBoundedFile(absolute, BYTE_CAP) } catch (cause) {
    const absent = !file && (cause as NodeJS.ErrnoException).code === 'ENOENT'
    return {
      signature: JSON.stringify([absolute, databaseIdentity, absent ? 'absent' : 'failed']), valid: () => identity(absolute) === databaseIdentity,
      ...(!absent ? { info: { status: 'failed' as const, path: absolute, entries: 0, unsupported: 0, message: '编译数据库不可读取或超过 8 MiB。' } } : {}),
    }
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  const cacheKey = JSON.stringify([root, absolute])
  let cached = CACHE.get(cacheKey)
  if (!cached || cached.digest !== digest) {
    try {
      const parsed: unknown = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
      if (!Array.isArray(parsed) || parsed.length > ENTRY_CAP) throw new Error('shape')
      const configs = new Map<string, IncludeConfig[]>()
      const info: CompilationInfo = { status: 'ok', path: absolute, entries: 0, unsupported: 0 }
      for (const raw of parsed) {
        signal?.throwIfAborted()
        if (!raw || typeof raw !== 'object' || typeof raw.file !== 'string' || typeof raw.directory !== 'string') {
          info.unsupported++; continue
        }
        const directory = path.resolve(path.dirname(absolute), raw.directory)
        const source = path.resolve(directory, raw.file)
        const rel = relativeFile(root, source)
        if (!rel) continue // external compilation units are outside this graph
        const args = Array.isArray(raw.arguments) && raw.arguments.every((arg: unknown) => typeof arg === 'string')
          ? raw.arguments as string[] : typeof raw.command === 'string' ? commandArgs(raw.command) : null
        const config = includeConfig(args, directory)
        if (!config.supported) info.unsupported++
        info.entries++
        const variants = configs.get(pathKey(rel)) ?? []
        variants.push(config)
        configs.set(pathKey(rel), variants)
      }
      cached = { digest, configs, info }
      CACHE.delete(cacheKey); CACHE.set(cacheKey, cached)
      if (CACHE.size > 4) CACHE.delete(CACHE.keys().next().value!)
    } catch (cause) {
      signal?.throwIfAborted()
      return { signature: JSON.stringify([absolute, databaseIdentity, digest, 'failed']), valid: () => identity(absolute) === databaseIdentity,
        info: { status: 'failed', path: absolute, entries: 0, unsupported: 0, message: '编译数据库需为不超过 20,000 项的 JSON 数组。' } }
    }
  }
  const canonicalRoot = realpathSync(root), probes = new Map<string, string | null>()
  const remember = (file: string): string | null => {
    const previous = probes.get(file)
    if (probes.has(file)) return previous ?? null
    const current = identity(file)
    probes.set(file, current)
    return current
  }
  const searchPaths = new Map<IncludeConfig, string[]>()
  const includesOf = (config: IncludeConfig): string[] => {
    const previous = searchPaths.get(config)
    if (previous) return previous
    const systemPaths = new Set(config.system.map(pathKey))
    const systemIdentities = new Set(config.system.map(remember).filter((value): value is string => value !== null).map(pathKey))
    const normal = config.include.filter(directory => {
      const canonical = remember(directory)
      return !systemPaths.has(pathKey(directory)) && !(canonical && systemIdentities.has(pathKey(canonical)))
    })
    const directories = [...normal, ...config.system]
    searchPaths.set(config, directories)
    return directories
  }
  const resolve: IncludeResolver = (from, spec, mode, isFile) => {
    const variants = cached!.configs.get(pathKey(from))
    if (!variants) return null
    if (mode === 'dynamic' || !spec || spec.includes('\0') || path.isAbsolute(spec) || /^[a-z]:/i.test(spec)) return []
    const targets = variants.map(config => {
      if (!config.supported) return null
      const include = includesOf(config)
      const directories = mode === 'quote' ? [path.resolve(root, path.dirname(from)), ...config.quote, ...include] : include
      for (const directory of directories) {
        const canonical = remember(directory)
        // An earlier outside/unknown directory might contain the header. Do
        // not guess a later local match or read outside the analyzed root.
        if (!canonical || !within(canonicalRoot, canonical)) return null
        const target = path.resolve(directory, spec)
        const rel = relativeFile(root, target)
        if (!rel) return null
        if (!isFile(rel)) continue
        const resolved = remember(target)
        return resolved && within(canonicalRoot, resolved) ? rel : null
      }
      return null
    })
    const first = targets[0]
    // Multiple build configurations must agree. A single variant cannot
    // silently select a different header for the same translation unit.
    return first && targets.every(target => target !== null && pathKey(target) === pathKey(first)) ? [first] : []
  }
  return { signature: JSON.stringify([absolute, databaseIdentity, digest, canonicalRoot]), info: cached.info, resolve,
    valid: () => identity(absolute) === databaseIdentity && [...probes].every(([file, expected]) => identity(file) === expected) }
}
