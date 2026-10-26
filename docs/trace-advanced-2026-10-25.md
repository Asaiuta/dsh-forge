# Trace：传递影响、依赖路径与编译数据库增强

日期：2026-10-25。接续 [ProjectForge 能力与性能核验](trace-projectforge-capability-performance-2026-10-24.md)，完成 `impact:`、`path:` 和 `compile_commands.json` 三项增强。本轮同时修复 HTML 内联脚本归属、C/C++ 搜索顺序与缓存性能回归，已通过构建、全套测试和独立复核。尚未提交、推送或发布。

## 已实现的行为

| 入口 | 行为与证据 |
| --- | --- |
| `impact:src/lib.rs` | 沿已解析的反向文件引用广度优先遍历，返回传递引用者、最短距离、关联 HTML 页面；为每个引用者保留一条父边及原始引用行号。 |
| `path:app/index.html -> renderer/helper.js` | 沿正向文件依赖和 HTML script 引用返回一条最短有向路径；箭头两侧需留空格，支持扫描根内相对和绝对路径。 |
| `compileCommands: "build/compile_commands.json"` | 静态读取 C/C++ 编译数据库；缺省发现根下同名文件。依据显式的本地目录、`-iquote`、`-I`、`-isystem` 和相应 MSVC 参数解析 include。 |

`analysis` 包含文件距离、页面和引用边的 `from/to/line/kind`。查询最多索引 200,000 条边、访问 20,000 个节点，结构化文件/边/页面列表各最多 100 项，文本各展示前 30 项。遍历预算不足时不声明不可达，也不把已找到的路径称作已证明最短。`analysis.complete` 描述遍历是否完成，`analysis.truncated` 还包括展示截断；扫描覆盖度另由 `incomplete` 及错误计数表示。

编译数据库上限为 8 MiB、20,000 条记录，优先采用 `arguments`，兼容当前平台常见引号形式的 `command`。同一文件的多套配置必须一致指向目标；更早的搜索目录在根外或身份未知时保留未解析，避免猜测后面的本地命中。按物理目录身份处理 `-I` 与 `-isystem` 的别名优先级。

编译数据库只作为数据读取，不执行编译器、shell 或工作区命令。不支持的响应文件、sysroot、预处理转发、`env`/`env.exe` 启动器以及显式 include 环境变量赋值会计入 `compilation.unsupported`，结果标记不完整。此功能不模拟完整预处理环境，也不提供函数调用图、类型推断或运行时依赖保证；Python 子模块候选继续保留候选标记。

## 修复与结构取舍

- HTML 内联 import/require 在提取时携带 `scriptIndex`，组图按真实 script 归属传播页面成员，修复空标签、同行多个 script 和多行起始标签引起的错归属及行号问题。归属映射留在组图内部，不扩张公共依赖边字段。
- C/C++ 普通和 system 搜索路径分别保留，解析时依据物理目录身份消除 system 别名的普通目录优先级。目录链接切换会刷新解析结果。独立复核使用 GCC 15.2 的真实预处理结果验证该反例。
- 热缓存先前对已扫描源码重复执行真实路径探测，出现数秒级退化。最终版本每轮统一校验扫描根身份与源码 stat/ctime，已扫描条目直接复用；未扫描资源、忽略项和 include 搜索目录仍保留单独存在性及链接身份探测。
- 根目录真实身份进入 facts 缓存键和图签名。使用硬链接制造完全相同源码 stat 后切换根 junction，仍必须失效；稳定根重复查询则复用图。独立复核同时验证非候选资源的嵌套 junction 切换。

新增分析和编译数据库解析分别放在 `src/trace-analysis.ts` 与 `src/compile-commands.ts`，继续复用现有 facts 和依赖图。本轮未引入另一套索引后端。

## 正确性验证

| 检查 | 最终结果 |
| --- | --- |
| `pnpm run check` | exit 0，类型检查和构建通过。 |
| `pnpm test` | exit 0；共 30 个测试入口，29 个实际执行，真实 DSH 宿主集成 1 项跳过。 |
| 新分析及编译数据库回归 | 18 组通过，覆盖环、最短距离、行号、伪动态边、HTML 归属、预算、搜索顺序、链接身份、配置冲突和输入边界。 |
| Trace 缓存与覆盖度 | 9 组通过，包含同大小恢复 mtime 修改、根链接切换、取消与共享扫描。 |
| 既有 Trace 行为 | 30 组通过。 |
| JS/HTML 人工边真值 | 11 类，54 TP / 0 FN / 0 FP；新增 HTML 依赖边已纳入真值。 |
| Python / Rust / C/C++ 人工边真值 | 38 TP / 0 FN / 0 FP；对应语言测试共 8 组通过。 |
| 真实仓库 | VCPChat、VCPToolBox、audio-engine-core、dsh-session-hub 的健康度、两次冷态确定性和结构不变量通过。 |
| 已安装 SDK | 嵌套 `analysis` / `compilation` 在找到与未找到路径上均通过输出校验和渲染。 |
| 独立源码复核 | 修复反馈后无剩余 P1/P2；最终缓存反例检查 exit 0。 |
| 最终差异与打包检查 | `git -c core.safecrlf=false diff --check` 和 `npm pack --dry-run --ignore-scripts --json` 均 exit 0；包清单共 159 项，新增声明齐全，无已删除模块的残留声明、临时证据或 README 本地坏链。 |

宿主模块路径已有配置，但该路径下 `dsh-fs-sandbox/lib/index.js` 不存在，因此真实宿主集成跳过。已安装 SDK 的验证不能替代这一项。endpoint 相关回归使用 stub，未发送真实上游模型请求。

人工 fixture 的精确率/召回率只适用于其真值集合；真实仓库健康度和结构不变量不等于全图边准确率证明。

## 最终性能测量

使用本轮冻结基线和最终 V2 在同一批串行配对中测量。每个仓库、每个版本启动 3 个新进程，每进程执行 1 次冷查询和 3 次热查询：每格冷态 3 个样本、热态 9 个样本。表中为中位数，括号为最小值至最大值。

| 冻结语料 | 文件数 | 基线冷态 | 增强后冷态 | 冷态变化 |
| --- | ---: | ---: | ---: | ---: |
| VCPChat | 1,691 | 3.473 s（3.254–3.803） | 3.051 s（3.028–3.956） | -12.14% |
| VCPToolBox | 1,430 | 4.473 s（4.184–5.130） | 4.164 s（4.053–4.961） | -6.90% |

| 冻结语料 | 基线热态 | 增强后热态 | 热态变化 | 冷态 CPU 累计中位数，基线 → 增强后 |
| --- | ---: | ---: | ---: | ---: |
| VCPChat | 349 ms（234–476） | 351 ms（250–484） | +0.60% | 26.546 → 24.095 CPU-s |
| VCPToolBox | 343 ms（251–523） | 332 ms（264–600） | -3.22% | 33.093 → 32.047 CPU-s |

最终冷态中位数较基线下降，热态中位数接近。范围重叠且样本较少，不能据此证明稳定提速、统计显著性或延迟上限；Toolbox 增强后热态最大值也高于基线。V1 退化样本保留在证据目录，不将不同批次 V1/V2 的绝对耗时相减作为提速证明。

测量边界：

- Windows、Node v24.9.0、i5-12500H，`availableParallelism()` 为 16，默认 AST Worker 上限为 8。
- 第二轮倒转版本及仓库顺序，全部串行；未与本任务的构建、测试或其他 AST 解析并发，未停止用户其他进程。
- 冷态指新进程内缓存为空，不清空操作系统文件缓存。计时范围为 `assembleTraceGraph()`，含扫描、Worker 启动、解析、提取和组图；模块加载、序列化、断言、目标查询与展示在外。
- CPU 时间是含 Worker 的进程累计 user+system 时间，不能与墙钟秒数混用。每项分别取中位数。
- 两套冻结语料沿用既有 JS/HTML 集合及原始字节；每套各含 1 个解析失败计数，部分解析文件分别为 Chat 82、Toolbox 3，遍历错误均为 0。这些覆盖度与基线相同。
- 该表不覆盖全语言默认扫描集合，也未重新测量 PF，不能据本轮结果更新对 PF 的速度倍数或宣称总体能力全面超过 PF。

## 完整输出审计与身份

全部冷/热样本校验完整图输出。基线所有样本与原冻结图逐字节一致；最终 V2 所有增强样本与保留的 V1 增强图逐字节一致。

增强前后完整序列化字节不同：Chat 79 个 facts 文件、Toolbox 72 个 facts 文件新增内联脚本归属或未解析表达式标记。严格深比较断言确认：除这些字段外 facts 无意外差异；覆盖度和其他图字段不变，`deps`、`rdeps`、`unresolvedModules`、页面成员关系全部一致。归属标记分别涉及 14/38 个 inline body，表达式标记分别为 141/69 个。

| 身份 | SHA-256 |
| --- | --- |
| 最终 V2 src 文件清单 | `b911fbb9614e896c2fcbd0205384f20c376d7804e5d510acad6a924f94b82ccb` |
| 最终 V2 lib 文件清单 | `2e3dc9979e4c5c733515513d25fe9df5621ca9b7a1a986f2edb313e486343177` |
| 基线 lib 文件清单 | `f8d12fd4d81e7737831c241fbb901f47069a46facc72d9b7af0e2b9f366fcdb4` |
| VCPChat 语料清单 | `b1062c8a01bea9205670d8074ed3ee872085229c4231739161c6a90e4722a82c` |
| VCPToolBox 语料清单 | `6c541cbd239d3be99de01eff8cddebd457e280675aa2edb3949ed9ee256f3126` |
| VCPChat 增强后完整图 | `d752dfc81d9c09b74765f4be2c991f195fe239b406b4904efb4b69aa3e5c80e4` |
| VCPToolBox 增强后完整图 | `7ad203c3d3554644d919b803f45f938fa0c96ad0bbd135b0ff36fd42bf117207` |

最终汇总再次核验全部 src/lib 文件、基线 lib 和逐文件语料 SHA-256；测试源文件也逐字节核验，仅排除测试生成的点目录内容（例如 fixture 的 Git index）。README 随后补充环境启动器边界，未改变测量的生产源码或构建产物。

本地证据位于被忽略的 `.tmp-analysis/`，不进入 npm 包：

- `trace-round5-resume.mjs`：冻结、串行配对采样与汇总；`DSH_FORGE_BENCH_DIR` 选择证据目录。
- `trace-round5/baseline-{src,lib,tests}/`：增强前冻结基线。
- `trace-round5/resume/`：保留的 V1 增强版本及性能退化样本。
- `trace-round5/resume-v2/identity.json`、`final-{src,lib,tests}/`、`results/`、`summary.json`：最终版本身份、全图和性能原始样本；日志为 `trace-round5-v2-perf.log`、`trace-round5-v2-summary.log`。
- `trace-round5-resume-diff.mjs`、`trace-round5/resume-v2/graph-diff.json`：最终完整图的严格差异审计，exit 0；保留旧版 `resume/graph-diff.json`。
- `trace-round5-resume-cache-check.log`、`trace-round5-v2-final-tests.{log,json}`：最终类型/构建与完整测试结果。
- `trace-round5-v2-final-pack.json`、`trace-round5-v2-final-audit.{mjs,json}`：最终打包清单与源码/构建/测试源文件未漂移审计，exit 0。打包为 dry-run，未发布。

冻结、采样及审计拒绝覆盖已有结果；复跑时应选择新目录。
