# M2–M3：JS/TS 语义与跨文件安全变更

状态：待实施。遵循[公共契约](forge-plan-contracts.md)；依赖[M0–M1](forge-plan-m0-m1.md)的版本、检查与权限边界。下面模块/API名称是拟定方案。

## M2.1 后端最小试验与选型门槛

**依赖**：M0.7；可与M1并行。**改动**：新增 `tests/bench-semantics.mjs`、`tests/run-semantic-oracle.mjs`；此项暂不接生产工具。

1. 以当前本地已安装的TypeScript 5.9.2做首个可复现试验，记录确切版本；它目前只是devDependency，不能假设用户运行时一定有。后续升级必须重跑相同契约用例，不把当前版本称为最新版本。
2. 构造两种原型：A使用 `ts.createLanguageService(host,registry)` 查询；B使用 `ts.createProgram`、TypeChecker及节点遍历建立声明/引用索引。两者使用同一组规范文本、编译选项、项目集合和人工真值。
3. 固定三档fixture：单项目别名/重载；多tsconfig与项目引用；多包workspace和re-export。另选用户允许的真实仓库标注子集，不将整个仓库随机命中当真值。
4. 依次测进程启动、第一次引用查询、第二次查询、单文件改动后查询、配置改动、取消；记录wall time、峰值RSS、文件/引用数、失败和未知数。
5. 先A/A测噪声，再交错A/B；每组至少7次，分别报告冷/热/更新，不相加多线程自计时当墙钟。测试发生在隔离进程，线程与缓存条件固定。
6. 选择规则：先全部人工fixture正确且无假完整；再验证取消/更新；只有效果超过同实现噪声且多个位置分组方向一致才用性能选型。无显著差异默认A，因为目标是交互式编辑后的按需查询。

**执行**：实现后先跑 `node tests/run-semantic-oracle.mjs`，真值通过再跑 `node tests/bench-semantics.mjs`；脚本输出各配置的输入身份和逐次读数。

**退出**：保留输入、版本、逐次JSON读数和选择结论；如果两者语义均不达标，先修原型，不把研究结果包装成M2上线。后续只发展选中的一条生产通道。

## M2.2 隔离的 TypeScript 服务生命周期

**依赖**：M2.1；启动权限另依赖M1.4同等级的宿主契约验证。**新增**：`src/semantic-types.ts`、`src/semantic-client.ts`、`src/semantic-worker.ts`、`src/semantic-typescript.ts`。**修改**：`src/index.ts`、`src/config.ts`、`build.mjs`，实际引入依赖时才修改package/lock。

1. 第一版只做TS，不先造通用LSP框架。通过 `semantic-types.ts` 定义请求 `{id,method,workspaceId,configKey,snapshotId,params}` 和响应 `{id,status,context,coverage,result}`；禁止读取未声明路径或执行任意方法。
2. ServiceHost从已授权快照取 `getScriptSnapshot/getScriptVersion/getCompilationSettings/getScriptFileNames`；文本版本用textHash，不用mtime。文件系统访问统一走限定根/预算/真实路径检查，TS标准库根由受信依赖位置提供。
3. 优先通过已核实的宿主进程服务启动固定插件worker，绑定scope、signal、允许读取根和生命周期。没有可证明的启动/文件权限传递时返回unavailable，不能绕过宿主用任意spawn。worker进程隔离本身不是安全沙箱。
4. 若M2.1选择LS：每project使用一个LanguageService，共享DocumentRegistry仅在其支持的语法树范围内；配置、TS版本或上下文不同不能复用类型结果。
5. 子进程消息采用固定schema、请求ID和大小限制，stdout只作协议，日志走独立通道；任何response的id/版本不匹配都丢弃。等待启动有超时，不阻塞fffind/ffgrep/静态Trace。
6. CPU密集TS调用无法处理同事件循环里的cancel消息时，用可跨线程/进程观察的取消标志或终止本插件拥有的worker；不能只向忙死的事件循环发一条cancel后宣称已取消。返回中断状态，后续请求重建。
7. 原型使用已安装TS；正式交付把测试通过的精确版本作为明确的可选运行时依赖，禁止从分析工程加载任意typescript包或tsserver plugin。不运行tsconfig plugins，不自动执行npm。
8. `semantic`配置初始默认禁用，显式启用且通过启动授权后可用；卸载插件、工作区关闭、崩溃都释放本插件持有资源。不能终止用户独立启动的服务器。

**新增测试**：`tests/run-semantic-client.mjs`，模拟慢启动、坏JSON/大消息、id错配、版本错配、取消、崩溃、卸载；断言Trace静态路径仍可用。**退出**：没有后端仍可正常使用旧功能，失效/取消不会返回旧结果。

## M2.3 符号、引用与诊断操作

**依赖**：M2.2。**改动**：`src/semantic-typescript.ts`、`src/semantic-types.ts`；扩充 `run-semantic-oracle`。

1. `definition` 调 `getDefinitionAtPosition`，`references` 调 `findReferences`；接收位置前校验SourceRef和规范文本边界，不落在有效符号时返回not_found而非随意附近名字。
2. 对每个结果组保留后端definition与引用，不按显示名字合并不同组。snapshot内symbolId由provider/version/configKey/声明路径/范围构造，移动后重新解析，不能充当跨版本永久ID。
3. 保存声明标记、read/write信息；TypeScript未提供的角色记unknown。只有后端明确的call hierarchy结果才标call，不能把类型引用或方法取值当实际调用。
4. 诊断先返回 `getCompilerOptionsDiagnostics`，再对请求项目成员收集syntactic/semantic diagnostics；记录文件范围、code、category、消息和sourceRef。跨文件diagnostic相关信息保留引用，避免只剩一段文本。
5. 调用层次在基础查询完成后加入 `prepareCallHierarchy` 与 incoming/outgoing操作；一次只展开一层，节点/结果有预算；实现、多态候选与动态目标边界单独显示。
6. 部分项目无法加载或依赖缺失时仍返回已知结果，但coverage为partial；空引用集合必须同时说明项目及文件范围，不能解释为全世界无人使用。

**人工fixture**：两个模块的同名函数、类成员和局部变量同名、import别名、默认/namespace导入、接口和实现、重载、类型专用引用、方法赋值、动态属性。对每类保存预期声明/引用位置；比较结构化集合而非输出文案。**退出**：同名诱饵不进入目标集合，动态未知不会被抹掉。

## M2.4 公开入口、读取与结果衔接

**依赖**：M2.3、M0.6。**改动**：`src/tools-trace.ts`、`src/trace-queries.ts`、`src/tools-read.ts`、`src/guidance.ts`。

1. tools-trace先识别C3的 `definition:/references:/calls:` 新类型，校验position/sourceHash/projectConfig；静态旧target仍走原解析分支。无position的语义查询拒绝并给出准确参数形状。
2. `symbol:<name>`保持名称定义查询；多定义返回候选，调用者先选文件+位置，不能把某个列表顺序当符号选择。
3. 返回结构化 `SourceRef[]`、EvidenceContext、Coverage、nextCursor；渲染只显示必要片段。完整结果分页使用M0.6快照纪律，不在read工具内重新猜符号身份。
4. `ff_read`允许读取SourceRef指定范围，校验rawHash；旧结果过期给出stale/requery，而非悄悄读新位置并称为同一符号。
5. guidance按真实后端能力提示使用语义或文本；backend缺失时说明ffgrep只是文本候选，不能给相同的references标题。

**测试**：新增 `tests/run-semantic-tools.mjs`；复用 `run-read`、`run-trace`、`run-registration`。覆盖旧参数、新参数互斥、错误坐标、跨工作区SourceRef、分页、过期读取、takeover名称。**退出**：一次引用结果可直接准确读取，不需Agent重搜位置。

## M2.5 真实 TypeScript 项目环境

**依赖**：M2.2。**改动**：`src/semantic-typescript.ts`；复用 `src/js-project.ts` 做发现提示，配置语义交给TS自身。

1. 用TS公开配置解析API和受限FileSystemHost读取tsconfig JSONC、extends/references；现有启发式program closure不冒充编译器Program成员集合。
2. 一文件归多个项目时返回可选projectConfig；未选择不能跨配置拼接后声称唯一结果。项目引用中的声明/源码映射均记录来源。
3. 记录实际消费的配置、package元数据、源码及声明版本；TypeScript标准库版本也进入context。node_modules只在已授权依赖根读取，不默认展示全部第三方引用。
4. 禁止自动生成缺失声明、运行构建或安装包；项目需要先build时输出缺什么及建议命令，是否执行交给M1.4审批。没有tsconfig的JS项目使用明确的inferred模式并标注限制。
5. 配置和依赖变化失效整个相关project；普通文件更新经getScriptVersion推进，不错误复用旧类型结果。外部符号可以显示，但范围与跨根读权限明确。

**测试**：多tsconfig相反paths、project references、NodeNext的MTS/CTS、exports/imports、缺 `.d.ts`、allowJs、配置环、依赖在授权根外。**退出**：至少一个多项目fixture能给出可复现、配置隔离的引用结果。

## M2.6 降级、诊断差分与更新

**依赖**：M2.3–M2.5、M1.5。**改动**：`src/semantic-client.ts`、`src/verification.ts`、`src/tools-check.ts`。

1. ffcheck types生成后端诊断记录，绑定项目/文件输入；比较前后诊断时按code、文件、范围映射和语义锚配对。配不准时列unknown，不靠消息字符串集合减法强行归因。
2. 有既存错误可报告“未观察到新增诊断”，但不能把该类型检查整体标为passed；检查计划可明确要求“无新增”，其谓词与全量types检查分开显示。
3. 内存/超时/后端崩溃下保留已有静态图；语义响应不完整时不使用缓存中的上一个成功列表顶替本次请求。
4. 编辑后用新内容hash查询，旧检查变stale；baseline、预览和诊断更新互相验证相同context。

**测试**：跨文件改变成员类型、只移动行号、先存错误、并发改配置、后端返回半份结果；扩充 `run-check`、`run-semantic-client`。**退出**：TS语义可参与M1闭环，失败降级不掩盖未知。

## M3.1 从语义结果生成只读变更计划

**依赖**：M2.3–M2.6。**新增**：`src/change-plan.ts`；修改 `src/semantic-typescript.ts`、`src/tools-trace.ts`。

1. `rename:`先做 `getRenameInfo`，不可重命名时返回后端原因；可重命名再用 `findRenameLocations`。保留后端提供的prefix/suffix编辑信息，尤其是对象shorthand/import别名，禁止直接全文替换名字。
2. 读取每个目标的当前Buffer，与返回结果的snapshot/context比对；创建C4计划，预览每文件diff、beforeHash、编辑数、未知和建议检查。
3. 只接受能映射回已授权源文件的编辑；生成文件、虚拟位置、外部依赖、重复/重叠span、不可完整枚举的引用均不得进入自动可应用计划。
4. 计划分ready/blocked；blocked仍可展示原因，但ffedit不能应用。修改newName或过滤目标集合必须重新生成计划，不能编辑存储里的已审核集合。

**新增测试**：`tests/run-change-plan.mjs`：别名、shorthand、同名诱饵、重叠span、后端只给部分引用、跨授权根。**退出**：预览没有写任何源码且每条改动有可追溯来源。

## M3.2 授权、锁与过期计划拒绝

**依赖**：M3.1。**改动**：`src/tools-edit.ts`、`src/execution.ts`、`src/change-plan.ts`。

1. 新 `{plan,reason}`分支与path/find/steps/ticket互斥；从插件私有存储加载计划，不接受调用者附带approved或任意edits覆盖它。
2. 执行守卫先解析计划涉及路径，按现有权限机制授权全部读取/写入目标；新增/移动目标还要检查父目录真实身份。计划ID本身不是权限。
3. 采用现有workspace锁，再对目标规范路径排序取文件锁，避免反序死锁；加载待恢复事务并走prepareWorkspace，不在未授权恢复路径上直接recover。已授权的历史事务恢复可能写盘，须单独报告；恢复受阻就停止，不能接着应用新计划。
4. 在同一workspace锁内先查ledger的changePlanId；已有提交返回原batch及当前适用性，不再按已过时的beforeHash拒绝幂等重试。未提交才复核源hash、目标不存在条件、项目配置、provider版本及snapshot；任何差异返回stale，本次新计划零写入。校验完成后仍使用withNativeWrite的版本/权限复核。

**测试**：预览后编辑、重命名目录/符号链接替换、两个Agent并发应用、目标已存在、部分路径拒绝、恢复与新计划拒绝分别报告。**退出**：只要一条前置条件失效，不能半应用其余编辑。

## M3.3 复用事务与实现幂等恢复

**依赖**：M3.2。**改动**：`src/change-plan.ts`、`src/tools-edit.ts`、`src/ledger.ts`。

1. 各文件在内存生成最终Buffer，保留原编码；同一文件多个edit按原始snapshot降序应用，不能将前一步修改后的坐标用于下一步。
2. 生成同一组FileChange和LedgerNode，经现有commitFiles提交一次。给新批次增加可选 `changePlanId`，旧记录可不含；这是真实新业务字段，不修改旧批次。
3. 应用前查询ledger是否已存在同一changePlanId；已有则返回对应batch及当前适用性，不重复施加。提交后再标计划consumed，崩溃窗口由ledger关联消除。
4. 复用WAL和before/after快照恢复；中途出错由现有恢复流程处理，发现外部未知字节就保留journal并停下。不得使用git reset或覆盖式回滚。
5. 明确事务不保证其它进程看不到逐文件中间态；后验检查只针对事务完成后的版本，不能在写到一半时开始。

**测试**：`run-change-plan`增加第二文件写失败、提交后消费标记前退出、重复请求、未完成journal、恢复时外部改动；回归 `run-files`、`run-edit`、`run-review-regressions`。**退出**：磁盘、台账和plan状态一致，重复请求不会双改。

## M3.4 文件移动与代码迁移的不同承诺

**依赖**：M3.1–M3.3。**改动**：`src/tools-files.ts`、`src/change-plan.ts`、`src/semantic-typescript.ts`。

1. 首版自动引用更新只支持文件move：调用TS `getEditsForFileRename` 取import/path改动，将source删除、destination创建和引用编辑放入同一计划。
2. old/new路径必须同一允许工作区，目标不存在，处理大小写重命名需专用临时名策略并纳入恢复日志；实现前不能默认用Windows覆盖式rename。
3. move_code/copy_code不借文件rename冒充符号迁移。没有后端提供完整提取/移动语义时保持现有文本迁移，预览显示import、可见性、闭包捕获和消费者仍需人工处理，静态检查为partial。
4. 只有另行实现了明确语言的安全符号迁移算法并通过闭包变量/export/import测试，才开启该操作的自动引用更新；unsupported不能默默降为文本写入。

**测试**：移动被两个模块引用的文件、index路径、大小写路径、目标冲突、跨配置、移动捕获外部变量的函数。**退出**：文件rename闭环可用，未支持的符号迁移不会伪称语义重构。

## M3.5 最终版本后验与范围控制

**依赖**：M3.3、M1.3–M1.5、M2.6。**改动**：`src/tools-check.ts`、`src/verification.ts`、`src/change-plan.ts`。

1. 提交后返回batch和建议checkPlanId，不隐式执行测试；显式static/types检查读取最终after版本，run仍需宿主审批。
2. 对rename检查新符号/消费者、旧符号残留的语义引用及类型诊断；文本旧名可能属于无关符号，不能因此自动继续替换。
3. 使用before/after影响集合的并集推荐检查，保留固定必需smoke/type检查；图不完整时不能通过裁剪测试掩盖风险。
4. 检查失败返回已应用批次、失败证据和回滚预览入口；不得再次自动写入以“修到绿”为目标。

**测试**：漏改产生类型错误、文本旧名诱饵、检查期间外部改动、tests未跑、检查失败后文件仍保留已授权修改。**退出**：应用成功、后验失败和未验证是独立可见状态。

## M3.6 回滚后的证据与索引一致性

**依赖**：M3.5。**改动**：`src/tools-edit.ts` 的rollback、`src/verification.ts`；复用ledger/overlay。

1. 通过现有ffrollback预览目标批次及冲突，确认后才执行；计划的多个文件一起列出，不按失败诊断随意回滚局部。
2. 回滚产生新批次、记录原批次关系；验证历史不删除，新内容不再引用已失效的after检查。
3. 确认overlay、AST、语义project版本、Trace、cards能观察恢复内容；刷新尽量局部，必须保留下一次查询的hash校验。
4. 后续外部修改或事务冲突使恢复阻塞时完整报告，不删journal，不将回滚状态写成成功。

**测试**：扩充 `run-change-plan`、`run-forge-loop`：安全恢复、回滚前外部修改、回滚再撤销、同版本内容重新出现但配置不同。**退出**：恢复可追溯且旧检查不会因为内容名字相同就自动恢复有效。

## 本阶段可粘贴验收场景（实施后）

> 在授权临时工作区建立tsconfig.json（strict:true,noEmit:true），a.ts导出 `function inc(x:number){return x+1}`，b.ts写 `import {inc} from './a'; export const y=inc(1)`，c.ts写 `export function inc(x:string){return x+'!'}`。读取并按a.ts的inc位置查引用，确认不包含c.ts；生成inc→bump的重命名预览，先不应用。让我在预览后修改b.ts，确认旧计划零写入并要求重建；重建后经我确认应用，验证a/b改为bump而c不变。通过授权的类型检查并查询历史证据，最后只预览回滚，不自动执行。任何后端缺失、权限拒绝或检查未运行均明确报告，不使用全文替换冒充语义rename。
