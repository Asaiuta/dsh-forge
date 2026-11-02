/**
 * 参数卫生：为 strict 化的上游（Responses/Codex 后端）兜底。
 *
 * 这类上游把 function schema 的每个 property 都当必填，模型于是把整张参数表
 * 补齐——`choice: ""`、`steps: []`、`edit: "replace"`、`indent: "auto"` 一起塞进来。
 * 补出来的值不携带意图，只是形状；若按「显式传入」对待，每一次正常调用都会被
 * 误判成误用（实测：一次会话 17 次 ff_edit 全部拒绝，无一落盘）。
 *
 * 全部规则只有这一处，工具自身不写任何归一代码：每个工具在定义里交一张
 * `hygiene` 声明，`defineForgeTool` 统一执行。新工具不声明也能吃到通用部分。
 *
 * 收窄原则：只归一空值与缺省形态，非默认值照旧触发原有的严格拒绝。
 */

/** 一个工具的参数卫生声明；省略即只吃通用规则。 */
export interface ArgHygiene {
  /** 空串有语义、不能删的字段（`replaceWith: ""` 是删除匹配块）。 */
  keepEmpty?: readonly string[]
  /** 0 表示「没有选择」的数值字段（1-based 的批号之类）。 */
  zeroMeansAbsent?: readonly string[]
  /** 决定互斥分组的字段名。 */
  modeField?: string
  /** 从参数本身推导模式（target 前缀这类没有独立字段的情形）。 */
  modeFrom?: (args: Record<string, unknown>) => string
  /** 字段 → 允许它存在的模式；模式确定且不在列表里就删除，不看值。 */
  onlyIn?: Record<string, readonly string[]>
  /** 同上，但只在值等于 `defaults[字段]` 时删除；非缺省值仍是真实误用。 */
  defaultOnlyIn?: Record<string, readonly string[]>
  /** 缺省形态表，供 `defaultOnlyIn` / `requires` 判断。 */
  defaults?: Record<string, unknown>
  /** 字段 → 它依赖的字段；依赖不存在且值为缺省形态时删除。 */
  requires?: Record<string, string>
}

function isBlankString(value: string): boolean {
  return value.trim() === ''
}

/** 空值形态：空串（含纯空白）或空数组。 */
export function isEmptyArg(value: unknown): boolean {
  if (typeof value === 'string') return isBlankString(value)
  return Array.isArray(value) && value.length === 0
}

function drop(args: Record<string, unknown>, key: string): void {
  delete args[key]
}

/**
 * 通用归一。模式未确定（比如 view 传了非法值）时只做空值清理，不动互斥字段：
 * 让工具自己报那条更准确的错误。
 */
export function cleanArgs(input: Record<string, unknown>, hygiene?: ArgHygiene): Record<string, unknown> {
  const args = { ...input }
  const keep = new Set(hygiene?.keepEmpty ?? [])
  const zero = new Set(hygiene?.zeroMeansAbsent ?? [])
  const defaults = hygiene?.defaults ?? {}
  const isDefault = (key: string) => key in defaults && Object.is(args[key], defaults[key])

  for (const key of Object.keys(args)) {
    if (keep.has(key)) continue
    if (zero.has(key) && args[key] === 0) {
      // 选择器补成 0 与「没选」同义；宁可报「请指定一个选择」，也不拿 0 去执行。
      drop(args, key)
      continue
    }
    if (isEmptyArg(args[key])) drop(args, key)
  }

  const mode = hygiene?.modeFrom
    ? hygiene.modeFrom(args)
    : hygiene?.modeField
      ? String(args[hygiene.modeField] ?? '')
      : ''

  if (mode !== '') {
    for (const [key, modes] of Object.entries(hygiene?.onlyIn ?? {})) {
      if (key in args && !modes.includes(mode)) drop(args, key)
    }
    for (const [key, modes] of Object.entries(hygiene?.defaultOnlyIn ?? {})) {
      if (key in args && !modes.includes(mode) && isDefault(key)) drop(args, key)
    }
  }

  for (const [key, dependsOn] of Object.entries(hygiene?.requires ?? {})) {
    if (key in args && !(dependsOn in args) && isDefault(key)) drop(args, key)
  }

  return args
}
