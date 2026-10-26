# Trace：preload 结构性布线与诊断卫生（2026-10-26）

P0 ③类补读深挖的三项根因修复：A10 的 preload 盲区、A2 的诊断噪音、跨文件常量不可见。只动 fftrace 内部与 facts 提取，工具面不变。

## Preload 结构性布线边

preload 由 `webPreferences.preload` 结构性加载，require/import 图永远看不到——真实仓库 A10 中 `impact:preloads/chart.js` 返回 0 引用者，模型用 25 次 grep 手工重建。现新增 `PreloadFact`（facts.ts）与 `preload` 边（linkgraph.ts）：

- 支持四种写法：字面量路径（certain）、`path.join`/`path.resolve` 全字面量参数（certain）、const 表标识符/成员（candidate）、裸角色 token 按 `preloads/<role>.js` 惯例试探（candidate，未命中不产生边）。
- **跨文件常量重试**：`const { PRELOAD_ROLES } = require(...)` 使定义表对本文件不可见——各文件导出 `constStrings`（≤128 条，值 ≤200 字符），linkgraph 建全局点分索引（≤20k）对 `externalRef` 事实重试；helper 调用 `f(root, TABLE.X)` 取最后一个名字型参数重试。
- 真实 VCPChat 验证：`impact:preloads/chart.js` → `main.js` + `modules/ipc/chartHandlers.js` + 测试 helper；`preloads/chat.js`/`preloads/desktop.js` 同样命中布线与 require 双路径。

## 诊断卫生

- **宿主自解包容器识别（结构性，非名字）**：点前缀目录含 `_dsh` 标记子目录即跳过（与 `.dsh`/`.git`/`node_modules` 同类）；任意宿主目录名均命中，普通点目录不误伤。真实效果：VCPChat 扫描 1,868 → 1,726 文件，partialFiles 84 → 2，工程问题 85 → 3。
- **同目录同原因 ≥3 次折叠**：头部展示折叠为"首行 + 同目录另有 N 个（已折叠）"，对 dist/vendor 等任何生成物目录洪水生效；diagnostics 结构化行保持完整。
- **外部包计数拆分**：全图范围查询（impact/path/ipc/…）的未解析计数拆为"本地未解析 X 项（另有 Y 项外部包导入，不参与文件边）"，行级 diagnostics 亦过滤外部包；`file:` 单文件查询保留外部包行（有界且有意义）。真实效果：4,377 → 本地 1,335 + 外部 2,680 分列。

## 验证

- typecheck/build 通过；run-trace 33 组（新增 preload 块：字面量/join/const/角色/跨文件/`_dsh` 标记跳过/折叠/外部包拆分）、run-trace-projects 27、run-trace-analysis 18、run-tools 46、run-regressions 37、其余 trace/语言/编辑/worker 套件与 eval-trace（recall=precision=1）、eval-trace-real、eval-coverage 全过。
- prompt surface 本轮零增量（描述与 schema 未动）。

## 边界

- 角色 token 仅按 `preloads/` 目录惯例与文件相对两种基试探；helper 内部模板拼接（如 `` `${role}.js` ``）不展开，靠 externalRef 常量重试兜底。
- 常量索引为全工作区首见优先，同名常量跨模块冲突时取先扫描者（candidate 级，可被 edgeMode=certain 排除）。
- `.vendor`/`dist` 等普通目录仍入图；折叠只影响头部展示。
