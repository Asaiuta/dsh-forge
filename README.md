# dsh-forge

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](https://nodejs.org)
[![DeepSeek Harness](https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.2-orange.svg)](https://github.com/deepseek-ai)

为 **DSH（DeepSeek Harness）** 打造的检索与施工治理插件：把 [fff](https://github.com/dmtrKovalenko/fff) 的 Rust 检索引擎接进工具系统，配上多语言 AST 符号定位和一套带台账、快照、回滚的容错编辑引擎。

装好之后，AI Agent 找文件、读符号、改代码都走同一套带治理的工具，而不是各自去 `ls`、`cat`、`sed`。

> **状态** `v0.1.0` · 尚未发布到 npm，按[源码安装](#安装) · MIT · 需要 Node `^22.19 || >=24` 与 DSH `>=0.2.0-rc.2`

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

- 数据就是 `~/.dsh/forge/snapshots/` 里的账本，与 `ff_history` 同源；检查徽标区分历史判定与当前适用性，`passed→stale` 不是当前通过。
- 列表支持 `keyword`、`pathContains`、`actor`、`kind` 筛选和不透明游标分页；改变筛选必须重新查询，旧游标不能混用。
- `GET /forge-ledger?workspace=<绝对路径>` 读取列表或 `batch` 详情；同一路由 POST 回滚先 `preview`，再携短时、单次 token `confirm`。预览不授予写权限；确认重新检查台账和文件身份，宿主 guard 不可用时拒绝。
- 工程页支持私有工程、任务和批次关联。任务仅 `pending / doing / done / blocked` 四态，`note` 是独立备注；修改（除 create）须带当前 `revision`，冲突重新读后处理。
- 报告 `draft / review / accepted` 是人工工作流；`accepted` 不等于机器验证 `passed`，接受须所有任务（含归档任务）为 done。报告保留历史快照，删除任务只级联实时关联。
- 不装 better-sidebar 就没有侧栏页，设置页和当前工具面照常工作。HTTP 工程接口为 `/forge-projects`，它的响应平铺字段，不套工具的 `action/payload`。

### GUI 加载与验收边界

源码修改不会自动更新正在运行的 GUI：需先 `pnpm run build` 生成客户端/服务产物，再由宿主重载插件并刷新页面。设置页保存 surface 触发的配置重载，不等于替你构建了新源码。

本轮本地构建已成功（含 pnpm 自动 prepare），但未完成宿主重载，不宣称已部署到运行中的 GUI。现有 GUI URL `http://127.0.0.1:20014` 返回 `403 Browser access disabled`，因此没有完成浏览器 E2E 验收；源码/组件测试不能冒充该 URL 的真实加载验收。

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
