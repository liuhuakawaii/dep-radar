# dep-radar TODO: 真实项目可用性重构

> 这份 TODO 替换旧的“已完成清单”。新的目标不是继续堆功能，而是让 dep-radar 在真实前端项目里少误报、少空泛建议，并能说明每个结论来自哪里。

## 背景基线

验证项目：

`C:\Users\65632\Desktop\PROJECT-DL\deemos-project\hyper3d-frontend`

这次验证暴露出的核心问题：

- 体积维度把 `dependencies` 中大量构建、测试、脚本依赖当成浏览器运行时代码报警。
- 多数分析使用 `package.json` 声明版本或 registry latest 信息，而不是 lockfile / 实际安装版本。
- 包级体积估算被当成真实 bundle 结论，和生产构建 gzip 结果差距明显。
- 安全报告曾显示“未发现已知漏洞”，但 `npm audit --omit=dev` 实际存在 57 个生产依赖范围漏洞。
- 优化建议缺少置信度、证据和前提条件。例如 `uuid -> crypto.randomUUID()` 技术上可行，但受 browserslist 兼容约束影响，不能直接当作无条件替换。
- 真实高价值问题包括：`react-mentions` deprecated 且单点使用、Three.js 多版本并存、若干 direct deps 未被源码引用或位置可能放错。

后续开发请把 `hyper3d-frontend` 作为回归样例之一，避免只靠小型 fixture 让功能“看起来正确”。

---

## P0 - 先统一事实来源

### 1. 建立 Dependency Inventory，版本来源改为 lockfile / 实际安装版本 ✅ 已完成

**要解决的问题**

当前 `src/analyzers/bundle.ts` 的 `resolveSpec()` 会把 `^1.2.3`、`~4.5.0`、`npm:three@^0.149.0` 之类的声明范围剥成近似版本，license/health 还可能读取 latest manifest。这会让安全、license、体积和健康度都基于错误版本。

**实现路径**

- 新增 `src/analyzers/inventory.ts` 或 `src/utils/dependencyInventory.ts`，产出统一的 `DependencyInventory`。
- 新增/扩展类型文件：
  - `src/types/package.ts`
  - `src/types/analysis.ts`
- 为每个依赖记录至少保存：
  - `name`: 用户声明或树上的包名。
  - `packageName`: 实际 npm 包名，处理 alias 后的真实名。例如 `three149` 的 `packageName` 是 `three`。
  - `requestedSpec`: `package.json` 中的原始声明，例如 `npm:three@0.149.0`。
  - `resolvedVersion`: lockfile 或 `node_modules` 中的实际版本。
  - `declaredIn`: `dependencies` / `devDependencies` / `peerDependencies` / `optionalDependencies` / `transitive`。
  - `isDirect`: 是否 root direct dependency。
  - `isAlias`: 是否 npm alias。
  - `aliasOf`: alias 指向的包名和版本。
  - `resolvedFrom`: `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `node_modules` / `package-json-fallback`。
  - `paths`: 从 root 到该包的依赖路径，安全和多版本分析会用到。
- lockfile 支持顺序：
  - `package-lock.json`: 读取 `packages["node_modules/<pkg>"].version` 和 `dependencies`。
  - `pnpm-lock.yaml`: 读取 `importers` 和 `packages`，识别 `name@npm:target@version` alias。
  - `yarn.lock`: 第一阶段可先用 `yarn list --json` 或 `node_modules` 回退，后续再做完整 parser。
  - 无 lockfile 时，读取 `node_modules/<pkg>/package.json`；仍失败时才回退到 `package.json` 声明，并把 `confidence` 标低。
- `src/commands/analyze.ts` 和 `src/commands/optimize.ts` 在 `loadSetup()` 之后先构建 inventory，再把 inventory 传给各 analyzer。
- `src/analyzers/bundle.ts`、`src/analyzers/license.ts`、`src/analyzers/health.ts` 不再自己从 `pkg.dependencies` 拼目标列表。

**验收标准**

- `three149@npm:three@0.149.0` 在 inventory 中显示为：
  - `name = three149`
  - `packageName = three`
  - `resolvedVersion = 0.149.0`
  - `isAlias = true`
- `license` 和 `bundle` 查询使用 `packageName@resolvedVersion`，不是 `name@requestedSpec` 或 latest。
- 当 lockfile 和 `node_modules` 都不可用时，报告必须明确显示 `resolvedFrom=package-json-fallback`，并降低该条结论置信度。
- 增加 fixture 测试覆盖 semver range、npm alias、transitive dependency、workspace/file/git 协议。

### 2. 建立依赖作用域分类，区分运行时、构建、测试、脚本和配置依赖 ✅ 已完成

**要解决的问题**

hyper3d 报告中 `@babel/plugin-transform-private-methods`、`@rollup/plugin-terser`、`@testing-library/*`、`@sentry/cli` 被当成浏览器 bundle 体积风险。这类包多数不是运行时代码，不应该进入同一个“前端体积问题”结论。

**实现路径**

- 新增 `src/analyzers/classifier.ts`，基于 inventory 和项目文件给每个 direct dependency 标注 `usageClass`：
  - `runtime`: 被 `src` 入口可达，或被生产入口引用。
  - `build`: 构建工具、bundler plugin、loader、babel/postcss/tailwind/vite/webpack/rollup 相关。
  - `test`: 测试框架和测试工具，例如 `@testing-library/*`、`vitest`、`jest`。
  - `script`: 只在 `package.json scripts` 中出现，例如 CLI 工具。
  - `config`: 只在配置文件中出现，例如 `postcss.config.*`、`vite.config.*`、`webpack.config.*`。
  - `unknown`: 没找到证据，不能直接假定进入浏览器。
- 分类依据按优先级记录到 `evidence`：
  - `src` 可达 import。
  - config 文件 import。
  - test 文件 import。
  - `package.json scripts` 文本命中。
  - 包名规则兜底。
- 修改 `src/analyzers/bundle.ts`：
  - 默认只对 `usageClass=runtime` 或 `unknown` 中可证明进入 bundle 的包做“浏览器体积”结论。
  - 对 `build/test/script/config` 只输出“依赖治理”或“可能 misplaced”建议，不参与 runtime gzip 汇总。
- CLI 增加或配置化：
  - `--scope runtime|all|non-runtime`
  - config: `classification.overrides`
  - config: `runtimeEntryGlobs`

**验收标准**

- hyper3d 中以下包不再作为浏览器 runtime bundle 体积报警：
  - `@babel/plugin-transform-private-methods`
  - `@rollup/plugin-terser`
  - `@testing-library/*`
  - `@sentry/cli`
- 报告仍可在“依赖治理”区显示这些包，但必须注明分类依据，例如“仅在配置/脚本/测试中出现”。
- 对分类为 `unknown` 的包不能输出高置信度体积节省建议，只能输出“需要确认是否进入 bundle”。

---

## P1 - 接入真实代码可达性和真实 bundle 数据

### 3. 从源码入口做可达性分析，给建议附源码证据 ✅ 已完成

**要解决的问题**

当前 optimizer 只知道“项目声明了某包”，不知道这个包是否被源码用到、在哪些文件用到、使用频率如何。因此它会低估 `react-icons` 迁移成本，也无法识别 `react-mentions` 是单点使用。

**实现路径**

- 新增 `src/analyzers/reachability.ts`。
- 扫描范围：
  - 默认 `src/**/*.{js,jsx,ts,tsx,mjs,cjs}`。
  - config 文件：`vite.config.*`、`webpack.config.*`、`rollup.config.*`、`postcss.config.*`、`tailwind.config.*`、`craco.config.*`。
  - 测试文件：`*.test.*`、`*.spec.*`、`__tests__/**`。
- 解析 import 形式：
  - ESM: `import x from 'pkg'`、`import('pkg')`、`export ... from 'pkg'`。
  - CommonJS: `require('pkg')`。
  - 子路径归一化：`react-icons/fa` 归到 `react-icons`，`@scope/pkg/sub` 归到 `@scope/pkg`。
- 推荐先引入轻量 parser：
  - `es-module-lexer` 处理 ESM。
  - `cjs-module-lexer` 或受控正则处理 CommonJS。
  - `fast-glob` 做文件扫描。
  - 如果后续要准确处理 TS path alias，再考虑 `tsconfck` 或 TypeScript compiler API。
- `ReachabilityResult` 至少包含：
  - `packageName`
  - `importers`: `{ file, line, column, specifier, importKind }[]`
  - `sourceBucket`: `src` / `test` / `config` / `script`
  - `reachableFromRuntimeEntry`
  - `importCount`
- optimizer 使用 import evidence：
  - 单点使用且 deprecated 的包，建议优先级提高。
  - 大量使用的包，迁移难度提高，不能输出“低难度”。
  - 没有 import evidence 的 direct dependency，进入 unused/misplaced 检测。

**验收标准**

- hyper3d 中 `react-mentions` 报告应显示唯一源码引用：
  - `src\components\newRodin\components\Remix\index.tsx:51`
- `react-icons` 应显示大量 `react-icons/*` 子路径引用，迁移难度不得标成 low。
- `@react-three/drei`、`@react-three/fiber` 若无源码静态引用，应进入 unused direct deps 候选，而不是 runtime bundle 体积大户。

### 4. 接入真实构建产物数据，区分”包级估算”和”项目 bundle 贡献” ✅ 已完成

**要解决的问题**

报告中的总量约 3.06 MB 来自包级估算，不等于真实生产 bundle。hyper3d 实际生产构建 gzip JS 大致为：

- `main` 约 2.18 MB
- `vendors` 约 0.89 MB
- `vendor-threejs` 约 0.31 MB

工具必须把“包级估算”与“真实 bundle 结果”分开展示。

**实现路径**

- 新增 `src/analyzers/buildArtifacts.ts` 或 `src/data/buildStats.ts`。
- 新增 CLI/config 输入：
  - `--stats <file>`: webpack stats JSON。
  - `--assets-dir <dir>`: 生产构建输出目录，计算 JS/CSS gzip/brotli。
  - `--sourcemap <glob>`: 从 source map 中归因 package contribution。
  - config: `buildArtifacts.statsFile`、`buildArtifacts.assetsDir`、`buildArtifacts.sourceMaps`。
- 支持三类数据：
  - webpack `stats.json`: 读取 chunks/assets/modules，按 `node_modules/<pkg>` 归因。
  - Vite/Rollup `manifest.json` + sourcemap: 读取 chunk 文件和 module sources。
  - assets fallback: 无法归因时至少计算每个 JS/CSS chunk 的 raw/gzip/brotli。
- 扩展 `BundleInfo`：
  - `estimateSize` / `estimateGzip`: pkg-size 或 Bundlephobia 估算。
  - `actualGzip`: 真实构建产物贡献，不能归因则为空。
  - `chunks`: 命中的 chunk 列表。
  - `bundleSource`: `build-stats` / `source-map` / `asset-gzip` / `pkg-estimate`。
- 报告输出规则：
  - 顶部总量优先使用真实 assets gzip。
  - 单包贡献只在有 stats/source map 归因时显示为 actual。
  - 没有真实构建输入时，必须写明“当前为包级估算，不能代表项目 bundle”。

**验收标准**

- 对 hyper3d 传入构建产物后，报告总 JS gzip 应接近真实 chunk 结果，而不是继续显示包级估算总量约 3.06 MB。
- `@babel/plugin-transform-private-methods`、`@testing-library/*` 不应出现在真实 runtime chunk 贡献中。
- HTML/JSON/terminal/markdown 报告都要区分 `actual` 和 `estimate`。

---

## P2 - 重做安全和 license 结论

### 5. 安全审计改为保留 npm audit 原始证据，区分 direct / transitive / prod / dev ✅ 已完成

**要解决的问题**

当前 `src/analyzers/security.ts` 只把 audit 输出压缩成 `{ name, severity, title, url, fixAvailable }`，丢失了 `via`、`effects`、`range`、`nodes`、路径、是否 direct、是否生产依赖等关键信息。真实项目里这会导致漏报或错误归因。

**实现路径**

- `runSecurity()` 默认使用生产依赖口径：
  - npm: `npm audit --json --omit=dev`
  - pnpm: `pnpm audit --json --prod`
  - yarn: 根据版本使用等价 prod 参数；不支持时在报告中标注限制。
- `--include-dev` 时才审计 dev 范围。
- 扩展类型：
  - `SecurityInfo.scope`: `prod` / `dev` / `mixed` / `unknown`
  - `SecurityInfo.isDirect`
  - `SecurityInfo.dependencyPaths`
  - `Vulnerability.id`
  - `Vulnerability.source`
  - `Vulnerability.range`
  - `Vulnerability.via`
  - `Vulnerability.effects`
  - `Vulnerability.fixVersion`
  - `Vulnerability.fixCommand`
- 解析 npm audit v7+ 的 `vulnerabilities` 对象时保留：
  - `name`
  - `severity`
  - `isDirect`
  - `via`
  - `effects`
  - `range`
  - `nodes`
  - `fixAvailable`
- direct/transitive 判定优先使用 audit 的 `isDirect`，再用 inventory 校验。
- 报告中拆分：
  - direct prod vulnerabilities
  - transitive prod vulnerabilities
  - dev-only vulnerabilities
  - fix available / no fix available
- optimizer 安全建议规则改成：
  - direct critical/high: 高优先级升级或替换。
  - transitive critical/high: 优先建议升级引入链上的 direct dependency。
  - dev-only: 不和 runtime 风险混在一起。

**验收标准**

- hyper3d `npm audit --omit=dev` 的 57 个生产依赖范围漏洞必须被报告出来。
- direct dependency 中至少能识别：
  - critical: `fast-xml-parser`、`swiper`
  - high: `axios`、`fabric`、`react-cookie-consent`
  - moderate: `@react-three/drei`、`@rollup/plugin-terser`、`i18next-http-backend`、`postcss`、`qs`、`react-mentions`、`uuid`
- 报告不得再输出“未发现已知漏洞”，除非 audit 原始结果确实为空。
- JSON 报告保留足够字段，便于 CI 根据 direct critical/high 失败。

### 6. License 分析基于 resolved version，并显示元数据来源 ✅ 已完成

**要解决的问题**

当前 `src/analyzers/license.ts` 注释和实现都倾向于读取 registry latest manifest，只看 license 字段。这会让特定安装版本的 license 判断失真，也会把元数据缺失误判成 UNKNOWN。

**实现路径**

- `LicenseFetcher.getLicense()` 改为接收 `{ packageName, resolvedVersion, installPath }`。
- 数据来源优先级：
  - `node_modules/<pkg>/package.json` 的 `license` / `licenses` 字段。
  - `node_modules/<pkg>/LICENSE*` 文件摘要，用于辅助 UNKNOWN 判断。
  - registry manifest `/<pkg>/<resolvedVersion>`。
  - registry latest 只作为最后 fallback，且必须标注 `source=registry-latest-fallback`。
- 扩展 `LicenseInfo`：
  - `version`
  - `source`
  - `rawLicense`
  - `normalizedLicense`
  - `evidence`
  - `needsHumanReview`
- license 解析增强：
  - 支持 `licenses: [{ type }]` 旧格式。
  - 支持 `SEE LICENSE IN ...`，标为 `unknown` 但显示 license 文件证据。
  - 对 `UNLICENSED`、`proprietary`、`Commercial` 明确归类为人工确认。
- 报告中把“缺失元数据”和“法律高风险”分开，不要都混成 UNKNOWN 高风险。

**验收标准**

- `@sentry/cli` 的 license 结论使用实际安装版本，不使用错误的 latest/声明版本。
- `gsap` 保持“需人工合规判断”，并说明依据是其非标准商业授权文本，而不是简单 UNKNOWN。
- `toastr` 不能只因 registry 字段读取不完整就直接 UNKNOWN；应尝试实际安装包 metadata 和 license 文件。

---

## P3 - 让优化建议带置信度、前提和操作路径

### 7. 为 OptimizationSuggestion 增加置信度、证据和前提条件 ✅ 已完成

**要解决的问题**

当前 `src/analyzers/optimizer.ts` 只基于规则表和简单阈值生成建议，容易给出过度确定的结论。例如 `uuid -> crypto.randomUUID()` 在 hyper3d 中只使用了 `v4()`，但 browserslist 包含较老 iOS Safari 目标，不能无条件建议替换。

**实现路径**

- 扩展 `OptimizationSuggestion`：
  - `confidence`: `high` / `medium` / `low`
  - `actionability`: `ready` / `needs-review` / `info`
  - `evidence`: `{ source, file?, line?, detail }[]`
  - `assumptions`: 字符串数组。
  - `preconditions`: 字符串数组。
  - `blockedBy`: 字符串数组。
  - `suggestedSteps`: 字符串数组。
- optimizer 规则不再只看包名命中，要同时看：
  - inventory resolved version。
  - reachability import count。
  - usageClass。
  - real bundle contribution。
  - security/license evidence。
- 对浏览器原生 API 替换增加兼容校验：
  - 读取项目 `browserslist`。
  - 检查 `caniuse-lite` 数据是否过旧。
  - 对 `crypto.randomUUID()` 输出“可替换，但需 fallback/更新浏览器目标”的前提。
- 报告排序规则调整：
  - `ready + high confidence + high impact` 优先。
  - `needs-review` 不应排在明确漏洞修复前面。
  - `info` 不应作为“节省体积”主建议。

**验收标准**

- hyper3d 中 `react-mentions` 输出为高置信度建议：
  - 原因：deprecated。
  - 证据：源码单点使用。
  - 操作路径：替换或移除该输入组件依赖。
- `uuid` 输出为中等置信度、`needs-review`：
  - 前提：只使用 `v4()`。
  - 风险：browserslist / iOS Safari 兼容需要 fallback。
  - 不允许直接写“100% 节省，低难度，无条件替换”。
- `react-icons` 不允许标为低难度小收益建议；应显示使用面较广、需按图标集分批迁移。

### 8. 增加 unused direct deps 和 misplaced deps 检测 ✅ 已完成

**要解决的问题**

真实项目中有一批 direct dependencies 没有源码静态引用，或更像应该放到 devDependencies / scripts / config 的依赖。当前工具没有专门区分，导致它们被体积模块误报或完全漏掉。

**实现路径**

- 新增 `src/analyzers/dependencyHygiene.ts`。
- 输入 inventory + reachability + classifier。
- 输出两类建议：
  - `unused-direct`: direct dependency 在 `src/test/config/scripts` 都没有证据。
  - `misplaced-dependency`: 包被声明在 `dependencies`，但只在 `test/build/config/script` 中使用。
- 判断规则：
  - runtime source import -> 不是 unused。
  - package scripts 命中 -> script dependency，若在 `dependencies` 中则建议移到 devDependencies，除非它是运行时 CLI wrapper。
  - config/test 文件命中 -> dev dependency 候选。
  - 无任何证据 -> removal candidate，但置信度默认 medium，需要人工确认动态 import。
- 增加 config：
  - `hygiene.ignore`
  - `hygiene.allowDynamic`
  - `hygiene.runtimePackages`
- 报告中不要把 unused 和 runtime bundle 体积混在一起，单独放“依赖清理”区。

**验收标准**

hyper3d 中以下包如果仍无静态源码证据，应进入 `unused-direct` 或 `needs-review` 清理候选：

- `@fortawesome/free-solid-svg-icons`
- `@fortawesome/react-fontawesome`
- `@react-three/drei`
- `@react-three/fiber`
- `front-matter`
- `image-capture`
- `qrcode.react`
- `react-helmet`
- `react-image-crop`
- `three.meshline`
- `toastr`

报告必须为每个候选显示“为什么判定”：无源码 import、只在配置中出现、只在 scripts 中出现，或仅包名规则命中。

### 9. 增加多版本库专项检测，特别处理 alias 和 transitive 版本 ✅ 已完成

**要解决的问题**

hyper3d 的 Three.js 问题不是“单个包很大”，而是多个版本并存：

- `three@0.165.0`
- `three149@npm:three@0.149.0`
- `stats-gl` 传入 `three@0.170.0`

当前工具没有把这类问题作为独立风险输出。

**实现路径**

- 新增 `src/analyzers/duplicateVersions.ts`。
- 基于 inventory 按 `packageName` 聚合版本：
  - direct declared version。
  - alias version。
  - transitive version。
  - dependency path。
- 输出 `DuplicateVersionInfo`：
  - `packageName`
  - `versions`
  - `directPackages`
  - `aliases`
  - `introducedBy`
  - `runtimeReachable`
  - `chunks`
  - `recommendation`
- 特殊处理大型基础库：
  - `three`
  - `react`
  - `react-dom`
  - `lodash`
  - `rxjs`
  - `monaco-editor`
- optimizer 不再对这类包只给“替换更小包”，而是给“统一版本 / 移除 alias / 检查兼容层 / bundle split”建议。

**验收标准**

- hyper3d 中能识别 `three149` 是 `three` 的 alias，而不是一个全新包。
- 报告应显示 `stats-gl -> three@0.170.0` 的引入路径。
- `src\render\sssss_rendering.js:1` 中的 `three149` 使用应作为 alias 仍在用的证据。
- 建议标题应类似“Three.js 多版本并存”，不是“three 包体积过大”。

---

## P4 - 输出层改造成证据驱动报告

### 10. 给所有报告格式补充”判定依据”和”适用范围” ✅ 已完成

**要解决的问题**

用户需要知道结论为什么成立、证据来自哪里、适用范围是什么。当前报告更像结果表，缺少可追溯性。

**实现路径**

- 在 `src/types/analysis.ts` 增加通用证据类型：
  - `EvidenceSource`
  - `SourceLocation`
  - `Confidence`
  - `AnalysisScope`
- 每类结果都能附 evidence：
  - `BundleInfo.evidence`
  - `LicenseInfo.evidence`
  - `SecurityInfo.evidence`
  - `OptimizationSuggestion.evidence`
  - `DependencyHygieneInfo.evidence`
  - `DuplicateVersionInfo.evidence`
- 修改报告生成器：
  - `src/report/terminal.ts`: 简短显示依据，例如 `source: lockfile + source-map`。
  - `src/report/html.ts`: 每条建议增加可展开 evidence 面板。
  - `src/report/json.ts`: 完整保留 evidence，适合 CI 和外部系统消费。
  - `src/report/markdown.ts`: 在建议下方用短列表显示关键证据。
- 报告文案明确区分：
  - `actual bundle`
  - `package estimate`
  - `declared dependency`
  - `installed dependency`
  - `runtime reachable`
  - `needs manual review`

**验收标准**

- 对 `uuid`，报告必须说明建议适用范围和浏览器兼容前提。
- 对 `react-mentions`，报告必须显示 deprecated 来源和源码引用位置。
- 对 security，报告必须显示 audit 命令口径，例如 `npm audit --json --omit=dev`。
- 对 license，报告必须显示 license 来源是 actual installed package 还是 registry resolved version。

### 11. 用 hyper3d 建立回归 fixture 和快照测试 ✅ 部分完成（analyzer 测试已就绪，hyper3d fixture 待补充）

**要解决的问题**

没有真实复杂项目 fixture，容易让 dep-radar 在小样例上通过测试，但在真实项目继续误报。

**实现路径**

- 新增 `tests/fixtures/hyper3d-like/`，不要直接复制完整商业源码，只保留最小可复现数据：
  - `package.json` 片段。
  - lockfile 片段，覆盖 `three149` alias、多版本 `three`、有漏洞 direct deps。
  - `src/components/newRodin/components/Remix/index.tsx` 最小片段，包含 `react-mentions` import。
  - `src/render/sssss_rendering.js` 最小片段，包含 `three149` import。
  - `npm-audit-prod.json`，记录 57 个漏洞的结构样例和 direct critical/high。
  - `webpack-stats.json` 或 `build-assets/` 最小样例，覆盖 main/vendors/vendor-threejs chunk。
- 增加测试文件：
  - `src/analyzers/inventory.test.ts`
  - `src/analyzers/classifier.test.ts`
  - `src/analyzers/reachability.test.ts`
  - `src/analyzers/buildArtifacts.test.ts`
  - `src/analyzers/dependencyHygiene.test.ts`
  - `src/analyzers/duplicateVersions.test.ts`
  - 更新 `src/analyzers/security.test.ts`
  - 更新 `src/analyzers/license.test.ts`
  - 更新 `src/analyzers/optimizer.test.ts`
- 增加 CLI 级快照：
  - `optimize --format json`
  - `optimize --format markdown`
  - `analyze --only security --format json`

**验收标准**

- 测试能稳定证明这些旧误报已经消失：
  - 构建/测试依赖不再算 runtime bundle 体积。
  - security 不再漏掉 hyper3d 的生产漏洞。
  - `uuid` 建议带兼容前提。
  - `three` 多版本作为专项问题出现。
  - `react-mentions` 是高价值建议，并带单点源码证据。

---

## 推荐实施顺序

1. 先做 `DependencyInventory`，否则版本、license、安全和多版本都会继续建立在错误事实上。
2. 再做 `classifier + reachability`，先减少体积和优化建议的明显误报。
3. 接着改 security 和 license，让高风险结论可信。
4. 然后接真实 bundle 数据，纠正“总体积”和“节省体积”的口径。
5. 最后改 optimizer 和 report，把证据、置信度、前提条件展示给用户。

## 每阶段都必须同步检查

- 若新增 CLI 选项或配置字段，按 `CLAUDE.md` 要求同步更新 `README.md` 和 `FEATURES.md`。
- 若只做内部重构或测试补充，可以不更新 README，但需要更新 `FEATURES.md` 中对应模块说明。
- 每个 analyzer 的新增结果字段都要同步覆盖：
  - `src/types/analysis.ts`
  - `src/report/json.ts`
  - `src/report/terminal.ts`
  - `src/report/html.ts`
  - `src/report/markdown.ts`
  - 对应 `.test.ts`

## 非目标

- 不要继续把 Bundlephobia/pkg-size 的包级估算包装成真实项目 bundle 结论。
- 不要把所有 `dependencies` 默认当成浏览器运行时代码。
- 不要只输出“建议替换某包”，必须说明证据、适用前提和迁移成本。
- 不要为了让报告显得乐观而隐藏 skipped、fallback、unknown、low-confidence 结论。
