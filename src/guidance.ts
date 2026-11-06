/**
 * Task-oriented guidance for the forge tools visible in one scope.
 *
 * Forge never renames itself onto a built-in, so every line names a forge tool
 * by its own name, and a line appears only when that tool resolves in the
 * calling scope. The built-ins `read`/`grep`/`glob` carry their own prompt
 * sections. Full scopes use ff_file's explicit symbol selector; retrieval-only
 * scopes advertise the augmented read's file#Symbol convention.
 */
import { FORGE_DEFINITION_TAG } from './host.ts'
import type { AugmentName } from './augment.ts'

export const FORGE_GUIDANCE_ORDER = 130
export const FORGE_GUIDANCE_SECTION = 'plugin:dsh-forge'

export const FORGE_CAPABILITIES = [
  'find', 'grep', 'read', 'edit', 'file', 'history', 'rollback', 'trace', 'project',
] as const
export type ForgeCapability = (typeof FORGE_CAPABILITIES)[number]

/** The forge tool serving each capability. */
export const FORGE_TOOLS: Record<ForgeCapability, string> = {
  find: 'ff_find', grep: 'ff_grep', read: 'ff_symbols', edit: 'ff_edit', file: 'ff_file',
  history: 'ff_history', rollback: 'ff_rollback', trace: 'ff_trace', project: 'ff_project',
}
export const FORGE_TOOL_NAMES = FORGE_CAPABILITIES.map((capability) => FORGE_TOOLS[capability])

/** What an augmented built-in adds to the model-facing surface. */
export interface AugmentedSurface {
  /** The built-in `read` answers `file_path=<file>#<Symbol>` with that definition's lines. */
  symbolRead?: boolean
  /**
   * The scope resolves a built-in `grep`, so plain and regex content search is
   * not ffgrep's job. `undefined` (no registry to ask) keeps the routing that
   * matches a full host.
   */
  builtinGrep?: boolean
  /** The scope resolves a built-in `glob`, so path patterns are not fffind's. */
  builtinGlob?: boolean
}

/** Render only available capabilities, with no references to hidden tools. */
const RETRIEVAL_CAPABILITIES: readonly ForgeCapability[] = ['find', 'grep', 'read']

export function forgeGuidance(visible: readonly ForgeCapability[] = RETRIEVAL_CAPABILITIES, augmented: AugmentedSurface = {}): string {
  const has = (cap: ForgeCapability): boolean => visible.includes(cap)
  // A missing built-in is the one case where "use the built-in" is a dead end:
  // hosting without `glob`/`grep` leaves the forge tool as the only answer, and
  // the line has to say so. Only an explicit `false` (a scope that was asked and
  // answered) overrides the full-host wording.
  const builtinGlob = augmented.builtinGlob !== false
  const builtinGrep = augmented.builtinGrep !== false
  if (!visible.length && !augmented.symbolRead) return ''
  const n = FORGE_TOOLS
  return [
    // Known definitions precede outline discovery. Full scopes expose a symbol
    // field directly; missing/hidden ff_file falls back to augmented read.
    ...(has('file') ? [
      `- Symbol known → ${n.file} action=read, files=[{path:"src/service.ts",symbol:"Service.start"}]; no outline first. Also batches known files/ranges. Plain single-file reads → read.`,
      ...(has('read') ? [`- Need names → ${n.read} view=outline; every definition of one name → view=definitions. Request further pages only when needed.`] : []),
    ] : has('read') && augmented.symbolRead ? [
      `- Symbol known → read with file_path=<file>#<Symbol> (no offset/limit): that definition only, no outline first. Need the names → ${n.read} view=outline; every definition of one name → view=definitions. Request further outline pages only when needed.`,
    ] : has('read') ? [
      `- Code structure → ${n.read} view=outline for names and line ranges; view=definitions with symbol=<name> for exact definitions. Read source through the built-in read using the returned file and line range.`,
    ] : augmented.symbolRead ? [
      '- Read one definition → read with file_path=<file>#<Symbol> (no offset/limit): only that definition\'s lines come back, numbered like any read.',
    ] : []),
    // Only the routing is left: which tool for the question, not how to call it.
    ...(has('find') ? [builtinGlob
      ? `- Find files → built-in glob for path patterns; ${n.find} only for fuzzy names or typos.`
      : `- Find files → ${n.find}: fuzzy names and typos, any directory.`] : []),
    ...(has('grep') ? [builtinGrep
      ? `- Search contents → built-in grep for plain/regex; ${n.grep} for fuzzy search or multi-literal.`
      : `- Search contents → ${n.grep}: fuzzy by default, literal for multi-pattern or non-ASCII.`] : []),
    ...(has('trace') ? [
      // What stays is the one thing no schema can state: the old wording ("pass
      // edgeMode=certain before reporting a dependency as fact") read as a duty
      // on any answer, so on an ipc: registration the caller went off and
      // re-verified a literal edge by hand and never came back: Q8 cost two
      // extra rounds and ~100k tokens against a plain grep
      // (docs/takeover-eval-result-2026-10-30.md). A negative rule that stops
      // that hunt is worth its tokens; the target list and the edgeMode
      // mechanics are the `target`/`edgeMode` descriptions verbatim, and the
      // sentence "answers who breaks if a file changes … FFI/binary exports"
      // was this tool's own description copied into the prompt.
      `- ${n.trace} answers wiring questions. A literal channel registration, a declared exposure or a symbol definition is not a dependency — take it as given. capture=true returns a snapshotId that a later ${has('edit') ? n.edit : 'edit'} checks.`,
    ] : []),
    ...(has('edit') ? [
      // Ask for the patch at edit time only when the task needs its evidence.
      `- Edit after reading → ${n.edit}: batch independent changes to the same file in ONE call using steps=[{find,replaceWith},...]; all target the original snapshot. match=literal also supports steps. Use a single find/replaceWith only for one change. receipt=diff when evidence is needed; compilers/tests for build/type correctness.`,
    ] : []),
    ...(has('file') ? [`- Create/overwrite files → ${n.file} action=create (overwrite=true to replace); missing parents are created.`] : []),
    ...(has('project') ? [`- ${n.project} tracks projects and reports. Daily plans use todo_write, already mirrored into projects; do not recreate them with task_add. Request report/evidence details only when needed.`] : []),
    ...(has('history') ? [
      `- Look back → ${n.history}; revert → ${has('rollback') ? n.rollback : 'ff_rollback'}.`,
    ] : has('rollback') ? [`- Revert a recorded batch → ${n.rollback}.`] : []),
    'Use built-in tools for attachments and multimodal reads. Respect sandbox denials; switching tools grants no extra access.',
  ].join('\n')
}
export const FORGE_GUIDANCE = forgeGuidance()

export interface ScopedToolLookup { get(name: string, scope?: unknown): unknown }
export interface SectionScopeContext { scope?: unknown }

/**
 * The guidance one scope should see.
 *
 * A capability is announced only when its forge tool resolves in that scope, and
 * the `file#Symbol` line only when the scope's `read` is the host built-in that
 * the augmentation answers for. A lookup failure is unknown availability, not
 * proof of removal, so it keeps the line.
 *
 * @param tools - the registry lookup, or `undefined` on a host without one.
 * @param augmented - built-in names the augmentation serves in this process.
 */
export function visibleForgeText(
  tools: ScopedToolLookup | undefined,
  augmented: readonly AugmentName[] = [],
  registeredTools: readonly string[] = FORGE_TOOL_NAMES,
): (context: SectionScopeContext) => string {
  const readAugmented = augmented.includes('read')
  const registered = new Set(registeredTools)
  const candidates = FORGE_CAPABILITIES.filter((capability) => registered.has(FORGE_TOOLS[capability]))
  if (!tools || typeof tools.get !== 'function') return () => forgeGuidance(candidates, { symbolRead: readAugmented })
  return (context) => {
    const visible = candidates.filter((capability) => {
      try {
        return tools.get(FORGE_TOOLS[capability], context?.scope) !== undefined
      } catch {
        return registered.has(FORGE_TOOLS[capability])
      }
    })
    // Present-but-unknown stays `undefined` so the full-host wording survives a
    // registry that throws; only a scope without the tool says `false`.
    const resolves = (name: string): boolean | undefined => {
      try {
        return tools.get(name, context?.scope) !== undefined
      } catch {
        return undefined
      }
    }
    let symbolRead = false
    if (readAugmented) {
      try {
        const builtin = tools.get('read', context?.scope)
        symbolRead = typeof builtin === 'object' && builtin !== null && (builtin as Record<string, unknown>)[FORGE_DEFINITION_TAG] === undefined
      } catch {
        symbolRead = true
      }
    }
    return forgeGuidance(visible, {
      symbolRead,
      builtinGrep: resolves('grep'),
      builtinGlob: resolves('glob'),
    })
  }
}

export interface ForgeSystemPromptService {
  section(section: {
    name: string
    order: number
    text: string | ((context: SectionScopeContext) => string)
  }): () => void
}
