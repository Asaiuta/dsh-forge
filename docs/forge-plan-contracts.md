# 实施公共契约与任务入口

日期：2026-10-28。状态：设计，所有新增接口/文件/命令均待实现；本文件不授权执行、安装、改权限或发布。

[路线图](forge-capability-roadmap-2026-10-28.md)保留目标和阶段；实施时按下面任务编号执行，不把本文件当成现有 API 文档。

| 顺序 | 实施手册 | 任务范围 | 首个落地结果 |
|---|---|---|---|
| 1 | [证据与 Electron 闭环](forge-plan-m0-m1.md) | M0.1–M0.7、M1.1–M1.7 | 明确审计状态、版本化基线、真实检查记录 |
| 2 | [语义与安全重构](forge-plan-m2-m3.md) | M2.1–M2.6、M3.1–M3.6 | TS 引用查询、诊断与跨文件变更计划 |
| 3 | [语言与框架适配](forge-plan-m4.md) | M4.0–M4.10 | 各语言独立可验收的能力包 |
| 4 | [运行、发行与验收](forge-plan-m5.md) | M5.1–M5.8 | 生命周期、可信部署与宿主验收 |

## 1. 执行约定

- 每项任务必须先检查工作树，保留现有未提交工作；按符号定位，行号只用于导航。不得用全文件回退代替处理冲突。
- 手册中的现有文件均经当前目录核对；标记“新增”的文件只有实施该任务时才创建。函数名和新增 schema 是本次设计选择，不是已存在的函数。
- 先补失败测试，再改实现，再跑所在任务的局部测试和关联旧测试；修改过源码后重新构建，不能测试旧 `lib`。
- 只为进程入口或被 `.mjs` 测试直接 import 的新模块增加 `build.mjs` 的 `entryPoints`；内部 helper 随上层打包，不把所有源码都变成公共入口。
- 新回归脚本须加入 `package.json` 的 `test` 链。当前 `tests/run-edit-audit.mjs` 已存在但未在该链中，M0.2 一并接入。添加脚本入口不等于获准安装依赖或更改 CI。
- 每项只有一个负责人修改公共契约；语言任务遵循已落地 schema，不平行创造不同的 hash、状态与位置格式。

当前可用的基础检查（在仓库根执行，依赖已安装时）：

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node build.mjs
```

`build.mjs` 会重建 `lib` 并清理它识别出的旧构建块。上述命令在本次文档细化中未执行。避免为了调用脚本触发包管理器自动安装或 build 审批变更；没有依赖时先报告缺失。

## 2. C1：版本化位置与检查范围

M0 在新增 `src/source-evidence.ts` 实现字节/位置转换，Trace 的范围类型留在现有 `src/trace-evidence.ts`。以下是首版必要字段，不要求普通文件名搜索立即返回所有字段。

```ts
interface SourceRef {
  workspaceId: string
  file: string
  rawHash: string
  textHash: string
  start: number
  end: number
  encoding: 'utf16-lf-no-bom'
}
interface Coverage {
  requested: string[]
  analyzed: number
  traversalComplete: boolean
  resultComplete: boolean
  limitations: Array<{ reason: string; file?: string; count?: number }>
}
interface EvidenceContext {
  snapshotId: string
  workspaceId: string
  configKey: string
  provider: string
  providerVersion: string
  strength: 'observed' | 'content-bound'
}
```

规则：

1. `rawHash` 是磁盘原始字节完整 SHA-256；`textHash` 是 UTF-8 解码后去一个 BOM、CRLF/CR→LF 的文本摘要；`start/end` 是该规范文本的 UTF-16 半开区间。
2. 保留已有展示的 1-based 行号；新增结构化 `position` 采用 0-based `line/character`、UTF-16。转换必须显式，不能将 native byte offset 直接作为 JS string offset。
3. 源码范围和附加 context 的显示范围分别返回；`occurrence` 只帮助挑定义，不充当稳定 ID。
4. Windows 路径依现有 `fs-paths.ts`/图 key 规范化，保留显示拼写；文件不存在时保存父目录身份和预期不存在，不把路径字符串当权限证明。
5. 内容哈希必须来自实际解析的同一份 Buffer。先读图、后给当前文件算 hash 不能让旧 facts 获得新身份。
6. 每个正式快照保存解析文件哈希清单、配置摘要、候选集合/相关目录清单摘要和解析探针；内容、集合、缺失目标或配置变化都可能令结论失效。
7. 多文件实时读取只能证明一组被观察到的输入；需要严格同一时刻环境时使用明确隔离快照。哈希不保证没有并发的临时变化，也不覆盖数据库/网络状态。

## 3. C2：审计和验证不是同一种结果

M0 扩展 `src/edit-audit.ts` 的返回值；M1 在新增 `src/verification.ts` 保存正式检查结果。

```ts
type CheckStatus = 'passed' | 'failed' | 'partial' | 'not_run' | 'unavailable' | 'stale'
interface CheckResult {
  id: string
  kind: 'bridge' | 'syntax' | 'types' | 'tests' | 'external'
  status: CheckStatus
  reason?: string
  context?: EvidenceContext
  coverage: Coverage
  findings: Array<{ code: string; message: string; source?: SourceRef }>
}
interface VerificationRecord {
  id: string
  workspaceId: string
  checkPlanId?: string
  batchIds: number[]
  afterHashes: Array<{ file: string; hash: string | null }>
  checks: CheckResult[]
  requiredChecks: string[]
  startedAt: string
  finishedAt: string
  provenance: 'internal-static' | 'host-execution' | 'external-report'
  hostCallId?: string
  recipeId?: string
  exitCode?: number
  outputRef?: string
}
```

- 即时审计是 advice；只有静态启发式时用 `partial`，无缓存/无规则/未跑用 `not_run` 并给 reason，不得制造 `passed`。
- 正式检查中发现确定违反当前静态契约的项可 `failed`，但文案不得说运行时必失败。存在动态未知且不能回答请求范围时为 `partial`。
- `aggregateChecks(required, results)` 不把缺项、跳过、取消、unavailable 或陈旧算通过；已发现失败仍保留。历史执行状态不可改写，当前适用性另外计算。
- 后端超时/中断：尚无结果记 `not_run` 加原因，已有不完整结果记 `partial`；用户拒绝记 `not_run/denied`。不要发明一个外观看似成功的空数组。
- `external-report` 仅说明用户/Agent 提供了资料，不具备自动检查的可信来源，不计入自动验收必需检查的 passed 集合。
- 同一批次可有多条检查记录；旧失败保留。通过只覆盖记录声明的检查范围，不能推出工程整体安全。

存储方案：在 `storeFor(workspace).dir` 下新增 `verification/`，每条记录用独立 ID、临时文件再原子重命名；批次只追加关联，不改 `LedgerBatch` 历史内容。按工作区锁更新轻量 revision，history/cards 用该 revision 发现新增证据。记录/输出读取遵循私有存储权限，限定大小和保留策略；不是防恶意本机篡改的签名系统。

检查计划与执行记录分开：`CheckPlan` 保存 `{id, workspaceId, batchIds, snapshotId?, inputManifest, requiredChecks, recipes, createdAt}`；其中 `inputManifest` 包含实际源码、配置和候选范围身份，recipe 为 `{id, kind, program, argv, cwd, scope, predicate, reportFormat?, reportPath?}`。静态项没有命令，命令项由用户显式指定；存储 ID 不是审批凭据。`run` 执行前、结束后都核对输入身份，变化返回 stale；recipe 不可原地改写，输出路径必须在授权范围。首版测试报告解析 Node test runner 的 TAP，要求发现数大于0、无失败且必需项未跳过；不支持的报告只记录进程退出事实，不能推导 tests passed。进程结果与内部静态结果分别保存各自来源记录，由同一计划关联汇总，不把混合来源都标为 host-execution。

## 4. C3：拟定公共工具增量

下面是待实施 schema；旧用法不变，无关参数组合必须报错，不静默忽略。

| 工具 | 新参数/操作 | 结果与边界 |
|---|---|---|
| `fftrace` | `capture=true`，只允许 file/impact/exposes/ipc/api；`cursor` 与结果分页 | 返回 `snapshotId`、覆盖和结构化 rows；capture 显式付出内容绑定扫描成本 |
| `ffedit` / `ff_file` | 可选 `snapshotId` | 校验同工作区、声明/配置身份和前态；没有它仍允许原有文本操作，但不声称完成前后验证 |
| `ffcheck`（新增） | `action=plan/static/run/show`；plan/static 接 `batchIds`、可选 `snapshotId` 和 `checks`；plan 可接显式 `recipes`；run 接 `checkPlanId`；show 接 `verificationId` | static 的 checks 默认 bridge/syntax，M2 才允许 types；tests 只能通过 plan/run。plan只生成计划；run必须走已核验的宿主审批通道，缺接口时不可用 |
| `ff_read` | 新增 `sourceRef`，与已有文件/符号选择参数互斥 | M2 消费 C1 完整引用；校验 rawHash 后读规范文本范围，不接受旧坐标自动漂移 |
| `fftrace` | `target=references:<file>` 或 `definition:<file>`，必填 `position`；可选 `projectConfig`、`sourceHash` | M2 才加入；sourceHash明确为rawHash；仍保留 `symbol:<name>` 的名称定义查询 |
| `fftrace` | `target=calls:<file>`，position、`direction=incoming/outgoing` | 单层、按需展开，后端不支持就 unavailable；不是所有引用都当调用 |
| `fftrace` | `target=rename:<file>`，position、`newName` | M3 返回 `changePlanId` 和预览，不写源码 |
| `ffedit` | `{plan: changePlanId, reason}`，与 path/steps/ticket 互斥 | M3 应用插件自己保存的计划；ID不赋予权限，不接受模型直接上传的“已批准”编辑集合 |
| `ff_file` | 对 move 增加 `preview=true, updateReferences=true` | M3 有后端支持才生成含文件移动和引用修改的计划；move_code 不自动宣称可搬符号依赖 |
| `ffhistory` | 批次详情可选 `checks=true` | 展示验证历史与当前适用性，不重跑测试 |

语义工具启动与命令执行必须使用独立权限边界；不能把“只读 query”推导为可执行工程插件。具体权限接入见 M1.4、M2.2。

## 5. C4：跨文件计划与生命周期

M3 新增 `src/change-plan.ts`，管理计划，不取代 `edit-engine.ts` 或 `ledger.ts`。

- 计划包含：随机 ID、workspaceId、configKey、生成后端/版本、baseline snapshotId、逐文件 beforeHash、规范文本 edits、文件 create/delete/move 操作、未知项、建议检查、创建时间。
- edit 为 `{start,end,text}`；应用前转换到规范文本，按偏移从后向前应用，拒绝重叠和重复编辑。保留原 BOM/EOL 编码。
- TTL 初始 24 小时、最多 100 个待应用计划/工作区；这是可调整的资源默认值，不是有效性证明。任何版本差异即拒绝，不能因为 TTL 未过就放行。
- 输入版本有效且全部授权后，生成 `FileChange[]`，经已有 `prepareWorkspace → withNativeWrite → commitFiles`；每阶段的锁和恢复规定见 M3。
- 计划应用成功后记录消费结果。若进程在提交后、标记消费前退出，重试必须从 ledger 的计划关联识别已提交，不能重复施加文本修改。

## 6. 验收任务执行法

现有脚本在手册中用 `现有` 标记；新增脚本须实现后才能执行。所有新增 fixture 自建临时工作区，测试数据目录独立，清理只限本次创建内容。需要宿主/后端而环境缺失时可标 SKIPPED，但该阶段不能因此判定已验收。

一次交付的最低证据：局部脚本退出码、测试摘要、必要的磁盘结果检查、实际宿主 tool-call/result 对应关系。不要只用输出中有 `ok` 或命令退出 0 判断测试覆盖完整；不得跳过失败 hooks 或修改审批换取通过。

实现前的建议切片顺序：`M0.1 → M0.2 → M0.3 → M0.7 → M0.4 → M0.6 → M0.5 → M1.1 → M1.2 → M1.3 → M1.4 → M1.5 → M1.6 → M1.7`。M2.1 的只读试验可并行；生产路径必须满足本文件的证据/权限契约。
