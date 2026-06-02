/**
 * `optimize` 命令：聚合 bundle + health + license + security 数据并生成可操作建议
 *
 * 流程：
 *   1. 加载配置 + 读 package.json
 *   2. 构建 DependencyInventory（统一事实来源）
 *   3. **并行**跑四个 analyzer（避免依赖串行带来的等待）
 *   4. 把结果喂给 generateOptimizations
 *   5. 把建议填到 AnalysisReport.optimizations 后渲染
 *
 * 与 analyze 命令的关系：
 *   - analyze 是单维度详查（终端表格友好）
 *   - optimize 是跨维度全景 + 推荐（用户最终关心的"我该做什么"）
 *
 * 退出码：
 *   - 当前只返回 OK / ERROR
 *   - 是否要"有 high-priority 建议时返回非零"是个产品决策，目前保守不加
 *     （避免 CI 因为内置建议表更新而突然失败）
 */

import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

import ora from 'ora'

const execFileP = promisify(execFile)

import { analyzeBuildArtifacts } from '../analyzers/buildArtifacts.js'
import { analyzeBundleSize } from '../analyzers/bundle.js'
import { classifyDependencies } from '../analyzers/classifier.js'
import { detectDuplicateVersions } from '../analyzers/duplicateVersions.js'
import { detectHygieneIssues } from '../analyzers/dependencyHygiene.js'
import { analyzeHealth } from '../analyzers/health.js'
import { buildInventory } from '../analyzers/inventory.js'
import { analyzeLicenses } from '../analyzers/license.js'
import { analyzeReachability } from '../analyzers/reachability.js'
import { analyzeSecurity, type AuditExecutor } from '../analyzers/security.js'
import { generateOptimizations } from '../analyzers/optimizer.js'
import { loadUserConfig } from '../config/loader.js'
import { ConfigError, PackageNotFoundError } from '../errors/index.js'
import type { AnalysisReport } from '../types/analysis.js'
import type { DependencyInventory } from '../types/inventory.js'
import { EXIT_CODES, type ExitCode } from '../utils/exitCode.js'
import { readPackageJson } from '../utils/fs.js'
import { stripAnsi } from '../utils/format.js'
import { logger } from '../utils/logger.js'
import {
  detectPackageManager,
  detectYarnVersion,
  PM_COMMANDS,
  YARN_CLASSIC_COMMANDS,
} from '../utils/packageManager.js'

import { createCacheFromGlobals, renderReport } from './analyze.js'
import { buildBundleFetcher } from './buildBundleFetcher.js'
import { buildHealthFetcher } from './buildHealthFetcher.js'
import { buildLicenseFetcher } from './buildLicenseFetcher.js'

export interface OptimizeOptions {
  /** 输出格式；默认 terminal */
  format?: 'terminal' | 'json' | 'html' | 'markdown'
  /** 输出文件 */
  output?: string
  /** 是否同时分析 devDependencies */
  includeDev?: boolean
  /** 跳过 health 维度（仅基于 size + license + 内置规则） */
  skipHealth?: boolean
  /** 跳过 license 维度（仅基于 size + health + 内置规则） */
  skipLicense?: boolean
  /** 跳过 security 维度（仅基于 size + health + license + 内置规则） */
  skipSecurity?: boolean
  /** 体积分析范围：runtime（默认）/ all / non-runtime */
  scope?: 'runtime' | 'all' | 'non-runtime'
  statsFile?: string
  assetsDir?: string
  /** CLI 全局选项中的缓存开关（--no-cache 时为 false） */
  cacheEnabled?: boolean
  /** CLI 全局选项中的缓存目录 */
  cacheDir?: string
  /** 自定义 npm registry URL */
  registry?: string
  /** 并发请求数；默认 5 */
  concurrency?: number
}

export async function optimizeCommand(
  projectPath: string,
  options: OptimizeOptions = {},
): Promise<ExitCode> {
  const {
    format = 'terminal',
    output,
    includeDev = false,
    skipHealth = false,
    skipLicense = false,
    skipSecurity = false,
    scope = 'runtime',
    statsFile,
    assetsDir,
    cacheEnabled,
    cacheDir,
    registry,
    concurrency,
  } = options

  // ----------- 1. setup -----------
  let config
  try {
    config = await loadUserConfig(projectPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(err.message)
      return EXIT_CODES.ERROR
    }
    throw err
  }

  let pkg
  try {
    pkg = await readPackageJson(projectPath)
  } catch (err) {
    if (err instanceof PackageNotFoundError) {
      logger.error(err.message)
      logger.info('请确认当前目录存在 package.json，或通过参数指定项目路径')
      return EXIT_CODES.ERROR
    }
    throw err
  }

  const pm = detectPackageManager(projectPath)

  // 创建缓存实例
  const cache = createCacheFromGlobals({
    cacheEnabled,
    cacheDir,
    cacheTTL: config.cacheTTL,
  })

  // registry 优先级：CLI --registry > config.registry
  const resolvedRegistry = registry ?? config.registry

  // concurrency 优先级：CLI --concurrency > config.concurrency > 默认 5
  const resolvedConcurrency = concurrency ?? config.concurrency ?? 5

  // ----------- 1.5 构建 DependencyInventory -----------
  const spinner = ora('正在解析依赖清单...').start()
  let inventory: DependencyInventory
  try {
    inventory = await buildInventory(projectPath, pkg, {
      includeDev,
      ignore: config.ignore,
    })
    spinner.succeed(
      `依赖清单解析完成（${inventory.directCount} 直接 + ${inventory.transitiveCount} 传递，来源：${inventory.resolvedFrom}）`,
    )
    for (const w of inventory.warnings) {
      logger.warn(`[inventory] ${w}`)
    }
  } catch (err) {
    spinner.fail('依赖清单解析失败')
    logger.error(err instanceof Error ? err.message : String(err))
    return EXIT_CODES.ERROR
  }

  // ----------- 1.6 源码可达性分析 -----------
  let reachabilityResults: Awaited<ReturnType<typeof analyzeReachability>> = []
  try {
    reachabilityResults = await analyzeReachability(
      projectPath,
      inventory.entries,
      {
        srcGlobs: config.classification?.runtimeEntryGlobs,
      },
    )
    if (reachabilityResults.length > 0) {
      logger.info(`可达性分析：${reachabilityResults.length} 个包被源码引用`)
    }
  } catch (err) {
    logger.warn(
      `可达性分析失败（跳过）：${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // ----------- 1.7 依赖分类 -----------
  const entries = classifyDependencies(inventory.entries, pkg, {
    overrides: config.classification?.overrides,
    reachabilityResults,
  })
  inventory.entries = entries

  // 分类统计
  const classified = {
    runtime: 0,
    build: 0,
    test: 0,
    script: 0,
    config: 0,
    unknown: 0,
  }
  for (const e of entries) {
    if (e.usageClass) classified[e.usageClass]++
  }

  // ----------- 2. 并行跑四个 analyzer -----------
  // 根据 includeDev 选择 audit 命令：prod-only 或全量
  let auditCmd = includeDev ? PM_COMMANDS[pm].auditAll : PM_COMMANDS[pm].audit
  if (pm === 'yarn') {
    const yarnVersion = await detectYarnVersion(projectPath)
    if (yarnVersion === 'classic') {
      auditCmd = includeDev
        ? YARN_CLASSIC_COMMANDS.auditAll
        : YARN_CLASSIC_COMMANDS.audit
    }
  }
  const defaultAuditExecutor: AuditExecutor = {
    async execute(cmd, args, cwd) {
      return execFileP(cmd, args, {
        cwd,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      })
    },
  }

  const analysisSpinner = ora('正在跑全维度分析...').start()
  let bundles, healthList, licenses, securityResult
  try {
    const bundleP = analyzeBundleSize(
      entries,
      buildBundleFetcher({
        dataSource: config.dataSource,
        cache,
        bundlephobiaRecord: config.bundlephobiaRecord,
      }),
      {
        concurrency: resolvedConcurrency,
        scope,
        ignore: config.ignore,
        onProgress: ({ current, total, name }) => {
          analysisSpinner.text = `正在分析体积 [${current}/${total}] ${name}...`
        },
      },
    )
    const healthP = skipHealth
      ? Promise.resolve({ health: [], skipped: [] })
      : analyzeHealth(
          entries,
          buildHealthFetcher({ cache, registry: resolvedRegistry }),
          {
            concurrency: resolvedConcurrency,
            healthWeights: config.healthWeights,
            onProgress: ({ current, total, name }) => {
              analysisSpinner.text = `正在分析健康度 [${current}/${total}] ${name}...`
            },
          },
        )
    const licenseP = skipLicense
      ? Promise.resolve({ licenses: [], projectConflicts: [], skipped: [] })
      : analyzeLicenses(
          entries,
          buildLicenseFetcher({
            cache,
            registry: resolvedRegistry,
            projectPath,
          }),
          {
            concurrency: resolvedConcurrency,
          },
        )
    const securityP = skipSecurity
      ? Promise.resolve({
          security: [],
          skipped: [],
          summary: { critical: 0, high: 0, moderate: 0, low: 0 },
        })
      : analyzeSecurity(auditCmd, pm, projectPath, defaultAuditExecutor, {
          includeDev,
          ignore: config.ignore,
        })

    const [bRes, hRes, lRes, sRes] = await Promise.all([
      bundleP,
      healthP,
      licenseP,
      securityP,
    ])
    analysisSpinner.succeed('分析完成')
    bundles = bRes
    healthList = hRes
    licenses = lRes
    securityResult = sRes
  } catch (err) {
    analysisSpinner.fail('分析失败')
    logger.error(err instanceof Error ? err.message : String(err))
    return EXIT_CODES.ERROR
  }

  // ----------- 2.8 依赖卫生检测 -----------
  const hygieneIssues = detectHygieneIssues(entries, reachabilityResults)
  if (hygieneIssues.length > 0) {
    logger.info(
      `依赖卫生：${hygieneIssues.length} 个问题（${hygieneIssues.filter(i => i.type === 'unused-direct').length} unused，${hygieneIssues.filter(i => i.type === 'misplaced-dependency').length} misplaced）`,
    )
  }

  // ----------- 2.9 多版本检测 -----------
  const duplicateVersions = detectDuplicateVersions(entries)
  if (duplicateVersions.length > 0) {
    logger.info(`多版本检测：${duplicateVersions.length} 个包存在多版本并存`)
  }

  // ----------- 2.95 构建产物分析（可选） -----------
  const effectiveStatsFile = statsFile ?? config.buildArtifacts?.statsFile
  const effectiveAssetsDir = assetsDir ?? config.buildArtifacts?.assetsDir
  let buildArtifactResult:
    | Awaited<ReturnType<typeof analyzeBuildArtifacts>>
    | undefined
  if (effectiveStatsFile || effectiveAssetsDir) {
    try {
      buildArtifactResult = await analyzeBuildArtifacts(projectPath, {
        statsFile: effectiveStatsFile,
        assetsDir: effectiveAssetsDir,
      })
      if (buildArtifactResult.source !== 'none') {
        logger.info(
          `构建产物分析：${buildArtifactResult.source}，${buildArtifactResult.assets.length} 个资源`,
        )
      }
    } catch (err) {
      logger.warn(
        `构建产物分析失败（跳过）：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // ----------- 3. 生成 optimization -----------
  // 构建 usageClassMap
  const usageClassMap = new Map<string, string>()
  for (const e of entries) {
    if (e.usageClass) usageClassMap.set(e.name, e.usageClass)
  }

  const optimizations = generateOptimizations({
    bundles: bundles.bundles,
    health: healthList.health,
    licenses: licenses.licenses,
    security: securityResult.security,
    userReplacements: config.replacements,
    reachabilityResults,
    usageClassMap,
  })

  // ----------- 4. 组装报告 -----------
  const report: AnalysisReport = {
    project: pkg.name,
    timestamp: new Date().toISOString(),
    packageManager: pm,
    inventory,
    dimensions: {
      size: true,
      health: !skipHealth,
      license: !skipLicense,
      security: !skipSecurity,
      optimize: true,
    },
    summary: {
      totalDependencies: bundles.bundles.length,
      totalSize: bundles.totalSize,
      totalGzip: bundles.totalGzip,
      maxDepth: 0,
      vulnerabilities: securityResult.summary,
      licenseIssues: licenses.licenses.filter(l => l.risk !== 'low').length,
      optimizationCount: optimizations.length,
      deprecatedCount: healthList.health.filter(h => h.deprecated).length,
      classified,
    },
    bundles: bundles.bundles,
    health: healthList.health,
    licenses: licenses.licenses,
    security: securityResult.security,
    optimizations,
    hygieneIssues,
    duplicateVersions,
    buildArtifacts: buildArtifactResult,
  }

  // ----------- 5. 输出 -----------
  const rendered = renderReport(report, format)
  if (output) {
    try {
      // terminal 格式写文件时去除 ANSI 转义码，避免乱码
      const content = format === 'terminal' ? stripAnsi(rendered) : rendered
      await writeFile(output, content, 'utf-8')
      logger.success(`报告已写入 ${output}`)
    } catch (err) {
      logger.error(
        `写入失败：${err instanceof Error ? err.message : String(err)}`,
      )
      return EXIT_CODES.ERROR
    }
  } else {
    process.stdout.write(rendered)
  }

  // 简要摘要打到 stderr/log
  if (optimizations.length > 0) {
    const high = optimizations.filter(o => o.priority === 'high').length
    logger.info(
      `共生成 ${optimizations.length} 条建议（high=${high}，medium=${optimizations.filter(o => o.priority === 'medium').length}）`,
    )
  } else {
    logger.success('未发现明显优化空间，依赖结构良好！')
  }

  return EXIT_CODES.OK
}
