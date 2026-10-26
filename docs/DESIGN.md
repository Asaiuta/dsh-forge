# dsh-forge 设计思考与架构演进 (Architecture & Design Notes)

本文档记录 `dsh-forge` 的深度架构决策、提示词工程实验数据与工程演进思考。

---

## 一、 提示词引导设计：为什么是「按任务」而不是「按能力」

在早期版本中，系统提示词段按架构分层罗列了每个工具的能力（如：检索层工具、施工层工具）。

在一次真实的 Agent 会话中，当 Agent 被要求「分析这个插件的原理」时，它连续通读了 4 个完整的源代码文件，`ff_outline` 一次也没有被调用——尽管当时的工具描述文案里写着 `ff_outline … "prefer over reading a whole file to learn its shape"`。

### 原因分析：指令在场但「不可寻址」
旧版文案排在一条以三个工具名为主语的列表项末尾。Agent 带着「我要看懂这个仓库」的意图进入上下文时，无法迅速在提示词中检索到匹配的操作入口。

内建的优质工具引导（如 `dsh-tool-fs-search`：`Use the grep tool — not shell grep or rg — to search file contents`）均采用**任务在前、工具在后、排除最后**的模式。

因此，`dsh-forge` 的系统提示词调整为以意图为索引的映射规则：
```text
Working out how a file, module or repo is put together → ff_read view=outline first: names, kinds and exact line ranges...
You already have a name → ff_read view=definitions for where it is defined, ff_read for one body, fffind for files...
You have the text but not its location → ffgrep...
You need several files or ranges at once → ff_read...
You are changing files → ffedit...
You need audit, revert or a frozen diff → ffhistory / ffrollback...
You need IPC / global / page / module-edge facts → fftrace...
```

**效果**：改写为任务先行后，Agent 意图命中率大幅提升，且整体提示词体积相比首版还减少了约 22 token。

---

## 二、 提示词段位与注入纪律

| 参数 | 取值 / 决策 | 考量 |
|---|---|---|
| **段名** | `plugin:dsh-forge` | 遵循 DSH 插件命名规范。 |
| **order** | `130` | 官方 `SECTION_ORDERS` 中，插件段建议范围为 60–210。取 130 刻意排在 `PLAN_POLICY`（500）与内建工具引导（`TOOL_BASH: 1000` 起）之前，确保 Agent 在产生内建工具惯性前优先命中本插件推荐。 |
| **门禁机制** | `visibleForgeText()` | 当 restriction、preset 或 scoped override 禁用了工具时，引导段自动随之隐藏，避免 Agent 尝试调用不可见的工具。若注册表读取抛错，则保守保留文本。 |
| **服务注入** | `inject = ['tools', 'systemPrompt', 'subprocess']` | Cordis 并行装载插件时，若不在 `inject` 声明 `systemPrompt`，在 `apply()` 生命周期可能无法捕获后续挂载的服务导致公告丢失。真正的可选服务（如 `sandboxPolicy`）采用动态 `ctx.get()`。 |

---

## 三、 施工治理与存储决策

在设计施工治理层（容错编辑、审计台账、快照管理）时，我们进行了以下关键技术权衡：

| 决策项 | 最终方案 | 权衡原因 |
|---|---|---|
| **强制 reason 审计** | 每次写入必填，缺失时拒绝操作并提供格式提示 | 保证审计日志的完整可溯，使多 Agent 协作时每个动作均有据可查。 |
| **歧义票据存储** | `~/.dsh/forge/tickets/` (24h 过期) | 相比纯内存暂存，持久化文件能在宿主意外崩溃或跨进程重启后保持有效；同时避免污染用户工作区。 |
| **快照作用域** | `~/.dsh/forge/snapshots/<workspace-key>/` | 中心化哈希存储，用户工作区零污染，快照与回退完全不依赖工作区是否处于 Git 管理下。 |
| **存储数据格式** | JSONL 台账 + sha256 寻址 gzip 压缩 blob | 纯标准 Node.js 原生能力，零 C++ 编译依赖，杜绝类似 `better-sqlite3` 等原生构建在 Electron/Node 多 ABI 下的跨平台编译与加载问题。 |
| **Actor 溯源** | 提取 `exec.agent.session.header.id` | 天然支持 DSH 的子 Agent 区分，天然支持按不同执行者过滤变更。 |

---

## 四、 容错编辑与安全边界

### 1. 容错编辑引擎（纯函数管道）
- **快照坐标对齐**：一批 steps 全部以操作前的原始内容为基准坐标，自动检测冲突重叠，重叠立即报错，避免因中间步骤偏移导致代码改坏。
- **expect 漂移修正**：当模型给出的目标行号有偏差（±20 行范围内），引擎根据上下文文本自动对齐定位。
- **自引用锚点剥除**：模型在替换时容易带上上下文的首尾行作为定位标记，引擎自动识别首尾锚点行并仅替换中间内容，确保编辑幂等性。
- **语法校验回退（revertOnSyntaxError）**：写入后通过 AST 进行语法树完整性评估。对于原本无语法错误的文件，如果本次编辑导致 syntax error，触发安全拦截。

### 2. 外部修改保护与并发纪律
- **外部篡改检测**：写入前比对当前磁盘哈希与台账中记录的最后已知哈希，若发现非本插件引起的外部改动，自动录入 `external` 节点并保留原始快照，防止盲目覆盖人类开发者或外部进程的工作。
- **回滚即新提交**：所有的 `rollback` 操作都会完整记录 before/after 双向 blob，回退操作本身也可以被重做。
- **锁与协作**：写入操作与 DSH 的底层文件系统 Provider 共享目标锁机制，确保并发场景下的顺序一致性。

---

## 五、 性能基准与未来演进

1. **冷启动与索引开销**：FFF 引擎采用懒加载机制，首次触发检索时按工作区根目录建立索引。
2. **AST 解析机制**：当前采用 `web-tree-sitter` (WASM) 进行 11 种语言的 AST 提取，单文件热缓存表现良好；对于海量多文件的冷启动大纲分析，可开启 worker 并行解析机制（`DSH_FORGE_AST_WORKERS`）。后续如有需要，可进一步接入纯原生 Rust AST 后端。

---

## 六、 工具面收口：为什么合并、合并到哪里为止

### 1. 判据（三条硬边界）

工具面能收口，不是因为「引擎层对象少」——那是错误的外推。真正的判据是三条：

| 边界 | 规则 | 反例（不能合） |
|---|---|---|
| **动词 + 目标类型** | 同动词、同目标类型才能合 | `ffgrep`（搜**内容**）与 `fffind`（列**路径**）动词不同，目标类型不同。注：`ffglob` 与 `fffind` 动词同为「找文件」、目标类型同为「文件路径」，属**可合**一类 → 见 §八 B 刀 |
| **状态对象独立性** | 各自持有独立状态对象的工具不能合 | 歧义票据 / 回滚批次 / 项目台账 / IPC 事实 |
| **读写分离** | `isConcurrencySafe` 的读与写不能合（读可并行、写须串行） | `ff_read` 与 `ffedit` |

按这条判据，`ff_project`（项目台账）、`fftrace`（IPC/页面/模块图事实）、`ffhistory`（只读账目）、`ffrollback`（批次恢复）**天然不参与合并**，因此「13 → 6~7」站不住；判据支持的是 **13 → 10（可选 → 9）**。

> **后续（2026-10）**：`ff_project` 已整体删除，工具面 9 → 8。删除理由不是「能合并」，而是**零使用**——4 个账本 88 批次里 `kind: project` 为 0 条，同时它带 9 个 action、一个独立文件与 5 处跨模块依赖（`LedgerBatch.projectId` / `HistoryFilter` / `TicketPayload` / `requireProjectLedger` / `guidance` 能力表）。合并判据仍然成立，只是「不合并」不等于「必须保留」：一个没人调用的状态对象，其独立性只值一次维护成本。旧账本中的 `kind: 'project'` 批次仍被 `validateRecord` 白名单放行并驱动 `strict` 尾部语义，历史可继续重放。

### 2. A 刀：读三合一（已落地）

`ff_outline` + `ff_find_symbol` + `ff_read` 三者动词同为「读」，目标类型同为「文件/符号」，且都不持状态 ⇒ 合并为 `ff_read` 的三个视图：

- `view=body`（默认，缺省行为与旧 `ff_read` 完全一致，向后兼容）
- `view=outline`（原 `ff_outline`）
- `view=definitions`（原 `ff_find_symbol`，需要 `symbol` 参数）

实现上，原先的 `createOutlineTool()` / `createFindSymbolTool()` 工厂被拆成纯函数 `outlineOf(exec, path, depth, kind)` / `findDefinitions(exec, args, workers)`，由 `createReadTool(workers)` 在 `execute` 里按 `view` 分派。输出 schema 因此必须是**一张扁平 schema**：`blocks` 改为可选，新增 `items` / `lang` / `stats`。

> **SDK 约束**：`defineForgeTool` 会把根 `properties` 展开到工具 schema 上，所以无法用顶层 `oneOf` 做「按视图的联合输出类型」——多形态返回值只能是单张带可选字段的扁平 schema。

### 3. 实测结果（同口径，`current-surface.mjs` 前后 diff）

| 指标 | before | after | Δ |
|---|---|---|---|
| 工具数 | 13 | **11** | −2 |
| desc + params 字符 | 16,870 | **16,626** | **−244（−1.4%）** |
| 描述交叉引用边数 / 涉及工具 | 21 / 11 | **15 / 9** | −6 / −2 |
| native schema 字节 | 17,992 | 17,576 | −416（−2.3%） |
| cl100k token | 3,892 | **3,794** | **−98（−2.5%）** |

账目可对平：删掉 `ff_outline`(516) + `ff_find_symbol`(910) = **−1,426**；`ff_read` 从 1,501 涨到 2,653 = **+1,152**；其余工具因交叉引用改写 **+30**。净 **−244 字符**。

**必须诚实说出的部分**：事先的估算是「A 刀省 1,027 字符 / −225 tok」，实测只有 **−244 字符 / −98 tok**，高估约 4 倍。两个误差同向叠加：① 两个被删工具的实际体量只有 1,426 字符（估算按 2,927 记）；② 新 `ff_read` 实际 2,653 字符（估算按 1,900 记）——多出的 13 个参数里，`view` 一项就把三个视图的文档重新写了一遍。

**结论**：合并的主收益**不是 token，而是减少选型歧义**（-6 条交叉引用、-2 个「要互相指路」的工具）。token 的主杠杆在**散文**（详见 §七）。

---

## 七、 工具面散文压缩：能压多少、为什么不能再压

### 1. 先按 token 分桶，别按字符

工具面在**原生**渲染下（`native` 口径，即真正发给模型的那份）分三个桶：

| 桶 | 字符 | cl100k | 字符占比 | token 占比 | 可控性 |
| --- | --- | --- | --- | --- | --- |
| 工具描述（11 个） | 4,209 | 897 | 24.8% | 23.6% | 可压 |
| **参数描述散文** | **6,763** | **1,520** | 39.8% | **40.1%** | 可压 |
| schema 脚手架 | 6,020 | ~1,280 | 35.4% | ~33.7% | **不可控** |
| 工具名 + 工具间 JSON | — | ~97 | — | ~2.6% | 不可控 |
| 合计 | 16,992 | **3,794** | | | |

> 三个桶在**字符和 token 两个维度上的占比几乎一致**（散文合计约 64%、脚手架约 35%）。tokenizer 对 JSON 骨架并不比散文便宜多少（0.213 vs 0.229 tok/字符）——**别指望「压 JSON 骨架」省 token**。
>
> 那为什么只压散文？不是因为脚手架便宜，而是因为**脚手架由 SDK schema 契约决定、根本改不动**：每个 object 必须带 `additionalProperties`，每个属性必须带 `type`，每个 enum 必须把值列全。**可控的只有散文**。

### 2. 压缩规则（R1–R6）

| # | 规则 | 说明 |
| --- | --- | --- |
| **R1** | 保留全部**取值域** | 枚举值、数值范围、默认值、`max`、单位 —— 一个不删 |
| **R2** | 保留全部**判别条件** | `Required for <action>`、互斥、`<view/action> only` —— 这是「单工具多动作」模式唯一的判别信号 |
| **R3** | **同一事实只写一次** | 影响「**选哪个工具**」的留 tool desc；影响「**怎么填**」的留 param desc |
| **R4** | **不新增缩写** | 缩写本身是解码成本，且对 tokenizer 未必更短 |
| **R5** | 删纯修辞 | 括号补充、冗余 `e.g.`、重复主语 |
| **R6** | 每个参数描述**仍独立可读** | 不依赖阅读顺序 |

**R3 是主力**：实质削减全部来自「同一事实只写一次」（例：`ffgrep` 的 pattern/patterns 互斥原本在 desc、`pattern`、`patterns` 里写了**三遍**，改成 desc 里一遍）。

### 3. 实测

| 指标 | before | after | Δ |
| --- | --- | --- | --- |
| native 字节 | 17,576 | 16,535 | **−1,041（−5.9%）** |
| **native cl100k** | 3,794 | **3,602** | **−192（−5.1%）** |
| 工具描述 | 4,209 字符 | 3,743 | −466（−93 tok） |
| 参数散文 | 6,763 字符 | 6,182 | −581（−104 tok） |
| schema 脚手架 | 6,020 字符 | 6,020 | **0**（脚手架不变，这是对的） |
| `blank parameter descriptions` | 0 | 0 | 保持 |

### 4. 为什么只能压 5%（本节的结论）

压完再扫全 surface，**≥28 字符、跨 ≥2 个条目重复的片段只剩 10 条**，其中最长的一条是 `— node_modules, another drive and another checkout included`（×3）—— 那是「你可以去工作区外检索」的能力声明，**每个工具都必须独立说一遍**，正是它修掉了 `ops_bash` 的滥用。删它省 120 字符、毁掉最关键的一条引导。

**⇒ 在「零语义损失」下，无损去重空间已经用尽。** 剩下的约 1,400 tok 参数散文由三部分构成，每一部分都动不得：

1. `Required for <action>` 矩阵（R2）—— 删了模型不知道每个动作要填哪些字段；
2. 枚举/范围/默认值（R1）—— 删了就是丢契约；
3. 每个工具必须独立自洽的重复声明（R6）。

要再往下只能**违约**，可选方案与代价：

| 违约 | 做法 | 预估 | 代价 |
| --- | --- | --- | --- |
| 破 R2 | 删各 param 的 `Required for <action>` 前缀，改在 tool desc 放一张动作→字段矩阵 | ~70–90 tok | 判别信号从「参数本地」退回「要回读 desc」—— 正是 §六 那条显式权衡要避免的方向 ⇒ **须先做采用率复测** |
| 破 R6 | 允许参数描述引用其他参数 / 工具描述，跨工具去重 | ~45 tok | 模型单看某参数时失去自洽 |
| 破 R1 | 把枚举值挪到 desc 列一次 | — | SDK 需要 `enum`，挪不走 |

### 5. 收益定位

散文压缩降的是**冷启动税**：tools 属于可复用缓存前缀（同模型连续使用 ≈ 13,312 tok），新会话首步即命中。A 刀（§六）−98 tok + 本节 −192 tok = **−290 tok ≈ 该前缀的 2.2%**。单看比例不大，但它是**唯一一处不损失任何能力的收益** —— 不改变任何工具名、参数名、取值域或行为。

---

## 八、 B 刀：找文件两合一（已落地）

### 1. 为什么这两个能合

按 §六 的「动词 + 目标类型」边界，`ffglob`（列路径）与 `fffind`（模糊找文件名）**动词同为「找文件」、目标类型同为「文件路径」**，与 `ffgrep`（搜内容）不同类 ⇒ 属可合一类。

区别只在**匹配语义**，而匹配语义天然是一个枚举可以表达的东西：

| 工具 | 匹配方式 | 排序 |
| --- | --- | --- |
| `fffind`（旧） | 文件名 + 路径的**模糊**匹配（容错拼写） | 匹配分 × 访问频率（frecency） |
| `ffglob`（旧） | 路径的 **glob** 匹配（npm-glob 语法、gitignore 感知） | 路径字典序 + 按页分页 |

⇒ 合并为 `fffind` 的 `mode` 参数：`mode=name`（默认）走模糊，`mode=glob` 走 glob。

### 2. 两个真实障碍与解法

**障碍 1：同名参数 `limit` 的默认值/上限不同。**

| 模式 | 默认 | 上限 |
| --- | --- | --- |
| `mode=name`（原 `fffind`） | 30 | 200 |
| `mode=glob`（原 `ffglob`） | 100 | 1,000 |

这正是「两个工具各自持有独立契约」的表现，也是 `mode` 合并最容易翻车的地方——**一个参数名要承载两套取值域**。

解法：**不做参数级拆分，而是在同一个 `limit` 的参数描述里按模式并列写清两套默认/上限**（R1 要求取值域一个不删，这里两条都保留）。选择这条而不是「`limitName` / `limitGlob` 两个参数」，是因为后者把「同一概念」在 schema 层裂成两个名字，反而增加选型歧义——与合并的初衷相悖。

**障碍 2：`page` 只对 `mode=glob` 有意义。**

原 `fffind` **没有** `page`（它内部按分页语义一次给完）。解法：保留 `page`，在参数描述里显式标注 **glob only**（R2 判别信号），并在 `execute` 里对 `mode=name` + 显式传 `page` 的调用直接返回失败：

```ts
if (findModeOf(args) === 'name') {
  if (args.page !== undefined) return failure('page applies to mode=glob only; mode=name pages internally')
  ...
}
```

### 3. 实现要点

- 工厂 `createGlobTool()` **删除**，原 `execute` 体抽成纯函数 `globSearch(pool, args, rawPattern, exec)`；原 `fffind` 的搜索体抽成 `nameSearch(...)`；`createFindTool` 的 `execute` 只做**模式分派 + 参数校验**。
- 输出 schema 沿用 §六 的 SDK 约束：**一张扁平 schema**。`name` / `score` / `match` / `frecency` 改为**可选**（只有 `mode=name` 会填），`path` / `size` / `modified` / `git` 保持必填（两种模式都填）。
- 模式判定容错：`mode` 缺失或为未知值 → 当 `name`；但**显式传了一个非法值**要报错（否则拼错 `mode='glob '` 会静默退化成模糊搜索）：
  ```ts
  const explicit = typeof args.mode === 'string' && args.mode.trim() !== '' ? args.mode.trim() : undefined
  if (explicit !== undefined && !FIND_MODES.includes(explicit)) return failure(...)
  ```
- 原有的 `GLOB_LOOKING_PATTERN_NOTE`（「你这个 pattern 看着像 glob，模糊搜索大概率找不到，改用 mode=glob 或 ff_read glob=」）**保留在存活工具内部**——它原本是 `fffind` → `ffglob` 的**跨工具指路**，合并后降级为**工具内提示**，引导没有丢。
- `src/absence.ts` 的措辞本来就是**工具面中立**的（「这些工具只列文件」而非「`ffglob` 只列文件」）⇒ 无需改动。这是前面把它写成中立的回报。

### 4. 实测结果

| 指标 | before | after | Δ |
| --- | --- | --- | --- |
| 工具数 | 11 | **10** | −1 |
| desc + params 字符 | 15,579 | **15,557** | **−22（−0.1%）** |
| 描述交叉引用**边数 / 涉及工具** | 14 / 9 | **13 / 8** | −1 / −1 |
| native schema 字节 | 16,535 | **16,428** | −107（−0.6%） |
| **native cl100k** | 3,602 | **3,584** | **−18（−0.5%）** |
| PTC TypeScript cl100k | 4,601 | **4,521** | **−80（−1.7%）** |
| PTC Python cl100k | 5,295 | **5,177** | −118（−2.2%） |
| `blank parameter descriptions` | 0 | **0** | 保持 |

> 交叉引用减少的那 1 条边就是 `ffglob -> fffind`（原来两个工具要互相指路）。合并后 `fffind` 自己指向 `ffgrep`（内容 vs 路径仍要分流），这是**应当保留**的一条。

**必须诚实说出的部分：B 刀在 token 上是近乎中性的（−18 tok）。**

原因不是实现打折，而是**两条描述之间几乎没有重复**：旧的 `fffind` desc 103 字符 + 旧的 `ffglob` desc 346 字符 = 449 字符，新的合并 desc 是 **466 字符**——比原来两份加起来还多 17 字符。因为存活的那个工具必须**同时**声明两种模式的用途、排序依据、分页方式与「只返回文件」的共同约束。

⇒ **B 刀的收益是「少一个工具」，不是「少一点 token」。** 它买的是**选型清晰度**：模型不再需要在 `fffind` / `ffglob` 之间做一次语义相近的判别（而历史上那次判别确实失败过——见 `src/guidance.ts` 注释里 `ffglob` 整场只有一个调用的记录）。这与 A 刀（§六）的结论是**同一个结论的第二次验证**：合并的主收益是减少歧义，token 的主杠杆是散文（§七）。

> **一个值得记下的口径差异**：同一刀在 native 口径只有 −18 tok，在 **PTC 口径是 −80（TS）/ −118（Py）tok**。原因是两种渲染方式对「一个工具」的计价不同：native 只发工具名 + 描述 + 参数 schema，PTC 还要为每个工具生成完整的**类型声明**，删掉一个工具就删掉一整个接口定义。⇒ **「合并省多少 token」这个问题没有唯一答案，必须先说口径。** 对 native 缓存前缀而言 B 刀近乎中性；对启用 PTC 的会话它省得更多。

### 5. 到此为止

三条刀合计：**13 → 10 个工具**（A 刀 −2，B 刀 −1），散文压缩 −192 tok，合并带来 −18 tok。

剩下的 D 刀（`ffresolve` 并入 `ffedit`，约 260 字符）按 §六 判据**属于可合但收益极小**的一类，属可选项。工具面的收口到此可停：再合就要动 §六 明列的「不参与合并」的四类（台账 / IPC 事实 / 只读账目 / 批次恢复），那是**状态对象独立性**这条硬边界，不该逾越。

### 5.1 D 刀已落地（10 → 9）

12 天真实会话里 `ffresolve` **零调用**，而它的全部语义都是 `ffedit` 的续体（ticket 由 ffedit 签、候选由 ffedit 量、批次由 ffedit 的引擎重放）。这不是「两个工具功能相近」，而是**一件事被拆成两次调用**。已合：

- `ffedit` 新增 `ticket` / `choice` 两个可选参数（`choice` 在后续收口中由 `choice` / `choices` / `all` 三个同义参数合并而来）；带 `ticket` 时走 `decideTicket()`，只接受这两个参数（再带 `path`/`steps` 直接拒绝，避免一次调用表达两个意图）。`choice` 接受单个索引（`2`）、去重索引列表（`2,3` / `#2 #3`，逗号/空格/顿号皆可）或 `"all"`。
- `path` / `reason` 的 `required` 从 schema 下移到运行期，改为「**除非在答复票据**」——schema 层无法表达条件必填，而把 `path` 留在必填会让票据答复必须复述一个它根本不需要的路径。
- ticket 存储、24h TTL、原始快照坐标校验、stale 后重新签票的语义**逐字未动**。
- `FORGE_CAPABILITIES` 去掉 `resolve` 能力；guidance 里原来的“由 `ffresolve` 裁决”并入 `ffedit` 那一句。

⚠️ 这次合的正当理由**不是省 token**（一个工具约 700 B / 190 tok），而是：`ffresolve` 单独存在时，歧义路径要付**两次模型往返**；而真实会话 12 天从未走进这条路径 —— 也就是说这个工具的成本一直在付，收益一次没兑现。现在同样的能力少一次往返、少一条声明。

### 5.2 参数面收口：从「少参数」改判为「不许静默忽略」（2026-10）

原先的判据是「参数数量越少越好」，实测后改判：**数量不是主要成本，静默忽略才是**。同一批参数在三处表达不同意思（`limit` 在 3 个视图下 3 个含义、`path` 在 4 种语境下 4 个含义），模型把 `view=outline` 该用的 `depth` 传给 `view=body`、或把 `body` 传给 `outline` 时，工具照常返回一份**看起来正常**的结果 —— 错的是语义，不是返回值。

- **`ff_read`：视图参数白名单硬报错。** `VIEW_ARGS` 逐视图列出可接受参数；参数属于别的视图时，报错**点名**并指出去哪个视图读（`"body" does not apply to view=outline; it is read by view=body — drop it or switch view`），完全未知的参数报 `unknown parameter`。内置形状（`file_path`/`offset`/`limit`）先翻译再判定，翻译留下的字段一并丢弃，避免自己造出「未知参数」。
- **`ffedit`：9 → 8 个参数。** 删 `projectId`/`todoId`（工程台账已删）、`choice`/`choices`/`all` 三合一为 `choice`（一个字符串表达单索引、索引列表或 `all`）、删 `mode`。`mode` 的删除是判据问题而非数量问题：`bestEffort` 会「跳过失败步骤」，等于允许半应用，与「账本可回滚」的承诺直接冲突 ⇒ 现在传 `mode` 直接报错，写明「改为拆成多次调用」。引擎层的 `bestEffort` 仍保留给内部调用方与引擎测试。
- **票据答复的字段闭包。** 带 `ticket` 时只接受 `{ticket, choice}`，其余参数**逐名拒绝**（`drop "all"`）。旧行为是只拦 `path`/`steps`，别的字段被静默忽略 —— 实测这正是「以为答了题、其实没答」的来源。

判据修正：**参数可以多，语义不能糊**。新增参数的成本是一次声明；静默忽略的成本是一次错误的施工。

## 九、 fftrace 能力修补：跨模块包装 + 静态推导键 + 事实缓存

在 VCPChat（1691 个 JS/HTML 文件、45 个页面）上实测，`fftrace` 只有「静态图」那一半能用：`page:` / `file:` 正常，`ipc:` 的**主进程侧**正常，而**渲染侧整层是空的** —— 每个通道都报 `preload 暴露（0）`、`直接 ipcRenderer 调用（0）`。同时单次调用 **37–70 秒**，八次查询合计 6 分 07 秒。

### 1. 两个根因

**① 包装函数的解析只认同文件。** `facts.ts` pass 2 的 `wrappers` 是 per-file 的 `Map`，只在该文件内匹配包装函数定义。VCPChat 的 `invoke()` 定义在 `preloads/core/define.js:62`，而 482 条声明全写在 `preloads/api/*.js` —— 跨文件，于是：

- `file:preloads/api/desktop.js` → `IPC 直接调用（0）`
- `file:preloads/core/define.js` → 4 条 `channel`，`via` 全是 `dynamic`（形参，永不入边）

479 个通道因此一条边都没有。

**② 声明表只认手写 JSON。** `decls.ts` 的 `loadPreloadDecls(root, file)` 在 `file` 缺省时直接返回 `absent`。而这类仓库的真实声明在**运行期注册表**里（`ApiEntry(kind, channel)`）。兄弟实现 VCPChat `linkGraph.js:60` 走的是另一条路：起子进程 `ELECTRON_RUN_AS_NODE=1` 执行注册表拿真值。**那不是这里要抄的** —— `fftrace` 的既有不变量是「Read-only: never executes workspace code」，换成本项目的做法不需要执行任何东西。

### 2. 三处改动

**跨模块包装解析**（`facts.ts` + `linkgraph.ts`）。三件事：

1. 记绑定：`const { invoke } = require('../core/define')`、`import { send as s } from './bridge'`、命名空间绑定，全部进 `FileFacts.bindings`。
2. 导出包装表：`this.wrappers` 里**属于顶层声明**的那些进 `FileFacts.wrappers`（嵌套在函数里的包装不可能被 import，一律不导出）。
3. 延迟决议：调用点若命中的是**导入的**绑定，不当场下结论，先落进 `FileFacts.deferredCalls`；`buildGraph` 拿到全量包装表后，用既有的 `resolveSpec` 把 spec 解析成文件、查出 `{side, method}`，才生成边（`via: 'wrapper'`）。

失败模式是**安全方向的**：解析不到目标模块的包装表就不产生任何边（`{label: t('key')}` 这类非 IPC 调用不会被误判），形参通道依旧是 `dynamic`。

**静态推导 preload 键**。`{ openDesktopWindow: invoke('desktop:open').roles('chat') }` 这个形状本身就是 `{name, channel}` 对。`walk()` 遇到 `pair` 节点时沿 `callee` 链下探到最内层的包装调用（`invoke('x')`、`invoke('x').roles(...)`、`invoke('x').mapResult(f)` 都能穿透），读出字面量通道，记进 `namedEntries`；`buildGraph` 再复核「导入的包装确实存在于目标模块」，最后供 `api:<name>` 兜底查询。

渲染上**区分来源**：声明表来的标 `declared`，推导来的标 `静态推导（无声明表）`，`api:` 命中推导键时也会在结果里说明一句。两者不混算。

**事实缓存**（`tools-trace.ts`）。键 = 绝对路径 + bridge 签名，校验 = `(mtimeMs, size)`，容量 6000、超限淘汰 1/4。缓存的是**单文件事实**而不是整张图，所以 `ffedit` 改完一个文件，下一次 trace 只重解析那一个。解析失败的路径也缓存成 `null` 标记，避免反复撞同一个坏文件。

### 2.1 为什么 `ast.ts` 里原有的缓存救不了

`ast.ts` 早就有 `factsCache`（同样按 `mtimeMs/size/bridgeKey` 校验），所以「慢」看起来不该发生。实测把它留下、只清掉新缓存：

| 状态 | 耗时 |
|---|---|
| 两个缓存都空 | 64,492 ms |
| **新缓存清空、AST 缓存热** | **60,280 ms** |
| 新缓存保留、AST 缓存热 | **962 ms** |

差别只有 6.5%。原因是 `factsCache` 的键**只有路径**，bridgeKey 只用来*校验*——一个文件只留一份事实。而 `assembleTraceGraph` 在别名存在时会跑两遍 `scanFacts`（bridge 扩表后重扫），两遍的 bridge 签名不同 ⇒ 这份单槽缓存每次都在两种签名之间被覆盖，**永远有一遍全量未命中**。也就是说这个缓存对 `fftrace` 事实上是死的。

更深的修法是把 AST 层缓存的键也带上 bridge 签名（一处改动，对所有调用方生效）。这里没有动它，是因为外层缓存还顺带覆盖了 HTML 内联合并与解析失败标记，且不必触碰 26 个套件共用的 `resetFactsCache()` 语义。

### 3. 实测（VCPChat，同口径前后对比）

| 项 | 修前 | 修后 |
|---|---|---|
| `ipc:open-desktop-window` · 主进程 handler | 1 | 1 |
| 同上 · preload 暴露 | **0** | **1**（`openDesktopWindow` · `preloads/api/desktop.js:12`） |
| 同上 · 直接调用 | **0** | **1**（`（wrapper）`） |
| `api:openDesktopWindow` | 未找到 | 命中，标注为静态推导 |
| 全树推导出的 preload 键 | 0 | **403** |
| `file:preloads/api/desktop.js` 外部包装调用 | 未呈现 | 3 条，带 `是否 IPC 取决于 ../core/define` |
| 单次调用（冷） | 37–70 s | 100 s（含首次双扫 + 新事实） |
| 单次调用（同进程第二次） | 37–70 s | **0.5–1.6 s** |

冷启动变慢是预期的：新事实多了一轮 AST 访问。热路径的 128× 才是这条改动对可用性的意义所在 —— 40 秒一次的工具在回合预算里等于不可用。

### 4. 仍未覆盖

- **命名空间绑定的成员调用**（`const define = require('./define'); define.invoke('ch')`）只记了绑定，没解析成员调用，所以不产生边。
- **导出别名**（`module.exports = { invoke: ipcInvoke }`）会让导入名与本地包装名对不上。
- **动态通道**依旧是 `dynamic`，VCPChat 全树 47 处。
- 缓存是进程内的：宿主重启后第一次 trace 仍要付全量解析。

### 5. 测试侧：`eval-trace-real` 必须逐进程

这条改动第一次跑全量套件时，`eval-trace-real` 挂在「两次冷装配必须产出同一张图」。表现是同一个仓库两次装配的摘要不同；但**单独**跑该仓库时，14 个摘要桶（files / depEdges / unresolved / registers / pushes / directCalls / gdefs / guses / bridgeRefs / unknownBridge / membership / pages / scanned / parseErrors）连续两次**逐个一致**。

差别只在「先跑完 VCPChat 再跑它」时出现 ⇒ 跨仓库同进程的 AST 池状态污染，与图算法无关。

顺手修了两处测试基础设施：

- `resetFactsCache()` 只清 AST 层缓存，清不掉新加的事实缓存 ⇒ 断言里的「冷装配」名存实亡。已导出 `resetTraceFactsCache()` 并接进 `assembleCold()`。**教训：任何新增缓存都必须同时提供能清掉它的测试钩子，否则「冷」是假的。**
- 多目标改为**每个仓库一个子进程**（`spawnSync` 重入本文件 + `DSH_FORGE_REAL_REPO`）。determinism 在这里是进程级属性，堆在同一个进程里测只会测到池的残留状态。

四目标（VCPChat / VCPToolBox / audio-engine-core / dsh-session-hub）逐进程复跑全部通过。

---

## 十、 知识卡片沉淀层（阶段一，2026-10-24）

### 1. 定位：缓存，不是资产

Qoder（Repo Wiki / Knowledge Cards / Skill 自进化建议）验证了一条「经验 → 持久工件」的沉淀路线，但它的前提是把 wiki 当**人拥有的文档**：in-repo 存储、人工编辑受保护、采纳要过 spec 门。dsh-forge 的知识卡走相反的定位——**缓存**：私有存放在 `~/.dsh/forge/cards/<workspace-key>/`（与快照库同键空间，别名解析规则一致，锚与台账永远不会指错对象）、整体可再生成、不进工作区（ffedit 治理管线完全不经手）、不设人工编辑保护。升级成资产（in-repo / 团队共享）是显式的后置路线，v1 不做。

### 2. 确定性蒸馏是地板，不是妥协

阶段一零模型：四张卡全部由台账批次 + 内容锚定 AST 骨架确定性编译（`overview` 总量与 reason 分布、`hotspot` 热点文件、`timeline` 近 14 天窗口、`structure` 近 30 批次涉文件的 depth-2 符号骨架）。这是**地板**：阶段二的模型润色层压在这组骨架上，骨架同时是模型失败时的回退管线（blackhole 双管线同构）。两个纪律由此而来：

- **字节确定性**：同一台账（加同一组被覆盖文件的 stat 签名）必须产出逐字节相同的卡。卡片内容里禁止 `Date.now()`（生成时间只进 `state.json`）、日期统一 UTC、排序用码点序而非 `localeCompare`——后两者都是 determinism 实测里最容易漏的机器差异源。
- **reason 分类是启发式**：关键词桶（fix/refactor/docs/test/feat/chore，先 kind 后 pattern、test 先于 feat）只喂分布统计行，永不参与坐标或回退决策。

### 3. 新鲜度锚：`{ batches, lastId, files }`

台账追加移动 `lastId`；**没有台账追加的外部编辑**由 `files` 捕获——structure 卡覆盖文件的 (size, mtimeMs) 摘要。锚的检查是 O(台账缓存视图) + 每覆盖文件一次 statSync，**永不触发解析**（`currentAnchor` 与 `buildCards` 共享 `anchorFor`，检查用的锚和重建用的锚不可能分叉）。这延续了 AST 层「锚定内容不锚定索引」的老原则，只是锚的对象从单文件内容换成了批次游标 + stat 签名。

重建在 `withFileLock` 内做双重检查后整体重写，`state.json` 最后落盘作为提交标记：看到旧 state 的并发读者只会多重建一次，永远不会读到「新 state 配旧卡」。卡片 md 先行、state 收尾的写序就是这里的崩溃一致性方案，与台账的 WAL 意图认证相比刻意更简单——卡的重建是幂等的，损失一个 state 只多一次全量重算。

### 4. 已知边界

- `files` 锚只覆盖 structure 卡的文件；hotspot/overview/timeline 只依赖台账，台账不动它们就不动，这是对的。
- fff 查询史库依旧读不到（fff-node 无 recordAccess API），查询侧信号缺席，「Agent 实际关心什么」这个维度要等 trackQuery 反哺的下一个通道。
- structure 卡对已删除/不支持语言的文件计数说明而非静默丢弃；`README.md` 这类非源码文件进「outside the AST languages」注脚。

### 5. 阶段二：蒸馏双路径与幻觉门（2026-10-24 同日落地）

**"默认使用当前模型"的约束先于设计**：DSH 的工具执行路径上不存在可注入的 LLM 服务面（官方工具包只注入 `tools/commands/fs/systemPrompt/subprocess`），工具既拿不到会话凭证也拿不到稳定的模型标识——所以"工具直接调用当前模型"在宿主契约里根本不存在。诚实的实现是**模型在环**（session 路径）：ff_cards 读骨架时附带蒸馏指令，当前会话模型以 `{polish, content}` 写回润色稿。这天然继承了 D3 的纪律——蒸馏消耗会话 token，结构上不可能后台静默发生。

`endpoint` 路径（baseUrl/model/apiKeyEnv/apiKey/timeoutMs）只在**读取**上内联执行：list 和 `skeleton=true` 永不发 fetch，失败回退骨架并说明原因。`validatePolish` 只检查反引号路径是否属于台账文件集、`#N` 是否为实际批次、frontmatter 和 32KB 上限。通过不代表内容真实：裸路径、数量、日期与自然语言事实未经核验。润色返回 `source: model` 和对应提示；`{card, skeleton: true}` 可直接读 `source: ledger` 的确定性来源。

落盘形态沿用自描述原则：润色稿是 `<name>.polished.md`，锚嵌在自己的 frontmatter 里，`readPolished` 一次读取即完成有效性判定，`state.json` 零记账。锚移动 → `dropPolished` 全弃（缓存语义的彻底执行）。配置面（`cards.distill/endpoint`）走 schemastery schema，即 DSH 插件管理器渲染的设置页——"设置页面"不需要自建 UI，schema 就是 UI。`off` 模式拒绝 polish 写入但继续服务已存草稿：关掉的是蒸馏行为，不是已有缓存。

### 6. 阶段三：注入闭环与第二个反馈回路（2026-10-24 同日落地）

- **动态目录注入被否，静态目录落地**。D4 的理想形态是 system prompt 常驻「当前工作区的卡片目录」，但 section provider 的契约只给 `{scope}`——解析回 workspace 需要自建 scope→agent→cwd 映射（agent/created 监听 + 作用域匹配），更致命的是热路径风险：prompt 装配在每次请求发生，目录若在锚过期时触发全量重建（含 AST 解析），等于把几百毫秒塞进首 token 延迟。落点改为 guidance 静态点名四张卡（~15 token），动态目录留在 ff_cards 无参数调用里——一次便宜的工具调用，永远新鲜。
- **读取计数（reads.json）**。卡正文每次被服务（polished 或 skeleton）计数一次，与 state.json 刻意分离，且**重建、丢弃润色稿都不清零**——用量是读者侧的历史，不是台账的派生物；advisory only，文件损坏从零开始只是少个提示。这是 ffedit→trackQuery 之外的第二个学习回路：台账反哺「项目是什么」，用量反哺「哪张卡值得蒸馏」。
- **反馈落点（诚实版）**。v1 只有两个消费者：蒸馏建议点名最常读的未润色卡（`suggestedDistillTarget`），/forge-status 展示锚新鲜度、润色 k/N、各卡读取次数。没有排序魔法——卡集固定为四张时排序无从谈起，等卡集扩张（工作流卡 v2）用量才参与排序。
- **status 与修复分离**。`cardsStatusFor`（/forge-status 用）与 `ensureCards`（ff_cards 用）是两条路径：status 永不重建、永不解析，锚过期只报告不修理——状态命令在热路径上，修理是 ff_cards 按需触发的职责。
