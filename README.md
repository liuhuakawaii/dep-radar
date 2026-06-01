# dep-radar

> 前端依赖雷达 — 一站式依赖分析与优化建议 CLI 工具

[![npm](https://img.shields.io/npm/v/@liuhuakawaii/dep-radar.svg)](https://www.npmjs.com/package/@liuhuakawaii/dep-radar)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D18.17.0-brightgreen.svg)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D9-orange.svg)](https://pnpm.io)

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

## CLI

```bash
 # 1. 体积分析（默认）
  dep-radar analyze

  # 2. 看 TOP 5 体积大户
  dep-radar analyze --top 5

  # 3. 输出 JSON 到文件（CI 用）
  dep-radar analyze --format json --output dep-report.json

  # 4. 看依赖树
  dep-radar tree --depth 2

  # 5. 健康度分析（建议先配 GITHUB_TOKEN，否则 60 次/小时限流）
  $env:GITHUB_TOKEN = "ghp_xxx"        # PowerShell
  dep-radar analyze --only health

  # 6. 许可证合规检查
  dep-radar analyze --only license

  # 7. 跨维度聚合 + 优化建议（核心命令，最值得跑）
  dep-radar optimize

  # 8. 生成漂亮的 HTML 报告（离线可看）
  dep-radar optimize --format html --output dep-report.html
```

---

## 环境要求

| 项       | 版本                    |
| -------- | ----------------------- |
| Node.js  | `>= 18.17.0`            |
| pnpm     | `>= 9`                  |
| 操作系统 | Windows / macOS / Linux |

> 强制使用 pnpm（`preinstall` 钩子已经通过 `only-allow pnpm` 拦截 npm / yarn）。

---

#### 配置 GITHUB_TOKEN（强烈推荐）

未认证时 GitHub API 限流为 **60 次/小时**，依赖较多的项目容易触发。
在 [GitHub Settings → Developer settings → Personal access tokens](https://github.com/settings/tokens) 创建一个 `public_repo` 权限的 token，然后：

```bash
# Windows PowerShell
$env:GITHUB_TOKEN = "ghp_xxx"

# macOS / Linux
export GITHUB_TOKEN="ghp_xxx"
```

### 4. 配置文件示例

在项目根目录放 `dep-radar.config.ts`（或 `.dep-radarrc.json` 等）：

```ts
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

#### 已实现的 CLI 选项

**`analyze`**（单维度详查）

| 选项              | 说明                                                       |
| ----------------- | ---------------------------------------------------------- |
| `--only <dim>`    | `size`（默认） / `health` / `license` / `security`（占位） |
| `--format <type>` | `terminal`（默认） / `json` / `html`                       |
| `--output <path>` | 写入文件                                                   |
| `--top <n>`       | 显示前 N 个体积大户（默认 10，仅 size 维度）               |
| `--include-dev`   | 同时分析 `devDependencies`                                 |

**`optimize`**（跨维度聚合 + 生成可操作建议）

| 选项              | 说明                                             |
| ----------------- | ------------------------------------------------ |
| `--format <type>` | `terminal`（默认） / `json` / `html`             |
| `--output <path>` | 写入文件                                         |
| `--include-dev`   | 同时分析 `devDependencies`                       |
| `--skip-health`   | 跳过健康度维度（避免 GitHub API 调用，速度更快） |
| `--skip-license`  | 跳过许可证维度                                   |

**全局选项**

| 选项         | 说明                                      |
| ------------ | ----------------------------------------- |
| `--verbose`  | 详细日志                                  |
| `--silent`   | 静默模式                                  |
| `--no-cache` | 禁用缓存（缓存层待 Phase 3 接入 data 层） |
| `--registry` | 自定义 npm registry（待 data 层接入）     |

#### CI 集成的退出码

| 码  | 含义                                                   |
| --- | ------------------------------------------------------ |
| 0   | OK                                                     |
| 1   | 通用错误（IO/网络/配置）                               |
| 2   | 发现高危/严重漏洞（待 Phase 3 接入 security analyzer） |
| 3   | 体积超出 `budget`（`analyze --only size` 时）          |
| 4   | 检测到高风险许可证冲突（`analyze --only license` 时）  |

---

## 项目结构

```
dep-radar/
├── src/
│   ├── cli.ts                 # CLI 入口
│   ├── index.ts               # 库入口
│   ├── commands/              # CLI 子命令
│   ├── analyzers/             # 业务分析器
│   ├── data/                  # 数据获取层
│   ├── report/                # 报告生成器
│   ├── config/                # 配置与映射表
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

## 重要约定

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

## 许可证

[MIT](./LICENSE) © liuhuakawaii
