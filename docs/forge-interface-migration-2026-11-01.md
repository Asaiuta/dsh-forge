# Forge 接口迁移与修复边界（2026-11-01）

> 2026-11-05 后续调整：独立 `ff_verify` 已并入 `ff_edit action=verify`，参数 `checks` 改为 `verify`；新增 `ff_edit action=eval` 与 `ff_file action=read`，full 为 9 个。下文保留 11-01 接口迁移记录，当前调用以 [合并报告](2026-11-05_read-eval-consolidation-report.md) 为准。
本页以当前源码为准，记录接口迁移，不是部署声明。旧设计见[能力路线图](forge-capability-roadmap-2026-10-28.md)与[检查吸收记录](forge-check-absorption.md)；依赖查询详见[Trace 参考](trace-reference.md)。

## 公开工具名与注册

`retrieval` 默认只注册 `ff_find`、`ff_grep`、`ff_symbols`，共 3 个；`full` 注册下表全部 10 个。内置 `read` / `glob` / `grep` 的增强不增加 Forge 工具数。

| 当前公开名 | 旧名（仅供文档/离线 normalize） | 当前职责 |
|---|---|---|
| `ff_find` | `fffind` | 模糊文件名/路径 |
| `ff_grep` | `ffgrep` | 模糊内容/多字面量 OR |
| `ff_symbols` | `ff_read` | outline/definitions，正文用内置 read |
| `ff_trace` | `fftrace` | 文件依赖、Electron、暴露与 FFI 证据 |
| `ff_edit` | `ffedit` | 原子文本及精确符号编辑，可附 verify |
| `ff_file` | 同名；旧 edit_symbol 分流到 ff_edit | 文件 CRUD 与代码迁移 |
| `ff_history` | `ffhistory` | 列表、快照 diff、验证适用性 |
| `ff_rollback` | `ffrollback` | 默认预览、显式确认恢复 |
| `ff_verify` | 无；不恢复 ffcheck plan/run | 独立静态验证 |
| `ff_project` | 无 | 私有工程、任务、批次关联、报告 |

**仅注册新名，没有运行时旧名 alias。** 离线 normalize helper 用于迁移已保存参数，不在 execute 前自动翻译。`ff_cards`、`ffcheck` 以及 plan/run 宿主执行层已移除，历史记录可读不代表旧工具可调用。注册依据：[src/index.ts](../src/index.ts)、[src/registration.ts](../src/registration.ts)。

## 编辑、文件、历史与回滚

- 精确符号编辑属于 `ff_edit`：`path` + `sourceSymbol` + `edit`（replace/delete/insert_before/insert_after），除 delete 外传 `content`。`includeLeadingComment` 默认 true，false 才排除前导注释；它不是旧 `body` 的同义值，离线迁移为 `includeLeadingComment = !body`。符号编辑与 `steps`、`find/replaceWith` 互斥。
- `ff_file` 只接受 create/remove/move/copy_code/move_code；迁移代码用 `sourceSymbol` 或 `fromLines` 二选一，并恰好一个目的锚 `after/before/afterSymbol/beforeSymbol`。`includeLeadingComment` 只随 sourceSymbol 使用，默认 true。旧 `edit_symbol` 不能运行时调用。
- `ff_history pathContains` 是文件路径子串过滤，不是文件系统路径；具体 `batch` 或 `node` diff 与列表过滤互斥。旧 `path` 只允许离线 normalize，运行时参数不接受。
- `ff_rollback` 恰好选正整数 `batch`、`latest:true`、非负整数 `throughBatch` 之一；`throughBatch:0` 是初始状态，边界须存在。默认 `dryRun:true`，检查计划后再 `dryRun:false`。不再传字符串 batch 或 `batch:"last"`。
- **当前回滚工具的子串过滤仍叫 `path`**，尚未改成 `pathContains`；不要把历史工具的新参数提前套给它。GUI/HTTP selection 使用 `pathContains`，在服务内部映射到工具 `path`。`node` 要求具体 batch，不能搭配 throughBatch。

实现依据：[src/tools-edit.ts](../src/tools-edit.ts)、[src/tools-files.ts](../src/tools-files.ts)、[src/ledger-rollback.ts](../src/ledger-rollback.ts)。

## Trace：按 target 约束参数

支持 `file:`、`impact:`、`path:`、`ipc:`、`api:`、`global:`、`page:`、`exposes:`、`ffi:`。重复的 `symbol:` 定义入口已移除；查定义用 `ff_symbols view=definitions symbol=<name>`，即使加 capture 也不能让旧入口复活。

| 参数 | 可用 target |
|---|---|
| `edgeMode`（包括显式 all） | file / impact / path |
| `format`（包括显式 auto） | exposes |
| `limit` / `cursor` | file / impact / exposes |
| `capture` | 受支持 target，保存内容基线不等于验证修改正确 |

未知和不适用参数拒绝，不静默忽略。续页保持原 `target`、适用的 `edgeMode` 及页大小，不把新查询和旧游标混在一起。源码：[src/tools-trace.ts](../src/tools-trace.ts)。

## 独立验证与证据

`ff_edit verify:["bridge","ipc","syntax"]` 仍可验证本次实际写入生成的批次；没有写入时 not_run，不伪造批次。独立入口 `ff_verify` 恰好选一个既有正整数 `batch` 或一个工作区内文件 `path`，`checks` 是非空静态项列表（默认 bridge + syntax）。

- batch：消费已记录的 before/after 证据；结论受实际基线、覆盖和规则能力约束，不保证一定 passed。
- path：只有当前 syntax 能实际检查；语言/编码不支持时仍 not_run。bridge/ipc 没有 before 基线，固定 `not_run` / `no_baseline`，绝不冒充比较通过。若只需语法，显式 `checks:["syntax"]`。
- 不写源码、不制造编辑批次；记录落在私有验证区，输入变化时 stale。`ff_history checks:true` 读取记录时判定与当前适用性，历史 passed 不是当前 passed。

这两个入口均不执行工程 scripts、测试命令或旧 ffcheck host-run。源码：[src/tools-verify.ts](../src/tools-verify.ts)、[src/verification.ts](../src/verification.ts)。

## 工程：不要混淆三层结果

| 层 | 成功结果 | 错误 |
|---|---|---|
| `ff_project` 工具 | `{ok:true, action, payload:{project}}`；list 为 `{projects}`，overview 为 `{overview}` | `{ok:false, action, payload:{}, error}` |
| `projectAction` 服务 | 裸 `Project` / `Project[]` / `ProjectOverview` | 抛异常 |
| `/forge-projects` HTTP | 顶层 `{ok:true, project}` / `{ok:true, projects}` / `{ok:true, overview}`；GET 单工程同时带 project/overview | `{ok:false,error}`，revision 冲突 HTTP 409 |

工具 output schema 明确包装 `ok/action/payload`；HTTP 不带这层 action/payload，服务更没有 ok 信封。消费工具结果用 `result.payload.project`，消费 HTTP 用 `result.project`。

动作包括 create/list/get/overview/update/task_add/task_update/task_delete/link/unlink/report；每个动作拒绝无关字段。工具非 list 默认 workspace 为会话 cwd；list 省略 workspace 可搜索全部私有存储。HTTP POST 服务没有会话 cwd，需显式 workspace，GET workspace 须绝对路径。

工程状态为 active/review/accepted/archived；任务仅 pending/doing/done/blocked 四态，`note` 为独立字符串字段（默认空），`archived` 也是独立标志。除 create 外的修改须当前 `revision` 乐观锁，成功递增；冲突先重新读取，不用旧 revision 盲重试。

任务删除级联实时批次关联；已生成报告保存当时 summary，不重写历史。报告状态 draft/review/accepted 是 **human workflow**；accepted 要求所有任务（含归档任务）done，但绝不等同 **machine verification passed**。批次关联不能给任务自动盖通过章。实现：[src/tools-project.ts](../src/tools-project.ts)、[src/projects.ts](../src/projects.ts)、[src/http-plugin.ts](../src/http-plugin.ts)。

## GUI 台账与确认协议

列表 GET `/forge-ledger` 接 workspace、limit（1–200）、keyword/pathContains/actor/kind/cursor；详情用 batch。游标绑定工作区、筛选、页大小与账本前缀，10 分钟有效；不匹配或前缀漂移返回冲突，重新查询。total 是本页返回数，不是全历史总数。

POST 回滚先发送 `{action:"preview",workspace,selection,reason}`；selection 用 batch/latest/throughBatch 三选一，可带 node/pathContains。成功拿到 `{ok:true,token,expiresAt,preview}`。确认发送 `{action:"confirm",workspace,token,reason}`，不能再带 selection；返回 `{ok:true,result}`。

短时 token 最长 120 秒、单次使用，绑定工作区、reason、台账版本与文件身份；它是服务生成的确认票据，不是人工输入凭据。预览不授权恢复/写入；确认仍走宿主 guard 与 mutation fence，并在写锁内复核，缺 guard 为 unavailable/503，变化或过期为冲突。源码：[src/ledger-api.ts](../src/ledger-api.ts)、[src/ledger-rollback.ts](../src/ledger-rollback.ts)。

## 测试与加载状态

新增修复回归接入 `package.json` 的 test 链：源码直测 `run-repair-surface`、`run-repair-mutations`、`run-projects`、`run-ledger-repair` 用 `node --experimental-transform-types tests/<name>.mjs`；`node tests/run-ledger-client.mjs` 自带 esbuild 转换 TSX，write:false，不是发布 build。

实际 GUI 需要先 build 产物，再宿主重载/刷新；本轮本地构建已成功（含 pnpm 自动 prepare），但未完成宿主重载，不宣称已部署到运行中的 GUI。当前 `http://127.0.0.1:20014` 返回 `403 Browser access disabled`，因此没有真实浏览器 E2E 验收。组件状态测试、HTTP 测试和源码契约测试不能代替该 URL 的真实加载。开发入口见[README](../README.md)。
