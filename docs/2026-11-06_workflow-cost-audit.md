# dsh-forge 调用与输出成本复核

本轮继续检查“接口看似更简单、首页更短，完成同一任务却需要更多调用”的问题。确认并修正了 6 类问题。实际减少调用的证据来自小结果执行与任务分页；大回执、超大 diff 的处理属于预算及完整性修复，不能计为完整信息的压缩收益。

## 已修正的行为

| 问题 | 复现结果 | 修改后的行为 |
| --- | --- | --- |
| eval 总是只给 preview | 返回数字 5、空日志，也需再查询一次才能取得完整结构化结果 | 小结果及日志直接返回 `evaluation.result`；`resultComplete=true` 无须再查。大结果保留原来的分页读取 |
| 任务分页绑定整个项目 | 读取第一页后提交无关报告，第二页报 snapshot changed，必须重读 | 任务页绑定所选完整任务列表；列表页绑定概况及顺序。任务变化，包括 Todo 不增加 revision 的变化、预览范围以外的文本变化，仍使对应游标失效 |
| 编辑回执预算只覆盖 diff 成功路径 | 50 个长符号的普通编辑为 18,144 字节；内容未变为 17,920 字节；50 个歧义候选为 14,794 字节 | 成功、未改动、歧义票据共用预算；完整诊断按 receiptRef 存档读取。未写入的调用不会为此制造编辑批次 |
| diff 只用 hunk 文本判断是否能装入一页 | 约 6.8 KiB 的 hunk 本身合格，加上长路径、头部和快照身份后，默认读取直接报错 | 按完整单项计算预算；不能装入空页时明确返回 omittedNodes 和节点补丁读取入口。保持完整 hunk 分页 |
| path 验证默认要求不存在的 bridge 基线 | 语法检查通过，但默认结果为 partial，bridge 为 not_run | path 默认 syntax；batch 仍默认 bridge+syntax。显式请求 path 的 bridge/IPC 仍诚实返回 no_baseline |
| 符号浏览描述与 full 模式读取引导不一致 | ff_symbols 描述仍固定推荐隐式 file#Symbol，与显式 ff_file 引导冲突 | 改为已知定义直接读取、不必先取 outline；具体路由由已有 full/retrieval 引导决定 |

主要改动位于 `src/tools-edit.ts`、`src/symbol-eval.ts`、`src/project-output.ts`、`src/history-output.ts`、`src/verify-static.ts` 和 `src/tools-read.ts`。没有增加工具，full 仍为 9 个工具。

`resultComplete` 与 `evidenceComplete` 区分两种完整性：前者表示本次是否给出完整存档；后者表示执行时是否丢失日志等内容。完整内联的超时记录仍有 `evidenceComplete=false`，不会因为省掉详情查询而变成测试通过。

`ff_history detail=receipt receiptRef=...` 现在可以读取没有 batch 的回执；可选 batch 必须匹配。分页绑定工作区、完整回执哈希及查询条件。原生文本和 PTC 值都能取得同一份 JSON 存档，不通过重新执行取得证据。

## 全流程离线计量

使用 `scripts/measure-workflow-cost.mjs`，统一计入所有工具参数、所有输出、失败重试和完整证据续页。下表采用 `o200k_base`；“原生”是参数加工具文本，“PTC”是参数加完整结构化值，不是两者相加。原始产物另含 `cl100k_base`。

| 固定工作流 | 调用数：前 → 后 | 原生 Token：前 → 后 | PTC Token：前 → 后 | 结论 |
| --- | --- | --- | --- | --- |
| eval 加法，取得完整值和日志 | 2 → 1 | 464 → 275 | 477 → 282 | 减少一次必需的详情查询 |
| 3 项任务按页读取，期间提交无关报告 | 5 → 3 | 820 → 566 | 864 → 596 | 避免失败及重读第一页 |
| 大型 eval，完整取回 Unicode 字符串 | 7 → 7 | 13,051 → 13,028 | 13,099 → 13,077 | 调用数未改善；小幅数值变化来自随机 ID 等，不计收益 |
| 50 项编辑，完整取回每项诊断 | 1 → 4 | 3,855 → 5,223 | 4,706 → 5,552 | 分页提高总成本；修复单次输出越界 |
| 50 项未改动，完整取回诊断 | 1 → 4 | 3,685 → 4,980 | 4,487 → 5,296 | 同上，无源码修改、无新批次 |
| 50 个歧义候选，取回全部候选及诊断 | 1 → 3 | 1,696 → 2,460 | 2,058 → 2,566 | 同上，保留选择所需的完整信息 |
| 长路径、接近预算的 hunk，取回完整补丁 | 2 → 2 | 1,605 → 2,178 | 1,810 → 2,565 | 默认查询从报错变为明确的不完整结果；没有调用数收益 |
| 单文件默认语法验证 | 1 → 1 | 68 → 45 | 195 → 130 | 省掉默认无法执行的检查；不代表编译或类型验证 |

大编辑、未改动、票据三种样本的首个结构化回执分别降至 508、429、479 字节，但完整诊断总成本按上表上升。不能只展示这三个首页数字。长符号样本有意构造输出边界，不代表常规仓库的平均 Token 分布。

计量覆盖的是工具交互，不含模型思考、PTC 包装程序、完整请求历史重放、缓存计费或供应商价格。临时路径、随机 ID、耗时和验证记录 ID 会导致少量 Token 波动。本轮没有向上游模型发送测试请求，没有声称 DeepSeek 的真实账单或行为已经改善。

`full` 的安装版 SDK 提示词投影连同 guidance 为：原生 4,988 → 5,014；PTC TypeScript 6,811 → 6,837；PTC Python 7,939 → 7,965，均增加 26 个 `o200k_base` Token。增加内容用于明确一次可取全的小结果、验证默认值和无 batch 回执入口；不能把单次任务收益与每轮固定提示词成本混为一谈。

## 保留的边界

多文件读取的续页仍绑定整个批次的所有源文件。已读完的文件变化也会使游标失效，这是为了避免同一批结果混合不同版本。使用时先取完所需页再开始编辑；不通过忽略旧文件变化来降低调用数。

默认读取、大纲与 diff 的字节预算仍可能导致额外页。需要完整内容时，应累计全部续查成本；本轮没有通过调大预算或把截断视为完整来制造节省。批量编辑优先的规则保留，精确替换的多个独立步骤仍在一次调用中执行。

## 验证与复现

构建和 TypeScript 检查通过。相关测试包括：输出预算 7 组（开发 SDK 和安装 SDK 均验证）、项目分页 13 组、历史 diff 13 组、符号执行 10 组、安装版执行 6 组、编辑 48 组、精确批量编辑 4 组、接口修改 15 组、参数归一 19 组、多文件读取 6 组、安装版工具接管 10 组、提示词投影 4 组、注册 5 组、展示层开发及安装 SDK 共 2 组。

验证涵盖：100/1,000 项任务、10 份报告、同 revision 下的内容变化、旧快照拒绝、完整回执重建、无写入不产生批次、原生/PTC 输出上限与值相等、小执行结果内联等于存档且读取不重新执行、超时与沙箱语义，以及通过独立 `git apply` 还原补丁的目标字节。

复现命令：

```powershell
pnpm run build
pnpm run typecheck
node --experimental-transform-types scripts/measure-workflow-cost.mjs <output.json> --built
node --experimental-transform-types tests/run-output-budget.mjs
node --experimental-transform-types tests/run-project-output.mjs
node --experimental-transform-types tests/run-history-diff.mjs
node --experimental-transform-types tests/run-symbol-eval.mjs
```

设 `DSH_FORGE_DSH_MODULES` 为安装版 `@deepseek-ai` 模块目录，可在 `run-output-budget.mjs` 使用安装版执行管线；`run-symbol-eval-host.mjs` 进一步检查真实本地 subprocess 和沙箱。测试只使用隔离的本地样本。

审计产物目录：`%USERPROFILE%\.codex\visualizations\2026\11\05\01a1abad-23e0-7e03-ae98-6e6cd914a1c3\workflow-cost-audit`。`before.json` 是本轮修改前的六条工作流；`before-unwritten.json` 只用于补充未写入/票据的修改前证据，其余路径已经包含第一轮修复。`after.json` 是最终构建产物上的完整计量。另保存了提示词投影、各阶段测试输出、本轮文件差分与源码哈希。

构建产物已更新。桌面插件指向此仓库，但本轮没有通过新的真实模型请求验证现有会话实际加载的新 schema，也没有据此宣称会话行为改变。未提交 Git 或推送。
