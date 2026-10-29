# M0–M1：证据契约与 Electron 闭环实施手册

状态：M0 已实施（M0.1–M0.7 全部落地并有测试）。M1.1 已实施（内容基线捕获、`snapshotId` 编辑门槛、跨进程复用）。M1.2 起待实施。先读[公共契约](forge-plan-contracts.md)；M1.2 及以后章节中的新增字段/函数/脚本仍是实施目标，不是当前能力。任务保持与[路线图](forge-capability-roadmap-2026-10-28.md)同号。

## M0 实施记录

已落地，全部进入 `pnpm test` 链：

| 任务 | 产物 | 测试 |
|---|---|---|
| M0.1 能力矩阵 | `src/trace-capabilities.ts`、`docs/trace-reference.md` 的矩阵表 | `run-trace-capabilities` + 各语言套件 |
| M0.2 审计状态 | `src/edit-audit.ts` 的 `status/reason/detail/coverage/baseline` | `run-edit-audit` |
| M0.3 统一出口 | `src/tools-edit.ts`、`src/tools-files.ts` 的 post-commit 整形 | `run-edit-audit`、`run-edit`、`run-targets` |
| M0.4 快照身份 | `src/trace-snapshot.ts`；`fftrace` 输出 `snapshot` | `run-trace-snapshot`、`run-trace-cache` |
| M0.5 被动状态 | `peekIndexerStatus()`、`/forge-status` 的 Trace 段 | `run-status-passive` |
| M0.6 分页 | `src/trace-rows.ts`；`limit`/`cursor`/`page` | `run-trace-pagination` |
| M0.7 字节身份 | `src/source-evidence.ts`；`ff_read` 的区间与哈希 | `run-source-evidence` |

实施中确认的两处边界（后续任务不能当已完成）：

1. ~~快照强度在 M0 只能是 `observed`~~：M1.1 已提供 `capture=true` 的 `content-bound` 路径；但普通快路径的快照仍是 `observed`，且没有捕获就无法声称“知道新增问题”。M1.2 的桥接差分必须建立在捕获基线上。
2. 桥接站点的位置证据只有行号。范围身份（起止列）属于 M1.2，因此当前“同一行两次调用”只能计为两行记录，不能报“精确调用次数”。

## M1.1 实施记录

| 产物 | 位置 | 测试 |
|---|---|---|
| 捕获扫描（逐文件读字节、严格 UTF-8、双次 stat 判稳定） | `src/tools-trace.ts` 的 `scanFactsForCapture` | `run-trace-capture` |
| 单次读取的 facts 入口 | `src/ast.ts` `fileFactsFromText`、`src/trace-facts.ts` `extractTraceFileFromBytes` | `run-trace-capture`、`run-trace-languages` |
| 私有基线存储（TTL/条数/字节预算、原子写、轮换） | `src/trace-capture.ts` | `run-trace-capture` |
| `capture` 参数与 `capture` 输出段 | `src/tools-trace.ts` | `run-trace-capture` |
| `snapshotId` 编辑门槛 | `resolveBeforeEvidence()`；`ffedit`/`ff_file` 在写锁内校验 | `run-edit-audit` |

三处刻意保留的边界：

1. **捕获用 WASM，不借 sidecar 的 facts。** sidecar 目前不返回其输入的内容身份，用它的结果就等于用两份不同来源的内容互相背书。原生路径要重新做 parity 才能进入基线。
2. **不完整即不保存。** 截断、部分解析、读取期间文件变化都会把强度降为 `observed` 并给出 `saveError`；手工构造的截断记录也会被 `saveBaseline` 拒绝。基线从不把“少看了几个文件”包装成“没有问题”。
3. **编辑门槛不是编辑许可。** `snapshotId` 通过只说明 beforeHash 存在且仍匹配；`drift`/`not_covered`/`observed_only`/`unavailable` 都会拒绝写入并说明原因，省略 `snapshotId` 仍是普通编辑。

## M0.1 能力矩阵与文档对齐

**依赖**：无。**改动**：`src/tools-trace.ts`、`src/indexer-client.ts`、`src/tools-symbol.ts`、`docs/trace-reference.md`；复用现有语言/项目测试。

1. 将 Trace 扫描扩展集合和静态语言支持映射整理成可读取的只读导出，保持扫描行为不变；不得拿 sidecar 的 SUPPORTED 直接生成“Trace 支持语言”列表。
2. 以 `parse / fileDependency / projectResolution / symbolReferences / runtime` 五列形成矩阵；前三列按源码/测试填写，后两列当前未实现处明确 false/unsupported。
3. 更新 Python packaging、Cargo path/workspace 继承、Go work/replace、Lua path、JS re-export/program closure 说明；Cargo members/exclude 完整语义不得提前标完成。
4. 将 `.cs`、`.vue/.svelte` 和二进制单列，分别说明定义与依赖差别、script-only、元数据而非调用链。

**验收**：现有 `run-trace-languages`、`run-trace-projects`、`run-trace-python-project`、`run-trace-cargo`、`run-trace-gowork`、`run-trace-luapath`、`run-trace-reexports` 脚本；各为 `node tests/<名称>.mjs`。新增矩阵断言必须确认 C# 未被误报为文件依赖完整支持。**完成产物**：矩阵与测试一致，不新增扫描语言。

## M0.2 审计状态不能靠有无输出判断

**依赖**：M0.1。**改动**：`src/edit-audit.ts`、`src/tools-edit.ts`；扩充现有 `tests/run-edit-audit.mjs` 并加入 test 链。

1. 将 `auditEdit()` 改为总是返回结构化审计结果；保留 findings 的展示，但增加 C2 状态、reason、coverage、基线身份。
2. 当前名称出现检查仍只能生成 `partial/legacy_heuristic`；找不到缓存返回 `not_run/no_baseline`，不适用返回 `not_run/not_applicable`，异常返回 `partial/audit_error` 或尚未开始时 `not_run/audit_error`。
3. 删除“调用现在一定失败”式结论；即时输出用“静态可见消费者仍引用已移除成员，需复查”。无发现可以短渲染，但结构化结果必须可区别未检查。
4. 更新输出 schema/render，禁止通过异常 catch 静默抹掉状态；审计失败不改变已经完成的写入结果。

**测试**：热缓存有发现、冷态、普通无关编辑、解析失败、审计异常、名称只在注释/无关对象里出现；断言写入状态仍为 applied，而审计没有虚假 passed。**退出**：任何分支都有可解释状态；审计不是写入成功的必要条件。

## M0.3 所有施工入口统一接审计

**依赖**：M0.2。**改动**：`src/tools-edit.ts` 的普通执行、`decideTicket`、结果整形；`src/tools-files.ts` 的成功提交出口。

1. 提取一个 post-commit 结果整形函数，输入 `{workspace,batchId,changedFiles,before/afterRefs}`；审计调用放在写锁外，避免长分析锁住施工。
2. 普通编辑和票据成功都调用该出口；noChange、不写入的歧义和失败分支不伪造变更批次；一次提交只审计一次。
3. `ff_file` 先将 create/delete/move/move_code 映射为 changedFiles；适用规则未实现时返回 not_applicable，不能只遗漏这个入口。
4. post-commit 读取到后续编辑时，返回 stale，不针对别人的新内容归因。将自身 before/after 身份作为判断依据，而非最后一次读到的字节。

**测试**：`run-edit-audit` 增加票据确认、noChange、同文件多个 step、文件操作、提交后外部修改；回归 `run-edit`、`run-targets`、`run-files`。**退出**：相同字节变更无论通过哪个入口，审计语义一致。

## M0.4 显式快照与配置身份

**依赖**：M0.7 的字节身份；可先设计，随后落地。**改动**：`src/tools-trace.ts` 的 GRAPH_CACHE/assemble/peek，新增 `src/trace-snapshot.ts`。

1. 定义 configKey，覆盖规范 root、declarations 选择及摘要、compileCommands 选择及摘要、项目上下文签名、提取器/schema 版本；缺省值有固定表示，禁止“最近一次任意配置图”。
2. 给每次 assembly 一个不可猜的 snapshotId 与来源描述；新的查找函数按 snapshotId/workspace/configKey 找到唯一快照。旧 peek 只供明确标成 observed 的建议使用。
3. 快照携带已知文件/候选集合/解析探针与配置身份。M0 现有 stat 缓存只标 observed，不能直接冒充 content-bound；M1.1 才建设正式内容绑定路径。
4. 查询原快照与校验当前适用性分开：旧图可用于 before，但不能代表 current。缓存淘汰、进程重启或找不到 ID 返回 snapshot_unavailable，不能切换到别的图。
5. 单工作区多 declarations/编译配置并存；snapshotId 不允许跨工作区使用。M1 持久快照复用相同 schema。

**测试**：扩充 `run-trace-cache`：双 declarations、编译配置换值、同大小恢复mtime、依赖新增、目录链接/大小写变化、token跨工作区、淘汰后重用。**退出**：不出现旧图换新身份或错误配置图被复用。

## M0.5 被动能力状态

**依赖**：M0.1、M0.4。**改动**：`src/tools.ts` 的 status command、`src/indexer-client.ts` 状态读取；M2 后接语义状态。

1. 提供不触发 spawn 的 `peekIndexerStatus()`；只报告 configured/not_started/ready/failed 和已知版本，未探测不写“可用”。
2. status 增加 Trace 覆盖语言、缓存快照数、原生就绪、语义和宿主检查状态；未实现阶段明确 not_installed/unavailable。
3. 不为了展示状态调用 indexerReady、Cargo、Node服务器或 package manager。后续主动诊断另设显式操作，不能改变 status 的被动语义。

**测试**：现有 `run-tools`、`run-indexer-fallback`；用替身统计 spawn/execute 为0，分别模拟未启动、可用、崩溃。**退出**：状态查询零工程代码执行，不依赖网络。

## M0.6 完整结果与分页

**依赖**：M0.4。**改动**：`src/trace-analysis.ts`、`src/trace-queries.ts`、`src/tools-trace.ts`；新增 `tests/run-trace-pagination.mjs`。

1. 从 exposes 渲染中分离结构化行计算；成员消费者保留 file、成员名、范围身份，不能从已截断 text 反向解析。
2. impact 内部保留预算内完整结果，分页发生在查询层；节点/边预算仍保留。区分 traversalComplete、resultComplete、展示截断，不能移除预算换“完整”。
3. 首版页面默认100行、最大500行；cursor保存 query/snapshotId/offset，在进程内用随机ID查表，不接受任意客户端偏移跳过范围检查。
4. 后续页只返回同一不可变快照；发现快照与当前不一致时明确 stale，继续浏览旧快照须明确标注，不能用于当前修改计划。过期cursor要求重查。
5. file/impact/exposes 的查询过滤只裁剪结果，不偷偷缩小依赖发现。若要改变扫描范围，必须成为 configKey 的一部分并暴露 coverage。

**测试**：250个消费者分三页、同一行多个成员、空页、取消、预算不足、翻页期间改文件、改查询复用cursor、淘汰。**退出**：完整取回时总数一致、无重复/遗漏；遍历本身不完整时分页也不能声称完整。

## M0.7 字节、文本和位置转换

**依赖**：无，可与 M0.2 并行。**改动**：新增 `src/source-evidence.ts`；`src/tools-read.ts`、`src/tools-symbol.ts` 接入；新增 `tests/run-source-evidence.mjs`。

1. `readSourceSnapshot()` 一次读取 Buffer，计算 rawHash，严格 UTF-8 解码，保存 BOM/EOL，生成规范文本与 textHash；不支持的编码显式拒绝用于编辑。
2. 实现规范文本 offset↔0-based UTF-16 position；展示1-based行号通过显式转换。多字节 UTF-8 的 native offset 必须经过对应字节→UTF-16映射测试。
3. body块返回实际 displayRange；符号另给 symbolRange。当前加context后正文与lines范围不一致的问题在此修正。
4. 读取本身不自动锁住未来写入；将 SourceRef 传给预览/编辑时重新读 rawHash，失败要求重读，不用相同行号继续改。

**测试**：ASCII、中文、非BMP字符、BOM、LF/CRLF/CR、空文件、文件末尾、半开区间、同字节长度修改、context扩展；现有 `run-read`、`run-ast`、`run-targets` 回归。**退出**：展示和替换对应同一段字符，哈希与解析字节来自同一次读取。

## M1.1 捕获可用于前后比较的基线

**依赖**：M0.4、M0.6、M0.7。**改动**：`src/trace-snapshot.ts`、`src/trace-facts.ts`、`src/ast.ts` 的buffer解析接点、`src/tools-trace.ts`。

1. `capture=true` 开启正式路径：候选发现→读取受预算限制的Buffer→从这些Buffer提取facts→构图→保存清单/配置/探针。普通非capture调用继续快路径。
2. 为 `extractTraceFile` 提取共享的buffer/text入口，避免先fileFacts读磁盘再读另一份内容计算hash；JS/TS/HTML先实现。其它语言没有buffer绑定入口时将对应范围标partial，不借用旧缓存给出content-bound完成结论。
3. sidecar未返回同一输入的内容身份前，该正式路径用WASM；不假设原生facts与稍后读到的文件必一致。以后增加原生协议须另做parity。
4. 保存规范facts和清单到私有 verification 数据区，不在工程内写快照；记录来源版本。基线最多20个/工作区、初始24小时TTL、128MiB预算，超限返回明确信息，不截断后假完整。
5. `ffedit/ff_file` 接snapshotId时校验其工作区与提供者beforeHash；调用者没提供仍可普通编辑。正式改后检查可使用before快照，但必须重新构建after。

**测试**：新增 `tests/run-trace-snapshot.mjs`：捕获后重命名、进程重启、snapshot损坏/过期、提供者已变、捕获期间文件变化、预算与原生缺失。**退出**：记录中的hash可以重算，facts与其输入匹配；无基线时只能做当前检查，不能声称知道新增问题。

## M1.2 基于 AST 的桥接差分

**依赖**：M1.1。**改动**：`src/edit-audit.ts`；`src/facts.ts`/`src/linkgraph.ts` 必要的站点与未知证据；新增 `src/bridge-check.ts`。

1. 将 expose 标识为 `{providerFile,object,siteRange}`；成员集合来自对应 expose 的AST对象，不从全文件名称搜索推断。动态对象名、spread、计算属性分别记录unknown。
2. 消费站点标识为 `{file,range,object,member}`，以range区分同一行调用。现有只有行号的facts不能直接给“精确调用次数”；新增范围需同步WASM/原生协议，未同步的路径明确降级。
3. 对相同对象合并提供者前先确认归属；多preload同名全局而无法按页面确定时返回ambiguous，不能任选一个提供者。局部别名须确认词法作用域与未重赋值，无法确认的保留候选。
4. 从before提取变动的提供面，从after重新解析消费者和IPC；删除成员仍有明确消费者→finding，注释/字符串/无关对象不计，已补改消费者消除finding。
5. 差分以对象/成员/文件/范围映射和原文锚匹配；先前就存在的缺失列existing，确定本次引入列new，无法对应列unknown。原有错误不能被行号变化伪装成新增或自动消失。
6. 无确定问题且范围完整、规则可判定才passed；动态未知影响当前问题时partial。保持规则集小：expose缺成员/全局、IPC缺handler/方法不匹配，不在此自建全语言类型系统。
7. IPC先建明确的方法配对表：renderer.invoke→main.handle/handleOnce，renderer.send/sendSync→main.on/once，webContents.send→renderer.on/once；按解析后的channel和已知进程/页面归属匹配，不只比较字符串。只统计静态可见注册；动态通道、未知wrapper、运行时移除/条件注册、无法确定接收页面均保留unknown。匹配成功只代表存在相应静态端点，不证明回复、投递或时序正确。

**测试**：扩充 `run-edit-audit`，新增 `tests/run-bridge-check.mjs`：两消费者、局部别名、同名对象诱饵、注释、spread、动态成员、重赋值、同一行两调用、同名多preload、先存错误、删文件；IPC含invoke仅有on、同通道不同页面、动态注册、删handler。**退出**：修复全部静态遗漏后可通过，歧义/动态路径不会伪绿。

## M1.3 显式正式检查与快速建议分离

**依赖**：M1.2。**改动**：新增 `src/tools-check.ts`，调用 `bridge-check`、`trace-snapshot`；`src/index.ts` 注册。

1. 实现C3的 `ffcheck action=static`：校验batchIds与工作区→读取before基线→捕获after→按checks分派→生成CheckResult；默认检查bridge与syntax，M2再接types，不接受tests作为静态项。
2. 输入多个批次时取每个文件最早before、最后after，核对中间链是否相接；没有完整链时只做当前检查，新增归因为partial。
3. 当前文件必须匹配所选最后afterHash；否则返回stale并建议选择新批次/重新捕获。静态检查不偷偷将其它人的修改归到当前批次。
4. syntax复用 `syntaxValid`，输入必须来自after快照；逐个检查变更且仍存在的受支持源码，删除项列明不适用，未知编码/不支持的脚本范围标partial。发现ERROR/MISSING则failed；它只证明语法解析，不代表类型或运行时正确。文件删除或不适用导致零检查时not_run，不制造passed。
5. 快速post-edit仅给建议，不调用完整capture；正式检查允许冷构图并遵循取消和预算。取消不得提交一条passed记录。

**测试**：新增 `tests/run-check.mjs`，覆盖冷态、跨批补改、链断裂、旧批次检查、取消、语法错误、仅删除、不支持语言、缺基线、checks非法组合。**退出**：完整检查延迟只由显式工具调用承担。

## M1.4 宿主验证适配：先证实审批通道

**依赖**：M1.3。**改动**：新增 `src/check-host.ts`、`tests/run-check-host.mjs`；接 `src/host.ts`、`src/index.ts`、`src/tools-check.ts`。

1. 先核验当前已安装宿主：找到受支持的工具派发/子进程服务、作用域与审批入口、终态结果和取消协议，记录实际版本与符号。禁止猜服务名。现有 NativeDelegate 直接调用definition.execute，不能当中央审批证明。
2. 设计 `HostCheckAdapter.capabilities()` 和 `run({recipeId,program,argv,cwd,scope},rawExec)`；rawExec保持对象身份，绝不序列化存盘。能力查询只读取状态。
3. 返回 `unavailable/denied/running/completed/cancelled/interrupted` 判别结果；completed必须有宿主来源的callId、exitCode、outputRef。后台启动回执不是完成；没有可信终态通道就不开放后台检查。
4. `action=plan` 只生成检查清单：静态bridge、语法、用户显式选定的类型检查/测试recipe。recipe保存程序、参数数组、cwd、输入范围及判据，hash与checkPlanId绑定；更改任何参数需要新计划与审批。
5. `action=run` 只接受保存的checkPlanId；实际派发仍通过宿主审批，不接受客户端传入approved=true。没有可证明的安全派发接口时整个run为unavailable，不用spawn补洞。
6. 最小真实宿主试验使用固定 `node -e 'process.exit(0)'` 和退出7版本；断言批准才执行、拒绝零启动、raw身份不丢、callId能读回结果。替身测试不能代替这一步。
7. 退出0只说明进程成功：tests首版解析C2限定的Node TAP报告，核对报告属于本次callId、未截断、计划与结束计数一致、实际测试数大于0、无失败且必需用例未跳过；todo/skip不充当通过。类型检查需对应诊断/退出协议；无法解释的用户命令只记录process结果，不把它升级为tests通过。
8. 派发前和终态后复核checkPlan的inputManifest；执行中源文件或配置改变则结果stale，即使退出0也不适用。stdout不足以证明完整时读取宿主受控完整输出，仍无法取得则partial，不从截断片段推导通过。

**测试**：`rawContextIdentity`、`approvedResultRoundtrip`、`deniedNeverStarts`、`cancelBeforeAndDuring`、`backgroundNeedsTerminal`、`missingOrForgedEvidence`；报告用例包括零测试、全skip、todo、嵌套测试、截断、旧报告、执行中改文件；回归现有 `run-tools`、`run-host-integration`。**退出**：能证明审批和结果归属才开放run；否则static/plan/show可交付，宿主执行子项保持未完成。

## M1.5 验证记录接入历史和卡片

**依赖**：M1.3；执行记录另需M1.4。**改动**：新增 `src/verification.ts`；`src/tools-edit.ts` 的history输出、`src/history.ts`、`src/cards.ts`、`src/tools-cards.ts`、`src/distill.ts`。

1. 按C2保存独立不可覆盖记录，记录完整afterHash、实际检查上下文、范围和来源；append成功才推进revision。处理半写文件，不能把存在临时文件当成功。
2. `ffhistory batch=... checks=true` 列出全部尝试及当前适用性；失败后通过可显示最后有效结果，但原失败不消失。
3. cards在原账本锚上加入verification revision和覆盖输入适用性摘要；只是新检查没有新代码批次也要刷新。size/mtime未变但内容变时不得沿用当前通过。
4. 确定性卡片渲染明确的状态表；模型润色不能修改“测试通过/未跑/过期”事实栏。外部报告独立标识，不接收用户传入status=passed作为可信记录。
5. 存储失败不撤销代码写入；工具报告验证记录未持久化，history不能声称已经归档。日志默认保存摘要/受控引用，凭据与环境值不入库。

**测试**：新增 `tests/run-verification.mjs`；扩充 `run-cards`、`run-distill`：伪造passed、revision更新、老结果过期、损坏记录、失败保留、无代码变更的新检查。**退出**：卡片上的每个验证结论都能追到实际记录与输入版本。

## M1.6 工具注册与指引联动

**依赖**：M1.3–M1.5。**改动**：`src/index.ts`、`src/guidance.ts`、`src/registration.ts` 相关类型、`src/config.ts` 仅必要能力配置；README当前工具数量在实际注册后更新。

1. 为check增加ForgeCapability和additive surface；不接管宿主命令工具。指导文字通过现有visibleForgeText输出，缺失就不推荐。
2. 指导顺序为读取→Trace capture→编辑带snapshot→ffcheck static→有权限时run→history；票据与重构计划遵从各自schema。
3. no-op或纯文本编辑不强制每次全链；根据audit状态给最小下一步建议。所有自动建议仍由用户/Agent决定调用，不隐式执行。

**测试**：现有 `run-mount`、`run-registration`，覆盖additive、takeover、check隐藏、宿主run不可用；工具数量断言按实际新增修改。**退出**：模型不会看到未注册或未实现能力的指令。

## M1.7 缓存、恢复与真实宿主闭环

**依赖**：M1.1–M1.6。**改动**：以测试为主；仅发现实际断点时修改 `src/overlay.ts`、`src/ast.ts`、`src/tools-trace.ts`、`src/cards.ts`，不新建总缓存管理器。

1. 以已有 `commitFiles/markWritten` 为写入通知源，测试全文搜索立即读新字节；AST按内容身份更新，Trace按配置/集合/探针校验，卡片按批次/检查revision刷新。
2. 测试普通编辑、票据、move、失败事务恢复、rollback五条路径；回滚后旧验证仍保留为历史，但不是当前通过。
3. 在真实DSH中完成下面自包含场景，保存对应tool-call与result关联；如果工具没注册或Agent绕过闭环，不把内部函数测试当宿主成功。

**新增脚本**：`tests/run-forge-loop.mjs`；回归 `run-overlay`、`run-trace-cache`、`run-files`、`run-cards`、`run-host-integration`。

**DSH验收提示词（实施后使用）**：

> 在我授权的临时工作区创建三个文件：preload.js 内容为 `const {contextBridge}=require('electron'); contextBridge.exposeInMainWorld('chartAPI',{togglePin(){return 1}});`；a.js 内容为 `window.chartAPI.togglePin();`；b.js 内容为 `const api=window.chartAPI; api.togglePin(); const other={togglePin(){return 0}}; other.togglePin();`。先用插件读取并捕获桥接基线，然后仅把preload的成员改成pinToggle，确认写入成功但检查发现a.js和b.js各一处遗漏。只修这两个消费者，不改other，再次检查并在history/cards查询证据。未执行测试必须显示未运行。最后预览一次回滚，等我确认后才应用，并确认搜索、读取和Trace看到恢复内容，旧检查不再表示当前通过。不要发布、联网或安装依赖。

**退出**：正向、漏改、动态未知、回滚及拒绝路径均有真实证据；缺宿主执行协议则如实交付静态闭环，不能将M1.4标完成。
