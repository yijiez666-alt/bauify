# Bauify 技术指南：代码背后的东西

写给第一次读这个仓库的人。每一节回答四个问题：这是什么、代码里在哪、为什么用它、容易踩的坑。看代码时遇到不认识的东西，回来查这一篇。

阅读顺序建议和代码流水线一致：先看运行环境（Node、ESM），再看契约（JSON Schema），然后按 extract → graphs → bridge 的顺序看每一层用到的技术，最后看测试和跨平台问题。

---

## 1. 运行环境：Node.js 与 ES Module

### 这是什么

Bauify 是一个 Node.js 命令行程序。文件后缀 `.mjs` 表示它用的是 **ES Module**（ESM）——JavaScript 的官方模块系统，用 `import` / `export` 语句，而不是老式 CommonJS 的 `require()` / `module.exports`。

```js
// extract/py/index.mjs
import { spawnSync } from 'node:child_process';   // Node 内置模块，加 node: 前缀
import { fail } from '../shared/diagnostics.mjs';  // 本仓库文件，必须写扩展名
export const id = 'py';
export function extract(root, config) { … }
```

### 为什么

`package.json` 里 `"type": "module"` 让整个包默认是 ESM。选 ESM 而不是 CommonJS 有两个原因：Archify 也是 ESM，风格一致；ESM 的 `import` 是静态的，本身就是"静态可分析的依赖"——Bauify 分析别人代码时依赖的正是这个性质。

### 坑

- ESM 的相对导入**必须写扩展名**：`'./files.mjs'` 而不是 `'./files'`。
- ESM 里没有 `__dirname`。要拿当前文件所在目录，用 `fileURLToPath(import.meta.url)`，代码里 `extract/py/index.mjs` 顶部就是这样定位 `extract.py` 的。
- `import()` 带括号是**动态导入**，返回 Promise，参数可以是任意表达式。这一点在后面"opaque"一节会再出现。

---

## 2. 契约：JSON Schema 与 ajv

### 这是什么

**JSON Schema** 是用 JSON 描述"一份 JSON 应该长什么样"的标准。Bauify 每一层的产物都有一份 schema：`schemas/raw-facts.schema.json`、`schemas/module-graph.schema.json`。

**ajv** 是 Node 里最常用的 JSON Schema 校验库。代码在 `extract/shared/schema.mjs`：

```js
import Ajv2020 from 'ajv/dist/2020.js';           // 用 draft 2020-12 版本
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const validate = ajv.compile(schema);              // 把 schema 编译成校验函数
if (!validate(data)) console.log(validate.errors); // 每条错误带 instancePath 和 message
```

### 为什么

契约先于代码。schema 写好之后，extract 的输出**写盘前**先过校验，graphs 的输入**读进来后**也先过校验。任何一层产出不合规的 JSON 会立刻报 `extract/schema-invalid` 而不是让下一层莫名其妙崩掉。

schema 里两个值得看的写法：

```json
"if":   { "properties": { "resolved": { "const": true } } },
"then": { "required": ["to"] },
"else": { "not": { "required": ["to"] } }
```

这是 **条件约束**：`resolved` 为 true 时必须有 `to`，为 false 时不能有 `to`。之前这个不变量只写在注释里，CodeRabbit 指出"注释不是约束"，于是改成了 schema 能强制的形式。

`"additionalProperties": false` 表示对象里不允许出现 schema 没列出的字段——防止某个适配器偷偷塞私有字段进公共契约。

### 坑

- draft 2020-12 要从 `ajv/dist/2020.js` 引入，默认的 `ajv` 导出只认 draft-07，会报 "no schema with key or ref"。
- ajv 的 `strict: true` 会拒绝 `then` 里 `required` 一个上层定义的属性（`strictRequired`）。我们把 `strictRequired` 关掉、其余严格检查保留。

---

## 3. extract/ts：TypeScript Compiler API

### 这是什么

TypeScript 除了是一门语言，它的编译器 `typescript` 包还暴露了一整套 API，可以把源码解析成 **AST**（抽象语法树）并做类型分析。它同样能解析纯 JavaScript（`allowJs: true`），所以 Bauify 用它统一处理 JS 和 TS。

### AST 是什么

AST 是源码的树形表示。`import { a } from './x.mjs'` 这一行会变成一个 `ImportDeclaration` 节点，下面挂着 `ImportClause`（导入了什么）和 `StringLiteral`（从哪导入）。分析代码就是在树上找特定类型的节点。

代码里的遍历（`extract/ts/index.mjs` 的 `collectImports`）：

```js
const visit = (node) => {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    found.push({ specifier: node.moduleSpecifier.text, kind: 'static', line: lineOf(source, node), … });
  } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    // import(...) 动态导入
  }
  ts.forEachChild(node, visit);   // 递归所有子节点
};
visit(sourceFile);
```

`ts.isXxx(node)` 系列函数是类型守卫，用来判断节点种类；`ts.forEachChild` 深度优先遍历。

### Program 与 type checker

一开始 Bauify 只用 `ts.createSourceFile` 单文件解析。上游作者把它改成了 `ts.createProgram(files, { noResolve: true, noLib: true })` 再拿 `program.getTypeChecker()`。原因是一个真实 bug：

```js
function local() { require('./dep'); var require = (s) => s; }
```

这里的 `require` 是局部变量，不是 CommonJS 的加载器。单看语法分不出来；type checker 的 `getSymbolAtLocation(identifier)` 能告诉你这个标识符绑定到哪个声明——没有声明就是全局 `require`，有声明就是局部变量。`noResolve` 和 `noLib` 让 Program 只做词法绑定、不去解析模块和标准库，所以速度可以接受。

### 模块解析

`ts.resolveModuleName(specifier, containingFile, options, ts.sys)` 按 Node 的规则把 `'../shared/cli.mjs'` 解析成绝对路径。Bauify 拿到路径后判断它是否在分析根目录内、是否在文件集合里，据此归到 resolved / outside / unknown。

### 为什么不用 dependency-cruiser 或 babel

它们只给 import 边。M2 要做符号图和调用图时需要引用和调用信息，TS API 一次遍历都能拿到，不用再引第二个解析器。

### 坑

- `node.getStart(source)` 需要传 sourceFile，否则在 Program 模式下拿不到位置。
- 引擎默认排序 `localeCompare` 依赖操作系统 locale，不同机器结果不同——见第 9 节。

---

## 4. extract/py：Python 标准库 `ast` + 子进程

### 这是什么

Python 自带 `ast` 模块，功能和 TS 的解析器类似：`ast.parse(source)` 得到树，`ast.walk(tree)` 遍历。`extract/py/extract.py` 只用标准库，不需要 pip 安装任何东西。

```python
for node in ast.walk(tree):
    if isinstance(node, ast.Import):          # import a.b as c
        …
    elif isinstance(node, ast.ImportFrom):    # from ..pkg import x, y
        level = node.level                    # 前导点的个数：0 绝对，1 当前包，2 上一级
        module = node.module or ""            # from . import x 时 module 是 None
```

### 子进程与进程间通信

Node 不能直接跑 Python 代码，所以 `extract/py/index.mjs` 用 `child_process.spawnSync` 启动一个 Python 进程，把文件列表以 JSON 写到它的 **stdin**，从它的 **stdout** 读回 JSON：

```js
const result = spawnSync('python3', [SCRIPT], { input: JSON.stringify(request), encoding: 'utf8' });
const output = JSON.parse(result.stdout);
```

`spawnSync` 是同步的：Node 会等 Python 跑完再继续。对命令行工具这样最简单，不用处理并发。

解释器名字在 Windows 上通常是 `python`，Linux/macOS 上是 `python3`，Windows 还有 `py -3` 启动器。代码按顺序试三个，都失败才报 `extract/python-unavailable`，也可以用环境变量 `BAUIFY_PYTHON` 指定。

### 为什么解析在 Node 侧做

Python 脚本只输出"原始 import 语句"，把 `from utils import logger` 解析成 `utils/logger.py` 这一步在 Node 里做。这样 external / outside / unknown / opaque 四类的定义只存在一份，两种语言不会各自解释。

### Python 导入语义（新手最容易糊的部分）

- **包**：有 `__init__.py` 的目录。`import pkg` 实际加载的是 `pkg/__init__.py`。
- **相对导入**：`from .a import x` 里的点表示"相对当前文件所在的包"。`level=1` 是同一目录，`level=2` 是上一级。越出分析根目录记为 `outside`。
- **`from pkg import name`** 有两种可能：`name` 是 `pkg/name.py`（子模块），或者是 `pkg/__init__.py` 里定义的变量（属性）。代码先试子模块，找不到才算属性、指向 `__init__.py`。
- **PEP 420 命名空间包**：Python 3.3 起，**没有** `__init__.py` 的目录也能当包用。ai-voice 的 `utils/`、`asr/` 都是这种。它没有自己的文件，所以只有 `from ns import submodule` 能产生边；`from ns import 属性` 记 unknown。这是跑真实仓库时发现的，第一版有 56 条解析失败。
- **绝对导入的搜索路径**：真实的 Python 按 `sys.path` 找，Bauify 无法知道用户的运行环境，就按最常见的约定：先仓库根目录，再 `src/`。
- **动态导入**：`importlib.import_module("a.b")` 参数是字面量就能解析；是变量就记 `opaque`。

---

## 5. 四类"解析不到"：为什么要分开数

`raw-facts.json` 的 `unresolved` 有四个计数器，都是 `required`：

| 类别 | 含义 | 期望 |
|---|---|---|
| `external` | 裸模块名或 `node:` 前缀：第三方库、标准库 | 多是正常的 |
| `outside` | 解析到了，但文件在分析根目录之外 | 通常是测试引用了上级目录的脚本 |
| `unknown` | 像路径，但找不到文件 | **应该是 0**，非 0 说明解析规则有漏洞或代码有坏引用 |
| `opaque` | `import()` / `require()` / `import_module()` 的参数不是字符串字面量 | 静态分析的盲区，必须可见 |

`opaque` 是关键的一类。Archify 的 `bin/archify.mjs` 用 `spawnSync(process.execPath, [渲染器路径])` 启动子进程、用 `import(pathToFileURL(path.join(...)))` 加载 delta 模块——两种都是运行时才知道目标的调用。图上 `bin` 到各渲染器**没有边**，这是事实；但如果只是悄悄没有边，读图的人会以为 bin 不依赖渲染器。计数把"这里有 3 处看不见的动态加载"说出来，这就是 ARCHITECTURE.md 里"漏报可见"的意思。

---

## 6. 小工具：glob 匹配、文件角色、Git

### glob → 正则

`config/defaults.json` 里的 `**/test/**`、`**/*.{js,mjs}` 是 **glob** 模式，一种描述路径的简写。Node 18 没有稳定的内置 glob，`extract/shared/glob.mjs` 手写了一个转换器，把 glob 翻译成正则表达式：`**` → 任意多级目录，`*` → 一段内任意字符，`{a,b}` → 二选一。上游作者补了一个边界：`{` 没有闭合时原来会死循环，现在报 `cli/config-invalid`。

### 文件角色

每个文件被标为 `source` / `test` / `generated`。规则是 glob，优先级 **test > generated > source**：`test/generated-artifact-xml.test.mjs` 同时匹配两条，它是测试。这个优先级是被测试抓出来后定的。

### Git

`extract/shared/git.mjs` 用 `spawnSync('git', [...])` 调三条**只读**命令：`rev-parse --show-toplevel`（仓库根）、`rev-parse HEAD`（当前 commit 的 40 位 sha）、`remote get-url origin`（远端地址）。这些是 Git 的"plumbing"命令，输出稳定、适合程序解析。没有 Git 时全部返回 null，分析照常进行，只是后面走不了证据模式。

---

## 7. graphs/module：图的基本概念与度量

### 从文件图到模块图

raw-facts 里的边是文件到文件。`graphs/module.mjs` 把每个文件映射到一个模块（按配置分组 / 包边界 / 目录深度），再把文件边**合并**成模块边：同一对模块之间的多条文件边合成一条，`weight` 是条数，`kinds` 按 static / dynamic 分计，`evidence` 保留最多 5 条 file:line。

用 `Map` 做去重合并是 JS 里的惯用写法：

```js
const key = `${from} ${to}`;
if (!edgeMap.has(key)) edgeMap.set(key, { from, to, weight: 0, … });
edgeMap.get(key).weight += 1;
```

### fan-in、fan-out、instability

- **fan-in**：有多少个别的模块依赖我（入边数）。高 = 被广泛使用，改动要小心。
- **fan-out**：我依赖多少个别的模块（出边数）。高 = 脆弱，别人一变我就要跟着变。
- **instability** I = fanOut / (fanIn + fanOut)。0 表示纯 sink（只被依赖），1 表示纯 source（只依赖别人）。这是 Robert C. Martin 在《敏捷软件开发》里提出的度量；健康的依赖方向是"不稳定的依赖稳定的"。

没有任何边时 I 是 `null` 而不是 0——没有数据就不假装有。

### 为什么剔除测试和生成文件

测试文件几乎 import 一切，留着会让每个模块的 fan-in 都很高，度量失去意义。生成文件（`generated-validators.mjs`）是构建产物，不反映设计。剔除但**计数**（`excluded.files`），Archify 图的卡片会写"102 个文件未画"。

---

## 8. bridge/to-archify：图算法与布局

这是仓库里算法最密集的文件。逐个说。

### 折叠到 12 个节点

Archify 建议一张图不超过 12 个主节点。`foldToBudget` 把**整组兄弟**折进父目录（最深的先）：`tools/dram`、`tools/finance`、… 全部并入 `tools`。第一版是"折到够 12 个就停"，结果 `tools/*` 折了一半留一半，测试抓到后改成整组折叠。折叠时边要**重映射**（`remap`）：指向被折叠模块的边改指父模块，父子之间的边变成自环要删掉，然后重新计算 fan-in/out。

### DFS 去环与分层

真实依赖图常有环（ai-voice 里 `root ↔ asr`）。要排成上下分层的图必须先变成 DAG（有向无环图）。做法是**深度优先搜索**（DFS）：遍历时给节点标记"正在访问"；如果一条边指向正在访问中的节点，它就是**回边**，构成环，分层时忽略它（`layerModules` 里 `state.get(next) === 1` 那行）。

分层用**最长路径**：先做拓扑排序，再按顺序把每个节点的层数更新为"所有前驱层数 + 1 的最大值"。source（没有入边）在第 0 层，最深的 sink 在最下面。

### 拓扑排序与 Kahn 算法

`orderLanes` 里用的是 **Kahn 算法**：维护"还没放的集合"，每轮取出所有约束已经满足的节点，按稳定的规则选一个放下。约束来自"哪条边必须在哪条边上方"（见下）。如果约束成环（嵌套区间），退回到按跨度排序——这就是不可避免的交叉。

### 为什么每个模块独占一列

Archify 对"边穿过无关节点"是硬错误。如果每个模块独占一列，一条竖直走线永远只会经过自己那一列，而那一列里没有别的节点。代价是图变宽；这是已知短板。

列的顺序按 instability 升序：sink 在左、source 在右，这样大部分 lane 都从右往左指向 sink，源节点的竖直短线很少落在别人的横线区间里。

### 显式路由：via 与 lane

Archify 没有自动布局，只有 `grid` 模式和显式路由点 `via`。每条边走三段：从源底部竖直下到一条 **lane**（该行下方 gap 里的一条水平线，每条边一条，24px 一档），水平走到目标所在列，再竖直下到目标顶部。反向边（指向上方的回边）从顶部走上方的 gap。标签用 `labelAt` 钉在 lane 上靠近源的位置，那里不会有别的列的竖线。

同一 gap 里多条 lane 的上下顺序按两条规则排：一条边的**源**落在另一条边的水平区间内 → 它必须在上方；一条边的**目标**落在另一条区间内 → 它必须在下方。两条都满足不了（区间嵌套）就会交叉。

### standard 与 showcase

Archify 的 `showcase` 档位要求零交叉。真实依赖图基本是非平面图（无论怎么画都有交叉），所以 Bauify 默认声明 `standard`：交叉是 warning，图正常交付，证据照样核对。

### 证据模式

`meta.repository` 和每个节点的 `sources` 只在两个条件同时满足时写：revision 是 40 位 sha，origin 是 github.com（ssh 形式 `git@github.com:a/b.git` 会归一成 `https://github.com/a/b`）。写了之后 `archify deliver --repo-root` 会用 git 逐条核对这些路径在那个 commit 真实存在——所以 Bauify 不是自己声称有证据，而是把可核对的线索交给 Archify。

---

## 9. 确定性：为什么这么执着于"字节相同"

"同一输入跑两次，输出字节级相同"是 Bauify 的硬约束，因为它让 `diff` 两次分析结果等价于 `diff` 代码结构。为此代码里处处注意：

- 所有数组在输出前按稳定键排序（文件按路径，边按 from/line/specifier）。
- 不写时间戳，不写绝对路径（`repository.root` 是相对 Git 根的路径）。
- **不用 `localeCompare`**。它按操作系统的语言设置排序，`ä` 和 `z` 在 `C` locale 和 `sv_SE` locale 下顺序不同。改用 `a < b ? -1 : a > b ? 1 : 0` 的字节序比较。这是 CodeRabbit 发现、上游作者修的。
- `JSON.stringify(value, null, 2)` 输出顺序就是对象属性的插入顺序，所以构造对象时字段顺序也是固定的。

有一个测试专门跑两次比较字节。

---

## 10. 失败即结构化诊断

Bauify 从不把 Node 的堆栈打给用户。任何失败都是一个固定形状的对象（`extract/shared/diagnostics.mjs`）：

```json
{ "code": "extract/adapter-ambiguous", "severity": "error",
  "message": "More than one language adapter matches; choose one explicitly.",
  "subject": { "root": "…" }, "evidence": { "detected": ["ts", "py"] },
  "supportedFixes": ["pass --language ts", "pass --language py"] }
```

实现方式：`fail(code, message, details)` 抛一个自定义的 `DiagnosticError`；`bin/analyze.mjs` 最外层 `try/catch` 接住它，`--json` 模式输出 `{ status: "failed", diagnostics: [...] }`，人类模式打印 `code: message` 和修复建议，进程退出码 1。不是 `DiagnosticError` 的意外错误也走同一条路，code 是 `internal/unclassified`——明确说"没分类"，不编造修复建议。

这个形状和 Archify 的 diagnostic 契约一模一样，所以将来 findings 可以直接挂进 Archify 的节点卡片。

---

## 11. 测试：node:test、fixture、自举

### node:test

Node 18 起内置测试框架，不用装 jest。`node --test test/*.test.mjs` 跑所有文件；每个 `test('名字', fn)` 里用 `node:assert/strict` 断言。`{ skip: '原因' }` 可以跳过而不是失败——没有 Archify checkout 时相关测试就是这样跳过的。

### 合成 fixture

`test/fixtures/ts-basic/` 和 `py-basic/` 是手工写的迷你仓库，每个文件只有几行，专门覆盖一种情况（相对导入、命名空间包、语法错误、计算路径的动态导入……）。旁边的 `expected.json` 是**先手推、再跑程序核对**得到的预期输出。测试就是 `assert.deepEqual(实际, 预期)`。这类测试的价值在于：任何改动让某条边变了，你会立刻知道是哪个文件哪一行。

### 回归测试

`test/extract-regressions.test.mjs` 每个测试对应一个被 review 抓出的 bug：locale 排序、`..generated/` 误判、glob 死循环、局部 `require`。改坏了会立刻复现。

### 自举

分析 Archify 自己的 `archify/` 包，断言 `bin → renderers/* → renderers/shared` 三层、`shared` fan-out 为 0、bin 到渲染器没有静态边但 `opaque ≥ 1`，最后用 Archify 自己的 `validate` 校验桥接产物。这既测 Bauify，也是对上游代码结构的一次体检。

### 子进程方式跑 CLI

`test/helpers.mjs` 的 `runCli` 用 `spawnSync(process.execPath, [CLI, ...args])` 真的启动一次命令行，而不是直接调函数。这样测到的是用户实际会遇到的行为：退出码、stdout 的 JSON、stderr 的文字。

---

## 12. 跨平台：Windows 上会遇到的

- **路径分隔符**：Windows 是 `\`，POSIX 是 `/`。所有写进 JSON 的路径都经过 `toPosix()` 统一成 `/`，否则同一仓库在两台机器上产物不同。
- **行尾**：Windows Git 默认 `autocrlf=true`，检出时把 LF 换成 CRLF。`.gitattributes` 里 `* text=auto eol=lf` 让仓库统一 LF；`lineCount` 用 `/\r\n|\n|\r/` 三种都认。
- **符号链接**：Windows 普通用户建不了 symlink，要开开发者模式。Archify 的一批测试因此在 Windows 上失败，和 Bauify 无关。
- **临时目录**：不要写死 `/tmp`，用 `os.tmpdir()`。
- **解释器名**：`python` / `python3` / `py -3`，见第 4 节。
- **ESM 与 Windows 绝对路径**：`import('C:\\...')` 会报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，必须先 `pathToFileURL()`。这是上游一个真实的 Windows bug。

---

## 13. 名词速查

| 词 | 一句话 |
|---|---|
| AST | 源码的树形结构，分析代码就是在树上找节点 |
| ESM / CJS | 两种 JS 模块系统；`import` 静态可分析，`require` 是函数调用 |
| JSON Schema | 描述 JSON 形状的规范；ajv 是校验器 |
| raw-facts | extract 的产物：文件、角色、import 边、四类未解析计数 |
| module graph | 文件边按目录折叠后的模块级图，带 fan-in/out 与证据 |
| IR | 中间表示；Archify 的 `architecture` JSON 就是它的 IR |
| fan-in / fan-out / instability | 入边数 / 出边数 / out÷(in+out) |
| DAG | 有向无环图；分层布局的前提 |
| 回边 | DFS 中指向"正在访问"节点的边，标志一个环 |
| 拓扑排序 / Kahn | 在 DAG 上给节点排一个"前驱都在前面"的顺序 |
| 非平面图 | 无论怎么画都有交叉的图；真实依赖图大多如此 |
| PEP 420 | 没有 `__init__.py` 的目录也是 Python 包 |
| opaque | 参数不是字面量的动态导入，静态分析看不见目标 |
| 证据模式 | IR 带 commit sha 和源码路径，由 Archify 用 git 核对 |
| 结构化诊断 | code / severity / subject / evidence / supportedFixes 五字段的失败对象 |

---

## 14. 继续读什么

- TypeScript Compiler API：官方 wiki "Using the Compiler API"；先用 `ts.createSourceFile` 打印一棵小树，比看文档快。
- Python `ast`：官方文档 `ast` 模块；`ast.dump(ast.parse("from . import x"), indent=2)` 一行就能看到结构。
- JSON Schema：json-schema.org 的 "Understanding JSON Schema"，重点看 `if/then/else` 和 `additionalProperties`。
- 图算法：任何算法教材的 DFS、拓扑排序、强连通分量（Tarjan）三节；M1 剩下的 `coupling/cycle` 就是 Tarjan。
- 依赖度量：Robert C. Martin《敏捷软件开发：原则、模式与实践》第 20 章"包的设计原则"。
- Archify 的契约：`archify/references/authoring-contract.md`，看"Executable geometry rules"一节就知道 bridge 为什么那样画。
