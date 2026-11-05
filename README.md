# dsh-forge

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](https://nodejs.org)
[![DeepSeek Harness](https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.2-orange.svg)](https://github.com/deepseek-ai)

为 **DSH（DeepSeek Harness）** 打造的检索与施工治理插件：把 [fff](https://github.com/dmtrKovalenko/fff) 的 Rust 检索引擎接进工具系统，配上多语言 AST 符号定位和一套带台账、快照、回滚的容错编辑引擎。

装好之后，AI Agent 找文件、读符号、改代码都走同一套带治理的工具，而不是各自去 `ls`、`cat`、`sed`。

> **状态** `v0.2.0` · 尚未发布到 npm，按[源码安装](#安装) · MIT · 需要 Node `^22.19 || >=24` 与 DSH `>=0.2.0-rc.2`

## 目录

- [架构](#架构)
- [工具面](#工具面)
- [安装](#安装)
- [配置](#配置)
- [已知边界](#已知边界)
- [本地开发](#本地开发)

---

## 架构

运行时不需要 `cargo` 或 `rustc`：检索走预编译的 Rust 动态库，符号解析走 WASM。

| 层次 | 职责 | 实现 |
|---|---|---|
| 工具接入与治理 | 工具注册、施工台账、会话策略适配 | TypeScript，`src/index.ts` / `src/ledger.ts` / `src/tools-*.ts` |
| 全文检索 | 模糊查找、全文 Grep、跨会话热度模型 | `@ff-labs/fff-node` + 预编译 `fff_c` |
| 符号解析 | 11 种语言的符号提取、大纲、精确定义 | `web-tree-sitter` + `tree-sitter-wasms` |
| 编辑引擎 | 漂移校正、快照坐标对齐、歧义票据 | 纯 TypeScript，`src/edit-engine.ts` |

可选的原生索引 sidecar（`rust_indexer/`）会接管扫描、事实提取和图缓存校验。不装也能用全部工具，只是符号与 Trace 查询会退回 WASM 路径。

---

## 工具面

| 工具名 | 层级 | 功能 | 典型用法 |
|---|---|---|---|
| `ff_find` | 检索 | 模糊查找文件名和路径，容错拼写。路径模式交给内置 `glob`。 | 记得大概文件名或拼写不确定时使用。 |
| `ff_grep` | 检索 | 模糊内容搜索，或一次查询多个字面量。普通文本和正则交给内置 `grep`。 | 搜索调用点、配置名和不确定的文本。 |
| `ff_symbols` | 检索 | `view=outline` 列出单文件定义；`view=definitions` 跨文件查找精确符号定义。正文交给内置 `read`。 | 已知符号用 `read file_path=<file>#<Symbol>`。 |
| `ff_trace` | 完整 | 静态依赖、影响、IPC、暴露关系和 FFI 证据。 | 定义查询交给 `ff_symbols`，不接受 `symbol:`。 |
| `ff_edit` | 完整 | 带快照和审计的文本或精确符号编辑，可追加 `verify`。 | 符号参数用 `sourceSymbol` / `includeLeadingComment`。 |
| `ff_file` | 完整 | 创建、删除、移动文件或复制/移动代码。 | 不再承载 `edit_symbol`；符号编辑归 `ff_edit`。 |
| `ff_history` | 完整 | 查询施工台账与不可变 diff、验证记录。 | 列表路径子串用 `pathContains`。 |
| `ff_rollback` | 完整 | 预览并恢复已记录批次。 | 正整数 `batch`、`latest:true`、`throughBatch` 三选一；当前过滤仍叫 `path`。 |
| `ff_verify` | 完整 | 独立静态验证，不制造编辑批次。 | 既有 `batch` 或单文件 `path` 二选一。 |
| `ff_project` | 完整 | 私有工程、任务、批次关联与报告快照。 | 工具返回 `{ok, action, payload, error?}`，不是 HTTP 信封。 |

只注册新公开名，没有运行时旧名 alias。旧名映射仅供文档迁移与离线 normalize。`retrieval` 共 3 个，`full` 共 10 个；详细互斥参数与迁移示例见[接口迁移说明](docs/forge-interface-migration-2026-11-01.md)。

AST 支持 11 种语言：JavaScript、TypeScript（含 TSX/MTS/CTS）、Python（含 PYI）、Rust、Go、C、C++、Java、C#、Lua。

后续规划见[能力补齐与工具闭环路线图](docs/forge-capability-roadmap-2026-10-28.md)与[实施手册](docs/forge-plan-m0-m1.md)。M0/M1 的主要实现已进入当前源码；真实 DSH 集成验收仍待在具备宿主模块的环境执行，M2 及之后仍在规划中。状态不代表已发布版本。

---

## 安装

### 前置要求

- Node `^22.19 || >=24`
- 已安装的 DSH，版本 `>=0.2.0-rc.2 <0.3.0`
- pnpm

插件尚未发布到 npm，从源码 checkout 安装：

### 步骤

1. 克隆并安装依赖（`prepare` 会自动构建 `lib/`）：

   ```bash
   git clone https://github.com/Asaiuta/dsh-forge.git
   cd dsh-forge
   pnpm install
   ```

2. 让 DSH profile 依赖这个目录 —— 编辑 `~/.dsh/profiles/desktop/package.json`：

   ```json
   {
     "dependencies": {
       "dsh-forge": "link:<dsh-forge 的本地绝对路径>"
     }
   }
   ```

3. 在同文件的 `dsh.profile.bundles` 里登记：

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": ["...", "dsh-forge"]
       }
     }
   }
   ```

4. 安装并重启：

   ```bash
   pnpm -C ~/.dsh/profiles/desktop install
   ```

重启后 `/forge-status` 可查看当前生效状态。

---

## 配置

开箱即用，以下全部可选。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_FORGE_DATA_DIR` | `~/.dsh/forge` | frecency 统计、查询历史、快照、验证与工程私有数据的主目录；不再使用卡片缓存。 |
| `DSH_FORGE_GRAMMAR_DIR` | 随包预装 | Tree-sitter WASM 语法目录。 |
| `DSH_FORGE_AST_WORKERS` | 自动，≤ `8` | 符号与 Trace 共用的 Worker 池。`0` 强制顺序，`1..8` 指定上限。 |
| `DSH_FORGE_INDEXER` | 自动 | 原生 sidecar 开关，`0` / `off` 关闭。启动或读取失败自动回退 WASM。 |
| `DSH_FORGE_INDEXER_BIN` | 未配置 | 指向本机的 sidecar 二进制；源码 checkout 也会发现 `rust_indexer/bin`。npm 包不捆绑平台二进制。 |
| `DSH_FORGE_SEARCH_NATIVE` | 自动 | 原生 `glob` / `grep` 开关，`0` / `false` / `off` 时交回宿主内置工具。 |
| `DSH_FORGE_TRACE_NATIVE` | 自动 | sidecar 可用时用原生提取源码事实，`0` / `off` 保持 WASM。 |
| `FORGE_GLOBAL_INDEX` | `auto` | 字面名机器索引后端（旧文档称 `mode=name`，当前公开参数不接受 mode）。`auto`：Windows 上找到 `es.exe` 就用，其余情况静默走 fff。`everything`：强制启用，不可用时在结果里说明原因。`off`：关闭。 |
| `FORGE_ES_PATH` | 自动发现 | `es.exe` 路径；不配则依次查 `PATH` 与 `Program Files\Everything`。 |
| `FORGE_CONTENT_INDEX` | 关 | `1` 恢复 fff 的 mmap 缓存与内容索引。仅当进程只开一个索引根时使用——开着它再建第二个索引会让后续索引永久停在扫描中（引擎 0.11.0 缺陷）。 |

原生加速是可选的：源码 checkout 里装 Rust 1.88+ 后执行 `pnpm run build:indexer`，产物进 `rust_indexer/bin`。启用后 Trace 冷启动不再加载 WASM 语法，峰值内存约降一个数量级。

### 工具面配置

默认只注册检索工具。需要编辑、台账、文件操作和 Trace 时，在用户 patch 层切换完整 surface：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: dsh-forge
  name: dsh-forge
  config:
    surface: full                   # 默认 retrieval
```

| `surface` | 结果 |
|---|---|
| `retrieval`（默认） | 注册 `ff_find`、`ff_grep`、`ff_symbols`，共 3 个。 |
| `full` | 注册上述 3 个及 `ff_trace`、`ff_edit`、`ff_file`、`ff_history`、`ff_rollback`、`ff_verify`、`ff_project`，共 10 个。 |

**内置增强始终启用。** 内置的 `read`/`grep`/`glob` 保留原 schema、提示词、超时和输出契约；forge 在环绕分发点让 `read` 支持 `file#Symbol`，并为 `glob` / `grep` 提供常驻 Rust 搜索后端。结果不在原生层预截断；宿主仍负责展示上限、截断标志和完整结果文件。旧 sidecar 没有完整性标记、完整序列化结果超过 20 MB、后端不可用或参数超出契约时直接交回内置。

| 内置 | forge 做什么 | 答案与内置的关系 | 实测 |
|---|---|---|---|
| `glob` | 常驻 Rust 并行遍历和 globset 匹配，按修改时间与路径组件排序，返回完整列表 | 值、渲染文本、截断与完整结果文件保持内置契约；语义不确定时交回内置 | 必须先验证完整结果等价，再比较冷/热耗时 |
| `grep` | 常驻 Rust regex/searcher 并行搜索；直接调用出现超过 2000 字节的命中行时交回宿主预览，不改写 canonical value | 路径、行号、完整命中行与完整结果文件保留；程序化调用（PTC）同样拿完整行 | `pnpm bench:takeover` 的摘录统计只测离线潜力，不代表已部署节省 |
| `read` | `file_path=<文件>#<符号>`（如 `src/store.ts#Store.save`）返回该定义的行窗口，形状、行号、信封与普通 read 相同，并发出 `fs/observed`（之后可直接用内置 `edit`） | 只占内置原本会报「not found」的输入空间；真有名为 `a#b` 的文件时照常由内置读 | 读一个函数不必整读文件：`src/tools.ts` 整读 70 KB（内置要分两次），单个定义约 6 KB |

`grep` 不复用代码索引：内容检索需要逐行正则、BOM 和二进制规则，索引无法直接复现这些语义。常驻 Rust 后端复用同一套 regex/searcher 规则并并行遍历，避免每次启动外部进程；无法证明结果契约时交回内置。

`/forge-status` 会逐个列出被增强的内置工具：forge 作答了几次、交回内置几次及原因，以及 Rust 原生搜索是否开启。

`ff_grep` 与 `ff_find` 的 specialist schema 只保留内置检索 schema 无法表达的能力：模糊内容、多字面量 OR 和模糊文件名。普通 grep、正则 grep、路径 glob 直接使用内置工具。

### 浏览声明与完整符号

已知目标时直接 `read { file_path: "src/store.ts#Store.save" }`。需要浏览结构时，`ff_symbols { view: "outline", path: "src/store.ts" }` 默认展示顶层声明及类、接口、对象等容器成员，停止展开函数和方法内部符号；默认深度没有改成 1，因此类方法仍可发现。

默认输出已从全符号列表改为分页的声明视图。需要旧视图的全部符号时传 `scope: "all"`；显式 `kind`（如 `"field"`）默认在完整树中筛选，也可以同时传 `scope: "declarations"` 保持声明边界。`depth` 独立控制层级，范围 1–20。

每页最多 `limit` 条，默认 50、最大 200，8 KiB 序列化条目预算可能让页更短；结果外层检查为 12 KiB。`page` 返回实际筛选条件、`available`（完整提取数）、`total`（筛选后总数）、`returned`、零起点 `offset`、`complete` 和续页 `nextCursor`。继续用同一 path/scope/depth/kind，传 `cursor: nextCursor`，limit 保持一致或省略。原生回执也注明筛选条件和未完成状态；完整性只指当前筛选结果，解析错误另有明确说明。

游标绑定文件地址、筛选条件及解析用的规范化源码 SHA-256，30 分钟有效，每个工具实例保留最多 128 个续页位置。文件内容变化（即使大小/mtime 不变）、参数不匹配、过期或淘汰会要求重新查询。完整限定名与行号不会截短；单个符号行超预算会报出源行范围，可用内置 read 读取该范围。符号原始树、精确 definitions 搜索和源码读取不受默认浏览筛选影响。

`limit` 现在也用于 outline，之前依赖一次返回完整数组的调用需要遍历 `page.nextCursor`；definitions 的 limit 仍是结果上限，没有新增续页。`node --experimental-transform-types tests/run-outline-output.mjs` 覆盖结构保留、分页、符号身份、源码变更、参数校验及多语言成员。首屏与全部续页的实测成本见 `scripts/measure-prompt-surface.mjs` 的离线计量，不随仓库分发本机证据目录。

### 编辑后核验与历史补丁

需要模型核验修改时，给 `ff_edit` 加 `receipt: "diff"`，一次返回提交结果与本批次的历史补丁；默认 `summary` 仍返回短成功说明。票据消歧也可传 `{ ticket, choice, receipt: "diff" }`。diff 模式省去普通成功步骤的重复坐标，保留审计、警告及漂移/缩进/符号等特殊信息；结构化结果保留步骤报告。

`ff_history { batch: 12 }` 或 `{ node: "b12:n0" }` 返回对应不可变快照的局部 diff，默认前后 3 行上下文，重叠上下文合并。输出包含节点地址、完整前后哈希、文件及旧/新行号，当前文件后续变化不改写历史补丁。相同差异操作用于工具和 UI，UI 保持自身的行对齐与折叠展示。

普通 diff 按完整变更块分页，`page.nextCursor`（编辑回执为 `diff.nextCursor`）通过相同 batch/node 与 detail 传给 `ff_history` 续读。页内每个文件有自己的 `---/+++` 文件头；拼接同一文件的后续块时只保留一次文件头。`complete` 表示已到选择范围末尾且没有省略块，单个文件本页只包含部分差异时有 `truncated` 标记。

超大块或超过 2,000 字符的行不会伪装成完整补丁：结果明确列出当前页的 `omittedNodes`。改用 `ff_history { node: "b12:n0", detail: "patch" }`，按 UTF-16 `offset` 顺序拼接 `items[0].diffs[0].diff`，直到 `page.complete` 后才应用；片段可能在任意字符边界结束，但不会切断 Unicode 代理对。普通页最多 100 个差异单元，8 KiB 内容预算，单项最多 8 KiB；历史 diff 整个工具值检查 12 KiB。先前页有遗漏时，即使已无续页，最终页也不会标记完整。

游标绑定工作区、选择器、模式和节点快照，30 分钟有效，最多缓存 128 个位置；不匹配、过期或快照改变明确报错。行对齐超出工作预算时标记 `coarse`，完整 patch 仍可取回。有效 UTF-8 文本保留 CRLF、BOM 与 EOF 换行，二进制内容明确标记 `binary`，不提供可应用的文本补丁。

`node --experimental-transform-types tests/run-history-diff.mjs` 使用独立 `git -c core.autocrlf=false apply` 验证还原，并覆盖分页、长行、票据回执、跨文件与游标失效。原生文本、结构化结果与包装层 UI 快照的成本分开计量，不能混用。

### 统一输出预算与完整读取

项目、大纲与 diff 共用 `output-budget.ts`：按序列化 JSON 的 UTF-8 字节限制内容、单项与整页，并分别限制条数；模型 Token 只在离线统一 tokenizer 验收时计算。ID、哈希、符号名和行号保持完整。显示字段缩短会注明；完整记录、补丁或源码通过明确入口读取。超大的身份字段返回可操作的读取提示，不会静默切断。

`ff_history {batch:12, detail:"record"}` 返回批次完整 JSON 分片，拼接 `page.record` 后解析。它可读取被默认 reason 预览省略的正文。`ff_edit receipt:"diff"` 的整个成功回执超过 12 KiB 时，保留提交身份、计数和审计状态，设置 `receiptComplete:false`，并给出 `receiptRef`。用 `ff_history {batch:12, detail:"receipt", receiptRef:"返回的完整哈希"}` 逐页拼接 `page.record` 获取冻结的完整回执。回执内的 diff 若仍是分页结果，继续按节点读取补丁。回执存储随工作区历史一起清除，不受普通源码 blob GC 影响；归档失败会明确说明诊断不可恢复，编辑仍报告已提交。

UI 修改前后全文仅放入 SDK 展示元数据，不再放进工具 `value` 或 PTC 返回类型。展示数据在执行时冻结，回放不读取当前文件；原生和 PTC 调用的文件观察事件仍正常发出。完整性、整对象大小和续查成本以离线计量脚本与各专项测试为准。

提示词离线计量默认按 `full`：`node scripts/dump-injected-prompt.mjs --json`。设 `DSH_FORGE_DSH_MODULES` 为安装版 `@deepseek-ai` 模块目录可使用该版本的 schema 和独立 PTC 渲染器；开发依赖的旧 API 也受测。`--retrieval` 显式切换三工具面。`measure-prompt-surface.mjs`、`measure-three-way.mjs` 和 `audit-descriptions.mjs` 使用同一投影入口与实际 tokenizer，不再把 bytes/4 当作 Token 数。

### 工程工具的按需详情

`ff_project` 的原生文本与程序化结果均使用精简投影：`get` 返回项目身份、revision、任务计数、关联数、报告数和最近报告 ID；任务修改只返回变化任务与计数；提交报告返回报告摘要与证据计数。`links` 是任务与批次的关联数，唯一批次数由 `overview` 返回。完整记录继续保存在私有存储，网页接口维持完整数据契约。

需要更多信息时使用 `get`：

| 参数 | 返回内容 |
|---|---|
| `detail: "tasks"` | 任务预览列表，可用 `taskId` 选择一项。 |
| `detail: "reports"` | 最新在前的报告预览列表，可用 `reportId` 选择一项。 |
| `detail: "record"` | 完整项目，或 `taskId` / `reportId` 指定的完整记录，逐页返回 JSON 文本片段。 |
| `detail: "evidence", reportId` | 报告提交时冻结的批次、快照哈希与验证证据；不是当前状态重新验证。 |

`list` 及任务/报告列表默认每页最多 20 项，`limit` 可设 1–100；8 KiB 内容预算可能让页更短。行列表返回 `total`、`returned`、`complete` 和未完成时的 `nextCursor`。预览里的 `truncated` 列出被缩短的字段，完整正文可从对应 `record` 获取。

续页保留相同查询，传入 `cursor: nextCursor`；`limit` 保持一致或省略。JSON 片段按 `offset`（UTF-16 字符偏移）依次拼接 `text`，到 `complete: true` 后再解析。游标绑定内容摘要，30 分钟过期，每个工具实例保留最多 128 个续页位置；内容改变、过期或被淘汰均明确要求重新查询。即使 Todo 镜像没有增加人工操作 revision，内容变化仍会使相关游标失效。冻结报告的详情可独立于后续项目修改继续读取。

分页 payload 另有 12 KiB 外层检查；这是 UTF-8 字节约束，不是严格 Token 上限。查询长记录的总成本应累计全部续页。`node --experimental-transform-types tests/run-project-output.mjs` 验证规模稳定性、原生与结构化结果一致、长 Unicode 记录还原、游标隔离/失效、冻结证据及无副作用的参数拒绝。

### 设置页

`surface` 可以在界面上切换，不用手写 YAML：

- **设置 → DSH-Forge**：设置面板侧栏里的一行（页面标题同名）。
- **插件 → dsh-forge → 配置**：插件管理页里该组合包自己的配置页，行内摘要写「检索工具与内置工具增强」。

两处是同一个页面，只有一个二选一的 surface 控件。

保存写入的是**当前 profile 的 `cordis.patch.yml`**（`configEditor` 的语义），然后走 Loader 的正常生命周期 —— 这一行会被重载，工具面真的按新配置重新注册，不需要重启应用。

页面只写 `surface`，其它键原样穿过，不会被页面删掉。

页面依赖一条独立行 `dsh-forge-http`（`inject: ['webServer','configEditor']`，路由 `GET/POST /forge-config`）。headless / SDK profile 没有 `webServer`，这一行由 cordis 直接跳过，主插件照常加载，只是没有页面可用。

### 侧栏台账

装了 `dsh-better-sidebar` 时，右侧栏的「+」菜单里多一页**台账**：批次列表（`#id`、时间、kind、reason、文件数、检查徽标），点开一批看逐文件快照 diff。

布局按用户可见的 VCPChat ProjectForge 对齐：计划、施工线、改动文件、详情、Git 五个互斥分页。工程选择只占一条紧凑导航，搜索、创建、跨工作区选择放入“工程管理”折叠区，不再占用大块侧栏。施工线内提供搜索折叠区；点击批次进入详情，返回时回施工线；工程验收报告保留在详情页。

Git 分页首先是一扇门：**进入即切换到 better-sidebar 自带的 Git 页**（`openTab({ type: 'git' })`，那个内置分页的 id 一直叫 `git`）。它已有状态、暂存、提交、推送、分支、提交图和带语法高亮的 diff，本插件不再造第二套。打开前先查 `getTab('git')` 且 `isTabEnabled('git') !== false`；因为 `openTab` 对禁用或缺失的类型是**静默空操作**，所以结果会如实回报，不能假定成功。`getTab` 本身不可用（很老的版本）不算“确定缺失”，此时仍会尝试，否则会被永久困在降级视图。

**跳转必须用 ref 守卫，只跑一次。** `openTab` 内部走 `store.reduce`，是**同步**通知并触发重渲染的；如果把这个动作挂在随渲染重建的回调或未加守卫的 effect 上，就会变成：打开 → 重渲染 → 再打开 → …，直到 React 抛 “Maximum update depth exceeded” 崩溃。因此：(1) `openBuiltinGitTab(sidebar)` 只在 `ctx.inject` 作用域里创建一次，不放进每次渲染都执行的 `component` 工厂里；(2) 组件内用 ref 保证**每次进入只跳一次**，离开再进入才重新允许。两层都做，因为任一层单独依靠对方的引用稳定性都不够。

只有在那扇门打不开时（分页被设置禁用，或这个版本没装），才提供降级的只读视图：分支、上游、领先/落后（`↑n ↓n`）、远程，按“冲突 / 已暂存 / 工作区改动”分组的**目录树**，以及点开后的左侧索引版本 / 右侧工作区原文对照。

改动清单按编辑器惯例呈现：每行一个等宽单字母状态徽标（M/A/D/R/U）用宿主 `--dsw-alias-state-*` 语义色着色；文件名在前、目录路径变暗、行数 `+n −n` 右对齐；分组标题带数量胶囊。目录树把 `src/client/changes/*` 这类平铺列表折成层级，并像编辑器一样压缩单子目录链（无自带文件且只有一个子目录时并成 `src/client/changes` 一行），压缩在分支处或本层有文件处停止；目录行带变更文件数，可展开/收起，默认全展开；排序固定为目录优先、名称大小写不敏感 + 码位兜底，不随运行环境 locale 变化。这里不暂存、不提交、不推送、不丢弃；`POST /forge-git` 直接 405，后端也没有对应路由，误点改不了仓库。Git 历史与施工快照是两套独立记录。不在仓库内、无未提交改动、二进制、超过 1 MiB、该侧版本不存在都会分别说明，不截断冒充完整。

视觉层米用参考实现的结构语言：施工线是左侧细轨 + 圆点的时间线，圆点颜色只表达批次种类（edit 蓝、rollback 橙、external 紫、delete 红、create 绿）；批次与任务是 1px 细边、10px 圆角的卡片；状态用胶囊徽标着色（同组绿/橙/红/紫，明暗背景均可读）；计划页指标改为随容器自动换列的网格。不搬的部分：Electron 标题栏与窗口按钮、`backdrop-filter` 玻璃面板、CodeMirror 编辑器。布局用容器查询而非固定 300px 分栏，因为没有 300px 可占。

按钮、文本输入和分页条采用宿主 `Button` / `Input` / `SegmentedTabs`，任务与报告草稿在切页时保留。台账根容器自身负责纵向滚动，受侧栏高度限制，不依赖外层页面滚动；换分页时回到顶部。

Git 读取经宿主 `subprocess` 能力执行，环境为 `GIT_CONFIG_COUNT=0`、`GIT_TERMINAL_PROMPT=0`、`GIT_OPTIONAL_LOCKS=0`、`LC_MESSAGES=C`，单命令 30s 超时、输出 8 MiB 上限；宿主不提供子进程能力时路由返回 503，不降级到 `node:child_process` 在沙箱外 spawn。命令只包含 `rev-parse / status --porcelain=v2 / diff --numstat / remote / show :path`。路径经规范化后必须留在仓库根内，`.git` 及其 NTFS 别名（`GIT~1`、尾随点/空格、`::$INDEX_ALLOCATION`）一律拒绝。

- 数据就是 `~/.dsh/forge/snapshots/` 里的账本，与 `ff_history` 同源；检查徽标区分历史判定与当前适用性，`passed→stale` 不是当前通过。
- 列表支持 `keyword`、`pathContains`、`actor`、`kind`、`projectId`、`taskId`、精确 `file` 和 `unassigned` 筛选及不透明游标分页；`taskId` 需要 `projectId`，工程与未归属互斥。改变筛选或工程修订必须重新查询，旧游标不能混用。
- `ff_edit` / `ff_file` 可显式传 `projectId` 与可选 `taskId`；归属直接写入同一施工批次，不另写工程关联。非法、已归档工程或任务在写入前拒绝，歧义票据保留并重新校验归属。未传归属保持旧行为；GUI 选择仅影响浏览，不改变工具施工上下文。
- 工程汇总去重统计直接归属与事后关联，任务、文件、贡献者和报告批次可下钻；未归属指既无直接归属也无任何人工关联的批次。

#### 会话 Todo 引用

插件监听宿主最终 `tools/result`，并把每次成功写入折进它所属的**计划**，而不是每条写入新建工程。一次真实会话日志显示：同一轮内 4 次 `todo_write`（完成度 0/1/2/3）写的是同一份三项计划；按写入建工程就会把它拆成 4 个，这正是之前重复的来源。

计划边界用两条规则判定，不做文本相似度：

1. **同一会话同一轮 → 同一计划**。轮次来自 `ctx.on('session/event')` 的 `turn/start`，与宿主自己重置 todos 的边界一致（`dsh-tool-todo` 在 turn 边界把投影置 null）。
2. **跨轮时看标题集合是否嵌套**（`A ⊆ B` 或 `B ⊆ A`）→ 视为增改而沿用；标题完全换掉 → 新建工程。任一侧标题集为空时不做此判定：空集是任何集合的子集，若据此合并会静默并入最新工程并清空其快照。

合并时就地更新已有任务（保住任务 ID，批次关联不会断），新增任务追加；`revision` 只计人工修改，因为计划是代理写下的镜像，每个状态跳变都碰修订会让打开的任务编辑器反复冲突。同一调用重放是幂等的，`todoSource.callIds` 记录全部来源调用，`writes` 记录合并次数。

子会话按自身会话 ID 记录，不通过显示名合并。失败工具、缺失身份或工作区不会写入，捕获失败告警但不改变原工具结果。旧存储记录缺少新字段时视为默认而非损坏。

任务状态从 `pending / in_progress / completed` 映射为 `pending / doing / done`，这是唯一的翻译。工程与计划的**选择只由顶部菜单承担**，页内不再重复一份可选列表。计划页在未选中工程时直接展示本工作区最新一份计划的任务内容（状态圆点 + 标题 + 状态），并提示从菜单选中后可编辑；选中后展示任务编辑、批次关联与贡献者。侧栏重新可见时会自动重读，不必再手动点“刷新工程”。计划页显示原始 Todo 引用快照；工程任务可独立编辑，不回写会话 Todo。原始长文本无损保存于来源快照，工程任务标题最多保留 20000 字符。此阶段仅捕获插件加载后成功的写入，不追溯旧会话，也不清理规则生效前已产生的重复工程（可在工程页归档）；点击“刷新工程”后在工程选择器打开新增计划。会话级指来源身份独立，不是新增访问控制，私有工程索引仍可浏览旧计划。不会据此静默改变 `ff_edit / ff_file` 的显式施工归属。
- `GET /forge-ledger?workspace=<绝对路径>` 读取列表或 `batch` 详情；同一路由 POST 回滚先 `preview`，再携短时、单次 token `confirm`。预览不授予写权限；确认重新检查台账和文件身份，宿主 guard 不可用时拒绝。
- 工程页支持私有工程、任务和批次关联。任务仅 `pending / doing / done / blocked` 四态，`note` 是独立备注；修改（除 create）须带当前 `revision`，冲突重新读后处理。
- 报告 `draft / review / accepted` 是人工工作流；`accepted` 不等于机器验证 `passed`，接受须所有任务（含归档任务）为 done。新报告冻结工程修订、批次、节点、before/after 哈希、验证记录全文与摘要哈希、提交时适用性及提交者；不可读验证证据阻止提交。旧报告不补造证据，删除任务只级联实时关联。
- 完整快照通过 `GET /forge-ledger?workspace=...&node=b1:n0&side=before|after&offset=0&limit=32768` 分页读取（UTF-16 字符偏移，limit 最大 65536），保留 BOM 与原换行，明确区分不存在、二进制、损坏。GUI 双栏按页阅读，不是逐行对齐 diff。
- 单文件恢复使用明确的 `{batch, node, version: 'before'|'after'}`；GUI 仍需预览、一次性确认与漂移复核，不影响其他节点。
- 不装 better-sidebar 就没有侧栏页，设置页和当前工具面照常工作。HTTP 工程接口为 `/forge-projects`，它的响应平铺字段，不套工具的 `action/payload`。

### GUI 加载与验收边界

源码修改不会自动更新正在运行的 GUI：需先 `pnpm run build` 生成客户端/服务产物，再由宿主重载插件并刷新页面。设置页保存 surface 触发的配置重载，不等于替你构建了新源码。

本轮本地构建已成功（含 pnpm 自动 prepare），但未完成宿主重载，不宣称已部署到运行中的 GUI。2026-11-02 使用 Playwright/Edge 访问现有 GUI `http://127.0.0.1:33158`，页面和台账接口均返回 `Browser access is disabled`；未改变访问策略、未启动替代服务器，因此没有完成浏览器 E2E/布局验收。源码/组件测试不能冒充该 URL 的真实加载验收。

独立组件浏览器验证：`tests/build-ledger-layout.mjs` 从本地宿主组件副本抽取未经改写的 Button/Input/SegmentedTabs 及其 CSS，配合真实 React 和 mock HTTP，`tests/verify-ledger-layout.py` 使用 Playwright/Edge 检查固定 640px 高容器。1100px/360px × 明暗主题四组均验证导航收起高度 ≤48px、滚轮与 Home/PageDown、尾部操作可达、单分页可见、详情返回及无横向溢出。该测试不启动服务器，也不等于已部署 GUI E2E；需用环境变量 `DSH_FORGE_NATIVE_MODULES`、`DSH_FORGE_REACT_MODULES` 指定本地模块目录。

---

## 已知边界

1. **数据都在插件私有目录**：快照与批次账本在 `~/.dsh/forge/snapshots/`，票据在 `~/.dsh/forge/tickets/`，验证记录在 `~/.dsh/forge/verification/`。即使用户仓库没有 Git，也有完整快照与回滚；这些目录整体可删，下次调用重建。旧版 `~/.dsh/forge/cards/` 随知识卡片工具一起废弃，留着也不会被读。
2. **目录只在机器索引命中时返回**：`ff_find` 在机器索引（Everything）答话时会返回目录并带尾部 `/`，走 fff 模糊回退时只返回文件。路径模式和目录下的文件列表交给内置 `glob`，不要给 `ff_find` 传 `mode`。
3. **单文件 2 MiB 上限**：AST 解析超限会降级并提示改用 `ff_grep`。
4. **正文读取属于内置 `read`**：`ff_symbols` 只接受 `outline` 与 `definitions`；已知符号时使用内置 `read` 的 `file_path=<file>#<Symbol>`。增强不可用时，用 `ff_symbols view=definitions` 定位范围，再用内置 `read` 的 `offset` / `limit` 读正文。
5. **读取正文与结构分工**：`ff_symbols` 仅查询结构，不提供正文视图。保留旧读取层的历史基准：≤256 KB 一次性解码，更大的按 256 KB 分块；94 MB 日志读取 `L500001-500005` 时常驻内存 254 MB → 9 MB、缓冲区 93.8 MB → 0.25 MB，耗时 224 ms → 246 ms。该实现仍扫到 EOF 取总行数，是恒定内存而非零成本；这些历史数字不代表当前内置 read 增强的复测，也不恢复已移除的 Forge 正文参数。
6. **分页预算与引擎硬截断分开**：`ff_grep` 每页最多返回 `limit` 条，单模式和多字面量模式都会保留已收集的溢出命中并通过 `nextCursor` 继续，写入覆盖层同样受作用域与分页预算约束。引擎在单文件内最多收集 2000 条；超过这 2000 条的命中无法翻页取得，结果会给出文件名与硬截断提示。游标绑定原查询与索引实例，5 分钟过期；未知、过期或变更参数的游标明确拒绝，不会静默从第一页重来。
7. **空结果分两种**：区分"索引看不见"和"被 `path=` 约束滤掉"，后者会直接告出命中有多少落在约束之外。
8. **索引会落后，但不会骗人**：引擎的文件监听会丢事件——实测在工作区内新建一个文件后 2.5 s 内 `fileSearch` 仍查不到（`isScanning()` 为 false，重试四次都没有），而 `scanFiles()` 之后 1.2 s 就能列出，且换默认引擎参数一样会丢。空页因此不可直接当答案：文件名查找按名字做一次磁盘核对（历史内部路径称 `mode=name`，不是当前参数），`ff_grep` 按目录 mtime 核对——内容查询没有名字可查，问的是"上次扫描之后有没有目录变过"。有证据就重建索引并重查一轮；重建按根 3 s 节流。核对走查限三层深、跳过 `node_modules`/`target`/`dist` 一类目录：实测空页从 400 ms 降到 find ~12 ms、grep ~40 ms（深度 6 时分别是 416 ms 和 149 ms，几乎全花在列举依赖树和构建产物上）；新建文件后约 480 ms 命中。

---

## 本地开发

```bash
pnpm run check   # 类型检查 + 构建
pnpm test        # 完整集成测试套件
pnpm run bench   # 检索与 AST 性能基准
```

部分套件要接真实宿主环境：复制 `.env.example` 为 `.env` 填好路径即可，缺省时会跳过或降级而不是失败。

CI 目前只跑类型检查与构建。集成套件有几十条断言按 win32/posix 分支，尚未在 Linux 上跑通，等验证后再逐组接入。

---

## 许可

[MIT](LICENSE)。

上游依赖：[fff](https://github.com/dmtrKovalenko/fff)（Rust 检索内核）、[web-tree-sitter](https://github.com/tree-sitter/tree-sitter) 与 [tree-sitter-wasms](https://github.com/samuel/tree-sitter-wasms)（WASM 语法）。
