/** File-edge evidence is independent of runtime reachability. */
export type EdgeMode = 'all' | 'certain'
export interface EdgeEvidence {
  confidence: 'certain' | 'candidate'
  basis: string
  config?: string
}
export type UnresolvedReason = 'non_literal' | 'missing_target' | 'external_package' | 'ambiguous_target'
  | 'unsupported_config' | 'outside_root' | 'unsupported_resolution'
export interface ResolutionFailure { reason: UnresolvedReason; detail?: string; config?: string }
export interface UnresolvedModule extends ResolutionFailure { path: string; line: number; spec: string }
/** Project metadata a graph was built from; a changed signature or invalid() forces reassembly. */
export interface ProjectContext { signature: string; valid: () => boolean }
export interface TraceDiagnostic { path: string; reason: string; message: string; line?: number }
export type JsResolution = { status: 'resolved'; targets: Array<{ to: string; evidence: EdgeEvidence }> }
  | ({ status: 'unresolved' } & ResolutionFailure)
export type JsSyntax = 'javascript' | 'typescript' | 'tsx'
export type JsMode = 'import' | 'require' | 'dynamic_import'
export type JsResolver = (from: string, spec: string, mode: JsMode, isFile: (file: string) => boolean, syntax?: JsSyntax) => JsResolution
export const unresolved = (reason: UnresolvedReason, detail?: string, config?: string): JsResolution =>
  ({ status: 'unresolved', reason, ...(detail ? { detail } : {}), ...(config ? { config } : {}) })
export const resolved = (to: string, basis: string, config?: string, candidate = false): JsResolution =>
  ({ status: 'resolved', targets: [{ to, evidence: { confidence: candidate ? 'candidate' : 'certain', basis, ...(config ? { config } : {}) } }] })
