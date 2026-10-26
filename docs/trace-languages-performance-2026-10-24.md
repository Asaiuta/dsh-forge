# Trace：继续优化与 Rust / Python / C/C++ 文件依赖

日期：2026-10-24。接续[第二轮性能对照](trace-vcpchat-comparison-2026-10-24.md)，按用户指定顺序增加 Rust、Python、C/C++。保留工作区既有修改，未提交或发布。

当前版本与 ProjectForge 的同批直接测量、8/16 Worker 实验及 PF 实际 Trace 范围见[后续审查](trace-projectforge-capability-performance-2026-10-24.md)。本文保留第三轮基线/优化版的历史测量。

## 最终性能结果

复用上一轮冻结的 JS/HTML 文件集合，包含 vendor bundle。基线为本轮修改前冻结的完整构建；最终版本包含本轮性能修改和全部语言扩展。两边各运行三个新进程，以下为冷查询中位数，括号内为最小值至最大值。

| 冻结语料 | 候选文件 | 本轮基线 | 最终版本 | 耗时减少 |
| --- | ---: | ---: | ---: | ---: |
| VCPChat | 1,691 | 7.16 s（6.20–7.24） | 6.65 s（6.58–7.02） | 7.1% |
| VCPToolBox | 1,430 | 8.63 s（7.87–10.17） | 7.73 s（7.57–8.29） | 10.4% |

同时记录 `process.cpuUsage()` 的进程 CPU 时间，包含同进程 AST Worker 的各线程 CPU 时间，因而可以大于墙钟时间：

| 冻结语料 | 基线 CPU 中位数 | 最终 CPU 中位数 | 减少 |
| --- | ---: | ---: | ---: |
| VCPChat | 41.094 s | 37.547 s | 8.6% |
| VCPToolBox | 51.969 s | 47.484 s | 8.6% |

这是一次有限的额外收益。机器存在其他负载，非测量间隙的一次 CPU 负载读数为 77%；没有停止用户的其他进程。三个样本不足以证明稳定性能上限或统计显著性，Chat 最后一对的墙钟时间仍有回退。不能把本表绝对时延与上一轮负载条件下的时延直接相减，也没有把上一轮的 ProjectForge 原生参考数据拼成本轮对比。

热查询每个进程再执行三次，共九个样本。Chat 中位数为 584 → 452 ms，Toolbox 为 667 → 739 ms；范围分别为 316–1,384 → 293–725 ms 和 459–1,246 → 254–935 ms。热态没有一致改善，本轮主要减少冷态事实提取工作。

### 测量口径与早期结果

- Windows、Node v24.9.0、i5-12500H，`availableParallelism()` 为 16，自动最多 8 个 AST Worker。
- 每次命令使用新进程；冷态是解析、事实、图缓存为空，没有清空操作系统文件缓存。
- `assembleTraceGraph()` 计时包含扫描、Worker 启动、解析、事实提取及组图；模块 import、结果序列化和断言在计时外。
- 最终三轮采用相邻基线/最终版本配对，第二轮反转版本及仓库顺序。全部顺序执行，没有与构建、测试或其他本任务解析并发。
- 最终基线标签为 `before-4/5/6`，最终版本为 `after-gated-1/2/3`。每个进程的三次热查询均与自己的冷查询完整序列化输出相同。
- 冻结语料逐文件字节数、SHA-256 和清单哈希在汇总时重新验证。两套语料各有一个超过 2 MiB 的文件，按原有限制跳过，没有候选截断。

早期仅修改批量 wrapper 扫描时，单次采样曾显示约 11–12% 提速。后续尚未加入必要名称检查的三次复测并未确认收益：Chat 基线/修改版中位数为 5.87 / 6.39 s，Toolbox 为 8.00 / 9.05 s，分别慢 8.9% / 13.2%。这些样本全部保留，不能用早期单次结果替代最终结论。随后进一步省去普通模块的无效 IPC 工作，再按上述固定三轮流程复测最终代码。

## 实现调整

单线程诊断 profile（`before-profile`，强制 workers=0）用来定位开销，不进入自动 Worker 的性能表。其中 wrapper 扫描 inclusive 时间约 3.8 s，全次冷组图约 14.2 s。

1. wrapper 识别通过 Tree-sitter 的 `descendantsOfType('call_expression')` 批量找调用；仅对 IPC 候选且首参为 identifier 的调用恢复祖先作用域，保持原来的首个匹配和先序语义。
2. 直接 IPC 分类的所有成功路径都必含精确的 `ipcMain`、`ipcRenderer` 或 `webContents`。源码不含这些名字时，跳过 wrapper 扫描及直接 IPC 分类；注释或字符串中的名字最多增加工作，不会抑制事实。跨文件绑定、命名入口、全局变量、bridge 等仍按原规则提取。
3. 普通调用不再提前读取参数；preload 对象属性先确认值中存在 wrapper 调用，再读取键。
4. 两处页面闭包用队列索引前进，避免 `shift()` 反复移动数组；新增语言的编译依赖不继续进入浏览器页面成员和页面依赖闭包。
5. Rust 外部属性按父节点缓存兄弟列表及位置，避免宽声明列表中为每个 `mod` 重建兄弟列表。这些节点缓存仅存在于一次提取期间。

仍使用现有 WASM / Worker 路径，无新增依赖，也不需要原生索引器。

## 新语言能力

查询入口仍为 `fftrace` 的 `file:路径`。源码节点展示直接依赖、反向引用及未解析导入，不进入 IPC、浏览器全局或 preload 别名推导。

| 语言 | 已支持 | 保留的边界 |
| --- | --- | --- |
| Rust | 常见 `mod` 文件布局、内联模块作用域、直接 `#[path]`、字面量 `include!` / `include_str!` / `include_bytes!`；raw string、Rust 字符串转义、`std::` / `core::` 限定宏 | 不解析 `use`、`extern crate` 或跨 crate 符号；不展开宏和条件编译。`cfg_attr`、带路径的内联父模块、双候选歧义保留为未解析。按常见入口约定判断 crate root，不读取 Cargo manifest 配置，自定义 crate root 需人工确认。 |
| Python / PYI | 根内绝对模块名、显式相对包导入、别名、嵌套导入、`__init__`、`.pyi` | 工作区根作为搜索根；不推断 `sys.path`、外部安装包或 `src` 布局。`from pkg import name` 的实际子模块文件标为 `(submodule candidate)`，它也可能绑定包属性。 |
| C / C++ | 当前文件目录下存在的双引号 include，支持扫描根内 `../` | 角括号、宏、`-I` 搜索路径和缺失目标保持未解析；不读取编译命令。条件分支均收集静态引用。 |

Rust 常规入口包含 `src/lib.rs`、`src/main.rs`、`src/bin/name.rs`、`src/bin/name/main.rs`，以及 tests / examples / benches 的单文件与目录 `main.rs` 形式。根 `build.rs` 视为入口，嵌套 `build.rs` 通过同目录 `Cargo.toml` 的存在性识别；普通 `src/build.rs` 按模块处理。存在性通过图缓存探针跟踪，增删 manifest 会更新解析结果。

被 Rust 宏、C include 或 JS 相对引用关联的 `.txt`、`.inc` 等非扫描文件也可用 `file:` 反查，输出明确标注“被源码引用，内容未解析”。没有已确认引用关系的未扫描文件仍返回未找到。

新增扫描扩展名为 `.py`、`.pyi`、`.rs`、`.c`、`.h`、`.cc`、`.cpp`、`.cxx`、`.hpp`、`.hh`、`.hxx`、`.cppm`、`.ixx`。暂未增加 Go、Lua、Java、C# 的 Trace resolver；符号解析器可用并不等于已具备可靠的文件依赖语义。

这些边是源码中的静态文件引用，不能当作函数调用图、类型推断或完整运行时加载顺序。

## 正确性与真实仓库覆盖

旧 JS/HTML 冻结语料的完整 `AssembledTrace` 序列化结果逐字节一致，包含全部图字段和覆盖度元数据，未做字段筛选或文本归一化：

| 语料 | 最终输出 SHA-256 | parseErrors / partialFiles / walkErrors |
| --- | --- | --- |
| VCPChat | `075cd0e5019bd5af0fcd0da61ceb7ae3085ba8e09965fad9150187855ae4f533` | 1 / 82 / 0 |
| VCPToolBox | `e8a90a1ad038ee7462504edc093cb63209ccd5acf6c5339f05b3c591893cb8fb` | 1 / 3 / 0 |

验证结果：

- `pnpm run check`：退出码 0。
- `pnpm test`：退出码 0，29 个入口中 28 个实际执行，真实宿主集成 1 个跳过（当前环境无可用的已安装 DSH 模块）。
- 原 Trace 人工 oracle：11 类、53 TP / 0 FN / 0 FP。
- 新语言回归：8 组；全部 source 边与 38 条手写真值精确相同，38 TP / 0 FN / 0 FP（Rust 25、Python 8、C/C++ 5，包含 2 条 Python 子模块候选边）。包含 BOM/CRLF 行号、注释/字符串排除、Python 顶层相对导入越界、Cargo 常见入口与 build 模块诱饵、资源及 manifest 存在性缓存、Worker/顺序完整等价、部分解析覆盖度，以及无 IPC 名称的跨文件调用。
- 按 requesting-code-review 技能完成独立只读复核，修复 Python 包边界、Rust 入口和资源反查三个 P2，最后的 IPC 必要名称检查也经过复核。
- `git -c core.safecrlf=false diff --check`：退出码 0。
- `npm pack --dry-run --ignore-scripts --json`：退出码 0；157 个文件，Trace 入口和新增模块声明均在包内，基准证据没有进入包。

扩大后的真实仓库默认扫描，各执行两次冷组图，健康度、确定性和结构约束均通过：

| 仓库 | 候选文件 | 新语言文件：Rust / Python / C / C++ | 新语言依赖边 | parseErrors / partialFiles / walkErrors |
| --- | ---: | --- | ---: | --- |
| VCPChat | 1,858 | 119 / 48 / 0 / 0 | 122 | 1 / 84 / 0 |
| VCPToolBox | 2,677 | 152 / 953 / 1 / 141 | 1,871 | 1 / 115 / 0 |
| audio-engine-core | 169 | 150 / 9 / 0 / 10 | 152 | 0 / 11 / 0 |
| dsh-session-hub | 79 | 0 / 0 / 0 / 0 | 0 | 0 / 6 / 0 |

新增语言扩大了默认候选范围，不能把这些原仓的耗时与以前 JS/HTML 范围直接换算提速。部分解析文件可提供部分事实，覆盖度会进入工具的 `incomplete` 提示；真实仓库没有穷举真值，结构与确定性通过不等于真实准确率 100%。

## 本地复现证据

根目录 `.tmp-analysis/` 被忽略，不进入发布包：

- `trace-round3/baseline-src/`、`baseline-lib/`：本轮修改前源码和完整构建冻结，未覆盖。
- `trace-round3/final-src/`、`final-lib/`、`final-context/`：最终源码、构建及测试上下文快照；192 个文件的 `final-code.manifest.json` 清单哈希为 `369f111a0689121f9a51316c81b98c0adcc92b9739a25234cfd8911ab70c6ae1`。
- `trace-round2/{VCPChat,VCPToolBox}.manifest.json`、`corpus/`：沿用的逐文件字节和 SHA-256 清单。
- `trace-round3/results/before-1/2/3/`、`after-final-1/2/3/`：未加入必要名称检查的早期完整输出和计时，保留反向结果。
- `trace-round3/results/before-4/5/6/`、`after-gated-1/2/3/`：最终基线与最终代码的完整输出、冷/热时延及 CPU 时间。
- `trace-round3/summary.json`：最终全部样本、统计量、图哈希和早期样本摘要。
- `trace-round3/profile/before.cpuprofile`：单线程归因记录。
- `trace-round3-gated-check.log`、`trace-round3-final-tests.log`：最终构建与全套回归记录。
- `trace-round3-pack-dry-run.json`：发布文件清单预览，未执行发布。

`trace-round3.mjs df <标签> <仓库> [workers]` 执行单次新进程采样：`before*` 加载冻结构建，其他标签加载当前 `lib`。`compare <标签>` 对两套完整输出与 `before-1` 做逐字节比较。`trace-round3-gated-repeat.mjs` 按固定交替顺序测量且拒绝覆盖已有标签；`trace-round3-summarize.mjs` 重验语料及图后生成汇总。复跑需使用新标签并显式更新汇总的标签列表，不能覆盖冻结基线或语料。
