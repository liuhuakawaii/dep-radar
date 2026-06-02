# TODO: 依赖审查 CLI 精简优化方案

## 目标

将 CLI 从“全量 lock 文件扫描器”调整为“依赖审查与优化建议工具”。

核心目标：

- 默认扫描要快，避免被 lock 文件中的全量子依赖拖慢。
- 默认报告只输出有明确操作价值的建议。
- 子依赖风险仍然保留，但按生产影响、可达性、严重程度分层展示。
- 命令数量保持克制，避免复杂的子命令体系。
- 支持日常本地使用，也支持 CI 中做风险兜底。

非目标：

- 不默认输出 lock 文件中所有依赖的完整风险列表。
- 不把所有 transitive dependency 都当成同等优先级问题。
- 不为了安全扫描牺牲日常依赖优化体验。
- 不引入 hyper3d 相关能力。

## 精简后的 CLI 命令设计

只保留 3 个核心命令：

```bash
depcheck scan
depcheck explain <package>
depcheck doctor
```

### 1. `depcheck scan`

默认命令，用于日常依赖审查和优化建议。

默认行为：

- 分析 `package.json` 中的直接依赖。
- 解析 lock 文件，但只用于构建依赖路径和补充证据。
- 默认只展示可执行建议。
- 默认不展示完整 lock 全量扫描结果。
- 默认隐藏 low / moderate 且无明确修复动作的 transitive 风险。

推荐参数：

```bash
depcheck scan
depcheck scan --ci
depcheck scan --deep
depcheck scan --json
```

参数含义：

- `--ci`: CI 模式，只在高优先级问题上返回非零退出码。
- `--deep`: 深度模式，启用完整 lock 文件扫描。
- `--json`: 输出机器可读结果，方便 CI 或外部系统消费。

不再单独设计 `audit`、`unused`、`optimize`、`license` 等命令，避免命令体系过碎。这些能力统一归入 `scan`，通过报告分区呈现。

### 2. `depcheck explain <package>`

用于解释单个依赖为什么存在。

输出内容：

- 是否是直接依赖。
- 位于 `dependencies` 还是 `devDependencies`。
- 是否被源码 import / require。
- 是否被配置文件引用。
- 是否是框架生态必要依赖。
- 如果是子依赖，展示最短依赖路径。
- 是否可以删除、移动、升级或忽略。

示例：

```bash
depcheck explain lottie-react-native
depcheck explain react-native-worklets
```

### 3. `depcheck doctor`

用于检查项目依赖基础健康状态。

职责：

- 包管理器与 lock 文件是否匹配。
- package manager、lockfile、node_modules 是否一致。
- 框架版本是否自洽。
- 是否存在明显的文档与依赖版本不一致。
- 是否存在重复 lock 文件。

对 Expo / React Native 项目，`doctor` 应额外检查：

- Expo SDK 与 `react` / `react-native` / `expo-router` 版本是否匹配。
- `app.json` / `app.config.*` 中的 plugins 是否对应已安装依赖。
- Reanimated / Worklets / Gesture Handler 等生态依赖是否属于框架必需项。

## 默认扫描策略

配置保持简单，不做复杂 DSL。

## CI 行为

`depcheck scan --ci` 只在以下情况失败：

- P0 问题。
- P1 runtime security issue。
- 生产依赖 license block。
- 框架版本严重不匹配。
- package manager 与 lock 文件冲突。

CI 不因以下情况失败：

- dev transitive low / moderate 风险。
- 无修复路径的 transitive 风险。
- 纯建议型优化项。
- deprecated 但不可行动的问题。

## 实施计划

### Phase 1: CLI 命令收敛

- [ ] 将命令收敛为 `scan`、`explain`、`doctor`。
- [ ] 删除或合并过细命令，例如 `audit`、`unused`、`optimize`、`license`。
- [ ] 将这些能力合并到 `scan` 的报告分区中。
- [ ] 实现 `scan --ci`、`scan --deep`、`scan --json` 三个参数。
- [ ] 保证默认 `scan` 不执行完整 lock 全量扫描。

### Phase 2: 项目识别与基础健康检查

- [ ] 自动识别包管理器：pnpm / npm / yarn / bun。
- [ ] 检查 lock 文件是否与包管理器一致。
- [ ] 检查是否存在多个 lock 文件。
- [ ] 识别项目类型：Expo / React Native / Next / Vite / Node。
- [ ] 为 Expo 项目增加版本自洽检查。
- [ ] 检查 package 文档和实际依赖是否明显不一致。

### Phase 3: 直接依赖审查

- [ ] 解析 `dependencies`、`devDependencies`、`peerDependencies`、`optionalDependencies`。
- [ ] 扫描源码 import / require / dynamic import。
- [ ] 扫描配置文件引用。
- [ ] 扫描 package scripts 中的工具依赖。
- [ ] 标记直接依赖状态：used / config-used / script-used / framework-required / unused / unknown。
- [ ] 对 unused 依赖生成 remove 建议。
- [ ] 对位置错误依赖生成 move-to-dev 或 move-to-prod 建议。

### Phase 4: lock graph 分层扫描

- [ ] 使用结构化 parser 解析 pnpm lock。
- [ ] 构建 direct dependency -> transitive dependency graph。
- [ ] 构建 transitive package -> ancestor paths 映射。
- [ ] 默认只遍历 production direct dependencies 的子图。
- [ ] `--deep` 时遍历完整 lock graph。
- [ ] 对相同风险包进行路径聚合。

### Phase 5: 风险评分与噪声过滤

- [ ] 实现 P0 / P1 / P2 / P3 优先级模型。
- [ ] 实现 environment 分类：runtime / build / dev / unknown。
- [ ] 实现 confidence 分类：high / medium / low。
- [ ] 默认隐藏 low-value transitive findings。
- [ ] 默认隐藏无修复路径、无可达证据的问题。
- [ ] 主报告只展示 top actionable findings。

### Phase 6: 可执行建议生成

- [ ] 为 remove 建议生成包管理器命令。
- [ ] 为 update 建议生成升级命令。
- [ ] 为 move 建议生成 remove + add 命令。
- [ ] 为 transitive 风险生成 override 或直接依赖升级方向。
- [ ] 为 keep 建议输出保留原因。
- [ ] 为无法判断的问题输出 explain 命令建议，而不是直接下结论。

### Phase 7: 缓存与性能

- [ ] 实现 `.depcheck-cache`。
- [ ] 基于 package.json hash 和 lockfile hash 缓存结果。
- [ ] 缓存 package metadata。
- [ ] 缓存 vulnerability metadata。
- [ ] 缓存 lock graph。
- [ ] 远程请求使用批量查询和并发限制。
- [ ] 输出扫描耗时和 cache hit 状态。

### Phase 8: 输出体验

- [ ] 终端默认输出 summary + recommended actions + details。
- [ ] 控制默认输出长度。
- [ ] hidden findings 只展示数量和查看方式。
- [ ] JSON 输出保留完整结构。
- [ ] 每条 finding 都包含 evidence、suggestion、command、confidence。

### Phase 9: 测试用例

- [ ] 测试未使用直接依赖。
- [ ] 测试配置文件引用依赖不被误删。
- [ ] 测试 Expo 生态依赖不被误判。
- [ ] 测试生产 transitive high 风险进入主报告。
- [ ] 测试 dev transitive low 风险默认隐藏。
- [ ] 测试 `--deep` 输出完整 lock 风险。
- [ ] 测试 cache hit 后扫描速度明显下降。
- [ ] 测试 `--ci` 只对 P0/P1 失败。

## 验收标准

- 默认 `depcheck scan` 在中型前端项目中明显快于完整 lock 扫描。
- 默认报告中 80% 以上 finding 应该有明确操作建议。
- 默认报告不再被 transitive low-value findings 淹没。
- `--deep` 仍能拿到完整 lock 风险视图。
- `explain <package>` 可以解释依赖存在原因和删除风险。
- `doctor` 可以发现 package manager、lockfile、框架版本不一致问题。
- CI 模式稳定，不因为低价值噪声频繁失败。
