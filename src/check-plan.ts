/**
 * Saved check plans: the bridge between "a human approved this" and "run it".
 *
 * A plan exists so that approval names one exact thing. If `action=run` accepted
 * the program and arguments directly, an approval prompt could be answered for
 * one command and a different one dispatched a moment later — the classic
 * confused-deputy shape. So the plan freezes the recipe set, hashes it into a
 * `checkPlanId`, and `run` accepts nothing but that id.
 *
 * Two identities are frozen, and they answer different questions:
 *
 *   recipe hash  — "is this the same command the human approved?"
 *   input manifest — "are the inputs still what the check read?"
 *
 * The second is why a plan is not just a command list. A check that passed
 * before a source file changed says nothing about the current tree, so `run`
 * re-hashes the manifest before dispatch and again after the terminal result;
 * a mismatch makes the result stale rather than applicable.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { atomicWrite, storeFor } from './ledger.ts'
import { candidateSetDrift } from './trace-candidates.ts'

/**
 * How a recipe's result may be read.
 *
 * The kind is chosen at plan time and frozen into the hash, because it is part of
 * what a human approves: "run this command" and "run this command and let its TAP
 * output speak for the tests" are different permissions. A recipe is never
 * reclassified at run time — that would let a caller upgrade a process result
 * into a test verdict after the fact.
 */
export type RecipeKind =
  /** Only the process outcome is claimed: exit code, no semantic verdict. */
  | 'process'
  /**
   * A Node TAP report, interpreted by `tap.ts`. Enabled: the interpreter refuses
   * zero-test, all-skip, all-todo, truncated and foreign reports rather than
   * reading them as passes.
   */
  | 'tests'
  /**
   * A TypeScript diagnostic stream, interpreted by `types-check.ts`. Enabled:
   * silence counts only with a zero exit, and parsed errors fail regardless of
   * the exit code.
   */
  | 'types'

/** One frozen command. `argv` is an array, never a shell string. */
export interface CheckRecipe {
  id: string
  kind: RecipeKind
  program: string
  argv: string[]
  cwd: string
  /**
   * Paths the recipe was approved to exercise.
   *
   * Used by the TAP interpreter to tell a file-level wrapper (`ok 1 - suite.mjs`,
   * emitted for a file that registered no test) from a real test that happens to
   * share a file's name. Without it, a suite that registers nothing reads as one
   * passing test.
   */
  scope?: string[]
}

/** A plan as stored. Frozen by hash; never edited in place. */
export interface CheckPlan {
  checkPlanId: string
  workspace: string
  createdAt: string
  /** Static checks to re-run alongside the recipes. */
  staticChecks: string[]
  recipes: CheckRecipe[]
  /** Batch identities frozen at planning time, never replaced by the newest. */
  batchIds: number[]
  /** Relative path → content hash, the inputs the plan was formed against. */
  inputManifest: Record<string, string>
  /** The full candidate set when the plan includes bridge/IPC checks. */
  traceFiles?: string[]
}

const PLAN_DIR = 'checks'
const TTL_MS = 24 * 60 * 60 * 1000
const MAX_PLANS = 100

/** The exact bytes a hash is computed over: stable key order, no whitespace. */
type PlanContext = Pick<CheckPlan, 'workspace' | 'batchIds' | 'inputManifest' | 'traceFiles'>

function canonical(recipes: readonly CheckRecipe[], staticChecks: readonly string[], context?: PlanContext): string {
  return JSON.stringify({
    checks: [...staticChecks].sort(),
    recipes: recipes.map(recipe => ({
      id: recipe.id,
      kind: recipe.kind,
      program: recipe.program,
      argv: [...recipe.argv],
      cwd: recipe.cwd,
      scope: [...new Set(recipe.scope ?? [])].sort(),
    })),
    ...(context === undefined ? {} : {
      workspace: context.workspace,
      batches: [...context.batchIds].sort((a, b) => a - b),
      inputs: Object.entries(context.inputManifest).sort(([a], [b]) => a.localeCompare(b)),
      traceFiles: context.traceFiles === undefined ? null : [...new Set(context.traceFiles)].sort(),
    }),
  })
}

/**
 * Derive the plan identity from its content.
 *
 * Any change to a program, an argument, the order or the working directory
 * produces a different id, which is the whole point: a plan cannot be mutated
 * into a different command while keeping the approval that was given for it.
 */
export function planId(recipes: readonly CheckRecipe[], staticChecks: readonly string[], context?: PlanContext): string {
  return createHash('sha256').update(canonical(recipes, staticChecks, context), 'utf8').digest('hex').slice(0, 32)
}

function planDir(workspace: string): string {
  return join(storeFor(workspace).dir, PLAN_DIR)
}

/**
 * Hash the declared input files as they exist right now.
 *
 * A missing file hashes to `null`-equivalent marker rather than being omitted:
 * "the input disappeared" and "the input was never declared" must not look
 * alike when the manifest is compared.
 */
export function hashInputs(workspace: string, files: readonly string[]): Record<string, string> {
  const manifest: Record<string, string> = {}
  for (const file of [...files].sort()) {
    const abs = resolve(workspace, file)
    manifest[file] = existsSync(abs)
      ? createHash('sha256').update(readFileSync(abs)).digest('hex')
      : 'absent'
  }
  return manifest
}

/** Every manifest entry that no longer matches the recorded hash. */
export function manifestDrift(workspace: string, manifest: Record<string, string>, traceFiles?: readonly string[]): string[] {
  const current = hashInputs(workspace, Object.keys(manifest))
  const drifted = Object.keys(manifest).filter(file => current[file] !== manifest[file])
  if (traceFiles !== undefined) for (const file of candidateSetDrift(workspace, traceFiles)) if (!drifted.includes(file)) drifted.push(file)
  return drifted.sort()
}

/**
 * Persist one plan, evicting expired and excess entries first.
 *
 * Pruning is by creation time, so a burst of plans cannot push out the one a
 * user is about to run. Failures to prune are ignored: a stale file occupying a
 * slot is better than failing the save that the user asked for.
 */
export function savePlan(plan: CheckPlan): void {
  const dir = planDir(plan.workspace)
  mkdirSync(dir, { recursive: true })
  try {
    const now = Date.now()
    const existing = readdirSync(dir).filter(name => name.endsWith('.json'))
    const survivors: Array<{ file: string; at: number }> = []
    for (const name of existing) {
      const full = join(dir, name)
      try {
        const parsed = JSON.parse(readFileSync(full, 'utf8')) as { createdAt?: string }
        const at = Date.parse(parsed.createdAt ?? '') || 0
        if (now - at > TTL_MS) { unlinkSync(full); continue }
        survivors.push({ file: name, at })
      } catch {
        // An unreadable plan is not a valid plan; it must not occupy a slot.
        try { unlinkSync(full) } catch { /* another writer already removed it */ }
      }
    }
    if (survivors.length >= MAX_PLANS) {
      survivors.sort((a, b) => a.at - b.at)
      for (const entry of survivors.slice(0, survivors.length - MAX_PLANS + 1)) {
        try { unlinkSync(join(dir, entry.file)) } catch { /* already gone */ }
      }
    }
  } catch { /* pruning is best-effort; the save below still has to happen */ }
  atomicWrite(join(dir, `${plan.checkPlanId}.json`), JSON.stringify(plan, null, 2))
}

/**
 * Read one plan back, refusing anything whose id no longer matches its content.
 *
 * The check is not defensive decoration: the file is on disk between two runs,
 * so a hand-edited recipe must fail here rather than be dispatched under the
 * approval that the original id earned.
 */
export function loadPlan(workspace: string, checkPlanId: string): { ok: true; plan: CheckPlan } | { ok: false; detail: string } {
  if (!/^[0-9a-f]{32}$/.test(checkPlanId)) return { ok: false, detail: 'checkPlanId must be the 32-hex id returned by action=plan' }
  const dir = planDir(workspace)
  const file = join(dir, `${checkPlanId}.json`)
  if (!existsSync(file)) return { ok: false, detail: `no saved plan ${checkPlanId} in this workspace; run action=plan first` }
  let plan: CheckPlan
  try {
    plan = JSON.parse(readFileSync(file, 'utf8')) as CheckPlan
  } catch (error) {
    return { ok: false, detail: `saved plan ${checkPlanId} is unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (Date.now() - (Date.parse(plan.createdAt) || 0) > TTL_MS) {
    return { ok: false, detail: `saved plan ${checkPlanId} has expired; a fresh plan (and a fresh approval) is required` }
  }
  let expected: string
  try {
    if (!Array.isArray(plan.batchIds) || !plan.inputManifest || typeof plan.inputManifest !== 'object') throw new Error('missing batch/input identity')
    expected = planId(plan.recipes, plan.staticChecks, plan)
  } catch {
    return { ok: false, detail: `saved plan ${checkPlanId} lacks a valid frozen recipe, batch or input identity; re-plan before running` }
  }
  if (expected !== plan.checkPlanId || expected !== checkPlanId) {
    return { ok: false, detail: `saved plan ${checkPlanId} no longer matches its own content (recomputed ${expected}); refusing to run an edited plan` }
  }
  if (resolve(plan.workspace) !== resolve(realpathOrSelf(workspace))) {
    return { ok: false, detail: `saved plan ${checkPlanId} belongs to a different workspace` }
  }
  return { ok: true, plan }
}

function realpathOrSelf(path: string): string {
  const resolved = resolve(path)
  return existsSync(resolved) ? realpathSync(resolved) : resolved
}
