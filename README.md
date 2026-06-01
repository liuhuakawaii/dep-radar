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

> 当前处于 **脚手架阶段**（PLAN Step 1 已完成）。
> 业务功能将按 Phase 1 → Phase 2 → Phase 3 顺序实现。

- [x] Step 1：项目脚手架（工程化配置、目录结构、构建/测试/lint 链路）
- [ ] Step 2：类型系统
- [ ] Step 3：工具函数
- [ ] Step 4：数据获取层
- [ ] ... 详见 `PLAN-v2.md` 第三章

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
node ./dist/cli.js
```

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
