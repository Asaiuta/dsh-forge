# dsh-forge

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](https://nodejs.org)
[![DeepSeek Harness](https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.2-orange.svg)](https://github.com/deepseek-ai)

为 **DSH（DeepSeek Harness）** 打造的检索与施工治理插件：把 [fff](https://github.com/dmtrKovalenko/fff) 的 Rust 检索引擎接进工具系统，配上多语言 AST 符号定位和一套带台账、快照、回滚的容错编辑引擎。

装好之后，AI Agent 找文件、读符号、改代码都走同一套带治理的工具，而不是各自去 `ls`、`cat`、`sed`。

> **状态** `v0.1.0` · 尚未发布到 npm，按[源码安装](#安装) · MIT · 需要 Node `^22.19 || >=24` 与 DSH `>=0.2.0-rc.2`

## 目录

- [架构](#架构)
- [9 个工具](#9-个工具)
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

## 9 个工具

| 工具名 | 层级 | 功能 | 典型用法 |
|---|---|---|---|
| `fffind` | 发现 | 找文件。`mode=name`（默认）按文件名模糊匹配，容错拼写并按访问频率加权；`mode=glob` 走 npm-glob 语法、感知 `.gitignore`、可分页。两种模式都只返回文件。 | 记得大概文件名用 `mode=name`；批量列目录结构或文件类型用 `mode=glob`。 |
| `ffgrep` | 检索 | 文本搜索，支持 plain / regex / fuzzy，可一次扫多个字面量；`enclosing: true` 同时返回命中行所在符号。 | 找配置名、关键字、调用点。 |
| `ff_read` | 符号 | 统一读取。`view=body` 按行区间、符号名（`path#Symbol`）、批量路径或 Glob 读正文；`view=outline` 给单文件 AST 大纲；`view=definitions` 全局查定义，支持限定名与 Rust `::`。三个视图参数互不通用，传错直接报错并指路。 | 先 `outline` 摸结构，再 `definitions` 定位，最后 `body` 读实现。 |
| `fftrace` | 链路 | 静态分析文件级依赖：JS/TS/HTML 模块、Rust/Python/C/C++/Go/Java/Lua 引用关系、preload 暴露、IPC、FFI 声明与 PE/ELF/WASM 导出。 | `file:` 查直接引用，`impact:` 查传递影响，`path:` 求最短路径，`exposes:` 查暴露的全局。语义细节见 [docs/trace-reference.md](docs/trace-reference.md)。 |
| `ffedit` | 施工 | 多步行级编辑：快照坐标合并、±20 行锚点漂移校正、首尾锚自动识别、写前语法校验。命中多处时不猜——写零字节、签一张票据，回传 `{ticket, choice}` 决议。 | 精准改动；歧义时走票据确认。 |
| `ff_file` | 施工 | 创建、删除、移动文件；符号级或行块级代码迁移，四种落点锚定，自动校正缩进。 | 重构、搬函数、拆模块。 |
| `ffhistory` | 治理 | 查施工台账：谁在何时因何原因改了哪些文件，可取不可变快照 diff。 | 审查改动来源。 |
| `ffrollback` | 治理 | 按批次、节点或时间点还原；回滚本身生成新批次，可再撤销。 | 改错、测试失败时复原。 |
| `ff_cards` | 治理 | 把台账确定性蒸馏成四张卡：`overview`、`hotspot`、`timeline`、`structure`。无参数列目录，`card=<name>` 读正文。 | 新会话快速知道"最近改了哪儿"。 |

AST 支持 11 种语言：JavaScript、TypeScript（含 TSX/MTS/CTS）、Python（含 PYI）、Rust、Go、C、C++、Java、C#、Lua。

后续规划见[能力补齐与工具闭环路线图](docs/forge-capability-roadmap-2026-10-28.md)与[实施手册](docs/forge-plan-m0-m1.md)：M0（证据契约与能力边界——能力矩阵、审计状态、快照身份、分页、被动状态）已落地，M1 及之后尚未实施。

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
| `DSH_FORGE_DATA_DIR` | `~/.dsh/forge` | frecency 统计、查询历史、快照与卡片缓存的主目录。 |
| `DSH_FORGE_GRAMMAR_DIR` | 随包预装 | Tree-sitter WASM 语法目录。 |
| `DSH_FORGE_AST_WORKERS` | 自动，≤ `8` | 符号与 Trace 共用的 Worker 池。`0` 强制顺序，`1..8` 指定上限。 |
| `DSH_FORGE_INDEXER` | 自动 | 原生 sidecar 开关，`0` / `off` 关闭。启动或读取失败自动回退 WASM。 |
| `DSH_FORGE_INDEXER_BIN` | 未配置 | 指向本机的 sidecar 二进制；源码 checkout 也会发现 `rust_indexer/bin`。npm 包不捆绑平台二进制。 |
| `DSH_FORGE_TRACE_NATIVE` | 自动 | sidecar 可用时用原生提取源码事实，`0` / `off` 保持 WASM。 |

原生加速是可选的：源码 checkout 里装 Rust 1.88+ 后执行 `pnpm run build:indexer`，产物进 `rust_indexer/bin`。启用后 Trace 冷启动不再加载 WASM 语法，峰值内存约降一个数量级。

### 工具注册模式

默认让 9 个 `ff*` 工具与内置 `read`/`grep`/`glob`/`edit` 并存。若想用本插件遮蔽内置工具，在用户 patch 层配置：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: dsh-forge
  name: dsh-forge
  config:
    registration: takeover          # 默认 additive
    takeover: [read, glob, grep]    # 可省略；省略即取全部可接管项
```

| `registration` | 结果 |
|---|---|
| `additive`（默认） | 9 个工具以 `ff*` 名挂在全局，与内置工具并存。 |
| `takeover` | 列出的名字按 agent 作用域注册，遮蔽同名内置工具；其余仍走全局。 |

可接管 `read`、`glob`、`grep`。接管后参数与内置契约保持一致：`read` 同时接受 `file_path`/`offset`/`limit` 与 `path`/`lines` 两套；`glob` 接受 `{pattern, path}`；`grep` 接受 `{pattern, path, include}`，`pattern` 按 ripgrep 正则、大小写敏感解释。

`grep` 接管靠**逐调用回退**兜底：索引答不上来的那一次调用，原样交给内置 grep。

| 触发回退 | 原因 |
|---|---|
| 扫描未完成 | 半成品页是样本，不是答案 |
| finder 起不来 | 这个根没有索引 |
| 一页零命中 | 索引是快照，看不见别的进程刚写的文件 |
| `path` 里带 glob | 内置会当路径报错，那才是同一条调用的答案 |

零命中会额外向磁盘复核，所以「没有」也可能花掉约 1.1 s（内置 ripgrep 的代价），换来的是这个「没有」被磁盘确认过。回退句柄拿不到时一切照旧走索引。

`edit` 不提供接管：内置在 `replace_all: false` 时要求 `old_string` 唯一出现，多匹配即报错，而 `ffedit` 会签票据让你确认挑哪一处。

### 预建索引

`prewarm`（默认 `true`）在 agent 出现后约 1.5 s 后台把索引建到就绪，避免第一次查询等冷启动。它会短暂占用 JS 线程（5k 文件约 0.5 s），纯聊天场景可关：

```yaml
- id: dsh-forge
  name: dsh-forge
  config:
    prewarm: false
```

### 知识卡片

`ff_cards` 的蒸馏行为由 `cards` 块控制：

```yaml
- id: dsh-forge
  name: dsh-forge
  config:
    cards:
      distill: session   # session（默认）| endpoint | off
      endpoint:          # 仅 distill: endpoint 时需要
        baseUrl: https://api.example.com/v1
        model: your-model
        apiKeyEnv: OPENAI_API_KEY
        timeoutMs: 120000
```

| `distill` | 行为 |
|---|---|
| `session`（默认） | 读骨架卡时附带蒸馏指令，当前会话模型用 `{polish: "<name>", content: "<润色稿>"}` 写回。消耗会话 token，无额外后台调用。 |
| `endpoint` | 读未润色骨架时内联 POST `{baseUrl}/chat/completions`，失败回退骨架。 |
| `off` | 拒绝润色写入与模型调用，只读已有草稿。 |

润色稿是缓存不是资产：以台账锚（批次游标 + 文件 stat 签名）为凭据，锚一动即全部丢弃。`{card: "overview", skeleton: true}` 始终返回台账来源的确定性结果，不发请求。

---

## 已知边界

1. **数据都在插件私有目录**：快照在 `~/.dsh/forge/snapshots/`，卡片缓存在 `~/.dsh/forge/cards/`。即使用户仓库没有 Git，也有完整快照与回滚；这两个目录整体可删，下次调用重建。
2. **只返回文件**：`fffind` 两种模式都不返回目录节点，遍历目录请用 `dir/**` 或把 `path` 指到目录。
3. **单文件 2 MiB 上限**：AST 解析超限会降级并提示改用 `ffgrep`。
4. **单次整文件读取 4000 行**：更长的文件要用 `lines=L1-2000` 分段。
5. **单文件命中 2000 行硬截断**：`ffgrep` 在一个文件内收满 2000 行就跳下一个文件，`nextCursor` 不会回到该文件，所以靠翻页拿不到后续命中；触顶时结果里会有 note 指明文件。`limit` 管不住它——引擎按整个文件收集完才看 `pageSize`。
6. **空结果分两种**：区分"索引看不见"和"被 `path=` 约束滤掉"，后者会直接告出命中有多少落在约束之外。

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
