# dsh-forge

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](https://nodejs.org)
[![DeepSeek Harness](https://img.shields.io/badge/DSH-Plugin-orange.svg)](https://github.com/deepseek-ai)

**dsh-forge** 是专为 **DSH (DeepSeek Harness)** 打造的高性能检索与施工治理扩展插件。

它将 [fff](https://github.com/dmtrKovalenko/fff)（基于 Rust 开发、SIMD 加速、支持跨会话热度学习的搜索引擎）无缝接入 DSH 工具系统，结合多语言 AST 符号提取能力与工业级容错编辑引擎，为 AI 编程 Agent 提供“找得快、看得准、改得稳”的端到端开发体验。

---

## 核心特性

- ⚡ **极速检索（L0/L1）**：集成 Rust 原生 FFF 检索内核，提供文件名模糊搜索（支持拼写纠错与 frecency 排序）、路径模式匹配与高速文本检索（支持 Aho-Corasick 多词扫描与行符号标注）。
- 🧭 **精准符号定位（L2）**：基于 Tree-sitter WASM 覆盖 11 种主流源码语言的大纲分析、定义查找与跨会话读取，大幅降低阅读整个文件对模型 Token 的消耗。
- 🛠️ **容错编辑引擎（L3）**：提供支持行号漂移校正、首尾行锚定、行内/块模糊匹配的多步编辑能力，写前检测语法合法性，支持歧义票据决议。
- 📜 **快照历史与治理台账**：所有写操作强制关联原因（reason）与执行者（actor），内置内容寻址的增量快照库，支持批次/节点/时间点安全回退，工作区零侵入。
- 🧠 **Agent 任务感知**：内置优化过的系统提示词路由（System Prompt Guidance），引导模型“按开发意图选工具”，实现更自然的工具调用习惯。
- 🪞 **写后即可搜**：工具自己写过的文件（`ffedit` / `ff_file` / 回滚）在 15 秒内以**刚写入的字节**为准作答，压过还没追上来的索引。否则"改完立刻搜"会拿到改动前的旧内容：5.8k 文件实测，新建文件后立刻搜索返回 **0 命中**，覆盖写入后仍在返回已删除的符号。命中来源会在 note 里标明，不会让新答案伪装成索引答案。
- 🗂️ **知识卡片沉淀**：施工台账的跨批次确定性蒸馏（零模型）：`overview`（总量 + reason 分布）、`hotspot`（热点文件）、`timeline`（近 14 天）、`structure`（近期文件的符号骨架）四张缓存卡，锚定台账游标与文件 stat 签名，动过即自动重建；模型润色层（阶段二）压在这组骨架上，骨架即回退。

---

## 架构概览

dsh-forge 采用轻量化分层架构，运行时无需在本地安装 `cargo` 或 `rustc` 编译环境：

| 层次 | 功能职责 | 实现技术 | 核心模块 / 依赖 |
|---|---|---|---|
| **工具接入与治理** | DSH 工具注册、施工台账、会话策略适配 | TypeScript (Node.js) | `src/index.ts`, `src/ledger.ts`, `src/tools-*.ts` |
| **底层全文检索** | 快速路径检索、全文 Grep、跨会话热度模型 | Rust 原生动态库 (FFF) | `@ff-labs/fff-node` + 预编译 `fff_c` 动态链接库 |
| **AST 符号解析** | 11 种语言的符号提取、代码大纲、精确定义定位 | WebAssembly (WASM) | `web-tree-sitter` + `tree-sitter-wasms` |
| **容错编辑引擎** | 漂移校正、快照坐标对齐、歧义票据处理 | 纯 TypeScript 算法 | `src/edit-engine.ts` |

---

## 工具列表 (9 个核心工具)

| 工具名 | 层级 | 功能简介 | 常见使用场景 |
|---|---|---|---|
| `fffind` | L0 发现 | 找文件，两种模式：`mode=name`（默认）文件名模糊搜索，容错拼写，基于匹配分与访问频率综合排序；`mode=glob` 路径 Glob 匹配（npm-glob 语法、gitignore 感知、按页分页），返回纯文件路径列表。两种模式都只返回**文件**。 | 知道大致文件名时用 `mode=name`；批量列举特定目录结构或文件类型时用 `mode=glob`。 |
| `ffgrep` | L1 检索 | 高速文本内容搜索（支持 plain/regex/fuzzy），支持 Aho-Corasick 多字面量批量扫描；开启 `enclosing: true` 可同时返回命中行所在的代码符号。 | 查找关键字、配置名或调用点，支持快速定位外层函数。 |
| `ff_read` | L2 符号 / 寻址 | 统一读取，三种视图：`view=body`（默认）按行区间（`lines=L10-20`）、符号名（`path#Symbol`）、批量路径或 Glob 模式读取正文；`view=outline` 解析单文件 AST，给出类/函数/接口/结构体的定义与起止行区间；`view=definitions` 全局符号定义查找（支持限定名与 Rust `::` 路径），覆盖 11 种语言。均支持按序号消除同名定义歧义。三个视图的参数互不通用：传了别的视图才有的参数会**直接报错并指路**，不再静默忽略。 | 了解新模块架构时优先 `view=outline`（省 Token、无需读全文件）；已知名字时 `view=definitions` 定位定义；再 `view=body` 精确读实现。 |
| `fftrace` | L2 链路 | 静态分析 JS/TS/HTML 模块、IPC、全局、Rust/Python/C/C++/Go/Java/Lua 文件关系；提供影响分析、最短路径，以及源码 FFI 声明和 PE/ELF/WASM 导出元数据。 | `file:路径` 查直接引用，`impact:路径` 查传递影响，`path:源 -> 目标` 解释文件依赖，`exposes:名称` 查 preload 暴露的全局与逐键使用点，`symbol:名称` 查同名符号的全部定义，`ffi:名称` 查原生边界证据。 |
| `ffedit` | L3 施工 | 工业级容错多步行级编辑工具：自动基于快照坐标合并修改、支持 ±20 行锚点漂移校正、自动识别首尾锚点；写前可选语法校验拦截。定位命中多处时**不猜**：写入零字节、签一张票据，用同一工具回传 `{ticket, choice}` 决议。 | 对代码进行精准、安全的单处或多处修改；含歧义决议。 |
| `ff_file` | L3 施工 | 高级文件操作：创建、删除、移动文件，或进行符号级/行块级的代码迁移；支持四种落点锚定并自动校正代码缩进。 | 重构、函数搬移或跨文件模块拆分。 |
| `ffhistory` | L3 治理 | 施工台账与快照差异检索：查询修改记录（谁在何时因何原因改动了哪些文件），支持直接获取不可变快照 diff。 | 审查 Agent 修改历史、排查改动来源。 |
| `ffrollback` | L3 治理 | 安全回滚工具：支持按批次、节点或时间点还原文件状态；回滚操作本身生成新批次，支持二次重做。 | 代码改错或测试失败时一键安全复原。 |
| `ff_cards` | L3 治理 | 知识卡片（沉淀层）：把施工台账确定性蒸馏成四张卡——`overview`（总量与 reason 分布）、`hotspot`（热点文件）、`timeline`（近 14 天）、`structure`（近期文件的符号骨架）。无参数列目录，`card=<name>` 读正文；台账锚或被覆盖文件变动时自动重建。骨架可经 `{polish: "<name>", content: "<润色稿>"}` 升级为可读卡（有限引用校验后缓存，标记模型来源）。 | 新会话快速掌握"这个项目最近在施工什么、改在哪儿"；台账越多越有用。 |

*AST 支持的 11 种语言*：JavaScript、TypeScript（含 TSX/MTS/CTS）、Python（含 PYI）、Rust、Go、C、C++、Java、C#、Lua。

---

## 快速安装与配置

### 1. 安装插件至 DSH (以桌面版为例)

1. 在 DSH 配置文件 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 中添加依赖：
   ```json
   {
     "dependencies": {
       "dsh-forge": "link:<dsh-forge 仓库的本地绝对路径>"
     }
   }
   ```
2. 在该配置文件的 `dsh.profile.bundles` 数组中追加 `"dsh-forge"`：
   ```json
   {
     "dsh": {
       "profile": {
         "bundles": [
           "...",
           "dsh-forge"
         ]
       }
     }
   }
   ```
3. 在配置目录执行依赖安装：
   ```bash
   pnpm -C ~/.dsh/profiles/desktop install
   ```
4. 重启 DeepSeek Harness 即可生效。

### 2. 环境变量配置（可选）

dsh-forge 在常规使用下开箱即用，无需特殊配置。如需调整缓存路径或性能参数，可配置以下环境变量：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_FORGE_DATA_DIR` | `~/.dsh/forge` | 跨会话 frecency 访问统计、查询历史、本地快照与知识卡片缓存的主目录。 |
| `DSH_FORGE_GRAMMAR_DIR` | 随包预装 | Tree-sitter WASM 语法文件目录。 |
| `DSH_FORGE_AST_WORKERS` | 自动，最多 `8` | 符号查询和 Trace 共用 AST Worker 池。默认候选达到 16 个时并行；`0` 强制顺序解析，`1..8` 显式指定 Worker 上限。 |
| `DSH_FORGE_INDEXER` | 自动 | 可选 Rust 符号索引 sidecar：`0`/`off` 关闭，其余取值在可用时尝试原生解析；启动或读取失败会回退 WASM。Trace 使用 WASM Worker，不依赖此二进制。 |
| `DSH_FORGE_INDEXER_BIN` | 未配置 | 指向可信的本机 sidecar 二进制；源码 checkout 也会发现 `rust_indexer/bin`。npm 包不捆绑平台二进制，默认使用 WASM。 |

可选原生符号加速：在源码 checkout 中安装 Rust 1.88+ 后执行 `pnpm run build:indexer`，会为当前平台构建并放入 `rust_indexer/bin`。npm 安装用户可将 `DSH_FORGE_INDEXER_BIN` 指向这份构建产物的绝对路径；没有该产物仍可使用全部工具。

Trace 首次扫描使用并行事实提取；全仓别名只做内存筛选，不再触发二次解析。同一工作区的重叠请求共享扫描，后续请求按文件 stat/ctime、声明表及被探测依赖的存在性验证缓存。文件新增、修改、删除或声明表变化会失效。输出的 `parseErrors`、`partialFiles`、`walkErrors`、`resolutionLimited` 与 `incomplete` 表示分析覆盖度；出现失败、部分解析、截断时，“未找到”只针对已分析范围。根 `.gitignore` 生效，跳过 `node_modules` / `.git` / `.dsh` 和目录链接；候选上限 20,000，源码上限 2 MiB，二进制上限 32 MiB。

Trace 新增语言的支持范围如下，查询形式为 `file:src/lib.rs`、`file:pkg/service.py`、`file:native/main.cpp`。被引用的 `.txt`、`.inc` 等资源也可反查引用者，内容不参与解析。

| 语言 | 静态文件依赖 | 解析边界 |
|---|---|---|
| JS / TS | 相对 import/require、HTML script；无顶层 import/export 的脚本中，精确名称 `declare module "name"` 可作为裸模块声明目标 | 不模拟包管理器、通配 ambient module 或模块增强合并；重复声明不任意选文件。 |
| Rust | `mod`、内联模块作用域、直接 `#[path]`、字面量 `include!` / `include_str!` / `include_bytes!`，以及分组、别名、`crate/self/super` 形式的 `use` 模块候选 | 按常见 Cargo 入口和真实 `mod` 树确定归属；不展开宏、条件编译、重导出或 `extern crate`。模块归属工作预算 20,000、深度 64；达到预算停止 `use` 推断，标记 `resolutionLimited` 和 `incomplete`。 |
| Python / PYI | 工作区根下的 import/from；字面量 `__import__`、已确认 importlib / import_module 别名及字面量 package 相对导入 | 不执行 Python 或推断 sys.path；动态表达式保持未解析。发现 loader 名称绑定或遮蔽时保守停止该名称的动态推断。`from` 子模块保留候选标记。 |
| C / C++ | 本地 include 与显式编译目录；C++20 顶层命名模块、同模块分区和头文件单元的候选依赖 | 不推断编译器隐式目录或 BMI 构建映射、不展开宏/条件编译/响应文件。模块提供者重复时拒绝选取；部分模块语法仍保留上游 grammar 的 partial 标记。头文件不继承未证实的编译单元配置。 |
| Go | 最近 go.mod 的 module 名称和工作区内包成员；附着在独立 `import "C"` 前的 cgo 导言字面量本地 include 候选 | 不计算 build tag、GOOS/GOARCH、go.work、replace/vendor 或 cgo CFLAGS；嵌套 go.mod（包括无效清单）隔离模块边界。尾随代码的注释不作为导言。 |
| Java | package/类型索引解析 import、直接嵌套类型、继承/接口、泛型边界、字段/参数/返回/throws 类型候选；module-info 的 requires/exports/opens/services 候选 | 不解析 classpath/JAR、模块路径或完整类型/访问控制。泛型和局部/匿名类型遮蔽会排除误匹配；可能的继承成员或未知父类阻止简单名回退。继承检查预算 20,000、深度 64，触发后报告 resolutionLimited/incomplete。 |
| Lua | 字面量 require，按根下 `name.lua` / `name/init.lua` 约定查找候选 | 不执行 package.path、自定义搜索器或动态参数；require / `_G.require` 重绑定时停止推断。Lua 使用维护中的独立 WASM 语法包，避免旧 grammar 的跨文件状态串扰。 |

这些关系表示源码中的文件引用，不提供函数调用图、类型推断或运行时依赖保证。增加语言会扩大默认扫描集合，首次查询耗时也取决于新增文件数量。

JS/TS 还会只读发现根内的 `tsconfig.json` / `jsconfig.json`、相对 `extends`、`references` 指向的配置及 `package.json`。支持 JSONC、`paths` 精确/单星号映射及顺序目标回退、`baseUrl`、多份继承、根成员 `files/include/exclude`（`*` / `**` / `?`），路径相对声明配置定位。工程映射的文件边保留来源配置。尚未展开完整 TypeScript program 导入闭包；成员归属不明或多配置歧义时停止裸包名回退并报告限制。包名形式的 `extends`、`rootDirs`、`moduleSuffixes`、自定义条件及 bundler alias 保持未解析，不执行配置代码。

根 `package.json` 的 npm/yarn `workspaces` 和 `pnpm-workspace.yaml` 字面量 `packages` 列表用于识别本地包，支持正向/排除模式、包自身引用、`exports/imports` 精确及单星号入口、`main`/`types` 和入口转发。同名包拒绝猜测，包外依赖不读 `node_modules`。此处确定边基于已识别的本地 workspace 映射，不证明安装器实际选择了哪个同名包版本。条件导出保留可用分支作为候选；CTS/MTS、显式 module、NodeNext 与 package type 帮助选择 import/require 分支，未知 TS 编译上下文保留两者候选。缺失条件产物单独报告；包映射数组、复杂 YAML、安装器链接覆盖和完整 bundler/Node loader 语义不在支持范围。单个工程元数据上限 256 KiB，总上限 2,000 文件 / 8 MiB；元数据内容和相关路径链接身份变化使图缓存失效。

`impact:` 沿反向文件依赖递归查找引用者，给出距离、受影响的 HTML 页面和引用行号；`path:` 沿正向文件依赖及 HTML script 引用查找一条最短路径。例如：

```json
{"target":"impact:src/lib.rs"}
{"target":"path:app/index.html -> renderer/helper.js"}
{"target":"path:src/main.ts -> src/service.ts","edgeMode":"certain"}
{"target":"file:native/main.cpp","compileCommands":"build/compile_commands.json"}
{"target":"ffi:shared_export"}
```

路径查询的箭头两侧需留空格；支持根内绝对路径和相对路径。`file:/impact:/path:` 接受 `edgeMode: "all" | "certain"`，默认包含候选边，certain 排除它们；确定仅表示静态文件引用可解析，不保证运行时执行。`analysis` 返回 `edgeMode`、引用边的 `from/to/line/kind/evidence`、文件距离、页面及计数；`evidence` 包含 `confidence/basis/config?`。ambient 声明、条件导出及多语言候选保留候选身份。单次查询最多索引 200,000 条边、遍历 20,000 个节点，结构化文件/边/页面列表各最多 100 项，文本各展示前 30 项。`analysis.complete` 表示所选图的遍历是否完成，`analysis.truncated` 也包含展示截断；它们与扫描覆盖度 `incomplete` 分开，达到遍历上限时不会据“未找到”断言不可达。

`diagnostics` 提供未解析项的 `path/line/spec/reason/detail?/config?`，以及文件读取、部分解析、工程配置问题；两类列表各最多 100 项，分别保留总数与截断标记。`file:` 的未解析列表限定当前文件，文件/工程问题仍报告全扫描范围。JS/TS 区分非字面量、缺失目标、外部包、歧义、配置限制和根外目标；其他语言无法细分的失败诚实使用 `unsupported_resolution`，不会把未知原因伪装为缺失文件。`incomplete` 包含已知的配置/归属限制，不能用 `analysis.complete` 代替完整工程覆盖度。

包含 C/C++ 文件时自动读取根下的 `compile_commands.json`；其他位置通过 `compileCommands` 指定。文件上限为 8 MiB、20,000 条记录，优先读取 `arguments`，也接受当前平台常见引号形式的 `command`。只把 JSON 当作数据，不运行编译器或 shell；带响应文件、sysroot、未知预处理转发、`env` 启动器或显式 include 环境变量赋值（如 `CPATH`、`INCLUDE`、`SDKROOT`）的记录保持未解析，`compilation` 会报告不支持的记录数。解析只依据显式搜索路径，不模拟完整预处理环境。数据库内容变化及搜索目标的存在性、目录链接身份变化均使图缓存失效。

`ffi:<name>` 按精确名称分别列出源码边界声明和二进制导出，不会把同名拼成跨语言调用链。源码支持 Rust no_mangle/export_name/link_name、extern 块，C/C++ extern C / dllexport、Node/N-API 常见注册宏和紧邻函数的 cgo `//export`。标记只证明源码声明，无法证明链接保留、符号修饰或 ABI 一致；上游 Rust grammar 尚不识别部分 `unsafe extern` 新语法，会报告部分解析。复杂宏与函数指针声明不做完整语义推断。

二进制按魔数读取 `.exe/.dll/.node/.so/.elf/.wasm` 的 PE/ELF/WebAssembly 元数据，绝不加载或实例化。PE 支持 ordinal/forwarder，ELF 仅动态符号表作为导出证据，WASM 支持导入库和导出名；`file:` 可查看依赖库及限制说明。未覆盖 Mach-O、archive、导入函数符号、PE delay-load、无 section header 的 ELF 动态表和 WASM memory64；不做反汇编、完整二进制有效性验证或源码产物对应验证。每文件符号上限 20,000，FFI 结构化匹配最多 100 条、文本最多 30 条。

### 3. 插件设置：接管原生 / 增量并存

工具面有两种挂法，写在用户 patch 层即可（升级不丢）：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: dsh-forge
  name: dsh-forge
  config:
    registration: takeover   # 默认 additive
    takeover: [read, glob, grep]   # 可省略；省略即取全部可接管项
```

| `registration` | 结果 |
|---|---|
| `additive`（默认） | 9 个工具全部以 `ff*` 名挂在全局，与内置 `read`/`grep`/`glob`/`edit` 并存。 |
| `takeover` | 列出的名字改成**每个 agent 作用域**注册（`agent.ctx`），遮蔽同名内置工具；其余工具仍走全局。模型看到的是一件事一个工具，而不是两个。 |

目前可接管：`read`、`glob`、`grep`。

`read` 的 `file_path` / `offset` / `limit` 与 `path` / `lines` 两套参数都接受（`limit` 的含义由寻址方式决定：`file_path` 寻址按行数，`path` 寻址按文件数），越界时会给出 `continue with offset=<n>`。

`glob` 的内置契约只有 `{pattern, path}`、返回路径列表（无分页、无 limit），接管后原样接受。**剩下的差别是作用域，不是语法**，且写在工具描述里：内置 glob 走 `ripgrep --files --no-ignore --hidden`（磁盘上有什么），本索引尊重 `.gitignore` 且不含 `node_modules`（仓库里有什么）。两种都是"哪些文件匹配"的合理答案，所以这是接管而不是改名——调用方看得见自己拿到的是哪一种。

改完重启后，`/forge-status` 的第一行就是**当前进程实际生效的注册模式**。补丁层没被应用和从来没写过，在配置文件上长得完全一样，只有进程自己说得清。

`grep` 的内置契约是 `{pattern, path, include}`，`pattern` 按 ripgrep 正则、**大小写敏感**解释。接管后原样接受这三个参数（`mode` 固定 `regex`、`smartCase: false`，其余不额外开放），`include` 按 ripgrep 的 glob 语义编译：无分隔符的 `*.ts` 匹配任意深度的文件名，大小写跟随文件系统；`!` 取反与逗号列表按内置的做法直接拒绝。

真正让 `grep` 能安全接管的是**逐调用回退**（`src/delegate.ts`）：索引答不上来时，这一次调用原样交给内置 grep，用内置自己的参数、自己的执行上下文。触发条件有四条，每一条都对应一种索引可能给错的场景——

| 触发 | 为什么索引不可信 |
|---|---|
| 扫描尚未完成 | 半成品页是样本，不是答案 |
| finder 起不来 | 这个根根本没有索引 |
| 一页零命中 | 索引是快照，别的进程刚写的文件它看不见 |
| `path` 里带 glob | 内置会把它当路径报错，那才是同一条调用的答案 |

零命中那条最关键：**"0 命中"是调用方唯一会据以放弃的答案**。回退后会出现三种结果，各自说清是谁回答的——磁盘命中了（`come from ripgrep on disk`）、磁盘也没有（`no match in the index and none on disk`）、磁盘检查本身失败（把失败原因写进 note，并保留索引自己的答案）。回退拿不到句柄时一切照旧走索引，所以它只是改进，不是依赖。

`/forge-status` 在接管 `grep` 时会多一行 `内置委托：可用 / 不可用`：能否拿到内置句柄取决于宿主把 fs 工具注册在哪一层，配置上看不出来，只有进程自己知道——不可用时 `grep` 仍按内置语义工作，只是空结果不再被磁盘复核。

实测（一个 2 667 文件的真实 Electron 仓库，索引已就绪）与内置 `rg --json --regexp=…` 逐条比对：

| 查询 | 索引 | 内置 ripgrep | 接管后 | 命中集差异 |
|---|---|---|---|---|
| `browserWindow`（10 命中） | 958 ms | 1 022 ms | 855 ms | 0 / 0 |
| 不存在的 token | 418 ms | 1 136 ms | 1 137 ms（含磁盘复核） | 0 / 0 |
| 大小写不符 `Browserwindow` | 471 ms / 0 命中 | 1 018 ms / 0 命中 | 993 ms / 0 命中 | 0 / 0 |
| `require`（宽泛） | 37 ms | 1 028 ms | 25 ms | 索引 ⊆ 磁盘 |
| `ipc[A-Z]\w+`（正则） | 38 ms | 999 ms | 27 ms | 索引 ⊆ 磁盘 |
| `include: *.md` | 460 ms / 132 | 240 ms / 89 | 521 ms / 132 | 索引多 43 条，全在隐藏点目录下 |

两处差异都是作用域，不是语义：命中多出来的 43 条全部落在点目录里——`rg` 默认跳过隐藏路径，索引不跳。这一条写在工具描述里。零命中那一行的代价是诚实的：**接管的"没有"要花内置的钱**（约 1.1 s），换来的是这个"没有"同时被磁盘确认过。

`edit` 仍不支持接管，而且回退也救不了它：内置在 `replace_all: false` 时要求 `old_string` **唯一出现**，歧义就报错；`ffedit` 的锚定/模糊引擎遇到多匹配会按规则挑一个。等到歧义出现时，内置手上也只剩一句报错——把那句报错塞给模型，比让它看见"该确认哪一处"更糟。所以 `edit` 保留自己的名字和自己的语义。

同一条 `config` 里还有 `prewarm`（默认 `true`）：agent 出现后约 1.5 s，在后台把该工作区的索引建到**完全就绪**，而不是等第一次查询再建。5 千文件实测，第一次真实查询从 2.9 s（冷启动）／约 2.0 s（索引已落盘，但实际只等到了扫描）降到 4 ms。代价是一次原生扫描会阻塞 JS 线程约 0.5 s（同规模实测 p99 531 ms），所以它延迟启动、不 await、`unref()` 不拖住进程，并且全程 best-effort——失败不抛，只在查询真正需要时由工具层报出。纯聊天、不需要检索或不愿有启动 IO 抖动的 profile 可以关掉：

```yaml
- id: dsh-forge
  name: dsh-forge
  config:
    prewarm: false
```

### 4. 插件设置页：知识卡片蒸馏

以上全部配置共同构成 DSH 插件管理器里 dsh-forge 的设置页（Config schema 即设置界面）。知识卡片（`ff_cards`）的蒸馏行为由 `cards` 块控制：

```yaml
- id: dsh-forge
  name: dsh-forge
  config:
    cards:
      distill: session   # session（默认）| endpoint | off
      endpoint:          # 仅 distill: endpoint 时需要
        baseUrl: https://api.example.com/v1
        model: your-model
        apiKeyEnv: OPENAI_API_KEY   # 或用 apiKey 内联（不推荐，会写进配置文件）
        timeoutMs: 120000
```

| `distill` | 行为 |
|---|---|
| `session`（默认） | **当前会话模型润色**。读骨架卡时附带蒸馏指令；模型用 `{polish: "<name>", content: "<润色稿>"}` 写回，经有限引用校验后缓存。消耗会话 token，无额外后台调用。 |
| `endpoint` | 读到未润色骨架时内联 POST `{baseUrl}/chat/completions`，经同一引用校验缓存；失败回退骨架并说明原因。只在按需读取时发生，无后台定时器。 |
| `off` | 拒绝 polish 写入与模型调用，仍可读取已有草稿。 |

引用校验只核对反引号中的路径、`#N` 的实际批次身份及格式/大小，无法核实裸路径、数量、日期或自然语言事实。润色返回 `source: "model"` 并明确提示事实未经核验；`{card: "overview", skeleton: true}` 始终返回 `source: "ledger"` 的确定性来源，即使 endpoint 模式也不发请求。卡片来自本插件施工台账，不代表完整项目知识。

润色稿是**缓存不是资产**：以台账锚（批次游标 + 文件 stat 签名）为有效性凭据，锚一动即整体丢弃——没有人工编辑保护，下次蒸馏从新事实重新开始。`refresh: true` 也会丢掉全部润色稿。

**反馈闭环**：卡正文每次被读取都计入 `reads.json`——刻意与卡片重建分离，重建、丢弃润色稿都不清零（用量是读者侧的历史，不是台账的派生物）。两个消费者：`ff_cards` 无参数列表带每卡读取次数、蒸馏建议点名**最常读的未润色卡**；`/forge-status` 新增知识卡片行（锚新鲜度、润色 k/N、各卡读取次数），只读不重建——过期只报告，修理是 `ff_cards` 的职责。

---

## 架构设计与技术细节

更多有关系统提示词设计（为什么采用“任务导向”而非“能力罗列”）、容错编辑算法细节、外部修改检测纪律以及 Token 开销控制，请参阅专门的设计文档：

👉 **[查看详细架构与设计思考 (docs/DESIGN.md)](docs/DESIGN.md)**

---

## 已知边界与使用说明

1. **快照库存储**：修改快照统一存放在 `~/.dsh/forge/snapshots/`，不污染被操作的目标项目，即使用户仓库没有初始化 Git，也享有完整的快照与版本回滚能力。知识卡片缓存在 `~/.dsh/forge/cards/`，同为插件私有数据：整体可删，下次 `ff_cards` 调用即按台账重建；卡片是生成物，不做人工编辑保护（定位为缓存）。
2. **目录与文件搜索差异**：`fffind` 的两种模式（`mode=name` / `mode=glob`）都只返回**文件**路径，不直接返回目录节点；若需遍历目录，请使用 `dir/**` 模式（`mode=glob`）或将 `path` 参数显式指向对应目录。
3. **大文件防护**：AST 符号解析层对单文件设置了 **2MiB** 大小防护上限，超限文件会自动降级并提示使用 `ffgrep` 文本检索，避免极端文件导致内存耗尽。
4. **单文件行数上限**：`ff_read` 单次整文件读取上限为 4000 行，超过上限需通过行区间（`lines=L1-2000`）分段读取。
5. **单文件命中上限**：`ffgrep` 对单个文件最多收集 2000 行命中（`GREP_MAX_MATCHES_PER_FILE`）。这是引擎侧的硬截断：它在一个文件内停住后直接跳到下一个文件，`nextCursor` 不会回到该文件，所以更靠后的命中翻页也拿不到。一旦触顶，返回结果会带一条 note 指明是哪个文件，此时应改用更窄的模式或直接 `ff_read` 该文件。注意 `limit` 管不住这件事——引擎按**整个文件**收集完才看 `pageSize`，所以 `limit=5` 也可能返回几百行。
6. **空页面的两种解释**：空结果会区分"索引看不见"和"被 `path=` 约束滤掉"。后者不会再给出"磁盘上有、区分大小写"这类诊断，而是直接说命中有多少落在约束之外——因为前者的根因是索引可见性，后者的根因是约束写窄了。

---

## 本地开发与测试

本项目采用标准 TypeScript + Node.js 环境开发：

```bash
# 类型检查与构建
pnpm run check

# 执行完整集成测试套件
pnpm test

# 执行检索与 AST 性能测试
pnpm run bench
```

本地深度集成测试可通过复制 `.env.example` 为 `.env` 并配置 `DSH_FORGE_DSH_MODULES` 等路径以接入真实的宿主环境。

---

## 开源协议

本项目采用 [MIT 许可证](LICENSE)。

感谢上游开源项目：
- [fff](https://github.com/dmtrKovalenko/fff) (Rust 检索内核与算法实现)
- [web-tree-sitter](https://github.com/tree-sitter/tree-sitter) & [tree-sitter-wasms](https://github.com/samuel/tree-sitter-wasms) (WASM 语法解析能力)
