/**
 * Card distillation (sedimentation stage 2): turn a deterministic skeleton
 * card into readable markdown, through one of two model paths.
 *
 * - `session` — the *current session model* polishes via a tool roundtrip:
 *   ff_cards hands it the skeleton plus a directive, the model calls back
 *   with `polish` + `content`, and {@link validatePolish} gates the draft
 *   against the ledger before anything is stored. The tool path carries no
 *   credentials, so this roundtrip is the only honest way to "use the
 *   current model"; it also means distillation spends conversation tokens
 *   and can never run unattended.
 *
 * - `endpoint` — a user-supplied OpenAI-compatible chat endpoint (same shape
 *   as dsh-blackhole's) polishes inline on the ff_cards call that finds an
 *   unpolished skeleton. Never a background timer; falls back to the
 *   skeleton on any failure, with the failure named.
 *
 * Both paths apply limited reference checks before caching a model-generated
 * draft. These checks cannot verify prose, counts, dates or causal claims;
 * callers can always request the deterministic skeleton as the source.
 *
 * @module dsh-forge/distill
 */

import type { CardName } from './cards.ts'

/** Polished drafts are cached bodies, not artifacts — this cap keeps one well
 *  under the host's ~50KB spill boundary so reading it never spills. */
export const POLISH_MAX_BYTES = 32 * 1024

/** The ledger facts a polished draft is gated against. */
export interface PolishFacts {
  /** Every file path the ledger has ever touched (forward slashes). */
  files: ReadonlySet<string>
  /** Actual batch identities, including gaps in recovered ledgers. */
  batchIds: ReadonlySet<number>
  /** The ledger's last batch id, used in diagnostics. */
  lastBatchId: number
}

export function polishDirective(card: CardName): string {
  return `distill: this card is a deterministic skeleton — rewrite it into readable markdown (same facts, no inventions, no frontmatter) and store it with ff_cards {polish: "${card}", content: "..."}`
}

// ---------------------------------------------------------------------------
// Prompt (endpoint path)
// ---------------------------------------------------------------------------

export function polishPrompt(skeleton: string): string {
  return [
    'You are distilling a code workspace\'s construction ledger into a readable knowledge card.',
    'Below is a deterministic skeleton card: every fact in it comes from an audited edit ledger.',
    '',
    'Rewrite it as clear markdown for an engineer orienting in this workspace:',
    '- Keep EVERY fact (files, counts, dates, actors, reasons) exactly as the skeleton states it.',
    '- Add structure and wording only — never invent a file, symbol, batch id, count or date.',
    '- Keep file paths in backticks exactly as the skeleton spells them.',
    '- Reason quotes may be paraphrased only when marked as summaries; short quotes stay verbatim.',
    '',
    'Output ONLY the markdown body. No frontmatter, no leading `---`, no wrapping code fence.',
    '',
    '--- skeleton ---',
    skeleton,
  ].join('\n')
}

export interface EndpointConfig {
  baseUrl: string
  model: string
  apiKeyEnv: string
  apiKey?: string
  timeoutMs: number
}

/** Injectable transport — tests stub `globalThis.fetch` through here. */
type DistillFetch = typeof fetch
let distillFetch: DistillFetch | undefined
export function setDistillFetchForTest(impl: DistillFetch | undefined): void {
  distillFetch = impl
}

/** POST {baseUrl}/chat/completions and return the assistant text. Throws with
 *  the reason — the caller owns the fallback and must name it. */
export async function polishViaEndpoint(endpoint: EndpointConfig, skeleton: string, signal: AbortSignal | undefined): Promise<string> {
  const doFetch = distillFetch ?? fetch
  // `resolveConfig()` deliberately validates an environment-backed key without
  // copying the secret into the resolved config. Resolve it at request time so
  // the documented `apiKeyEnv` path actually authenticates the request while
  // keeping credentials out of the plugin config object.
  const apiKey = endpoint.apiKey ?? process.env[endpoint.apiKeyEnv]
  const timeout = AbortSignal.timeout(endpoint.timeoutMs)
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response: Response
  try {
    response = await doFetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: composed,
      headers: {
        'content-type': 'application/json',
        ...(typeof apiKey === 'string' && apiKey.trim() !== '' ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [{ role: 'user', content: polishPrompt(skeleton) }],
      }),
    })
  } catch (cause) {
    throw new Error(`distill endpoint unreachable: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (!response.ok) {
    throw new Error(`distill endpoint answered ${response.status}`)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('distill endpoint returned a non-JSON body')
  }
  const content = extractAssistantText(payload)
  if (content === null) throw new Error('distill endpoint response carried no assistant text')
  return content
}

function extractAssistantText(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const message = (choices[0] as { message?: { content?: unknown } }).message
  const content = message?.content
  if (typeof content !== 'string' || content.trim() === '') return null
  return content
}

/** Strip a wrapping code fence the model may have added despite instructions.
 *  The closer must be exactly a line-final ``` — a ```` closer means the fence
 *  opened longer (or the model was sloppy) and the text is left untouched. */
export function stripWrappingFence(markdown: string): string {
  const text = markdown.replace(/^\uFEFF/, '').trim()
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text)
  return fenced !== null ? fenced[1] : text
}

// ---------------------------------------------------------------------------
// Hallucination gate
// ---------------------------------------------------------------------------

const PATHISH = /`([^`\n]+)`/g
const PATHISH_SUFFIX = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx|py|pyi|rs|go|c|h|cpp|cc|hpp|java|cs|lua|md|json|ya?ml|toml|html|css|sh|sql)$/i
const BATCH_REF = /(?:^|[^\w`])#(\d{1,6})\b/g

/**
 * Validate a polished draft against the anchor's own facts. Returns the list
 * of violations — empty means the draft may be stored.
 *
 * Two checkable classes (a model that hallucinates usually invents one of
 * them): backticked path-shaped tokens must exist in the ledger's touched-file
 * set, and `#N` batch references must exist. Bare paths and factual claims in
 * prose are not verified. Passing this check is not a factuality guarantee.
 */
export function validatePolish(content: string, facts: PolishFacts): string[] {
  const violations: string[] = []
  if (content.trim().length === 0) return ['content is empty']
  if (Buffer.byteLength(content, 'utf8') > POLISH_MAX_BYTES) {
    return [`content exceeds the ${Math.round(POLISH_MAX_BYTES / 1024)}KB polish cap`]
  }
  if (/^---\s*\n/m.test(content.slice(0, 16))) {
    violations.push('content must be body markdown only — the plugin owns the frontmatter')
  }
  const inventedPaths: string[] = []
  for (const match of content.matchAll(PATHISH)) {
    const token = match[1].trim()
    if (token.length === 0 || token.startsWith('#')) continue
    if (!token.includes('/') && !PATHISH_SUFFIX.test(token)) continue
    if (!facts.files.has(token) && !facts.files.has(token.replace(/\\/g, '/'))) {
      if (inventedPaths.length < 5) inventedPaths.push(token)
    }
  }
  if (inventedPaths.length > 0) {
    violations.push(`file path(s) not in this workspace's ledger: ${inventedPaths.map((p) => `"${p}"`).join(', ')}`)
  }
  const inventedBatches = new Set<string>()
  for (const match of content.matchAll(BATCH_REF)) {
    const id = Number(match[1])
    if (!facts.batchIds.has(id) && inventedBatches.size < 5) inventedBatches.add(match[1])
  }
  if (inventedBatches.size > 0) {
    violations.push(`batch reference(s) not in this workspace's ledger (last id ${facts.lastBatchId}): ${[...inventedBatches].map((id) => `#${id}`).join(', ')}`)
  }
  return violations
}
