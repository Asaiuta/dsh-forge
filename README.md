# dsh-forge

DSH（DeepSeek Harness）的 FFF 检索 + 施工治理插件。把 [fff](https://github.com/dmtrKovalenko/fff)（Rust 原生、SIMD 加速、带跨会话 frecency 的搜索引擎）接成 DSH agent 工具，提供容错编辑、快照回退与 reason/actor 台账，并沿用 DSH 的会话文件策略、观察策略和文件锁。

当前提供 15 个工具：FFF 检索、11 语言 AST 符号、持久化工程与任务、容错编辑、文件/代码搬移、快照历史/diff、节点与时间点回退、统一寻址批量读、链路图 Trace。工程状态与文件批次共用一份台账，并接入 DSH 本机文件策略和 diff 卡片。

目标是适配 DSH。ProjectForge 作为包外行为与性能参考，不是要复制的产品规范：VCPChat 的 preload registry、角色表、工程/Git 面板和多模态批量读取不直接迁入。图片交给 DSH 的内建读取/附件工具；Trace 默认只读静态源码，可显式提供 JSON 声明数据。内部的可行性调研、逐轮验收报告与 ProjectForge 对照脚本不随源码分发。

## Rust 在哪里，DSH 能否使用

**dsh-forge 本身是 TypeScript 插件；Rust 实现在第三方 FFF 依赖中。** 安装时下载适合本机平台的预编译库，所以本项目 `src/` 没有 `.rs` 文件。当前各层实际使用的技术如下：

| 层 | 实现 | 源码 / 运行文件 |
|---|---|---|
| DSH 工具注册、编辑与治理 | 本项目 TypeScript | `src/index.ts`、`src/tools-edit.ts`、`src/ledger.ts` 等 |
| FFF 文件与内容检索 | 上游 Rust 原生库 | `@ff-labs/fff-bin-win32-x64@0.11.0/fff_c.dll`；上游 `crates/fff-core/src/`、`crates/fff-c/src/lib.rs` |
| Node → Rust 桥接 | `@ff-labs/fff-node@0.11.0` + `ffi-rs@1.3.7` | JS SDK → N-API `.node` 桥 → C ABI DLL |
| AST 符号解析 | `web-tree-sitter@0.25.0` + WASM 语法 | `src/ast.ts`；当前不是原生 Rust AST 后端 |

可直接查看上游的 [Rust 检索内核](https://github.com/dmtrKovalenko/fff/tree/d978416f77aec3f9928d56e00c9e56ba39ca1fda/crates/fff-core/src) 和 [Rust C ABI 导出](https://github.com/dmtrKovalenko/fff/blob/d978416f77aec3f9928d56e00c9e56ba39ca1fda/crates/fff-c/src/lib.rs)。这些链接固定本次观察到的上游提交，用于说明源码位置；不代表已复现安装的 0.11.0 DLL 的构建。

**本机 DSH 的 Rust 调用已有运行验证。** 桌面版可执行文件的 Electron Node 模式能够加载 FFF DLL 与 WASM；最新验收覆盖全部 15 个工具的 SDK 成功结果、实际 sandbox provider 和观察策略。此模式不代表完整桌面 UI/模型验收。运行预编译 Rust 库不需要安装 `cargo` / `rustc`；DSH 的 Cordis 插件入口仍是 JS/TS。

工程注册表、任务关联、验收报告、文件/代码搬移和节点历史已实现。DSH todo 保留当前会话进度作用，跨会话任务真值由 forge 工程台账负责。可选并行 WASM 的热查询已经接近 PF，但冷查询和内存仍明显落后；新的 Rust AST 后端仍是候选。本次没有启动完整桌面 profile、PTC 或模型会话。

## 工具

| 工具 | 层 | 作用 |
|---|---|---|
| `fffind` | L0 | 文件名模糊搜索，容错拼写，frecency + git 状态加权排序 |
| `ffgrep` | L1 | 内容搜索（plain/regex/fuzzy），cursor 分页，`enclosing: true` 时给每个命中标注所在符号 |
| `fff_multi_grep` | L1 | 多模式 OR 搜索（Aho-Corasick），验证扫描一次搞定 |
| `ff_outline` | L2 | 单文件符号大纲（类/函数/方法/接口/结构体…），精确行区间，比读全文省 token |
| `ff_find_symbol` | L2 | 工作区级定义查找：简单名、限定名与 Rust `::`，覆盖 11 种源码语言；可选并行解析 |
| `ff_read_symbol` | L2 | 按符号地址读源码（含前置注释；`body=true` 从签名行起），区间锚定当前内容 |
| `ffedit` | L3 施工 | 容错多步行级编辑（原始快照坐标 / expect 漂移校正 / 首尾锚定 / 歧义票据），每次写入前快照、强制 reason；`revertOnSyntaxError` 在原本干净的文件将引入语法错误时写前拒绝（票据持久化该策略） |
| `ffresolve` | L3 施工 | 持久化票据单选、多选 `choices`、全选 `all`；重叠和过期字节身份拒绝写入 |
| `ffhistory` | L3 治理 | 台账检索：谁（actor=会话 id）、何时、为何（reason）改了哪些文件 |
| `ffrollback` | L3 治理 | 批次/节点/时间点文件状态回退；回退自身也是新批次，可重做；`dryRun` 默认 true |
| `ff_project` | 工程 | 工程注册、查询、任务 patch、revision 检查、验收报告、软删除/恢复 |
| `ff_file` | L3 施工 | 创建/删除/搬移文件，复制/搬移符号或 `fromLines=L10-20` 行块；落点锚四选一（`after=N` / `before=N` / `afterSymbol` / `beforeSymbol` 含前置注释），`indent=auto` 按插入点自动重排缩进（闭行参照上一行），按 AST 字符区间替换/删除/前后插入 |
| `ff_diff` | L3 治理 | 以稳定 `b:<batch>:n:<index>` 节点地址读取不可变快照 diff |
| `ff_read` | L2 | 统一寻址批量读：`path#符号` / `lines=L10-20` / 多 path / glob（根 .gitignore 生效）；整文件 4000 行上限，文本预算可能截断或跳过，结果带标记/原因；行号契约与 ffedit 一致 |
| `fftrace` | L2 链路 | 静态查询 `ipc:通道或API名`、`global:名称`、`page:xxx.html`、`file:相对路径`；分析 JS/TS 族与 HTML 的模块、IPC、页面顺序和全局关系。可选 `declarations` 指定 JSON 数据文件，补充 API/角色事实；不执行 registry。动态参数列位置不入边，结果位置可回填 ffedit/ff_read |
| `/forge-status` | — | 引擎状态 + 施工台账统计 + 票据计数；`rescan` 重扫、`prune` 清孤儿快照库并回收无引用 blob、`purge [confirm=yes]` 永久清除当前工作区施工历史（预览式确认，磁盘文件不动） |

覆盖语言（AST 层）：JavaScript / TypeScript / TSX / Python / Rust / Go / C / C++ / Java / C# / Lua。`.mts/.cts` 按 TypeScript、`.pyi` 按 Python、`.h/.cppm/.ixx` 按 C++ 解析；bundled grammar 对部分 C++ module 语法仍可能返回 partial。查找的 occurrence 按完整限定名组、声明顺序编号后再过滤 kind/limit；声明重排后应重新查找。其他文件类型由 FFF 文本检索覆盖。

### 为 Trace 提供应用声明

默认只分析源码，不自动导入任何工程代码或 VCPChat 角色。需要角色可见性检查时，在工程中提供数据文件（最多 256KiB）：

```json
{
  "apis": [
    { "name": "loadSettings", "channel": "settings:load", "kind": "query", "roles": ["main"] }
  ],
  "roleGlobals": { "main": "appBridge" }
}
```

调用 `fftrace` 时传入 `{"target":"ipc:settings:load","declarations":"trace-declarations.json"}`。`kind` 可为 `query`、`command`、`subscription`，`channel` 可为 null；无效数据会返回 `decls: "failed"` 并保留静态事实。扫描响应取消，不创建声明执行子进程。

### 焊接点（L1 → L2）

`ffgrep` 传 `enclosing: true`，每个命中行带 `in: {name, startLine, endLine}`——定义命中和调用点命中都能标注所在符号。典型流：`ffgrep pattern enclosing:true` → `ff_read_symbol path file#Symbol`。这就是"grep 命中行 → 所在函数"的精确版（ProjectForge 用正则兜底做同一件事，这里永远走 AST）。

### AST 层设计原则（承自 forge 计划）

- **区间以内容为准，不以索引为准**：每次查询重读文件、归一化 EOL、取 sha256，命中缓存才复用解析；索引用于发现，返回区间按本次读取的内容计算（有地板测试：改文件 → 立即查询 → 反映新内容）。并发写入的保证见已知边界。
- **只给确定的东西**：只提供定义 + 精确区间，不做调用图猜测；引用搜索留给 ffgrep。
- **行号契约**：1-based、去 BOM、CRLF/CR→LF 归一，与 fff 层一致（编辑引擎同契约）。
- **永远可降级**：不支持的扩展名报结构化错误并指向 ffgrep；语法缺失可重试。

## 施工治理内核（第三阶段）

### 容错编辑引擎（`src/edit-engine.ts`，纯函数）

- **原始快照坐标**：一批 steps 全部以调用前的快照为坐标编译成互斥区间，重叠直接报错（不猜测），最后按升序一次拼接。
- **expect 漂移校正**：行号记错时，锚点内容在 ±20 行内就近重定位，报告漂移量。
- **首尾锚定**：replacement 引用了区间自身首尾行时识别为锚（LLM 过量引用的典型错误），只替换内部——重复发送同一编辑是幂等的。
- **`N | ` 前缀剥除**：仅当所有非空行都带前缀才剥（markdown 表格安全）。
- **target 步**：整块匹配（精确 → 容忍首尾空白并平移缩进）；单行 literal 没有整行命中时自动匹配行内；独占行 `...` / `…` 支持省略块；零命中给相似行，多处命中签发票据。行内最多 100 个候选，省略块有搜索预算；超限拒绝写入。
- **atomic（默认）/ bestEffort**：任一步失败全批不写 / 跳过失败行级步骤并报告。行内 target 暂仅支持 atomic，bestEffort 显式报错。

### 治理决策（实现前经用户确认）

| 决策点 | 采纳 | 理由 |
|---|---|---|
| reason 强制程度 | 每次写操作强制必填，缺失报错并附可照抄格式 | PF 对齐；台账完整可读 |
| 票据落盘 | `~/.dsh/forge/tickets/`，24h 过期 | 相比 PF 内存票据可跨进程重启保留；仓库零污染 |
| 快照作用域 | `~/.dsh/forge/snapshots/<workspace-key>/` 中心式 | 仓库零污染、回退不依赖 git |
| 存储格式 | JSONL 台账 + sha256 内容寻址 gzip blob（零原生依赖） | 本机无 VS 工具链，better-sqlite3 原生绑定在 Electron ABI 下有风险；PF 用它只因主依赖已在 |
| actor 来源 | `exec.agent.session.header.id`（DSH 会话 id） | 子代理各有 id，按操作者过滤天然成立 |

### 数据面纪律（承自 forge 计划）

- **外部修改保护**：每次写入前把磁盘 hash 与台账最后已知 hash 比对，不一致先记 `external` 节点；规划后的变化会中止提交。检测到的手动改动有原始字节快照，外部并发写入的保证见已知边界。
- **回退即新批次**：rollback 记录 before/after 双 blob，回退回退即重做；文件级回退还原完整快照而非 diff。
- **台账反哺 frecency（1+1>2 焊点）**：fff-node 无 recordAccess API（已核实 typings），唯一诚实通道是 `trackQuery(query, file)`——ffgrep/fffind 命中文件时记下 (query→file)，ffedit 写入成功后回放进查询史库；查询与选中都真实发生，不造假学习数据。mtime frecency 随写入自动更新。
- **编辑后复解析**：`ffedit` 语法警告默认 report-only（写后新增与存量错误分开表述）；`revertOnSyntaxError` 开启时，原本干净的文件将被写坏 → 写前拒绝，已脏文件保持 report-only（tree-sitter 的二值 hasError 无法逐条归因）；按符号修改/搬移要求原始及计划结果的支持语法有效。共享声明、需要逗号处理的成员删除/搬移拒绝，改用明确整段 target，避免误伤邻居；语法解析不能代替编译器。
- **提交与锁**：工作区台账串行，多文件按固定顺序获取锁；最终授权、版本重验和文件发布共用 DSH provider 的目标锁。快照与文件恢复日志先落盘，文件完成后提交台账。重启恢复先授权全部文件目标并检查 write-intent；未知外部字节阻止写入。台账增量追加前保存 offset、前缀摘要及完整待写行；进程中断后仅恢复与证明精确匹配的字节，严格工程台账的未知撕裂尾部仍拒绝。完整损坏记录不被当作旧历史。
- **长历史热路径**：复用完整验证过、文件身份未变的台账视图与派生文件状态；每次追加只写新行，每 128 批次保存可丢弃 checkpoint。台账/元数据的 inode、size、mtime 或 ctime 变化会触发全量校验；重启首读也会全量校验。缓存最多保留四个工作区，不以 state.json 代替权威台账。
- **字节与链接**：编辑严格接受 UTF-8；回滚/重做保存原始 Buffer，外部二进制或无效 UTF-8 也能完整恢复。编辑符号链接会解析真实目标并保留链接身份。
- **票据决策**：多个 target 步骤的既有选择随下一张票据持久化。任何原始文件变化都重新要求决策；原歧义消失时返回错误，绝不自动改写剩余的唯一位置。

## 检索栈分工

| 层 | 问题 | 工具 |
|---|---|---|
| L0 文件发现 | "那个文件叫什么？" | fffind |
| L1 文本检索 | "哪些行出现了 X？" | ffgrep / fff_multi_grep（引用全集、验证扫描） |
| L2 符号定位 | "X 的定义边界在哪？" | ff_outline / ff_find_symbol / ff_read_symbol（定义 + 精确区间） |

fff 解决"找得快、排得准"，AST 解决"找得精"。二者数据面隔离：frecency 只影响发现排序，永不参与坐标计算。

设计要点：

- **会话启动零开销**：引擎懒启动，首次工具调用才按工作区根建索引（实测 3815 文件冷启动 0.3 秒）。
- **跨会话学习**：frecency（访问频率 + 新近度）与查询史存 LMDB，在 `~/.dsh/forge/fff/`（可用 `DSH_FORGE_DATA_DIR` 重定向）。这是**全局库**——学习信号跨工作区累积，这是有意为之的默认值；要与某工作区隔离时用环境变量指向独立目录。
- **学习与正确性分面**：frecency 只影响发现类结果的排序，永不参与坐标计算。精确的符号边界是第二阶段 AST 层的职责。
- **降级安全**：原生库加载失败、路径不存在、fs 根拒绝索引时，工具通过 SDK 错误通道报告具体原因与降级提示，避免把错误对象当成成功输出校验。
- **gitignore 生效**：gitignored 内容永不出现（grep 与 find 均然）。

## 已知边界（诚实契约）

- `limit` 是**目标页大小**：引擎按文件边界取整分页，单页可能略超 limit；`nextCursor` 分页保证不重不漏（有地板测试钉住）。
- 施工层：快照库**绑定本机**；外部路径也记入当前会话工作区台账，`ffhistory` / `ffrollback` 可直接寻址。`ffhistory` 支持 `content=` 快照内容过滤（大小写不敏感、32MB 扫描预算）。锁只覆盖同一 host 进程；提交前重验 hash，但不承诺跨进程文件 CAS、断电持久性或硬链接身份。编辑后语法检查是 report-only。
- 工程/任务/报告已持久化；删除和恢复只改变记录。`/forge-status purge`（`confirm=yes` 确认式）永久清除当前工作区施工历史；`prune` 回收孤儿快照库与无引用 blob（引用感知，绝不删台账可达快照）。时间点回退恢复文件，保留任务/报告历史，不还原工程元数据。接受报告后，关联文件修改会提升 revision 并让工程重新变为 active。
- 支持共享本机 LocalFileSystem 和标准 SandboxedFileSystem。按当前会话解析 sandboxPolicy：read-only 可读取、拒绝文件写入；workspace-write 检查规范目标所在范围；danger-full-access 仍执行观察/版本检查。读取固定 provider 的规范路径，仅稳定成功读取或确认缺失才发 observed；写入与 DSH 内建文件工具共用 provider 锁，等待后重新核验目标与版本。远端/不共享路径仍拒绝。
- 此适配已核对装机 DSH `0.2.0-rc.2` 的 `checkedTarget` / `withLock` 实现；它们不是公共 SDK 稳定承诺。缺少 per-session policy、规范写入 fence 或 sandbox 共享锁时文件写入失败关闭，升级 DSH 后应重跑接入测试。仍不承诺跨进程文件 CAS、断电持久性或完整审批 UI 等价。
- 施工结果将不可变 diff 冻结到 SDK metadata，并返回现有 DSH `card:'diff'`。卡片回放不读磁盘；256KB 卡片预算省略大文本/二进制，可查询 `ff_diff`。这不等于完整工程/Git 面板或桌面视觉验收。
- 变更 UI 适配：`scripts/patch-workspace-changes.mjs` 给装机版 dsh-workspace-changes 的 `mutationPath()` 幂等补上 `ffedit`/`ff_file` 两个 case（带备份，`--restore` 可回滚），使非 Git 目录、Gitignored 文件与仓库外路径的 forge 写入获得与内建文件工具相同的轮次快照捕获；**DSH 应用更新会覆盖该文件，更新后需重跑**。Git 仓库内的 forge 改动本就由轮次 numstat 捕获，与本 patch 无关。
- 引擎 0.11.0 的 `classifyDefinitions` 对 JS 系文件不可靠（探针确认：定义行漏标、调用行误标），已弃用不暴露；def 标记由第二阶段 AST 正规解决（`enclosing` 焊接 + ff_outline/ff_read_symbol）。
- AST 层使用 `ignore` 库处理根目录和嵌套 `.gitignore`，包含取反规则；目录忽略清单见 `tools-symbol.ts` 的 IGNORE_DIRS。原始文件超过 **2MiB** 时在读取源码、解码和 hash 前拒绝；打开后增长的输入也有界读取。此上限与 PF 的 8MB 不同。
- web-tree-sitter 固定 **0.25.0**：它必须与 tree-sitter-wasms 0.1.13 预编译语法的 ABI 匹配（0.27 加载同一批 wasm 会报 dylink 错误）。升级 web-tree-sitter 前先跑 `node tests/run-ast.mjs`。
- `ff_file` 每文件 8MB 上限，要求目标父目录已存在；传输源为 `symbol` 或 `fromLines`，落点锚四选一。`edit_symbol` 操作精确符号区间，共享声明及列表成员删除/搬移需用 `ffedit` 显式处理。创建/删除/搬移与回退拒绝链接身份；普通 `ffedit` 可编辑可达链接的真实目标，悬空链接始终拒绝。
- `fftrace`：静态分析默认开启，声明仅接收显式 JSON 数据。模块解析只处理相对路径，包名不入图；`globalsUsed` 只统计显式 `window.` / `globalThis.`；包装函数只在同文件识别，跨文件降级为 dynamic；桥接别名按顶层/同页采纳。facts 仅 JS 族 + HTML，不宣称 ffi 或多语言调用图完整覆盖。
- 工具描述里写明了与内建搜索/内建编辑的分工；内建工具不受影响，删掉本插件即完全回滚（快照库留在 `~/.dsh/forge/`，可整目录删除）。

## 安装（DSH 桌面版，无 dsh CLI）

1. 编辑 `~/.dsh/profiles/desktop/package.json`：`dependencies` 加 `"dsh-forge": "link:<本仓库绝对路径>"`，`dsh.profile.bundles` 数组追加 `"dsh-forge"`。
2. `pnpm -C ~/.dsh/profiles/desktop install`（若 pnpm 拦构建脚本，按惯例在 pnpm-workspace.yaml 的 allowBuilds 里放行后重装）。
3. 重启 DSH 生效。回滚：bundles 数组删行 + dependencies 删项，再 `pnpm install`。

cordis.patch.yml 只在 host plane `insert` 一行（dsh-ssh 同款），**刻意不碰 preset-standard**——dsh-blackhole 的 patch 已全量重述该列表，两份全量重述会互相覆盖。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_FORGE_DATA_DIR` | `~/.dsh/forge` | frecency/查询史 LMDB 根目录 |
| `DSH_FORGE_GRAMMAR_DIR` | 随包 `tree-sitter-wasms/out` | tree-sitter 预编译语法目录 |
| `DSH_FORGE_AST_WORKERS` | `0` | `0` 顺序 WASM；`1..8` 有界 worker，按 CPU 数收紧。2/4 可降低查询延迟，但显著增加总内存 |

插件本身不需要任何本机路径。只有测试链和维护脚本需要，它们从仓库根目录下 gitignored 的 `.env` 读取，真实环境变量优先。复制 `.env.example` 为 `.env` 再按需填：

| 变量 | 用途 |
|---|---|
| `DSH_FORGE_DSH_MODULES` | 装机 DSH 的 `@deepseek-ai` 包目录；启用 `run-host-integration`，并作为基准语料兜底 |
| `DSH_APP_DIR` | DSH 应用目录，供 `scripts/patch-workspace-changes.mjs` 使用 |
| `DSH_FORGE_BENCH_CORPUS` | `bench.mjs` / `bench-ast.mjs` 的基准源码树，任意大型真实仓库 |
| `DSH_FORGE_RG` | `bench.mjs` 进程基线用的 ripgrep，默认走 `PATH` 的 `rg` |
| `DSH_FORGE_REAL_REPO` | `eval-trace-real.mjs` 的额外真实仓库；未设时找同级 checkout，找不到即 skip |
| `DSH_FORGE_PF_EXE` / `DSH_FORGE_PF_PLUGIN` | ProjectForge 索引器与插件目录，**位于本仓库之外**（CC BY-NC-SA，绝不随包分发）。未设时 `eval-coverage.mjs` 的 ProjectForge 列报为不可用而非报错 |

## 验证与历史对照

```powershell
pnpm run check
pnpm test
node tests/bench.mjs
node tests/bench-ast.mjs
```

完整测试链包含 21 套件，其中 `run-host-integration.mjs` 使用装机的实际 SDK、sandbox provider、会话策略与观察策略；通过 `DSH_FORGE_DSH_MODULES` 指定 `@deepseek-ai` 包目录，未找到安装时明确报告 skip。`run-review-regressions.mjs` 覆盖符号身份、读取前预算、缓存完整性和真实进程强退恢复。单纯 factory 测试不代替接入测试。

工具描述保留选择边界、条件必填、互斥、默认值、坐标和副作用；多 action 工具的约束由参数说明与运行时校验共同保证。找定义用 `ff_find_symbol`，找引用用 `ffgrep`；单符号消歧读用 `ff_read_symbol`，批量读用 `ff_read`；行/文本编辑用 `ffedit`，符号编辑与代码传输用 `ff_file`。

下列脚本离线捕获实际注册的完整 native schema 和 PTC 声明（含嵌套参数与输出类型），不发送模型请求。通过 `DSH_FORGE_DSH_MODULES` 指向宿主同版本 SDK；安装了 `js-tiktoken` 时额外输出两种比较用分词计数。PTC 成本减去空 SDK 的固定前导，命令单列，不把 bytes/4 估算当作 DeepSeek 实际 token。

```powershell
node scripts/audit-descriptions.mjs
node scripts/dump-injected-prompt.mjs --json
node scripts/dump-injected-prompt.mjs --json --compare <baseline.json>
```

描述优化的前后数据与验证范围见仓库外的内部工具描述报告。脚本策略评测与宿主接入通过均不等于真实模型调用准确率。

ProjectForge 的符号、共同编辑行为和性能数据只作为冻结语料下的历史参考，对照脚本与审查证据均保存在包目录外，不随源码分发。原比较脚本已修正为等待全部 parseFile 完成并在本进程预热后计时；未等待 Promise 的旧热扫描数值不再作为证据。

审查时默认 WASM 的整库冷查询和 RSS 落后于 PF；单文件热缓存相近，可选 worker 的热查询更接近但内存更高。本次修复没有替换 AST 后端，也没有据此宣称整体更快或产品等价。FFF/rg 基准包含调用形态与配额差异，不能解读为等工作量速度倍率。

## 许可

MIT。依赖 `@ff-labs/fff-node`、`web-tree-sitter`、`tree-sitter-wasms`、`ignore`（均 MIT）。本插件的 AST 与施工治理内核自行实现。本次对比读取并执行了 VCPChat/ProjectForge（CC BY-NC-SA）的原始引擎与客户端，仅保存在包目录外的审计证据中；未把其实现代码或二进制加入插件发布内容。
