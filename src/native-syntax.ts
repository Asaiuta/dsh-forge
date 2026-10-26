/** Small C/C++ lexical scanner for module declarations and cgo preambles.
 * It never expands macros. Comments, strings and directives remain separate,
 * so their contents cannot masquerade as top-level module/import statements.
 */
export interface NativeToken { text: string; start: number; end: number; line: number; leading: boolean; kind: 'word' | 'string' | 'punctuation' | 'directive' }
const DIGRAPHS: Readonly<Record<string, string>> = { '<%': '{', '%>': '}', '<:': '[', ':>': ']' }

export function* nativeTokens(original: string): Generator<NativeToken> {
  // C/C++ translation phase 2 runs before comment/identifier recognition.
  // Retain a coordinate map only when splices exist; facts use physical lines.
  let source = original
  let coordinates: Uint32Array | undefined
  const lineStarts = [0]
  if (/\\\r?\n/.test(original)) {
    coordinates = new Uint32Array(original.length)
    const parts: string[] = []
    let count = 0, previous = 0
    for (const splice of original.matchAll(/\\\r?\n/g)) {
      parts.push(original.slice(previous, splice.index))
      for (let at = previous; at < splice.index; at++) coordinates[count++] = at
      previous = splice.index + splice[0].length
    }
    parts.push(original.slice(previous))
    for (let at = previous; at < original.length; at++) coordinates[count++] = at
    coordinates = coordinates.subarray(0, count)
    source = parts.join('')
    for (let at = 0; at < original.length; at++) if (original[at] === '\n') lineStarts.push(at + 1)
  }
  let i = 0, line = 1, lineStart = true, tokenLeading = true
  const lowerBound = (values: readonly number[] | Uint32Array, value: number): number => {
    let lo = 0, hi = values.length
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid] < value) lo = mid + 1; else hi = mid }
    return lo
  }
  const emit = (start: number, row: number, kind: NativeToken['kind']): NativeToken => {
    const offset = coordinates?.[start] ?? start
    return { text: source.slice(start, i), start: offset,
      end: coordinates ? (coordinates[i - 1] ?? original.length - 1) + 1 : i,
      line: coordinates ? lowerBound(lineStarts, offset + 1) : row, leading: tokenLeading, kind }
  }
  const advance = (end: number): void => {
    while (i < end) {
      if (source[i] === '\n') { line++; lineStart = true }
      else if (!/[\t\r ]/.test(source[i])) lineStart = false
      i++
    }
  }
  while (i < source.length) {
    const char = source[i], start = i, row = line
    tokenLeading = lineStart
    if (/\s/.test(char)) { advance(i + 1); continue }
    if (source.startsWith('//', i)) {
      // Backslash-newline continues a C++ line comment.
      let end = i
      do { end = source.indexOf('\n', end + 1); if (end < 0) end = source.length }
      while (end < source.length && source[end - 1] === '\\')
      advance(end); continue
    }
    if (source.startsWith('/*', i)) {
      const leading: boolean = lineStart, initialLine = line, end = source.indexOf('*/', i + 2)
      advance(end < 0 ? source.length : end + 2)
      lineStart = leading || line > initialLine
      continue
    }
    if ((char === '#' || source.startsWith('%:', i)) && lineStart) {
      let end = i
      do { end = source.indexOf('\n', end + 1); if (end < 0) end = source.length }
      while (end < source.length && source[end - 1] === '\\')
      advance(end)
      yield emit(start, row, 'directive')
      continue
    }
    const raw = /^(?:u8|u|U|L)?R"([^\s()\\]{0,16})\(/.exec(source.slice(i, i + 24))
    if (raw) {
      // Raw contents undo phase-2 splicing. Search physical bytes so a splice
      // cannot manufacture an earlier closing delimiter and expose fake code.
      const quote = i + raw[0].indexOf('"'), physicalQuote = coordinates?.[quote] ?? quote
      const physicalOpening = /^"([^\s()\\]{0,16})\(/.exec(original.slice(physicalQuote, physicalQuote + 20))
      const closing = ')' + raw[1] + '"'
      const end = physicalOpening?.[1] === raw[1] ? original.indexOf(closing, physicalQuote + physicalOpening[0].length) : -1
      const physicalEnd = end < 0 ? original.length : end + closing.length
      advance(coordinates ? lowerBound(coordinates, physicalEnd) : physicalEnd)
      yield emit(start, row, 'string')
      continue
    }
    const quoted = /^(?:u8|u|U|L)?(["'])/.exec(source.slice(i, i + 4))
    if (quoted) {
      let end = i + quoted[0].length
      while (end < source.length) {
        if (source[end] === '\\') { end += 2; continue }
        if (source[end++] === quoted[1]) break
      }
      advance(Math.min(end, source.length))
      yield emit(start, row, 'string')
      continue
    }
    if (/\d/.test(char)) {
      let end = i + 1
      while (end < source.length && (/[A-Za-z_\d.]/.test(source[end]) || source[end] === "'" && /[A-Za-z_\d]/.test(source[end + 1] ?? ''))) end++
      advance(end)
      yield emit(start, row, 'word')
    } else if (/[A-Za-z_]/.test(char)) {
      let end = i + 1
      while (end < source.length && /[A-Za-z_\d]/.test(source[end])) end++
      advance(end)
      yield emit(start, row, 'word')
    } else {
      const digraph = source.slice(i, i + 2)
      // <:: is the standard exception to the <: maximal-munch rule.
      const mapped = digraph === '<:' && source[i + 2] === ':' && ![':', '>'].includes(source[i + 3] ?? '') ? undefined : DIGRAPHS[digraph]
      advance(i + (mapped ? 2 : 1))
      yield { ...emit(start, row, 'punctuation'), ...(mapped ? { text: mapped } : {}) }
    }
  }
}

/** Literal include syntax only, after removing C comments and line splices. */
export function nativeInclude(token: NativeToken): { spec: string; mode: 'quote' | 'system' | 'dynamic' } | null {
  if (token.kind !== 'directive') return null
  const source = token.text.replace(/\\\r?\n/g, '')
  // Tokenize the payload so comments, quoted // and escaped quotes stay distinct.
  const head = /^(?:#|%:)\s*include\b/.exec(source)
  if (!head) return null
  const body = source.slice(head[0].length), tokens = [...nativeTokens(body)]
  if (tokens.length === 1 && tokens[0].kind === 'string' && /^"[^"\\\r\n]+"$/.test(tokens[0].text)) return { spec: tokens[0].text.slice(1, -1), mode: 'quote' }
  if (tokens[0]?.text === '<' && tokens.at(-1)?.text === '>') {
    const spec = body.slice(tokens[0].end, tokens.at(-1)!.start)
    if (spec && !/[<>\r\n]/.test(spec)) return { spec, mode: 'system' }
  }
  return { spec: body.trim().slice(0, 80) || '…', mode: 'dynamic' }
}
