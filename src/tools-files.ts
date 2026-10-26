/** File and symbol transfers commit all affected raw bytes in one recoverable batch. */
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { canonicalTarget, canonicalWorkspace, within } from './fs-paths.ts'
import { observedRead, parseLineRange, type ForgeExec, workdirOf, withFileLock, withFileLocks, withNativeWrite } from './core.ts'
import { commitFiles, detectEncoding, encodeText, prepareWorkspace, putBlob, readKnownState, recordExternalState, storeFor, type FileChange, type LedgerNode } from './ledger.ts'
import { findSymbol, parseFile, normalizeText, symbolSpan, syntaxValid, detectLanguage } from './ast.ts'
import { applyEditSteps } from './edit-engine.ts'
import { isSymbolicLink } from './fs-paths.ts'

/** Leading spaces of the nearest usable line at/after the insertion point (then before),
 *  skipping the moved range in same-file moves and tab-indented lines — space re-indent only.
 *  A closing line (`}`/`)`/`]`) at the insertion point defers to the line above it. */
function referenceIndent(lines: string[], afterLine: number, skipStartLine: number, skipEndLine: number): string {
  const skipped = (zeroBased: number): boolean => zeroBased >= skipStartLine - 1 && zeroBased <= skipEndLine - 1
  for (let i = afterLine; i < lines.length; i++) {
    if (skipped(i) || lines[i].trim() === '' || /^\t/.test(lines[i])) continue
    if (/^[ \t]*[}\])]/.test(lines[i])) break
    return /^[ ]*/.exec(lines[i])![0]
  }
  for (let i = afterLine - 1; i >= 0; i--) {
    if (skipped(i) || lines[i].trim() === '' || /^\t/.test(lines[i])) continue
    return /^[ ]*/.exec(lines[i])![0]
  }
  return ''
}

/** Minimum common leading-space count over non-blank lines. */
function commonLeadingSpaces(lines: string[]): number {
  let min = Infinity
  for (const line of lines) {
    const width = /^[ ]*/.exec(line)![0].length
    if (width < min) min = width
  }
  return min === Infinity ? 0 : min
}

function required(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== 'string' || !String(args[key]).trim()) throw new Error(`${key} is required`)
  return String(args[key]).trim()
}
function read(file: string): Buffer | null {
  if (!existsSync(file)) return null
  if (!statSync(file).isFile()) throw new Error(`not a regular file: ${file}`)
  const bytes = readFileSync(file)
  if (bytes.length > 8 * 1024 * 1024) throw new Error('file operation exceeds 8MB cap')
  return bytes
}
export function createFileTool() {
  return {
    name: 'ff_file',
    description: 'Create/remove/move files, transfer code, or edit one symbol in an atomic batch recoverable with ffrollback. Paths stay inside the workspace; parents must exist. Read before writing. ' +
      'Transfers need symbol OR fromLines plus exactly one destination anchor. edit_symbol uses an exact symbol span; shared declarations and list-member deletion/move require ffedit.',
    parameters: {
      action: { type: 'string', required: true, enum: ['create', 'remove', 'move', 'copy_code', 'move_code', 'edit_symbol'], description: 'Operation; only the fields it needs are used.' },
      path: { type: 'string', required: true, description: 'File path, absolute or workspace-relative; source for move/transfers.' },
      destination: { type: 'string', description: 'Required for move/transfers.' },
      content: { type: 'string', description: 'Required for create/edit_symbol except delete: literal UTF-8 text.' },
      overwrite: { type: 'boolean', description: 'create/move: allow overwriting the destination. Default false.' },
      symbol: { type: 'string', description: 'Required for edit_symbol; transfer alternative to fromLines. Unique name from ff_read view=outline.' },
      body: { type: 'boolean', description: 'Symbol span: drop leading comment, keep signature. Default false.' },
      fromLines: { type: 'string', description: 'Transfer source range ("L10-20"); alternative to symbol.' },
      after: { type: 'integer', description: 'Transfer: insert after the original destination line; 0 = file start.' },
      before: { type: 'integer', description: 'Transfer: insert before the original destination line, 1-based.' },
      afterSymbol: { type: 'string', description: 'Transfer: insert after this unique destination symbol.' },
      beforeSymbol: { type: 'string', description: 'Transfer: insert before this unique symbol and its leading comment.' },
      indent: { type: 'string', enum: ['auto', 'none'], description: 'Transfer: auto (default) fits space indentation; none preserves it.' },
      edit: { type: 'string', enum: ['replace', 'delete', 'insert_before', 'insert_after'], description: 'Required for edit_symbol: operation on the selected span.' },
      reason: { type: 'string', required: true, description: 'Why this change; recorded in history.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      batch: { type: 'integer', required: true }, files: { type: 'array', items: { type: 'string' }, required: true },
      note: { type: 'string' },
    } }, render: (_args: unknown, value: { batch: number; files: string[]; note?: string }) => [{ type: 'text' as const,
      text: `batch #${value.batch}\n${value.files.join('\n')}${value.note ? `\n[${value.note}]` : ''}` }] },
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      try {
        const workspace = canonicalWorkspace(workdirOf(exec))
        const store = storeFor(workspace), action = required(args, 'action'), reason = required(args, 'reason')
        const requestedSource = path.resolve(workspace, required(args, 'path'))
        if (['remove', 'move', 'create'].includes(action) && isSymbolicLink(requestedSource)) {
          throw new Error('file operation refuses symbolic link identity; address the intended real file explicitly')
        }
        const source = canonicalTarget(requestedSource)
        const destination = ['move', 'copy_code', 'move_code'].includes(action) ? canonicalTarget(path.resolve(workspace, required(args, 'destination'))) : undefined
        await exec?.authorizeNativePaths?.([source, ...(destination ? [destination] : [])])
        for (const file of [source, destination].filter((file): file is string => !!file)) {
          if (!within(workspace, file)) throw new Error('file operations must stay inside the workspace')
          if (!existsSync(path.dirname(file)) || !statSync(path.dirname(file)).isDirectory()) throw new Error('destination parent must be an existing directory')
        }
        return await withFileLock(store.dir, () => withFileLocks([source, ...(destination ? [destination] : [])], async () => {
          await prepareWorkspace(store, exec)
          exec?.signal?.throwIfAborted()
          const original = await observedRead(exec, source, read)
          let changes: FileChange[]
          let transferNote: string | undefined
          switch (action) {
            case 'create':
              if (typeof args.content !== 'string') throw new Error('content is required for create')
              if (original && args.overwrite !== true) throw new Error('file already exists; explicit overwrite=true required')
              if (Buffer.byteLength(args.content) > 8 * 1024 * 1024) throw new Error('create exceeds 8MB cap')
              changes = [{ file: source, before: original, after: Buffer.from(args.content) }]
              break
            case 'remove':
              if (!original) throw new Error('file not found')
              changes = [{ file: source, before: original, after: null }]
              break
            case 'move': {
              if (!original) throw new Error('file not found')
              if (source === destination) throw new Error('source and destination must differ')
              const previous = await observedRead(exec, destination!, read)
              if (previous && args.overwrite !== true) throw new Error('destination exists; explicit overwrite=true required')
              changes = [{ file: source, before: original, after: null }, { file: destination!, before: previous, after: original }]
              break
            }
            case 'edit_symbol': {
              if (!original) throw new Error('source not found')
              const symbol = required(args, 'symbol'), operation = required(args, 'edit')
              const parsed = await parseFile(source)
              if (!parsed.value || parsed.value.partial) throw new Error(parsed.error ?? 'symbol edit requires a syntax-valid original parse')
              const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original)
              if (raw.includes('\0') || normalizeText(raw) !== parsed.value.text) throw new Error('source changed during symbol planning or is binary')
              const matches = findSymbol(parsed.value.symbols, symbol, true)
              if (matches.length !== 1) throw new Error(`symbol must be unique (${matches.length} matches); use a qualified name`)
              if (matches[0].sharedDeclaration) throw new Error('symbol shares a declaration with other names; use ffedit with an explicit target for the whole declaration')
              if (operation === 'delete' && matches[0].listMember) throw new Error('symbol is a list member requiring separator handling; use ffedit with an explicit target including its separator')
              if (operation !== 'delete' && typeof args.content !== 'string') throw new Error('content is required for symbol edit')
              const span = symbolSpan(parsed.value, matches[0], args.body === true)
              const content = operation === 'delete' ? '' : typeof args.content === 'string' ? normalizeText(args.content) : ''
              const text = parsed.value.text
              const result = operation === 'replace' || operation === 'delete' ? text.slice(0, span.start) + content + text.slice(span.end)
                : operation === 'insert_before' ? text.slice(0, span.start) + content + text.slice(span.start)
                : operation === 'insert_after' ? text.slice(0, span.end) + content + text.slice(span.end)
                : undefined
              if (result === undefined) throw new Error('invalid symbol edit operation')
              if (!await syntaxValid(result, parsed.value.lang)) throw new Error('symbol edit would produce invalid syntax; use ffedit with an explicit target for the containing declaration')
              changes = [{ file: source, before: original, after: Buffer.from(encodeText(result, detectEncoding(raw))) }]
              break
            }
            case 'copy_code':
            case 'move_code': {
              if (!original) throw new Error('source not found')
              const rawSource = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original)
              if (rawSource.includes('\0')) throw new Error('source is binary')
              const sourceTextNormalized = normalizeText(rawSource)
              const sourceLines = sourceTextNormalized === '' ? [] : sourceTextNormalized.split('\n')
              let span: { start: number; end: number }
              let sourceLang: ReturnType<typeof detectLanguage> = null
              if (args.fromLines !== undefined) {
                if (args.symbol !== undefined) throw new Error('provide either symbol or fromLines, not both')
                const range = parseLineRange(String(args.fromLines))
                if (!range) throw new Error(`fromLines must look like "L10-20" or "L10", got: ${args.fromLines}`)
                if (range.end > sourceLines.length) throw new Error(`fromLines L${range.start}-${range.end} is past EOF (${sourceLines.length} lines)`)
                span = {
                  start: range.start === 1 ? 0 : sourceLines.slice(0, range.start - 1).reduce((total, line) => total + line.length + 1, 0),
                  end: Math.min(sourceTextNormalized.length, sourceLines.slice(0, range.end).reduce((total, line) => total + line.length + 1, 0)),
                }
                sourceLang = detectLanguage(source)
              } else {
                const symbol = required(args, 'symbol')
                const parsed = await parseFile(source)
                if (!parsed.value || parsed.value.partial) throw new Error(parsed.error ?? 'code transfer requires a syntax-valid original parse')
                if (sourceTextNormalized !== parsed.value.text) throw new Error('source changed during symbol planning; retry')
                const matches = findSymbol(parsed.value.symbols, symbol, false)
                if (matches.length !== 1) throw new Error(`source symbol must be unique (${matches.length} matches); use a qualified name`)
                if (matches[0].sharedDeclaration) throw new Error('symbol shares a declaration with other names; use ffedit with an explicit target for the whole declaration')
                if (action === 'move_code' && matches[0].listMember) throw new Error('symbol is a list member requiring separator handling; use ffedit with an explicit target including its separator')
                span = symbolSpan(parsed.value, matches[0], args.body === true)
                sourceLang = parsed.value.lang
              }
              const lineStart = sourceTextNormalized.lastIndexOf('\n', span.start - 1) + 1
              const lineEndIndex = sourceTextNormalized.indexOf('\n', span.end)
              const lineEnd = lineEndIndex < 0 ? sourceTextNormalized.length : lineEndIndex
              if (!sourceTextNormalized.slice(lineStart, span.start).trim()) span.start = lineStart
              if (!sourceTextNormalized.slice(span.end, lineEnd).trim()) span.end = lineEndIndex < 0 ? lineEnd : lineEnd + 1
              const block = sourceTextNormalized.slice(span.start, span.end).replace(/\n$/, '')
              const srcStartLine = sourceTextNormalized.slice(0, span.start).split('\n').length
              const srcEndLine = sourceTextNormalized.slice(0, span.end).split('\n').length
              const previous = source === destination ? original : await observedRead(exec, destination!, read)
              const targetText = previous === null ? '' : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(previous)
              if (targetText.includes('\0')) throw new Error('destination is binary')
              const targetEnc = detectEncoding(targetText)
              const normalized = targetText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
              const destinationLines = normalized === '' ? [] : normalized.split('\n')
              const anchorCount = ['after', 'before', 'afterSymbol', 'beforeSymbol'].filter((key) => args[key] !== undefined).length
              if (anchorCount !== 1) throw new Error('provide exactly one destination anchor: after=<line> | before=<line> | afterSymbol=<name> | beforeSymbol=<name>')
              let afterLine: number
              const anchorNotes: string[] = []
              if (args.afterSymbol !== undefined || args.beforeSymbol !== undefined) {
                if (previous === null) throw new Error('symbol anchors need an existing destination file')
                const parsedDst = await parseFile(destination!)
                if (!parsedDst.value || parsedDst.value.partial) throw new Error(parsedDst.error ?? 'symbol anchor requires a syntax-valid destination parse')
                const query = String(args.afterSymbol ?? args.beforeSymbol)
                const matches = findSymbol(parsedDst.value.symbols, query, false)
                if (matches.length === 0) throw new Error(`anchor symbol "${query}" not found in destination`)
                if (matches.length > 1) {
                  throw new Error(`anchor symbol "${query}" is ambiguous in destination (${matches.length} definitions): ` +
                    matches.slice(0, 5).map((m) => `${m.qualifiedName} L${m.startLine}`).join(', ') + ' — use a qualified name or after=<line>')
                }
                const sym = matches[0]
                if (args.beforeSymbol !== undefined) {
                  afterLine = (sym.commentStartLine ?? sym.startLine) - 1
                  anchorNotes.push(`insert before ${sym.qualifiedName} at L${afterLine + 1} (incl. its leading comment)`)
                } else {
                  afterLine = sym.endLine
                  anchorNotes.push(`insert after ${sym.qualifiedName} (ends L${sym.endLine})`)
                }
              } else if (args.before !== undefined) {
                if (!Number.isInteger(args.before) || Number(args.before) < 1 || Number(args.before) > destinationLines.length + 1) {
                  throw new Error('before must be an original destination line between 1 and file end + 1')
                }
                afterLine = Number(args.before) - 1
              } else {
                const after = args.after
                if (!Number.isInteger(after) || Number(after) < 0) throw new Error('after must be an original destination line (0 for start)')
                if (Number(after) > destinationLines.length) throw new Error('after is outside the destination')
                afterLine = Number(after)
              }
              const boundary = afterLine === 0 ? 0 : Math.min(normalized.length, destinationLines.slice(0, afterLine).reduce((total, line) => total + line.length + 1, 0))
              if (source === destination && boundary > span.start && boundary < span.end) throw new Error('destination lies inside the source block')
              let inserted = block
              if (args.indent !== 'none') {
                const refIndent = referenceIndent(destinationLines, afterLine, source === destination && action === 'move_code' ? srcStartLine : -1, source === destination && action === 'move_code' ? srcEndLine : -1)
                const blockLines = block.split('\n')
                const nonBlank = blockLines.filter((line) => line.trim() !== '')
                if (nonBlank.length > 0) {
                  const base = commonLeadingSpaces(nonBlank)
                  const tabbed = blockLines.some((line) => line.trim() !== '' && /^\t/.test(line))
                  if (tabbed) {
                    anchorNotes.push('tab-indented block left as-is')
                  } else if (base !== refIndent.length) {
                    inserted = blockLines.map((line) => line.trim() === '' ? line : refIndent + line.slice(base)).join('\n')
                    anchorNotes.push(`indent adjusted: ${base} → ${refIndent.length} spaces`)
                  }
                }
              }
              const steps = [{ op: 'insert' as const, after: afterLine, text: inserted }]
              const planned = applyEditSteps(normalized, steps)
              if (!planned.ok) throw new Error(planned.reason)
              let destinationResult = planned.text
              if (action === 'move_code' && source === destination) {
                const insertionBytes = planned.text.length - normalized.length
                const offset = boundary <= span.start ? insertionBytes : 0
                destinationResult = planned.text.slice(0, span.start + offset) + planned.text.slice(span.end + offset)
              }
              changes = [{ file: destination!, before: previous, after: Buffer.from(encodeText(destinationResult, targetEnc)) }]
              if (action === 'move_code' && source !== destination) {
                const removed = sourceTextNormalized.slice(0, span.start) + sourceTextNormalized.slice(span.end)
                if (sourceLang && !await syntaxValid(removed, sourceLang)) throw new Error('source removal would produce invalid syntax; use an explicit target for the containing declaration')
                const enc = detectEncoding(rawSource)
                changes.push({ file: source, before: original, after: Buffer.from(encodeText(removed, enc)) })
              }
              const targetLanguage = detectLanguage(destination!)
              if (targetLanguage && !await syntaxValid(destinationResult, targetLanguage)) throw new Error('code transfer would produce invalid destination syntax; use an explicit target')
              if (anchorNotes.length > 0) transferNote = anchorNotes.join('; ')
              break
            }
            default: throw new Error('unknown file action')
          }
          exec?.signal?.throwIfAborted()
          return await withNativeWrite(exec, changes.map(change => change.file), () => {
            for (const change of changes) {
              const current = read(change.file)
              if ((current === null) !== (change.before === null) || current && change.before && !current.equals(change.before)) throw new Error('file changed during planning; nothing written')
            }
            const nodes: LedgerNode[] = changes.map(change => {
              const file = path.relative(store.root, change.file).split(path.sep).join('/')
              const enc = detectEncoding((change.after ?? change.before ?? Buffer.alloc(0)).toString('utf8'))
              const known = readKnownState(store, file)
              if (change.before && known && putBlob(store, change.before).id !== known.hash) recordExternalState(store, file, change.before, enc.eol, enc.bom)
              return { file, op: change.after === null ? 'delete' : change.before === null ? 'create' : 'update', before: change.before === null ? null : putBlob(store, change.before).id,
                after: change.after === null ? null : putBlob(store, change.after).id, bytes: change.after?.length ?? 0, eol: enc.eol, bom: enc.bom }
            })
            const batch = commitFiles(store, { kind: 'edit', actor: exec?.agent?.session?.header?.id ?? 'unknown', reason, nodes }, changes)
            return { batch: batch.id, files: nodes.map(node => node.file), ...(transferNote ? { note: transferNote } : {}) }
          })
        }))
      } catch (cause) { return { error: cause instanceof Error ? cause.message : String(cause) } }
    },
  } as const
}
