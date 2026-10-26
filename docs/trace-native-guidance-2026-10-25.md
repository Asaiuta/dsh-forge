# Trace 多语言、原生边界与 DSH 工具使用诊断

日期：2026-10-25。接续 [Trace 影响分析与编译数据库增强](trace-advanced-2026-10-25.md)，本轮接入 Rust use、TS ambient module、Python 动态导入、Go/Java/Lua 和源码 FFI / PE/ELF/WASM 元数据，仍只有一个 `fftrace` 工具。所有结论来自本地源码、日志、测试和离线 SDK 投影，没有发送模型请求，未提交、推送或发布。

## 优先修复：插件在模型选工具之前就激活失败

本地桌面日志反复记录 `include:dsh-forge` 在加载阶段出现：

```text
ValidationError: $.cards.endpoint.baseUrl missing required value
```

原因是配置 schema 把可选的 endpoint 对象自动补成 `{}`，再因其中的必填 `baseUrl` / `model` 缺失而拒绝整个插件，尚未执行 `apply()`。这比“模型偏好其他工具”是更直接的可用性问题；它解释相关启动中的工具缺失，不能反推更早历史会话的全部调用选择。

`src/config.ts` 已改为显式的“有效 endpoint 对象或 null，默认 null”。默认、session、off 配置正常加载；显式空对象、缺字段对象仍会报错，endpoint 模式缺少有效配置仍会被拒绝。测试增加完整插件对象 `{ Config, inject, apply }` 的 Cordis 激活路径，避免只测 `ctx.plugin(apply)` 而漏过宿主的 schema 校验。

| 日志文件日期 | 筛选的相关日志记录 | 涉及 run ID 数 | 最后一条时间（UTC） |
| --- | ---: | ---: | --- |
| 2026-10-24 | 39 | 17 | 2026-10-24 16:50:59.314 |
| 2026-10-25 | 8 | 4 | 2026-10-25 05:41:06.984 |

筛选包含 loader / HMR 包装记录及重复 warn/error，因此不能把记录数称为独立激活失败次数。脱敏摘要保存在 `.tmp-analysis/trace-round6/activation-log-evidence.json`，没有保存凭据或完整用户提示。

实际 profile 已配置接管 `read/glob/grep`，其 `node_modules/dsh-forge` 链接到本仓库。本轮没有修改 profile 或重启桌面。已从当前安装的 `<DSH 安装目录>/resources/app.asar` 只读提取相关宿主 SDK，使用 dsh-tools `0.2.1-rc.2`、Cordis `4.0.5` 验证：6 个全局工具、3 个 agent scope 工具和引导 section 正常注册。**这证明安装版 SDK 的离线加载路径通过；当前运行桌面是否已恢复，及模型使用率是否改变，尚未验证。运行中的宿主需重新加载插件以采用新构建。**

## Trace 补齐范围

| 范围 | 本轮实现 | 保留的限制 |
| --- | --- | --- |
| Rust use | 按真实 mod 归属解析分组、别名、crate/self/super 路径，保留已有 path/include 能力 | 模块候选，不是类型解析；不展开宏、cfg、重导出或 extern crate。归属预算 20,000、深度 64，达到预算停止 use 推断并标记 resolutionLimited/incomplete。 |
| TS ambient | 无顶层 import/export 的脚本中，精确 `declare module "name"` 可成为裸模块导入目标 | 不模拟通配模块、模块增强合并或包管理器；多个声明目标不任意选取。 |
| Python 动态 | 字面量 `__import__`、已确认的 importlib / import_module 别名、显式字面量 package 相对导入 | 不执行 Python 或猜测动态字符串；assignment、with、except、comprehension、lambda 等绑定/遮蔽会保守关闭相应 loader 推断。 |
| Go | 最近 go.mod 的 module 前缀和本地包的所有非测试成员，标记构建候选 | 不处理 build tag、GOOS/GOARCH、go.work、replace/vendor；无效嵌套 go.mod 也隔离模块边界。 |
| Java | 按 package 与顶层类型解析显式、static、通配 import | 通配 import 是包成员候选；不解析 classpath、JAR、继承或编译模块；重复类型身份拒绝猜测。 |
| Lua | 字面量 require，包括字符串简写，按根下 name.lua / name/init.lua 查找候选 | 不执行 package.path 或自定义 loader；require、_G.require、_G["require"] 及 rawset 重绑定保守排除。 |
| 源码 FFI | Rust export/foreign/ABI、C/C++ extern C / dllexport / N-API、紧邻函数的 cgo `//export` | 只证明声明，不验证链接保留、ABI、符号修饰或实际调用；复杂宏/函数指针与部分 Rust unsafe extern 新语法仍可能部分解析。 |
| 二进制 | 只读 PE/ELF/WASM 格式、架构、依赖库和导出元数据；PE ordinal/forwarder、ELF 动态符号 | 不加载或实例化。未支持 Mach-O、archive、导入函数名、PE delay-load、无 section header 的 ELF 动态表、WASM memory64；不提供反汇编或完整有效性验证。 |

`ffi:<name>` 将源码声明与二进制同名导出分别展示，不生成跨语言调用边；`file:<binary>` 可直接查看二进制元数据。现有 `impact:` / `path:` 继续复用文件依赖图。

每个二进制最多 32 MiB、20,000 个符号，FFI 文本最多 30 项、结构结果最多 100 项。PE 目录读取严格服从 optional-header 边界；ELF 普通 SYMTAB 不当作动态导出；WASM 损坏长度、溢出的 u32 LEB128 和重复导出拒绝读取。遇到缺失、预算或部分解析，输出保留覆盖度，不将“未找到”包装成完整否定证据。

Lua 原 `tree-sitter-wasms@0.1.13` scanner 存在独立解析间的状态串扰，新建 Parser 或 reset 也不能可靠消除。本轮仅将 Lua 切换到固定的 `@tree-sitter-grammars/tree-sitter-lua@0.4.1` WASM，并适配其 AST 字段；其他语言和显式 grammar 目录优先级不变。没有采用会持续创建 Language 对象的规避方式。

实现按职责拆为 `language-facts`、`module-resolution`、`ffi-facts`、`binary-{facts,pe,elf}` 和 `trace-native`，接入现有 facts/cache/graph/output 路径，没有另造索引系统或增加工具名。

## DSH 历史使用证据与引导调整

固定检查 Forge、custom-header、VCPChat 三个 workspace 目录的 32 个本地 session；18 个包含工具调用。Zstd 日志按多帧完整解码，不能只读取首帧。

| 观察 | 数量或边界 |
| --- | --- |
| 工具调用总数 | 2,172 |
| 当前九个 Forge 名称的历史调用 | 221；其中 fftrace、ff_cards 均为 0 |
| 旧 Forge 名称 | 15（ffglob 9、ff_outline 5、ff_project 1） |
| 含 Forge / fftrace 的 request header | 49 / 49 |
| 有 Forge 引导的 system/message | 30 / 31 |
| 正则筛选出的 shell 检索候选 | 337；不表示均可避免或均是工具失败 |
| 原生名称历史调用 | read 345、glob 12、grep 16；不能直接视为当前接管模式绕开 Forge |

这些有效调用截至 10 月 17 日，早于 10 月 20 日的当前 takeover 配置，不能据此评价当前偏好或修复后的提升。历史工具列表通常 44–50 个，早期另有一份 104 个；后置原生引导仍要求 read/glob/grep，旧 fftrace 描述主要突出 JS/Electron。它们构成可发现性与重复工具竞争的线索，没有 A/B 或模型因果证据，不能概括为模型天生不喜欢插件。

本轮引导按当前 scope 可见能力生成，加入 impact/path/ffi 的任务例子；原生 grep/glob 只描述其实际参数，不承诺 additive 的 patterns / mode=name。接管失败留下无 Forge 标签的 built-in 时不宣称 Forge 扩展能力。最终投影还发现真实 grep/glob 工厂使用 native 标签，已修正对应过滤并用安装版 Cordis 的实际注册定义验证三条 read/glob/grep 引导。权限拒绝仍须遵守，不再建议换工具绕开。

使用安装版 SDK 的离线投影结果如下，token 数采用 cl100k_base，仅比较插件贡献；基线投影绕过完整 Config 激活，属于假设成功加载的工具面，不能称作真实生产请求。

| 投影 | additive 基线 → 最终 | takeover 基线 → 最终 |
| --- | ---: | ---: |
| 引导 bytes | 2,647 → 2,001 | 2,616 → 1,827 |
| 引导比较用 tokens | 591 → 422（-28.6%） | 578 → 378（-34.6%） |
| native schema tokens | 3,363 → 3,407 | 3,159 → 3,203 |
| native schema + 引导，两部分计数相加 | 3,954 → 3,829 | 3,737 → 3,581 |
| PTC TypeScript 插件贡献 tokens | 4,264 → 4,393 | 4,058 → 4,187 |
| PTC Python 插件贡献 tokens | 4,840 → 5,018 | 4,600 → 4,778 |

工具仍为 9 个，忽略描述后的输入 schema 完全一致。PTC 输出增加来自 FFI 结构，不能宣称所有提示面均缩小。该投影不含完整宿主提示/其他插件，不是 DeepSeek 实际 token 使用量或偏好测试。中间 `prompt-host-final-*` 的 348-token takeover 引导曾误过滤两条检索提示，作为历史证据保留；最终有效结果使用 `prompt-host-delivery-*`。

## 与 ProjectForge 的差距和取舍

PF 侧沿用 [2026-10-24 源码与随附二进制探针](trace-projectforge-capability-performance-2026-10-24.md)，本轮没有重新测量 PF，也没有验证其后续改动。以下比较限于 Trace。

| 项目 | 当前判断 |
| --- | --- |
| 主要语言/格式入口 | 先前缺失的 TS ambient、Rust use、Python 动态、Go/Java/Lua、ffi 与 PE/ELF/WASM 已接入，本轮回归验证其明确的子集；不等于逐项全语义一致。 |
| PF 仍较宽的事实 | Java 继承/接口/字段/参数类型和 module-info，部分 C++20 module/import、cgo 导言 include 及某些宏导出形态；本插件未实现相应完整关系。 |
| 本插件已有优势 | impact/path、显式 compile_commands 搜索顺序、跨模块 IPC wrapper、资源反查、binary 的 file 查询；Rust mod 归属、完整 Go 包成员候选及预算/部分覆盖度更明确。优势限于已有实现与样例，不作全量准确率排名。 |
| 原生性能后端 | PF 有 Rust/Rayon 每文件 facts；本插件现有 Rust sidecar 仍只加速符号，Trace 使用 WASM/JS Worker。若继续攻大仓冷态，原生 facts 协议与完整行为对齐仍是主要工程缺口。 |
| 共同边界 | 都不能据这些入口提供完整类型系统、运行时依赖、任意函数调用图或 FFI ABI 验证；C# 文件连边仍未补齐。 |

PF 的相关 Rust 索引器标注 CC-BY-NC-SA-4.0，本插件为 MIT；本轮独立实现，没有复制其实现。不能以更激进的猜测或缩减覆盖作为对齐要求。

## 验证与本轮性能

`pnpm run check` 和完整 `pnpm test` 均 exit 0：32 个入口全部实际执行、无宿主跳过。新增语言/包回归 10 组，原生边界回归 8 组，安装版宿主集成 25 组。已有人工边真值：JS/HTML 54 TP / 0 FN / 0 FP，Python/Rust/C/C++ 38 TP / 0 FN / 0 FP。真实仓库健康、确定性和结构检查通过，不能据此声称全图边准确率。

完整测试后最后调整仅涉及 `guidance.ts` 与宿主引导断言；再次执行类型/构建、注册、挂载和安装版宿主测试均 exit 0。独立审查修复反馈后无剩余 P1/P2；最终标签修正的窄复核也无剩余 P1/P2。最终差异检查和打包 dry-run 均 exit 0，包清单 166 项，新增声明齐全，没有临时 SDK/fixture、已删除模块残留声明或发布文档本地坏链。详情记录在 `final-audit.json`。

性能使用冻结 JS/HTML 文件集合、上一轮最终版本作为本轮基线、本轮冻结增强版本。每仓每版本 3 个新进程，每进程 1 次冷查询 + 3 次热查询；第二轮反转顺序，全部串行，没有本任务测试/构建并发，不清 OS 缓存。Windows / Node v24.9.0 / i5-12500H / parallelism 16，默认 8 AST Workers。计时为 assembleTraceGraph 的扫描至组图，不含模块加载、序列化、断言与展示。

| 语料 | 文件 | 基线冷态 ms | 增强冷态 ms | 基线热态 ms | 增强热态 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| VCPChat | 1,691 | 4,197.947（3,576–4,306） | 4,149.688（3,495–4,363） | 394.521（227–599） | 352.786（236–450） |
| VCPToolBox | 1,430 | 5,422.107（4,840–5,783） | 5,735.234（5,596–5,849） | 447.455（345–518） | 474.404（431–589） |

表为中位数及范围，冷态各 3 样本、热态各 9 样本。Chat 冷态约 -1.15%、热态 -10.58%；Toolbox 冷态约 +5.78%、热态 +6.02%。进程累计 CPU 时间冷态中位数分别为 31,501 → 31,142 ms、42,125 → 41,891 ms。范围重叠、样本有限，不能宣称稳定提速或完全无回归；Toolbox 有观测变慢。新语言/binary 默认扫描集合不在此表中，不能拼接历史 PF 耗时更新倍率。

所有冷/热样本完整输出均在版本内一致；Chat 前后字节完全一致。Toolbox 仅 `AdminPanel-Vue/src/types/easymde.d.ts` 增加精确 ambientModules 事实；剔除此字段后严格深比较确认其他 facts、图字段、依赖边和覆盖度全同。两套各 parseErrors=1，partialFiles 分别 82 / 3，walkErrors=0，前后不变。最终 guidance 修正后的 Trace 构建依赖闭包另作字节一致性核验，不重复计时。

## 身份与本地证据

| 身份 | SHA-256 |
| --- | --- |
| 最终交付 src 清单 | bea1848bc02fa491fdeb041a5fbd31354880d3f3074df221768ede0f2a3ade7f |
| 最终交付 lib 清单 | 429446686370fa327a1bc3ad605836ed009b141b484f073bfbf9b0a8a0b81f97 |
| 最终交付 tests 源文件清单 | 97a9bdf68104ee52b88d5ca03d298124fe184ec6c2fbf4157457015786c3d6e3 |
| 性能冻结增强 src 清单 | c08e53811a7cc4774ec7b1f15c2b9ca52dd909263212d5bf2e6dd26bbbd12fa9 |
| 性能冻结增强 lib 清单 | 207d394255a190404bd10781d980ae032f3a0268449239e017b6ec96ecdeb164 |
| 性能基线 lib 清单 | 2e3dc9979e4c5c733515513d25fe9df5621ca9b7a1a986f2edb313e486343177 |
| Chat 完整图，前后相同 | d752dfc81d9c09b74765f4be2c991f195fe239b406b4904efb4b69aa3e5c80e4 |
| Toolbox 基线图 | 7ad203c3d3554644d919b803f45f938fa0c96ad0bbd135b0ff36fd42bf117207 |
| Toolbox 增强图 | 37983dce8ba4fbc1b2d7b7757b0edb31cc5e741367cd1ab2fb7b10ee62329d6d |
| 安装版 app.asar | 204e1dcc32ff6a9b661200b7ab97bda1cbd449904e2eddb71c9309cf767e06b5 |

最终交付因引导过滤修正与测试断言而与性能冻结版本有明确差异；新身份和逐文件差异见 `delivery-identity.json`、`final-audit.json`，不将上述性能清单误称为最终源码清单。HEAD 保持 `06592d00cddd49cf7c53406a3bb71277b885119a`，保留此前所有无关 dirty 工作。

证据位于忽略目录 `.tmp-analysis/trace-round6/`，不进入发布包：

- `host-sdk-identity.json`、`extract-host-sdk.mjs`：安装版 SDK 来源；不改用户安装。
- `activation-log-evidence.json`、`dsh-session-audit*.json`、`analyze-dsh.mjs`：脱敏日志摘要及多帧会话审计。
- `check.log`、`full-test-verified.log`、`host-integration-final.log`：完整实现验证；`guidance-*.log` / `guidance-checks.json` 是最后引导修正的针对性复验。
- `prompt-host-baseline-*`、`prompt-host-delivery-*`、`prompt-delivery-summary.json`：最终有效离线投影；保留中间结果，不覆盖旧证据。
- `baseline-*`、`final-*`、`final-identity.json`、`verify-performance.mjs`、`performance/`、`performance-summary.json`、`performance.log`：冻结实现和逐样本全图/时延。
- `delivery-identity.json`、`final-audit.json`、`final-pack.json`、`final-diff-check.log`、`finalize-audit.mjs`：最终身份、测试来源、包清单、相对链接与差异检查。打包仅 dry-run，无临时提取 SDK/fixture 或已删除模块残留声明。

最终审计脚本与采样脚本拒绝覆盖已有输出。下一步若评估模型实际使用率，应基于重新加载后的正常生产会话日志，按真实接管来源分类；本轮没有为此发起探测流量。
