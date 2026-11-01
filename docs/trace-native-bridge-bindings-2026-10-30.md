# Trace：桥接绑定下沉到 Rust sidecar（2026-10-30）

接续 [事实提取迁入 Rust sidecar](trace-native-facts-2026-10-26.md)。那轮把逐文件事实搬进了原生进程，但漏了桥接绑定需要的三个字段，于是每次冷查询都要用 WASM 把整个仓库再解析一遍。本轮补齐这些字段，并把一个在这条路径上被放大的平方级扫描修掉。

## 缺口是什么

`supplementBridgeBindings`（`src/tools-trace.ts`）在 sidecar 返回事实后，用 WASM 重新解析所有带 `window.<global>` 访问的文件，只为了补三样东西：

- `receiver`：该访问点的接收者是不是本地变量、是否经由别名、绑到哪个声明。
- `span`：事实节点的精确坐标，`spanKey` 用它做别名身份。
- `binding`：能判定到某条声明时的声明坐标。

Rust 侧一个都没有输出，所以 supplement 对 1,883 个文件全命中，耗时 12–15 s，而其中 58 个文件本来就有新事实可用。**这里的工作是重复的：原生进程刚解析完，Node 又拿 WASM 解析了一遍同一份文本。**

## 做了什么

### 1. Rust 输出 `receiver`

新增 `rust_indexer/src/facts/bridge.rs`（357 行），移植 `src/facts.ts` 的 `BridgeScopes`：

- 两遍走：`index` 建作用域树与声明表（函数/块作用域、`const`/`let`/`var`、参数、`catch` 绑定），`writes` 记录重新赋值。
- `receiver(node)` 逐级向上查声明，区分「本地变量」「经由别名」「跨文件未定」。别名判定走 `bridgeAliases`，与 TS 侧同一条规则。
- `collect` 侧在 `bridge`、`ipc`、`globalsUsed`、`globalsDefined`、`exposes` 上带 `span`，在 `bridge` 上带 `receiver`。
- `import.meta` 这条伪桥接点补了一个 `plain_local("import")` 的接收者——WASM 的语法把 `import.meta` 解析成成员表达式，其 object 节点就是本地标识符 `import`，两边必须给出同一个形状。

### 2. `span` 的列口径

WASM 的 `web-tree-sitter` 喂进去的是 UTF-16 字符串，所以 `startPosition.column` 数的是 UTF-16 码元；原生 tree-sitter 数的是字节。`spanKey` 是别名身份，两边必须同口径，于是原生侧把字节列换算成 UTF-16 列。纯 ASCII 文件两者相等，直接跳过换算。

### 3. 一个被 `span` 引爆的平方级扫描

第一版换算按「从字节位置向前找到行首，再数前缀的 UTF-16 长度」写。压缩后的 bundle 只有几行、每行几百 KB，`three.min.js` 有 15,725 个桥接点，一个点扫一整行 = 几十 GB 的读：

| 文件 | 首版 | 现在 |
| --- | ---: | ---: |
| `vendor/three.min.js`（654 KB） | 17.7 s | 0.86 s |
| `vendor/pixi.min.js`（800 KB） | 2.8 s | — |

`tree_sitter::Point.column` 本身就是行内字节偏移，行首位置是 `byte - column`，O(1)。**这里没有算法问题，只有一次多余的扫描。**

顺带把 `BridgeScopes` 的两遍遍历改成共用一个 `TreeCursor`：原来每个节点 `node.walk()` 都要新建一个游标。

### 4. `symbol` 键的形状

Rust 的 `skip_serializing_if` 让缺省的可选字段直接不出现，而 WASM 提取器写的是 `symbol: undefined`。作为 JSON 两者相同，作为活对象不同——调用方是逐个对象比较图的。`indexer-client.ts` 收包后给这几类事实补回键，代价是每条约一次 `in` 检查。

## 结果

Windows、i5-12500H、Node v24.9.0，语料 VCPChat（1,942 个候选、2,324 个探针）。每次新进程，三次取中位数。

| 路径 | 冷查询 | 热查询 |
| --- | ---: | ---: |
| 旧 sidecar（无 `receiver`，全量 WASM 补算） | 13,167 ms | 177 ms |
| 纯 WASM（`DSH_FORGE_INDEXER=0`） | 14,906 ms | 358 ms |
| 新 sidecar | **8,508 ms** | 181 ms |

相对上一版少 35.4%，相对纯 WASM 少 42.9%。热查询没有变化——热态的成本在探针列举与 stat，不在解析。

### 正确性

`rust_indexer/parity-facts.mjs` 全量（2,038 个文件）：

| 语言 | 文件 | 逐字节相同 | 干净文件差异 | 语法错误文件差异 |
| --- | ---: | ---: | ---: | ---: |
| javascript | 1,857 | 1,847 | **0** | 9 |
| typescript | 12 | 11 | **0** | 1 |
| rust | 118 | 117 | **0** | 1 |
| python | 49 | 49 | **0** | 0 |
| tsx | 2 | 2 | **0** | 0 |

剩下的差异全在恢复路径上：两套 grammar 版本对同一段坏语法给出的恢复树不同，本轮之前就是这样。

更强的证据是图本身：新 sidecar 与纯 WASM 的 `graphBytes` 都是 1,530,195，`bridgeByObject` 逐项相同，`unboundBridge` 都是 3,074。

**而旧 sidecar 的 `unboundBridge` 是 2,803 —— 少了 271 条。** 缺 `receiver` 时 `recordMemberAccess` 会走 `bridge === null` 的分支，把本该「未绑定」的访问点判成了已绑定。所以上一版不只是慢 35%，它还在跨页/本地变量遮蔽的场景里多报了绑定。**这个缺口从来没被测试抓到，因为没有任何测试比较过「旧二进制 + supplement」与「纯 WASM」的图。**

## 测试

`tests/run-trace-cache.mjs` 原来靠「装上这个二进制、假装它没有 receiver」来验证 supplement 的降级路径——补齐后这条路径对当前二进制不存在了，测试因此变红。改成两条：

1. `setIndexerReplyTransformForTest` 把 `traceFacts` 回包里的 `receiver` 剥掉，模拟旧二进制：这些文件必须退化成一条严格字节读取、报 `bridge_binding_unavailable`，并在字节点修复后重新绑上。
2. 当前二进制：同一个坏字节文件直接绑上，`partialFiles` 为 0，不再需要第二遍解析。

新增的 `setIndexerReplyTransformForTest` 与既有的 `setIndexerTransportForTest` 不同：前者改写真实回包，后者整体替换传输。

64 个测试入口全绿。

## 还剩什么

冷查询 8.5 s 的分法：`traceFacts` 7.7 s、组图 0.75 s、其余 0.2 s。**大头回到了原生解析本身**，这是 CPU 上限，不是我能在 TS 侧再挤的东西。

若要继续，方向是「别把事实搬来搬去」——Rust 内直接组图，只回节点与边。但那是另一个工程，而且必须先有逐字节的 golden 对照才算数。
