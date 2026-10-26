# dsh-forge 实现与工具实用性审查

> 本文保留初次审查时的发现、测量与修复状态，属于历史快照。后续修复、最终验证和同环境 Trace 性能对比见 [Trace 优化与问题修复记录](trace-optimization-2026-10-24.md)；下文的“未修改”不代表当前状态。

日期：2026-10-24。范围：当前工作树中的 TypeScript 插件、Rust sidecar、工具注册与宿主适配、测试和 npm 发布内容。工作树原有修改保留；本轮没有提交、推送或发布。

核心检索、符号读取和写入治理值得保留，适合局部重构与精简。主要成本集中在多套符号实现、Trace 全仓分析，以及默认工具面与发布配置。现有代码已有配置解析、注册、宿主适配、执行和台账边界，再增加抽象层的收益有限。

## 优先处理的问题

### 1. Trace 没有把扫描失败呈现给调用者

位置：`src/tools-trace.ts:201,224,263,274`。

`assembleTraceGraph()` 返回 `parseErrors`，工具执行时却没有接收这个值，输出 schema 也没有对应字段。文件读取失败或超过解析上限时，结果可能是不完整图上的普通“未找到”。

本地复现：工作区只有一个超过 2 MiB 的 JS 文件，其中存在目标 IPC handler。内部结果为 `scanned=1, parseErrors=1`；工具输出 `found=false`，文本表示“未找到该通道或 API”，没有扫描失败提示。

建议：把失败数和分析不完整的说明同时放进结构化输出与渲染文本，区分已分析范围内的零命中和完整否定结论。目录遍历失败目前也会直接返回，后续应一并完善覆盖度说明。

状态：已复现，未修改。

### 2. 发布包与原生加速的使用说明不一致

位置：`package.json:23`、`src/indexer-client.ts:41`、`README.md:95`。

`npm pack --dry-run --json --ignore-scripts` 确认发布内容没有 `rust_indexer/bin`，README 却把该目录描述为随包提供。源码 checkout 中的可用 sidecar 不能证明 npm 安装后也有相同性能；没有二进制时会回退 WASM。

当前本地二进制是 17,191,936 bytes 的 Windows exe。应先确定各平台可选发布包或外部安装策略，并让文档和运行状态准确反映安装结果。另有 README 的 `docs/DESIGN.md` 链接目标未进入发布包。

状态：已验证发布文件清单，发布策略未修改。

### 3. 卡片校验的保证超过了实际检查能力

位置：`src/distill.ts:147`、`src/tools-cards.ts:60,64`、`README.md:183`。

当前检查主要覆盖反引号包裹的路径形状文本，以及超过台账最后编号的 `#N`。它不能证明描述、数量、日期、actor、reason 或事实之间的关系真实。以下离线输入均返回空违规列表：

- 裸写的虚构路径：`The new module src/ghost.ts was added.`
- 已知文件上的虚构事实：反引号包裹的 `src/calc.ts` 后接“每天删除 999 个客户账号”。
- 不存在的零号批次：`Batch #0 created the module.`，台账实际只有 #1 和 #2。

此外，工具描述固定宣称 `no model calls`，endpoint 模式却会在读取时发模型请求。

建议：将润色明确标为模型生成的阅读层，保留可访问的确定性骨架和来源；收窄文档与工具描述的保证，并按 distill 配置生成准确描述。继续堆路径正则不能解决事实真实性问题。

状态：已离线复现，相关描述与校验逻辑未修改。

### 4. Trace 冷扫描代价不适合高频交互

位置：`src/tools-trace.ts:113,210,263`。

本轮真实仓库评估中，VCPChat 的 1,691 个候选文件首次图组装用时 104,053 ms，VCPToolBox 的 1,430 个候选文件用时 103,027 ms；各有 1 个解析失败。小型 dsh-session-hub 为 79 文件、2,908 ms，纯 Rust 仓库为 0 个适用文件、79 ms。

代码已有按文件 stat 和 bridge 集合区分的 facts 缓存，但每次查询仍走工作区发现与图组装；别名扩展可能触发第二轮扫描。符号查询的 worker 池没有直接加速这条 facts 管线。

建议：先将工具按需启用，再评估共享正在进行的同根扫描、工作区图缓存及增量失效；事实提取适合独立 worker。优化必须保留反向依赖、bridge 别名和页面成员关系的完整性。

状态：已有真实测量，未进行性能重构。

### 5. 符号后端有明确的收敛空间

位置：`src/tools-symbol.ts:224`、`src/indexer-client.ts:251`、`rust_indexer/src/main.rs:296`。

TS/WASM 和 Rust 分别维护 11 种语言的符号提取，worker 则是 WASM 的另一种执行方式。生产 definitions 查询先在 JS 中遍历，再向 sidecar 传完整文件列表；已有 root-walk 接口尚未进入生产查询主路径。

Rust 常驻进程的文件缓存是无容量上限的 HashMap。sidecar 请求固定 30 秒超时，符号查询预算为 15 秒，取消信号也未穿透 sidecar 请求。

建议：以跨后端 parity 测试为前提，确定主路径和必要回退；判断 root-walk 接口是否值得接入，否则删除仅服务实验的维护面。给长驻缓存和请求预算补清晰边界。

状态：源码确认，未重构。

## 工具实用性与精简方向

| 工具 | 判断 | 建议 |
| --- | --- | --- |
| `ffgrep` | 高频核心；多模式检索和紧凑上下文实用 | 保留；压缩重复说明 |
| `fffind` | 名称模糊定位与 glob 定位边界清晰 | 保留两种模式 |
| `ff_read` | outline → definitions → body 能减少整文件读取 | 保留统一入口；继续严格校验各视图参数 |
| `ffedit` | 内容锚定、歧义处理、写入台账有明确价值 | 保留 |
| `ff_file` | 创建、移动、删除等文件操作补齐治理 | 保留；避免与编辑引擎重复实现事务 |
| `ffhistory` | 为写入提供可追溯上下文 | 保留 |
| `ffrollback` | 安全恢复有独立调用语义 | 保留独立工具 |
| `fftrace` | 适合 JS/Electron 的静态关系调查 | 按需启用；先补不完整性提示与冷扫描性能 |
| `ff_cards` | 有持续施工台账时有用；新仓库没有历史就没有知识来源 | 按需启用；定位为施工历史摘要 |

现有 outline/definitions/body、多检索模式和 ticket 流程的合并方向合理。进一步把所有操作塞进一个 action 工具会增加参数歧义，收益不足。

推荐在现有注册逻辑中提供简单的工具启用列表，让默认工具面可收敛为前 7 个；该配置本轮没有实现。已有 additive/takeover 模式应继续复用，避免新增注册机制。

## 量化证据与适用边界

- 当前实际注册 9 个工具。native schema 用 cl100k_base 测得 3,307 tokens；仅保留前 7 个为 2,874，减少 433，约 13.1%。PTC TypeScript/Python 的全部工具投影分别为 4,041 / 4,571 tokens。这些数值不含额外 guidance，也不是 DeepSeek 模型的实际 tokenizer 成本。
- `scripts/measure-prompt-surface.mjs` 仍硬编码显示 13 个工具，而且把 bytes/4 的高估写成负数“低估”，应修正测量输出。README 的 worker 默认值写 0，代码实际为按核心数自动选择、最多 8 个，并按语料规模决定是否启用。
- fixture 定位任务 9/9 成功，定位证据直接支持修改 9/9 成功。返回上下文按 bytes/4 估算为 Forge 511、baseline 1,058。baseline 是测试自写文本扫描与整文件读取，没有计入常驻 schema，不能据此宣称真实宿主任务总 token 节省 52%。
- Trace 人工 fixture oracle 覆盖 11 类边，53 TP、0 FN、0 FP。真实仓库评估验证健康度、确定性和结构不变量，没有真实语料人工真值，不能宣称真实仓库准确率 100%。
- 最终发布清单为 150 项，压缩包 423,199 bytes，解包 1,497,674 bytes；其中 lib 为 1,472,382 bytes，source map 为 888,059 bytes，约占 lib 的 60.3%。可按发布需求去除 source map，分离仅用于测试的构建入口；不要单凭文件数量判断运行质量。

## 本轮实际修正

1. `src/distill.ts`：endpoint 在请求时读取 `apiKeyEnv`，正确发送 Authorization；显式 apiKey 优先。密钥不复制进解析后的配置。
2. `tests/run-distill.mjs`：补配置到 transport 的环境密钥回归，覆盖显式密钥优先；完全使用 stub，没有调用真实上游模型。
3. `src/tools-cards.ts`：将整条卡片操作声明为需要宿主串行执行，减少 endpoint 等待期间与 refresh 交错的风险。文件锁已经存在；此标记不等于跨 agent 全局互斥。
4. `build.mjs`：声明 emit 成功后，清理失去源文件的旧 `.d.ts`。已验证临时孤立声明被删除、当前 index 声明保留。失败时不执行这项清理，不承诺构建产物原子替换。

独立复核未发现上述保留修复的阻断问题。

## 验证记录

- 最终源码 `pnpm run build`、`pnpm run typecheck` 均 exit 0。
- 最终重跑除昂贵真实仓库 Trace 评估外的全部测试入口：26/26 进程 exit 0；其中 25 个套件实际执行通过，1 个真实宿主集成套件跳过。真实宿主文件系统模块路径不可用，尚未验证这项集成。
- 真实仓库 Trace 的四个目标已在本轮较早阶段完成健康度、确定性和不变量评估；最终四处小修没有改动 Trace 管线，因此没有重复昂贵扫描。
- 发布 dry-run 确认旧 project/history 模块的幽灵声明已经消失；sidecar 与设计文档缺失仍存在。
- `git diff --check` exit 0。

本地验证原始输出位于 Git 忽略的 `.tmp-analysis/review-final-tests.log`，测试退出码、发布清单摘要、边界复现和工具面测量分别保存在同目录 `review-final-test-results.json`、`review-pack.json`、`review-boundaries.json`、`review-prompt.json`。这些临时文件不作为发布内容。

建议后续顺序：先修正输出与发布承诺，再收敛默认工具面；随后针对 Trace 图缓存和符号后端做有测量依据的局部重构。
