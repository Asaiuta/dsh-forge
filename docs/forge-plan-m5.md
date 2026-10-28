# M5：资源、发行与真实验收实施手册

状态：待实施。遵循[公共契约](forge-plan-contracts.md)。M5.1/2/7的基础测试随M0–M2推进；SCIP与运行时观察是可选分支，不阻塞最小静态闭环。

## M5.1 进程与资源生命周期

**依赖**：M2.2；多语言部分在M4.0后扩展。**改动**：`src/semantic-client.ts`、`src/semantic-lsp.ts`、`src/index.ts`、`src/config.ts`。

1. 按workspaceId/provider/version/configKey复用语义实例；同一实例请求串行或按后端明确能力并发。共享等待者沿用现有Trace PENDING的引用计数思路，不照搬其图数据类型。
2. 首版可配置默认值：全插件最多2个活跃语义进程、每进程目标内存上限512MiB、请求超时30秒、空闲5分钟释放。它们是资源策略起点，不是已经测得的性能指标；真实语料不足时调整并记录理由。
3. admission先检查并发/内存预算，超限排队或返回resource_limited，不能不断spawn重试。超时后停止本插件拥有的实例，所有受影响请求都返回中断/partial，不能只通知其中一个。
4. 插件卸载、工作区关闭按引用计数停止自有进程；连接用户外部服务时只关闭连接，不杀外部进程。取消请求不等于服务端已停，确认终态后再释放执行状态。
5. 将启动次数、队列、峰值RSS、取消耗时和退出原因纳入被动status；不记录源码正文或凭据。

**测试**：`run-semantic-client`、`run-semantic-lsp`增加3工作区争用、两个等待者取消一个、内存上限、忙进程超时、卸载、外部服务器不被终止。**退出**：没有孤儿自有进程，不影响廉价查找/静态Trace，不出现无限重启。

## M5.2 新鲜度传播与证据保留

**依赖**：M1.5、M2.5。**改动**：`src/source-evidence.ts`、`src/trace-snapshot.ts`、`src/verification.ts`、`src/semantic-client.ts`、`src/cards.ts`。

1. 建立“输入→消费记录”的轻量索引：源码、配置、声明依赖、候选目录/缺失探针、provider版本分别指向受影响snapshot/project/check；不要另建一份文件内容数据库。
2. 提交和恢复的markWritten加速失效；外部事件只作为提示，下一次正式验证仍检查内容和集合。恢复mtime或重新创建同名文件不能逃过身份复核。
3. history显示历史结果，当前适用性按完整manifest计算；过期不修改原记录。卡片读到新revision或适用性变化重建确定性结果。
4. 记录清理初始保留最近1000条或90天，以先触及者为界；活动plan/当前检查引用的基线不得提前清理。若保护引用导致超过资源预算，拒绝新捕获并明确说明，不静默删除仍需要的证据。
5. 用户显式清理后，被引用但已删除的证据显示expired/unavailable；不能把缺失记录当从未失败。清理属于私有数据管理，不能顺手删工程构建产物。

**测试**：新增 `tests/run-evidence-freshness.mjs`；覆盖同size/mtime、依赖声明变化、缺失文件变存在、目录链接替换、后端升级、历史通过变stale、引用保护和过期记录。**退出**：新鲜度有内容/配置依据，事件漏报不直接导致放行。

## M5.3 构建与发行包可用性

**依赖**：有一个可用后端；不阻塞源码开发。**改动**：`build.mjs`、`scripts/build-indexer.mjs`、`package.json`、README；新增 `tests/run-package-contract.mjs`。

1. 对worker等独立入口加入esbuild entryPoints；runtime TypeScript按选定方案外置/可选依赖处理。打包检查确认worker、其chunks、类型声明和依赖发现都能从发行目录解析。
2. 明确支持OS/arch矩阵；本机验证只代表本平台。原生sidecar选择显式路径优先，再插件声明的发行位置；不找到即回退，不运行下载器。
3. 每个原生产物记录版本、目标triple、构建来源与sha256；启动握手报告协议/提取器版本。现有exe未经构建来源核对不能作为“当前Rust源码已验收”的证明。
4. 在独立临时安装目录验证无Rust/无语言服务器、只有静态fallback、安装已声明TS后端、错误架构exe四种情形；不能引用开发checkout里的lib或node_modules掩盖漏包。
5. 发行前先构建和检查pack清单，再在临时目录执行只读smoke；发布npm、上传二进制、修改release/CI均需单独授权，本手册不代替授权。

**执行**（依赖齐全且获准执行后）：

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node build.mjs
npm pack --dry-run --json
node tests/run-package-contract.mjs
```

pack可能触发prepare，不能拿旧lib当通过。`run-package-contract.mjs`为拟新增脚本。**退出**：在声明平台的干净安装中可用，缺可选能力时明确降级且不隐式联网。

## M5.4 依赖与分发许可

**依赖**：每次新增运行时依赖/打包服务器前。**改动**：对应package/lock与许可清单；实现时新增 `scripts/check-distribution-licenses.mjs`，只读取元数据不运行包脚本。

1. 从实际lock和打包清单枚举直接/传递的运行时依赖、原生链接库和随包服务器；dev-only与真正分发内容分开。
2. 记录精确版本、来源、license expression、需要保留的notice、是否允许目标分发方式；缺失或冲突许可证标needs_review，不能默认MIT。
3. ProjectForge的实现只能作为行为对照；其原生crate许可与本仓不同，不直接复制源码。需要借用代码时先确认许可和归属，否则独立实现。
4. 可选后端由用户单独安装与插件随包分发属于不同范围，明确文档和安装责任；这不自动免除集成/再分发义务。
5. 依赖变化时重新生成清单并人工审查变化；扫描工具给出的结果不是法律保证，有疑问暂停该依赖的分发。

**测试**：脚本fixture包含MIT、多重许可、缺license、含notice、只dev依赖；断言未知许可会阻止“分发清单已通过”。**退出**：每个实际分发组件都有可查来源与结论，未知项未被跳过。

## M5.5 可选 SCIP 离线索引导入

**依赖**：M2.3、M4.0的数据模型稳定后；不与首个TS在线后端同时建设。**新增**：`src/semantic-scip.ts`、`tests/run-scip-import.mjs`。

1. 首版只导入用户提供的文件，不运行生成器。选定protobuf解析实现后固定schema/version，设置输入字节、文档和occurrence数量上限，超限拒绝而不是半读后假完整。
2. 校验metadata.project_root与当前授权root，document相对路径不能包含越界、绝对路径或符号链接逃逸；未知URI与external_symbols只供只读信息。
3. 生成器和版本只是来源描述，不证明新鲜度。要求额外manifest绑定每文件hash、工程配置与生成选项；缺manifest/不匹配时只作external参考，不授权自动修改。
4. 按document解析occurrences、symbolRoles、relationships，映射SourceRef和后端证据；局部symbol按document隔离，不能跨文件同名合并。
5. 禁止把所有reference角色当call；SCIP本身不提供的置信度/运行时完整性保持未知。索引删除文档与旧记录撤销必须处理，不能只追加导致幽灵引用。

**测试**：小型手工可审核index、局部同名symbol、越界路径、坏protobuf、陈旧hash、缺manifest、文件删除、多版本索引；不用现网下载作为回归依赖。**退出**：导入与在线语义能够区分来源，陈旧索引不能驱动编辑。

## M5.6 可选运行时观察

**依赖**：M1.4、M1.5；只有用户明确需要时实施。**新增**：`src/runtime-evidence.ts`、`tests/run-runtime-evidence.mjs`。

1. 首版接收用户批准的测试运行所产生的结构化coverage/IPC事件，不往工程注入永久探针，不默认监听生产进程。
2. 记录hostCallId、scenarioId、输入源码/构建产物hash、时间范围、事件模式和字段schema；先限定文件/通道白名单，默认不收消息payload和凭据。
3. 将observed边放在独立runtime层，与static/semantic并列；用户查询需明确layer。未观察到不代表不存在，某次出现也不代表所有配置都会出现。
4. 日志没有版本或可信执行关联时只显示external-report；过期版本不可叠加在当前图上伪装实时事实。限制大小和保留时间，不自动上传到卡片润色endpoint。
5. 需要启动被分析应用、联网或插桩时另行确认执行范围；回滚源码不能撤销数据库/网络副作用，结果中必须说明。

**测试**：自造事件文件、同通道不同scenario、错版本、缺调用ID、敏感payload被拒绝/脱敏、超限日志、零事件。**退出**：能回答“这次测试观察到什么”，不宣称完整运行时调用图。

## M5.7 质量、性能与闭环收益评测

**依赖**：从M0开始逐步纳入。**新增**：`tests/eval-forge-loop.mjs`、`tests/bench-forge-loop.mjs`；复用现有 `eval-trace`、`eval-trace-real`。

1. 固定三类人工真值任务：Electron成员改名、TS跨文件rename、文件move；每类包含同名诱饵、动态未知、外部修改、失败恢复。
2. 为每个任务记录目标文件/符号、允许编辑集合、必须保留的字节、应执行检查和预期未知。评测器从磁盘、台账和检查记录独立计算，不只读取工具给的passed。
3. 文件边、语义引用、误改/漏改分开统计precision/recall及分母；真实仓库无完整真值时只报告标注子集与健康度，不能外推整体准确率。
4. 闭环效率比较相同任务的工具轮次、输出字符/token估计、人工补查数；只有正确性不退化才采信效率改善。
5. 性能固定输入集合、线程、provider和配置；独立进程冷启动与同进程热查询分开，加入编辑后更新。先测A/A噪声，交错A/B至少7次并按顺序位置分组检查方向。
6. 第一轮测量后为各代表项目制定延迟/RSS预算，并在实现优化前保存；不根据优化后读数倒定门槛。越权写入、错误符号修改、陈旧结果放行是零容忍阻断项，不用平均分掩盖。

**执行**：实现脚本后用 `node tests/eval-forge-loop.mjs`、`node tests/bench-forge-loop.mjs`；语料根通过显式环境或参数传入，不硬编码个人目录。**退出**：原始逐次结果可复核，无法超过噪声就报告无结论，不宣称倍率。

## M5.8 真实 DSH 宿主验收与阶段交付

**依赖**：对应里程碑的内部测试已通过。**改动**：扩充现有 `tests/run-host-integration.mjs`；新增 `tests/run-host-check-contract.mjs`，不以直接执行工具工厂替代真实派发。

1. 在测试profile明确加载插件，确认实际版本、作用域、工具清单与takeover状态；日志中必须能看到模型调用的是哪个工具，而不是只在代码中注册过。
2. 使用M1或M3手册的自包含提示词，录制真实tool-call/result关联；检查读取、capture、应用、审计、检查、history/cards、回滚预览这些环节是否发生。
3. 宿主执行检查必须经过其正式审批/派发，核验批准、拒绝、取消、后台终态。当前已有直接execute再构造成功结果的测试不能证明中央审批，要保留其单元测试用途并新增真实契约层。
4. 每次交付附：本次新增操作、限制、测试摘要、可粘贴提示词、实际日志证明的环节与证明不了的边界。日志无执行证据时交付说明写“未完成宿主验收”，不写“已在宿主完成”；检查记录仍使用C2的状态，不另造not_verified枚举。
5. 原生/回退、语义后端可用/缺失、additive/takeover各跑相应契约；未安装后端可以验证降级，但不能替代该后端正向验收。
6. 不因验收失败自行改宿主权限、跳过审批或切到更宽松工具。把接口缺口作为阻塞项；保持静态功能可用，等待明确的宿主支持或授权。

**执行**：先跑现有 `node tests/run-host-integration.mjs` 保留内部回归，再于已核验的测试profile运行新增 `node tests/run-host-check-contract.mjs` 并执行上述真实会话。后者必须读取实际宿主调用/终态证据；连接方式在M1.4确定，环境缺失时明确阻塞，不能回退到直接execute自造成功。

**退出**：一个可重放的真实会话完成整个里程碑，并且拒绝/未知路径也被验证；文档中的规划能力仅在对应验收通过后才转为当前能力说明。

## 阶段收口检查表

- [ ] M5.1 自有进程资源与取消经过压力测试。
- [ ] M5.2 陈旧、损坏、清理后的证据不会放行修改或验证。
- [ ] M5.3 声明平台的独立安装可用，缺可选后端正常降级。
- [ ] M5.4 实际分发组件的许可与notice已审查。
- [ ] M5.5 若选择SCIP，导入与新鲜度负例已通过；未选择则标未实施，不冒充支持。
- [ ] M5.6 若选择运行时观察，范围/版本/隐私检查已通过；未选择不阻塞静态闭环。
- [ ] M5.7 固定真值、误改/漏改和同口径性能证据齐全。
- [ ] M5.8 实际DSH日志能证明所宣称的工具闭环。
