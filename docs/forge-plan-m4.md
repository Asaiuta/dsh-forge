# M4：专业语言、框架与 FFI 的逐项实施方案

状态：待实施。依赖[公共契约](forge-plan-contracts.md)及[M2语义通道](forge-plan-m2-m3.md)。任务可按使用频率排序，每种语言独立发布支持范围；不能只统计服务器启动成功或文件扩展数。

## M4.0 从第二个后端提炼协议与一致性测试

**依赖**：M2.6；与首个非TS后端一起实现。**新增**：`src/semantic-lsp.ts`、`tests/run-semantic-lsp.mjs`、`tests/lib/semantic-contract.mjs`。复用semantic-types/client，不另建图数据库。

1. 首个LSP后端使用标准stdio Content-Length framing，按字节解析；协议日志与正文分离，限制消息大小。支持id、error、notification和双向request，不把LSP当JSONL。
2. 流程固定：授权启动→initialize→核验serverInfo/capabilities/positionEncoding→initialized→didOpen/didChange→查询→shutdown/exit；按需响应服务器workspace/configuration请求，只提供已批准数据。忽略未知通知但保留调试摘要，不忽略请求错误。
3. 只公开实际支持的definition/references/diagnostics/implementation/rename/callHierarchy；静态能力与动态registration都要维护。textDocument/references返回Location[]不能凭名称创造符号ID；用返回definition和snapshot建立局部身份，歧义保持多组。
4. 将provider坐标映射为C1 SourceRef；区分未打开文件的磁盘坐标与didOpen规范文本。收到虚拟或外部URI时先校验来源与授权，不能把任意file URI当允许读写。
5. 每个provider实现四个最小钩子：启动参数与权限要求、工程上下文采集、配置适配、结果规范化；第二个实现出现后再抽共用部分。后端只返回部分项目或范围未知时记录provider_scope_unknown，不猜全工程完整。
6. 服务端workspace/applyEdit一律拒绝或转成待确认计划；workspace/executeCommand、动态进程、配置执行另走权限评审。分析请求不能让服务器直接修改工程。
7. 通用契约测试用协议替身覆盖UTF-8分包、消息乱序、取消后迟到响应、动态能力、重启、错误、非法URI、服务器主动applyEdit；随后每个语言再过真实服务器fixture。

**执行**：实现后运行 `node tests/run-semantic-lsp.mjs`，再运行选定语言的真实后端脚本；共用测试helper由各脚本导入，不作为单独的空测试入口。

**退出**：替身与一个真实非TS后端都通过；只有假服务器通过不算语言支持。各后端配置中的具体键必须以选定版本的发行schema/帮助和黑盒试验证实，未知键不能默认为生效。

## M4.1 Rust / rust-analyzer

**依赖**：M4.0。**新增**：`src/semantic-rust.ts`、`tests/run-semantic-rust.mjs`。**衔接**：`src/rust-project.ts`、`src/rust-resolution.ts` 只提供静态fallback与工程提示。

1. 启动用户明确配置、版本已记录的rust-analyzer，initialize以Cargo workspace根为rootUri；发送显式工程配置，不把“扫描到Cargo.toml”当完整workspace成员关系。
2. 基线模式要求关闭build scripts、proc macro、自动check/flycheck；核验所选版本对应设置确实生效。Cargo metadata或依赖发现可能启动外部进程，也必须纳入授权和离线策略，不能称完全零执行。
3. 构造workspace有lib/bin、members/exclude、path依赖、包重命名、feature分支；查询跨crate函数与trait成员引用，结果绑定Cargo.lock、Cargo.toml、选定features/target和服务器版本。
4. 禁用宏时，涉及proc macro展开和build.rs生成代码的结果为partial；需要补齐时生成额外执行授权请求。用户批准后在隔离fixture启用、重新加载，并使用不同configKey。
5. diagnostics与类型引用分开，cargo check结果由ffcheck接收；不能把服务器没发布诊断解释为cargo check通过。

**可执行验证**：新增脚本接 `FORGE_TEST_RA_BIN` 环境变量指向已安装exe，缺失明确SKIPPED；脚本自建临时Cargo工程，使用带marker的build.rs验证默认不执行，授权模式才允许执行。测试mod/path、trait、feature切换、外部依赖缺失和取消。

**退出**：本地跨crate引用正确，macro/build权限可证明；缺工具链/依赖不自动联网，返回缺失与partial。

## M4.2 Python / Pyright

**依赖**：M4.0。**新增**：`src/semantic-python.ts`、`tests/run-semantic-python.mjs`。**衔接**：`src/python-project.ts`。

1. 使用明确配置的pyright-langserver及发行版支持的stdio参数；启动前固定server版本、Python目标版本、项目根、venv/extraPaths/stubPath配置。
2. 不通过import用户模块来发现依赖。若服务器为了sys.path调用解释器，解释器启动及sitecustomize潜在执行属于单独授权；没有权限时使用显式已知路径并标记限制。
3. 将pyrightconfig/pyproject中该后端实际消费的配置、环境路径、stub和依赖版本纳入context；相同文件在不同venv下不能共享语义缓存。
4. references/definition用标准LSP；类型诊断接版本匹配的发布或pull协议，明确等待完成/静默超时的区别。动态getattr、monkey patch、importlib路径记录未知，不模拟Python执行。
5. 对`.pyi`定义与`.py`实现保留两类来源，不能把stub位置误当可编辑实现；外部site-packages结果默认只读。

**验证**：`FORGE_TEST_PYRIGHT_BIN`指定后端；fixture包括src layout、namespace package、相同模块名不同extraPaths、stub+实现、同名类方法、动态getattr、不可用解释器。使用显式类型的跨文件引用真值验证，不以动态案例要求完备。

**退出**：类型成员引用排除同名诱饵，环境切换使旧结果失效，不执行工程import作探测。

## M4.3 C/C++ / clangd

**依赖**：M4.0。**新增**：`src/semantic-cpp.ts`、`tests/run-semantic-cpp.mjs`。**衔接**：`src/compile-commands.ts`、`src/native-resolution.ts`。

1. 选定clangd版本和compile_commands目录，经已批准参数启动；不自动开启任意query-driver。编译器探测会执行程序，必须只允许明确批准的绝对路径。
2. 将编译数据库摘要、目标triple、宏定义、include/sysroot、生成头身份绑定context；同一源文件有多个编译命令时要求选择构建变体，不能合并成一种语义。
3. 文件与头的诊断/引用依据服务器真实翻译单元；头文件缺归属或生成头缺失时partial。已有静态include候选仍可显示，但不能当clangd已确认。
4. 用LSP定义/引用/实现/rename等实际能力；宏展开位置和拼写位置区分。无法映射回可编辑源范围的宏/模板实例结果只读，不加入changePlan。
5. types检查只代表clangd选定命令下的诊断；真正编译/链接测试通过ffcheck显式执行，不假设clangd成功就等于构建成功。

**验证**：`FORGE_TEST_CLANGD_BIN`；fixture提供手写compile_commands，不运行CMake生成。包含两组宏变体、头归属、重载、模板、宏展开、response文件、缺生成头；另外用假的query-driver marker验证默认不执行未批准程序。

**退出**：配置变体可解释且隔离，未配置或环境缺失不会返回“完整零引用”。

## M4.4 Go / gopls

**依赖**：M4.0。**新增**：`src/semantic-go.ts`、`tests/run-semantic-go.mjs`。**衔接**：`src/go-project.ts`。

1. 固定gopls与Go工具链路径/version；配置workspace、GOOS/GOARCH、build flags。go list等子进程必须包含在启动授权中。
2. 基线测试环境设置 `GOPROXY=off`、`GOSUMDB=off`、`GOTOOLCHAIN=local`，依赖均在fixture本地；实际用户环境只按显式配置调整，不偷偷修改全局go env。
3. go.work/replace/vendor和构建标签进入context；文件所属package由gopls给出，不沿用“目录首个Go文件代表包”的启发式。
4. references/implementation/callHierarchy按advertised能力接入；动态函数值与接口分派仍不声称完整调用图。
5. cgo解析可能启动编译器，未授权或无工具链时该部分partial；不运行go generate。类型/测试检查由ffcheck执行用户批准的go test/check recipe。

**验证**：`FORGE_TEST_GOPLS_BIN`及显式工具链；go.work两模块、replace、vendor、build tags、平台文件后缀、接口实现与同名方法，切换GOOS后旧结果stale。测试用例不依赖公网下载。

**退出**：包/对象绑定能超过静态目录依赖，构建环境缺失可观察且不触发隐式安装。

## M4.5 Java / Eclipse JDT LS

**依赖**：M4.0。**新增**：`src/semantic-java.ts`、`tests/run-semantic-java.mjs`。**衔接**：`src/java-facts.ts`、`src/java-resolution.ts`。

1. 用户提供JDT LS发行目录、Java路径及发行版要求的launcher参数；先核验java/server版本，再启动。每工作区使用插件私有独立data目录，不能复用用户IDE的可写状态目录。
2. 首个fixture使用显式classpath/源码根、无构建插件的小工程。Maven/Gradle工程导入可能运行构建逻辑，基线禁用自动导入/同步；禁用能力未证实时不对未信任工程启动全功能导入。
3. 若要真实Maven/Gradle多模块语义，先展示导入将运行的工具及网络/文件范围，经授权在隔离工程验证；配置和依赖集合改变使context更新。
4. 类型/重载references与implementations按JDT结果返回；缺JAR、生成源码或module path时coverage partial，不用当前Java名称候选替代语义结果。
5. 启动失败或未加载完成不能解释为无引用；通过progress与实际查询/诊断判据确认工程就绪，后台仍加载时返回pending/not_run。

**验证**：`FORGE_TEST_JDTLS_HOME`、`FORGE_TEST_JAVA_BIN`；普通类path、重载、继承、两个模块同简单名、缺JAR、授权的最小Maven/Gradle导入各自单列。服务器缓存只限测试私有目录。

**退出**：至少普通工程和一个已授权构建体系通过；另一个构建体系未验收就明确不支持，不泛称全部Java工程已支持。

## M4.6 C# / Roslyn 语言服务与文件入口

**依赖**：M4.0；本项比其它语言多一个文件入口切片。**新增**：`src/semantic-csharp.ts`、`tests/run-semantic-csharp.mjs`。**修改**：`src/tools-trace.ts`、`src/facts.ts`、`src/trace-facts.ts` 的文件分类，必要时扩展源码语言类型。

1. 先选择具体、可分发许可清楚的Roslyn语言服务器发行版。Roslyn compiler库本身不是可直接启动的LSP exe；用户提供program/argv，先跑initialize记录实际能力，不猜启动参数。
2. `.cs`加入候选扫描时明确归为source而非落入JS fallback；没有静态模块规则时模块列表为空并标semantic_unavailable，不将using namespace硬猜成某一个文件。
3. solution/csproj、target framework、条件符号、程序集引用由选定后端评估；MSBuild可能执行task和restore，默认不能隐式运行，缺少批准的工程加载路径时只交付定义/部分语义并标限制。
4. 后端可用后，语义引用按来源建立单独的symbol→file投影，kind为semantic_reference，带provider/config证据；不伪装成C# import边。文件视图可显式选择此层，旧静态边默认语义不变。
5. rename以服务器WorkspaceEdit为输入，经过C4范围/版本/权限校验；不接受服务端主动applyEdit绕过施工工具。

**验证**：`FORGE_TEST_CSHARP_SERVER`及独立参数配置；同名方法、namespace、多target framework、条件编译、缺程序集、partial class；含marker的MSBuild任务在未授权模式不得执行。

**退出**：C#真实进入文件/工程入口且有一个明确后端的语义闭环；只增加扩展名或只提取using不算完成。

## M4.7 Lua / LuaLS

**依赖**：M4.0。**新增**：`src/semantic-lua.ts`、`tests/run-semantic-lua.mjs`。**衔接**：`src/lua-resolution.ts`、`src/language-facts.ts`。

1. 启动已安装LuaLS，显式固定Lua版本、workspace.library、runtime.path；库目录必须在授权读取范围。
2. 优先只消费JSON配置；可执行Lua配置或插件默认禁用，按所选版本验证。不运行用户require来发现依赖。
3. 先交付definition/references、注解类型诊断，table字段引用仅在服务器能绑定时返回；metatable、动态key、custom searcher记未知。
4. callHierarchy未advertise就unavailable，不以同名文本邻接模拟；现有字面量package.path文件边继续提供独立静态证据。

**验证**：`FORGE_TEST_LUALS_BIN`；两个module同名字段、局部遮蔽、注解宿主库、runtime.path变更、动态table/metatable、缺library。**退出**：词法/类型引用与动态未知分开，无后端能力不造结果。

## M4.8 Vue 模板与虚拟文件

**依赖**：M4.0、M2.5。**新增**：`src/semantic-vue.ts`、`tests/run-semantic-vue.mjs`。**衔接**：`src/trace-facts.ts` 的component脚本事实。

1. 固定具体Vue语言工具发行版及其TS依赖/协作模式，先验证是否需要额外TS服务；不能假设独立Vue进程就能提供全部模板引用。
2. 查询返回原始`.vue`坐标时直接校验SourceRef；返回虚拟文档时只使用后端提供且版本绑定的source map，未提供映射就该结果只读/unsupported，不能按行号差值猜。
3. 首批覆盖script setup变量→模板使用、props/emits、组件导入；样式、宏和自定义构建插件未支持处独立说明。
4. 任何rename edit必须映射成单一合法源区间；多个虚拟片段映到重叠源区间时阻止计划，不能重复替换。
5. 工程配置JS插件可能执行代码，遵循语义执行授权；禁用时缺失的框架语义记partial。

**验证**：`FORGE_TEST_VUE_SERVER`加明确参数；script setup、template同名局部变量、props、emits、两个script块、非BMP字符、重叠映射、缺TS协作服务。**退出**：至少一个模板跨文件引用及rename预览准确落在源文件，不改虚拟产物。

## M4.9 Svelte 模板与生成代码

**依赖**：M4.0；复用M4.8验证过的映射契约，不复用其框架语义。**新增**：`src/semantic-svelte.ts`、`tests/run-semantic-svelte.mjs`。

1. 固定Svelte语言服务器、编译器与对应框架版本；记录配置和预处理器依赖。自定义preprocessor会执行代码，未授权时不加载。
2. 首批覆盖script变量、模板事件/绑定、组件导入与props；新旧框架语法分别建fixture，不能以一个版本通过代表全部版本。
3. 生成诊断/引用必须映射回`.svelte`；无映射、生成辅助变量、runtime-only关系保留未知，不进入自动编辑。
4. props/事件重命名只采用后端真实WorkspaceEdit，经过SourceRef与C4预览；不能用模板字符串替换模拟。

**验证**：`FORGE_TEST_SVELTE_SERVER`；模板循环遮蔽、事件、bind、组件props、CRLF、预处理器禁用、语法版本不匹配。**退出**：一个已声明Svelte版本的源位置闭环完整，其它版本明确限制。

## M4.10 FFI 与二进制关联：先证实产物身份

**依赖**：M1.5；与其它语言后端独立。**新增**：`src/ffi-link-evidence.ts`、`tests/run-ffi-link-evidence.mjs`。**衔接**：`src/trace-native.ts`、`src/ffi-facts.ts`、`src/binary-facts.ts`。

1. 首版只导入用户明确选择的链接map/受控构建报告，保存reportHash、binaryHash、来源调用ID、源码输入清单和工具版本；缺失字段按缺失报告，不从文件名猜对应构建。
2. 将关系拆成source declaration、binary export、build-associated三类；同名搜索仍是候选，只有可核验构建来源才能添加build-associated。外部手写manifest只能作为external-report。
3. 检查二进制格式、架构、符号名/修饰、ordinal/forwarder等现有可用信息；明确不据此证明ABI布局、调用约定或链接保留完整性。
4. 二进制或源码清单任一hash变化使关联stale；不给未知产物默认加载/执行权限。

**验证**：用仓内已有binary fixture与手工小报告测试正确关联、错架构、同名不同产物、产物改1字节、缺源码清单、伪造调用ID。**退出**：能区别“名字相同”与“有构建证据关联”；ABI/运行时调用仍列为未实施。

## 每个语言任务的统一完成清单

1. 明确所选发行版、版本、实际启动参数、许可和环境需求；不在测试中自动下载。
2. 新增脚本通过 `node tests/run-semantic-<language>.mjs` 执行；环境变量只是测试指向已有后端，不是生产自动安装配置。无真实后端的SKIPPED不能完成该任务。
3. 共用LSP契约测试、人工语义真值、该语言原有静态Trace回归均通过；后端不可用时原有静态能力不退化。
4. 至少演示一个“查询→读取→预览或修改→检查→历史”的真实宿主流程；后端不支持rename则验收只读语义+显式文本修改，不假称支持自动重构。
5. 发布说明精确列出已验收项目形态、未知/动态边界与执行权限。M4某个语言完成不推动其它语言自动完成。
