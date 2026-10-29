/**
 * Snapshot-aware comparison for "the same graph, built twice".
 *
 * Several Trace suites assert that the worker pipeline and the sequential
 * pipeline agree. Since M0.4 every assembly is a distinct snapshot: its ID is
 * unguessable and its `createdAt` is a timestamp, so a raw `deepEqual` on the
 * whole assembly compares identities that are *supposed* to differ.
 *
 * The property worth testing is "everything except identity is equal, and the
 * identity really is different". {@link sameGraphExceptSnapshot} states that in
 * one place so no suite can accidentally weaken it by dropping the whole
 * `snapshot` field without checking it was there.
 *
 * @module dsh-forge/tests/lib/snapshot-compare
 */
import assert from 'node:assert/strict'

/**
 * Assert two assemblies carry the same graph/facts/diagnostics, with distinct
 * snapshot identities, then return the snapshot-free halves for extra checks.
 *
 * @param actual - assembly under test (usually the parallel pipeline).
 * @param expected - reference assembly (usually the sequential pipeline).
 * @param label - what was compared, for the failure message.
 * @returns both assemblies with `snapshot` removed.
 */
export function sameGraphExceptSnapshot(actual, expected, label = 'assemblies') {
  assert.ok(actual?.snapshot?.snapshotId, `${label}: actual has no snapshot identity`)
  assert.ok(expected?.snapshot?.snapshotId, `${label}: expected has no snapshot identity`)
  assert.notEqual(actual.snapshot.snapshotId, expected.snapshot.snapshotId,
    `${label}: two separate assemblies must not share one snapshot ID`)
  const strip = ({ snapshot, ...rest }) => rest
  assert.deepEqual(strip(actual), strip(expected), `${label}: graph content must not depend on the pipeline`)
  return { actual: strip(actual), expected: strip(expected) }
}
