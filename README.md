# dep-radar

> 前端依赖雷达 — 一站式依赖分析与优化建议 CLI 工具

[![npm](https://img.shields.io/npm/v/@liuhuakawaii/dep-radar.svg)](https://www.npmjs.com/package/@liuhuakawaii/dep-radar)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D18.17.0-brightgreen.svg)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D9-orange.svg)](https://pnpm.io)

---

## 项目简介

`dep-radar` 是一个面向前端项目的依赖分析 CLI，提供：

- 包体积分析（pkg-size.dev / Bundlephobia / 本地 esbuild 三路数据源）
- 依赖健康度评分（下载量、活跃度、TypeScript 支持、deprecated 检测）
- 许可证合规检查（支持 `(MIT OR Apache-2.0)` 复合表达式）
- 安全漏洞审计（自动适配 npm / pnpm / yarn audit）
- 优化建议引擎（内置常用替代方案，可扩展）
- 多种报告格式（终端 / JSON / HTML）

详细技术方案见仓库根目录的 `PLAN-v2.md`。

---

## 安装

```bash
# 全局安装
npm i -g @liuhuakawaii/dep-radar
# 或
pnpm add -g @liuhuakawaii/dep-radar

# 直接运行（无需安装）
npx @liuhuakawaii/dep-radar analyze
```

> npm 包名是 `@liuhuakawaii/dep-radar`，但 CLI 命令是 `dep-radar`。

---

## 快速上手

```bash
# 分析当前项目体积（默认 TOP 10）
dep-radar analyze

# 跨维度聚合分析 + 优化建议（最常用的命令）
dep-radar optimize

# 查看依赖树
dep-radar tree

# 输出 JSON 到文件（适合 CI 集成）
dep-radar analyze --format json --output dep-report.json

# 生成 HTML 报告
dep-radar optimize --format html --output dep-report.html
```

---

## 配置

支持两种配置方式，任选其一。

### 方式一：JSON（推荐大多数用户）

在项目根目录创建 `.deprdarrc.json`：

```json
{
  "budget": {
    "totalGzip": 512000,
    "perPackage": { "moment": 0 }
  },
  "ignore": ["@internal/*"],
  "dataSource": ["pkg-size", "bundlephobia"]
}
```

也支持 `package.json` 中的 `"dep-radar"` 字段、`.deprdarrc.yaml`、`.deprdarrc.js`、`dep-radar.config.js` 等格式，由 [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig) 自动发现。

### 方式二：TypeScript（需要类型提示时）

使用 `defineConfig` 获得自动补全和类型检查。它是一个**纯类型辅助函数**，不做任何运行时校验，仅透传配置对象：

```ts
// dep-radar.config.ts
import { defineConfig } from '@liuhuakawaii/dep-radar'

export default defineConfig({
  budget: {
    totalGzip: 500 * 1024, // 总 gzip 上限 500KB
    perPackage: { moment: 0 }, // 禁用 moment
  },
  ignore: ['@internal/*'],
  dataSource: ['pkg-size', 'bundlephobia'],
  cacheTTL: 3600,
})
```

### 配置项说明

| 字段                | 类型                              | 默认值            | 说明                                         |
| ------------------- | --------------------------------- | ----------------- | -------------------------------------------- | ------------------------------ | ---------------------------------------- |
| `budget`            | `object`                          | -                 | 体积预算，CI 中超出则退出码 3                |
| `budget.totalGzip`  | `number`                          | -                 | 项目总 gzip 体积上限（字节）                 |
| `budget.perPackage` | `Record<string, number>`          | -                 | 单包体积上限，`{ "moment": 0 }` 表示禁止使用 |
| `ignore`            | `string[]`                        | `[]`              | 忽略的包，支持 glob 模式                     |
| `replacements`      | `Record<string, ReplacementRule>` | 内置表            | 自定义替代方案，同名覆盖内置规则             |
| `dataSource`        | `Array<'pkg-size' \\              | 'bundlephobia' \\ | 'local'>`                                    | `['pkg-size', 'bundlephobia']` | 数据源优先级，`'local'` 启用本地 esbuild |
| `registry`          | `string`                          | -                 | 自定义 npm registry URL                      |
| `cacheTTL`          | `number`                          | `3600`            | 缓存 TTL（秒）                               |

---

## 环境要求

| 项       | 版本                    |
| -------- | ----------------------- |
| Node.js  | `>= 18.17.0`            |
| pnpm     | `>= 9`                  |
| 操作系统 | Windows / macOS / Linux |

> 强制使用 pnpm（`preinstall` 钩子已经通过 `only-allow pnpm` 拦截 npm / yarn）。

### 配置 GITHUB_TOKEN（强烈推荐）

未认证时 GitHub API 限流为 **60 次/小时**，依赖较多的项目容易触发。
在 [GitHub Settings → Developer settings → Personal access tokens](https://github.com/settings/tokens) 创建一个 `public_repo` 权限的 token，然后：

```bash
# Windows PowerShell
$env:GITHUB_TOKEN = "ghp_xxx"

# macOS / Linux
export GITHUB_TOKEN="ghp_xxx"
```

---

## CLI 参考

### `analyze`（单维度详查）

| 选项              | 说明                                               |
| ----------------- | -------------------------------------------------- |
| `--only <dim>`    | `size`（默认） / `health` / `license` / `security` |
| `--format <type>` | `terminal`（默认） / `json` / `html`               |
| `--output <path>` | 写入文件                                           |
| `--top <n>`       | 显示前 N 个体积大户（默认 10，仅 size 维度）       |
| `--include-dev`   | 同时分析 `devDependencies`                         |

### `optimize`（跨维度聚合 + 生成可操作建议）

| 选项              | 说明                                             |
| ----------------- | ------------------------------------------------ |
| `--format <type>` | `terminal`（默认） / `json` / `html`             |
| `--output <path>` | 写入文件                                         |
| `--include-dev`   | 同时分析 `devDependencies`                       |
| `--skip-health`   | 跳过健康度维度（避免 GitHub API 调用，速度更快） |
| `--skip-license`  | 跳过许可证维度                                   |

### `tree`（依赖树可视化）

| 选项          | 说明                             |
| ------------- | -------------------------------- |
| `--depth <n>` | 最大深度（默认 5）               |
| `--no-hints`  | 不显示优化提示（`[!]` 替代建议） |

### `compare`（对比两个项目的体积差异）

| 选项            | 说明                       |
| --------------- | -------------------------- |
| `--include-dev` | 同时比较 `devDependencies` |

### `report`（生成 HTML 报告的快捷方式）

等价于 `optimize --format html`，额外支持 `--output` 指定输出路径（默认 `dep-radar-report.html`）。

### 全局选项

| 选项          | 说明                       |
| ------------- | -------------------------- |
| `--verbose`   | 详细日志                   |
| `--silent`    | 静默模式                   |
| `--no-cache`  | 禁用缓存                   |
| `--cache-dir` | 自定义缓存目录             |
| `--registry`  | 自定义 npm registry        |
| `--offline`   | 离线模式，跳过所有网络请求 |

### CI 集成的退出码

| 码  | 含义                                                  |
| --- | ----------------------------------------------------- |
| 0   | OK                                                    |
| 1   | 通用错误（IO / 网络 / 配置）                          |
| 2   | 发现高危 / 严重漏洞                                   |
| 3   | 体积超出 `budget`（`analyze --only size` 时）         |
| 4   | 检测到高风险许可证冲突（`analyze --only license` 时） |

---

## 架构概览

### 数据流

```
CLI (cli.ts)
  │
  ├─► Command (commands/*.ts)     ← 解析参数、组装流水线
  │     │
  │     ├─► Fetcher (data/*.ts)   ← 网络请求、缓存、错误处理
  │     │
  │     └─► Analyzer (analyzers/*.ts)  ← 纯逻辑，通过 Fetcher 注入数据
  │           │
  │           └─► Report (report/*.ts)  ← 渲染输出（terminal / json / html）
  │
  └─► Exit Code (utils/exitCode.ts)    ← 根据分析结果决定退出码
```

### 分层职责

| 层       | 目录             | 职责                                                   |
| -------- | ---------------- | ------------------------------------------------------ |
| CLI 层   | `src/cli.ts`     | Commander 入口，注册命令和全局选项，顶层错误处理       |
| 命令层   | `src/commands/`  | 每个子命令的编排逻辑：加载配置 → 调用分析器 → 渲染报告 |
| 分析器层 | `src/analyzers/` | 纯业务逻辑，接收 Fetcher 接口，返回分析结果            |
| 数据层   | `src/data/`      | HTTP 客户端、各 API 适配器、文件缓存                   |
| 报告层   | `src/report/`    | 将 `AnalysisReport` 渲染为不同格式的字符串             |
| 配置层   | `src/config/`    | cosmiconfig 配置加载、内置替代方案表、许可证分类表     |
| 类型层   | `src/types/`     | 所有公开类型定义                                       |
| 工具层   | `src/utils/`     | 日志、格式化、文件操作、重试、错误增强                 |

### 扩展点

**添加新数据源**（如本地 esbuild）：

1. 在 `src/data/` 新建文件，导出符合 `BundleFetcher` 签名的函数
2. 在 `src/commands/buildBundleFetcher.ts` 的 `SOURCES` map 中注册

**添加新分析维度**：

1. 在 `src/analyzers/` 新建分析器（接收 Fetcher 接口，返回结果类型）
2. 在 `src/commands/analyze.ts` 和 `optimize.ts` 中接入

**添加新报告格式**：

1. 在 `src/report/` 新建文件，导出 `(report: AnalysisReport) => string`
2. 在 `src/commands/analyze.ts` 的 `renderReport()` 中添加 case

**自定义替代方案**：

通过配置文件的 `replacements` 字段添加或覆盖内置规则，同名时用户配置优先。

---

## 开发约定

### NodeNext 模块解析

所有项目内 import **必须带 `.js` 后缀**（即使源文件是 `.ts`）：

```ts
import { foo } from './utils/format.js' // ✅ 正确
import { foo } from './utils/format' // ❌ 运行时报错
```

### 类型导入

启用 `verbatimModuleSyntax`，**仅做类型用途的 import 必须用 `import type`**：

```ts
import type { PackageJson } from './types/package.js' // ✅
import { type PackageJson } from './types/package.js' // ✅
```

### 日志输出

由于 `no-console` 规则只允许 `console.warn` / `console.error`，**CLI 的常规输出应通过 `consola`（统一日志器）或 `process.stdout.write`**，不要直接 `console.log`。

---

## 项目结构

```
dep-radar/
├── src/
│   ├── cli.ts                 # CLI 入口
│   ├── index.ts               # 库入口（defineConfig + 类型 re-export）
│   ├── commands/              # CLI 子命令编排
│   ├── analyzers/             # 业务分析器（纯逻辑）
│   ├── data/                  # 数据获取层（HTTP、API、缓存）
│   ├── report/                # 报告生成器（terminal/json/html）
│   ├── config/                # 配置加载、替代方案表、许可证分类
│   ├── errors/                # 自定义错误类
│   ├── types/                 # 类型定义
│   └── utils/                 # 工具函数
├── tests/
│   ├── integration/           # 集成测试
│   ├── fixtures/              # 测试固件
│   └── helpers/               # 测试工具
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── eslint.config.js
└── .prettierrc
```

> 单元测试与源码 **colocate**（同目录），集成测试放在 `tests/integration/`。

---

## 关键技术决策

| 类别        | 选择                  | 理由                               |
| ----------- | --------------------- | ---------------------------------- |
| 构建工具    | tsup                  | 零配置、基于 esbuild、支持 ESM/DTS |
| CLI 框架    | commander             | 成熟稳定                           |
| HTTP 客户端 | 原生 fetch (Node 18+) | 不需要 axios，节省安装体积         |
| 模块系统    | ESM + NodeNext        | 现代 Node.js 推荐                  |
| 测试框架    | vitest                | 与 Vite 生态一致                   |
| 包管理器    | pnpm                  | 性能与磁盘节约                     |
| 版本管理    | changesets            | 半自动 bump + CHANGELOG            |
| 缓存路径    | env-paths             | 跨平台正确                         |
| 配置文件    | cosmiconfig           | 业界标准，多格式支持               |

> 详见 `PLAN-v2.md` 第八章「关键技术决策记录」。

---

## 许可证

[MIT](./LICENSE) © liuhuakawaii
