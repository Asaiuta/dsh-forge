/** Immutable oversized receipts live with their workspace history, outside blob GC. */
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import type { StorePaths } from './ledger.ts'

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
export function archiveOutputReceipt(store: StorePaths, value: unknown): string {
 const bytes = Buffer.from(JSON.stringify(value)), id = digest(bytes), dir = path.join(store.dir, 'receipts')
 mkdirSync(dir, { recursive: true })
 const temp = path.join(dir, `${id}.${randomBytes(8).toString('hex')}.tmp`)
 try { writeFileSync(temp, gzipSync(bytes)); renameSync(temp, path.join(dir, `${id}.gz`)) }
 finally { rmSync(temp, { force: true }) }
 return id
}
export function readOutputReceipt(store: StorePaths, id: string): string {
 if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('receiptRef must be a full SHA-256 hash')
 const bytes = gunzipSync(readFileSync(path.join(store.dir, 'receipts', `${id}.gz`)))
 if (digest(bytes) !== id) throw new Error('receipt snapshot hash mismatch')
 return bytes.toString('utf8')
}
