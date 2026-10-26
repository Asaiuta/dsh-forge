# Trace 优化与问题修复记录

日期：2026-10-24。基于当前工作树局部修改，保留已有未提交工作。初次发现见 [实现审查快照](implementation-review-2026-10-24.md)。

后续与 VCPChat 的统一语料对照及节点访问优化见 [第二轮性能记录](trace-vcpchat-comparison-2026-10-24.md)；本文保留第一轮的历史测量。

Rust / Python / C/C++ 文件依赖与继续优化见[第三轮记录](trace-languages-performance-2026-10-24.md)，此前纯 Rust 覆盖为零的描述仅对应当时的语言范围。

## 结果

两个真实仓库的完整 Trace 图与修复前基线一致；比较时仅统一根路径分隔符和 HTML inline 文本的 CRLF/LF。候选集合、反向依赖、IPC、全局变量、bridge、页面成员与执行顺序均纳入比较，没有排除大型 bundle 来缩短扫描。

以下为同机、两个仓库依次运行、各自新 Node 进程的单次测量。冷指进程内解析与图缓存为空，操作系统文件缓存没有清空；热指同一进程紧接着第二次查询。Windows、Node v24.9.0、i5-12500H、可用逻辑核心 16，自动使用最多 8 个 AST Worker。

| 仓库 | 候选文件 | 修复前冷扫描 | 最终冷扫描 | 耗时减少 | 修复前热查询 | 最终热查询 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| VCPChat | 1,691 | 52,357 ms | 14,282 ms | 72.7% | 614 ms | 835 ms |
| VCPToolBox | 1,430 | 67,687 ms | 20,252 ms | 70.1% | 1,125 ms | 1,533 ms |

时延会随系统负载波动。后续全套测试也独立重跑了冷扫描，原始时间见测试日志；上表保留完整图对比运行的实测值。热查询没有显示稳定提速，仍需遍历文件、校验 stat 和依赖存在性，因此没有将它描述为常数时间或毫秒级命中。

## Trace 的实现调整

- 复用现有 AST Worker 池提取 JS/TS/HTML 事实，按文件字节数均衡分配，顺序归并结果。自动模式至少 16 个待解析文件才并行，`DSH_FORGE_AST_WORKERS=0` 可强制顺序。
- 每个语法树内部缓存节点视图、字段与访问结果，减少包装函数识别和事实提取反复跨 WASM 读取同一节点的开销；提取结束在 `finally` 中释放语法树。
- 文件事实与 bridge 配置解耦。先提取候选，再根据全仓发现的别名在内存筛选，消除别名扩展后的第二轮解析。
- 文件事实缓存最多 6,000 条，按路径和 mtime/size/ctime 校验；失败读取不缓存，以便权限恢复后重试。内容重读时走哈希验证，覆盖同大小、恢复 mtime 的编辑。
- 完整图缓存最多 4 项，验证候选集合、文件签名、声明表内容、失败状态和解析时探测的依赖存在性。新增或删除非源码 asset、缺失路径恢复也会失效。
- 同根、同声明表、同 Worker 池的重叠请求共享扫描。各调用者独立取消；最后一个调用者取消时等 Worker 确认停止后返回。插件之间保留各自池的所有权。
- Worker 内请求顺序处理；共享槽上的超时请求通过取消标志停止，不终止其他请求。仅剩一个请求时允许终止该 Worker 作为硬上限。Trace 不把超时或缺失结果当作成功的部分图返回。

输出新增 `parseErrors`、`partialFiles`、`walkErrors` 和 `incomplete`。失败、语法部分解析、候选截断或声明表失败都会显示“分析不完整；未找到仅表示已分析范围内无命中”。

## 其他审查问题的修复

- 卡片描述按配置反映是否可能调用 endpoint，模型润色返回 `source: "model"`，明确自然语言事实未经核验；`skeleton: true` 可始终读取确定性来源，endpoint 模式也不发请求。
- 引用校验按实际批次集合检查 `#N`，拒绝零号和恢复台账中的缺号。路径/批次校验仍不能证明自然语言描述、数量、日期或关系真实。
- npm 包按便携 WASM 路径发布，原生 sidecar 改为明确的可选本机源码构建：`pnpm run build:indexer`。脚本使用锁文件、明确选择 Cargo host，并按 `compiler-artifact.executable` 返回的实际路径安装到 `rust_indexer/bin`，覆盖 target/config 目录差异；生成目录已忽略。
- `docs/DESIGN.md` 进入发布清单；README 的 Worker 默认值、原生安装方式和校验保证与实现同步。
- 原生符号缓存限制为 6,000 条，命中更新使用时间，批次完成后清理最旧项；读取同时设置字节上限，覆盖 stat 后文件增长的情况。
- 生产符号查找将剩余预算和取消信号传入 readiness 等待及 sidecar 请求。过期预算不再派发，等待超时/取消时清理 pending、计时器与监听器；共享启动 ping 上限为 2 秒，各调用者可独立停止等待。
- 子进程退出、stdout 和 stdin 错误处理绑定进程身份；reset 清理旧请求与缓冲，旧进程的迟到事件不会破坏新进程。断管/EOF 会回退，避免流 error 未处理导致宿主退出。
- 工具面测量读取实际工具数量，修正原来硬编码 13 和负数“低估”的输出。工具仍为 9 个；工具启用列表与语言后端收敛属于后续结构任务。

此前已完成的环境 API key、卡片串行标记和孤立声明清理修复继续保留。

## 验证

| 检查 | 结果 |
| --- | --- |
| `pnpm run check` | 类型检查、构建、声明生成均 exit 0 |
| `pnpm test` | 28 个入口执行链 exit 0；27 个套件实际执行，真实宿主集成 1 项跳过 |
| Trace 人工 oracle | 11 类边，53 TP、0 FN、0 FP |
| Trace 缓存/覆盖度回归 | 8 组通过，覆盖增删改、恢复 mtime、依赖探测、别名与声明表、顺序/并行等价、共享请求及取消 |
| 索引器回退与生命周期回归 | 11 组通过，覆盖请求/启动预算和取消、实际断管退出、实际 sidecar 连续重启 |
| 四个真实仓库 | VCPChat、VCPToolBox、audio-engine-core、dsh-session-hub；各自两次真正冷解析，健康度、确定性和结构不变量通过 |
| Rust `cargo test --locked` | 1 项缓存淘汰单元测试通过 |
| `pnpm run build:indexer` | 配置 `CARGO_BUILD_TARGET=x86_64-pc-windows-msvc` 的 release 构建与本机安装 exit 0；安装产物 SHA-256 与 host artifact 相同 |
| `node rust_indexer/parity.mjs` | 实际 sidecar 与 WASM 对照 39 checks 通过，含 19 个文件的完整符号树、查询和大纲视图 |
| 发布 dry-run | 156 项；设计文档已包含，孤立声明与临时文件未包含；sidecar 按可选策略不入包 |
| `git diff --check` | exit 0 |

独立审查复核了池隔离、最后调用者取消确认、共享 Worker 超时隔离、别名/HTML 和模型来源说明；并用实际 Worker 重现验证所有权修复。追加复核用实际进程确认 readiness 取消由约 2 秒降至 20 毫秒，reset/restart 保持可用，stdin EOF/EPIPE 由宿主崩溃变为正常回退。

真实宿主路径配置存在，但配置位置下的 `dsh-fs-sandbox/lib/index.js` 不存在，因此该集成尚未验证。没有向真实上游模型发送测试请求，endpoint 回归使用本地 stub。

## 仍存在的边界

VCPChat / VCPToolBox 各有 1 个读取或解析失败，另分别有 82 / 3 个部分解析文件，遍历失败均为 0；这些覆盖限制在最终输出可见。真实仓库没有人工穷举真值，完整图等价及确定性不等于真实语料准确率 100%。纯 Rust 仓库的 Trace 适用文件为 0。

首次扫描的剩余热点是大型 vendor bundle 的 AST 提取，仍有秒级成本。运行时没有新增常驻文件监听器或跨进程持久化图缓存；热查询保留文件系统校验开销。

原生请求取消只停止当前调用者等待，已交给共享 sidecar 的计算继续完成。全仓原生 root-walk 接口尚未成为生产符号查询主路径，TS/WASM 与 Rust 的语言 collector 也没有在本次性能修复中合并。

## 本地证据

原始证据保存在 Git 忽略的 `.tmp-analysis/`，不进入 npm 包：

- `trace-review/before/*.graph.json`、`*.metrics.json`：修复前完整图与时间。
- `trace-review/after-final/*.graph.json`、`*.metrics.json`、`comparison.json`：最终完整图、时间与等价检查；metrics 包含各自原始序列化输出的 SHA-256。
- `trace-review-compare.mjs`：仅对根路径和 HTML inline 换行归一化，逐项比较完整图及公共覆盖度元数据。
- `review-fixes-final-tests.log`、`review-fixes-native-parity.log`：全套测试与原生对照输出。
- `review-fixes-native-build.json`：Cargo host artifact 与安装文件的 SHA-256 对照，均为 `774e1718ca1a49184c744190037b380ade14d6adc1d72962ca558a5de06d5b99`。
- `review-fixes-pack.json`：发布 dry-run 文件清单。

工作区修改尚未提交或发布。
