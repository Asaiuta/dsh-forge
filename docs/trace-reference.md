# Trace 参考

`fftrace` 的扫描范围、语言支持与查询语义。README 只列能力，具体边界在这里。

## 扫描范围与缓存

首次扫描使用并行事实提取；全仓别名只做内存筛选，不再触发二次解析。同一工作区的重叠请求共享扫描，后续请求按文件 stat/ctime、声明表及被探测依赖的存在性验证缓存。文件新增、修改、删除或声明表变化会失效。

输出的 `parseErrors`、`partialFiles`、`walkErrors`、`resolutionLimited` 与 `incomplete` 表示分析覆盖度；出现失败、部分解析、截断时，“未找到”只针对已分析范围。

根 `.gitignore` 生效，跳过 `node_modules` / `.git` / `.dsh` 和目录链接；候选上限 20,000，源码上限 2 MiB，二进制上限 32 MiB。

## 支持的语言

查询形式为 `file:src/lib.rs`、`file:pkg/service.py`、`file:native/main.cpp`。被引用的 `.txt`、`.inc` 等资源也可反查引用者，内容不参与解析。

| 语言 | 静态文件依赖 | 解析边界 |
|---|---|---|
| JS / TS | 相对 import/require、HTML script；无顶层 import/export 的脚本中，精确名称 `declare module "name"` 可作为裸模块声明目标 | 不模拟包管理器、通配 ambient module 或模块增强合并；重复声明不任意选文件。 |
| Rust | `mod`、内联模块作用域、直接 `#[path]`、字面量 `include!` / `include_str!` / `include_bytes!`，以及分组、别名、`crate/self/super` 形式的 `use` 模块候选 | 按常见 Cargo 入口和真实 `mod` 树确定归属；不展开宏、条件编译、重导出或 `extern crate`。模块归属工作预算 20,000、深度 64；达到预算停止 `use` 推断，标记 `resolutionLimited` 和 `incomplete`。 |
| Python / PYI | 工作区根下的 import/from；字面量 `__import__`、已确认 importlib / import_module 别名及字面量 package 相对导入 | 不执行 Python 或推断 sys.path；动态表达式保持未解析。发现 loader 名称绑定或遮蔽时保守停止该名称的动态推断。`from` 子模块保留候选标记。 |
| C / C++ | 本地 include 与显式编译目录；C++20 顶层命名模块、同模块分区和头文件单元的候选依赖 | 不推断编译器隐式目录或 BMI 构建映射、不展开宏/条件编译/响应文件。模块提供者重复时拒绝选取；部分模块语法仍保留上游 grammar 的 partial 标记。头文件不继承未证实的编译单元配置。 |
| Go | 最近 go.mod 的 module 名称和工作区内包成员；附着在独立 `import "C"` 前的 cgo 导言字面量本地 include 候选 | 不计算 build tag、GOOS/GOARCH、go.work、replace/vendor 或 cgo CFLAGS；嵌套 go.mod（包括无效清单）隔离模块边界。尾随代码的注释不作为导言。 |
| Java | package/类型索引解析 import、直接嵌套类型、继承/接口、泛型边界、字段/参数/返回/throws 类型候选；module-info 的 requires/exports/opens/services 候选 | 不解析 classpath/JAR、模块路径或完整类型/访问控制。泛型和局部/匿名类型遮蔽会排除误匹配；可能的继承成员或未知父类阻止简单名回退。继承检查预算 20,000、深度 64，触发后报告 resolutionLimited/incomplete。 |
| Lua | 字面量 require，按根下 `name.lua` / `name/init.lua` 约定查找候选 | 不执行 package.path、自定义搜索器或动态参数；require / `_G.require` 重绑定时停止推断。Lua 使用维护中的独立 WASM 语法包，避免旧 grammar 的跨文件状态串扰。 |

这些关系表示源码中的文件引用，不提供函数调用图、类型推断或运行时依赖保证。增加语言会扩大默认扫描集合，首次查询耗时也取决于新增文件数量。

## JS/TS 工程解析

还会只读发现根内的 `tsconfig.json` / `jsconfig.json`、相对 `extends`、`references` 指向的配置及 `package.json`。支持 JSONC、`paths` 精确/单星号映射及顺序目标回退、`baseUrl`、多份继承、根成员 `files/include/exclude`（`*` / `**` / `?`），路径相对声明配置定位。工程映射的文件边保留来源配置。

尚未展开完整 TypeScript program 导入闭包；成员归属不明或多配置歧义时停止裸包名回退并报告限制。包名形式的 `extends`、`rootDirs`、`moduleSuffixes`、自定义条件及 bundler alias 保持未解析，不执行配置代码。

## 本地包与 workspace

根 `package.json` 的 npm/yarn `workspaces` 和 `pnpm-workspace.yaml` 字面量 `packages` 列表用于识别本地包，支持正向/排除模式、包自身引用、`exports/imports` 精确及单星号入口、`main`/`types` 和入口转发。同名包拒绝猜测，包外依赖不读 `node_modules`。

此处确定边基于已识别的本地 workspace 映射，不证明安装器实际选择了哪个同名包版本。条件导出保留可用分支作为候选；CTS/MTS、显式 module、NodeNext 与 package type 帮助选择 import/require 分支，未知 TS 编译上下文保留两者候选。缺失条件产物单独报告；包映射数组、复杂 YAML、安装器链接覆盖和完整 bundler/Node loader 语义不在支持范围。

单个工程元数据上限 256 KiB，总上限 2,000 文件 / 8 MiB；元数据内容和相关路径链接身份变化使图缓存失效。

## 查询语义

`impact:` 沿反向文件依赖递归查找引用者，给出距离、受影响的 HTML 页面和引用行号；`path:` 沿正向文件依赖及 HTML script 引用查找一条最短路径。

```json
{"target":"impact:src/lib.rs"}
{"target":"path:app/index.html -> renderer/helper.js"}
{"target":"path:src/main.ts -> src/service.ts","edgeMode":"certain"}
{"target":"file:native/main.cpp","compileCommands":"build/compile_commands.json"}
{"target":"ffi:shared_export"}
```

路径查询的箭头两侧需留空格；支持根内绝对路径和相对路径。`file:/impact:/path:` 接受 `edgeMode: "all" | "certain"`，默认包含候选边，certain 排除它们；确定仅表示静态文件引用可解析，不保证运行时执行。

`analysis` 返回 `edgeMode`、引用边的 `from/to/line/kind/evidence`、文件距离、页面及计数；`evidence` 包含 `confidence/basis/config?`。ambient 声明、条件导出及多语言候选保留候选身份。

单次查询最多索引 200,000 条边、遍历 20,000 个节点，结构化文件/边/页面列表各最多 100 项，文本各展示前 30 项。`analysis.complete` 表示所选图的遍历是否完成，`analysis.truncated` 也包含展示截断；它们与扫描覆盖度 `incomplete` 分开，达到遍历上限时不会据“未找到”断言不可达。

## 诊断

`diagnostics` 提供未解析项的 `path/line/spec/reason/detail?/config?`，以及文件读取、部分解析、工程配置问题；两类列表各最多 100 项，分别保留总数与截断标记。`file:` 的未解析列表限定当前文件，文件/工程问题仍报告全扫描范围。

JS/TS 区分非字面量、缺失目标、外部包、歧义、配置限制和根外目标；其他语言无法细分的失败诚实使用 `unsupported_resolution`，不会把未知原因伪装为缺失文件。`incomplete` 包含已知的配置/归属限制，不能用 `analysis.complete` 代替完整工程覆盖度。

## C/C++ 编译目录

包含 C/C++ 文件时自动读取根下的 `compile_commands.json`；其他位置通过 `compileCommands` 指定。文件上限为 8 MiB、20,000 条记录，优先读取 `arguments`，也接受当前平台常见引号形式的 `command`。

只把 JSON 当作数据，不运行编译器或 shell；带响应文件、sysroot、未知预处理转发、`env` 启动器或显式 include 环境变量赋值（如 `CPATH`、`INCLUDE`、`SDKROOT`）的记录保持未解析，`compilation` 会报告不支持的记录数。解析只依据显式搜索路径，不模拟完整预处理环境。数据库内容变化及搜索目标的存在性、目录链接身份变化均使图缓存失效。

## FFI 与二进制

`ffi:<name>` 按精确名称分别列出源码边界声明和二进制导出，不会把同名拼成跨语言调用链。源码支持 Rust no_mangle/export_name/link_name、extern 块，C/C++ extern C / dllexport、Node/N-API 常见注册宏和紧邻函数的 cgo `//export`。

标记只证明源码声明，无法证明链接保留、符号修饰或 ABI 一致；上游 Rust grammar 尚不识别部分 `unsafe extern` 新语法，会报告部分解析。复杂宏与函数指针声明不做完整语义推断。

二进制按魔数读取 `.exe/.dll/.node/.so/.elf/.wasm` 的 PE/ELF/WebAssembly 元数据，绝不加载或实例化。PE 支持 ordinal/forwarder，ELF 仅动态符号表作为导出证据，WASM 支持导入库和导出名；`file:` 可查看依赖库及限制说明。

未覆盖 Mach-O、archive、导入函数符号、PE delay-load、无 section header 的 ELF 动态表和 WASM memory64；不做反汇编、完整二进制有效性验证或源码产物对应验证。每文件符号上限 20,000，FFI 结构化匹配最多 100 条、文本最多 30 条。
