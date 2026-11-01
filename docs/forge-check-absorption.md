# 检查吸收历史与当前验证入口

日期：2026-10-31；接口状态补记：2026-11-01。依据见 [takeover 评测结果](takeover-eval-result-2026-10-30.md) 与全会话工具调用统计。

## 当前状态（2026-11-01）

以下「结论」到「复验」保存 10-31 的历史决策与当时观测，旧名仅为历史标签，不是运行时 alias。当前只注册新名，`retrieval` 为 `ff_find / ff_grep / ff_symbols` 共 3 个，`full` 加 `ff_trace / ff_edit / ff_file / ff_history / ff_rollback / ff_verify / ff_project` 共 10 个；详见[接口迁移说明](forge-interface-migration-2026-11-01.md)。

`ff_edit verify` 继续给本次实际写入的批次作静态证据；新增 `ff_verify` 可对既有正整数 batch 或单文件 path（二选一）独立验证，不写源码、不制造伪编辑批次。path 只有 syntax 能实际检查，bridge/ipc 无 before 基线时必须 not_run/no_baseline。两种入口都不恢复旧 ffcheck 的 plan/run 宿主执行能力。

验证记录现在有 `ff_edit` 和 `ff_verify` 两个静态生产入口，`ff_history checks:true` 和 GUI 台账读取历史判定与当前适用性。工程报告的 human accepted 不等于 machine passed。`ff_cards` 仍已删除；源码状态、组件测试不等于 GUI 部署或 E2E 验收。

## 历史记录（2026-10-31，旧入口不可调用）

## 结论

工具面从 10 行降到 8 行，每请求表面成本 5,363 → 约 3,100 tok。删掉的是**没人调用的两行**，不是两个能力：

| 工具 | schema tok | 全机会话调用 | 处理 |
|---|---|---|---|
| `ffcheck` | 918 | 0 / 8,745 次工具调用、149 会话 | 静态检查并入 `ffedit {verify: [...]}`；`plan` / `run` 连同审批、子进程、TAP/tsc 解释层一起删除 |
| `ff_cards` | 308 | 1（模型在验证插件装没装好） | 工具、卡片引擎、蒸馏通道、`cards` 配置块全部删除 |

## 为什么不是"优化提示词"，而是删工具

`ffcheck` 的问题不在措辞。它的 `action=static` 与 `ffedit` 自己的 `[audit]` 行回答同一个问题（"这批改动有没有破坏桥接/语法"），而 `[audit]` 是免费的、就在调用结果里。让模型为一个已经拿到一半答案的问题再花一次往返，需求本身不存在——0 次调用是需求的测量结果，不是文档缺陷。

`ff_cards` 同理：卡片要回答的"最近改了哪儿"，`ffhistory` 无参数就能回答，而且回答的是台账原文而非蒸馏。唯一那次调用还是 smoke test。

## `verify` 的形状

```jsonc
{ "path": "src/a.ts", "steps": [...], "reason": "...", "verify": ["bridge", "ipc", "syntax"] }
```

- 检查项白名单 `bridge | ipc | syntax`，写前校验：拼错不落盘，避免"改完了才发现参数名错"。
- 复用 `runStaticCheck()`，产出与旧 `action=static` 完全相同的记录（`forge-verification/2`），照旧归档到 `~/.dsh/forge/verification/`，`ffhistory {checks: true}` 仍能读出当时判定与**当前**适用性。
- 批次号取自本次调用自己创建的批次，不接受外部指定——吸收的是"就给这批作证"，不是把 check 变成另一种入口。
- 写入没发生时（`noChange` 或失败）返回 `status: 'not_run'` 并明说"没有可检查的批次"，不给空判定冒充通过。
- 检查抛异常时写入照旧成立，判定降级为 `not_run` 并带原始错误：一次检查跑不起来不能读成一次编辑失败。

## 删掉的东西（保留判断依据）

`src/check-host.ts`、`src/check-plan.ts`、`src/check-outcome.ts`、`src/tap.ts`、`tests/run-check-{plan,host,semantics}.mjs`、`tests/run-tap.mjs`。

这些是 `action=plan` / `action=run` 的实现：冻结检查计划、走宿主 `approval` + `subprocess`、按 kind 解释 TAP/tsc 报告。能力本身没毛病，问题是没人从对话里走到它——需要跑测试的场景，模型直接调 `ops_bash` 就够了，而 `ffcheck` 的多一层审批反而更慢。

**`src/verification.ts` 一行未删。** 那是这套系统里最有价值的部分：记录不可变、按内容哈希判适用性、`stale` 与 `passed` 分开表达。它现在只有一个生产者（`ffedit`）和一个读者（`ffhistory`），但它是数据契约，不是入口。历史记录仍可读——`HostOutputRef` 类型从 `check-host.ts` 迁到了 `verification.ts`，因为记录是数据，写它的代码是历史。

## 复验

- `pnpm test`：58 个套件全绿（删掉的 6 个套件随被测对象一起下线）。
- `run-host-integration`（本次真实 SDK）：26 组全过，含新增的 "installed SDK materializes the ffedit verify verdict and its history record, and refuses to invent one for a call that wrote nothing"。
- `.env` 的 `DSH_FORGE_DSH_MODULES` 原先指向 `resources/app/node_modules`（已不存在，测试一直静默 SKIPPED），现指向仓库外解包目录，宿主集成才真的在跑。

## 当时尚未实施、现在的边界

10-31 尚未实施的 surface 分层与 guidance 压缩已进入当前源码：默认 retrieval 仅三个新名，full 十个；当时“压到 1,100 tok 以下”的目标是历史估算，不能当当前测量结论。旧名只供文档/离线 normalize；运行时不注册 alias。独立验证、工程任务 note/四态/revision 与 GUI 筛选/游标/短时 token 确认的现状见[接口迁移说明](forge-interface-migration-2026-11-01.md)。

本轮本地构建已成功（含 pnpm 自动 prepare），但 GUI 实际加载仍需由宿主重载/刷新，尚不宣称部署；现有 URL 返回 `403 Browser access disabled`，因此没有浏览器 E2E 验收，也不宣称部署。
