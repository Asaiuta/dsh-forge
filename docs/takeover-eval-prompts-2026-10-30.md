# takeover 效果验证 — VCPChat

测仓库：`D:\AI\VCPChat`（3,464 个索引文件；`*.js` 19,047、`*.ts` 11,831、`*.md` 2,093；含 `vendor/*.min.js` 单行 67 万字节）。

两组各跑一遍，除 `registration` 外不做任何改动：

| 组 | profile `cordis.patch.yml` |
|---|---|
| A | `registration: additive` |
| B | `registration: takeover` + `takeover: [read, glob, grep]` |

每题开新会话（同一会话里第二题会继承上下文，token 不可比）。每轮开始前记一次 `/forge-status`，结束后再记一次。

## 每题记录什么

| 项 | 来源 |
|---|---|
| 工具调用序列（名字 + 关键参数） | 会话里的工具卡片 |
| 答案对错 | 对照下面的「标准答案」 |
| 输入 / 输出 token | 会话 usage |
| 墙钟 | 首字到末字 |
| served / declined 增量 | `/forge-status` 两次读数相减 |

首轮含冷索引（约 2.9 s），单独标记，不进中位数。

---

## 1 模糊文件名

```text
只读任务。在当前仓库里找一个名称可能拼错成 stramManager 的文件，报告它的实际路径和大小。
不要修改任何文件，并说明你调用了哪个工具、参数是什么。
```

- B 期望：`fffind` `mode=name`
- 标准答案：`modules/renderer/streamManager.js`，99,631 字节 / 2,265 行
- 判定：路径完全正确即算对

## 2 正则内容搜索（不应误路由）

```text
只读任务。用正则找出所有注册名为 app-features 开头的 IPC 通道的地方，给出文件与行号。
不要把它当成模糊搜索，不要修改文件，并说明你用了哪个工具。
```

- B 期望：**内置 `grep`**（plain/regex 归内置；误用 ffgrep 记一次误路由）
- 标准答案：`modules/appFeatures.js:232`（`ipcMain.handle('app-features:renderer-entries', …)`）
- 判定：文件与行号正确

## 3 多字面量一次 OR

```text
只读任务。在一次工具调用里同时查找 defineWaStubs 和 rendererEntries 这两个标识符，
列出各自的文件和行号。不要修改文件，记录实际调用的工具和参数。
```

- B 期望：`ffgrep` `patterns=[...]`
- 标准答案：`scripts/test-ui-system.mjs:1014`（`function defineWaStubs()`）、`modules/appFeatures.js:217`（`rendererEntries() {`）
- 判定：两处都给出；分两次调用则该题不计入「一次 OR」的收益

## 4 路径 glob

```text
只读任务。列出 preloads/api 下所有 .js 文件的路径，只要路径不要内容。不要修改文件。
```

- B 期望：**内置 `glob`**
- 标准答案：`preloads/api/` 下 37 个 .js（含 `features.js`）
- 判定：集合完整、无多余文件

## 5 读一个定义（不用整读）

```text
只读任务。读取 scripts/test-ui-system.mjs 中 defineWaStubs 这个函数的完整定义，给出起止行号。
不要先读整个文件，说明你用的工具和参数。
```

- B 期望：内置 `read`，`file_path=scripts/test-ui-system.mjs#defineWaStubs`
- 标准答案：`scripts/test-ui-system.mjs:1014-1091`（77 行）
- 判定：行号正确 + 函数体完整
- 对照：整文件 74,255 B ≈ 16,811 tok；窗口 3,787 B ≈ 819 tok

## 6 同名多定义

```text
只读任务。仓库里有多个文件各自定义了 debounce，把这些定义全部列出来（文件与行号），
说明它们是否同名同签名。不要修改文件。
```

- B 期望：`ff_read` `view=definitions` + `symbol=debounce`（或 `occurrence` 逐个取）
- 标准答案：**5 处** —— `Forummodules/forum.js:1702`、`Memomodules/memo.js:1626`、`ProjectForgemodules/projectforge.js:581`、`Logmodules/log.js:513`、`Notemodules/notes.js:141`（`const` 箭头 + `delay` 形参，块作用域在 `DOMContentLoaded` 内）；签名 `(func, wait)` ×2、`(fn, wait)` ×2、`(func, delay)` ×1
- 判定：5 个文件齐全；漏 1 个算部分失败
- 注：原写 4 处，漏了 `notes.js`，2026-10-30 实测后修正

## 7 长行命中（信息能否被看见）

```text
只读任务。在仓库里搜索 EllipseCurve，报告它出现在哪个文件的第几行，
以及它在所在行里紧邻的前后两个标识符。不要修改文件。
```

- B 期望：内置 `grep`（命中行 669,555 字节，超出内置 2000 字节预览预算 → 由增强把匹配中心片段给模型）
- 标准答案：`vendor/three.min.js` 第 7 行。该行 `EllipseCurve` 出现 5 次，偏移 491,064 / 491,091 / 500,001 / 501,252 / 632,144；excerpt 锚定**第一次**（491,064，类定义处），邻项是 `type` 与 `this`；第 3 次（500,001）在导出表里，邻项才是 `CubicBezierCurve3:ql,` 与 `LineCurve:Yl,`
- 判定：**能说出该行任一命中处的前后标识符即算对**。只说文件行号、说不出邻项 = 内置预览没让它看到匹配
- 注：原答案只给了导出表那对，未说明 5 处命中与 excerpt 锚点，2026-10-30 实测后修正
- 这正是 additive 组应当失败的一题（首次命中在 491 KB，内置只给行首 2000 字节）

## 8 IPC 两端闭环

```text
只读任务。搞清楚 app-features:renderer-entries 这个 IPC 通道在主进程哪里注册、
渲染侧通过哪个 preload API 调用它，以及有没有测试盯着它。给出文件与行号，不要修改文件。
```

- B 期望：`fftrace` `target=ipc:app-features:renderer-entries`（或 grep→read 组合）
- 标准答案：注册 `modules/appFeatures.js:232`；preload `preloads/api/features.js:11`（`listAppFeatureEntries: invoke(...)`）；测试 `tests/app-features.test.mjs:113`
- 判定：三处齐全

## 9（可选）改动前的依赖摸底

```text
只读任务。如果我要改 modules/renderer/streamManager.js 里 createStreamProjection 的行为，
列出会被影响的文件。明确区分「确定的依赖」和「候选/不确定的边」。不要修改文件。
```

- B 期望：`fftrace` `target=impact:modules/renderer/streamManager.js`，并在结论里区分候选边（`edgeMode=all` 会带标注候选）
- 判定：结论中是否**把候选当事实** —— 这是 `edgeMode=certain` 那条提示词的检验点
- 状态：2026-10-30 未跑（当天跑的是下面那题拼错文件名）

## 附：本轮实际跑的第 9 题（原题前提不成立）

```text
只读任务。查找名称可能拼写为 guidnace 的文件。报告实际调用的工具、参数和找到的路径，不要修改文件。
```

- 实测：`D:\AI\VCPChat` 下根本没有这个文件，`fffind mode=name` + 8 次 glob + 全盘扫描均无命中
- 判定：题目作废。要找拼错文件的场景用第 1 题（`stramManager` → `modules/renderer/streamManager.js`）

---

## 判读口径

- 第 7 题是唯一「additive 必然答不出」的题；若 A 组也能答对，说明内置预览预算与假设不符，先复核再比。
- 第 2、4 题考的是**不误路由**：B 组调用 ffgrep/fffind 反而算退步。
- 其余题两组都可能答对，比的是 token 与轮数。
- 一组只跑一次不够：至少 2 轮，第 1 轮标冷启动。
