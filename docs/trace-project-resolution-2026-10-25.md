# Trace 工程解析、证据筛选与热态核查

本轮在上一轮交付工作树上继续实现，仍为 9 个工具、单一 `fftrace` 入口。新增可选参数 `edgeMode: "all" | "certain"`，默认包含候选；未提交、推送或发布，未修改 DSH profile、重载宿主或发送模型请求。

## 完成内容

### JS/TS 工程解析

- 发现根内 `tsconfig.json` / `jsconfig.json`，读取相对 `extends` 和 `references` 指向的配置；JSONC 支持注释与尾逗号。
- `paths` 支持精确键、单星号、最长前缀和声明顺序规则、多目标顺序回退；`baseUrl`、多份继承和子配置覆盖保留声明路径语义。
- 区分 TypeScript 的相对/基础目录扩展替换与 `paths` 显式扩展名目标的精确文件优先。星号捕获的扩展名不冒充配置目标的显式扩展名。
- `files/include/exclude`、隐藏路径、`allowJs`、默认输出目录排除用于判定根成员；显式根内兄弟成员可参与，歧义停止推断。引用子配置可以继承 solution 配置，不误报继承循环。
- 根 npm/yarn `workspaces` 与 pnpm 字面量 `packages` 列表识别本地包，支持排除模式、包自身引用、`exports/imports` 精确/单星号入口、`main/types` 和包入口转发。同名包停止猜测。
- 条件分支作为候选；CTS/MTS、显式 module、NodeNext 与 package type 选择 import/require，未知 TS 编译上下文保留两者候选。缺失可选产物会报告问题，并保留其余可用候选。
- 工程元数据每文件最多 256 KiB，总读取预算 2,000 文件 / 8 MiB。内容摘要、相关存在性和链接身份参与图缓存失效；不运行配置、加载器或包管理器。

`certain` 表示在读取到的静态规则下目标可解析。workspace 包的确定性基于已识别的本地映射，不证明实际安装器选择了同名包的哪个版本。（2026-10-26 更新：program 导入闭包已按 TS 5.9 规则实现，见 trace-program-closure-2026-10-26.md；归属为空的文件仍停止包名回退。）

### 证据和诊断

每条已解析文件边新增 `evidence: {confidence,basis,config?}`。`file:/impact:/path:` 可用 `edgeMode=certain` 排除候选；两种查询模式独立缓存，同一行指向相同目标的候选和确定证据分别保留，不受导入顺序影响。ambient 声明仍是声明提供者候选。

`diagnostics` 返回未解析项 `path/line/spec/reason/detail?/config?` 与文件/配置问题，各最多 100 项并保留总数和截断标记。JS/TS 原因区分非字面量、缺失目标、外部包、歧义、配置限制、根外路径。其他语言的既有解析器未暴露细因时使用 `unsupported_resolution`，不伪造更具体结论。读取/解析失败保留具体错误，部分解析仍可见；已知配置/归属限制进入 `incomplete`。

```json
{"target":"path:src/main.ts -> src/service.ts","edgeMode":"certain"}
{"target":"impact:packages/core/src/index.ts"}
{"target":"file:src/main.ts"}
```

配置、JS 文件解析、包入口和工程读取分别放在 `js-config.ts`、`js-resolution.ts`、`js-packages.ts`、`js-project.ts`，公共证据模型放在 `trace-evidence.ts`；沿用原 facts/worker/graph 管道。

## 验证与交付身份

冻结版本的 `pnpm run check`、`pnpm test` 均 exit 0：**34/34 测试入口实际执行、无跳过**。新增工程解析 24 组，部分预期结果独立对照本机 TypeScript 5.9.2 / Node 24.9.0；安装版 SDK 宿主 25 组通过。既有手写边真值保留 JS/HTML 54 TP / 0 FN / 0 FP、Python/Rust/C/C++ 38 TP / 0 FN / 0 FP。

独立审查找到并修复多继承覆盖、根/隐藏目录成员、兄弟 files、配置归属不明时误回退、条件导出与缺失分支、CTS/MTS 模式、无效包目标、空 wildcard 捕获、同一行证据去重和 paths 精确文件优先级问题。修复后另有 18 个离线边界及两种证据顺序复核，最终无剩余 P1/P2。

初次全测在旧宿主锁测试失败：固定等待 30 ms 不保证编辑已到达锁。改为等待实际共享锁请求后再释放并发写；单独运行与最后两次完整运行均通过，生产编辑/宿主代码未改。失败日志保留，最终通过记录为 `delivery-{check,test}.log` 与 `delivery-results.json`。

| 冻结对象 | 文件数 | SHA-256 |
| --- | ---: | --- |
| src | 54 | `074af275ab68959e0a43b084ff359691bd8c64a09d35792ae47545d1243b5ce2` |
| lib | 171 | `724926d3a1c9a9dec4c683ff048910e815fb36e87e9652436eaa507b74392db4` |
| tests | 41 | `1cd302a75ef4e0ff9d7e8549ee595d39b7ab4bc8c8c640d7ab3e154b3063080c` |
| scripts | 8 | `83902cc391231d0352588b5cc8b48686b825971610032d5a70790b8fa4610881` |

本轮仅改变约定的 9 个源码文件、4 个测试文件、README 和 package 测试链；更早工作树改动保留。基线 lib 为上一轮最终交付 `94cdd981ffd36223f69ac76cc7feb5ad40f02c1cab099dd2ae8fee24aaa34255`。测量后审计确认源码/构建/测试/scripts 均未漂移。

`git diff --check` 与 npm pack dry-run 通过，包清单 176 项；新模块声明齐全，无临时 SDK/fixture、废弃声明或发布文档坏链。安装版 SDK 的离线 additive/takeover 投影均为 9 个工具；输入变化仅 `fftrace.edgeMode` 可选参数，其他输入契约不变。native schema 增加 378 字节，PTC TypeScript / Python 分别增加 995 / 1,112 字节；均为离线插件贡献，不是实际模型请求计费数据。

## 热态核查与性能

先对 Round6、Round7 冻结构建分别采样，每仓一次冷扫描后连续 8 次热扫描。两者共同热点为逐文件 stat 与图缓存的缺失目标探测；采样不支持把上一轮约 20% 差异归因为新增语言模块。此次将缺失 stat 改为 `throwIfNoEntry:false`，目录遍历携带已知相对前缀，减少异常与重复路径运算；保留全部存在性及失效校验。

最终配对测量使用同一固定 JS/HTML/TS 源文件集合（没有工程元数据），每仓每版本 3 个新进程、每进程 1 冷 + 3 热，第二轮逆序，本任务测试/构建/性能任务不并发，不清系统缓存。计时为 `assembleTraceGraph` 扫描至组图，序列化与断言在计时外；Node 24.9.0、i5-12500H、parallelism=16。

| 集合 | 文件 | 基线冷态中位 ms（范围） | 最终冷态中位 ms（范围） | 基线热态中位 ms（范围） | 最终热态中位 ms（范围） |
| --- | ---: | ---: | ---: | ---: | ---: |
| VCPChat | 1,691 | 5,258.884（5,173–15,951） | 5,144.194（4,951–5,405） | 396.358（294–534） | 430.522（397–531） |
| VCPToolBox | 1,430 | 7,081.221（6,693–18,646） | 7,276.511（6,038–9,009） | 494.719（360–845） | 432.790（254–1,084） |

冷态分别约 -2.2% / +2.8%，热态约 +8.6% / -12.5%。每格冷态 3 样本、热态 9 样本，范围重叠且存在明显外部负载，不能宣称稳定提速或完全无回归。没有重测 ProjectForge，也不拼接历史倍率。

每版本的冷/热完整图均字节稳定。跨版本不再字节相同：新增证据/诊断字段，外部包占位行移入结构化未解析项；Toolbox 的声明扩展查找新增 8 条 `.d.ts` 边。原已解析文件边无删除：Chat 2,408 → 2,408，Toolbox 3,172 → 3,180。全部 facts、IPC、bridge、globals、pages、membership 和覆盖度保持一致。parseErrors 均 1，partialFiles 分别 82 / 3，walkErrors 均 0。

完整图 SHA-256：Chat 基线 `d752dfc81d9c09b74765f4be2c991f195fe239b406b4904efb4b69aa3e5c80e4`，最终 `0553b65a926f371d5632ace0180be267c5b06133ca4cfbd711ff10ec28a52d53`；Toolbox 基线 `37983dce8ba4fbc1b2d7b7757b0edb31cc5e741367cd1ab2fb7b10ee62329d6d`，最终 `facde50735b25cbb10d4b0a0f3cfa83ce82b1c45a6250664eda12fd4b7853a93`。

另构造本地 1,000 个 TS 文件、11 配置、10 workspace 包的确定链，包含 paths、继承、references 和跨包 exports；3 个独立进程每次全图均为 **999 TP / 0 FN / 0 FP**，certain 路径长度 999、查询 complete=true，输出按预算截断。冷态中位 584.545 ms（577–776），热态 153.419 ms（135–179）；完整图跨冷/热/进程一致。此为合成工程子集验证，不能替代真实大型 TS 工程的完整边真值，也不与不支持这些边的旧版本比较速度。

## 剩余边界

仍未提供包管理器实际链接/版本选择、可执行 bundler alias、自定义 loader、完整类型/调用图与类型级符号消歧（program 导入闭包已于 2026-10-26 交付）。包映射数组、复杂 YAML、包名 extends、rootDirs/moduleSuffixes/customConditions 等明确保持限制。其他语言工程配置、原生 Trace facts 后端、C# Trace、FFI 绑定与 Mach-O/archive 仍是后续独立工作。

本地证据位于 `.tmp-analysis/trace-round8/`：冻结清单、前后构建、命令日志、CPU profile、12 个配对性能进程、千文件配置夹具与最终审计均保留，不进入 npm 包。上述统计只证明各自验证集合。
