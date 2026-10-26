/**
 * dsh-forge ambiguity tickets (stage 3). When a target step matches several
 * locations, ffedit does NOT guess: it signs a ticket holding the full batch
 * payload plus annotated candidates, and the model answers by resending ffedit
 * carrying only the ticket id and a choice index — no content re-send.
 *
 * Persistence decision (user): tickets live under ~/.dsh/forge/tickets/ as
 * one JSON file each, 24h expiry — restart-safe (fixing PF's memory-only
 * known issue) with zero workspace pollution.
 *
 * Resolution contract: every decision binds to the same raw-file hash.
 * Changed content invalidates all previous choices; replanning may offer a
 * fresh ticket, but never commits a newly unique target automatically.
 *
 * @module dsh-forge/tickets
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataDir } from './core.ts'
import { atomicWrite } from './ledger.ts'
import type { EditStep, StepCandidate } from './edit-engine.ts'

export const TICKET_TTL_MS = 24 * 60 * 60 * 1000

export interface TicketCandidate extends StepCandidate {
  /** 1-based inclusive range of the matched block in current content. */
  start: number
  end: number
  /** Innermost enclosing symbol (stage-2 AST), when the file is a supported language. */
  symbol?: string | null
  /** First line of the block, clipped — enough to eyeball the choice. */
  preview: string
}

export interface TicketPayload {
  /** Absolute file path the batch targets. */
  file: string
  /** The full original step list (unchanged — a ticket reply replays it). */
  steps: EditStep[]
  /** Index of the ambiguous target step. */
  stepIndex: number
  candidates: TicketCandidate[]
  reason: string
  mode: 'atomic'
  /** Persisted so a ticket replay keeps the refusal policy of the original call. */
  revertOnSyntaxError?: boolean
  /** Bind the whole original snapshot; choices cannot silently retarget. */
  sourceHash: string
  workdir: string
  decisions: Array<StepCandidate & { stepIndex: number }>
}

export interface Ticket extends TicketPayload {
  id: string
  createdAt: number
  expiresAt: number
}

function ticketsDir(): string {
  return path.join(dataDir(), 'tickets')
}

function ticketFile(id: string): string {
  return path.join(ticketsDir(), `${id}.json`)
}

export function newTicketId(): string {
  return `forge_t${randomUUID().replaceAll('-', '')}`
}

/** Remove expired tickets (mtime-based — cheap, no parse). */
export function sweepExpired(): number {
  const dir = ticketsDir()
  if (!existsSync(dir)) return 0
  let removed = 0
  const now = Date.now()
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue
    const file = path.join(dir, entry)
    try {
      if (now - statSync(file).mtimeMs > TICKET_TTL_MS) {
        unlinkSync(file)
        removed++
      }
    } catch {
      // raced delete — ignore
    }
  }
  return removed
}

export function createTicket(payload: TicketPayload): Ticket {
  mkdirSync(ticketsDir(), { recursive: true })
  sweepExpired()
  const now = Date.now()
  const ticket: Ticket = {
    ...payload,
    id: newTicketId(),
    createdAt: now,
    expiresAt: now + TICKET_TTL_MS,
  }
  atomicWrite(ticketFile(ticket.id), JSON.stringify(ticket))
  return ticket
}

export function loadTicket(id: string): Ticket | { error: string } {
  if (!/^forge_t[0-9a-z]+$/.test(id)) return { error: `malformed ticket id "${id}"` }
  const file = ticketFile(id)
  if (!existsSync(file)) {
    return { error: `ticket ${id} not found (expired after 24h or already resolved) — re-send the ffedit call` }
  }
  try {
    const ticket = JSON.parse(readFileSync(file, 'utf8')) as Ticket
    if (ticket.id !== id || typeof ticket.file !== 'string' || typeof ticket.workdir !== 'string'
      || typeof ticket.sourceHash !== 'string' || !Array.isArray(ticket.steps)
      || !Array.isArray(ticket.candidates) || !Array.isArray(ticket.decisions)
      || !Number.isInteger(ticket.stepIndex) || !ticket.steps[ticket.stepIndex]
      || !Number.isFinite(ticket.expiresAt)) {
      return { error: `ticket ${id} has an invalid or obsolete payload — re-send ffedit` }
    }
    if (Date.now() > ticket.expiresAt) {
      unlinkSync(file)
      return { error: `ticket ${id} expired — re-send the ffedit call` }
    }
    return ticket
  } catch (cause) {
    return { error: `ticket ${id} is corrupted (${cause instanceof Error ? cause.message : String(cause)}) — re-send the ffedit call` }
  }
}

export function deleteTicket(id: string): void {
  try {
    unlinkSync(ticketFile(id))
  } catch {
    // already gone — fine
  }
}

/** Live ticket count for /forge-status. */
export function countTickets(): number {
  const dir = ticketsDir()
  if (!existsSync(dir)) return 0
  try {
    return readdirSync(dir).filter((e) => e.endsWith('.json')).length
  } catch {
    return 0
  }
}
