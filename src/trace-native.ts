import type { TraceFileFacts } from './facts.ts'

export interface FfiMatch {
  path: string
  name: string
  kind: string
  lang: string
  line?: number
  symbol?: string
  abi?: string
  format?: string
  ordinal?: number
  forwarder?: string
}
export interface FfiAnalysis { name: string; total: number; truncated: boolean; matches: FfiMatch[] }

export function indexFfi(entries: Map<string, TraceFileFacts>): Map<string, FfiMatch[]> {
  const index = new Map<string, FfiMatch[]>()
  const add = (value: FfiMatch): void => {
    const list = index.get(value.name) ?? []
    list.push(value); index.set(value.name, list)
  }
  for (const [path, facts] of entries) {
    if (facts.kind === 'source') for (const ref of facts.ffi ?? []) add({ ...ref, path })
    if (facts.kind === 'binary') for (const ref of facts.metadata.exports) add({ ...ref, path, lang: 'binary', format: facts.metadata.format })
  }
  return index
}

export function traceFfi(index: Map<string, FfiMatch[]> | undefined, name: string): { found: boolean; text: string; ffi: FfiAnalysis } {
  const matches = index?.get(name) ?? []
  return { found: matches.length > 0, ffi: { name, total: matches.length, truncated: matches.length > 100, matches: matches.slice(0, 100) }, text: [
    `## Trace ffi:${name}`,
    '- 按名称检索源码边界声明和二进制导出元数据；未验证 ABI、构建产物对应关系或跨语言调用链。',
    `### 匹配（${matches.length}）`,
    ...matches.slice(0, 30).map(ref => `- \`${ref.path}${ref.line ? ':' + ref.line : ''}\` · ${ref.lang}${ref.format ? '/' + ref.format : ''} · ${ref.kind}${ref.abi ? ' · ABI ' + ref.abi : ''}${ref.symbol && ref.symbol !== ref.name ? ' · 源符号 ' + ref.symbol : ''}${ref.ordinal !== undefined ? ' · ordinal ' + ref.ordinal : ''}${ref.forwarder ? ' → ' + ref.forwarder : ''}`),
    ...(!matches.length ? ['- 已分析范围内未找到同名声明或导出。'] : []),
    ...(matches.length > 30 ? ['- 文本展示前 30 项；结构化结果最多 100 项。'] : []),
  ].join('\n') }
}
