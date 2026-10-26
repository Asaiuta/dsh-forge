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

## 第二轮：重复查询的逐文件身份检查（同日）

事实提取搬走之后，重复查询剩下的成本几乎全是文件系统元数据操作。分段测量显示 `scanFacts` 里的逐文件 `statSync` 循环是最大一项：VCPToolBox（2,862 个文件）占 350–618 ms，单次约 0.12–0.22 ms。这个量级不是 SSD 的正常值——本机 `stat` 被 RaiDrive 的 CBFS 驱动拦截，元数据操作有固定延迟。

### 做法

新增 sidecar 方法 `statPaths`：一次传入整批路径，返回每个文件的 `(mtimeMs, size, ctimeMs)`，由 rayon 并行。

三个细节决定了它能不能直接用：

- **ctime 必须取到**。Windows 上 Node 的 `ctimeMs` 是 NTFS *change* time，std 没有任何 API 暴露它；没有它，「同尺寸改写 + 还原 mtime」的文件会复用旧事实。改从 `FILE_BASIC_INFO.ChangeTime` 读，代价是每文件多一次句柄查询（`CreateFileW` + `GetFileInformationByHandleEx` ×2 + `CloseHandle`），仍然远低于串行 `statSync`。
- **数值必须逐位相同**。Node 的 `mtimeMs` 是 `sec * 1000 + nsec / 1e6`（先在整数纳秒上拆 sec/nsec），不是 `ticks / 10_000`。两种算法在末位差 1 ulp，约 40% 的文件不同——若沿用后者，缓存会永远 miss。已按 Node 的公式实现。
- **超过 MAX_PATH 的路径要加 `\\?\` 前缀**。Node 内部自己加，所以 `statSync` 能成功；`CreateFileW` 不加会失败，这些文件会静默退回慢路径（VCPToolBox 的 `benchmarks/rivermemo` 下有一批中文长路径）。

回退有两层：某个路径 stamp 失败 → 该文件走本地 `statSync`，保住原来的 `stat_failed` 诊断文本；sidecar 不可用（无二进制、旧协议）→ 整轮走本地循环。`DSH_FORGE_TRACE_NATIVE=0` 时完全不调用。

### 一致性

三个语料、三种字段全部逐位比对，**0 处不一致，0 个 stamp 失败**：

| 语料 | 文件数 |
|---|---:|
| VCPChat | 4,363 |
| VCPToolBox | 23,585 |
| audio-engine-core | 30,523 |

### 性能

同一进程内先串行 `statSync` 全部文件，再一次 `statPaths`：

| 语料 | 串行 `statSync` | `statPaths`（rayon） |
|---|---:|---:|
| VCPChat（4,363） | 276–621 ms | **64 ms** |
| VCPToolBox（23,585） | 2,932–4,403 ms | **533–585 ms** |
| audio-engine-core（30,523） | 8,087 ms | **712 ms** |

在这一台机器上，`statSync` 的绝对值波动很大（同一份文件 276 ms 与 621 ms 都出现过），sidecar 一侧则稳定；上表取各自观测到的区间。

端到端重复查询（3 个独立进程、每个 3 次热调用，取中位数）：

| 语料 | 改前 | 改后 | 改后分段（VCPToolBox 同刻） |
|---|---:|---:|---|
| VCPChat（1,726） | ~700 ms | **296 ms** | — |
| VCPToolBox（2,862） | ~1,050 ms | **585 ms** | statLoop 350–618 → **40–49 ms** |
| audio-engine-core（169） | — | **39 ms** | — |

改后的绝对值仍高于上一轮记录的 145/278/21 ms：这一时段本机冷启动也从 1.85 s 涨到 4.6 s（同一负载），所以只宜与同刻的「改前」列比较，不宜与上一轮的数字横向比。

### 还没做的

重复查询剩下的两项仍是同步 `readdirSync`：

- `collectCandidates` 的目录遍历（VCPToolBox 233–250 ms）。语义包含根 `.gitignore`、`FILE_CAP`/`WALK_VISIT_CAP` 截断、元数据文件分类，复刻进 Rust 的出错面比 stat 大。
- `probesUnchanged` 的图缓存探测（VCPToolBox 158–190 ms）。约 1.5 万个候选路径，靠父目录列举剪枝，目录数不多但每次 `readdir` 也受同一驱动延迟影响。（已在下一节下推。）

## 第三轮：图缓存探测下推（同日）

图缓存复用前要复核 `buildGraph` 期间记录的每一条解析探测：`(相对路径, 是否解析到文件, 身份)`，身份是 `realpath(dir) + '\' + name`。VCPToolBox 一次重复查询有 15,291 条，靠父目录列举剪枝压到 280 次 `readdir`，仍在 JS 线程上花 158–190 ms。

### 做法

新增 sidecar 方法 `probesUnchanged`，逐条镜像 TS 版的分支：

- **父目录列举剪枝**：探测所在的目录不在父目录的列举结果里，直接判定「不存在」，不做 `readdir`。只差大小写地命中时不剪枝，转精确检查。
- **目录列举缓存按请求存活**：一条请求里 1.5 万条探测只读约 280 次目录。客户端因此把批量上限设成 5 万条/请求——分块会让同一批目录被重复列举。
- **精确检查**：符号链接、`ENOTDIR`（名字底下是个文件）、不可读目录、`canonicalize` 失败，都退回逐条 `metadata` + `canonicalize`，与 TS 版一致。
- **身份逐字相同**：`canonicalize` 给出 `\\?\D:\x`，剥成 `D:\x` 才等于 Node `realpathSync.native` 的输出。用 4 个仓库各 401 条路径逐个比对，0 处不同。

`DSH_FORGE_TRACE_NATIVE=0` 时完全不调用。客户端拿不到可用答复（无二进制、旧协议、请求失败）时返回 `null`，整轮判断交回 TS 版。

### 一致性

5 个场景，每个冷跑一次、改动一处、再热跑一次，两种实现必须给出相同的「复用/重建」结论：

| 场景 | 改动 | 应得结论 |
|---|---|---|
| `none` | 无 | 复用 |
| `add-asset` | 新增被探测的缺失资产 | 重建 |
| `add-case` | 只差大小写地新增同名资产（走精确检查） | 重建 |
| `del-present` | 删除已存在的被探测资产 | 重建 |
| `rm-ghost` | 删掉被探测过的空目录 | 复用（确实无可解析变化） |

5/5 一致。对拍本身也验证过会失败：把 sidecar 的判定硬改成 `true` 后，上表三个「重建」场景立刻与本地实现分歧，另两个仍然一致。另外直接对二进制做了 8 条协议用例（正确身份、错误身份、目录当文件、大小写折叠、批量 492 条读 56 次目录）。

全量测试两种模式都通过：原生 257 条 `ok`，`DSH_FORGE_TRACE_NATIVE=0` 256 条，均 exit 0。

### 性能

同一进程内冷跑一次建缓存，再 5 次热跑取中位数（`DSH_FORGE_AST_WORKERS=0`），两次采样：

| 语料 | 本地实现 | sidecar | 比值 |
|---|---:|---:|---:|
| VCPChat | 263 / 525 ms | **156 / 290 ms** | 0.55–0.59 |
| VCPToolBox | 630 / 1,175 ms | **370 / 557 ms** | 0.47–0.59 |
| audio-engine-core | 40 / 77 ms | **22 / 41 ms** | 0.53–0.55 |

两次采样的绝对值整体上移一倍，两列同向移动，所以只有比值可读。差值里含两项：本轮下推的 `probesUnchanged`（158–190 ms）和上一轮的 `statPaths`（40–49 ms）。

顺带修掉一处门控漏洞：重复查询的 `statPaths` 此前只检查 `DSH_FORGE_TRACE_NATIVE`，没有先问 sidecar 是否可用，于是 `DSH_FORGE_INDEXER=0` 仍会拉起子进程。现在两条下推都以「sidecar 就绪」为前提，关掉索引器就是完全不碰它——上表「本地实现」一列因此比上一轮记录的耗时更高，那是真正的无 sidecar 基线。

### 还没做的

- `collectCandidates` 的目录遍历（VCPToolBox 233–250 ms）。语义包含根 `.gitignore`、`FILE_CAP`/`WALK_VISIT_CAP` 截断、元数据文件分类，出错面比 stat 和探测都大。


