/**
 * Task-oriented guidance for the names and capabilities visible in one scope.
 * Native takeover keeps the host's argument contracts; its guidance must not
 * advertise additive-only options such as ffgrep.patterns or fffind.mode.
 */
import { FORGE_DEFINITION_TAG } from './delegate.ts'
export const FORGE_GUIDANCE_ORDER = 130
export const FORGE_GUIDANCE_SECTION = 'plugin:dsh-forge'

export const FORGE_CAPABILITIES = [
  'find', 'grep', 'read', 'edit', 'file', 'history', 'rollback', 'trace', 'cards',
] as const
export type ForgeCapability = (typeof FORGE_CAPABILITIES)[number]
export type ForgeSurface = Record<ForgeCapability, string>

export const ADDITIVE_SURFACE: ForgeSurface = {
  find: 'fffind', grep: 'ffgrep', read: 'ff_read', edit: 'ffedit', file: 'ff_file',
  history: 'ffhistory', rollback: 'ffrollback', trace: 'fftrace', cards: 'ff_cards',
}
export function surfaceNames(surface: ForgeSurface): string[] {
  return FORGE_CAPABILITIES.map(capability => surface[capability])
}
export const FORGE_TOOL_NAMES = surfaceNames(ADDITIVE_SURFACE)

/** Render only available capabilities, with no references to hidden tools. */
export function forgeGuidance(surface: ForgeSurface, visible: readonly ForgeCapability[] = FORGE_CAPABILITIES): string {
  if (!visible.length) return ''
  const n = surface, has = (cap: ForgeCapability): boolean => visible.includes(cap)
  return [
    'dsh-forge is installed. For the tasks below, prefer these tools; follow each tool\'s schema.',
    ...(has('read') ? [
      `- Understand a file → ${n.read} view=outline first, then view=body for selected lines or path#symbol. Find a definition → view=definitions with symbol (also when several files define the same name — it lists every definition with signatures). Batch paths/ranges in one read when useful.`,
    ] : []),
    ...(has('find') ? [n.find === 'glob'
      ? '- Find files by path → glob with pattern and optional path.'
      : `- Find files → ${n.find} mode=name for fuzzy names; mode=glob for path patterns (page continues results). Prefer over glob for these tasks.`,
    ] : []),
    ...(has('grep') ? [n.grep === 'grep'
      ? '- Search file contents → grep with a regular-expression pattern, optional path and include.'
      : `- Search file contents → ${n.grep} over grep: pattern for plain/regex/fuzzy search, or patterns for 2-16 literals in one pass; cursor continues results, enclosing=true adds symbol context.`,
    ] : []),
    ...(has('read') || has('find') || has('grep') ? [
      'For reads/searches outside the workspace, pass path at the target file/directory, including another checkout or node_modules, subject to the active filesystem permissions. Check partial/truncated results before concluding absence.',
    ] : []),
    ...(has('trace') ? [
      `- ${n.trace} answers wiring questions in one query — pick target= by question: who breaks if I change a file → impact:src/file.ts; what a file imports → file:<path>; how A reaches B → path:<a> -> <b>; where an IPC channel registers or a preload API lands → ipc:<channel> / api:<name>; which globals a preload exposes and who uses each member → exposes:<global|file>; who defines/uses a window.* global → global:<name>; which scripts a page loads → page:<file.html>; where a name is defined → symbol:<name>; FFI/binary exports → ffi:<name>. Results carry 路径:行.`,
    ] : []),
    ...(has('edit') ? [
      `- Edit text after reading it → ${n.edit} with path, find, replaceWith and reason; use steps for multiple changes. Ambiguity writes nothing and returns a ticket; resolve with {ticket, choice}.`,
    ] : []),
    ...(has('file') ? [`- Create/remove/move files or transfer a symbol → ${n.file}; read before changing existing files.`] : []),
    ...(has('history') ? [`- Inspect changes or an immutable snapshot diff → ${n.history}, optionally batch or node.`] : []),
    ...(has('rollback') ? [`- Revert a recorded batch → ${n.rollback}; inspect its dry-run first.`] : []),
    ...(has('cards') ? [`- Orient from recorded construction history → ${n.cards}; no arguments lists cards, card=<name> reads one. Cards describe ledger activity, not complete repository history.`] : []),
    'Use available built-in tools for attachments, multimodal reads and unsupported operations. Respect sandbox denials; switching tools does not grant additional access.',
  ].join('\n')
}
export const FORGE_GUIDANCE = forgeGuidance(ADDITIVE_SURFACE)

export interface ScopedToolLookup { get(name: string, scope?: unknown): unknown }
export interface SectionScopeContext { scope?: unknown }

/** A lookup failure is unknown availability, not proof of removal. */
export function visibleForgeText(tools: ScopedToolLookup | undefined, surface: ForgeSurface): (context: SectionScopeContext) => string {
  if (!tools || typeof tools.get !== 'function') return () => forgeGuidance(surface)
  return context => {
    const visible = FORGE_CAPABILITIES.filter(capability => {
      try {
        const definition = tools.get(surface[capability], context?.scope)
        if (definition === undefined) return false
        // Failed scoped installation can leave the native built-in visible.
        // Its name alone does not promise Forge's extended read parameters.
        if (surface[capability] !== ADDITIVE_SURFACE[capability]) {
          if (typeof definition !== 'object' || definition === null) return false
          const forgeName = (definition as Record<string, unknown>)[FORGE_DEFINITION_TAG]
          // Native search factories identify themselves as grep/glob; read
          // keeps ff_read. Both are stamped Forge definitions, unlike built-ins.
          return forgeName === ADDITIVE_SURFACE[capability] || forgeName === surface[capability]
        }
        return true
      }
      catch { return true }
    })
    return forgeGuidance(surface, visible)
  }
}

export interface ForgeSystemPromptService {
  section(section: {
    name: string
    order: number
    text: string | ((context: SectionScopeContext) => string)
  }): () => void
}
