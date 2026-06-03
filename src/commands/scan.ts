/**
 * `scan` 命令：日常依赖审查与优化建议
 *
 * 替代 analyze + optimize + report，统一为一个命令。
 *
 * 默认模式：快速扫描直接依赖，只输出可操作建议。
 * --deep 模式：完整 lock 文件扫描，等同原 optimize 行为。
 * --ci 模式：只对高优先级问题返回非零退出码。
 *
 * 退出码：
 *   - 0 OK
 *   - 1 ERROR（IO/网络/配置等致命错误）
 *   - 2 HIGH_VULNERABILITY（critical/high prod 安全漏洞，--ci 模式）
 *   - 3 BUDGET_EXCEEDED（体积超出 budget）
 *   - 4 LICENSE_CONFLICT（高风险许可证冲突）
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
import { hasP0Findings, scoreFindings } from '../analyzers/riskScorer.js'
import type { HygieneIssue } from '../analyzers/dependencyHygiene.js'
import type {
  AnalysisReport,
  OptimizationSuggestion,
} from '../types/analysis.js'
import type { DepRadarConfig } from '../types/config.js'
import type { DependencyInventory } from '../types/inventory.js'
import { EXIT_CODES, type ExitCode } from '../utils/exitCode.js'
import { stripAnsi } from '../utils/format.js'
import { getChangedDependencies } from '../utils/gitDiff.js'
import { logger } from '../utils/logger.js'
import {
  detectYarnVersion,
  PM_COMMANDS,
  YARN_CLASSIC_COMMANDS,
} from '../utils/packageManager.js'

import { buildBundleFetcher } from './buildBundleFetcher.js'
import { buildHealthFetcher } from './buildHealthFetcher.js'
import { buildLicenseFetcher } from './buildLicenseFetcher.js'
import { createCacheFromGlobals, loadSetup, renderReport } from './shared.js'

// =====================================================================
// 公开类型
// =====================================================================

export interface ScanOptions {
  /** 输出格式；默认 terminal */
  format?: 'terminal' | 'json' | 'html' | 'markdown'
  /** 输出文件 */
  output?: string
  /** CI 模式：只对高优先级问题返回非零退出码 */
  ci?: boolean
  /** 深度模式：完整 lock 文件扫描（等同原 optimize 行为） */
  deep?: boolean
  /** 是否同时分析 devDependencies */
  includeDev?: boolean
  /** 跳过 health 维度 */
  skipHealth?: boolean
  /** 跳过 license 维度 */
  skipLicense?: boolean
  /** 跳过 security 维度 */
  skipSecurity?: boolean
  /** 体积分析范围：runtime（默认）/ all / non-runtime */
  scope?: 'runtime' | 'all' | 'non-runtime'
  /** webpack stats.json 文件路径 */
  statsFile?: string
  /** 构建输出目录路径 */
  assetsDir?: string
  /** CLI 全局选项中的缓存开关（--no-cache 时为 false） */
  cacheEnabled?: boolean
  /** CLI 全局选项中的缓存目录 */
  cacheDir?: string
  /** 自定义 npm registry URL */
  registry?: string
  /** 并发请求数；默认 5 */
  concurrency?: number
  /** 增量分析：只分析相对于指定 git ref 变更的依赖 */
  since?: string
}

// =====================================================================
// 内容哈希（用于 scan 级缓存）
// =====================================================================

/**
 * 计算项目依赖内容的哈希值
 *
 * 基于 package.json + lockfile 内容，用于判断是否需要重新扫描。
 */
function createContentHash(projectPath: string): string {
  const hash = createHash('sha256')

  // package.json
  try {
    hash.update(readFileSync(join(projectPath, 'package.json'), 'utf-8'))
  } catch {
    hash.update('no-package-json')
  }

  // lockfile（按优先级尝试）
  for (const lock of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']) {
    const lockPath = join(projectPath, lock)
    if (existsSync(lockPath)) {
      try {
        hash.update(readFileSync(lockPath, 'utf-8'))
      } catch {
        // 读取失败，跳过
      }
      break
    }
  }

  return hash.digest('hex').slice(0, 16)
}

// =====================================================================
// 主入口
// =====================================================================

export async function scanCommand(
  projectPath: string,
  options: ScanOptions = {},
): Promise<ExitCode> {
  const {
    format = 'terminal',
    output,
    ci = false,
    deep = false,
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
    since,
  } = options

  // ============================================================
  // 0. 计时 + scan 级缓存检查
  // ============================================================
  const scanStart = performance.now()

  // scan 级缓存：基于内容哈希（仅非增量模式且缓存显式启用时）
  if (!since && cacheEnabled !== false && cacheEnabled !== undefined) {
    const quickCache = createCacheFromGlobals({
      cacheEnabled,
      cacheDir,
    })!
    const contentHash = createContentHash(projectPath)
    const cacheKey = `scan-result:${contentHash}:${deep ? 'deep' : 'default'}`
    const cached = await quickCache.get<{
      report: AnalysisReport
      exitCode: ExitCode
    }>(cacheKey)
    if (cached) {
      const elapsed = performance.now() - scanStart
      const rendered = renderReport(cached.report, format, {
        showTransitive: deep,
      })
      if (output) {
        const content = format === 'terminal' ? stripAnsi(rendered) : rendered
        await writeFile(output, content, 'utf-8')
        logger.success(`报告已写入 ${output}`)
      } else {
        process.stdout.write(rendered)
      }
      const cacheStats = quickCache.stats
      logger.info(
        `扫描完成（缓存命中，${Math.round(elapsed)}ms，hits=${cacheStats.hits} misses=${cacheStats.misses}）`,
      )
      return cached.exitCode
    }
  }

  // ============================================================
  // 1. Setup
  // ============================================================
  const setup = await loadSetup(projectPath)
  if (setup === null) return EXIT_CODES.ERROR
  const { config, pkg, pm } = setup

  // 用 config 的 cacheTTL 重建 cache
  const cache = createCacheFromGlobals({
    cacheEnabled,
    cacheDir,
    cacheTTL: config.cacheTTL,
  })

  const resolvedRegistry = registry ?? config.registry
  const resolvedConcurrency = concurrency ?? config.concurrency ?? 5

  // ============================================================
  // 2. 构建 DependencyInventory
  // ============================================================
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

  // 增量分析
  let entries = inventory.entries
  if (since) {
    try {
      const changed = await getChangedDependencies(projectPath, since)
      const changedSet = new Set([...changed.added, ...changed.changed])
      if (changedSet.size === 0) {
        logger.info(`自 ${since} 以来无依赖变更`)
        return EXIT_CODES.OK
      }
      logger.info(
        `增量分析：${changed.added.length} 新增, ${changed.changed.length} 变更, ${changed.removed.length} 移除`,
      )
      entries = entries.filter(e => changedSet.has(e.name))
    } catch (err) {
      logger.warn(
        `增量分析失败（回退到全量）：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // ============================================================
  // 2.5 源码可达性分析
  // ============================================================
  let reachabilityResults: Awaited<ReturnType<typeof analyzeReachability>> = []
  try {
    reachabilityResults = await analyzeReachability(projectPath, entries, {
      srcGlobs: config.classification?.runtimeEntryGlobs,
    })
    if (reachabilityResults.length > 0) {
      logger.info(`可达性分析：${reachabilityResults.length} 个包被源码引用`)
    }
  } catch (err) {
    logger.warn(
      `可达性分析失败（跳过）：${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // ============================================================
  // 2.6 依赖分类
  // ============================================================
  entries = classifyDependencies(entries, pkg, {
    overrides: config.classification?.overrides,
    reachabilityResults,
  })
  inventory.entries = entries

  // ============================================================
  // 2.7 并行跑四个 analyzer
  // ============================================================
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
        maxBuffer: 10 * 1024 * 1024,
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
          { concurrency: resolvedConcurrency },
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

  // ============================================================
  // 2.8 依赖卫生 + 多版本检测
  // ============================================================
  const hygieneIssues = detectHygieneIssues(entries, reachabilityResults)
  const duplicateVersions = detectDuplicateVersions(entries)

  // ============================================================
  // 2.9 构建产物分析（可选）
  // ============================================================
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

  // ============================================================
  // 3. 生成 optimization
  // ============================================================
  const usageClassMap = new Map<string, string>()
  for (const e of entries) {
    if (e.usageClass) usageClassMap.set(e.name, e.usageClass)
  }

  const allOptimizations = generateOptimizations({
    bundles: bundles.bundles,
    health: healthList.health,
    licenses: licenses.licenses,
    security: securityResult.security,
    userReplacements: config.replacements,
    reachabilityResults,
    usageClassMap,
    inventoryEntries: inventory.entries,
  })

  // ============================================================
  // 4. 过滤（非 deep 模式只保留 actionable findings）
  // ============================================================
  const optimizations = deep
    ? allOptimizations
    : filterActionable(allOptimizations)

  // 分类统计
  const classified = {
    runtime: 0,
    build: 0,
    test: 0,
    script: 0,
    config: 0,
    'framework-required': 0,
    unknown: 0,
  }
  for (const e of entries) {
    if (e.usageClass) classified[e.usageClass]++
  }

  // ============================================================
  // 5. 组装报告
  // ============================================================
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
    hygieneIssues: deep ? hygieneIssues : filterHighConfidence(hygieneIssues),
    duplicateVersions,
    buildArtifacts: buildArtifactResult,
  }

  // ============================================================
  // 6. 输出
  // ============================================================
  const rendered = renderReport(report, format, { showTransitive: deep })
  if (output) {
    try {
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

  // ============================================================
  // 7. 退出码 + 缓存结果 + 计时输出
  // ============================================================
  const exitCode = ci
    ? decideCiExitCode(report, config)
    : decideExitCode(report, config)

  // 缓存 scan 结果（仅非增量模式且缓存显式启用时）
  if (!since && cache && cacheEnabled !== false && cacheEnabled !== undefined) {
    const contentHash = createContentHash(projectPath)
    const cacheKey = `scan-result:${contentHash}:${deep ? 'deep' : 'default'}`
    await cache.set(cacheKey, { report, exitCode })
  }

  // 计时输出
  const elapsed = Math.round(performance.now() - scanStart)
  const cacheStats = cache?.stats
  const cacheInfo = cacheStats
    ? `，cache: ${cacheStats.hits} hits / ${cacheStats.misses} misses / ${cacheStats.writes} writes`
    : ''
  logger.info(`扫描完成（${elapsed}ms${cacheInfo}）`)

  return exitCode
}

// =====================================================================
// 过滤逻辑
// =====================================================================

/** 只保留 actionable 的优化建议 */
function filterActionable(
  opts: OptimizationSuggestion[],
): OptimizationSuggestion[] {
  return opts.filter(o => {
    // 排除纯信息型建议
    if (o.actionability === 'info') return false
    // 保留 high/medium 优先级
    if (o.priority === 'high' || o.priority === 'medium') return true
    // low 优先级只保留有明确替代方案的
    if (o.priority === 'low' && o.alternative) return true
    return false
  })
}

/** 只保留高置信度的卫生问题 */
function filterHighConfidence(issues: HygieneIssue[]): HygieneIssue[] {
  return issues.filter(i => i.confidence === 'high')
}

// =====================================================================
// 退出码
// =====================================================================

/** 标准退出码逻辑 */
function decideExitCode(
  report: AnalysisReport,
  config: DepRadarConfig,
): ExitCode {
  if (report.security.length > 0) {
    const { critical, high } = report.summary.vulnerabilities
    if (critical > 0 || high > 0) {
      return EXIT_CODES.HIGH_VULNERABILITY
    }
  }

  if (report.licenses.length > 0) {
    const hasHigh = report.licenses.some(l => l.risk === 'high')
    if (hasHigh) {
      return EXIT_CODES.LICENSE_CONFLICT
    }
  }

  if (report.bundles.length > 0) {
    if (config.budget?.totalGzip != null) {
      if (report.summary.totalGzip > config.budget.totalGzip) {
        return EXIT_CODES.BUDGET_EXCEEDED
      }
    }
    if (config.budget?.perPackage) {
      for (const b of report.bundles) {
        const limit = config.budget.perPackage[b.name]
        if (limit != null && b.gzip > limit) {
          return EXIT_CODES.BUDGET_EXCEEDED
        }
      }
    }
  }

  return EXIT_CODES.OK
}

/**
 * CI 模式退出码：只对高优先级问题返回非零
 *
 * 与标准模式的区别：
 * - transitive low/moderate 漏洞不导致失败（只看 direct prod critical/high）
 * - 只看有 fix 路径的问题
 */
function decideCiExitCode(
  report: AnalysisReport,
  config: DepRadarConfig,
): ExitCode {
  // security：只看 direct prod critical/high
  if (report.security.length > 0) {
    const hasCriticalHigh = report.security.some(
      s =>
        s.isDirect !== false &&
        (s.highestSeverity === 'critical' || s.highestSeverity === 'high'),
    )
    if (hasCriticalHigh) {
      logger.error('CI: 检测到 direct 生产依赖的 critical/high 安全漏洞')
      return EXIT_CODES.HIGH_VULNERABILITY
    }
  }

  // license：同标准模式
  if (report.licenses.length > 0) {
    const hasHigh = report.licenses.some(l => l.risk === 'high')
    if (hasHigh) {
      logger.error('CI: 检测到高风险许可证冲突')
      return EXIT_CODES.LICENSE_CONFLICT
    }
  }

  // P0 findings（deprecated 高优先级等）
  const findings = scoreFindings(report)
  if (hasP0Findings(findings)) {
    logger.error('CI: 检测到 P0 级别问题（deprecated 包或 critical 优化建议）')
    return EXIT_CODES.HIGH_VULNERABILITY
  }

  // budget：同标准模式
  if (report.bundles.length > 0) {
    if (config.budget?.totalGzip != null) {
      if (report.summary.totalGzip > config.budget.totalGzip) {
        return EXIT_CODES.BUDGET_EXCEEDED
      }
    }
    if (config.budget?.perPackage) {
      for (const b of report.bundles) {
        const limit = config.budget.perPackage[b.name]
        if (limit != null && b.gzip > limit) {
          return EXIT_CODES.BUDGET_EXCEEDED
        }
      }
    }
  }

  return EXIT_CODES.OK
}
