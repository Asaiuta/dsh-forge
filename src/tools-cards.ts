/**
 * ff_cards: the sedimentation surface. Lists and serves the knowledge cards
 * that ./cards.ts distills from the construction ledger, and (stage 2) the
 * polish channel that upgrades a skeleton into a readable card.
 *
 * Three argument shapes:
 *
 *   (none)                          list the card directory with freshness
 *   card=<name>                     read one card — polished draft first,
 *                                   skeleton when none is anchored
 *   polish=<name>, content=<md>     store a polished draft (session-model
 *                                   path); validated against the ledger by
 *                                   the hallucination gate before it lands
 *
 * Distillation modes (`config.cards.distill`): `session` (default) offers the
 * polish directive to the current session model on read/list; `endpoint`
 * polishes inline on a READ through the user's OpenAI-compatible endpoint and
 * falls back to the skeleton on any failure; `off` serves skeletons and
 * refuses polish writes. No mode runs a background timer, and only `endpoint`
 * spends anything without the model in the loop.
 *
 * Plain reads only: cards are plugin-private derived state, so nothing here
 * goes through the write-governance pipeline, and there is nothing to observe
 * for the host's write-intent policy.
 *
 * @module dsh-forge/tools-cards
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { workdirOf, type ForgeExec } from './core.ts'
import { ensureCards, polishFacts, readPolished, recordCardRead, storePolished, suggestedDistillTarget, CARD_NAMES, type CardName } from './cards.ts'
import { polishDirective, polishViaEndpoint, stripWrappingFence, validatePolish } from './distill.ts'
import type { CardsConfig } from './config.ts'
import { storeFor } from './ledger.ts'

interface CardsValue {
  cards?: Array<{ name: string; title: string; batches: number; bytes: number; polished: boolean; reads: number }>
  card?: string
  body?: string
  source?: 'ledger' | 'model'
  note?: string
}

function text(value: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value }]
}

/** Provenance for the session path: the model that wrote the draft, as far as
 *  the tool path can honestly see it. */
function sessionLabel(exec: ForgeExec | undefined): string {
  const model = exec?.agent?.options?.model
  const id = exec?.agent?.session?.header?.id
  const parts = ['session', typeof model === 'string' && model !== '' ? model : null, typeof id === 'string' && id !== '' ? id.slice(0, 8) : null]
  return parts.filter(Boolean).join(':')
}

export function createCardsTool(cardsConfig: CardsConfig = { distill: 'session' }) {
  const modeDescription = cardsConfig.distill === 'endpoint'
    ? 'Reads may call the configured model endpoint; lists and skeleton=true never do.'
    : cardsConfig.distill === 'off'
      ? 'Model polish writes are disabled.'
      : 'The current session model can store a draft with polish=<name>, content=<markdown>.'
  return {
    name: 'ff_cards',
    description: 'Construction history cards: overview, hotspot, timeline, structure. Omit card to list; card=<name> reads the cached model draft when available. skeleton=true reads the deterministic source. Draft reference checks do not verify factual claims. ' + modeDescription,
    parameters: {
      card: { type: 'string', description: `Card to read (${CARD_NAMES.join(', ')}). Omit to list the cards.` },
      skeleton: { type: 'boolean', description: 'With card: read the deterministic source, bypassing drafts and endpoint calls.' },
      refresh: { type: 'boolean', description: 'Rebuild from the ledger even when the freshness anchor says current (drops polished drafts). Default false.' },
      polish: { type: 'string', description: 'Store a model draft for this card. Requires content. Checks backticked paths and #N batch references against the ledger; prose facts are unchecked.' },
      content: { type: 'string', description: 'Polished body markdown for polish=<name> — reorganize and reword the skeleton freely, invent nothing, no frontmatter.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cards: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                title: { type: 'string', required: true },
                batches: { type: 'integer', required: true },
                bytes: { type: 'integer', required: true },
                polished: { type: 'boolean', required: true },
                reads: { type: 'integer', required: true },
              },
            },
          },
          card: { type: 'string' },
          body: { type: 'string' },
          source: { type: 'string', enum: ['ledger', 'model'] },
          note: { type: 'string' },
        },
      },
      render: (args: unknown, value: CardsValue) => {
        const lines: string[] = []
        if (typeof value.body === 'string') {
          lines.push(`#### card ${value.card ?? ''}`, value.body)
        } else if (Array.isArray(value.cards)) {
          lines.push(`knowledge cards (${value.cards.length}):`)
          for (const card of value.cards) {
            lines.push(`- ${card.name} — ${card.title} (${card.batches} batches, ${(card.bytes / 1024).toFixed(1)}KB${card.polished ? ', polished' : ''}${card.reads > 0 ? `, read ${card.reads}×` : ''})`)
          }
        }
        if (value.note !== undefined) lines.push(`[${value.note}]`)
        return text(lines.join('\n') || 'no cards')
      },
    },
    // A refresh can drop drafts while another call awaits endpoint polish.
    // Let the host sequence these operations; per-file cache/stat locks alone
    // do not cover the full tool call.
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      exec?.signal?.throwIfAborted()
      const workspace = path.resolve(workdirOf(exec))
      if (args.skeleton !== undefined && typeof args.skeleton !== 'boolean') return { error: 'skeleton must be true or false' }
      if (args.skeleton === true && (typeof args.card !== 'string' || args.card.trim() === '' || args.polish !== undefined)) {
        return { error: 'skeleton=true requires card=<name> and cannot be used with polish' }
      }

      // --- polish write (session-model path) --------------------------------
      const wanted = typeof args.polish === 'string' && args.polish.trim() !== '' ? args.polish.trim() : undefined
      if (wanted !== undefined) {
        if (cardsConfig.distill === 'off') {
          return { error: 'card distillation is disabled (config.cards.distill: "off") — set it to "session" to enable polish writes' }
        }
        if (!(CARD_NAMES as readonly string[]).includes(wanted)) {
          return { error: `unknown card "${wanted}" — cards: ${CARD_NAMES.join(', ')}` }
        }
        const content = typeof args.content === 'string' ? args.content : undefined
        if (content === undefined || content.trim() === '') {
          return { error: `polish="${wanted}" requires content — the polished body markdown` }
        }
        const result = await ensureCards(workspace)
        if ('error' in result) return result
        if (result.empty === true || result.anchor === undefined) {
          return { error: 'no construction ledger for this workspace — nothing to polish' }
        }
        const facts = polishFacts(storeFor(workspace))
        const violations = validatePolish(content, facts)
        if (violations.length > 0) {
          return { error: `polished draft rejected by the ledger gate — ${violations.join('; ')}` }
        }
        storePolished(result.dir, wanted as CardName, result.anchor, content, sessionLabel(exec))
        await recordCardRead(result.dir, wanted)
        return {
          card: wanted,
          body: content,
          source: 'model',
          note: `stored polished "${wanted}" (anchor batches=${result.anchor.batches} lastId=${result.anchor.lastId}; discards with the next anchor move); model-generated draft, factual claims unchecked — use card="${wanted}", skeleton=true for the source`,
        }
      }

      // --- list / read ------------------------------------------------------
      if (args.content !== undefined) return { error: 'content is only read together with polish=<card name>' }
      const refresh = args.refresh === true
      const result = await ensureCards(workspace, { refresh })
      if ('error' in result) return result
      const notes: string[] = []
      if (result.empty === true) notes.push(result.note ?? 'no cards')
      if (result.regenerated.length > 0) {
        notes.push(`rebuilt from the ledger (anchor moved): ${result.regenerated.join(', ')}`)
      }
      const anchor = result.anchor
      const cardName = typeof args.card === 'string' && args.card.trim() !== '' ? args.card.trim() : undefined

      if (cardName === undefined) {
        if (result.empty === true) return { cards: [], note: notes.join('; ') }
        const cards = result.cards.map((card) => ({
          ...card,
          polished: result.polished.includes(card.name),
          reads: result.reads[card.name]?.count ?? 0,
        }))
        if (cardsConfig.distill === 'session') {
          const unpolished = cards.filter((card) => !card.polished).map((card) => card.name)
          if (unpolished.length > 0) {
            // Usage feedback into the offer: the most-read skeleton is the one
            // a re-distillation pays back the most, so it is named first.
            const target = suggestedDistillTarget(result.reads, unpolished)
            notes.push(target === null
              ? `${unpolished.length} skeleton(s) await distillation — read one, then call ff_cards {polish: "<name>", content: "<readable markdown, same facts>"}`
              : `${unpolished.length} skeleton(s) await distillation — "${target}" is the most-read; read it, then call ff_cards {polish: "${target}", content: "<readable markdown, same facts>"}`)
          }
        }
        return { cards, ...(notes.length > 0 ? { note: notes.join('; ') } : {}) }
      }

      if (!(CARD_NAMES as readonly string[]).includes(cardName)) {
        return { error: `unknown card "${cardName}" — cards: ${CARD_NAMES.join(', ')}` }
      }
      if (result.empty === true || anchor === undefined) {
        return { error: `no construction ledger for this workspace — card "${cardName}" does not exist` }
      }
      const meta = result.cards.find((card) => card.name === cardName)
      if (meta === undefined) {
        return { error: `card "${cardName}" is missing on disk — re-call with refresh=true` }
      }

      if (args.skeleton === true) {
        await recordCardRead(result.dir, cardName)
        return { card: cardName, body: readSkeleton(result.dir, cardName), source: 'ledger' }
      }

      // endpoint mode polishes on read, inline; the list never fetches.
      if (!result.polished.includes(cardName) && cardsConfig.distill === 'endpoint' && cardsConfig.endpoint !== undefined) {
        const skeleton = readSkeleton(result.dir, cardName)
        try {
          const draft = stripWrappingFence(await polishViaEndpoint(cardsConfig.endpoint, skeleton, exec?.signal))
          const violations = validatePolish(draft, polishFacts(storeFor(workspace)))
          if (violations.length > 0) throw new Error(`ledger gate rejected the draft — ${violations.join('; ')}`)
          storePolished(result.dir, cardName as CardName, anchor, draft, `endpoint:${cardsConfig.endpoint.model}`)
          notes.push(`polished via endpoint ${cardsConfig.endpoint.model}`)
        } catch (cause) {
          notes.push(`endpoint polish failed (${cause instanceof Error ? cause.message : String(cause)}) — serving the skeleton`)
        }
      }

      // Every served body counts — polished or skeleton — because the signal
      // the distill offer consumes is "the model wanted this card at all".
      await recordCardRead(result.dir, cardName)
      const polished = readPolished(result.dir, cardName, anchor)
      if (polished !== null) {
        if (!notes.some((note) => /polish/i.test(note))) {
          notes.push('polished draft served — distilled at the current anchor; re-read after the ledger moves for fresh facts')
        }
        notes.push(`model-generated draft; factual claims unchecked — use card="${cardName}", skeleton=true for the source`)
        return { card: cardName, body: polished, source: 'model', note: notes.join('; ') }
      }
      if (cardsConfig.distill === 'session') notes.push(polishDirective(cardName as CardName))
      return {
        card: cardName,
        body: readSkeleton(result.dir, cardName),
        source: 'ledger',
        ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
      }
    },
  } as const
}

function readSkeleton(dir: string, name: string): string {
  const file = path.join(dir, `${name}.md`)
  if (existsSync(file)) return readFileSync(file, 'utf8')
  return `(card "${name}" is missing on disk — re-call with refresh=true)`
}
