# Takeover specialist surface trace

日期：2026-10-30。范围是 takeover 注册面与搜索工具协作，不是生产发布或真实模型 A/B 验收。

## 变更

接管 `grep`/`glob` 时，宿主内置工具继续拥有 plain、regex 和 glob 路径列举；相应的 `ffgrep`、`fffind` 不再整行移除，而是保留无法由宿主 schema 表达的 specialist。未列入 takeover 的搜索项保持完整 schema：

- 接管 `grep` 时，`ffgrep` 单 pattern 默认 fuzzy，或接受 `patterns` 多字面量 OR；显式 plain/regex 返回路由错误。
- 接管 `glob` 时，`fffind` 保留 typo-tolerant `mode=name`；`mode=glob` 返回路由错误。
- 没有 `tools/execute` 环绕分发点的旧宿主回退到 additive，注册完整 schema，避免静默丢失能力。
- guidance 按 `grep` 与 `glob` 是否分别接管生成，单项接管不会误导另一项的参数面。

## 离线 surface 体积

对工具工厂的 `name + description + parameters` JSON 做字节统计；表中的 token 当量按序列化字符数除以 4 粗估，不是 DeepSeek 实际 tokenizer 计费。

| 工具 | additive | takeover specialist | 变化 |
|---|---:|---:|---:|
| `ffgrep` | 1,790 B / ~446 tokens | 1,342 B / ~335 tokens | -25.0% |
| `fffind` | 1,270 B / ~315 tokens | 952 B / ~237 tokens | -25.0% |

两行合计约少 189 个 token 当量；真实 tokenizer 下的变化尚未测量。

这个收益来自去掉重复的 host-owned 模式，而不是把 specialist 能力删除。

## 可复现验证

- `pnpm typecheck`：exit 0。
- `pnpm build`：exit 0。
- `pnpm test`：exit 0；完整套件通过。`run-augment-host.mjs` 与 `run-host-integration.mjs` 因本机未设置 `DSH_FORGE_HOST_MODULES` / `DSH_FORGE_DSH_MODULES` 明确跳过。
- `pnpm pack --dry-run`：exit 0，包含 `lib/augment.js`、当前入口和类型声明。
- `DSH_FORGE_BENCH_CORPUS=D:\\AI\\dsh-plugins\\dsh-forge pnpm bench`：exit 0；语料 238 个 indexed files，cold-to-first-result 0.12 s，RSS 增量 11 MB；warm `ffgrep` p50 6.52 ms / p95 14.67 ms，`rg` spawn p50 147.73 ms；warm `fffind` p50 1.91 ms，`rg --files` p50 37.16 ms。

## Pareto 边界

在当前小仓库和离线宿主契约上，这轮是局部 Pareto 改善：普通搜索交给宿主以保留语义/UI/超时/输出闭环，索引工具只暴露额外能力，同时降低 specialist schema 体积。它不能推出全局 Pareto 最优，原因是尚未有真实 DSH tool dispatch、完整宿主 prompt、模型调用轨迹和大型工作区冷启动数据。

下一道验收门应在配置了真实 DSH 模块的 profile 上，固定任务集比较 additive/takeover 的工具选择、轮数、错误路由、上下文 token、冷/热延迟与内存；只有正确性不退化且在独立工作区重复，才能把结论升级为生产 Pareto 判断。Rust 重写应在该 profile 和真实 workload 的 profile 之后决定，不能用语言替换本身代替闭环证据。
