# fftrace 路线图（2026-10-26）

## 架构评估

不需要推倒重写；以下三处在加新功能前需定向重构。

1. **各语言工程上下文没有统一抽象**（最大阻碍）
   - JS/TS 走 `loadJsProject`，C/C++ 走 `loadCompilationDatabase`，`go.mod` 被当作 `kind: 'manifest'` 文件事实，Rust crate 根靠 `isRustRoot` 文件名正则。
   - 解析分发靠 `null` / `[]` 隐式约定串联：`extraResolver(rel, ref) ?? resolveModuleFact(...)`（`linkgraph.ts`），`resolveModuleFact` 对 workspace 索引语言返回 `[]`，`javaResolver` 返回 `null` 表示不归它管。
   - 非 JS 语言解析失败一律记为 `unsupported_resolution` + 通用说明，诊断无法区分缺失 / 外部 / 歧义。
2. **`buildGraph` 是 315 行上帝函数，`TraceGraph` 25 个平铺字段**。别名解析只存在于闭包中，`tracePage` 只能重读原始 `f.bridge`，与 `ipc:` / `exposes:` 结果不一致（P0 修复）。
3. **查询与渲染耦合，VCPChat 约定渗入通用核心**（`ROLE_GLOBALS.*`、`preloads/<role>.js` 猜测、`DEFAULT_ROLE_GLOBALS`）。可推迟。

## P0 修 bug（0.5 天）

- 图中预计算每个文件解析后的桥接引用 `bridgeByFile`；`tracePage` 改用它，并覆盖 HTML 内联脚本。
- 测试：`run-trace-generic.mjs` 补别名桥调用、内联 `<script>` 桥调用，`page:` 与 `exposes:` 统计一致。

## P1 统一工程上下文与解析器注册表（2-3 天）

```ts
interface LanguageProject {
  id: 'js' | 'cpp' | 'go' | 'rust' | 'python' | 'java' | 'lua'
  signature: string; valid(): boolean; issues: TraceDiagnostic[]
  resolve(from: string, ref: ModuleFact): Resolution
}
type Resolution =
  | { status: 'resolved'; targets: Array<{ to: string; evidence: EdgeEvidence }> }
  | { status: 'unresolved'; reason: UnresolvedReason; detail?: string }
  | { status: 'not_applicable' }
```

1. 定义接口；`JsProject`、`CompilationDatabase` 适配为实现（不改行为）。
2. `module-resolution.ts` 按语言拆分；`resolveModuleFact` 路径规则下沉到各语言；Java 包装 `javaResolver`。
3. `go.mod` 从 manifest 文件事实迁入 Go 工程上下文，`file:go.mod` 输出保持兼容。
4. `assemble()` 遍历注册表：签名取组合，校验要求全部 `valid()`。
5. `buildGraph` source 分支只调 `registry.resolve`，使用细分 `UnresolvedReason`。

验收：现有测试与 `eval-trace-real` 零差异；非 JS 诊断区分缺失 / 外部 / 歧义 / 动态。

**状态（已完成）**：
- `source-resolution.ts` 注册表 + `python/native/rust/go/lua/java-resolution.ts`，三态 `SourceResolution`；`module-resolution.ts` 删除，`module-facts.ts` 只保留提取。
- JS/TS 已有三态 `JsResolution`，未并入同一接口（签名不同：spec/mode/syntax），维持 `JsProject`。
- `assemble()` 缓存校验改为遍历 `ProjectContext[]`；P3 的新工程上下文追加一项即可。
- 推迟：`go.mod` 仍作为 manifest 文件事实提供数据（Go 解析器负责解释）；迁移会改 `file:go.mod` 输出与缓存签名，收益小，等 P3 加 `go.work` 时一并处理。
- 语义约定：源码本身的编译错误（rustc E0761 的 `x.rs` + `x/mod.rs`、Go 同目录多包名）记 `unsupported_resolution` 并在 detail 写明，不记 `ambiguous_target`，因为后者会把查询标为 incomplete（表示分析受限）。
- 测试：`tests/run-trace-reasons.mjs`。

## P2 拆分 `buildGraph`（1-2 天，可与 P1 并行）

- 拆为 `buildModuleGraph`、`buildPageGraph`、`buildBridgeIndex`、`buildIpcIndex`、`buildGlobalIndex`。
- `TraceGraph` 分组为 `{ modules, pages, electron: { ipc, bridge, globals }, ffi }`，保留过渡兼容层。
- 渲染抽到 `trace-render.ts`，只挪位置不改文案。

**状态（已完成）**：
- `buildGraph` 变为编排函数：`buildModuleGraph` / `buildPageGraph` / `buildElectronIndex` 共享 `BuildContext`；调用顺序固定（`normalizeTarget` 保留首个拼写）。
- `TraceGraph` 保持扁平（测试约 100 处直接访问字段），改为 `ModuleGraph & PageGraph & ElectronIndex & {...}` 组合类型，无需兼容层。
- 查询与渲染移到 `trace-queries.ts`（未拆分计算与渲染，文案零改动）；`linkgraph.ts` 重新导出以保持 `lib/linkgraph.js` 公开接口。
- 验证：全量测试通过；本仓库 9 个查询的输出与重构前逐字节一致。

## P3 语言能力（每项一个 `LanguageProject` 实现）

| 序 | 项目 | 做法 | 置信度 | 估时 |
|---|---|---|---|---|
| 1 | Python 包根 | pyproject（setuptools `package-dir` / `packages.find.where`、poetry `packages`）、`setup.cfg`；`src/` 启发式 | 声明 certain / 启发式 candidate | 2 天 |
| 2 | Rust Cargo workspace | `[workspace] members`、`[package] name`、`[lib] path` → crate 名到根映射；`use other_crate::` 接现有 mod 索引 | candidate | 2-3 天 |
| 3 | Go `go.work` / `replace` | 本地路径 `use` / `replace` 入模块表；修正嵌套模块一律拒绝 | candidate | 1 天 |
| 4 | JS/TS re-export 链 | 提取 `export * from` / `export {x} from`；按边上 `imports` 名追到定义文件，≤8 跳，遇环停 | `reexport`，candidate | 2-3 天 |
| 5 | Lua `package.path` | 仅字面量 `package.path = "..."` 的 `?` 模式 | candidate | 0.5 天 |

- TOML：引入零依赖 `smol-toml`（已确认）。

**P3.1 状态（已完成）**：
- `python-project.ts`：读取 `pyproject.toml`（setuptools `package-dir` / `packages.find.where`、poetry `packages[].from`、hatch wheel `packages`、pdm `package-dir`、maturin `python-source`）与 `setup.cfg`（`[options] package_dir`、`[options.packages.find] where`）；具名 `package-dir` 映射单个顶层包。
- 搜索顺序：扫描根 → 具名映射 → 声明根（certain）→ 约定根（candidate：`src/<pkg>/__init__.py`、无显式配置的嵌套工程目录）；同层多根命中记 `ambiguous_target`。
- 作为 `ProjectContext` 接入缓存；内容哈希进签名，改 pyproject 即失效。
- 测试：`tests/run-trace-python-project.mjs`。

**P3.2 状态（已完成）**：
- `rust-project.ts`：读取各 `Cargo.toml` 的 `[package] name`、`[lib] name/path`、`[[bin|test|example|bench]] path`，以及 `dependencies` / `dev-` / `build-` / `target.*` 中的 path 依赖（含 `workspace = true` 经 `[workspace.dependencies]`）。
- 代码中的依赖名取依赖 crate 的 lib 名；用 `package = "…"` 重命名时取表键。
- `use dep::…`：本地模块优先，其后进入依赖 crate 的 mod 树（candidate）；bin/tests/examples/benches 隐式可见本包 lib；注册表依赖保持 external；依赖中找不到路径记 `missing_target`。
- 声明的 target path 成为 crate 根（此前只认约定文件名）。
- `metadata-reader.ts`：Python 与 Cargo 共用的有界元数据读取 + 签名；`buildGraph` 末参数改为 `SourceProjects` 对象。
- 测试：`tests/run-trace-cargo.mjs`。

**P3.3 状态（已完成）**：
- `go-project.ts`：解析 `go.mod`（`module`、`replace`）与 `go.work`（`use`、`replace`），支持块语法、引号与注释；只采纳本地路径的 replace，版本替换仍为外部。
- 解析规则：可见模块（本模块；工作区模式下为 go.work 的全部 use 模块）中模块路径最长前缀者提供包；replace 覆盖同名模块，go.work 的 replace 优先；不在 go.work 中的模块只用自己的 replace。
- 无 go.work / replace 时行为与之前一致。`go.mod` 的 manifest 文件事实保留，仅供 `file:go.mod` 展示；解析数据来自工程上下文。
- 未做：`vendor/` 目录。
- 测试：`tests/run-trace-gowork.mjs`。

**P3.4 状态（已完成）**：
- 提取器新增 `moduleExports` 事实：本模块声明的导出名（含解构、TS 类型/枚举、`export default`）、转发（`export {a as b} from`、`export * from`、`export * as ns from`、导出的 import 绑定），默认/命名空间 import 绑定被再导出时记为 opaque。
- `js-reexports.ts`：从具名导入沿转发链找定义文件，≤8 跳、遇环停、带记忆化。按 ES 语义保守处理：`export *` 不转发 default；多个 star 目标同名则排除；链上任一模块导出表未知（CommonJS、外部包、非 JS）即停止。
- 定义文件不同于直接目标时，新增 `reexport` 边（candidate，evidence 写明 `via 中间文件链`，携带导入名）；不进入页面成员闭包；`edgeMode=certain` 排除。
- 未做：CommonJS `module.exports` 转发；默认导入（`import x from`）与命名空间导入不追踪（现有 bindings 事实不区分二者）；符号级 `impact:文件#名称`。
- 测试：`tests/run-trace-reexports.mjs`。
- 每项：`tests/run-trace-<lang>-project.mjs`、`eval-trace-real` 回归、与 `js-project` 一致的预算（2000 文件 / 8 MiB）。

## P4 远期（仅设计）

- Electron 约定配置化：VCPChat 约定移入可选 profile，默认通用规则。
- 可选 `references:`：接入已安装 LSP，`basis: 'lsp'`，无 LSP 时报告不支持；涉及外部进程，与只读原则冲突，需单独评审。

## 顺序与风险

- P0 → P1 → P2 → P3（1→5）。
- P1 改缓存签名，`run-trace-cache.mjs` 必须重点通过；P2 期间禁止改文案（有断言保护）。
- 估时：重构 4-5 天，语言能力 8-10 天。
