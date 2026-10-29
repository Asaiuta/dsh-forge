/**
 * Bridge diffing: did this change remove something a consumer still calls?
 *
 * The post-edit audit (M0.2) answers the cheap version of this question by
 * searching shipped text for a name. That is a prefilter, not a verdict: a name
 * in a comment hides a real miss, and a same-named object in an unrelated file
 * invents one. This module is the verdict, and it is built to be wrong in the
 * safe direction.
 *
 * Three ideas hold it together:
 *
 *   - **Identity, not names.** A provider side is `{file, object, site}` — the
 *     `exposeInMainWorld` call's own span, not the string it exposes. A consumer
 *     site is `{file, range, object, member}`. Two calls on one line are two
 *     sites; collapsing them to a line is how a check reports one and drops the
 *     other.
 *
 *   - **Every conclusion names its input.** A finding says which before-baseline
 *     and which after-state produced it. `new` means "not present before, present
 *     now"; `existing` means "the baseline already had it"; `unknown` means the
 *     evidence could not decide. None of them is guessed from line numbers: a
 *     moved line must not look like a new defect, nor make an old one vanish.
 *
 *   - **Silence is not success.** Dynamic members, spreads, runtime registration
 *     and a provider that cannot be pinned to one page all downgrade the run to
 *     `partial` with the reason attached. `passed` requires a complete, decidable
 *     scope; it never means "we did not look".
 *
 * The rule set stays deliberately small (expose member missing, global missing,
 * IPC endpoint missing, IPC method mismatch). A general type system is M2's job,
 * and pretending otherwise here would produce confident nonsense.
 *
 * @module dsh-forge/bridge-check
 */

import { scriptFacts, spanKey, type AliasFact, type FactSpan, type IpcFact, type ExposeFact, type BridgeFact, type TraceFileFacts } from './facts.ts'

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** One `contextBridge.exposeInMainWorld` call, addressed by file + span. */
export interface ProviderSide {
  providerFile: string
  /** The global it installs, or a placeholder when the name is dynamic. */
  object: string
  /** `exposeInMainWorld(<arg>)` is an identifier/expression, not a literal. */
  dynamicName: boolean
  /** Members the object literal declares. Lower bound when `partial`. */
  members: string[]
  /** A spread or computed key means `members` is not the whole surface. */
  partial: boolean
  site: FactSpan | undefined
  line: number
}

/** One `api.member` use of an exposed global. */
export interface ConsumerSite {
  file: string
  /** Root object after alias resolution (`api` → `chartAPI`). */
  object: string
  /** The name the source actually wrote, before alias resolution. */
  written: string
  member: string
  line: number
  site: FactSpan | undefined
  symbol?: string
  /** The member was reached through a local alias (`const api = window.x`). */
  viaAlias: boolean
  /** The alias is reassigned, so the receiver is not fixed: no provider can be
   *  bound with confidence and the run must say so. */
  uncertain: boolean
  /** 0-based offset of the occurrence within its line, to key same-line sites. */
  column: number
}

/** One statically visible IPC endpoint. */
export interface IpcSite {
  file: string
  side: 'register' | 'call' | 'push'
  method: string
  channel: string | null
  via: IpcFact['via']
  line: number
  site: FactSpan | undefined
  symbol?: string
  /** The channel argument was not statically resolvable. */
  dynamic: boolean
}

export interface BridgeModel {
  workspace: string
  providers: ProviderSide[]
  consumers: ConsumerSite[]
  ipc: IpcSite[]
  /** Facts that carried no span: their sites can only be compared by line. */
  unsourcedSites: number
  /** Files contributing facts, for coverage reporting. */
  files: number
}

/** How the provider→consumer binding was decided. */
export type Binding = 'declared' | 'alias' | 'ambiguous' | 'unknown'

export interface BridgeDiffInput {
  /** Workspace root; snapshots never cross it. */
  workspace: string
  before: BridgeModel | null
  after: BridgeModel
  /** Files this operation touched. Consumers elsewhere are still checked. */
  changed: readonly string[]
  /** Kinds of check to run. Defaults to both. */
  checks?: readonly CheckKind[]
}

export type CheckKind = 'bridge' | 'ipc'

export type FindingKind = 'expose_member_missing' | 'expose_global_missing' | 'ipc_endpoint_missing' | 'ipc_method_mismatch'

/** Why a finding belongs to this change rather than to the baseline. */
export type Attribution = 'new' | 'existing' | 'unknown'

export interface Finding {
  kind: FindingKind
  /** `new` — introduced by this change; `existing` — already broken before. */
  attribution: Attribution
  /** The consumer that would now fail to resolve. */
  consumer: { file: string; line: number; site: string; member: string; symbol?: string }
  /** What it expected, and what the provider side now offers. */
  expected: { object: string; member: string }
  provider: { file: string; site: string } | null
  /** The IPC channel and endpoint when the finding is an IPC one. */
  channel?: string
  detail: string
}

export type CheckStatus = 'passed' | 'failed' | 'partial'

export interface Limitation {
  code:
    | 'no_baseline'
    | 'no_spans'
    | 'dynamic_member'
    | 'dynamic_channel'
    | 'ambiguous_provider'
    | 'unknown_binding'
    | 'unsupported_file'
    | 'incomplete_scan'
  file?: string
  line?: number
  detail: string
}

export interface CheckResult {
  status: CheckStatus
  checks: CheckKind[]
  /** Findings, newest-cause first: `new` then `unknown` then `existing`. */
  findings: Finding[]
  limitations: Limitation[]
  coverage: {
    providers: number
    consumers: number
    ipc: number
    files: number
    /** Consumers whose object could be bound to exactly one provider. */
    boundConsumers: number
    /** True when both sides were read with range identity. */
    ranged: boolean
    /** Whether a before-baseline was available at all. */
    baseline: boolean
  }
  /** One-line verdict for a human, never a boolean. */
  verdict: string
}

// ---------------------------------------------------------------------------
// Model construction
// ---------------------------------------------------------------------------

const IPC_SYNTAX = /\b(ipcRenderer|ipcMain|webContents)\b/

/** Build the model from already-extracted facts. No parsing, no IO. */
export function bridgeModel(input: { workspace: string; files: Iterable<[string, TraceFileFacts]> }): BridgeModel {
  const model: BridgeModel = { workspace: input.workspace, providers: [], consumers: [], ipc: [], unsourcedSites: 0, files: 0 }
  for (const [file, entry] of input.files) {
    const facts = scriptFacts(entry)
    if (!facts) continue
    model.files++
    for (const expose of facts.exposes) {
      model.providers.push(providerOf(file, expose))
      if (!expose.span) model.unsourcedSites++
    }
    for (const bridge of facts.bridge) {
      if (bridge.receiver?.local) continue
      model.consumers.push(consumerOf(file, bridge, facts.bridgeAliases))
      if (!bridge.span) model.unsourcedSites++
    }
    for (const fact of facts.ipc) {
      model.ipc.push(ipcOf(file, fact))
      if (!fact.span) model.unsourcedSites++
    }
  }
  return model
}


function providerOf(file: string, expose: ExposeFact): ProviderSide {
  return {
    providerFile: file,
    object: expose.name,
    dynamicName: expose.dynamic === true,
    members: [...expose.keys],
    partial: expose.partial === true || (expose.keySource === undefined && !expose.dynamic),
    site: expose.span,
    line: expose.line,
  }
}

function consumerOf(file: string, bridge: BridgeFact, aliases: readonly AliasFact[]): ConsumerSite {
  const receiver = bridge.receiver
  // Older/native facts have no occurrence binding. A matching alias name alone
  // cannot decide its receiver and must remain unknown.
  const unboundAlias = receiver === undefined && aliases.some(alias => alias.name === bridge.object)
  return {
    file,
    object: receiver?.object ?? bridge.object,
    written: bridge.object,
    member: bridge.name,
    line: bridge.line,
    site: bridge.span,
    ...(bridge.symbol ? { symbol: bridge.symbol } : {}),
    viaAlias: receiver?.viaAlias ?? unboundAlias,
    uncertain: receiver?.uncertain ?? unboundAlias,
    column: bridge.span?.start.column ?? 0,
  }
}

function ipcOf(file: string, fact: IpcFact): IpcSite {
  return {
    file,
    side: fact.side,
    method: fact.method,
    channel: fact.channel,
    via: fact.via,
    line: fact.line,
    site: fact.span,
    ...(fact.symbol ? { symbol: fact.symbol } : {}),
    dynamic: fact.channel === null,
  }
}

/** Stable identity for one site: file plus span, or file+line when there is none. */
export function siteKey(site: { file: string; line: number; site: FactSpan | undefined }): string {
  return `${site.file}#${site.site ? spanKey(site.site) : `L${site.line}`}`
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

/** Which IPC method answers which, per side. Explicit because a name match is
 *  not semantics: `invoke` is answered by `handle`, `send` by `on`. */
const IPC_PAIRS: ReadonlyArray<{ caller: 'call' | 'push'; methods: readonly string[]; answerSides: readonly ('register' | 'push')[]; answerMethods: readonly string[] }> = [
  { caller: 'call', methods: ['invoke'], answerSides: ['register'], answerMethods: ['handle', 'handleOnce'] },
  { caller: 'call', methods: ['send', 'sendSync'], answerSides: ['register'], answerMethods: ['on', 'once'] },
  { caller: 'push', methods: ['send'], answerSides: ['push'], answerMethods: ['on', 'once'] },
]

/**
 * Compare an after-state against a before-baseline.
 *
 * `before === null` is allowed and means "no baseline". It does not mean "no
 * findings": it means every finding is `unknown` attribution, because the module
 * cannot claim a defect is new without having seen the old state. That
 * distinction is the difference between a useful check and a false alarm.
 */
export function diffBridges(input: BridgeDiffInput): CheckResult {
  const checks = input.checks && input.checks.length > 0 ? [...new Set(input.checks)] : (['bridge', 'ipc'] as CheckKind[])
  const limitations: Limitation[] = []
  const findings: Finding[] = []
  const baseline = input.before

  if (!baseline) {
    limitations.push({ code: 'no_baseline', detail: '没有内容基线：只能报告当前状态，无法区分“本次引入”与“基线已有”' })
  }
  if (input.after.unsourcedSites > 0 || (baseline && baseline.unsourcedSites > 0)) {
    limitations.push({
      code: 'no_spans',
      detail: `${(input.after.unsourcedSites + (baseline?.unsourcedSites ?? 0))} 个事实没有范围（来自未同步 span 的原生路径），同一行的多个站点只能按行合并`,
    })
  }

  const bound = bindProviders(input.after, limitations)
  const beforeConsumers = baseline ? new Set(baseline.consumers.map(consumerKey)) : null

  if (checks.includes('bridge')) {
    findings.push(...diffBridgeSurface(input.after, baseline, bound, beforeConsumers, limitations))
  }
  if (checks.includes('ipc')) {
    findings.push(...diffIpc(input.after, baseline, limitations))
  }

  const ranged = input.after.unsourcedSites === 0 && (!baseline || baseline.unsourcedSites === 0)
  const newCount = findings.filter(finding => finding.attribution === 'new').length
  const unknownCount = findings.filter(finding => finding.attribution === 'unknown').length
  const existingCount = findings.filter(finding => finding.attribution === 'existing').length
  // `passed` means "this code is fine", not "this change is not to blame". A
  // finding the baseline already had is still a broken call today, so the run is
  // `partial`: real problems, none of them this change's doing. Only an
  // undamaged, fully-decidable scope earns `passed`.
  const status: CheckStatus = findings.some(finding => finding.attribution === 'new')
    ? 'failed'
    : findings.length > 0 || limitations.length > 0 ? 'partial' : 'passed'

  const verdict = findings.length === 0
    ? (limitations.length > 0
      ? `未发现遗漏，但范围不完整（${limitations.map(item => item.code).join('、')}），不能称为通过`
      : `检查通过：${input.after.providers.length} 个提供面、${input.after.consumers.length} 个消费站点、${input.after.ipc.length} 个 IPC 端点全部解析`)
    : `${newCount} 处本次引入、${unknownCount} 处无法归属、${existingCount} 处基线已有`

  return {
    status,
    checks,
    findings: orderFindings(findings),
    limitations,
    coverage: {
      providers: input.after.providers.length,
      consumers: input.after.consumers.length,
      ipc: input.after.ipc.length,
      files: input.after.files,
      boundConsumers: bound.bound,
      ranged,
      baseline: baseline !== null,
    },
    verdict,
  }
}

function orderFindings(findings: Finding[]): Finding[] {
  // New first: a caller that reads one line of the reply should see what this
  // change broke, not what was already broken before it started.
  const rank: Record<Attribution, number> = { new: 0, unknown: 1, existing: 2 }
  return [...findings].sort((a, b) => rank[a.attribution] - rank[b.attribution])
}

/**
 * Bind each consumer object to exactly one provider.
 *
 * Two preloads exposing the same global from different files is `ambiguous` —
 * which one a page sees depends on script order and page membership, neither of
 * which facts carry. Picking one would produce a confident answer about a
 * binding the module cannot know, so it refuses instead.
 */
function bindProviders(model: BridgeModel, limitations: Limitation[]): { bound: number; byObject: Map<string, ProviderSide | null> } {
  const byObject = new Map<string, ProviderSide | null>()
  for (const provider of model.providers) {
    if (provider.dynamicName) {
      limitations.push({ code: 'ambiguous_provider', file: provider.providerFile, line: provider.line, detail: 'exposeInMainWorld 的名称是动态表达式，无法按名字绑定消费者' })
      continue
    }
    const existing = byObject.get(provider.object)
    if (existing === null) continue
    if (existing === undefined) { byObject.set(provider.object, provider); continue }
    // A second provider for the same global: remember the ambiguity permanently.
    byObject.set(provider.object, null)
    limitations.push({
      code: 'ambiguous_provider', file: provider.providerFile, line: provider.line,
      detail: `全局 ${provider.object} 由多个文件提供（${existing.providerFile} 与 ${provider.providerFile}），无法按页面确定哪一个生效`,
    })
  }
  let bound = 0
  for (const consumer of model.consumers) if (!consumer.uncertain && byObject.get(consumer.object)) bound++
  return { bound, byObject }
}

function diffBridgeSurface(
  after: BridgeModel,
  baseline: BridgeModel | null,
  bound: { byObject: Map<string, ProviderSide | null> },
  beforeConsumers: Set<string> | null,
  limitations: Limitation[],
): Finding[] {
  const findings: Finding[] = []
  // Members the baseline offered, per object. `null` means "the baseline could
  // not enumerate this object", which must not be read as "it offered nothing".
  const beforeSurface = baseline ? surfaceOf(baseline) : null

  for (const consumer of after.consumers) {
    if (consumer.uncertain) {
      limitations.push({
        code: 'unknown_binding', file: consumer.file, line: consumer.line,
        detail: `${consumer.written} 的词法绑定被重新赋值、动态选择或无法解析，不能确定 ${consumer.member} 落在哪个对象上`,
      })
      continue
    }
    const provider = bound.byObject.get(consumer.object)
    if (provider === undefined) {
      // No provider in this workspace at all. Outside a preload tree that is
      // normal (a page calling a browser global); inside one it is a finding.
      const anyProvider = after.providers.length > 0
      if (anyProvider) {
        limitations.push({
          code: 'unknown_binding', file: consumer.file, line: consumer.line,
          detail: `${consumer.object} 在当前工作区没有可绑定的提供者（可能是浏览器全局、来自未收录脚本，或提供者名称是动态表达式）`,
        })
      }
      continue
    }
    if (provider === null) continue
    if (provider.partial) {
      limitations.push({ code: 'dynamic_member', file: provider.providerFile, line: provider.line, detail: `${provider.object} 的成员集合含 spread/计算属性，只能作为下界` })
      continue
    }
    if (provider.members.includes(consumer.member)) continue
    findings.push({
      kind: 'expose_member_missing',
      attribution: attributeMember(beforeSurface, beforeConsumers, consumer),
      consumer: { file: consumer.file, line: consumer.line, site: siteKey(consumer), member: consumer.member, ...(consumer.symbol ? { symbol: consumer.symbol } : {}) },
      expected: { object: consumer.object, member: consumer.member },
      provider: { file: provider.providerFile, site: provider.site ? spanKey(provider.site) : `L${provider.line}` },
      detail: `${provider.providerFile} 暴露的 ${consumer.object} 没有成员 ${consumer.member}`,
    })
  }

  // A global that a page still uses after the provider disappeared entirely.
  if (baseline) {
    const beforeObjects = new Set(baseline.providers.filter(provider => !provider.dynamicName).map(provider => provider.object))
    const afterObjects = new Set(after.providers.filter(provider => !provider.dynamicName).map(provider => provider.object))
    for (const object of beforeObjects) {
      if (afterObjects.has(object)) continue
      const orphaned = after.consumers.filter(consumer => consumer.object === object && !consumer.uncertain)
      if (orphaned.length === 0) continue
      const beforeProvider = baseline.providers.find(provider => provider.object === object)
      // One finding per site, not one per global: each orphaned call is a place a
      // reader has to go and fix, and collapsing them to a count with a "3 more
      // not listed" note is how the third one gets missed.
      for (const consumer of orphaned) {
        findings.push({
          kind: 'expose_global_missing',
          attribution: 'new',
          consumer: { file: consumer.file, line: consumer.line, site: siteKey(consumer), member: consumer.member, ...(consumer.symbol ? { symbol: consumer.symbol } : {}) },
          expected: { object, member: consumer.member },
          provider: beforeProvider ? { file: beforeProvider.providerFile, site: beforeProvider.site ? spanKey(beforeProvider.site) : `L${beforeProvider.line}` } : null,
          detail: `全局 ${object} 之前由 ${beforeProvider?.providerFile ?? '未知文件'} 提供，现在没有提供者；此处仍调用 ${object}.${consumer.member}`,
        })
      }
    }
  }
  return findings
}

/** Members the baseline offered per object; `null` marks a non-enumerable one. */
function surfaceOf(model: BridgeModel): Map<string, Set<string> | null> {
  const surface = new Map<string, Set<string> | null>()
  for (const provider of model.providers) {
    if (provider.dynamicName) continue
    const current = surface.get(provider.object)
    if (current === null) continue
    if (provider.partial) { surface.set(provider.object, null); continue }
    if (current === undefined) surface.set(provider.object, new Set(provider.members))
    else surface.set(provider.object, null)
  }
  return surface
}

/**
 * Is this missing member new, or was it already missing before?
 *
 * Attribution is by member identity, never by line: the same broken call moved
 * by a few lines is the same broken call. `unknown` is reserved for "the
 * baseline had this consumer but could not tell whether the member was there",
 * which happens when the baseline's provider surface was not enumerable.
 */
function attributeMember(
  beforeSurface: Map<string, Set<string> | null> | null,
  beforeConsumers: Set<string> | null,
  consumer: ConsumerSite,
): Attribution {
  if (!beforeSurface) return 'unknown'
  const surface = beforeSurface.get(consumer.object)
  if (surface === undefined) return 'unknown'
  if (surface === null) return 'unknown'
  // The provider used to offer it and no longer does: this change removed it.
  if (surface.has(member_keyOf(consumer.member))) return 'new'
  // The provider never offered it. Then the question is whether the *call* is
  // new: a consumer that already called a missing member is damaged evidence,
  // not this change's doing; a call this batch added is the change's own doing
  // even though the member was never there.
  const key = consumerKey(consumer)
  if (beforeConsumers === null) return 'unknown'
  return beforeConsumers.has(key) ? 'existing' : 'new'
}

function member_keyOf(member: string): string { return member }

/** Identity of a consumer as "this file calls this object.member". Span is not
 *  used: an edit that moves the call a few lines is still the same breakage. */
function consumerKey(consumer: { file: string; object: string; member: string }): string {
  return `${consumer.file}|${consumer.object}|${consumer.member}`
}

function diffIpc(after: BridgeModel, baseline: BridgeModel | null, limitations: Limitation[]): Finding[] {
  const findings: Finding[] = []
  const registrations = after.ipc.filter(site => site.side === 'register' || site.side === 'push')
  const beforeCallers = baseline ? new Set(baseline.ipc.map(ipcCallerKey)) : null
  for (const site of registrations) if (site.method === 'removeHandler') limitations.push({
    code: 'dynamic_channel', file: site.file, line: site.line,
    detail: 'removeHandler 改变运行时注册状态，无法只凭静态声明判断端点是否仍有效',
  })

  for (const caller of after.ipc) {
    if (caller.side !== 'call' && caller.side !== 'push') continue
    if (caller.side === 'push' && (caller.method === 'on' || caller.method === 'once')) continue
    if (caller.dynamic) {
      limitations.push({ code: 'dynamic_channel', file: caller.file, line: caller.line, detail: `${caller.method} 的通道是动态表达式，无法静态匹配注册端` })
      continue
    }
    const pair = IPC_PAIRS.find(candidate => candidate.caller === caller.side && candidate.methods.includes(caller.method))
    if (!pair) {
      limitations.push({ code: 'dynamic_channel', file: caller.file, line: caller.line, detail: `${caller.method} 不在已知配对表内，未判定` })
      continue
    }
    const matchesSide = (site: IpcSite): boolean => site.channel === caller.channel && pair.answerSides.includes(site.side as 'register' | 'push') && site.method !== 'removeHandler'
    const answers = registrations.filter(matchesSide)
    const beforeAnswers = baseline?.ipc.filter(matchesSide) ?? []
    const answeredBefore = beforeAnswers.some(site => pair.answerMethods.includes(site.method))
    // A missing endpoint is new when the call itself is new or its compatible
    // endpoint disappeared. A caller already broken in the baseline stays
    // existing, including a method mismatch; moving its line changes neither.
    const attribution: Attribution = beforeCallers === null ? 'unknown'
      : !beforeCallers.has(ipcCallerKey(caller)) || answeredBefore ? 'new' : 'existing'
    if (answers.length === 0) {
      const removed = beforeAnswers.find(site => pair.answerMethods.includes(site.method))
      findings.push({
        kind: 'ipc_endpoint_missing',
        attribution,
        consumer: { file: caller.file, line: caller.line, site: siteKey(caller), member: caller.method, ...(caller.symbol ? { symbol: caller.symbol } : {}) },
        expected: { object: caller.method, member: caller.channel! },
        provider: removed ? { file: removed.file, site: removed.site ? spanKey(removed.site) : `L${removed.line}` } : null,
        channel: caller.channel!,
        detail: `${caller.file} 调用了 ${caller.method}('${caller.channel}')，但没有找到对应的 ${pair.answerMethods.join('/')} 注册`,
      })
      continue
    }
    // Registered, but by a method that cannot answer this call: `invoke` is only
    // answered by `handle`, never by `on`.
    const methodMatches = answers.filter(site => pair.answerMethods.includes(site.method))
    if (methodMatches.length === 0) {
      findings.push({
        kind: 'ipc_method_mismatch',
        attribution,
        consumer: { file: caller.file, line: caller.line, site: siteKey(caller), member: caller.method, ...(caller.symbol ? { symbol: caller.symbol } : {}) },
        expected: { object: caller.method, member: caller.channel! },
        provider: { file: answers[0].file, site: answers[0].site ? spanKey(answers[0].site) : `L${answers[0].line}` },
        channel: caller.channel!,
        detail: `通道 ${caller.channel} 由 ${answers[0].method} 注册，而 ${caller.method} 只能由 ${pair.answerMethods.join('/')} 应答`,
      })
    }
  }
  return findings
}

/** Semantic caller identity remains stable when source lines move. */
function ipcCallerKey(site: IpcSite): string {
  return `${site.file}|${site.symbol ?? ''}|${site.side}|${site.method}|${site.channel}`
}

/** Render a CheckResult as the lines a tool reply shows. */
export function renderCheck(result: CheckResult): string[] {
  const lines: string[] = []
  lines.push(`- 检查：${result.checks.join('+')} · ${result.verdict}`)
  for (const finding of result.findings) {
    const where = finding.consumer.symbol ? `${finding.consumer.file}:${finding.consumer.line} (${finding.consumer.symbol})` : `${finding.consumer.file}:${finding.consumer.line}`
    const tag = finding.attribution === 'new' ? '新增' : finding.attribution === 'existing' ? '基线已有' : '无法归属'
    lines.push(`  - [${tag}] ${finding.kind} @ ${where} — ${finding.detail}`)
  }
  for (const limitation of result.limitations) {
    lines.push(`  - [降级] ${limitation.code}${limitation.file ? ` @ ${limitation.file}${limitation.line ? `:${limitation.line}` : ''}` : ''} — ${limitation.detail}`)
  }
  const coverage = result.coverage
  lines.push(`- 覆盖：${coverage.providers} 提供面 · ${coverage.consumers} 消费站点（${coverage.boundConsumers} 已绑定）· ${coverage.ipc} IPC 端点 · ${coverage.files} 文件 · 基线 ${coverage.baseline ? '有' : '无'} · 范围身份 ${coverage.ranged ? '完整' : '部分'}`)
  return lines
}
