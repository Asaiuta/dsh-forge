/** The SDK boundary: failures use its exception channel, successful values are lossless JSON. */
import { defineTool, type ParameterSchemaSpec, type ValueSchemaSpec, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ForgeExec } from './core.ts'
import { freezePresentation } from './presentation.ts'
import type { ForgeFileSystem, ForgeFsEvents } from './execution.ts'

type Json = null | string | number | boolean | Json[] | { [key: string]: Json }
interface Factory<V, O extends ValueSchemaSpec> {
  name: string
  description: string
  parameters: ParameterSchemaSpec
  output: { schema: O; render(args: unknown, value: V): Array<{ type: 'text'; text: string }> }
  isConcurrencySafe(): boolean
  execute(args: Record<string, unknown>, exec: ForgeExec | undefined): Promise<unknown>
}
function assertJson(value: unknown): asserts value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) { value.forEach(assertJson); return }
  if (typeof value === 'object') { Object.values(value).forEach(assertJson); return }
  throw new TypeError('forge returned a non-JSON value')
}
export function defineForgeTool<V, O extends ValueSchemaSpec>(factory: Factory<V, O>, guard?: (exec: ForgeExec | undefined, args: Record<string, unknown>, tool: string) => Promise<ForgeExec>,
  integration?: { fs?: ForgeFileSystem; events: ForgeFsEvents }) {
  // The SDK's recursive inference over a runtime schema exceeds TS's depth.
  // Erase only inference here; keep SDK schema/argument/result validation intact.
  const compile = defineTool as unknown as (options: {
    name: string; description: string; parameters: ParameterSchemaSpec
    output: { schema: ValueSchemaSpec; render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }> }
    isConcurrencySafe(): boolean
    execute(args: Record<string, unknown>, exec: ToolRunContext): Promise<Json>
  }) => ToolDefinition
  const sourceSchema = factory.output.schema as ValueSchemaSpec & { properties?: Record<string, ValueSchemaSpec> }
  const outputSchema = { ...sourceSchema, properties: { ...sourceSchema.properties,
    forgePresentation: { type: 'object' as const, additionalProperties: true as const }, workspace: { type: 'string' as const },
  } } as ValueSchemaSpec
  const definition = compile({
    name: factory.name,
    description: factory.description,
    parameters: factory.parameters,
    isConcurrencySafe: () => factory.isConcurrencySafe(),
    output: { schema: outputSchema, render: (args, value) => factory.output.render(args, value as unknown as V) },
    async execute(args, exec) {
      const guarded: ForgeExec = guard ? await guard(exec, args, factory.name) : exec
      const value = await factory.execute(args, guarded)
      if (typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string') {
        throw new Error(value.error)
      }
      assertJson(value)
      let presentation
      try { presentation = await freezePresentation(factory.name, args, value as Record<string, unknown>, guarded ?? {}, integration?.fs, integration?.events) }
      catch { /* committed operations must remain visible as success */ }
      return presentation ? { ...(value as Record<string, Json>), forgePresentation: presentation as unknown as Json } : value
    },
  })
  definition.output.presentationMeta = (_args, value) => typeof value === 'object' && value !== null && !Array.isArray(value) ? value.forgePresentation ?? null : null
  definition.presentResult = (_args, result) => {
    const meta = result.meta
    if (result.isError || !meta || typeof meta !== 'object' || Array.isArray(meta) || !Array.isArray(meta.diffs) || meta.diffs.length === 0) return
    return { card: 'diff', title: `Forge batch #${meta.batch}${meta.omitted ? ` (${meta.omitted} files omitted; use ff_diff)` : ''}`,
      diffs: meta.diffs as unknown as Array<{ path: string; oldText: string | null; newText: string }> }
  }
  return definition
}
