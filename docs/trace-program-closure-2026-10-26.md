# Trace：TypeScript program 归属闭包与 Vue/Svelte 脚本依赖（2026-10-26）

承接 trace-project-resolution-2026-10-25 的剩余边界，本轮交付两块能力，仍保持 9 个工具、单一 `fftrace` 入口、只读与证据模型不变。

## TypeScript program 导入闭包

此前排除/未归属文件的裸包名解析一律停止。现在 `js-project.ts` 按每个配置单独传播 program 成员关系：

- 根集合 = `files/include/exclude` 命中（含 allowJs 对 JS 根的门控，jsconfig 默认 allowJs）。
- 闭包只沿**扩展 program 的引用**前进：静态 `import`、`import = require()`、字面量动态 `import()`。普通 `require()` 写在 TS 中不扩展（与 module 设置无关）；JS 成员内的 CommonJS `require()` 扩展；非字面量动态导入不扩展。`allowJs` 决定被导入的 JS 文件是否入 program 并继续传播；`noResolve` 只保留根。
- 被导入的排除文件获得导入方配置的 paths/baseUrl/module 语义；同一文件被两个 program 持有且映射到不同目标时报告 `ambiguous_target`，不发明边。
- 归属 = `configFor` 适用配置 ∪ 闭包成员；文件依赖边本身永远不是成员关系。归属为空时保持原有停止行为（不回退包名）。
- 闭包成员推导仅限已扫描文件（`knownFiles`），不引入新的文件系统探测；成员表与 `closureLimited` 标志进入工程签名，图缓存按输入失效。
- 成员传播预算 100,000 次；超限后剩余文件按未归属处理（与旧行为一致）。

上述规则逐条对照本机 TypeScript 5.9（`ts.createProgram` 实测：静态导入/import-equals/字面量动态导入扩展；TS 普通 require 在 CommonJS 与 ESNext 下均不扩展；非字面量不扩展；noResolve 不扩展；allowJs=false 时被导入 JS 不入 program）。排除文件经导入入 program 后 `resolveModuleName` 经 paths 命中的行为与本实现一致。

**边界**：闭包不沿 workspace 包导出边传播（真实 tsc 经 node_modules 链接进入包源码；包内文件通常已被其自身配置持有，未持有的保持停止）；HTML/组件脚本不进入 tsc program；同大小同 mtime 的源码内容编辑沿用既有 stat 签名限制（元数据文件已有 sha256 戳）。

## Vue/Svelte 脚本依赖

`.vue`/`.svelte` 进入扫描，提取顶层 `<script>` 块（含 Vue `script src` 外部声明、Svelte `context="module"`）：

- 组件只暴露依赖边：每个脚本块独立携带 `syntax`（`lang="ts/tsx"` → TS 感知解析与源码扩展替换，默认 JS 扩展顺序），import/require/字面量动态导入入图；脚本作用域（IPC/bridge/全局）不参与。
- 模板与样式的编译依赖明确不覆盖（属框架编译器，非静态 import 解析）。

## 验证

- `tests/run-trace-projects.mjs`：27 组全过，新增 4 组——排除文件经导入入闭包（oracle 对照）、扩展规则四例、allowJs 开关门控、双 program 歧义。
- `tests/run-trace.mjs`：31 组全过，新增组件依赖组（TS 替换偏好、JS 顺序、`script src`、impact 反查）。
- 全部 34 个测试入口执行通过（SDK 宿主集成按环境跳过，与上轮一致）；`pnpm run check` 通过。
- 规则集对照脚本（临时）已移除；oracle 断言固化在测试内。
