/**
 * dsh-forge cordis glue: registers the FFF retrieval tools and the
 * /forge-status command on the host-plane registries. Mounted by the bundle
 * patch as a host-plane insert (dsh-ssh shape), NOT inside the preset groups
 * — dsh-blackhole's patch already full-restates preset-standard's config, and
 * a second full restatement would overwrite its entries.
 *
 * Engine lifecycle: the FinderPool is created per plugin instance and
 * collected for disposal; nothing runs at session start (lazy per-workspace
 * init on first tool call).
 *
 * Lifecycle protocol: the DeepSeek cordis fork has no ctx.effect/ctx.collect —
 * apply must be a *generator function* (plain functions get `new`-constructed
 * and their return value dropped), and every yielded value is collected as a
 * disposable by the fork's _execute iterator branch.
 *
 * @module dsh-forge
 */

import { defineForgeTool } from './host.ts'
import type { Context } from '@deepseek-ai/cordis'
import { FinderPool } from './core.ts'
import { createFindTool, createGrepTool, createMultiGrepTool, createStatusCommand } from './tools.ts'
import { createFindSymbolTool, createOutlineTool, createReadSymbolTool } from './tools-symbol.ts'
import { createEditTool, createHistoryTool, createResolveTool, createRollbackTool } from './tools-edit.ts'
import { createProjectTool } from './tools-project.ts'
import { createExecutionGuard, type ForgeFileSystem, type ForgeFsEvents, type ForgePolicyService } from './execution.ts'
import { createDiffTool } from './tools-history.ts'
import { createFileTool } from './tools-files.ts'
import { createReadTool } from './tools-read.ts'
import { createTraceTool } from './tools-trace.ts'
import { AstWorkerPool } from './ast-pool.ts'

export const name = 'dsh-forge'

export const inject = ['tools', 'commands', 'fs'] as const

/** The slice of the cordis context this plugin touches (services arrive via inject). */
interface ForgeHostContext extends ForgeFsEvents {
  fs?: ForgeFileSystem
  get?(name: 'sandboxPolicy'): ForgePolicyService | undefined
  tools: {
    register(definition: unknown): (() => void) | void
  }
  commands: {
    register(definition: unknown): (() => void) | void
  }
}

export function* apply(ctx: Context): Generator<unknown, void, unknown> {
  const host = ctx as unknown as ForgeHostContext
  const pool = new FinderPool()
  const workers = new AstWorkerPool()
  const guard = createExecutionGuard(host.fs, host, host.get?.('sandboxPolicy'))
  const integration = { fs: host.fs, events: host }
  yield host.tools.register(defineForgeTool(createGrepTool(pool), guard, integration))
  yield host.tools.register(defineForgeTool(createFindTool(pool), guard, integration))
  yield host.tools.register(defineForgeTool(createMultiGrepTool(pool), guard, integration))
  yield host.tools.register(defineForgeTool(createOutlineTool(), guard, integration))
  yield host.tools.register(defineForgeTool(createFindSymbolTool(workers), guard, integration))
  yield host.tools.register(defineForgeTool(createReadSymbolTool(), guard, integration))
  yield host.tools.register(defineForgeTool(createEditTool(pool), guard, integration))
  yield host.tools.register(defineForgeTool(createResolveTool(pool), guard, integration))
  yield host.tools.register(defineForgeTool(createHistoryTool(), guard, integration))
  yield host.tools.register(defineForgeTool(createRollbackTool(pool), guard, integration))
  yield host.tools.register(defineForgeTool(createProjectTool(), guard, integration))
  yield host.tools.register(defineForgeTool(createDiffTool(), guard, integration))
  yield host.tools.register(defineForgeTool(createFileTool(), guard, integration))
  yield host.tools.register(defineForgeTool(createReadTool(), guard, integration))
  yield host.tools.register(defineForgeTool(createTraceTool(), guard, integration))
  yield host.commands.register(createStatusCommand(pool))
  yield () => { pool.disposeAll(); void workers.dispose() }
}
