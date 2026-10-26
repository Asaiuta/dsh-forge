# Trace：事实提取迁入 Rust sidecar（2026-10-26）

接续 [ProjectForge 能力与性能快照](trace-projectforge-capability-performance-2026-10-24.md)。本轮把 Trace 的逐文件事实提取从 Node Worker 中的 WASM tree-sitter 移到已有的 `rust_indexer` 原生进程；工程解析器、建图、查询与工具层仍在 TS。

## 为什么迁

冷启动组图约 90% 的时间花在 WASM 解析与事实提取。峰值内存 2.7–4.1 GB 的主因不是 JS 堆（约 10 MB），而是 V8 用 TurboFan 编译 tree-sitter WASM 语法时的瞬时内存：

- 只要用到一次 WASM 语法，就要付出约 0.8–1.1 GB；108 个 C/C++ 小头文件就能触发 1.1 GB。
- `--liftoff-only` 可以把它压到 83 MB，但这是进程级 V8 参数，插件不能替宿主设置。
- 减少 Worker 数反而更糟（8 个 3.2 GB，2 个 4.2 GB）。

所以只有 Trace 完全不加载 WASM，内存问题才会消失。

## 做了什么

- `rust_indexer/src/facts/`：逐字段移植以下提取逻辑，共约 2,400 行 Rust。
  - `js.rs`：`FactsCollector`。
  - `modules.rs`：module-facts、language-facts、Python 动态导入。
  - `java.rs`、`ffi.rs`。
  - `native.rs`：C/C++ 词法扫描、C++20 模块、cgo。
- 新增协议方法：
  - `traceFacts`：批量提取，rayon 并行。缓存按内容哈希命中（Windows 拿不到 ctime，同尺寸改写后恢复 mtime 不能复用旧事实），命中时直接写出缓存的 JSON 文本。
  - `textFacts`：提取 HTML 和 Vue/Svelte 的内联脚本。
- TS 侧（`tools-trace.ts` 的 `scanFacts`）分三路：
  1. 源码文件先走 sidecar；
  2. HTML、组件、go.mod、二进制在进程内处理，内联脚本经 `textFacts` 提取；
  3. sidecar 拒绝的文件（超过大小上限、树深超过 1,500 层、旧版二进制没有 `traceFacts`）走原有 WASM 路径，数量少时顺序处理，不再拉起整个 Worker 池。
- `DSH_FORGE_TRACE_NATIVE=0` 保留纯 WASM 路径。
- 修正 `indexer-client` 拼接响应的 O(n²) 问题：原先每个分块都对整个缓冲区做 `indexOf`。

## 一致性

用 `rust_indexer/parity-facts.mjs` 把同一批文件的 WASM 与原生结果逐字段比较：

- 对象：约 28,000 个真实文件，10 种语言，取自 VCPChat、VCPToolBox、new-api、audio-engine-core、GPT-SoVITS、dsh-forge 本身，以及 gson、luarocks、nlohmann/json。
- 结果：**两边都无语法错误的文件，差异为 0**。
- HTML、Vue、Svelte 共 576 个文件全部一致。

两侧语法版本不同：WASM 用 `tree-sitter-wasms@0.1.13`，Rust 用锁定的新版 crate。剩余差异约占 1%，全部出现在含语法错误、两套语法错误恢复方式不同的文件上：

- 新语法更准的例子：Rust 2024 的 `unsafe extern "C"` 会导致 ffi 行号错一行；`mod tests` 嵌套在 `mod windows` 里时，模块作用域会丢掉外层。
- 新语法更差的例子：doctest.h 第 3095 行之后的 `#include` 被错误恢复吞掉。

已决定含语法错误的文件也采用原生结果，原因是一次 WASM 回退就要付出约 1 GB 内存。这类文件仍带 `partial_parse` 诊断。

另有一处有意保留的兼容：旧语法把 `import.meta` 当成对 `import` 的成员访问，并产生事实 `{object:"import", name:"meta"}`。原生侧照样输出这条事实。它在下游永远会被 `selectBridgeFacts` 过滤掉，保留它只为两条路径结果完全一致。

## 性能

测量环境与上一轮相同：Windows、i5-12500H（16 个逻辑核）、Node v24.9.0。每项 3 个独立冷进程，串行，取中位数。内存为 Node `maxRSS` 加 sidecar `PeakWorkingSet64`，CPU 也包含 sidecar 进程。OS 文件缓存是热的。

| 语料 | WASM 冷启动 | 原生冷启动 | WASM 峰值内存 | 原生峰值内存 | CPU（WASM → 原生） |
|---|---:|---:|---:|---:|---:|
| VCPChat（1,726 个文件） | 3.76 s | **1.85 s** | 4,074 MB | **409 MB** | 21.1 → 12.5 s |
| VCPToolBox（2,862 个文件） | 6.03 s | **3.95 s** | 2,694 MB | **641 MB** | 38.0 → 24.7 s |
| audio-engine-core（169 个文件） | 0.43 s | **0.23 s** | 985 MB | **96 MB** | 3.3 → 1.5 s |

ProjectForge 同期对照：

| 语料 | 冷启动 | 峰值内存 |
|---|---:|---:|
| VCPChat | 2.40 s | 200 MB |
| VCPToolBox | 0.82 s | 157 MB |
| audio-engine-core | 0.24 s | 102 MB |

PF 在 VCPToolBox 只解析 966 个文件，本插件解析 2,859 个，两者不是同一口径。重复查询耗时不变，仍由图缓存决定，各约 211 ms、718 ms 和 27 ms。

## 已知限制与后续

- 压缩包和 bundle 的瓶颈是 tree-sitter 解析本身。例如 pixi.min.js（800 KB）解析约 210 ms，事实提取约 210 ms。
- VCPToolBox 的重复查询仍然慢，原因在扫描和工程上下文加载，与本轮无关，见实现审查第 2 条。
- sidecar 仍是可选安装。npm 用户没有这个二进制时，行为与之前完全相同。
