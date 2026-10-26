# Trace：ProjectForge 当前性能与能力范围

后续实现与最终验证见 [Trace 传递影响、依赖路径与编译数据库增强（2026-10-25）](trace-advanced-2026-10-25.md)。本篇保留 2026-10-24 的能力和性能快照。

日期：2026-10-24。接续[本插件的语言扩展与性能优化](trace-languages-performance-2026-10-24.md)。本轮重新测量当前代码与 PF 随附二进制，并用静态样例核验能力；未修改生产源码、提交或发布。之前各轮报告中的时延保留为历史结果。

## 是否达到 PF 的性能

同一份 JS/HTML 文件集合上，**VCPChat 语料已达到这一组样本中的 PF 性能；VCPToolBox 仍未追平，冷查询耗时约为 PF 的 1.87 倍**。不能据此宣称所有项目均已达到 PF 的性能。

三个独立进程的冷查询中位数，括号内为最小值至最大值：

| 冻结语料 | 候选文件 | 本插件 | ProjectForge | 本插件 / PF |
| --- | ---: | ---: | ---: | ---: |
| VCPChat | 1,691 | 4.934 s（4.884–5.796） | 5.920 s（5.339–6.501） | 0.83× |
| VCPToolBox | 1,430 | 7.433 s（6.662–7.621） | 3.969 s（3.484–4.194） | 1.87× |

Chat 上约少耗时 16.7%，主要解释之一是本插件避免了桥接别名引起的第二轮解析。PF 的三个 Chat 冷样本均执行两轮 facts，累计解析 3,380 个文件；Toolbox 均为一轮、1,429 个文件。这不能证明本插件底层 WASM 事实提取已经达到 PF 原生提取的速度。

| PF 冷态阶段 | VCPChat 中位数 | VCPToolBox 中位数 |
| --- | ---: | ---: |
| facts 请求，含协议、别名发现及必要重扫 | 5.583 s | 3.414 s |
| JS 组图 | 0.337 s | 0.588 s |
| 二进制启动至 ping 完成，另计 | 61 ms（58–564） | 49 ms（48–50） |

各阶段分别取中位数，不能直接相加重建总耗时中位数。

每个进程随后执行三次重复查询，共九个热态样本：

| 语料 | 本插件中位数（范围） | PF 中位数（范围） |
| --- | ---: | ---: |
| VCPChat | 584 ms（474–697） | 725 ms（679–790） |
| VCPToolBox | 653 ms（467–722） | 997 ms（877–1,243） |

本插件校验后复用完整图；PF 复用每文件 facts，但每次请求仍扫描、传输事实并重新组图。上表比较各自现有重复查询路径，不能解释为两个相同组图算法的速度差。

### 测量边界

- Windows、Node v24.9.0、i5-12500H，`availableParallelism()` 为 16。本插件默认上限为 8 个 AST Worker。
- 每轮两个产品相邻采样；第二轮反转产品及仓库顺序。全部串行运行，没有与本任务的构建、测试或其他解析并发。没有停止用户其他进程，系统负载有波动，三个样本不构成统计显著性或稳定上限证明。
- 冷态是新进程内解析、事实及图缓存为空，没有清空操作系统文件缓存。本插件计时为 `assembleTraceGraph()`，含扫描、Worker 启动、解析、提取、组图；模块加载、序列化及断言在计时外。
- PF 调用随附原生索引器的真实 `facts` RPC 与 `linkGraph.buildGraph()`，按 Service 的桥接别名扩展逻辑执行必要重扫。原生启动单列；不包含模块加载、声明表加载、目标查询和展示，没有启动 Service、SQLite 或执行工作区 registry。两边声明表均为 `absent`。
- 沿用第二轮冻结语料，保留相对路径、文件原始字节及 vendor bundle。PF 实际返回文件集合与清单中不超过 2 MiB 的文件精确一致；两套各跳过一个超限文件，没有数量截断。汇总时再次校验逐文件 SHA-256 和参考二进制、JS 模块身份。
- 当前两产品默认忽略规则和支持语言不同；本插件新增 Rust/Python/C/C++ 后默认候选范围已扩大，不能把默认全仓耗时直接与这个 JS/HTML 表相比。相同文件集合也不代表两产品分析结果完全等价。

## 增加并发是否足够

仅在独立临时源码副本中将 Worker 上限放宽到 16，再对 Toolbox 运行三轮 8/16 相邻配对，第二轮倒序。每次完整输出都与既有冻结图逐字节相同。

| Toolbox 临时实验 | 8 Worker | 16 Worker |
| --- | ---: | ---: |
| 冷查询中位数（范围） | 6.943 s（6.807–6.991） | 6.696 s（6.425–7.078） |
| 进程 CPU 时间中位数 | 45.202 s | 56.297 s |
| 热查询中位数（范围） | 326 ms（240–431） | 330 ms（273–1,101） |

冷态中位数仅改善 3.6%，CPU 时间增加 24.5%；三对冷态分别变慢 1.2%、改善 1.6%、改善 7.5%。样本有限、收益不稳，不足以解释此前约 1.87 倍差距。保留生产上限 8；不能将这个稍后实验的 16 Worker 数字与先前 PF 样本拼成新的产品倍率。CPU 时间包含同进程 Worker 各线程，可以大于墙钟时间。

## PF 的 Trace 能力

审查入口是 `ProjectForgeService.js:898` 的 `traceCmd()`、`linkGraph.js`、`resolvers.js`，以及 `rust_projectforge_indexer/src/facts/` 和 `src/scan.rs`。运行的是 checkout 随附二进制，没有重编译，源码分析与二进制探针分别留证；未断言该二进制与当前 Rust 源码逐字节构建对应。

实际入口有六种：

| 查询 | 实际作用 | 主要边界 |
| --- | --- | --- |
| `ipc:通道` | Electron 主进程注册、renderer 调用、推送、同文件常量/包装、桥接调用与诊断 | 不执行程序；动态表达式可能无法解析；探针中的跨文件 wrapper 通道未识别 |
| `api:名称` | 与 `ipc:` 使用同一查询函数，经 preload 声明表映射 API 到通道、角色与调用点 | 不是任意语言的函数/API 调用图；`exposeInMainWorld` 键不自动建立完整 API 到通道映射 |
| `global:名称` | 浏览器全局的定义、显式 `window` / `globalThis` 使用、页面归属及加载位置提示 | 不做完整词法绑定、类型推断或任意裸变量使用追踪 |
| `page:HTML` | script 顺序、内联/module/外部脚本、require/import 闭包及桥接使用 | 是静态加载拓扑，不是运行时执行顺序证明 |
| `file:路径` | 源文件依赖/反向引用、页面、IPC、全局、FFI 声明等 | 常规查询依赖 `graph.files`；已提取二进制元数据不保证可用 `file:` 查询；未解析资源通常也不能反查 |
| `ffi:导出名` | Rust/C/C++ 导出声明与原生二进制导出名的同名检索 | 不连接外部调用者和被调用函数，不验证 ABI，不构成完整 FFI 链路 |

### 语言事实与文件连边应分开看

ready 握手报告 `javascript, typescript, tsx, python, rust, c, cpp, go, java, c_sharp, lua, binary`，HTML 另走专用事实路径。当前 resolver 注册并没有覆盖所有可解析语言和扩展名。

| 语言/格式 | PF 当前事实与寻道范围 | 限制 |
| --- | --- | --- |
| JS / JSX / TS / TSX / HTML | require/import、Electron IPC、bridge、页面与全局；相对/根内名称、常见扩展/index、TS ambient module | 未实现完整 Node package/tsconfig/bundler 语义；根内名称探测不能等同于配置驱动别名解析 |
| Rust | `mod`、展开的 `use` 路径、`crate`/`super` 和逐段回退；extern/export 属性及部分宏形态的 FFI 声明 | 不是 Cargo 模块/类型系统；探针漏掉 `#[path]` 和 `include_str!`，普通文件的嵌套 `mod` 还可能选错文件 |
| Python | import/from、相对与包入口、逐级前缀回退；字面量或部分字符串前缀的动态导入启发式 | 不执行 Python 导入器；存在顶层相对导入越界连边；解析器接受 `.pyi`，resolver 仅注册 `.py`，探针未连到 stub |
| C / C++ | include、部分 C++20 import/module 事实；本目录/根/include/src/src/include 猜测；extern C、dllexport、N-API 等导出形态 | 未读取 `compile_commands.json` / `-I`，不完整展开预处理器；系统角括号不连本地边；提取 module 事实不等于能准确解析所有命名模块 |
| Go | import、go.mod 模块前缀、本地包；cgo 导言区部分 include/FFI 事实 | 用包目录中首个 Go 文件代表整个包，没有完整包成员/构建标签语义 |
| Java | import/static import、部分继承/接口/字段/参数类型和 module-info 事实；类名/FQN/常见源码目录寻道 | 同名类与类路径依赖启发式，不是 javac 类型系统 |
| Lua | 字面量 require，点分模块到 `.lua` / `init.lua`，常见源码根 | 不运行 `package.path` 或自定义 loader |
| C# | 解析并提取 `using` 等事实 | **没有注册 C# resolver**；探针能查询文件并看到 `using`，但未连到对应 `.cs` 文件 |
| 二进制 | 解析器当前实际分派 PE、ELF、WebAssembly；Trace 接收 format/architecture/导入库/导出名，导出加入 `ffi:` 索引 | 不是反编译/指令调用图；扩展识别包含某种后缀不表示具备 Mach-O 或所有归档格式解析能力 |

`.mts/.cts/.pyi/.hh/.hxx/.ixx` 等部分扩展被语法解析器接受，却没有相应 resolver 扩展注册；通用相对直接文件兜底只能覆盖少数情况。

Service 当前依赖可用的 native AST 索引器，没有 Trace 的 WASM 回退。扫描默认最多 20,000 个候选、单文件 2 MiB，按目录/ignore/glob 过滤；vendor/assets/target/build 等默认范围与本插件不同。facts 缓存主要使用 mtime、size、bridge 名单，读取/解析失败通过 `filter_map` 丢弃；`hasError` 只标记返回文件的语法部分错误，不能据总数推断全仓完整覆盖。

## 二进制行为探针

使用 42 个静态文件的独立 fixture，调用真实 PF `facts` RPC、`buildGraph()` 和 `trace()`；另用本轮冻结的本插件构建比较相关文件边。PF 报告扫描 41 个文件，返回 40 个源码/HTML 事实与一个二进制元数据项，文本资源不进入事实扫描。手写的最小 WASM 只读取导出元数据，没有执行。所有工作区样例代码均未执行。

返回事实中，`go.mod`（按 Go 语法树解析）和含 N-API 宏调用的 `native/main.cpp` 标记了 `hasError`；相关结果只证明事实仍被提取，不表示样例通过编译或预处理。其余 38 个源码/HTML 事实没有该标记。

| 样例 | PF 观察结果 | 本插件当前对应能力 |
| --- | --- | --- |
| TS `declare module "virtual-probe"` + 名称导入 | 连到 `types/virtual.d.ts` | 暂无 ambient module resolver |
| Rust `use crate::worker::Worker` | 经路径回退连到 `worker.rs` | 只用明确文件引用建边，暂不解析 `use` |
| Rust `#[path="alt.rs"] mod renamed`、`include_str!("data.txt")` | 无对应边 | 分别连到 `alt.rs` 与 `data.txt` |
| `lib.rs` 加载 `feature.rs`，后者 `mod nested`，同时放同目录诱饵 | 错连 `src/nested.rs` | 连到 `src/feature/nested.rs` |
| Python `pkg/top.py` 中 `from ..shared import api` | 连到根下 shared 包/文件 | 拒绝越过顶层包 |
| Python `import stubs`，目标仅有 `stubs.pyi` | 无边 | 连到 `.pyi` |
| Python `__import__("util")` | 提取 dynamic 导入并连到 `util.py` | 目前不提取动态 Python 导入 |
| C++ `#include "root.h"`，仅根 `include/` 下存在目标 | 猜到 `include/root.h` | 未解析，需明确 include 搜索配置才能进一步确认 |
| Go 本地 module 包 / Java import 和继承 / Lua require | 三种样例都成功连边 | 三种语言尚未接入 Trace 文件 resolver |
| C# `using Example.Helper` | 有事实、文件可查询，依赖边为空 | 尚未接入 C# Trace |
| 从另一个 JS 文件导入 wrapper 后调用 `relay("across")` | `ipc:across` 未找到 | 图中存在 `caller.js` 的通道调用 |
| `api:queryTask`，有 expose 键、缺声明表 | 未找到 | 本插件也不应将任意 expose 键视为已证实通道映射 |
| 人工提供结构化 preload 声明表，再查同一 API | 映射到 task，显示 handler、角色和一个桥接调用点 | 此项用于验证 PF 声明驱动路径；未执行 registry 加载器 |
| Rust extern C、C++ extern C、NODE_API_MODULE、WASM 导出 | 对应四个 `ffi:` 查询均找到 | 本插件目前没有 `ffi:` 查询入口 |
| `ffi:probe` 与 `file:bin/probe.wasm` | 前者找到，后者未找到 | 尚无二进制 Trace |
| `file:rust/src/data.txt` | 未找到 | 有已确认源码引用时支持资源反查 |

这些是用于辨别能力边界的个案，不是 PF 全量准确率评测。未把只在源码中审查的所有特性都称为已通过运行验证。初次探针和第二版保留；最终 `capabilities-v3.*` 包含父模块连接、结构化 API 声明和 TS ambient module，并明确 Python 包入口与 C# 命名空间示例，没有覆盖旧证据。

PF manifest 仍主要描述 JS/Electron、列举五类入口，Service 输出也仍写“JS/HTML”；这些文案已落后于当前实际实现。文案中的冷态 1–2 秒、热态 0.1 秒也不能替代当前同批测量。

## 后续优化判断

PF 的 Rust + Rayon 在原生树上提取每文件 facts，然后用 JS 组图。本插件的 WASM/JS 节点读取、对象分配和完整事实遍历仍有冷态成本；前轮 profile 和本轮有限并发收益共同表明，继续只增加 Worker 不足以填平差距。

若目标是在大语料上更稳定地达到 PF 的冷态水平，值得优先实现**独立的原生每文件 facts 后端**，沿用现有 JS 组图、桥接别名后处理和缓存。当前 `rust_indexer` 仅有符号相关协议，没有 Trace facts，开启现有 sidecar 不会自动加速 Trace。WASM 路径仍可能进一步优化；本轮没有证明它的理论上限，也没有实现或验证原生 facts 的全功能行为一致性和最终速度。

实现顺序应先把 JS/HTML 每文件 facts 做成可独立比较的协议，验证完整事实、数组顺序、行号、跨文件 wrapper、动态/未解析标记、部分失败、缓存失效和取消语义，再加 Rust/Python/C/C++。用当前 frozen 图和人工 oracle 做准入，之后在同一时间窗口复测两产品，避免以缩减覆盖或更激进的猜测换时延。

PF 的原生索引器当前 `Cargo.toml` 标注 `CC-BY-NC-SA-4.0`，本插件为 MIT。上述方向应独立实现并核验所用依赖许可，不直接复制 PF 实现。PF 的已知目录剪枝、Go 单文件代表包以及猜测寻道也不宜当作正确性要求照搬。

## 验证与证据

本轮没有生产源码变化，不重跑与只读研究无关的全套测试。实际完成：产品采样、并发实验、增强能力探针、身份/断言审计均 exit 0；最终 `git -c core.safecrlf=false diff --check` exit 0。此前的类型/构建、完整测试和语言 oracle 结果见[上一轮报告](trace-languages-performance-2026-10-24.md)，不将其称作本轮新执行。

审计确认当前全部 `src/` 35 个文件、`lib/` 152 个文件与本轮测量前冻结副本逐字节相同。两套冻结语料本插件所有冷/热样本及 8/16 Worker 样本的完整输出，均与第三轮最终图逐字节相同，包含覆盖度和所有图字段。

| 身份 | SHA-256 |
| --- | --- |
| PF 二进制，17,907,200 字节，协议 3 | `6293770c29f49674a8d1fbfed41bc2f9225760653a920b5a7c33e07da89474b0` |
| 本轮 src 清单 | `10bd069276ad6b8e81b63b8351cd02a5115bff7acef5e2f7a0527c219f4af87b` |
| 本轮 lib 清单 | `f8d12fd4d81e7737831c241fbb901f47069a46facc72d9b7af0e2b9f366fcdb4` |
| VCPChat 完整图 | `075cd0e5019bd5af0fcd0da61ceb7ae3085ba8e09965fad9150187855ae4f533` |
| VCPToolBox 完整图 | `e8a90a1ad038ee7462504edc093cb63209ccd5acf6c5339f05b3c591893cb8fb` |
| 增强能力 fixture 清单 | `32516bcc7e617833a5eca89ae147e0597bbaca1ff8f7e0994f17d66964dcca3a` |

本地证据放在被忽略的 `.tmp-analysis/`：

- `trace-round4.mjs`：冻结、单次采样、三轮配对、临时 16 Worker 构建/采样及汇总入口。
- `trace-round4/dsh-src/`、`dsh-lib/`、`identity.json`：当前测量版本和 PF JS/二进制身份；`audit-v3.json` 另含 Rust 参考源码、全部本插件代码和最终 fixture 文件身份。
- `trace-round4/results/paired-{1,2,3}/`、`summary.json`、`trace-round4-paired.log`：产品冷/热及 PF 分阶段原始样本。PF 采样复用 `trace-round2.mjs pf round4-paired-N <仓库>`，原始副本也保留在第二轮目录。
- `trace-round4/workers16-src/`、`workers16-lib/`、`results/workers{8,16}-{1,2,3}/`、`workers-summary.json`：并发实验源码、构建、完整图、CPU 与墙钟样本。
- `trace-round4-capabilities.mjs`、`trace-round4/capability-fixture-v3/`、`capabilities-v3{,.facts,.pf-graph,.dsh-graph}.json`：能力样例、事实、两个图和查询文本；日志为 `trace-round4-capabilities-v3.log`。
- `trace-round4-audit.mjs`、`trace-round4-audit-v3.log`：源码未改变、变体只调整 Worker 上限、参考身份、统计量和关键行为断言。审计及采样拒绝覆盖已有结果；复跑应使用新标签/输出文件。
