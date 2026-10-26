# Trace：Java 类型、C++20 模块与 cgo 导言

日期：2026-10-25。接续[多语言、FFI 与本地 DSH 诊断](trace-native-guidance-2026-10-25.md)，本轮继续补文件关系事实，保持 9 个工具和单一 `fftrace` 入口。未修改 DSH profile、重启宿主、发送模型请求、提交、推送或发布。

## 新增能力

| 范围 | 行为 | 证据边界 |
| --- | --- | --- |
| Java 类型 | AST 提取 superclass/interfaces、泛型 bound、字段、参数、返回、throws、构造和其他类型位置；索引顶层及直接嵌套类型，依照词法作用域、显式/static import、同包和通配候选定位文件 | `java_type:<role> (module candidate)` 保留角色和源码行；泛型参数、本地/匿名类型遮蔽不当作外部类型。重复身份和歧义保持未解析。 |
| Java module-info | 唯一模块 descriptor 的 requires、所属模块的 exports/opens 包成员、uses/provides 的类型候选 | 源码目录中的 descriptor 归属，不等于 Java module-path、可读性/可访问性或 javac 类型检查；相邻嵌套 descriptor 隔离包成员。 |
| C++20 命名模块 | 顶层 interface、implementation unit、同模块 partition import / re-export；同名 provider 多个时停止推断 | 根据源码声明建立 `cpp_import` / `cpp_implementation` 候选，不模拟 BMI/编译器模块映射。partition implementation 不捏造隐式 primary import。 |
| C++ 头文件单元 | 字面量 `import "header"` / `import <header>`，复用明确的编译数据库目录搜索规则 | `cpp_header` 候选；无显式配置时仅尝试双引号本目录，角括号保持未解析；不从其他翻译单元继承配置。 |
| cgo 导言 | 只消费紧邻独立 `import "C"` 的整行注释/块注释组，提取字面量本地 include | `cgo_include` 候选；不消费前句尾随注释、分离注释、分组/带别名导入，不解释 #cgo CFLAGS；宏 include、系统目录保持未解析。 |
| Node 注册 | 在已有 NODE_API_MODULE / NAPI_MODULE 之外，识别 NODE_MODULE、NODE_MODULE_CONTEXT_AWARE、NODE_MODULE_LINKED、NAPI_MODULE_X | 仍为 `ffi:` 下 module-registration 源码证据；区分 Node 与 N-API，排除成员调用和宏定义内部文本，不验证产物、ABI 或运行时注册。 |

新关系接入已有 `file:` / `impact:` / `path:` / `ffi:` 查询、缓存刷新和 AST Worker，不增加参数或查询工具。例如：

```json
{"target":"file:src/main/java/app/Service.java"}
{"target":"impact:src/main/java/app/Base.java"}
{"target":"path:native/consumer.cpp -> native/core.cppm"}
{"target":"ffi:legacy_addon"}
```

## 取舍与误连防线

Java 不提供完整继承成员类型展开。已知父类可能含同名成员、父类不可解析、父绑定受外层继承影响时，阻止回退到无关的同包/导入类型。即使父成员是 public 或 private，本轮也保持未解析，避免在缺少访问控制与泛型替换时给出错误直接边；明确的 extends / implements 文件边仍保留。匿名类体中的类型引用同样停止推断，`new Base(...)` 的构造类型事实保留。

Java 继承遮蔽检查全图工作上限 20,000、深度 64，达到后停止相关类型推断，并通过 `resolutionLimited` / `incomplete` 上报。查询提示现在同时覆盖 Rust 模块归属和 Java 检查预算，不再把所有限制误写成 Rust use。

C++ 当前 tree-sitter WASM 不完整识别模块语法。因此新增独立的有限词法扫描，原 grammar 的 partial 标记仍保留；不把词法 facts 当成编译成功。扫描器区分字符串、raw string、注释和预处理指令，先处理反斜杠换行并保留物理行坐标；raw string 结束符按原始字节查找，防止拼接制造假的提前结束。识别 `%:` 指令和 `<%/%>` 等替代标点，按逻辑行起点识别 contextual module/import，避免把 `struct import {}; import value;` 的变量声明当导入。

文件中 define/undef 过的标识符按全文件保守收集，模块 statement 任一标识符触及这些名字时，不注册 provider 或不连导入边。不展开宏、条件编译、外部 include 或编译选项中的宏环境；词法子集、缺失的编译语义和候选标记均保留。候选关系不能解释成已验证的运行时/编译依赖。

本轮将 Java 提取/寻道、C++ 模块、cgo、native 词法分别放在 `java-facts.ts`、`java-resolution.ts`、`cpp-modules.ts`、`cgo-facts.ts`、`native-syntax.ts`。沿用现有 facts / graph / worker 管道；C++ 词法使用生成器，只有存在换行拼接时才分配紧凑坐标表。

## 验证

新增 `tests/run-trace-semantic.mjs` 的 13 组回归，覆盖角色/行号、嵌套类型、static 与 wildcard import 优先级、遮蔽、module descriptor、分区、头文件单元、伪导入、cgo 注释归属、注册宏、缓存新增/冲突、顺序/worker 全图一致性和预算。已加入常规测试链，总入口为 33。

独立审查另用 C++ 15、Java 7、cgo 4 个小型正负场景检查词法与绑定；Java 反例通过 javac 17 / javap，C++ 相关有效反例通过 MSVC 14.44 核验。最后复核无剩余 P1/P2。审查中实际发现并修复了 static-import / 继承成员 / 匿名体误归属、phase-2/raw-string 边界、digraph、contextual keyword、已知宏和尾随 cgo 注释的误连。

最终冻结版本完整验证如下，均 exit 0：

| 检查 | 结果 |
| --- | --- |
| `pnpm run check` | 类型检查、构建通过；最终交付构建与性能冻结产物逐文件相同。 |
| `pnpm test` | 33/33 个入口实际执行，无跳过；包含新增 13 组语义回归及安装版 SDK 宿主 25 组。 |
| 既有人工边真值 | JS/HTML 54 TP / 0 FN / 0 FP；Python/Rust/C/C++ 38 TP / 0 FN / 0 FP。 |
| 独立复核 | 最终无剩余 P1/P2，前述具体反例已闭合；20,001 次受限查询另验证预算上报。 |
| 离线工具面 | additive / takeover 均 9 个工具，与本轮基线比较输入 schema 未变；未发模型请求。 |
| `git diff --check` / pack dry-run | 均通过；包清单 171 项，5 个新增模块声明齐全，无临时 SDK/fixture、已删模块残留声明或 README 发布链接缺失。未发布。 |
| 身份审计 | src 49、lib 166、测试源文件 40、scripts 8 个文件逐项校验；本轮只修改约定的 12 个源码文件，其余旧工作保留。 |

最终完整命令日志为 `delivery-complete-{check,test}.log`，执行结果 `delivery-complete-results.json`；打包清单 `final-pack.json`，审计 `final-audit.json`。中间版本的通过或失败日志均保留，最终结论不依赖它们。人工 fixture 与编译反例只验证各自集合，不是全仓边准确率证明。

## 性能与输出一致性

使用同一冻结 JS/HTML 文件集合，以本轮开始时的工作树构建为基线，和最终冻结构建串行配对。每仓每版本 3 个新进程，每进程 1 冷 + 3 热查询，第二轮倒序，无本任务测试/构建并发，不清操作系统缓存。Node v24.9.0、i5-12500H、availableParallelism=16、默认最多 8 AST Workers。计时为 assembleTraceGraph 的扫描到组图，模块加载、序列化和断言在外。

表中为中位数和最小/最大范围，冷态各 3 样本、热态各 9 样本：

| 冻结语料 | 文件 | 基线冷态 ms | 最终冷态 ms | 基线热态 ms | 最终热态 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| VCPChat | 1,691 | 5,780.533（5,138–5,860） | 5,387.702（5,158–5,406） | 373.547（327–639） | 458.332（310–544） |
| VCPToolBox | 1,430 | 6,676.625（6,391–7,483） | 6,959.735（6,726–8,817） | 414.293（350–637） | 498.376（394–1,050） |

Chat 冷态约 -6.8%、热态 +22.7%；Toolbox 冷态约 +4.2%、热态 +20.3%。冷态进程累计 CPU 中位数分别为 35,672 → 34,953 ms、46,282 → 47,187 ms。冷态和热态范围存在重叠，样本有限且系统负载未隔离，不据此归因为某一新模块；热态变慢是本轮观测结果，不能宣称稳定提速或完全无回归。

所有前后冷/热样本的完整图字节相同，包含全部 facts、边、顺序与覆盖度。Chat SHA-256 为 `d752dfc81d9c09b74765f4be2c991f195fe239b406b4904efb4b69aa3e5c80e4`，Toolbox 为 `37983dce8ba4fbc1b2d7b7757b0edb31cc5e741367cd1ab2fb7b10ee62329d6d`。两套 parseErrors 均 1，partialFiles 分别 82 / 3，walkErrors 均 0，前后不变。

该集合不包含新增 Java/C++/Go 默认扫描成本，本轮不测 ProjectForge、不拼接历史 PF 时间更新倍率。性能与最终交付的 src 清单均为 `a54b96d40654da67b696361c5dee574446bda201c977fdb94b1b133dc071b4f7`，lib 均为 `94cdd981ffd36223f69ac76cc7feb5ad40f02c1cab099dd2ae8fee24aaa34255`；最终审计已逐文件复核未漂移。本轮基线 lib 为 `429446686370fa327a1bc3ad605836ed009b141b484f073bfbf9b0a8a0b81f97`，是上一批最终交付构建，不能混用此前性能冻结版的身份。

## 剩余范围

本轮补入上次对比中主要的 Java 类型/module-info、C++20 module/header unit、cgo 导言和 Node 注册宏事实，仍不能宣称与 ProjectForge 全语义等价。尚未提供 C# 文件连边、完整编译器/包/模块解析、继承成员访问控制、任意宏展开或函数调用图；二进制仍沿用 PE/ELF/WASM 的已有边界。

原生 Trace facts 后端仍是独立工程缺口：现有 Rust sidecar 只服务符号，未在本轮扩张为 Trace 后端。继续处理冷态性能需冻结完整事实协议并与当前 WASM 路径逐字段对齐；本轮没有用缩减覆盖或增加猜测来宣称提速。

本地证据目录 `.tmp-analysis/trace-round7/` 不进入 npm 包，保存本轮 `baseline-*`、最终 `final-*`、身份清单、`inspect.mjs` / AST 形状、`verify.mjs` / 测试日志、`measure.mjs` / `performance/` 样本和最终审计。脚本拒绝覆盖旧结果；失败或中间检查日志保留，最终结论只引用明确的通过记录。
