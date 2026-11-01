# takeover 实测结果 — VCPChat（2026-10-30 22:42–22:50）

题源：`docs/takeover-eval-prompts-2026-10-30.md`。B 组（`registration: takeover` + `takeover: [read, glob, grep]`）已跑完，共 16 个会话（9 题，其中 7 题各跑 2 次）。
会话来源：`~/.dsh/sessions/--D-AI-VCPChat--/session-*/session.v4.jsonl.zstd`（多帧 zstd，逐帧解压）。
解析脚本：`scripts/eval-sessions.mjs`（汇总）、`scripts/show-session.mjs`（单个会话全流程）。

## 逐题

| 题 | 会话 | calls | steps | in | out | ctx 峰值 | 返回 KB | 墙钟 | 判定 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| Q1 模糊文件名 | `07cdede7` | 4 | 4 | 1,499 | 972 | 25.1k | 2.5 | 20.7s | ✓ fffind 首调命中 |
| | `11de5425` | 3 | 3 | 23,955 | 851 | 25.0k | 2.5 | 19.7s | ✓ |
| Q2 正则 IPC | `5708a39c` | 6 | 6 | 4,405 | 1,456 | 27.7k | 8.9 | 36.8s | ✓ 走内置 grep，未误路由 |
| Q3 多字面量 OR | `35682f65` | 1 | 2 | 1,642 | 496 | 23.9k | 0.6 | 12.2s | ✓ 一次 ffgrep |
| | `3cc90390` | 1 | 2 | 499 | 366 | 23.8k | 0.6 | 9.1s | ✓ |
| Q4 路径 glob | `0d33cb26` | 1 | 2 | 610 | 774 | 24.4k | 0.9 | 10.4s | ✓ 37 个 |
| | `b723278b` | 2 | 2 | 2,336 | 735 | 24.9k | 2.0 | 11.3s | ✓ |
| Q5 读一个定义 | `a80031a1` | 2 | 3 | 10,054 | 649 | 32.3k | 25.0 | 15.6s | ✓ 但多花一次 outline |
| | `9d3558ce` | 3 | 4 | 8,977 | 4,098 | 35.9k | 25.6 | 34.6s | ✓ 同上 |
| Q6 同名多定义 | `07037ae6` | 18 | 11 | 6,545 | 5,133 | 33.6k | 16.6 | 71.8s | ✓ 5 处 |
| | `f6be06f5` | 13 | 7 | 7,214 | 4,210 | 32.9k | 17.2 | 49.2s | ✓ 5 处 |
| Q7 长行命中 | `aa70c370` | 8 | 6 | 2,222 | 3,513 | 28.3k | 4.0 | 42.1s | ✓ excerpt 生效 |
| | `e195c4fd` | 5 | 5 | 3,580 | 4,340 | 29.4k | 4.8 | 39.4s | ✓ |
| Q8 IPC 闭环 | `79b5ef38` | 30 | 16 | 24,728 | 6,665 | 52.4k | 71.7 | 103.4s | ✓ 三处齐，含 1 次误路由 |
| | `81a536f5` | 27 | 15 | 26,017 | 5,677 | 53.8k | 81.5 | 88.7s | ✓ |
| Q9 拼错文件名 | `82212e00` | 13 | 8 | 35,873 | 3,357 | 38.9k | 31.3 | 77.5s | ✗ 题目前提不成立 |

合计：137 次调用 · 160,156 输入 tok · 43,292 输出 tok · 墙钟 642.5 s。

首轮上下文（system prompt 15.2k 字符 + 63 个工具 schema + 技能清单）稳定在 **23,310–23,762 tok**，跨题标准差 < 2%，可作为固定开销基线。

## Q7 是 takeover 生效的决定性证据

`vendor/three.min.js` 第 7 行 669,555 字节，`EllipseCurve` 在该行出现 5 次：

| # | 字节偏移 | 前后文 |
|---|---:|---|
| 1 | 491,064 | `{constructor(...)…this.type="EllipseCurve",this.aX=t…` |
| 2 | 491,091 | 同 1 处 `isEllipseCurve` 之后 |
| 3 | 500,001 | `CubicBezierCurve3:ql,EllipseCurve:Nl,LineCurve:Yl` |
| 4 | 501,252 | `s.isEllipseCurve?2*t:…` |
| 5 | 632,144 | `t.EllipseCurve=Nl`（UMD 赋值表） |

首次命中在 491 KB 处，**远超内置 grep 的 2000 字节行首预览** → 内置只能给出 `}fromJSON(t){…` 这类前缀，模型不可能看到匹配。实际两次会话拿到的都是以匹配为中心的 excerpt：

```
vendor\three.min.js Line 7: …}fromJSON(t){return this.arcLengthDivisions=…
class Nl extends Dl{constructor(t=0,e=0,n=1,i=1,r=0,s=2*Math.PI,a=!1,o=0){super(),
this.isEllipseCurve=!0,this.type="EllipseCurve",this.aX=t,… (line truncated)
```

excerpt 锚定第 1 处，因此模型报的邻项是 `type` / `this`（而非导出表那对）。两次会话都额外 `read` `vendor/three.module.js:36498-36501` 拿到 `CubicBezierCurve3` / `LineCurve`——**原标准答案给的标识符对应第 3 处命中，出题时选错了锚点**。

## 出题侧需修正的三处

| 题 | 原标准答案 | 实测 |
|---|---|---|
| Q6 | 4 处 | **5 处**，漏了 `Notemodules/notes.js:141`（`const` 箭头 + `delay` 形参，块作用域在 `DOMContentLoaded` 内）。两次会话都找到 5 处 |
| Q7 | `min.js:7` 邻项 `CubicBezierCurve3`/`LineCurve` | 该对在第 3 次命中（500,001）；excerpt 锚第 1 次（491,064），邻项是 `type`/`this`。两处都对，但题意需改写为「任一命中处的邻项」 |
| Q9 | 存在 `guidnace` 拼错文件 | **不存在**。`fffind mode=name` + 8 次 glob + 全盘扫描均无命中，题目作废 |

## 路由偏差

1. `79b5ef38` 第二次 `grep` 把 `path` 指到 `F:\DSH-NEXT\DSH NEXT\resources\app.asar`——问的是「当前仓库」，却去翻 DSH 自身安装目录，白跑一次。
2. Q5 两次都没按 guidance 走 `read file_path=<file>#<Symbol>`，而是先 `ff_read view=outline`（返回 21,560 B ≈ 5.4k tok）再取符号。直接 `#Symbol` 只要 4,077 B。**多花约 5.4k tok 换一次往返**，上下文从 23.3k 涨到 32.3k/35.9k。
3. Q9 在 fffind 未命中后扩展到全盘（`D:\` / `F:\` / `C:\Users`），不是工具问题，是模型不肯接受「不存在」。

## 成本结构

| 题 | 调用 | 墙钟 | 峰值 ctx | 说明 |
|---|---:|---:|---:|---|
| Q3 / Q4 | 1 | 9–12 s | 23.8k | 索引工具单次收敛，几乎零增量 |
| Q5 | 2–3 | 16–35 s | 32–36k | 符号读窗口 4 KB，但被 outline 拉高 |
| Q6 / Q7 | 5–18 | 39–72 s | 28–34k | 多轮交叉验证 |
| Q8 | 27–30 | 89–103 s | 52–54k | 题目要求三条链路闭合，模型展开到 7 处 + 空档分析 |

Q8 的贵不在 forge：标准答案只要三处（`appFeatures.js:232`、`preloads/api/features.js:11`、`tests/app-features.test.mjs:113`），模型给了三处 + invoke 包装 + 渲染装配 + contracts 生成图 + side-pane policy 空档。题面「有没有测试盯着它」边界太松。

## A 组（additive）对照 — 23:01–23:09，16 会话 8 题 ×2

| 题 | A calls | B calls | A in | B in | A 峰值 | B 峰值 | A 墙钟 | B 墙钟 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Q1 stramManager | 4 / 3 | 4 / 3 | 26,186 / 2,694 | 1,499 / 23,955 | 27.1k / 26.4k | 25.1k / 25.0k | 27.4 / 23.8 s | 20.7 / 19.7 s |
| Q2 正则 IPC | 6 / 9 | 6 / 6 | 4,352 / 11,317 | 4,405 / — | 27.9k / 36.7k | 27.7k | 33.1 / 37.1 s | 36.8 s |
| Q3 多字面量 | 1 / 1 | 1 / 1 | 1,622 / 437 | 1,642 / 499 | 24.0k / 23.9k | 23.9k / 23.8k | 10.4 / 9.1 s | 12.2 / 9.1 s |
| Q4 路径 glob | 1 / 2 | 1 / 2 | 605 / 1,927 | 610 / 2,336 | 24.2k / 25.6k | 24.4k / 24.9k | 9.7 / 16.8 s | 10.4 / 11.3 s |
| Q5 读定义 | 5 / 2 | 2 / 3 | 3,378 / 4,531 | 10,054 / 8,977 | 28.1k / 28.2k | 32.3k / 35.9k | 32.9 / 17.6 s | 15.6 / 34.6 s |
| Q6 debounce | 13 / 17 | 18 / 13 | 14,501 / 11,465 | 6,545 / 7,214 | 42.7k / 38.3k | 33.6k / 32.9k | 139.8 / 62.4 s | 71.8 / 49.2 s |
| Q7 EllipseCurve | 8 / 8 | 8 / 5 | 2,532 / 5,493 | 2,222 / 3,580 | 29.4k / 33.7k | 28.3k / 29.4k | **122.2 / 367.7 s** | **42.1 / 39.4 s** |
| Q8 IPC 闭环 | 17 / 36 | 30 / 27 | 9,915 / 21,078 | 24,728 / 26,017 | 37.0k / 49.6k | 52.4k / 53.8k | 79.7 / 96.8 s | 103.4 / 88.7 s |

同口径合计（B 组 15 个会话，已剔除作废的 guidnace；B 组 Q2 只跑了 1 次，A 组 16 个会话）：

| 指标 | A（additive） | B（takeover） | 差 |
|---|---:|---:|---:|
| 工具调用 | 133 | 124 | A +7% |
| 输入 tok（**非缓存部分，不是成本**） | 122,033 | 124,283 | 基本持平（+1.8%） |
| 输出 tok | 47,915 | 39,935 | A +20% |
| 墙钟 | 1,086.5 s | 565.0 s | **A +92%** |
| 剔除 Q7 后墙钟 | 596.6 s | 483.5 s | A +23% |

> `inputTokens` 只统计未命中缓存的部分，与会话间隔、缓存首字节位置强相关，**不能跨组当成本比较**。真正的成本代理是后文三方对比里的 `sum(totalTokens)`。

**所有墙钟差距的一半以上来自 Q7 一题**：A 组 122.2 s / 367.7 s，B 组 42.1 s / 39.4 s。

## Q7 是唯一有定性差异的题

A 组两次都必须绕开内置 grep 自己造轮子：

- `17e916f2`：`ffgrep` → `ff_read` ×4 → **`grep -o -E '.{45}EllipseCurve.{45}' vendor/three.min.js`** 才拿到行内上下文
- `70df6742`：`ops_bash` 6 次，其中 `rg` 在本机不存在、`grep -rIl` 全仓扫描 **撞 90 s 超时**，最后靠 `timeout 60 grep -rIl` 收场，总墙钟 367.7 s

B 组一次 `grep` 就带回匹配中心 excerpt，40 s 内收敛。这是 takeover 唯一不可替代的收益：**把「模型自己写 shell 抠上下文」变成「工具自带上下文」**。

副作用：A 组手工 `awk` 逐列算偏移，答案反而更细（给出 491,092 / 500,002 / 632,145 三个列偏移并区分 `isEllipseCurve` 子串）。B 组答案够用但没这么细。**准确度上 A 组不输，输的是墙钟和确定性。**

## 已修：Q5 的 outline 绕路

`src/guidance.ts` 原句把 `view=outline first` 放在最前：

```
- Understand a file → ff_read view=outline first; read one definition → read with file_path=<file>#<Symbol> ...
```

两组模型读到「读一个定义」时都先跑 outline（B 组 21,560 B ≈ 5.4k tok，A 组 `depth=1` 后约 9 KB），再取符号。**符号名题目里已经给了，这一步纯属多余。**

改成语序倒置 + 显式禁止：

```
- Already know the symbol → read with file_path=<file>#<Symbol> (e.g. src/store.ts#Store.save, no offset/limit):
  that definition only, no outline first. Need the names → ff_read view=outline (depth=1 for top level only);
  every definition of one name → view=definitions. A plain file read stays the built-in read — ...
```

同批改动：

| 项 | 内容 |
|---|---|
| `src/guidance.ts` | takeover 与 additive 两条 read 支路都改；outline 只在「不知道名字」时出现，并补 `depth=1` 提示 |
| `tests/run-registration.mjs` | 两条断言从 `includes('ff_read view=outline first')` 改为 `no outline first` + `Need the names → view=outline` |
| `tests/run-mount.mjs` | 同上，改为两条语义断言 |

代价与收益：

| 指标 | 改前 | 改后 |
|---|---:|---:|
| additive guidance | 485 tok | 500 tok |
| takeover guidance | 530 tok | 546 tok |
| Q5 预期上下文 | 32.3k / 35.9k（实测） | ≈24.3k（省 5.4k） |
| Q5 预期调用 | 2–3 次 | 1 次 |

涨 16 tok 换一次往返加 5.4k tok 的冗余读，比例约 1:340。

验证：重启 DSH 加载新 `lib/`，用第 5 题单跑一次，预期工具序列只有一条 `read`（`file_path=scripts/test-ui-system.mjs#defineWaStubs`）、上下文峰值 ≈24k。

### 复跑结果（`b4f2fffa`，23:19）

| 指标 | 改前 `a80031a1` | 改前 `9d3558ce` | 改后 `b4f2fffa` |
|---|---|---|---|
| 工具序列 | `ff_read outline` → `ff_read #Symbol` | `ff_read outline` → `view=body lines` | **`ff_read symbol` → `ff_read lines`** |
| 调用 | 2 | 3 | 2 |
| 首轮 ctx | 23,341 | 23,443 | 23,499 |
| 峰值 ctx | 32,256 | 35,888 | **25,221** |
| 返回字节 | 25.0 KB | 25.6 KB | **4.6 KB** |
| 墙钟 | 15.6 s | 34.6 s | 15.6 s |
| 答案 | L1011–1091（注明本体 1014）✓ | L1011–1091（注明 1014–1091）✓ | **L1013–1091 ✗ 差 1 行** |

**绕路消失**：第一条调用就是 `ff_read {path, symbol:"defineWaStubs"}`，没有任何 outline。返回字节降 82%，上下文峰值降 22–30%。

**但这次答错 1 行**：真实声明在 `L1014`（`1011-1013` 是三行注释），模型报 `L1013`。它第二次读了 `lines=L1008-1016` 共九行，信息完备，是数注释行时数成两行。问题不在信息量，在**头部标签**。

`ff_read` 的符号读头部只写 `L1011-1091`（含注释块的区间），没说声明行在哪。已修：

```
改前: #### scripts/test-ui-system.mjs#defineWaStubs · L1011-1091 · #1
改后: #### scripts/test-ui-system.mjs#defineWaStubs · L1011-1091 (decl L1014) · #1
      body=true 时: L1014-1091   （起始即声明行，无后缀）
```

`src/tools-read.ts:796-810` 改为 `start === sym.startLine ? 'L{a}-{b}' : 'L{a}-{b} (decl L{c})'`，18 字节消除歧义。`tests/run-read.mjs` 新增一组断言（`src/commented.ts`：默认读 `L1-6 (decl L4)`，`body=true` 读 `L4-6`）。

## 三个被证伪的预设

1. **「ffgrep 的多字面量 OR 是独占能力」** —— 错。A 组 `aa994be6` 用**内置 grep** 一次就查完 `defineWaStubs|rendererEntries`（正则 OR），1 次调用 / 23.9k 峰值 `/ 9.1 s`，比 B 组两次 ffgrep 都省。字面量 OR 只在「关键词含正则元字符」时才有优势。
2. **「Q5 的 outline 绕路是普遍现象」** —— 半对。B 组两次都先 `view=outline`（峰值 32.3k / 35.9k）；A 组 `d2d1f302` 同样走了 outline+symbol，但 `b35805ba` 用 5 次 `ff_read` 逐个读，峰值只有 28.1k。绕路不是 takeover 独有，是 `ff_read` 本身有多个入口造成的。A 组 Q5 峰值 28.1–28.2k vs B 组 32.3–35.9k，**takeover 在 Q5 上贵 15–27%**。
3. **「takeover 会让上下文更省」** —— 整体成立但不均匀。Q6 A 组 42.7k/38.3k vs B 组 33.6k/32.9k（B 省 20%）；Q8 反过来，A 37.0k/49.6k vs B 52.4k/53.8k（A 省 15%）。grep 的 excerpt 在普通短行上是纯增量（没有长行问题时它会多吐 ±160 字符）。

## 误路由：takeover 明显更好

| 题 | A 组实际工具 | B 组实际工具 |
|---|---|---|
| Q2（题面明确禁止当模糊搜索） | `ffgrep` ×3 / `grep` + `ffgrep` 混用 —— **2/2 误路由** | 内置 `grep` —— 2/2 正确 |
| Q4（路径模式） | `fffind` ×2 —— 未用 `ffglob`，结果正确 | 内置 `glob` —— 正确 |
| Q7（普通标识符搜索） | `ffgrep` 起手，失败后转 `ops_bash` | 内置 `grep` —— 正确 |

A 组的问题是**同类工具太多**（`ffgrep`/`grep`、`fffind`/`ffglob`/`glob`、`ff_read`/`read`），模型靠猜；takeover 的 guidance 直接按任务类型分派，把这条判断从模型手里拿走了。这是 token 数字看不出来、但实际影响最大的一项。

## 结论

**takeover 该开，但它买的不是 token。**

| 收益 | 量级 | 来源 |
|---|---|---|
| 长行/巨型文件命中的确定性 | Q7 墙钟 40.8 s vs additive 245.0 s（6.0×）、vs 无插件 51.6 s（1.26×），且不需要模型自己写 shell | `excerptGrep` 的匹配中心片段 |
| 同类工具不再被误选 | Q2 误路由 2/2 → 0/2 | guidance 按任务分派 |
| token | **不省，净增**：8 题一轮 1.16 M（无插件）→ 1.37 M（additive，+18%）→ 1.45 M（takeover，+25%） | 静态面 5.3–5.4 k × 每轮 |
| 墙钟 | takeover 每题 58.7 s → 37.2 s（−37%），additive 66.5 s（没有收益） | 工具返回量下降 + 少绕路 |
| 局部更贵 | Q5 +15–27%（已修）、Q8 +63% | excerpt 在短行上是纯增量 |

三组真值见下一节。旧版这里写的「token 基本打平（122.0 k vs 124.3 k 输入）」是拿 `sum(inputTokens)` 算的，只反映缓存命中差异，已作废。

下一轮若要再动，优先级：

1. **Q8 题面收窄** —— 「有没有测试盯着它」改成「列出直接断言这个通道的测试文件:行」，别让模型展开到 contracts 生成图和 side-pane policy。
2. **`ffgrep` 定位重新评估** —— 多字面量 OR 已被证伪不独占（正则 OR 内置就能做），specialist schema 里它只剩 fuzzy + 字面量两条，值不值这 418 tok 要单独算。
3. **takeover 下的 grep excerpt 长度** —— `EXCERPT_CONTEXT = 160` 在短行文件上是纯增量（Q6 多吐 ±160 字符 × 每命中），可考虑按行长度自适应：行本身短于 2000 字节时不替换。

---

## 三方对比：无插件 / additive / takeover

脚本：`scripts/measure-three-way.mjs`（复用 `apply()` 的真实注册路径，`--json` 未加，直接读 stdout）。

### 每请求固定开销（cl100k，只算 forge 的贡献）

| 模式 | 工具 | native | ptcTS | ptcPy | guidance | 命令 | 合计 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 无插件 | 0 | 0 | 0 | 0 | 0 | 0 | **0** |
| additive | 10 | 4,899 | 7,084 | 8,412 | 500 | 49 | **5,448** |
| takeover | 10 | 4,730 | 6,917 | 8,250 | 546 | 49 | **5,325** |

takeover 比 additive 省 123 tok：`ffgrep` −66、`fffind` −103（specialist schema 收窄），guidance +46（多写了一条 `enclosing` 与 `no outline first`）。

### 三组实测（真值，不再是推算）

无插件组：2026-10-31 00:00 把 profile 里 `dsh-forge` 与 `dsh-forge-http` 两条都写 `disabled: true` 后重启，同 8 题各跑 1 次。
分组按 `request/header` 的 `tools` 名单判定（有 `ff*` 才算装了插件），再用 guidance 文案分 additive / takeover —— 只看文案会把旧版 guidance 误判成无插件。
脚本：`scripts/eval-three-groups.mjs`。

| 组 | 会话 | 轮数 | sumTotal | 每轮均值 | 墙钟合计 |
|---|---:|---:|---:|---:|---:|
| 无插件 | 8 | 49 | 1,160,723 | 23,688 | 469.9 s |
| additive | 18 | 100 | 2,947,271 | 29,473 | 1,112.2 s |
| takeover | 16 | 91 | 2,846,943 | 31,285 | 580.5 s |

会话数不等，直接比总数没意义。按「每题一次」归一化（先算每题组内均值，再对 8 题取平均）：

| 组 | 轮/题 | sumTotal/题 | 8 题合计 | 墙钟/题 | 中位墙钟 |
|---|---:|---:|---:|---:|---:|
| 无插件 | 6.1 | 145,090 | 1.16 M | 58.7 s | 58.7 s |
| additive | 5.8 | 171,204 | 1.37 M | 66.5 s | 66.5 s |
| takeover | 5.9 | 181,651 | 1.45 M | 37.2 s | 36.6 s |

**答案：跑同样 8 题，additive 多花 18% token，takeover 多花 25%；takeover 换回 −37% 墙钟，additive 没有换回任何时间。**

`sum(inputTokens)` 不能当成本代理（只算未命中缓存那部分，随会话间隔剧烈波动）；上表全部是 `sum(totalTokens)`，即每轮重发的全量上下文。

### 逐题（每题组内均值）

`轮 / sumTotal / 工具返回 KB / 墙钟中位 s`。无插件每题只有 1 次，没有方差信息。

| 题 | 无插件 | additive | takeover | takeover vs 无插件 |
|---|---|---|---|---:|
| Q1 模糊文件名 | 7.0 / 151 k / 15.9 / 134.4 s | 3.3 / 86 k / 10.8 / 22.9 s | 3.5 / 85 k / **2.5** / 20.2 s | **−43%** |
| Q2 正则 IPC | 6.0 / 118 k / 6.5 / 35.9 s | 4.3 / 122 k / 15.3 / 26.1 s | 6.0 / 155 k / 8.9 / 36.8 s | +31% |
| Q3 多字面量 | 2.0 / 36 k / 0.5 / 10.3 s | 2.0 / 47 k / 0.6 / 9.8 s | 2.0 / 47 k / 0.6 / 10.7 s | +33% |
| Q4 路径 glob | 2.0 / 36 k / 0.9 / 13.5 s | 2.5 / 61 k / 0.9 / 13.2 s | 2.0 / 48 k / 1.4 / 10.8 s | +33% |
| Q5 读一个定义 | 3.0 / 55 k / 4.4 / 15.9 s | 4.0 / 103 k / 9.3 / 25.3 s | 3.3 / 95 k / 18.4 / 15.6 s | +73% |
| Q6 同名多定义 | 9.0 / 230 k / 25.8 / 130.0 s | 9.5 / 299 k / 37.0 / 101.1 s | 9.0 / 258 k / **16.9** / **60.5 s** | +12% |
| Q7 长行命中 | 7.0 / 152 k / 8.2 / 51.6 s | 8.5 / 234 k / 6.4 / 245.0 s | 5.5 / 143 k / 4.4 / 40.8 s | −6% |
| Q8 IPC 闭环 | 13.0 / 383 k / 67.4 / 78.3 s | 12.0 / 417 k / 46.4 / 88.2 s | 15.5 / 622 k / 76.6 / 96.1 s | **+63%** |

Q5 的 takeover 均值被两次修复前的跑法污染（`9d3558ce` 25.6 KB、`a80031a1` 25.0 KB）。修复后单跑 `b4f2fffa`：3 轮 / 73,445 tok / 4.6 KB / 15.6 s，对照无插件 3 轮 / 54,898 tok / 4.4 KB / 15.9 s —— **轮数与返回量已经打平，剩下的 +34% 就是纯静态面**。

### 临界点：插件需要把轮数砍掉多少才回本

每轮单价是硬的，回本只能靠少跑轮：

| 组 | 每轮成本 | 需要轮数降到 | 实测轮数 | 缺口 |
|---|---:|---:|---:|---:|
| additive | 29,473 | 23,688 / 29,473 = **80.4%**（−19.6%） | −4.9% | 14.7 pt |
| takeover | 31,285 | 23,688 / 31,285 = **75.7%**（−24.3%） | −3.3% | 21.0 pt |

同一批题里，只有 Q1 真正越过了这条线（轮数 −50%，token −43%）。Q7 差 1 轮就够（−21% 轮数，token 打平），Q6 轮数持平、靠工具返回量从 25.8 KB 压到 16.9 KB 把墙钟砍掉 53%。

换成一句话：**插件不是省 token 的，它卖的是「少绕路」。绕路本身要花多少轮，决定了这笔交易赚还是赔。**

### 正确性：三组都答对了

无插件组 8 题全部给出了实质答案，没有一题崩掉：

- Q1 自己纠了拼写（`stramManager` → `streamManager.js`），代价是 7 轮、134 s、15.9 KB 返回。
- Q7 内置 grep 只给 `Line 7: function(t,e){"object"==typeof exports...`（行首 2,000 字节，**不含 `EllipseCurve`**，4,728 B），模型被迫补一次 `grep -o '.\{50\}EllipseCurve.\{50\}'` 才拿到上下文。takeover 一次给 1,396 B 且带匹配。**这是唯一「不装插件就看不到答案」的场景，但模型自己也能补出来，只是多花一轮。**
- Q8 无插件 errHit=11（工具报错最多的一次），仍然收场。

所以这轮 benchmark 的结论不是「装了能答对、不装答不对」，而是「都答对，装的更快但更贵」。

### 已知输面，下一步

1. **Q8 takeover 15.5 轮 vs 无插件 13 轮**：装了插件反而多绕 2.5 轮、多 63% token。得逐轮看是不是 `ff_read`/`ffgrep` 被当成必经步骤。这是三组里最该修的一处。
2. **Q3 / Q4 纯付静态面**：2 轮就完事的题，插件不可能回本。除非静态面能压到 1 k 以内，否则这类题永远 +33%。可以考虑把 `ffread` 与 `ffgrep` 的 schema 描述再收窄，或者让 `prewarm` 之外的 6 个工具按需挂载。
3. **无插件组每题 n=1**：Q8 的 +63% 可能就是个例。要坐实需要每题再跑 2 次。目前只把它当方向，不当结论。

---

## Q8 为什么装了插件反而多绕（逐轮拆解）

三组里唯一明确变差的一题。把 5 条会话的每一步工具调用拉出来对齐后，原因很集中，不在轮数分布上，在**第一步**。

| 组 | 会话 | 步数 | 轮 | sumTotal | 第 1 步 | 第 2 步 |
|---|---|---:|---:|---:|---|---|
| 无插件 | `d26c5917` | 22 | 13 | 382,580 | `grep app-features:renderer-entries` → 6 匹配 | `grep renderer-entries` → 命中 `appFeatures.js:232` |
| additive | `ac96a01c` | 17 | 9 | 273,875 | `ffgrep ... context=4` → 首条是 `tests/app-features.test.mjs:113` | `fftrace` |
| additive | `b82314e2` | 36 | 15 | 560,629 | `ffgrep pattern=app-features` → 首条是 `.workbuddy/memory/MEMORY.md:133` | `ffgrep` 搜 `F:/DSH-NEXT/.../app.asar`，0 命中 |
| takeover | `79b5ef38` | 30 | 16 | 646,561 | `fftrace` → **三问全答完** | `grep` 再查一遍 |
| takeover | `81a536f5` | 27 | 15 | 597,198 | `fftrace` → 全答完 | `grep` 再查一遍 |

### 根因 1：`fftrace` 答对了，但用 2/3 篇幅自我否定

`fftrace target=ipc:app-features:renderer-entries` 的完整返回只有 677 B，内容是：

```
### 主进程 handler（1）
- `modules/appFeatures.js:232` · in installIpc · ipcMain.handle（literal）
### preload 暴露（1）
- `listAppFeatureEntries` · preloads/api/features.js:11 · 静态推导（无声明表）
### 直接 ipcRenderer 调用（1）
- `preloads/api/features.js:11` · ipcRenderer.invoke（wrapper）
```

**三问里的两问一次答完，全部标了 literal / 静态推导。** 但这一段在返回里排在后面，前面先出现的是：

```
- 范围：1941 文件 · 48 页面 · 无 preload 声明表（只有字面量边） · 446 推导键 · 含候选边
- 限制：311 项本地未解析（另有 4123 项外部包），2 项文件/工程问题；读取/解析失败 1 处，
  部分解析 1 文件，遍历失败 0 处，桥接接收者绑定未确定 3074 处。未找到仅表示已分析范围内无命中。
  - `rust_projectforge_indexer/tests/fixtures/broken_syntax.rs` · partial_parse
  - `vendor/mermaid.min.js` · file_too_large
```

三个大数字（311 / 4123 / 3074）跟「这个通道在哪注册」毫无关系，`含候选边` 更是全局状态 —— 而真正返回的那条边自己已经写着 `（literal）`。模型读到「含候选边 + 未找到仅表示已分析范围内无命中」，判断"这个结果不可引用"，于是第 2 步用 grep 重查、第 3 步用 read 复核。**两次 takeover 跑都是同一个动作序列**，不是偶然。

`src/tools-trace.ts:1266-1294` 里已经有一段「Two lines, not eight」的压缩注释，但压的是**行数**，没压**顺序**和**相关性**。

### 根因 2：guidance 亲手要求它再查一次

`src/guidance.ts:80` 结尾那句：

> `edgeMode defaults to all and includes labelled candidates: pass edgeMode=certain before reporting a dependency as fact.`

模型照做了，但没重跑 `fftrace`（那样又贵又慢），而是改用 grep + read 自己核。**一次查询变成三次，guidance 就是那把扳手。** 这句在真正需要"报依赖为事实"的场景（改动影响面）是对的，在"注册点在哪"这种 literal 边上纯属多余。

### 根因 3：范围膨胀 —— 从「6 处命中」到「1941 文件 48 页面」

「有没有测试盯着它」这一问，无插件用 7 次调用收敛，takeover 用了 17 次：

- 无插件停在 `tests/app-features.test.mjs` + `tests/chat-event-graph.test.mjs`。
- takeover 又翻了 `tests/domain-activator.test.js`、`tests/contribution-registry.test.js`、`scripts/run-all-tests.mjs`、`modules/ipc/sidePaneIpcPolicy.js`，尾部连续 3 次零命中（第 24/26/28 步）。

`fftrace` 开头那句「1941 文件 · 48 页面 · 446 推导键」给了一个**看起来存在但没法闭合的全局视图**，模型为了把它闭合，去验证图上多出来的节点。无插件的 `grep` 只给了 6 行，心理范围就是这 6 行。

### 数字拆解

Q8 的差额 239,300 tok（takeover 均值 621,880 − 无插件 382,580）大致三分：

| 来源 | 量 | 占比 |
|---|---:|---:|
| 静态面 5.9 k/轮 × 15.5 轮 | ≈ 91 k | 38% |
| 多出的 2.5 轮（后段边际 45–52 k/轮） | ≈ 125 k | 52% |
| 工具返回多 9.2 KB/次（≈2.3 k tok）× 15.5 | ≈ 36 k | 15% |

三项相加略超实测（区间重叠），但量级确定：**一半是可修的绕路，四成是插件的固定门票，一成多是返回变大的副作用。**

对照组 Q2 证明「门票」和「绕路」是分开的：takeover 与无插件**都是 6 轮**，路径几乎一样（`grep app-features` → `grep app-features:` → `read appFeatures.js:215`），token 118 k → 155 k 的 +31% **全部是静态面**（6 轮 × 6 k = 36 k）。这种一次就成的题没有绕路可修。

### 可修的三处，按收益排序

1. **`fftrace` 把 caveat 移到答案之后，并按相关性过滤**（`src/tools-trace.ts:1266-1294`）
   - 答案块先出，`范围/限制` 后置。
   - `外部包未解析`、`桥接接收者绑定未确定` 这类全局数字，只在本次 query 的边真的受影响时出现；否则压成一行尾部或在 `complete: true` 时省略。
   - 本次返回的边全是 literal 时，不再打「含候选边」—— 那条边自己已经标了 literal。
   - 预期：Q8 省 2 轮 ≈ 100 k tok，把 +63% 压到 +20% 左右。

2. **`edgeMode=certain` 那句加适用条件**（`src/guidance.ts:80`）
   - 改成「报**跨文件依赖**为事实前先 `edgeMode=certain`；literal 或 static 边不必」。
   - 预期：直接消除第 2 步那次重查。

3. **`ffgrep` 的默认排序与范围**（additive 侧，`b82314e2` 36 步的成因）
   - 首条命中 `.workbuddy/memory/MEMORY.md` —— 记忆文件被当源码搜；源码目录应加权。
   - 字面量失败静默退化成正则重跑（`[no literal matches — automatically retried as regex]`），模型不知道自己搜错过，该重试时它会换工具而不是换模式。
   - 预期：additive 的 Q8 从 36 步降到 20 步以内。
