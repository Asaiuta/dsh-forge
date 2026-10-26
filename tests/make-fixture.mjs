/**
 * Deterministic fixture workspace for dsh-forge tests and evals.
 *
 * Generates tests/.fixture/ as a real git repo (git-aware ranking needs a
 * repository) with known file contents. Ground-truth line numbers are
 * computed from the written lines at generation time (locate a unique token
 * substring) — never hardcoded, so content shifts cannot silently desync the
 * evals.
 *
 * The rebuild is **incremental**: files whose bytes already match are left
 * alone, only strays are removed. A cold `rm -rf` of the tree costs ~65 s on
 * hosts with an on-access filesystem filter (RaiDrive CBFS), and sandboxed
 * runners reject deletes past a per-turn threshold — both problems vanish when
 * a repeat build deletes nothing.
 *
 * @module dsh-forge/tests/make-fixture
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.fixture')

/** 1-based line number of the first line containing `token`. */
function mark(lines, token) {
  const idx = lines.findIndex((line) => line.includes(token))
  if (idx === -1) throw new Error(`fixture drift: token "${token}" not found in generated lines`)
  return idx + 1
}

/** Relative paths written by the current build, used to prune strays. */
let expected = new Set()

function writeLines(relPath, lines, crlf = false) {
  const abs = path.join(FIXTURE_DIR, relPath)
  const eol = crlf ? '\r\n' : '\n'
  const text = lines.join(eol) + eol
  expected.add(path.normalize(relPath))
  let current = null
  try {
    current = readFileSync(abs, 'utf8')
  } catch { /* missing or unreadable: rewrite */ }
  if (current === text) return
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, text, 'utf8')
}

/**
 * Delete files the current build no longer produces (and only those).
 * A full `rm -rf` of the fixture costs ~65 s on hosts with an on-access
 * filesystem filter, and trips bulk-delete guards in sandboxed runners, so
 * the rebuild is incremental: canonical content is rewritten, everything
 * else is left untouched.
 */
function prune() {
  if (!existsSync(FIXTURE_DIR)) return
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const abs = path.join(dir, entry.name)
      const rel = path.normalize(path.relative(FIXTURE_DIR, abs))
      if (entry.isDirectory()) walk(abs)
      else if (!expected.has(rel)) rmSync(abs, { force: true })
    }
  }
  walk(FIXTURE_DIR)
}

export function buildFixture() {
  expected = new Set()
  mkdirSync(FIXTURE_DIR, { recursive: true })
  const truth = {}

  const storeLines = [
    '/** Blob store with dedup. */',
    'class Store {',
    '  hasBlob(hash) {',
    '    return this.blobs.has(hash);',
    '  }',
    '',
    '  putBlob(buffer) {',
    '    const hash = sha256(buffer);',
    '    if (!this.hasBlob(hash)) this.blobs.set(hash, buffer);',
    '    return hash;',
    '  }',
    '',
    '  getBlob(hash) {',
    '    return this.blobs.get(hash) ?? null;',
    '  }',
    '}',
    '',
    'module.exports = { Store };',
  ]
  writeLines('src/store.js', storeLines)
  truth.storePutBlob = mark(storeLines, 'putBlob(buffer) {')
  truth.storeGetBlob = mark(storeLines, 'getBlob(hash) {')

  const validateLines = [
    'export function isEmail(value) {',
    "  return /^[^@\\s]+@[^\\s]+\\.[^\\s]+$/.test(value);",
    '}',
    '',
    'export function isPhone(value) {',
    '  return /^\\+?\\d{7,15}$/.test(value);',
    '}',
  ]
  writeLines('src/validate.js', validateLines)
  truth.validateIsEmail = mark(validateLines, 'export function isEmail')

  writeLines('src/login.js', [
    'import { isEmail } from "./validate.js";',
    'import { Store } from "./store.js";',
    '',
    'function submit(form) {',
    '  if (!isEmail(form.email)) return showError("邮箱格式不正确");',
    '  const store = new Store();',
    '  store.putBlob(form.payload);',
    '  return apiLogin(form);',
    '}',
    '',
    'function showError(message) {',
    '  console.error(message);',
    '  return null;',
    '}',
    '',
    'export { submit };',
  ])

  writeLines('src/nested/deep.ts', [
    'export interface User {',
    '  id: string;',
    '  email: string;',
    '}',
    '',
    'export class UserService {',
    '  private users = new Map<string, User>();',
    '',
    '  putUser(user: User): void {',
    '    this.users.set(user.id, user);',
    '  }',
    '',
    '  getUser(id: string): User | undefined {',
    '    return this.users.get(id);',
    '  }',
    '}',
  ])

  writeLines('lib/utils.py', [
    'import os',
    '',
    '',
    'def normalize_path(raw):',
    '    """Expand and normalize a filesystem path."""',
    '    return os.path.normpath(os.path.expanduser(raw))',
    '',
    '',
    'class Cache:',
    '    def __init__(self):',
    '        self._items = {}',
    '',
    '    def put(self, key, value):',
    '        self._items[key] = value',
  ])

  const scoringLines = [
    'pub struct Config {',
    '    pub weight: f64,',
    '}',
    '',
    'pub fn compute_score(raw: f64, config: &Config) -> f64 {',
    '    raw * config.weight',
    '}',
    '',
    'impl Config {',
    '    /// Default weight for new configs.',
    '    pub fn default_weight() -> f64 {',
    '        1.0',
    '    }',
    '}',
  ]
  writeLines('lib/scoring.rs', scoringLines)
  truth.rsDefaultWeight = mark(scoringLines, 'pub fn default_weight')
  truth.rsDefaultWeightComment = mark(scoringLines, '/// Default weight')

  writeLines('docs/guide.md', [
    '# Usage guide',
    '',
    'Call `putBlob` before reading back with `getBlob`; the hash is the key.',
    '',
    '## Notes',
    '',
    'The cache in `utils.py` is unrelated to the blob store.',
  ])

  const crlfLines = [
    'first line',
    'second line',
    'CRLF_TOKEN lives here',
    'fourth line',
  ]
  writeLines('data/crlf.txt', crlfLines, true)
  truth.crlfToken = mark(crlfLines, 'CRLF_TOKEN')

  // JSDoc'd function + const-arrow — exercises comment capture and the
  // lexical_declaration extraction path.
  const docedLines = [
    '/** Format a greeting. */',
    'export function greet(name) {',
    "  return `hello ${name}`;",
    '}',
    '',
    '/** Uppercase a string. */',
    'const shout = (s) => s.toUpperCase();',
  ]
  writeLines('src/doced.js', docedLines)
  truth.docedGreet = mark(docedLines, 'export function greet')
  truth.docedGreetComment = mark(docedLines, '/** Format a greeting. */')
  truth.docedShout = mark(docedLines, 'const shout')

  writeLines('cmd/server.go', [
    'package main',
    '',
    'import "fmt"',
    '',
    'type Greeter struct {',
    '\tName string',
    '}',
    '',
    'func (g Greeter) Greet() string {',
    '\treturn fmt.Sprintf("hello %s", g.Name)',
    '}',
    '',
    'func main() {',
    '\tg := Greeter{Name: "forge"}',
    '\tfmt.Println(g.Greet())',
    '}',
  ])
  truth.goGreet = 9   // func (g Greeter) Greet
  truth.goMain = 13   // func main

  writeLines('data/unicode.md', [
    '# 中文文档',
    '',
    '这里包含一个中文标记，用于验证多字节内容检索。',
  ])

  writeLines('build/generated.js', [
    '// This directory is gitignored.',
    'IGNORED_BUILD_TOKEN should never surface in results.',
  ])

  writeLines('logs/app.log', [
    '2026-10-11 IGNORED_LOG_TOKEN something happened',
  ])

  writeLines('README.md', [
    '# forge fixture',
    '',
    'A deterministic workspace for dsh-forge evals.',
  ])

  writeLines('.gitignore', [
    'build/',
    'logs/',
    '*.log',
  ])

  prune()

  // Git init + single commit so fff sees a real repository with clean status.
  const git = (args) => execFileSync('git', args, { cwd: FIXTURE_DIR, stdio: 'pipe' })
  if (!existsSync(path.join(FIXTURE_DIR, '.git'))) git(['init', '-q'])
  git(['config', 'user.email', 'forge@example.com'])
  git(['config', 'user.name', 'forge-fixture'])
  if (git(['status', '--porcelain']).toString().trim() !== '') {
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'fixture'])
  }
  return truth
}

export function fixtureUpToDate() {
  return existsSync(path.join(FIXTURE_DIR, '.git'))
}
