# 内置 edit / write 隐藏验收

2026-11-06。实现位于 dsh-forge 源码与本机构建产物。后续核对确认 desktop profile 的 `node_modules/dsh-forge` 是指向本源码目录的 junction，构建产物共享；正在运行的宿主是否已加载需以实际请求头为准。desktop 配置未开启 `hideBuiltinWrites`。本次实现验收没有发起模型请求或上游 API 流量。

## 使用方式

配置 `surface: full`、`hideBuiltinWrites: true`，或在设置页启用「可替代时隐藏内置 edit / write」。默认关闭。`/forge-status` 按代理显示两个名字是否真正隐藏，以及保留原因。

仍为 9 个完整工具，没有新增独立工具。已有 `ff_edit action=verify/eval`、`ff_file action=read` 保留。

| 内置入口 | Forge 入口 | 明确边界 |
|---|---|---|
| edit | `ff_edit` 的 `find/replaceWith` 加 `match: literal` | 严格 UTF-8 子串，默认唯一匹配；`replaceAll: true` 替换全部非重叠匹配；8 MiB 输入/结果上限；必须填写 reason |
| write | `ff_file action=create` | 工作区内、8 MiB；覆盖须 `overwrite: true`；自动创建父目录；必须填写 reason |

literal 模式按原文处理空格、BOM、CRLF、LF 和 CR，不沿用 block 模式的重缩进、换行归一化或歧义票据。替换内容中的美元符号没有特殊含义。一次 replaceAll 仍是一个编辑操作，回执提供匹配次数；完整证据用 `receipt: diff` 和 `ff_history` 获取。默认 block 模式保持原行为。

缺失父目录只在路径、策略、观察版本和事务锁检查之后创建。权限或观察版本拒绝不会创建目录；提交失败清理本次仍为空且身份未变的目录。成功批次的文件回滚只恢复文件，保留目录；中断时若恢复日志尚在，保留目录供恢复使用。

## 宿主与回退

使用安装版 DSH 的公开 `tools.view/restrict`，没有修改注册表私有字段或改写宿主。安装版预设由 preset registry 创建独立作用域，代理通过父作用域绑定继承其工具，因此标准预设属于可隐藏范围。

隐藏要求 Forge 自身定义在代理中可见且无条件启用、文件系统共享本地路径、必要的权限检查接口齐全。宿主使用沙箱文件系统时，仅在会话为 danger-full-access 时隐藏；workspace-write/read-only 保留内置权限升级入口。远程文件系统、代理自身注册的同名工具、旧 SDK、Forge 定义消失或被其它插件遮蔽时保留/恢复内置入口。

代理创建/销毁、预设选择、工具注册变化、会话事件及请求前的 inbox claim/status 事件会更新可见性。`agent/pre-step` 位于安装版宿主的工具选择和提示词组装之后，不能用于当前请求的隐藏准备，因此没有依赖它。每次施加限制后检查实际可见列表；不会把仅拒绝执行当作隐藏成功。

关闭、切换 retrieval 或卸载只解除本插件持有的限制，不解除其它插件的限制。保留 read、read_image、glob、grep、shell、todo_write；日常计划仍由 Todo 镜像进入项目。

## 验收

构建和 TypeScript 检查通过。20 个检查进程全部退出 0，无跳过，包括配置读写与 HTTP、注册与挂载、提示词、编辑、文件事务、参数卫生、回执/历史、批量读取、符号执行、内置写工具记账和事务契约。

安装版 SDK 检查有 8 组，覆盖：

- 真实 preset/agent 作用域、本地/远程及不同权限会话之间的隔离。
- 新建/销毁代理、预设切换、权限切换、代理自身工具覆盖和 Forge 替代定义遮蔽。
- 原生 schema、PTC TypeScript/Python 声明及内置提示词同步消失；旧 admitted tool set 不能调用隐藏名字。
- 原生和 PTC 的成功回执值一致，结构化值及文本满足输出字节上限。
- BOM/混合换行/纯空白/美元符号、严格匹配失败、replaceAll 和逐字节回滚。
- 嵌套目录创建、显式覆盖空文件、权限拒绝、越界拒绝及过期观察拒绝。
- 卸载、retrieval、关闭开关、缺少公开限制 API 时的恢复和诊断。

现有文件事务测试增加了嵌套创建的故障注入，确认失败后没有文件、空目录或已提交批次。配置 HTTP 测试修正了旧的“三条路由”断言：现有 Git 路由使实际为四条，因此后续保存/错误断言得以执行。

复现：先构建，再设置 `DSH_FORGE_DSH_MODULES` 指向安装版的 `node_modules/@deepseek-ai`，运行 `pnpm run test:builtin-writes`。缺少安装版 SDK 会失败，不静默跳过。`DSH_FORGE_ACCEPTANCE_DIR` 可保存计量 JSON。

## Token 计量

离线统一使用 o200k_base；不是字节除以四。固定装配为 full Forge 加宿主 read/edit/write，计入这组工具的说明；其它工具、系统提示词、运行时上下文和任务正文未计入。本表只比较同版本开关，不是整个请求的 Token 数。

| 投影 | 关闭隐藏 | 开启隐藏 | 减少 |
|---|---:|---:|---:|
| 原生 schema + 说明 | 5,484 | 5,042 | 442 |
| PTC TypeScript + 说明 | 7,794 | 7,306 | 488 |
| PTC Python + 说明 | 8,953 | 8,424 | 529 |

新增严格替换参数与写入引导也有成本。按上一阶段保存的 full 插件投影、相同 tokenizer 和分项加总口径，插件本身从 4,837/6,663/7,786 增至 4,924/6,747/7,875，即增加 87/84/89 Token。分项抵扣开关收益后为净减少 355/404/440 Token；这不是线上实测的整个会话节省，也不代表前序路线图固定样本验收目标在本阶段重新通过。

证据保存在当前 Codex 任务产物目录的 `builtin-writes/`：`checks.json`、`logs/`、`measurement.json`、`plugin-prompt.json` 和 `source-manifest.json`。上一阶段的 `read-eval/measurement.json` 保持原样。
