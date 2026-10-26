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

图缓存复用前要复核 `buildGraph` 期间记录的每一条解析探测：`(相对路径, 是否解析到文件, 身份)`，身份是 `realpath(dir) + '\' + name`。VCPToolBox 一次重复查询有 15,291 条，靠父目录列举剪枝压到 280 次 `readdir`，当时记的是在 JS 线程上花 158–190 ms（同刻插桩后来量到 89 ms，见《热查询的分段成本》，此处按当时的记录保留）。

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

两次采样的绝对值整体上移一倍，两列同向移动，所以只有比值可读。差值里含两项：本轮下推的 `probesUnchanged` 和上一轮的 `statPaths`。

本节和下两节的绝对耗时来自不同时段，不要混着比。同一时刻插桩量出来的分量见《热查询的分段成本》：那里 `probesUnchanged` 的本地实现是 89 ms，不是本节早先记的 158–190 ms——后者是冷态或受干扰环境的数字。

顺带修掉一处门控漏洞：重复查询的 `statPaths` 此前只检查 `DSH_FORGE_TRACE_NATIVE`，没有先问 sidecar 是否可用，于是 `DSH_FORGE_INDEXER=0` 仍会拉起子进程。现在两条下推都以「sidecar 就绪」为前提，关掉索引器就是完全不碰它——上表「本地实现」一列因此比上一轮记录的耗时更高，那是真正的无 sidecar 基线。

### 目录遍历：并行 readdir，不是缓存 mtime

第三项是扫描时的目录遍历。这一项前后做了三轮，前两轮都退了，第三轮才成立——三轮的判据都是实测，过程值得留着。

**第一轮（退回）**：语义对齐没问题（四个仓库 1,726 / 2,862 / 169 / 142 个候选的相对路径列表逐字相同，外加一个 60 项 `.gitignore` fixture），但按当时那组数字判为不值：

| 量法（VCPToolBox） | 本地 | sidecar |
|---|---:|---:|
| 紧循环微基准 | 80 ms | 72 ms |
| 真实路径插桩 | 102 ms | 102 ms |
| 拆开：sidecar 请求本身 | — | 91 ms |
| 拆开：abs 拼接 / 排序 | 8.3 / 1.9 ms | 同 |

同一个函数三次量出 80 / 102 / 194–233 ms：紧循环里没有别的活，V8 能在 `await` 间隙做增量 GC；连续 5 次背靠背遍历又把 GC 空档挤没了。**只信插桩在真实路径里的那组**：100 ms，换语言挪走 0–10 ms。原因不是 JS 开销，是 `readdir` 的调用延迟——877 个目录 × 约 95 µs ≈ 83 ms。结论：搬语言没用，要减只能少调。

**第二轮（也是退回）**：试「按目录时间戳缓存列举结果」。先验证 NTFS 能不能当失效信号（`dir-mtime.mjs`，8 个场景）：

```
create file / rename file / delete file / create subdir / rename subdir / delete subdir  → 目录变了
modify file content / create file in subdirectory                                        → 目录没变
同 tick（20 组 create+delete 对）漏判 0/20；跨进程立即可见；目录句柄被别人打开时仍可见
```

结论是可用，但单价的账不划算：

| 调用 | 单价（VCPToolBox 3,303 个目录） |
|---|---:|
| `stat` 一个目录 | 45.3 µs |
| `readdir` 一个目录 | 65.1 µs |

纯 mtime 缓存每轮省 65.1 − 45.3 ≈ 20 µs/目录，即约 30%，却要换来跨请求状态和「15.6 ms 时钟粒度窗口内改了目录」的漏判面。而 readdir 是**延迟**不是 CPU：一次列举 65 µs，一个目录 800 个文件也不涨——那就把一整层目录同时列举，延迟就重叠了。

**第三轮（成立）**：两阶段。

- **阶段一**：按 BFS 逐层用 rayon 并行列举，每个目录的结果（`readdir` 原始顺序、已分类的 `File/Dir/Link/Other`、已算好的 ignore 与否）存进 `HashMap<PathBuf, Snapshot>`。列举量与目录数超过 `WALK_VISIT_CAP` / `DIR_BUDGET` 就放弃，退回原来的串行 DFS——那种规模下截断点必须按 DFS 顺序花掉，不能靠并行结果拼。
- **阶段二**：按 DFS 在内存里的快照上重放，顺序与串行完全一致，因此 `FILE_CAP` / `WALK_VISIT_CAP` 截断在同一个文件上。这一条是必须的：**顺序变了，截断点就变**，两个实现在大仓库上会给出不同候选集。

收益（同一进程、7 次中位数、冷 assemble 之后）：

| 语料 | 本地遍历（含 abs + 排序） | sidecar 请求 | + abs 拼接 | + localeCompare | 合计 | 比值 |
|---|---:|---:|---:|---:|---:|---:|
| VCPToolBox（2,862） | 113.4 ms | 39.8 ms | 8.4 | 2.0 | **50.2 ms** | 0.44 |
| VCPChat（1,726） | 62.8 ms | 25.6 ms | 4.5 | 1.1 | **31.2 ms** | 0.50 |

端到端热查询（两个独立进程各取 5 次中位数，`DSH_FORGE_AST_WORKERS=0`）：

| 语料 | `DSH_FORGE_INDEXER=0` | 默认（sidecar） | 差 |
|---|---:|---:|---:|
| VCPToolBox | 414 ms | **202 ms** | −212 |
| VCPChat | 295 ms | **126 ms** | −168 |
| audio-engine-core（169） | 38 ms | **30 ms** | −8 |
| dsh-forge（142） | 28 ms | **33 ms** | **+5** |

最后一行是实话：**小仓库上 sidecar 更慢**，多出来的是一趟 IPC 加上子进程侧的固定开销，几百个候选以下赚不回来。这条没有加阈值规避——判候选数要先遍历一遍，而真的按目录数猜阈值只是把误差挪个地方。

一致性上，本轮新增了会失败的常驻对拍 `tests/run-trace-candidates.mjs`（5 组，进 `npm test`）：同一棵 fixture 上把两边列表逐字比对（不是比数量——数量恰好是「两个文件互换」最擅长骗过的东西），fixture 覆盖目录专用模式、`**`、锚定、字符类、否定、转义 `#`、同名规则在两个深度、ts/js config 家族、未知扩展名、`_dsh` 标记，并单独断言每条规则该收的收该弃的弃，避免「两边都是空」也算通过。另加 Rust 单测 `parallel_replay_matches_sequential_walk`（并行重放 vs 串行遍历，含截断旗标与 walkErrors）。

对拍本身验过会红：把 `matched_path_or_any_parents` 改回 `matched`（也就是第一轮踩过的坑），`run-trace-candidates` 立刻在 `dist/bundle.js`、`dist/deep/nested.js` 两个条目上分歧，其余全绿。

**顺带抓到一个真 bug，而且是别人抓的**：全量测试里 `run-trace-languages` 变红——那条测试的 `put()` helper 会给每个文件加 UTF-8 BOM，于是 `.gitignore` 的首行是 `\uFEFFignored/`。npm 的 `ignore` 包有一条第 `^\uFEFF` 的 replacer，Rust 的 `GitignoreBuilder` 没有，于是 sidecar 那条规则整条失效、`ignored/miss.py` 被重新扫进来。我新写的 fixture 不带 BOM，所以它没红——**新测试覆盖不到的地方，旧测试挡住了**。修法是按行剥掉行首 BOM；同时把 `read_to_string` 换成 `read` + `from_utf8_lossy`，因为非 UTF-8 的 `.gitignore`（中文 Windows 上的 GBK 文件）原本会让 Rust 侧多记一次 `walkErrors`，而 JS 侧只是把坏字节变成匹配不到任何东西的替换字符。

两个语义偏差记在这里，将来若要重做可以直接抄：

- `ignore` crate 的 `GitignoreBuilder::add_line` 一次只吃一行。把整个文件当一行传进去，**之后所有模式全部失效**（症状：sidecar 一个文件都不排除，dsh-forge 从 142 涨到 12,742）。要按 `lines()` 逐行喂。
- `matched()` 只比路径自身，`dist/` 这类目录专用模式匹配不到 `dist/a.js`，而 JS 的 `ignore` 包会。改成 `matched_path_or_any_parents(rel, false)`：父目录按目录参与匹配，路径自身仍按非目录，正好复刻 JS。另外 `projectMetadata` 还接受 `/^(?:ts|js)config(?:\.[^/]+)?\.json$/`（`tsconfig.app.json` 这类），只按等值判断会漏三个文件。

全量测试两种模式都通过：原生 262 条 `ok`，`DSH_FORGE_TRACE_NATIVE=0 DSH_FORGE_INDEXER=0` 261 条（少的一条是 candidate 对拍在无 sidecar 时显式 SKIPPED），均 exit 0。

## 热查询的分段成本（同日实测）

临时给 `assemble` 与 `scanFacts` 插了 `performance.now()` 打点，取 6 次热调用的中位数（`DSH_FORGE_AST_WORKERS=0`、`DSH_FORGE_INDEXER=1`）：

| 阶段 | VCPToolBox（2,862） | VCPChat（1,726） | audio-engine-core（169） |
|---|---:|---:|---:|
| 目录遍历 `walk` | 102 | 36 | 11 |
| 逐文件 stat `statBatch` | 41 | 37 | 5 |
| stamp 循环 `stamps` | 2 | 1 | 0 |
| 事实提取 `facts`（全命中） | 2 | 0 | 0 |
| **工程上下文 `contexts`** | **34** | **27** | 5 |
| sidecar 就绪 `ready` | 54 | 25 | 6 |
| 图缓存校验 `probes` | 0 | 0 | 0 |
| 合计 | 238 | 128 | 27 |

表里 `walk` 是并行遍历之前的那一版；现在同一语料上这一项约 50 ms，见《目录遍历：并行 readdir》。其余各行与本节一致。

对照 `DSH_FORGE_INDEXER=0`（完全不碰 sidecar）：VCPToolBox 409 ms（`walk` 103 + `stamps` 165 + `probes` 89 + `contexts` 36）、VCPChat 197 ms（38 + 98 + 27 + 26）。差的 171 / 69 ms 就是前两轮下推兑现的部分。

### 工程上下文加载：27–34 ms，不是 70–90 ms

`contexts` 这一段是 `loadJsProject` / `loadPythonProject` / `loadRustProject` / `loadGoProject` / `loadCompilationDatabase`，热态只读几个元数据文件，不碰代码。此前记的 70–90 ms 应是冷态或受干扰的数字；热态占一次查询的 13–23%，冷 rebuild 上是 62–98 ms。本节这一行是按功能块量的；拆细之后 `jsProj` 与 `rustProj` 分开看合计 54 ms，见《第四轮》。

### 图构建：热查询上是 0

`buildGraph` 只在图缓存未命中时执行——热查询在 `probesUnchanged` 通过后直接返回缓存的 `assembled`。它只出现在 rebuild 上：

| 阶段 | VCPToolBox | VCPChat |
|---|---:|---:|
| 目录遍历 | 406 | 251 |
| 事实提取 | 6,615 | 2,787 |
| 工程上下文 | 98 | 62 |
| **buildGraph** | **931** | **302** |

冷路径的第一大项是事实提取，第二大就是图构建。下推它的收益面最大，代价也最大：`buildGraph` 是纯内存图算法加解析器组合，输入是全部文件的 facts、声明表与五种工程上下文，输出是节点、边、注册表与 bridge 过滤结果；复刻它等于把 `linkgraph` 和五个 resolver 一起搬进 Rust，出错面比前三项加起来还大得多。不建议动。

## 第四轮：热查询剩下的那些钱（同日实测）

第二轮的分段表是按功能块分的（walk / statBatch / contexts / ready）。这一轮把它拆细，并且先拆清楚再去动，结论是原来的两笔账都不对。

### 拆细之后（VCPToolBox 2,862 个候选，6 次热调用中位数）

| 阶段 | 拆细前 | 拆细后 | 说明 |
|---|---:|---:|---|
| 目录遍历 sidecar 请求 | 102（含下面两行） | 44 | 并行 readdir |
| `abs` 拼接 | — | 10 | 原来被算进 walk |
| `localeCompare` 排序 | — | 2.6 | 顺序是签名的一部分，不动 |
| 逐文件 stat | 41 | 39 | 已在 Rust 侧并行 |
| 工程上下文 | 34 | 54 | 原来漏了 `jsProj` 与 `rustProj` 分开算 |
| 图缓存探针检查 | 54 | 80 | 这是最大的一块 |
| 其余（facts / 遍历判定 / 编译库） | 7 | 10 | |
| 合计 | 238 | 240 | 总数没变，权重变了 |

### 探针检查：不是「一趟 1 MB 的往返」

原来的假设是「15,291 条探针约 1 MB JSON，往返本身贵」。逐项量下来不成立：

| 量法 | 结果 |
|---|---:|
| JS 侧展开 Map + 转数组 + `JSON.stringify` | 6.1 ms（0.83 + 1.19 + 4.08） |
| 一次空往返（`statPaths` 传空数组） | **约 0.05 ms** |
| 8 条探针整趟 | 2.1 ms |
| 15,291 条探针整趟 | 69.0 ms |

**一趟 IPC 几乎不花钱。** 所以「把 stat 和探针校验合成一次请求」这件事从计划里划掉了——省下的是一次 0.05 ms 的往返。真正的大头是探针数量本身。

再往下拆一层，用合成探针（同样 15,291 次迭代，全都不存在，所以循环一定跑完）：

| 形态 | 耗时 |
|---|---:|
| 一条目录、短名字 | 15.4 ms |
| 10 条目录、短名字 | 16.0 ms |
| 300 条目录、短名字 | 17.8 ms |
| **真实路径、真实目录** | **69.0 ms** |

同样是 15,291 次循环，短路径 15 ms、真路径 69 ms。差别不在循环次数，也不在 readdir 次数（实测只有 280 次），而在**为这 280 个真实目录建列举表**：每个条目要往两个哈希表各插一次，其中一个是 `name.to_lowercase()` 新分配的字符串。

### 改了什么，各值多少

| 改动 | 位置 | 隔离实测 |
|---|---|---:|
| 探针的折叠索引从 `HashSet<String>` 改成 `HashSet<u64>`（`fold_hash`） | `rust_indexer/src/main.rs` | 69.0 → 35.4 ms |
| 每个候选文件的 `abs` 不再走 `path.join` | `src/tools-trace.ts` | 10 → 0.95 ms |
| 五个 `scan.entries` 遍历合并成一次 | `src/tools-trace.ts` | 3.8 → 2.5 ms |

`fold_hash` 之所以安全：命中不了只会让探针走下面那条精确检查（`metadata` + `canonicalize`），那是保守答案，不可能把「变了」误判成「没变」。ASCII 就地折叠，非 ASCII 退回真正的 `to_lowercase()`，所以和 JS 的 `name.toLowerCase()` 在边缘情况上也一致（`str::to_lowercase` 与 `char::to_lowercase` 在词尾 sigma 上不同）。

端到端（两个独立进程各 5 次中位数）：

| 语料 | `DSH_FORGE_INDEXER=0` | sidecar | 上一轮同法测得 |
|---|---:|---:|---:|
| VCPToolBox | 528 ms | **169 ms** | 202 ms |
| VCPChat | 201 ms | **113 ms** | 126 ms |
| audio-engine-core | 28 ms | **19 ms** | 30 ms |
| dsh-forge（142） | 27 ms | **22 ms** | 33 ms |

「本地实现」一列在两次测量之间从 414 漂到 528 ms，测试机噪声太大，不能跨行比；sidecar 一列稳定。小仓库那一行这次也不再是负收益。

顺带一个副产品：这轮补了一条常驻回归 `run-trace-cache` 的「依赖换个大小写回来也要失效」——它正好压在 `fold_hash` 上，把 `folded` 判定改成恒 false 后立刻变红。

### 还剩什么

现在 VCPToolBox 一次热查询 169 ms 的分法是：探针检查 35（隔离实测 35.4）、遍历 47、stat 40、工程上下文 28、其余 19。

两块可以考虑，都不便宜：

1. **工程上下文每次查询都重算，只为了比一次签名。** `scan.signature` 已经相同（所有候选的 `(mtime, size, ctime)` 与根身份都没变）时，py/rust/go 三个 context 的 `valid()` 都是 `() => true`，也就是说它们自己认为「签名就是全部检查」，而签名是从候选文件内容算出来的——那些文件的戳已经在 `scan.signature` 里了。把它们整块跳过能省约 15 ms。**缺口**：`loadPythonProject` 会列举目录来发现 namespace package，新建一个只含非候选文件的目录不会改任何戳，跳过就看不到了。要动必须先把「哪些输入不是候选文件」这件事列干净，`compile_commands.json` 与 preload 声明表就属于这一类（前者本来就在每次重算，1 ms）。
2. **探针列举表（约 35 ms 里的 20 ms）。** 280 个目录每次都重新 readdir 再建两张表。按目录时间戳缓存列举结果能省掉，代价是跨请求状态和 15.6 ms 时钟窗口——和第三轮否掉目录缓存是同一个理由，只是这次赌注更小、收益也更小。

## 关于测量的两条（这一轮换来的）

1. **同一个函数能差 3 倍，取决于你在哪儿量。** 紧循环 80 ms / 真实路径插桩 102 ms / 背靠背连调 5 次 194–233 ms，是同一个 `collectCandidates`。紧循环里 V8 在 `await` 间隙做增量 GC，把成本测低了；背靠背又把 GC 空档挤没了。**只有插桩在真实调用路径里的那组能用**，其余两组可以用来判断「方向」，不能用来判断「值不值」。
2. **同一个函数在同一个进程里，位置不同也能差 2–3 倍。** `walk-heap.mjs` 把 `collectCandidates` 分别放在冷启动后和一次完整 assemble 之后各量一遍，后者稳定慢 2–3 倍（堆上已经有几万个 fact 对象和整张图）。所以「A 比 B 快」的结论必须在**同一个位置**上交替量，不能一个在干净进程里、一个在吃饱了的进程里。
