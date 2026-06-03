# dep-radar 已完成功能详解

> 本文档基于源码逐行审查生成，详细描述 `dep-radar` 项目当前已实现的全部功能。

---

## 一、CLI 框架与命令体系

### 1.1 CLI 入口 (`src/cli.ts`)

基于 **Commander.js** 构建的 CLI 程序，支持 3 个核心命令：

| 命令      | 状态      | 说明                                                       |
| --------- | --------- | ---------------------------------------------------------- |
| `scan`    | ✅ 已完成 | 日常依赖审查与优化建议（替代 analyze + optimize + report） |
| `explain` | ✅ 已完成 | 解释单个依赖为什么存在                                     |
| `doctor`  | ✅ 已完成 | 检查项目依赖健康基线（纯本地，无网络请求）                 |

**全局选项：**

- `--no-cache` — 禁用缓存
- `--cache-dir <path>` — 自定义缓存目录
- `--verbose` — 详细日志模式（映射到 consola 的 trace 等级）
- `--silent` — 静默模式（关闭所有输出）
- `--registry <url>` — 自定义 npm registry
- `--concurrency <n>` — 并发请求数（默认 5，建议 1-20）
- `--offline` — 离线模式，跳过所有网络请求（也可通过 `OFFLINE=1` 环境变量启用）

**Verbose 模式：**

- `--verbose` 启用详细日志，逐包输出体积分析结果（包名、版本、size、gzip）

**顶层错误处理：**

- 所有异常通过 `errorEnricher` 模块增强，自动追加上下文提示（代理设置、认证、私有包等）
- `DepRadarError` 子类按错误码映射为语义化退出码
- 版本号通过 tsup `define` 注入 `__DEP_RADAR_VERSION__` 宏

### 1.2 库入口 (`src/index.ts`)

对外暴露：

- `defineConfig()` — 纯类型辅助函数，为 `dep-radar.config.ts` 提供自动补全和类型检查
- 全部公开类型的 re-export（`DepRadarConfig`, `AnalysisReport`, `BundleInfo` 等）

---

## 二、四大分析维度

### 2.1 包体积分析 (`src/analyzers/bundle.ts`)

**功能：** 分析项目所有依赖的 minified/gzip/brotli 体积。

**核心特性：**

- **依赖注入模式**：通过 `BundleFetcher` 接口注入数据源，analyzer 不直接依赖具体 API
- **并发控制**：使用 `p-limit` 控制并发请求（默认 5），避免触发 API 限流
- **容错机制**：单个包获取失败不阻断整体分析，标记为 `source='unknown'` 并记录错误原因
- **协议过滤**：自动跳过 `workspace:` / `file:` / `link:` / `git:` / `http:` 等非 npm 标准依赖
- **ignore 模式**：支持精确匹配（`'lodash'`）和末尾通配符（`'@internal/*'`）
- **版本号解析**：`resolveSpec()` 函数处理 `^1.2.3` / `~4.5.0` / `>=1 <2` / `npm:react@^18` 等各种格式
- **TopN 排序**：按 gzip 降序排列，输出体积最大的前 N 个包

**输出数据结构：**

```typescript
interface BundleAnalysisResult {
  bundles: BundleInfo[] // 全部依赖的体积信息
  totalSize: number // minified 字节总和
  totalGzip: number // gzip 字节总和
  topN: BundleInfo[] // 体积最大的前 N 个
  skipped: Array<{ name: string; reason: string }> // 被跳过的包
}
```

### 2.2 依赖健康度分析 (`src/analyzers/health.ts`)

**功能：** 综合评估每个依赖的维护状态、社区活跃度、技术质量。

**评分算法（0-100 分）：**

| 维度            | 权重  | 评分规则                                |
| --------------- | ----- | --------------------------------------- |
| 周下载量        | 25 分 | >100K: 25, >10K: 18, >1K: 10, 其他: 3   |
| 最近发布时间    | 25 分 | <1月: 25, <6月: 18, <12月: 10, <24月: 3 |
| GitHub Stars    | 15 分 | >10K: 15, >1K: 10, >100: 5              |
| 维护者人数      | 10 分 | >3: 10, >1: 6, 其他: 2                  |
| TypeScript 类型 | 10 分 | 有 types/typings 字段: 10               |
| 下载量趋势      | 15 分 | 上升: 15, 稳定: 10, 下降: 0             |

**特殊规则：** deprecated 包直接得 0 分。

**权重可配置：** 通过 `DepRadarConfig.healthWeights` 自定义各维度权重，未指定的字段使用默认值。各维度按比例缩放，总分封顶 100。

```ts
// dep-radar.config.ts
export default defineConfig({
  healthWeights: {
    weeklyDownloads: 30, // 更关注下载量
    lastPublish: 20,
    githubStars: 10, // 降低 GitHub 权重
    maintainers: 15,
    hasTypeScriptTypes: 15, // 提高 TS 支持权重
    downloadTrend: 10,
  },
})
```

**数据来源（通过 HealthFetcher 依赖注入）：**

- npm 完整 document（`registry.npmjs.org/{name}`）— 提取 maintainers、time、deprecated、types
- npm 下载量 API（`api.npmjs.org/downloads`）— 周下载量 + 趋势计算
- GitHub REST API（`api.github.com/repos`）— stars、open issues、最近 push
- GitHub 数据软失败：私有仓库、限流、404 等情况返回 null，不影响其他维度评分

**下载量趋势算法：**

- 取近一月每日下载量，对比前半月与后半月总和
- 后半月/前半月 > 1.1 → `'up'`（增长 > 10%）
- 后半月/前半月 < 0.9 → `'down'`（下降 > 10%）
- 数据点不足 14 天（新包）一律返回 `'stable'`

### 2.3 许可证合规分析 (`src/analyzers/license.ts`)

**功能：** 检查每个依赖的许可证类型，识别法律风险。

**核心特性：**

- **SPDX 表达式解析**：使用 `spdx-expression-parse` 库解析复合表达式
  - 简单标识：`'MIT'` → 直接查表
  - OR 表达式：`(MIT OR Apache-2.0)` → 取最宽松（severity 最低）
  - AND 表达式：`GPL-3.0 AND MIT` → 取最严格（severity 最高）
- **五级分类**：permissive / weak-copyleft / strong-copyleft / proprietary / unknown
- **三级风险**：low / medium / high（permissive → low, strong-copyleft → high）
- **项目级冲突规则**：检测到 GPL/AGPL 强传染、私有/UNLICENSED、未知许可证时触发告警
- **单包冲突文案**：每个包根据其许可证类型给出一句话风险提示
- **license 字段兼容**：支持字符串 `"MIT"` 和旧版对象 `{ type: "MIT" }` 两种格式

**内置许可证分类表：**

- 宽松许可（14 种）：MIT, ISC, 0BSD, BSD-2-Clause, BSD-3-Clause, Apache-2.0, CC0-1.0 等
- 弱传染（14 种）：LGPL-2.0/2.1/3.0, MPL-1.1/2.0, EPL-1.0/2.0, CDDL-1.0/1.1
- 强传染（9 种）：GPL-2.0/3.0, AGPL-3.0（含 only/or-later 变体）
- 私有（3 种）：UNLICENSED, SEE LICENSE IN LICENSE, SEE LICENSE IN LICENSE.md

### 2.4 安全漏洞审计 (`src/analyzers/security.ts`)

**功能：** 通过各包管理器的 `audit` 命令检测已知漏洞。

**核心特性：**

- **多包管理器适配**：自动检测 npm/pnpm/yarn 并使用对应的 audit 命令
- **三种解析器**：
  - npm：解析 `{ vulnerabilities: { "pkg": { severity, title, url, fixAvailable } } }`
  - pnpm：兼容旧版（`advisories` map）和新版（`vulnerabilities` 数组，pnpm >= 9）
  - yarn：解析 Yarn Berry 格式（`yarn npm audit --json`）和 Yarn Classic NDJSON 格式（`yarn audit --json`）
- **容错处理**：
  - audit 命令返回非零退出码时仍尝试从 stdout 解析（有漏洞时 npm/pnpm 会返回非零）
  - 解析失败时优雅降级，记录 skipped 而非阻断分析
  - 私有 registry 无 audit 端点时提示用户
- **四级严重度**：low / moderate / high / critical
- **汇总统计**：统计各严重度的漏洞总数，输出最高严重度

---

## 三、优化建议引擎 (`src/analyzers/optimizer.ts`)

**功能：** 将四大分析维度的结果聚合为可操作的优化建议。

**核心设计原则：以直接依赖为中心**

- **只对直接依赖生成优化建议**，不对子依赖单独生成建议
- 子依赖的问题按类型分级归并到引入它的**直接依赖**上
- 父依赖归并通过 `inventory.entries[].paths[0][0]` 精确定位（不再是把每个子依赖问题挂到所有直接依赖的桩实现）

**为什么这样设计？**

子依赖（如 jquery、@babel/plugin-proposal-class-properties）通常无法直接操作——用户不能直接卸载或替换它们。如果子依赖有问题，正确的方式是：

1. 升级引入该子依赖的直接依赖到新版本
2. 或者替换直接依赖为其他方案

**子依赖问题分级（决定是否传染父依赖）：**

| 子依赖问题类型           | 是否传染父直接依赖          |
| ------------------------ | --------------------------- |
| Deprecated               | ✅ 作为父依赖建议的 caveats |
| 高危 / Critical 安全漏洞 | ✅ 作为父依赖建议的 caveats |
| 高风险许可证             | ✅ 作为父依赖建议的 caveats |
| 体积大                   | ❌ 父依赖也无能为力，不传染 |
| 健康度低                 | ❌ 父依赖也无能为力，不传染 |

体积和健康度不传染的理由：父依赖选择引入它就是为了它的功能，父依赖既无法替换它也无法 tree-shake 掉，告知父依赖也不构成可操作信号；继续传染只是噪音。

**七条规则（按优先级从高到低，全部仅作用于直接依赖）：**

1. **Deprecated 包**（type=deprecated, priority=high）— 已废弃包直接标红
2. **命中内置替代方案表**（type=replace）— 与内置 REPLACEMENTS 表匹配
3. **体积大户**（type=replace）— gzip > 50KB 且无已知替代方案
4. **健康度过低**（type=replace）— healthScore < 30，附带低分原因说明
5. **许可证高风险**（type=replace）— license risk = high
6. **高危漏洞无修复**（type=replace）— high/critical 级别漏洞且 fixAvailable = false
7. **（合成）子依赖触发**（type=upgrade）— 父依赖自身未命中 1-6 但拉入了 actionable 子依赖问题；priority 由子依赖最高严重度决定，建议升级或评估替换父依赖

**子依赖问题在建议中的展示：**

每条 caveats 和 evidence 都带上完整祖先链（`react > some-pkg > jquery`），方便用户定位：

```text
● some-direct-dependency [deprecated] [high] [ready]
  该包已被作者标记为 deprecated；其子依赖存在 2 个问题
  caveats:
    - 子依赖 some-transitive-dep（deprecated，路径: some-direct-dependency > some-transitive-dep）: 该包已被标记为 deprecated
    - 子依赖 another-transitive-dep（security，路径: some-direct-dependency > intermediate > another-transitive-dep）: 存在 1 个 high 级别漏洞
```

**降级行为：** 若调用 `generateOptimizations` 时未提供 `inventoryEntries`，子依赖问题不会被传染（避免给所有直接依赖错误地堆 caveats）。scan 命令默认会传入完整 inventory。

**同包去重策略：**

- 按 packageName 聚合，取最严重的一条
- description 累积（用 `;` 连接），避免信息丢失
- type 优先级：deprecated > replace > upgrade ≈ remove > tree-shake/import-style

**排序算法：**

- `score = priorityWeight * 1000 + estimatedSavings`
- priorityWeight: high=3, medium=2, low=1
- 1000 的常数确保 priority 是首要排序键

**内置替代方案表（10 条）：**

| 原包        | 替代方案                     | 节省百分比 | 难度   | 破坏性 |
| ----------- | ---------------------------- | ---------- | ------ | ------ |
| moment      | dayjs                        | 97%        | low    | 否     |
| lodash      | es-toolkit / lodash-es       | 90%        | medium | 否     |
| jquery      | 原生 DOM API                 | 100%       | high   | 是     |
| classnames  | clsx                         | 60%        | low    | 否     |
| uuid        | crypto.randomUUID()          | 100%       | low    | 否     |
| request     | ofetch / undici / 原生 fetch | 80%        | medium | 是     |
| node-sass   | sass (dart-sass)             | 0%         | low    | 否     |
| formik      | react-hook-form              | 50%        | high   | 是     |
| yup         | zod                          | 30%        | medium | 是     |
| react-icons | lucide-react                 | 70%        | low    | 是     |

每条规则都包含：替代方案描述、预估节省百分比、迁移难度、是否破坏性变更、注意事项（caveats）、迁移指南链接。

用户可通过配置文件的 `replacements` 字段追加或覆盖内置规则（同名用户优先）。

---

## 四、数据获取层

### 4.1 统一 HTTP 客户端 (`src/data/http.ts`)

- 使用 Node 18+ 原生 `fetch`（基于 undici），零外部依赖
- **超时控制**：AbortController + setTimeout（默认 10s）
- **指数退避重试**：默认 3 次，minDelay 500ms，maxDelay 5000ms
- **智能重试策略**：限流(429)和 5xx 总是重试，4xx 不重试
- **错误分类**：HTTP 429 → RateLimitError，5xx → NetworkError，其他 → NetworkError
- **离线模式**：`setOfflineMode(true)` 或 `OFFLINE=1` 环境变量直接拦截所有请求
- **统一 User-Agent**：`dep-radar/{version}`

### 4.2 文件级缓存 (`src/data/cache.ts`)

- 基于 `env-paths` 的跨平台缓存目录：
  - macOS: `~/Library/Caches/dep-radar-nodejs/`
  - Linux: `~/.cache/dep-radar-nodejs/`
  - Windows: `%LOCALAPPDATA%\dep-radar-nodejs\Cache\`
- 每个 key 对应一个 `.json` 文件，key 中的 `/` 映射为目录分隔符（自动分桶）
- TTL 通过文件 mtime 判断，不额外存元数据
- 写入失败静默处理，不影响主流程
- key 安全性：保留 `[A-Za-z0-9@/_.-]`，其他字符替换为 `_`，`..` 替换为 `__` 防路径穿越
- **已全面接入**：所有数据源函数（pkg-size、bundlephobia、npm、github）均支持可选 `DataCache` 参数
- `withCache<T>(key, fetchFn)` 泛型方法封装"读缓存 → miss 则请求 → 写缓存"逻辑
- CLI `--no-cache` / `--cache-dir` / `config.cacheTTL` 均已连接到缓存实例

### 4.3 pkg-size.dev 数据源 (`src/data/pkg-size.ts`)

- 主数据源，获取包的真实 esbuild 打包体积
- API：`GET https://pkg-size.dev/api/{pkg}@{version}`
- 返回 minified / gzip / brotli 三种体积
- 支持 scoped 包名（`@scope/pkg`），使用 `encodeURI` 而非 `encodeURIComponent`

### 4.4 Bundlephobia 数据源 (`src/data/bundlephobia.ts`)

- 备用数据源，主源失败时自动 fallback
- API：`GET https://bundlephobia.com/api/size?package={spec}`
- `record=true` 可通过 `config.bundlephobiaRecord` 启用（默认 false，不向第三方写入数据）
- 不提供 brotli 数据

### 4.5 npm Registry 数据源 (`src/data/npm.ts`)

提供 5 个函数：

- `getPackageInfo(name, cache?, registry?)` — latest manifest（轻量，适合 license/types/deprecated 检查）
- `getFullPackageInfo(name, cache?, registry?)` — 完整 document（含所有版本、time、maintainers）
- `getDownloadCount(name, period, cache?)` — 指定时段下载总数
- `getDownloadRange(name)` — 近一月每日下载量明细
- `getDownloadTrend(name, cache?)` — 下载量趋势（up/down/stable）

**自定义 registry 支持**：`getPackageInfo` 和 `getFullPackageInfo` 支持 `registry` 参数，CLI `--registry` 优先级高于 `config.registry`。

### 4.6 GitHub REST API (`src/data/github.ts`)

- API：`GET https://api.github.com/repos/{owner}/{repo}`
- 支持 `GITHUB_TOKEN` 环境变量认证（未认证 60 次/小时，认证后 5000 次/小时）
- `parseGitHubUrl()` 解析多种 repository URL 格式：
  - `git+https://github.com/owner/repo.git`
  - `https://github.com/owner/repo`
  - `git@github.com:owner/repo.git`
  - `github:owner/repo`（npm 简写）
- 非 GitHub 仓库（GitLab、Bitbucket）返回 null

### 4.7 多数据源 Fallback (`src/commands/buildBundleFetcher.ts`)

- 按 `config.dataSource` 顺序依次尝试（默认 `['pkg-size', 'bundlephobia']`）
- 支持 `cache` 选项，透传给各数据源函数
- 命中 `PackageNotFoundError` → 直接抛出（包确实不存在）
- 其他错误 → 记 verbose 日志后 fallback 到下一源
- 全部源失败 → 抛最后一次错误
- 去重处理：相同数据源只保留第一个

### 4.8 HealthFetcher 工厂 (`src/commands/buildHealthFetcher.ts`)

- 组合 4 个原子函数为 `HealthFetcher` 接口
- 支持 `cache` 和 `registry` 选项，透传给底层数据源函数
- GitHub 调用软失败（私有仓库、限流等返回 null）
- 启动时一次性提示 `GITHUB_TOKEN` 未设置（避免每条记录都警告）

### 4.9 LicenseFetcher 工厂 (`src/commands/buildLicenseFetcher.ts`)

- 包装 npm `/latest` manifest 的 license 字段
- 支持 `cache` 和 `registry` 选项，透传给 `getPackageInfo`
- 兼容字符串和旧版对象格式

---

## 五、命令层编排

### 5.1 `scan` 命令 (`src/commands/scan.ts`)

**功能：** 日常依赖审查与优化建议，替代原 `analyze` + `optimize` + `report`。

**流程：**

1. 加载配置（cosmiconfig）→ 读 package.json → 检测包管理器
2. 构建 DependencyInventory（从 lockfile / node_modules）
3. 源码可达性分析 + 依赖分类
4. **并行**跑四个 analyzer（bundle + health + license + security）
5. 依赖卫生检测 + 多版本检测 + 优化建议生成
6. 默认模式过滤：只保留 actionable findings
7. 渲染报告 + 决定退出码

**模式：**

- **默认模式**：以直接依赖为中心。bundle/health/license/security 表格只展示直接依赖；子依赖的 actionable 问题（deprecated/高危漏洞/高风险许可证）以 caveats + evidence 形式归并到引入它的直接依赖建议中；只保留 actionable findings。
- **`--deep` 模式**：在 bundle/health/license/security 表格中**同时**展示子依赖，便于排查。优化建议依然遵循「以直接依赖为中心」，不会单独对子依赖产出建议。
- **`--ci` 模式**：只对 direct prod critical/high 漏洞和高风险许可证冲突返回非零。

**退出码规则：**

- 0: OK
- 1: 通用错误
- 2: 发现 direct prod critical/high 漏洞（`--ci` 模式）
- 3: 体积超出 budget
- 4: 高风险许可证冲突

**共享模块：** `src/commands/shared.ts` 提供 `loadSetup()`、`createCacheFromGlobals()`、`renderReport()`、`makeEmptyReport()`。

### 5.2 `explain` 命令 (`src/commands/explain.ts`)

**功能：** 解释单个依赖为什么存在于项目中。

**输出内容：**

- 是否为直接依赖，位于 `dependencies` / `devDependencies` / `transitive`
- 是否被源码 import/require（含文件位置和引用次数）
- 如果是 transitive：最短依赖路径
- 依赖使用分类（runtime / build / test / script / config）
- 是否可移除/移动/升级
- 操作命令建议（如 `pnpm remove X`）

**流程：** 跑完整 inventory + reachability + classification pipeline → 筛选目标包 → 输出单包报告。

### 5.3 `doctor` 命令 (`src/commands/doctor.ts`)

**功能：** 检查项目依赖健康基线。纯本地检查，不发网络请求。

**检查项（`src/analyzers/doctorChecks.ts`）：**

- Lock 文件一致性：检测到的包管理器是否与 lock 文件匹配
- 多 lock 文件：是否存在多个 lock 文件
- node_modules 状态：是否已安装，元数据是否一致
- packageManager 字段：corepack 声明是否与检测结果一致

**项目类型检测（`src/analyzers/projectDetector.ts`）：**

- 自动识别：Expo / React Native / Next.js / Vite / Node.js / unknown
- 提取框架版本和 React 版本

### 5.4 Monorepo Workspace 支持

**支持的配置格式：**

- npm/yarn `workspaces` 字段（数组或 `{ packages: [...] }` 对象）
- pnpm `pnpm-workspace.yaml`

**CLI 选项（scan）：**

- `--workspace <name>`：分析指定子包（按 name 或 path 匹配）
- `--all-workspaces`：逐个分析所有子包，退出码取最严重的

**实现：** `src/utils/workspace.ts` — `detectWorkspaces()` 检测并展开 glob 模式，`findWorkspace()` 按名称/路径查找。

### 5.7 增量分析 (`--since`)

**功能：** 只分析相对于指定 git ref 变更的依赖，大幅减少 CI 分析范围。

**实现：** `src/utils/gitDiff.ts` — `getChangedDependencies(cwd, ref)` 通过 `git show <ref>:package.json` 对比当前 HEAD，返回 `{ added, removed, changed }` 列表。

**用法：**

```bash
# 只分析相对于 main 分支变更的依赖
dep-radar scan --since main
```

---

## 六、报告生成层

### 6.1 终端报告 (`src/report/terminal.ts`)

- 彩色 ANSI 输出，使用 chalk + cli-table3 + boxen
- **Header**：圆角边框卡片，显示项目名、时间、包管理器
- **Summary**：概览区显示依赖总数、总体积（minified + gzip）、废弃数、许可证问题数、漏洞数、优化建议数
- **Bundle 表格**：包名、版本、gzip、占比、来源（彩色标记 pkg-size/bundlephobia/local/unknown）。**默认只展示直接依赖**；隐藏的子依赖数会作为脚注提示。`--deep`/`showTransitive` 时显示全部。
- **Health 表格**：包名、健康度分数（绿/黄/红色）、周下载、最近发布、废弃状态、TS 类型支持。**默认只展示直接依赖**。
- **License 表格**：仅展示直接依赖中风险不为 low 的包；`--deep` 模式下可同时展示子依赖。
- **Security 列表**：默认只展示直接依赖漏洞；子依赖漏洞已归并到优化建议中，列表底部提示隐藏数。`--deep` 模式下显示所有漏洞。
- **Optimization 列表**：按优先级 + 预估节省量排序。每条建议自身已是直接依赖维度；子依赖问题以 caveats / evidence（带完整祖先路径）出现在父依赖建议中。
- **推荐操作**：仅推荐直接依赖的可执行操作（如 `npm audit fix` 仅在直接依赖漏洞 fixAvailable 时出现）。

### 6.2 JSON 报告 (`src/report/json.ts`)

- 直接 `JSON.stringify(AnalysisReport, null, 2)`
- **不做直接/子依赖过滤**，总是输出全量原始数据，由消费者按需筛选（每条目均有 `isDirect` 字段）
- 适用于 CI 集成（被其他工具读取）

### 6.3 Markdown 报告 (`src/report/markdown.ts`)

- 标准 Markdown 表格语法，适合嵌入 GitHub PR description 或 README
- 各维度独立表格：体积、健康度、许可证、安全审计
- **默认只展示直接依赖**；隐藏的子依赖数以斜体行内提示展示；`showTransitive` 选项启用全量展示

### 6.4 HTML 报告 (`src/report/html.ts`)

- **单文件输出**：内联 CSS，无外部资源依赖
- **离线可用**：不引入 CDN、字体、图表库
- **深色主题**：CSS 变量驱动（`--bg`, `--fg`, `--accent` 等），与终端报告色调一致
- **XSS 安全**：所有用户数据通过 `escapeHtml()` 转义
- **响应式布局**：flex-wrap 自适应宽度
- **可视化组件**：
  - 统计卡片（stat cards）— 依赖总数、总体积、废弃数、许可证问题、漏洞数、优化建议
  - 体积表格 — 进度条（conic-gradient）显示占比
  - 优化建议卡片 — 按优先级着色（红/黄/灰），含替代方案、难度、迁移指南链接
  - 健康度表格 — 分数徽章（绿/黄/红）
  - 许可证表格 — 风险徽章
  - 安全审计 — 漏洞详情列表，含可修复/暂无修复标签
- **直接依赖中心**：与终端 / Markdown 一致，bundle/health/license/security 表格默认只展示直接依赖；隐藏的子依赖数会以脚注形式提示
- **Footer**：数据来源说明

---

## 七、配置系统

### 7.1 配置加载 (`src/config/loader.ts`)

基于 **cosmiconfig**，支持多种配置文件格式：

- `dep-radar.config.ts` / `.js` / `.cjs` / `.mjs` / `.json`
- `.deprdarrc` / `.deprdarrc.json` / `.deprdarrc.yaml` / `.deprdarrc.yml`
- `package.json` 的 `"dep-radar"` 字段

找不到配置文件时返回空对象（不报错），解析失败时抛 `ConfigError`。

### 7.2 配置项

```typescript
interface DepRadarConfig {
  budget?: {
    totalGzip?: number // 项目总体积上限（字节）
    perPackage?: Record<string, number> // 单包体积上限，{ "moment": 0 } 表示禁止
  }
  ignore?: string[] // 忽略的包，支持 glob 模式
  replacements?: Record<string, ReplacementRule> // 自定义替代方案
  dataSource?: Array<'pkg-size' | 'bundlephobia' | 'local'> // 数据源优先级
  registry?: string // 自定义 npm registry
  cacheTTL?: number // 缓存 TTL（秒），默认 3600
  concurrency?: number // 并发请求数，默认 5
  bundlephobiaRecord?: boolean // 是否向 Bundlephobia 写入记录，默认 false
  healthWeights?: {
    // 自定义健康度评分权重
    weeklyDownloads?: number // 周下载量权重，默认 25
    lastPublish?: number // 最近发布时间权重，默认 25
    githubStars?: number // GitHub stars 权重，默认 15
    maintainers?: number // 维护者人数权重，默认 10
    hasTypeScriptTypes?: number // TypeScript 类型权重，默认 10
    downloadTrend?: number // 下载趋势权重，默认 15
  }
}
```

### 7.3 内置许可证分类表 (`src/config/licenses.ts`)

- 40+ 种 SPDX 标识的分类映射
- 五级分类 → 三级风险映射
- 严重度权重（用于复合表达式 OR/AND 计算）
- 三条项目级冲突规则（强传染、私有、未知）

### 7.4 内置替代方案表 (`src/config/replacements.ts`)

10 条内置规则，用户可通过配置文件覆盖或追加（同名用户优先）。

---

## 八、工具层

### 8.1 格式化工具 (`src/utils/format.ts`)

- `formatBytes(bytes)` — 字节数 → 人类可读（1024 进制，如 `312.50 KB`）
- `formatDate(isoString)` — ISO → `YYYY-MM-DD`（UTC）
- `formatNumber(n)` — 千位分隔符（`1,234,567`）
- `formatRelativeTime(isoString, now?)` — ISO → 中文相对时间（`5 个月前`、`刚刚`）

### 8.2 文件系统工具 (`src/utils/fs.ts`)

- `readPackageJson(projectPath)` — 读取并解析 package.json，抛出统一错误类
- `findProjectRoot(startPath)` — 向上查找包含 package.json 的最近目录

### 8.3 日志器 (`src/utils/logger.ts`)

- 基于 **consola**，提供分等级输出（info / success / warn / error / debug）
- 三级日志模式：`silent`（-999）/ `normal`（3）/ `verbose`（5）
- 统一 tag：`dep-radar`

### 8.4 包管理器检测 (`src/utils/packageManager.ts`)

- `detectPackageManager(cwd)` — 根据 lock 文件推断（pnpm-lock.yaml > yarn.lock > npm）
- `detectYarnVersion(cwd)` — 通过 `yarn --version` 检测 Classic (1.x) vs Berry (2+)
- `PM_COMMANDS` — 各包管理器的 list/audit 命令规格（npm/pnpm/yarn berry）
- `YARN_CLASSIC_COMMANDS` — Yarn Classic 专用的 list/audit 命令规格

### 8.5 指数退避重试 (`src/utils/withRetry.ts`)

- 通用异步重试包装器
- 退避策略：`minDelay * 2^attempt`，封顶 `maxDelay`
- `shouldRetry` 回调控制重试条件

### 8.6 错误增强器 (`src/utils/errorEnricher.ts`)

- `getErrorHints(err)` — 根据错误类型生成上下文提示
- `errorCodeToExitCode(code)` — 错误码 → CLI 退出码映射
- `formatError(err, verbose)` — 格式化错误输出（消息 + 错误码 + 提示）

### 8.7 退出码 (`src/utils/exitCode.ts`)

语义化退出码契约：

- `0` — OK
- `1` — 通用错误
- `2` — 高危/严重漏洞
- `3` — 体积超出 budget
- `4` — 许可证冲突

### 8.8 自定义错误类 (`src/errors/index.ts`)

- `DepRadarError` — 基类，含 error code
- `NetworkError` — 网络错误，含 HTTP status（0 表示非 HTTP 错误）
- `RateLimitError` — API 限流（HTTP 429）
- `PackageNotFoundError` — 包不存在
- `ConfigError` — 配置文件错误

---

## 九、工程化

### 9.1 构建 (`tsup.config.ts`)

- **双产物**：
  - `cli.ts` → `dist/cli.js`（ESM + shebang banner）
  - `index.ts` → `dist/index.js` + `dist/index.d.ts`（ESM + 类型声明）
- Target: Node 18
- Source map 启用
- 版本号通过 `define` 注入

### 9.2 TypeScript (`tsconfig.json`)

- Target: ES2022, Module: NodeNext
- 严格模式全开（strict, noUnusedLocals, noUnusedParameters, noUncheckedIndexedAccess）
- `verbatimModuleSyntax` — 强制 `import type` 语法

### 9.3 测试 (`vitest.config.ts`)

- 28 个测试文件（全部 colocate 在源码目录）
- 覆盖率阈值：lines 70%, functions 70%, branches 65%
- 覆盖率排除：cli.ts, 测试文件, types/, errors/

**测试覆盖范围：**

- `src/utils/` — format, fs, packageManager, withRetry, errorEnricher, workspace
- `src/data/` — bundlephobia, github, npm, pkg-size, http, cache
- `src/analyzers/` — bundle, health, license, security, optimizer
- `src/commands/` — analyze, optimize, tree, compare, buildBundleFetcher, buildHealthFetcher, buildLicenseFetcher
- `src/config/` — loader
- `src/report/` — terminal, json, html

### 9.4 代码质量

- **ESLint** (`eslint.config.js`) — flat config 格式
- **Prettier** (`.prettierrc`) — 代码格式化
- **Husky** (`.husky/pre-commit`) — Git 提交前钩子
- **lint-staged** — 提交时自动对 `.ts` 文件执行 eslint + prettier，对 `.json/.md` 执行 prettier
- **only-allow pnpm** — `preinstall` 钩子强制使用 pnpm

### 9.5 发布 (`publish.yml` + `PUBLISH.md`)

- GitHub Actions workflow
- `prepublishOnly` 钩子：typecheck → lint → test → build
- npm 公共包发布（`@liuhuakawaii/dep-radar`）

---

## 十、类型系统 (`src/types/`)

### 10.1 基础类型 (`package.ts`)

- `PackageJson` — package.json 最小可消费形状（dependencies, devDependencies, peerDependencies, optionalDependencies, workspaces）
- `PackageManager` — `'npm' | 'pnpm' | 'yarn'`

### 10.2 API 响应类型 (`api.ts`)

- `PkgSizeResponse` — pkg-size.dev 响应
- `NpmRegistryResponse` — npm registry `/latest` 响应
- `NpmFullDocResponse` — npm registry 完整 document
- `NpmDownloadsResponse` / `NpmDownloadsRangeResponse` — npm 下载量 API
- `GithubRepoResponse` — GitHub 仓库 API

### 10.3 分析结果类型 (`analysis.ts`)

- `BundleInfo` — 单包体积信息（含 `isDirect` 字段标识是否为直接依赖）
- `HealthInfo` — 单包健康度信息（含 `isDirect` 字段标识是否为直接依赖）
- `LicenseInfo` / `LicenseCategory` — 许可证信息（含 `isDirect` 字段标识是否为直接依赖）
- `SecurityInfo` / `Vulnerability` — 安全漏洞信息
- `OptimizationSuggestion` / `OptimizationType` — 优化建议
- `AnalysisReport` — 顶层报告聚合（含 `dimensions` 标记）

### 10.4 配置类型 (`config.ts`)

- `DepRadarConfig` — 用户配置
- `ReplacementRule` — 替代方案规则

---

## 十一、架构亮点

### 11.1 依赖注入模式

所有 analyzer 都通过接口注入数据源（`BundleFetcher` / `HealthFetcher` / `LicenseFetcher` / `AuditExecutor`），实现：

- 测试时可 mock 数据源
- 数据源可独立替换（如本地 esbuild）
- analyzer 层纯逻辑，无网络副作用

### 11.2 分层架构

```
CLI 层 (cli.ts)
  └─► 命令层 (commands/*.ts)     ← 解析参数、组装流水线
        ├─► 数据层 (data/*.ts)   ← HTTP 请求、缓存、错误处理
        └─► 分析器层 (analyzers/*.ts)  ← 纯逻辑
              └─► 报告层 (report/*.ts)  ← 渲染输出
```

### 11.3 CI 友好

- 语义化退出码（0-4）用于 CI 管道判断
- JSON 输出格式便于机器解析
- budget 机制自动阻断体积膨胀
- 离线模式支持内网环境
