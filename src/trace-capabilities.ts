/**
 * Read-only capability matrix for Trace.
 *
 * Three different questions look alike and must not be answered by one set:
 *
 * - `TRACE_SCAN_EXTENSIONS` — which files the dependency walker collects. This
 *   is the set `tools-trace.ts` passes files through; no language outside it
 *   can contribute a `file:`/`impact:`/`path:` edge.
 * - `TRACE_CAPABILITY_MATRIX` — per language, how far Parse /
 *   File dependency / Project resolution actually go, and which of the two
 *   remaining columns (symbol references, runtime) are still unsupported.
 * - `indexer-client.ts`'s `SUPPORTED` — which languages the native sidecar can
 *   parse. A language can be parseable and still contribute no Trace edges
 *   (C# today), so that set must never be rendered as "Trace supported
 *   languages".
 *
 * Rows are hand-written. `fileDependency !== false` rows own the scan
 * extensions and the union must equal the walker's set exactly; the
 * capability test pins that, so widening the walker without updating this
 * table fails loudly instead of over-claiming in docs.
 *
 * @module dsh-forge/trace-capabilities
 */

import { BINARY_EXTENSIONS } from './binary-facts.ts'

/** `supported` = implemented for the stated boundary; `partial` = a real but
 *  narrower channel than the column implies (script-only parsing, tag scan,
 *  declared-roots-only project resolution); `false` = not implemented. */
export type CapabilityState = 'supported' | 'partial' | false

export interface TraceLanguageCapability {
  /** Stable id used by tests and docs; not a tree-sitter grammar name. */
  language: string
  /** Extensions this row owns (lowercase, leading dot). */
  extensions: readonly string[]
  parse: CapabilityState
  fileDependency: CapabilityState
  projectResolution: CapabilityState
  /** Structural references (`references:`/`rename:`) — not implemented. */
  symbolReferences: false
  /** Runtime call/reachability evidence — not implemented. */
  runtime: false
  note: string
}

export const TRACE_CAPABILITY_MATRIX: readonly TraceLanguageCapability[] = [
  {
    language: 'javascript',
    extensions: ['.js', '.mjs', '.cjs', '.jsx'],
    parse: 'supported',
    fileDependency: 'supported',
    projectResolution: 'supported',
    symbolReferences: false,
    runtime: false,
    note: 'ES import/require, dynamic import and HTML <script>; tsconfig/jsconfig paths, baseUrl, references, local workspaces and named re-export chains (≤8 hops). No full TS program import closure.',
  },
  {
    language: 'typescript',
    extensions: ['.ts', '.mts', '.cts'],
    parse: 'supported',
    fileDependency: 'supported',
    projectResolution: 'supported',
    symbolReferences: false,
    runtime: false,
    note: 'Same channel as JavaScript; narrowing to a TS program is not implemented.',
  },
  {
    language: 'tsx',
    extensions: ['.tsx'],
    parse: 'supported',
    fileDependency: 'supported',
    projectResolution: 'supported',
    symbolReferences: false,
    runtime: false,
    note: 'TSX grammar; component template semantics are not modeled.',
  },
  {
    language: 'html',
    extensions: ['.html'],
    parse: 'partial',
    fileDependency: 'supported',
    projectResolution: false,
    symbolReferences: false,
    runtime: false,
    note: 'Regex tag scan for <script src> and inline bodies (module flag preserved); not an HTML tree, so non-script references are invisible.',
  },
  {
    language: 'vue',
    extensions: ['.vue'],
    parse: 'partial',
    fileDependency: 'supported',
    projectResolution: 'supported',
    symbolReferences: false,
    runtime: false,
    note: 'Script blocks only (`<script src>` or parsed body, scope preserved); template and style are not analyzed.',
  },
  {
    language: 'svelte',
    extensions: ['.svelte'],
    parse: 'partial',
    fileDependency: 'supported',
    projectResolution: 'supported',
    symbolReferences: false,
    runtime: false,
    note: 'Script blocks only; template bindings, props and generated-code maps are not modeled.',
  },
  {
    language: 'python',
    extensions: ['.py', '.pyi'],
    parse: 'supported',
    fileDependency: 'supported',
    projectResolution: 'partial',
    symbolReferences: false,
    runtime: false,
    note: 'import/from and literals resolved against the workspace root plus pyproject.toml/setup.cfg declared roots and package-dir maps; no venv, sys.path or typeshed.',
  },
  {
    language: 'rust',
    extensions: ['.rs'],
    parse: 'supported',
    fileDependency: 'supported',
    projectResolution: 'partial',
    symbolReferences: false,
    runtime: false,
    note: 'mod/use/include! plus Cargo crate names, target roots, path dependencies and workspace dependency inheritance; workspace members/exclude expansion, macros and cfg are not implemented.',
  },
  {
    language: 'c',
    extensions: ['.c'],
    parse: 'supported',
    fileDependency: 'supported',
    projectResolution: 'partial',
    symbolReferences: false,
    runtime: false,
    note: 'Local #include resolved through compile_commands.json only; no implicit system directories, response files or preprocessing.',
  },
  {
    language: 'cpp',
    extensions: ['.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx', '.cppm', '.ixx'],
    parse: 'supported',
    fileDependency: 'supported',
    projectResolution: 'partial',
    symbolReferences: false,
    runtime: false,
    note: 'Includes plus C++20 named modules/partitions/header units as candidates; no BMI build mapping, macros or conditionals. Headers do not inherit unproven translation-unit config.',
  },
  {
    language: 'go',
    extensions: ['.go'],
    parse: 'supported',
    fileDependency: 'supported',
    projectResolution: 'partial',
    symbolReferences: false,
    runtime: false,
    note: 'go.mod module path, go.work `use` and local-path `replace`; no build tags, GOOS/GOARCH selection, vendor or cgo CFLAGS.',
  },
  {
    language: 'java',
    extensions: ['.java'],
    parse: 'supported',
    fileDependency: 'supported',
    projectResolution: false,
    symbolReferences: false,
    runtime: false,
    note: 'package/type index for imports, nesting and inheritance; no classpath, JAR or module path.',
  },
  {
    language: 'lua',
    extensions: ['.lua'],
    parse: 'supported',
    fileDependency: 'supported',
    projectResolution: false,
    symbolReferences: false,
    runtime: false,
    note: 'Literal require plus literal package.path patterns; no dynamic searchers or package.path execution.',
  },
  {
    // Parsed for definitions only. Deliberately absent from the scan set: a
    // `.cs` file never contributes a Trace edge, and marking it "supported"
    // for file dependency would turn "no references" into "nothing to fix".
    language: 'csharp',
    extensions: ['.cs'],
    parse: 'supported',
    fileDependency: false,
    projectResolution: false,
    symbolReferences: false,
    runtime: false,
    note: 'AST/symbol definitions only — .cs is not a Trace scan extension, so file:/impact:/path: see no project edges until a backend exists.',
  },
]

/** Files the dependency walker collects. Derived from the matrix above so the
 *  scan behavior and the documented capability boundary cannot drift apart. */
export const TRACE_SCAN_EXTENSIONS: ReadonlySet<string> = new Set(
  TRACE_CAPABILITY_MATRIX.filter(row => row.fileDependency !== false).flatMap(row => row.extensions),
)

export function traceLanguageCapability(language: string): TraceLanguageCapability | undefined {
  return TRACE_CAPABILITY_MATRIX.find(row => row.language === language)
}

/** Evidence read from build artifacts rather than source. Never a language row:
 *  binary metadata proves an export name exists in a file, not that code calls it. */
export const TRACE_BINARY_EVIDENCE = {
  extensions: [...BINARY_EXTENSIONS],
  kind: 'metadata',
  note: 'PE/ELF/WebAssembly export and import names read by magic number; no loading, instantiation or disassembly.',
} as const
