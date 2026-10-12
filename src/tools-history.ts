/** Persistent ledger diff, independent of Git and the ephemeral DSH changes UI. */
import { canonicalWorkspace } from './projects.ts'
import { storeFor, readLedgerTail } from './ledger.ts'
import { workdirOf, type ForgeExec } from './core.ts'
import { nodeId, readNode, snapshot, snapshotDiff } from './history.ts'

export function createDiffTool() {
  return {
    name: 'ff_diff',
    description: 'Compare saved before/after snapshots from ffhistory, independent of current files/Git. Provide exactly one of batch or node. ' +
      'Text diffs are bounded replacement hunks; binary changes report hashes/sizes. Check truncated.',
    parameters: {
      batch: { type: 'integer', description: 'Positive batch ID from ffhistory; returns all its file nodes.' },
      node: { type: 'string', description: 'One node address, e.g. b12:n0 (0-based node index).' },
      projectId: { type: 'string', description: 'Require selected batch/nodes to belong to this project.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        node: { type: 'string', required: true }, batch: { type: 'integer', required: true }, file: { type: 'string', required: true },
        before: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true }, after: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        diff: { type: 'string', required: true }, binary: { type: 'boolean', required: true }, truncated: { type: 'boolean', required: true },
      } } },
    } }, render: (_args: unknown, value: { items: Array<{ node: string; diff: string; truncated: boolean }> }) => [{ type: 'text' as const,
      text: value.items.map(item => `${item.node}${item.truncated ? ' [truncated]' : ''}\n${item.diff}`).join('\n\n') }] },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: ForgeExec | undefined) {
      try {
        const store = storeFor(canonicalWorkspace(workdirOf(exec)))
        if ((args.node !== undefined) === (args.batch !== undefined)) throw new Error('provide exactly one of batch or node')
        let selection
        if (typeof args.node === 'string') selection = [readNode(store, args.node)]
        else {
          if (!Number.isSafeInteger(args.batch) || Number(args.batch) < 1) throw new Error('batch must be a positive integer')
          const batch = readLedgerTail(store, Number.MAX_SAFE_INTEGER).find(batch => batch.id === args.batch)
          if (!batch) throw new Error('batch not found')
          if (batch.nodes.length > 50) throw new Error('batch has more than 50 nodes; query individual nodes')
          selection = batch.nodes.map((node, index) => ({ batch, node, index }))
        }
        if (args.projectId !== undefined && selection.some(item => item.batch.projectId !== args.projectId)) throw new Error('node does not belong to the requested project')
        return { items: selection.map(({ batch, node, index }) => ({ node: nodeId(batch.id, index), batch: batch.id, file: node.file,
          before: node.before, after: node.after, ...snapshotDiff(snapshot(store, node.before), snapshot(store, node.after), node.file) })) }
      } catch (cause) { return { error: cause instanceof Error ? cause.message : String(cause) } }
    },
  } as const
}
