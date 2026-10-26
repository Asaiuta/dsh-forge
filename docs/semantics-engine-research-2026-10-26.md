# 语义引擎调研:P1 sidecar 架构与外部实现对照(2026-10-26)

定位:评估成熟语义引擎作为 fftrace 底层能力提供者的可行性,不替换现有骨架(语法事实层 / linkgraph / 证据模型 / 8 类查询全部保留)。本轮为纯研究,未改代码、未提交。

方法:全部结论基于**源码级研究**而非 README。克隆至 `/tmp/dsh-research`(临时目录,不进工作区),commit 快照:scip@d556dd3、scip-typescript@ad3ca37(均 2026-10-22)、ariadne@3946c3c(2026-10-18)、infigraph@cf82f5d(2026-10-03)、ast-grep@05a7cf3(2026-10-25);rust-analyzer 与 TS LS 取官方文档/源码(见各节来源)。行号引用均对应该快照。

---

## 一、SCIP 协议(sourcegraph/scip)

**数据模型**(全部在单文件 `scip/scip.proto`,963 行):
- `Index` = metadata + repeated documents + repeated external_symbols。注释明确支持**流式消费**:metadata 必须在流首且仅一次,其余字段任意顺序(`scip.proto:20-39`)。
- `Document`(`:76-119`):`relative_path` 必须相对 `Metadata.project_root`、正斜杠分隔、**禁止符号链接**(`:82-91`);含本文件 `symbols`(SymbolInformation)与 `occurrences`。与 fftrace 的约束几乎同构(相对路径、正斜杠、junction 探测)。
- `Occurrence`(`:692-806`):symbol 字符串 + `symbol_roles` bitset + range(单行 3 元素数组省一个字段)+ 可选 `enclosing_range`(父 AST 节点范围,供调用层级)。**Definition 就是 role bit 0x1**(`:529`),另有 Import/Write/Read/Generated/Test/ForwardDefinition 位(`:531-545`)。没有 `is_implicit`(LSIF 概念,SCIP 已整体移除 LSIF 支持,`docs/DESIGN.md:20-22`)。
- `Relationship`(`:465-517`):is_reference / is_implementation / is_type_definition / is_definition——接口方法与实现方法的 find-references 合并靠它表达。

**符号编码**(`<scheme> ' ' <package> ' ' (<descriptor>)+`,`:154-180`):package = manager name version 三段;descriptor 后缀区分语义:`name/` 命名空间、`name#` 类型、`name.` term、`name().` 方法、`[n]` 类型参数。**局部符号仅限单 Document 内**(`:188-189`)。跨索引引用靠 scheme+package 对齐;`external_symbols` 提供未索引外部包的元信息。

**增量性:协议无内建增量**(CLI 无 merge 命令),但 `docs/DESIGN.md:35` 明言 Document 级切分"should be easy"支持文件级增量——即**per-Document 流式追加就是增量的天然接口,官方工具链未实现,留给了消费方**。

**工具链**(cmd/scip):`print`(结构化打印)、`snapshot`(索引→注释化快照)、`test`(快照校验)、`lint`(重复符号/悬空引用/符号格式检查)、`stats`、`convert`(SCIP→SQLite+zstd 分块,非 LSIF)。

**SCIP 明确不提供**:置信度、不完整性语义、增量更新协议、调用图完整性承诺。这正是 fftrace 证据模型的留白区——SCIP 只交事实边,诚实性由消费方负责,与既定判断一致。

## 二、scip-typescript(TS 语义索引器的唯一成熟参照)

约 5200 行 TS(不含生成代码),架构要点:

- **编译器驱动**:`ts.createProgram` + `program.getTypeChecker()`(`ProjectIndexer.ts:83-84`)。**不用 LanguageService、不用 findReferences**——引用发现靠遍历全 AST 的 Identifier/PrivateIdentifier/StringLiteral 节点 + `checker.getSymbolAtLocation`(`FileIndexer.ts:94-108`),import 别名用 `checker.getAliasedSymbol` 手动拆解(注释明言直接基于 TS 源码 goToDefinition.ts 的逻辑,`FileIndexer.ts:110-149`),还调用了 TS 内部 API(`TypeScriptInternal.ts`)。
- **多工程发现**:yarn/pnpm workspaces shell 出列表(`main.ts:221-293`),每工程递归 `indexSingleProject`,**project references 先递归索引**(`main.ts:142-151`);无 tsconfig 时 `--infer-ts-config` 注入最小配置(`{}` 或 `{"allowJs":true}`,上限 1000 文件)。与 fftrace `js-project.ts` 的归属问题同源,但粒度更粗。
- **符号编码**:package 段向上找最近 package.json 的 name/version(缺 version 用 `HEAD`,`Packages.ts:10-65`);Node→符号 Map memoize 跨文件共享(`ProjectIndexer.ts:73`)。
- **输出**:每文件一个 Document、每文件一次 Index 消息流式追加(`ProjectIndexer.ts:168-173`);跨工程重叠文件用 Set 去重(SCIP 协议要求);occurrence 按 range+role+symbol 三元组去重。
- **性能特征**:官方博客实测 1k–5k 行/秒(取决于类型密度);符号缓存显著增内存、可能 OOM(README 提供禁用开关);大 monorepo 慢的问题在 [issue #175](https://github.com/sourcegraph/scip-typescript/issues/175)(方向:按 package 并行分片)。默认跳过 >1MB 文件。
- **空白区(反面教训)**:无取消机制(AbortSignal)、无并行、无增量落地、长任务不可中断——这正是 fftrace sidecar 要补的,且 fftrace 的 AbortSignal 纪律与 PENDING 共享扫描已有现成模式。
- **版本策略**:`typescript ^6.0.3` 是**直接依赖而非 peerDependency**,node ≥22.13——锁版本是有意为之(见第四节 API 稳定性)。

**对 P1 的直接结论**:scip-typescript 验证了"createProgram + Checker + 节点遍历"路线在真实仓库可行且不需要 LS 的按需开销;fftrace 的 TS 语义 sidecar 应采用同一路线,输出格式直接兼容 SCIP 符号编码(见第八节)。

## 三、TypeScript Language Service 增量机制(按需 vs 全量)

- `LanguageServiceHost` 的 getScriptSnapshot/getScriptVersion 驱动失效;`DocumentRegistry` 是跨 LanguageService 实例共享 SourceFile 的存储(key = resolvedPath + 编译选项 + version,引用计数);TS v5.9.3 源码注释详述版本竞态防御(旧版本 SourceFile 被新版本"不可逆损坏",`src/services/services.ts` L1915–1957 附近)。**跨 Program 复用的只有解析产物,类型检查结果按 Program 重建**。
- 取舍:一次性批处理(索引)用 createProgram 更直接;常驻交互用 LS 增量廉价但内存常驻。
- `findReferences` 本质是全程序扫描 + 逐文件候选过滤,**逼近全量类型检查成本**(Knip 实测 `getSymbolAtLocation` 为最大热点,单次 trace 调用约 2900 次)——印证 scip-typescript 不用它的选择。
- **API 稳定性警示**:compiler API 不受 semver 保护([API Breaking Changes](https://github.com/microsoft/TypeScript/wiki/API-Breaking-Changes) 每次 minor 更新);wiki 已标注 **TypeScript 7.1(Go 原生移植)将是完全不同的 API**。含义:(a) sidecar 必须锁 typescript 版本(scip-typescript 直接依赖的原因);(b) 语义逻辑隔离在 sidecar 进程内,TS 7 迁移不冲击主进程——**这本身就是 sidecar 架构的又一独立论据**。

## 四、rust-analyzer(借设计,不借库)

- **red-green 增量**(salsa):输入变更 bump 全局 revision;依赖 memo 变红重算,重算后输出深度相等则标绿,**阻止失效级联**——"验证时未变即停止传播"是核心思想。
- **取消**:revision 计数 + 协作式检查,过期以特殊值 panic(`Canceled::throw`),ide 层 `catch_unwind` 边界转为 `Result<T, Cancelled>`。与 fftrace 的 AbortSignal+代次比对同构,验证了现有做法。
- **分层与 API 边界**:parser/syntax(纯语法、永不失败、可独立用)→ salsa 输入层 → hir 层("大脑")→ hir 门面(API Boundary)→ ide/ide-db(**POD 数据门面**)→ 唯一懂 LSP 的顶层 crate。"核心计算不稳定、对外只暴露可序列化 POD"的分层值得 sidecar 协议照抄。
- **ra_ap_\* 现状**:crates.io 每周发版、0.0.x 显式不稳定——**不应把 ra 当库链接**(会拖入巨量依赖树,毁掉 rust_indexer 的轻量性)。
- **scip-rust 已上游化**为 `rust-analyzer scip <CRATE>` CLI 子命令(load_cargo → StaticIndex::compute → 符号转 SCIP 输出)——证明"引擎当库 + 输出 SCIP"模式可行。**fftrace 未来 Rust 符号级需求的正道是消费其 SCIP 输出,不是自建**。
- 无构建/依赖缺失时:flycheck(调 cargo check)与语义分析正交,解析永不失败、部分可用——与 fftrace"语法层永远出结果,语义层按需补充、缺失即降级"的分层一致。

## 五、Ariadne(CRJFisher,MIT,v0.5.8)

**先修正一个传闻**:调研输入称其"组合 SCIP 符号索引 + SQLite"——**源码 grep 全仓无 SCIP、无 SQLite**(实际:tree-sitter 自产索引,JSON blob 持久化)。定位是"AI agent 守门人",但 MCP 工具面仅 2 个(list_entrypoints / show_call_graph_neighborhood)。

- **数据模型**:"scope graph" = 每文件 4 遍管线(query→scopes→definitions→references)+ 7 个项目级内存注册表。语言仅 4 种(JS/TS/Python/Rust)。SymbolId 含行列位置(`kind:file:startL:startC:endL:endC:name`,`packages/types/src/symbol.ts:63`)——**符号移动即换 ID**,比 fftrace 的 graphKey 脆弱。
- **置信度模型比 fftrace 细**:`Resolution.confidence ∈ {certain, probable, possible}` + 结构化 reason(direct/interface_implementation/collection_member/heuristic_match score)+ 失败侧 stage+reason 枚举分类(`packages/types/src/resolution.ts:11-35`)。多态调用保留多候选 resolutions。
- **缓存自校验**:每文件 JSON blob 自带四重戳(indexer_fingerprint/source_path/content_hash/git_blob_hash),断点续跑、指纹变更全量失效(`packages/core/src/persistence/storage.ts:12`)。
- **误报治理**:内置已知误报注册表(Flask 路由/dunder/测试),`--show-suppressed` 输出审计段——把守门人过滤变成可审计而非黑箱。281 个测试文件,含 corpus/property/benchmark。
- **弱项**:注册表纯内存(MCP 进程退出即弃,每会话重建);无 find-references 类工具暴露;4 语言。

## 六、Infigraph(intuit,Apache-2.0,v3.2.16)

- **存储**:嵌入式 KuzuDB 列存图库,DDL 在 `crates/infigraph-core/src/graph/schema.rs:53`:Symbol/Module/File/Folder/Cluster/Dependency 节点 + 15+ 种边(CALLS/IMPORTS/CONTAINS/INHERITS/TESTED_BY/SIMILAR_TO/BRIDGE_TO/…)。Symbol id = `path::Name::method`(名字限定,容忍移动)。
- **跨文件解析 = 名字匹配**(索引后置遍,全局 name→[(id,file,kind)] 表 + import 词干匹配,`resolve/calls.rs:18,58`)。**62 语言是统一的名字匹配深度**:59 种 tree-sitter `.scm` 查询 + 3 种 ANTLR,无类型推断,跨语言无 CALLS 边。ARCHITECTURE.md §11 自述局限表直认。
- **SCIP 是消费方**:`import_scip_index` + 独立 lsp-to-scip crate(任意 LSP→SCIP 转换)——类型信息只来自 SCIP 导入。
- **LearnedStore**(`learned/mod.rs:33`):把 SCIP 纠错记为可重放模式(0..1 confidence),用于校准自身启发式——"高可信源校准低可信启发式"的思路可迁移。
- **AI 接口**:MCP 92 个 tool_def + Web UI + 40 个 CLI 命令。值得注意:工具描述**内嵌盲区告警**(trace_callers 明示"同类兄弟方法默认不含,需 expand_interface")。
- **弱项(对 fftrace 的镜子)**:**无边级确定性标注**——fast-path 单命中、多候选过滤、learned 重放三类边同质化为 CALLS,**未解析调用静默丢弃不留悬挂边**,下游 agent 会误以为图完备;同名裸函数跨模块易假阳性。且写用户仓库(`.infigraph/` 目录)、依赖 KuzuDB(Windows 构建受限)。1367 个测试是亮点。

## 七、ast-grep 规则系统(结构匹配的表达方式)

核心模型在 `crates/config/src/rule/mod.rs:227` 的 `Rule` 枚举,三层组合子:

- **原子**:Pattern(字符串模式或 `{context, selector, strictness}` 上下文模式,`:200-215`)、Kind、Regex、NthChild、Range。
- **关系**:Inside / Has / Precedes / Follows(锚定父/子/前后兄弟节点)。
- **复合**:All / Any / Not / **Matches**(按 id 引用 `utils` 命名规则,带环检测 `check_cyclic`)。

三个值得吸收的设计(均已在 fftrace 有对应物或明确落点):

1. **元变量约束**(`rule_core.rs:52` 的 `constraints`):模式 `ipcRenderer.invoke($CH, ...)` 可对 `$CH` 施加子规则约束(如"必须是字符串字面量")——这正是 fftrace 通道字面量入边/动态参数入诊断这条纪律的**声明式表达**。fftrace 在代码里手写了这个区分;若未来框架规则增多,可参考此模型把规则数据化,而不必引入 ast-grep 本体。
2. **potential-kinds 优化**(`rule_config.rs:85` "Rule must specify a set of AST kinds to match"):每条规则必须声明可命中的 AST kind,扫描器只遍历相关节点——fftrace 的 AST 提取层(IpcFact/BridgeFact 等按节点类型走)隐式做了同样的事,规则数据化时应保留这个约束。
3. **严格度分级**(PatternStyle 的 Strictness:Cst/Smart/Ast/Relaxed/Signature/Template,`:160-180`):同一模式按注释/空白/等价语法容忍度分级。对 fftrace 的启示是语法事实提取可显式声明匹配严格度,而不是隐式选择。

局限(与调研输入判断一致):所有匹配单文件内完成,Matches 只引用规则集合,没有跨文件别名→导出符号的解析,故不能替代语义通道。

## 八、对照总结:fftrace 已被验证的优势与外部差距

| 维度 | fftrace 现状 | 外部参照 |
| --- | --- | --- |
| 边级证据 | candidate/certain + basis + config,未解析保留悬挂边并分类 | Infigraph 无标注且静默丢弃(反面教材);Ariadne 三级置信 + 结构化 reason(更细,可借鉴) |
| 诚实性 | incomplete/resolutionLimited/七类 UnresolvedReason | 两者均无等价机制 |
| 只读边界 | 进程内缓存,零落盘 | 两者都写用户仓库或全局目录 |
| 工具面 | 9 工具纪律,8 target 单入口 | Infigraph 92 工具(对立面);其工具内嵌盲区告警值得吸收 |
| 增量 | 三级缓存 + 签名失效 + AbortSignal | scip-typescript 无增量无取消;ra 有完整理论但未提供现成 TS 方案 |
| 语义深度 | 语法事实 + 归属闭包 | scip-typescript 已趟出 createProgram+Checker 路线 |

## 九、落地判断(P1 决策输入)

1. **TS 语义 sidecar 路线定型**:createProgram + TypeChecker + 全 AST Identifier 遍历 + getSymbolAtLocation(照 scip-typescript 驱动骨架),不引入 LanguageService;增量与取消用 fftrace 自己的(AbortSignal + 签名失效),这是官方实现的空白区,做了就是差异化。1k–5k 行/秒 → 2 万文件上限工作区的冷启动预算可据此标定(P1 前先 bench)。
2. **输出格式选 SCIP 的理由增强**:(a) 符号编码直接兼容 scip-typescript 生态;(b) `scip snapshot/test/lint` 官方校验链可白嫖作 sidecar 正确性验收;(c) per-Document 流式追加 = 文件级增量接口(协议设计意图);(d) 未来 Rust(scip 子命令)等多语言语义源统一汇入同一格式,infigraph 的 import_scip_index 已验证消费模式。**注意**:SCIP 无置信度语义,sidecar 输出需在协议外补一层 evidence 元数据(fftrace 私有 sidecar 通道,或 SCIP 的 diagnostics 字段借用)。
3. **版本与进程隔离**:sidecar 锁定 typescript 版本(直接依赖),TS 7.1 API 大改由 sidecar 进程隔离吸收——架构论据独立成立,与语义无关。
4. **证据模型演进(克制)**:candidate 内部再分层(probable/possible + 结构化 reason)作为 P1+ 方向记录,Ariadne 的 taxonomy 枚举是参照;不阻塞 P0/P1 主线。
5. **两条立即可抄的小改进**:(a) 工具描述/输出内嵌盲区告警(Infigraph 式,与 P0 A/B 的"问题→target"改动同向,把"本查询不含什么"写明);(b) GRAPH_CACHE 签名纳入提取器版本号——现状 signature 只含文件 stat 与 outcomes,**插件升级(提取逻辑变更)后图缓存不会自动失效**,Infigraph 的指纹(提取器版本+schema version)与 Ariadne 的 indexer_fingerprint 都证明这是必须的。
6. **明确不做**:ra 当库链接、ast-grep/Semgrep 本体引入(其规则表达思想见第七节,元变量约束/potential-kinds/严格度分级三点可在未来框架规则数据化时吸收)、Infigraph 式图数据库与 embedding 检索(与只读离线纪律冲突,且 fftrace 查询面已自洽)。

## 来源

- 本地克隆:`/tmp/dsh-research/{scip,scip-typescript,ariadne,infigraph,ast-grep}`(commit 见文首;临时目录,不复现时可按仓库名重新克隆)
- rust-analyzer 官方架构文档(docs/book/src/contributing/architecture.md)、[salsa overview](https://salsa-rs.github.io/salsa/overview.html)、[ra scip.rs 源码](https://rust-lang.github.io/rust-analyzer/src/rust_analyzer/cli/scip.rs.html)
- [TypeScript Compiler API wiki](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) · [API Breaking Changes](https://github.com/microsoft/TypeScript/wiki/API-Breaking-Changes) · TS v5.9.3 services.ts 源码
- [scip-typescript issue #175](https://github.com/sourcegraph/scip-typescript/issues/175) · [发布博客](https://sourcegraph.com/blog/announcing-scip-typescript) · [Knip 性能实测](https://www.knip.dev/blog/slim-down-to-speed-up)
