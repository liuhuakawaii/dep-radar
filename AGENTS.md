# AGENTS.md

## 项目概述

`dep-radar` 是前端依赖分析 CLI 工具（`@liuhuakawaii/dep-radar`），提供包体积分析、健康度评分、许可证合规检查、安全漏洞审计和优化建议。

## 核心规则

### 文档同步更新（强制）

**任何涉及功能变更的修改，必须同步更新以下文档：**

1. **README.md** — 用户面向的文档，包含安装、配置、CLI 参考
   - 新增/修改 CLI 选项 → 更新对应命令的选项表
   - 新增/修改配置项 → 更新「配置项说明」表
   - 新增命令 → 更新快速上手 + CLI 参考 + 全局选项表
   - 新增报告格式 → 更新项目简介 + 对应命令的 `--format` 说明

2. **FEATURES.md** — 功能实现详解，面向开发者和贡献者
   - 新增功能 → 添加对应章节
   - 修改现有功能 → 更新对应章节的描述
   - 新增配置项 → 更新 7.2 配置项接口
   - 新增测试文件 → 更新测试覆盖范围

### 何时触发更新

| 变更类型        | README.md | FEATURES.md |
| --------------- | --------- | ----------- |
| 新增 CLI 选项   | ✅        | ✅          |
| 新增配置字段    | ✅        | ✅          |
| 新增命令        | ✅        | ✅          |
| 新增报告格式    | ✅        | ✅          |
| 新增分析维度    | ✅        | ✅          |
| 修改退出码规则  | ✅        | ✅          |
| 新增工具模块    | ❌        | ✅          |
| 纯重构/测试补充 | ❌        | ❌          |
| Bug 修复        | ❌        | ❌          |

## 技术约定

- **模块系统**：ESM + NodeNext，所有 import 必须带 `.js` 后缀
- **类型导入**：`verbatimModuleSyntax`，仅类型用途必须用 `import type`
- **构建工具**：tsup，双产物（cli.js + index.js/d.ts）
- **测试框架**：vitest，测试文件与源码 colocate
- **包管理器**：pnpm（preinstall 钩子强制）
- **版本号**：`__DEP_RADAR_VERSION__` 由 tsup define 注入

## 项目结构

```
src/
├── cli.ts              # CLI 入口（Commander）
├── index.ts            # 库入口（defineConfig + 类型 re-export）
├── commands/           # 子命令编排
├── analyzers/          # 业务分析器（纯逻辑，依赖注入）
├── data/               # 数据获取层（HTTP、API、缓存）
├── report/             # 报告生成器（terminal/json/html/markdown）
├── config/             # 配置加载、替代方案表、许可证分类
├── errors/             # 自定义错误类
├── types/              # 类型定义
└── utils/              # 工具函数
```

## 常用命令

```bash
pnpm test               # 运行测试
pnpm run typecheck       # TypeScript 类型检查
pnpm run build           # 构建
pnpm run lint            # ESLint 检查
```
