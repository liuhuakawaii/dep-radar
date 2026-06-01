# dep-radar

> 前端依赖雷达 — 一站式依赖分析与优化建议 CLI 工具

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

## 当前进度

> **Phase 1（MVP）已基本完成**，可端到端运行 `analyze` 命令。
> Phase 2/3 的能力（优化建议、HTML 报告、对比分析、安全/许可证维度）将按 PLAN 顺序逐步接入。

- [x] Step 1：项目脚手架
- [x] Step 2：类型系统（`src/types/`）
- [x] Step 3：错误类与工具函数（`src/errors/`、`src/utils/`）
- [x] Step 4-5：数据获取层（pkg-size、bundlephobia、npm、github、cache、http）
- [x] Step 6：包体积分析器（`src/analyzers/bundle.ts`）
- [x] Step 7：终端 + JSON 报告生成器（`src/report/`）
- [x] Step 8：配置文件加载（`src/config/loader.ts`，支持 `dep-radar.config.{ts,js,cjs,mjs,json}` / `.dep-radarrc.*` / `package.json` 字段）
- [x] Step 9：CLI 框架 + analyze + tree 命令
- [x] Step 11：依赖健康度 analyzer（npm + GitHub 集成，含 deprecated/TS 支持/下载趋势）
- [ ] Step 12-13：许可证、优化建议 analyzer（Phase 2）
- [ ] Step 14：HTML 报告（Phase 2）
- [ ] Step 15-17：安全审计、对比分析（Phase 3）

---

## 环境要求

| 项       | 版本                    |
| -------- | ----------------------- |
| Node.js  | `>= 18.17.0`            |
| pnpm     | `>= 9`                  |
| 操作系统 | Windows / macOS / Linux |

> 强制使用 pnpm（`preinstall` 钩子已经通过 `only-allow pnpm` 拦截 npm / yarn）。

---

## 快速开始

### 1. 克隆与安装

```bash
git clone <repo-url> dep-radar
cd dep-radar
pnpm install
```

### 2. 常用脚本

| 命令                 | 说明                                   |
| -------------------- | -------------------------------------- |
| `pnpm dev`           | 监听模式构建，开发时使用               |
| `pnpm build`         | 构建产物到 `dist/`                     |
| `pnpm typecheck`     | 仅做 TypeScript 类型检查               |
| `pnpm lint`          | ESLint 检查（`--max-warnings 0` 严格） |
| `pnpm lint:fix`      | 自动修复可修复的 lint 问题             |
| `pnpm format`        | Prettier 格式化 `src/`                 |
| `pnpm format:check`  | 仅检查格式                             |
| `pnpm test`          | 运行所有测试                           |
| `pnpm test:watch`    | 测试监听模式                           |
| `pnpm test:coverage` | 测试 + 覆盖率报告                      |

### 3. 本地运行 CLI

```bash
pnpm build

# 查看帮助
node ./dist/cli.js --help

# 分析当前项目（默认 terminal 输出）
node ./dist/cli.js analyze

# 输出 JSON 到文件
node ./dist/cli.js analyze --format json --output report.json

# 只看 TOP 5 体积大户
node ./dist/cli.js analyze --top 5

# 查看依赖树（npm/pnpm 支持，yarn 待实现）
node ./dist/cli.js tree --depth 2

# 分析依赖健康度（推荐先配 GITHUB_TOKEN 提升 GitHub API 配额）
node ./dist/cli.js analyze --only health --format json --output health.json
```

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
import { defineConfig } from 'dep-radar'

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

| 选项              | 说明                                                                         |
| ----------------- | ---------------------------------------------------------------------------- |
| `--format <type>` | `terminal`（默认） / `json`                                                  |
| `--output <path>` | 写入文件                                                                     |
| `--top <n>`       | 显示前 N 个体积大户（默认 10，仅 size 维度）                                 |
| `--include-dev`   | 同时分析 `devDependencies`                                                   |
| `--only <dim>`    | 维度选择：`size`（默认） / `health` / `license`（占位） / `security`（占位） |
| `--verbose`       | 详细日志                                                                     |
| `--silent`        | 静默模式                                                                     |

#### CI 集成的退出码

| 码  | 含义                 |
| --- | -------------------- |
| 0   | OK                   |
| 1   | 通用错误             |
| 2   | 体积超出 budget      |
| 3   | 许可证冲突（待实现） |
| 4   | 检测到漏洞（待实现） |

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
