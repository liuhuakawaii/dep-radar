# dep-radar TODO 清单

> 基于源码审查发现的问题，按优先级排列。

---

## P0 — 基础功能缺失（影响可用性）

### 1. 接入缓存系统 ✅

缓存模块已实现但从未被任何 fetcher 使用，导致每次运行都全量请求 API。

- [x] 在 `src/data/pkg-size.ts` 的 `getPackageSize` 中接入 `DataCache`
- [x] 在 `src/data/bundlephobia.ts` 的 `getPackageSize` 中接入 `DataCache`
- [x] 在 `src/data/npm.ts` 的 4 个函数中接入 `DataCache`
- [x] 在 `src/data/github.ts` 的 `getRepoInfo` 中接入 `DataCache`
- [x] 将 CLI 的 `--no-cache` 选项连接到 `DataCache`（禁用时跳过缓存读写）
- [x] 将 CLI 的 `--cache-dir` 选项传递给 `DataCache` 构造函数
- [x] 将 `DepRadarConfig.cacheTTL` 传递给 `DataCache` 构造函数
- [x] 各 fetcher 需要接收 `DataCache` 实例（通过依赖注入或参数）

### 2. 接入 `--registry` 选项 ✅

registry 选项被 CLI 接受但从未传递给数据源，私有 registry 用户完全不可用。

- [x] 修改 `src/data/npm.ts`：`REGISTRY_URL` 改为从参数/config 读取，而非硬编码
- [x] 在 `src/commands/analyze.ts` 和 `src/commands/optimize.ts` 中将 `config.registry` 传递给 fetcher
- [x] CLI `--registry` 全局选项需合并到 config 中（优先级：CLI > config > 默认值）
- [x] `buildHealthFetcher` / `buildLicenseFetcher` 需要接收 registry 参数
- [x] 更新 `errorEnricher.ts` 中的提示文案（当前建议用户用 `--registry`，但实际无效）

### 3. `optimize` 命令接入安全审计 ✅

最常用的命令缺少安全漏洞维度。

- [x] 在 `src/commands/optimize.ts` 中接入 `analyzeSecurity`（与 bundle/health/license 并行）
- [x] 需要 `AuditExecutor` 实例（复用 `analyze.ts` 中的 `defaultAuditExecutor`）
- [x] 移除 `security: []` 硬编码
- [x] 更新 `dimensions.security` 标记
- [x] 考虑添加 `--skip-security` 选项（对称 `--skip-health` / `--skip-license`）

---

## P1 — 显著影响用户体验

### 4. `tree` 命令读取用户配置 ✅

当前直接用内置 `REPLACEMENTS` 常量，忽略用户自定义替代方案。

- [x] `treeCommand` 中加载用户配置（`loadUserConfig`）
- [x] 用 `mergeReplacements(config.replacements)` 替代直接 import `REPLACEMENTS`
- [x] `treeCommand` 函数签名需增加 config 参数或在内部加载

### 5. 使用 `formatRelativeTime` 替代绝对日期 ✅

已实现但未使用，"最近发布"展示绝对日期不够直观。

- [x] 在 `src/report/terminal.ts` 的 `renderHealthSection` 中，将 `formatDate(h.lastPublish)` 改为 `formatRelativeTime(h.lastPublish)`
- [x] 在 `src/report/html.ts` 的 `renderHealthSection` 中做同样修改
- [x] 保留 `formatDate` 用于 header 的"分析时间"（绝对日期更合适）

### 6. `--format terminal --output` 去除 ANSI 转义码 ✅

写文件时 ANSI 码会变成乱码。

- [x] 在 `src/commands/analyze.ts` 的文件写入逻辑中，当 format=terminal 且 output 存在时，strip ANSI 转义码
- [x] 在 `src/commands/optimize.ts` 中做同样处理
- [x] 可使用正则 `/\x1B\[[0-9;]*m/g` 或引入 `strip-ansi`（但注意包体积）

### 7. 添加 `--concurrency` 选项 ✅

并发数硬编码为 5，无法适配不同场景。

- [x] 在 CLI 中添加 `--concurrency <n>` 全局选项
- [x] 在 `DepRadarConfig` 中添加 `concurrency` 字段
- [x] 将值传递给各 analyzer 的 `options.concurrency`
- [x] 默认值保持 5，文档建议范围 1-20

### 8. `errorCodeToExitCode` 实现有意义的映射 ✅

当前所有错误码都映射到 1，设计意图没有体现。

- [x] `RATE_LIMIT` → 保持 1，但可考虑独立码
- [x] `PACKAGE_NOT_FOUND` → 保持 1（单包不影响整体）
- [x] `CONFIG_ERROR` → 保持 1
- [x] 至少在 verbose 模式下输出错误码到 stderr，方便 CI 调试

---

## P2 — 功能完整性提升

### 9. `analyze` 命令支持多维度 ✅

当前 `--only` 限制为单一维度，用户需要跑多次。

- [x] 将 `--only` 改为支持逗号分隔：`--only size,health`
- [x] 或添加 `--all` 选项，等价于 `--only size,health,license,security`
- [x] 内部改为循环调用各 runXxx 函数，复用现有逻辑
- [x] 退出码取所有维度中最严重的

### 10. `compare` 命令扩展到多维度 ✅

当前只比较体积。

- [x] 添加 `--dimensions <dims>` 选项（默认 `size`，可选 `health,license`）
- [x] health 维度：对比健康度分数变化
- [x] license 维度：对比许可证风险变化
- [x] 输出格式扩展：每个维度一个 section

### 11. 添加真实 API 集成测试 ✅

`tests/integration/` 目录为空，无法验证端到端行为。

- [x] 对 pkg-size.dev 的真实请求测试（选 1-2 个稳定小包如 `ms`、`chalk`）
- [x] 对 npm registry 的真实请求测试
- [x] 多数据源 fallback 的端到端测试（主源 404 → 备用源）
- [x] 注意：集成测试应标记为 `skip` 在 CI 中（避免依赖网络），或使用 `it.skipIf(!process.env.INTEGRATION)`
- [x] GitHub API 测试需要 `GITHUB_TOKEN`，条件跳过

### 12. Health 评分权重可配置 ✅

硬编码的权重无法适配不同团队需求。

- [x] 在 `DepRadarConfig` 中添加 `healthWeights` 可选字段
- [x] 默认值保持当前硬编码值
- [x] `computeHealthScore` 接收 weights 参数
- [x] 文档说明各权重的含义和建议值

### 13. Yarn Classic 适配 ✅

当前 tree 和 security 都不支持 Yarn 1.x。

- [x] `tree` 命令：解析 `yarn list --json` 的 Classic 输出格式
- [x] `security` 分析器：检测 Yarn 版本（1.x vs Berry），选择对应的 audit 命令
- [x] 或在检测到 Yarn Classic 时给出明确提示并建议升级

---

## P3 — 锦上添花

### 14. Monorepo 支持 ✅

- [x] 检测 `workspaces` 字段，列出所有子包
- [x] 添加 `--workspace <name>` 选项分析特定子包
- [x] 或 `--all-workspaces` 分析全部并汇总

### 15. 增量分析 ✅

- [x] `--since <ref>` 选项：只分析 git diff 引入的依赖变更
- [x] 与 `compare` 命令结合，对比当前分支与 main 的依赖差异
- [x] CI 场景下大幅减少分析范围

### 16. `report` 命令独立功能 ✅

当前只是 `optimize --format html` 的别名。

- [x] 考虑是否移除该命令（避免混淆）
- [x] 或赋予独立能力：支持多种格式、支持模板自定义

### 17. Bundlephobia `record=true` 行为可选 ✅

- [x] 在配置中添加 `bundlephobiaRecord?: boolean` 选项
- [x] 默认 false（不替用户向 Bundlephobia 写入数据）
- [x] 仅在用户明确同意时启用

### 18. 进度条替代单一 spinner ✅

依赖多的项目只显示一个 spinner，用户无法感知进度。

- [x] 使用 ora 的 `text` 更新或引入 `listr2`
- [x] 显示 `分析中 [23/156] lodash...`
- [x] verbose 模式下逐包输出结果

### 19. 输出 `--format markdown` ✅

- [x] 新增 markdown 报告生成器
- [x] 适合嵌入 GitHub PR description 或 README
- [x] 表格用标准 markdown 语法

---

## 代码清理

- [x] 删除 `errorCodeToExitCode` 函数或重新设计映射逻辑
- [x] 清理 `src/cli.ts` 中已标记为占位的注释（功能已实现）
- [x] 统一 `cli.ts` 头部注释的命令状态标记（当前显示 optimize/compare/report 为 🚧，实际已完成）
- [x] `src/data/github.ts` 的 `parseGitHubUrl` 与 `src/analyzers/health.ts` 的 `parseGitHubOwnerRepo` 功能重复，合并为一个
