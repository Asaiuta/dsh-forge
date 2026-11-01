/**
 * The passive `/forge-status` command.
 *
 * Status is a host-facing diagnostic surface, not a search tool. Keeping it in
 * its own module prevents the search factories from owning ledger maintenance,
 * Trace capability reporting, and takeover diagnostics together.
 */

import { existsSync } from 'node:fs'
import type { FileFinderApi } from '@ff-labs/fff-node'
import type { AugmentStats } from './augment.ts'
import { canonicalWorkspace } from './fs-paths.ts'
import { peekIndexerStatus } from './indexer-client.ts'
import {
  allStores, gcStoreBlobs, hasPendingTransaction, pruneOrphanedStores, purgeStore, statsFor, storeFor,
} from './ledger.ts'
import { countTickets } from './tickets.ts'
import { TRACE_BINARY_EVIDENCE, TRACE_CAPABILITY_MATRIX } from './trace-capabilities.ts'
import { traceSnapshotStatus } from './tools-trace.ts'
import {
  dataDir, isHomeDir, withFileLock,
  type FinderPool, type ForgeExec,
} from './core.ts'

export interface ForgeStatusInvocation extends ForgeExec {
  readonly rawInput: string
}

export interface ForgeStatusResult {
  readonly kind: 'success' | 'error'
  readonly text: string
}

/** What the status command reports about the active surface. */
export interface StatusRegistration {
  surface: string
  augmentation?: { stats(): AugmentStats; nativeSearchEnabled(): boolean }
}

/** `/forge-status` — engine health in zh-CN (desktop UI convention). */
export function createStatusCommand(pool: FinderPool, registration?: StatusRegistration) {
  return {
    name: 'forge-status',
    description: '查看 dsh-forge 检索引擎状态（索引根、文件数、frecency 库、git 集成）、施工台账与票据统计。',
    input: { hint: '[rescan] [prune] [purge [confirm=yes]]' },
    async handler(invocation: ForgeStatusInvocation): Promise<ForgeStatusResult> {
      const args = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
      const wantRescan = args.includes('rescan')
      const wantPrune = args.includes('prune')
      const wantPurge = args.includes('purge')
      const purgeConfirmed = args.includes('confirm=yes')
      const live = pool.live()

      const ledgerLines: string[] = []
      if (wantPrune) {
        const removed: Array<{ bytes: number }> = []
        let gcBlobs = 0, gcBytes = 0
        for (const store of allStores()) {
          await withFileLock(store.dir, () => {
            try {
              if (statsFor(store).orphan) {
                removed.push(...pruneOrphanedStores([store]))
                return
              }
              for (const freed of gcStoreBlobs(store)) { gcBlobs++; gcBytes += freed.bytes }
            } catch (cause) {
              ledgerLines.push(`prune：保留 ${store.root} 的快照：${cause instanceof Error ? cause.message : String(cause)}`)
            }
          })
        }
        ledgerLines.push(removed.length === 0
          ? 'prune：没有可清理的孤儿快照库。'
          : `prune：已清理 ${removed.length} 个孤儿快照库，释放 ${(removed.reduce((sum, r) => sum + r.bytes, 0) / 1024).toFixed(0)} KB。`)
        ledgerLines.push(gcBlobs === 0
          ? 'prune：没有可回收的无引用快照 blob。'
          : `prune：已回收 ${gcBlobs} 个无引用 blob，释放 ${(gcBytes / 1024).toFixed(0)} KB。`)
      }
      if (wantPurge) {
        const cwd = invocation.agent?.session?.header?.cwd
        if (!cwd) {
          return { kind: 'error', text: 'purge：缺少当前命令会话的工作区，拒绝清除。' }
        }
        const target = storeFor(canonicalWorkspace(cwd))
        await withFileLock(target.dir, () => {
          invocation.signal?.throwIfAborted()
          if (!existsSync(target.ledgerFile)) {
            ledgerLines.push('purge：当前工作区没有施工台账，无可清除内容。')
          } else if (!purgeConfirmed) {
            const s = statsFor(target)
            ledgerLines.push(
              `purge（预览）：将永久清除 ${s.root} 的施工历史——${s.batches} 个批次、${s.blobs} 个快照（${(s.blobBytes / 1024).toFixed(0)} KB）。` +
              `工作区磁盘文件不受影响，且无法回退。确认请执行 /forge-status purge confirm=yes`,
            )
          } else {
            try {
              const purged = purgeStore(target)
              ledgerLines.push(`purge：已永久清除 ${purged.batches} 个批次与全部快照（释放 ${(purged.bytes / 1024).toFixed(0)} KB）。工作区磁盘文件未改动。`)
            } catch (cause) {
              ledgerLines.push(`purge：拒绝执行 — ${cause instanceof Error ? cause.message : String(cause)}`)
            }
          }
        })
      }

      appendLedgerStatus(ledgerLines)
      appendTraceStatus(ledgerLines, invocation.agent?.session?.header?.cwd)

      const modeLine = registration === undefined ? undefined : `工具面：${registration.surface}`
      const augmentationLine = registration === undefined ? undefined : describeAugmentation(registration)
      const statusHead = [modeLine, augmentationLine].filter((line): line is string => line !== undefined)

      if (live.length === 0) {
        return {
          kind: 'success',
          text: [
            'dsh-forge：尚未创建任何索引。',
            '引擎在首次调用 ff_find / ff_grep 时按会话工作区懒启动，会话启动零开销。',
            ...statusHead,
            ...ledgerLines,
            `数据目录：${dataDir()}（frecency 与查询史跨会话累积）`,
          ].join('\n'),
        }
      }

      const lines: string[] = [...statusHead]
      if (wantRescan) {
        for (const { finder, basePath, temporary } of live) {
          if (temporary) continue
          finder.scanFiles()
          lines.push(`已触发重扫：${basePath}`)
        }
      }
      for (const { finder, basePath, temporary } of live) {
        const health = finder.healthCheck()
        if (!health.ok) {
          lines.push(`${temporary ? '[临时]' : '[主]'} ${basePath}：healthCheck 失败（${health.error}）`)
          continue
        }
        const h = health.value
        const pick = h.filePicker
        lines.push(
          `${temporary ? '[临时]' : '[主]'} ${pick.basePath ?? basePath}` +
          `：文件 ${pick.indexedFiles ?? '?'}，${pick.isScanning ? '扫描中' : '就绪'}` +
          `，git ${h.git.available ? (h.git.repositoryFound ? '已接入' : '未发现仓库') : '不可用'}` +
          `，frecency 库 ${h.frecency.initialized ? '已启用' : '未启用'}` +
          `，查询史库 ${h.queryTracker.initialized ? '已启用' : '未启用'}` +
          (isHomeDir(basePath) ? '（注意：正在索引用户主目录）' : ''),
        )
      }
      lines.push(`引擎版本：fff ${safeVersion(live[0].finder)}`)
      lines.push(`数据目录：${dataDir()}`)
      lines.push('')
      lines.push(...ledgerLines)
      return { kind: 'success', text: lines.join('\n') }
    },
  } as const
}

/** Bytes in the unit status lines use: MB once it stops being a small number. */
const sizeText = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`

export function appendLedgerStatus(lines: string[]): void {
  const stores = allStores().map((store) => ({ store, stats: statsFor(store) }))
  if (stores.length === 0) {
    lines.push('施工台账：尚无任何工作区快照（ff_edit 首次写入后建立）。')
    lines.push(`歧义票据：${countTickets()} 张存活（24h 过期）`)
    return
  }
  // Live workspaces get a line each; dead ones only a count. `prune` clears the
  // dead in one call, so listing them one per row buries the rows that matter.
  const live = stores.filter(({ stats }) => !stats.orphan).sort((a, b) => b.stats.blobBytes - a.stats.blobBytes)
  const orphaned = stores.filter(({ stats }) => stats.orphan)
  for (const { store, stats } of live) {
    lines.push(
      `施工台账 ${stats.root}：批次 ${stats.batches}，快照 ${stats.blobs} 个（${sizeText(stats.blobBytes)}），在管文件 ${stats.files}` +
      (hasPendingTransaction(store) ? '，⚠ 有写入中断的未完成事务（下次写操作将自动恢复；若被外部修改阻塞会显式报错）' : ''),
    )
  }
  if (orphaned.length > 0) {
    const blobs = orphaned.reduce((sum, { stats }) => sum + stats.blobs, 0)
    const bytes = orphaned.reduce((sum, { stats }) => sum + stats.blobBytes, 0)
    lines.push(`施工台账：${orphaned.length} 个失效工作区待清理（快照 ${blobs} 个，${sizeText(bytes)}）· /forge-status prune`)
  }
  lines.push(`歧义票据：${countTickets()} 张存活（24h 过期）`)
}

function appendTraceStatus(lines: string[], workspace: string | undefined): void {
  const indexer = peekIndexerStatus()
  const dependencyLanguages = TRACE_CAPABILITY_MATRIX.filter(row => row.fileDependency !== false).map(row => row.language)
  const parseOnly = TRACE_CAPABILITY_MATRIX.filter(row => row.fileDependency === false).map(row => row.language)
  lines.push(
    `Trace 覆盖：${TRACE_CAPABILITY_MATRIX.length} 种语言，文件依赖 ${dependencyLanguages.length} 种（${dependencyLanguages.join('、')}）` +
    `${parseOnly.length ? `；仅解析不计依赖：${parseOnly.join('、')}` : ''}` +
    `；二进制证据 ${TRACE_BINARY_EVIDENCE.extensions.length} 类扩展名（仅元数据）`,
    `Trace 原生解析：${indexer.state}${indexer.binary ? `（${indexer.binary}）` : ''} · ${indexer.detail}` +
    `${indexer.version ? ` · 版本 ${indexer.version}` : ''}；未探测不等于可用`,
  )
  const snapshots = traceSnapshotStatus(workspace)
  lines.push(
    snapshots.snapshots === 0
      ? 'Trace 快照：本次进程内尚无（ff_trace 首次查询后建立；仅内存，不落盘）'
      : `Trace 快照：${snapshots.snapshots} 个 · ${snapshots.configurations} 种配置 · 分页游标 ${snapshots.liveCursors} 个 · 最新 ${snapshots.newest}`,
    'Trace 语义引用：unavailable（M2 计划，当前未实现；ff_symbols 只找定义，不是引用计数）',
    'Trace 运行时证据：unavailable（不做动态加载、不执行工程代码）',
  )
}

function describeAugmentation(registration: StatusRegistration): string {
  const augmentation = registration.augmentation
  if (augmentation === undefined) return '增强：宿主没有 tools/execute 环绕分发点，内置工具原样运行'
  const stats = augmentation.stats()
  const parts = ['read', 'glob', 'grep', 'edit', 'write'].map((name) => {
    const key = name as keyof AugmentStats['served']
    const declined = Object.entries(stats.declined[key] ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason}×${count}`)
      .join(' ')
    const extra = name === 'glob' ? `，Rust 原生搜索${augmentation.nativeSearchEnabled() ? '开启（sidecar 不可用时回退）' : '关闭'}` : ''
    // edit/write are never answered by forge: the count is ledger entries, not
    // calls taken away from the built-in.
    const verb = name === 'edit' || name === 'write' ? '记账' : '作答'
    return `${name} ${verb} ${stats.served[key] ?? 0} 次${declined ? `，交回内置：${declined}` : ''}${stats.failed[key] ? `，异常 ${stats.failed[key]} 次` : ''}${extra}`
  })
  return `增强：${parts.join('；')}`
}

function safeVersion(finder: FileFinderApi): string {
  const health = finder.healthCheck()
  return health.ok ? health.value.version : 'unknown'
}
