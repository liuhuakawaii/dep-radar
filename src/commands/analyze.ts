/**
 * `analyze` 命令：组装 config → fetcher → analyzer → report → exitCode
 *
 * 按 `--only` 维度分支：
 *   - size（默认）：体积分析（pkg-size / bundlephobia）
 *   - health：依赖健康度（npm registry + downloads + GitHub）
 *   - license：许可证合规检查（SPDX 表达式解析 + 风险分级）
 *   - security：安全漏洞审计（npm/pnpm/yarn audit）
 *
 * 退出码规则：
 *   - 0 OK
 *   - 1 ERROR（IO/网络/配置等致命错误）
 *   - 2 BUDGET_EXCEEDED（size 维度的 budget 校验）
 */

import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import ora from 'ora'

const execFileP = promisify(execFile)

import { analyzeBundleSize } from '../analyzers/bundle.js'
import { analyzeHealth } from '../analyzers/health.js'
import { analyzeLicenses } from '../analyzers/license.js'
import { analyzeSecurity, type AuditExecutor } from '../analyzers/security.js'
import { DataCache } from '../data/cache.js'
import { loadUserConfig } from '../config/loader.js'
import { ConfigError, PackageNotFoundError } from '../errors/index.js'
import { renderHtmlReport } from '../report/html.js'
import { renderJsonReport } from '../report/json.js'
import { renderMarkdownReport } from '../report/markdown.js'
import { renderTerminalReport } from '../report/terminal.js'
import type {
  AnalysisReport,
  HealthInfo,
  LicenseInfo,
} from '../types/analysis.js'
import type { DepRadarConfig } from '../types/config.js'
import type { PackageJson } from '../types/package.js'
import { EXIT_CODES, type ExitCode } from '../utils/exitCode.js'
import { readPackageJson } from '../utils/fs.js'
import { formatBytes, stripAnsi } from '../utils/format.js'
import { getChangedDependencies } from '../utils/gitDiff.js'
import { logger } from '../utils/logger.js'
import {
  detectPackageManager,
  detectYarnVersion,
  PM_COMMANDS,
  YARN_CLASSIC_COMMANDS,
} from '../utils/packageManager.js'

import { buildBundleFetcher } from './buildBundleFetcher.js'
import { buildHealthFetcher } from './buildHealthFetcher.js'
import { buildLicenseFetcher } from './buildLicenseFetcher.js'

export type AnalyzeDimension = 'size' | 'health' | 'license' | 'security'

const ALL_DIMENSIONS: AnalyzeDimension[] = [
  'size',
  'health',
  'license',
  'security',
]

/**
 * 解析 --only 参数为维度数组
 *
 * 支持：
 * - 单维度：'size'
 * - 逗号分隔：'size,health'
 * - 'all'：全部维度
 */
export function parseDimensions(only: string): AnalyzeDimension[] {
  if (only === 'all') return [...ALL_DIMENSIONS]
  const parts = only
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const valid: AnalyzeDimension[] = []
  for (const p of parts) {
    if (ALL_DIMENSIONS.includes(p as AnalyzeDimension)) {
      valid.push(p as AnalyzeDimension)
    } else {
      logger.warn(
        `未知维度 "${p}"，已跳过（可选：${ALL_DIMENSIONS.join(', ')}）`,
      )
    }
  }
  return valid.length > 0 ? valid : ['size']
}

export interface AnalyzeOptions {
  /** 输出格式：terminal（默认）/ json / html / markdown */
  format?: 'terminal' | 'json' | 'html' | 'markdown'
  /** 输出到文件（不传则打到 stdout） */
  output?: string
  /** topN 体积大户（仅 size 维度有效） */
  top?: number
  /** 是否同时分析 devDependencies */
  includeDev?: boolean
  /** 分析维度；默认 size；支持逗号分隔多维度（如 "size,health"）或 "all" */
  only?: string
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
  /** verbose 模式：逐包输出结果 */
  verbose?: boolean
}

/**
 * 根据 CLI 全局选项和用户配置创建缓存实例
 *
 * 供 analyze / optimize 等命令复用。
 *
 * @returns DataCache 实例，或 undefined（缓存禁用时）
 */
export function createCacheFromGlobals(options: {
  cacheEnabled?: boolean
  cacheDir?: string
  cacheTTL?: number
}): DataCache | undefined {
  if (options.cacheEnabled === false) return undefined
  return new DataCache({
    cacheDir: options.cacheDir,
    ttl: options.cacheTTL ? options.cacheTTL * 1000 : undefined,
  })
}

/**
 * `analyze` 命令的真实入口
 */
export async function analyzeCommand(
  projectPath: string,
  options: AnalyzeOptions = {},
): Promise<ExitCode> {
  const {
    format = 'terminal',
    output,
    top = 10,
    includeDev = false,
    only = 'size',
    cacheEnabled,
    cacheDir,
    registry,
    concurrency,
    since,
    verbose = false,
  } = options

  // ============================================================
  // 1. 加载配置 + 读 package.json + 检测包管理器
  // ============================================================
  const setup = await loadSetup(projectPath)
  if (setup === null) return EXIT_CODES.ERROR
  const { config, pkg, pm } = setup

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

  // 增量分析：过滤为仅变更的依赖
  let analysisPkg = pkg
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
      // 创建只包含变更依赖的 package.json 副本
      analysisPkg = {
        ...pkg,
        dependencies: filterDeps(pkg.dependencies, changedSet),
        devDependencies: filterDeps(pkg.devDependencies, changedSet),
      }
    } catch (err) {
      logger.warn(
        `增量分析失败（回退到全量）：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // ============================================================
  // 2. 按维度跑分析；组装报告
  // ============================================================
  const baseReport = makeEmptyReport(analysisPkg.name, pm)
  const dimensions = parseDimensions(only)
  let report = baseReport

  try {
    for (const dim of dimensions) {
      if (dim === 'size') {
        report = await runSize(report, analysisPkg, config, {
          top,
          includeDev,
          cache,
          concurrency: resolvedConcurrency,
          verbose,
        })
      } else if (dim === 'health') {
        report = await runHealth(report, analysisPkg, config, {
          includeDev,
          cache,
          registry: resolvedRegistry,
          concurrency: resolvedConcurrency,
        })
      } else if (dim === 'license') {
        report = await runLicense(report, analysisPkg, config, {
          includeDev,
          cache,
          registry: resolvedRegistry,
          concurrency: resolvedConcurrency,
        })
      } else if (dim === 'security') {
        report = await runSecurity(
          report,
          analysisPkg,
          projectPath,
          pm,
          config,
          {
            includeDev,
          },
        )
      } else {
        logger.warn(`维度 "${dim}" 尚未实现，将在后续 Phase 接入`)
      }
    }
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err))
    return EXIT_CODES.ERROR
  }

  // ============================================================
  // 3. 输出
  // ============================================================
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

  // ============================================================
  // 4. 退出码
  // ============================================================
  return decideExitCode(report, config)
}

/** 统一的格式分发；同时被 optimize 命令复用 */
export function renderReport(
  report: AnalysisReport,
  format: 'terminal' | 'json' | 'html' | 'markdown',
): string {
  switch (format) {
    case 'json':
      return renderJsonReport(report)
    case 'html':
      return renderHtmlReport(report)
    case 'markdown':
      return renderMarkdownReport(report)
    case 'terminal':
    default:
      return renderTerminalReport(report)
  }
}

// =====================================================================
// 维度分支
// =====================================================================

interface SizeOptions {
  top: number
  includeDev: boolean
  cache?: DataCache
  concurrency: number
  verbose?: boolean
}

async function runSize(
  base: AnalysisReport,
  pkg: PackageJson,
  config: DepRadarConfig,
  { top, includeDev, cache, concurrency, verbose }: SizeOptions,
): Promise<AnalysisReport> {
  const spinner = ora('正在分析依赖体积...').start()
  let result
  try {
    const fetcher = buildBundleFetcher({
      dataSource: config.dataSource,
      cache,
      bundlephobiaRecord: config.bundlephobiaRecord,
    })
    result = await analyzeBundleSize(pkg, fetcher, {
      concurrency,
      topN: top,
      includeDev,
      ignore: config.ignore,
      onProgress: ({ current, total, name }) => {
        spinner.text = `正在分析体积 [${current}/${total}] ${name}...`
      },
      onResult: verbose
        ? ({ result: r }) => {
            const size = formatBytes(r.size)
            const gzip = formatBytes(r.gzip)
            if (r.error) {
              logger.debug(`  ${r.name} — ${r.error}`)
            } else {
              logger.debug(
                `  ${r.name} ${r.version}  size=${size}  gzip=${gzip}`,
              )
            }
          }
        : undefined,
    })
    spinner.succeed('体积分析完成')
  } catch (err) {
    spinner.fail('体积分析失败')
    throw err
  }

  if (result.skipped.length > 0) {
    logger.info(
      `已跳过 ${result.skipped.length} 个非标依赖：${result.skipped
        .map(s => `${s.name}(${s.reason})`)
        .join(', ')}`,
    )
  }

  return {
    ...base,
    dimensions: { ...base.dimensions, size: true },
    summary: {
      ...base.summary,
      totalDependencies: result.bundles.length,
      totalSize: result.totalSize,
      totalGzip: result.totalGzip,
    },
    bundles: result.bundles,
  }
}

interface HealthDimOptions {
  includeDev: boolean
  cache?: DataCache
  registry?: string
  concurrency: number
}

async function runHealth(
  base: AnalysisReport,
  pkg: PackageJson,
  config: DepRadarConfig,
  { includeDev, cache, registry, concurrency }: HealthDimOptions,
): Promise<AnalysisReport> {
  const spinner = ora('正在分析依赖健康度...').start()
  let result
  try {
    const fetcher = buildHealthFetcher({ cache, registry })
    result = await analyzeHealth(pkg, fetcher, {
      concurrency,
      includeDev,
      ignore: config.ignore,
      healthWeights: config.healthWeights,
      onProgress: ({ current, total, name }) => {
        spinner.text = `正在分析健康度 [${current}/${total}] ${name}...`
      },
    })
    spinner.succeed('健康度分析完成')
  } catch (err) {
    spinner.fail('健康度分析失败')
    throw err
  }

  if (result.skipped.length > 0) {
    logger.info(
      `已跳过 ${result.skipped.length} 个包：${result.skipped
        .map(s => `${s.name}(${s.reason})`)
        .join(', ')}`,
    )
  }

  return {
    ...base,
    dimensions: { ...base.dimensions, health: true },
    summary: {
      ...base.summary,
      totalDependencies: result.health.length,
      deprecatedCount: countDeprecated(result.health),
    },
    health: result.health,
  }
}

function countDeprecated(list: HealthInfo[]): number {
  return list.filter(h => h.deprecated).length
}

// -----------------------------------------------------------------
// license 维度
// -----------------------------------------------------------------

interface LicenseDimOptions {
  includeDev: boolean
  cache?: DataCache
  registry?: string
  concurrency: number
}

async function runLicense(
  base: AnalysisReport,
  pkg: PackageJson,
  config: DepRadarConfig,
  { includeDev, cache, registry, concurrency }: LicenseDimOptions,
): Promise<AnalysisReport> {
  const spinner = ora('正在分析许可证合规...').start()
  let result
  try {
    const fetcher = buildLicenseFetcher({ cache, registry })
    result = await analyzeLicenses(pkg, fetcher, {
      concurrency,
      includeDev,
      ignore: config.ignore,
    })
    spinner.succeed('许可证分析完成')
  } catch (err) {
    spinner.fail('许可证分析失败')
    throw err
  }

  if (result.skipped.length > 0) {
    logger.info(
      `已跳过 ${result.skipped.length} 个包：${result.skipped
        .map(s => `${s.name}(${s.reason})`)
        .join(', ')}`,
    )
  }

  // 项目级冲突规则：用 warn 提示，正式判定退出码在 decideExitCode 中
  for (const c of result.projectConflicts) {
    logger.warn(`[license] ${c.message}`)
  }

  return {
    ...base,
    dimensions: { ...base.dimensions, license: true },
    summary: {
      ...base.summary,
      totalDependencies: result.licenses.length,
      licenseIssues: countLicenseIssues(result.licenses),
    },
    licenses: result.licenses,
  }
}

function countLicenseIssues(list: LicenseInfo[]): number {
  return list.filter(l => l.risk !== 'low').length
}

// -----------------------------------------------------------------
// security 维度
// -----------------------------------------------------------------

interface SecurityDimOptions {
  includeDev: boolean
}

const defaultAuditExecutor: AuditExecutor = {
  async execute(cmd, args, cwd) {
    return execFileP(cmd, args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    })
  },
}

async function runSecurity(
  base: AnalysisReport,
  _pkg: PackageJson,
  projectPath: string,
  pm: ReturnType<typeof detectPackageManager>,
  config: DepRadarConfig,
  { includeDev }: SecurityDimOptions,
): Promise<AnalysisReport> {
  // yarn classic 使用不同的 audit 命令
  let auditCmd = PM_COMMANDS[pm].audit
  if (pm === 'yarn') {
    const yarnVersion = await detectYarnVersion(projectPath)
    if (yarnVersion === 'classic') auditCmd = YARN_CLASSIC_COMMANDS.audit
  }
  const spinner = ora('正在执行安全审计...').start()
  let result
  try {
    result = await analyzeSecurity(
      auditCmd,
      pm,
      projectPath,
      defaultAuditExecutor,
      {
        includeDev,
        ignore: config.ignore,
      },
    )
    spinner.succeed('安全审计完成')
  } catch (err) {
    spinner.fail('安全审计失败')
    throw err
  }

  if (result.skipped.length > 0) {
    logger.warn(`安全审计跳过：${result.skipped.map(s => s.reason).join('; ')}`)
  }

  return {
    ...base,
    dimensions: { ...base.dimensions, security: true },
    summary: {
      ...base.summary,
      vulnerabilities: result.summary,
    },
    security: result.security,
  }
}

// =====================================================================
// setup
// =====================================================================

interface AnalyzeSetup {
  config: DepRadarConfig
  pkg: PackageJson
  pm: ReturnType<typeof detectPackageManager>
}

async function loadSetup(projectPath: string): Promise<AnalyzeSetup | null> {
  let config: DepRadarConfig
  try {
    config = await loadUserConfig(projectPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(err.message)
      return null
    }
    throw err
  }

  let pkg: PackageJson
  try {
    pkg = await readPackageJson(projectPath)
  } catch (err) {
    if (err instanceof PackageNotFoundError) {
      logger.error(err.message)
      logger.info('请确认当前目录存在 package.json，或通过参数指定项目路径')
      return null
    }
    throw err
  }

  return { config, pkg, pm: detectPackageManager(projectPath) }
}

function makeEmptyReport(
  project: string,
  pm: ReturnType<typeof detectPackageManager>,
): AnalysisReport {
  return {
    project,
    timestamp: new Date().toISOString(),
    packageManager: pm,
    dimensions: {
      size: false,
      health: false,
      license: false,
      security: false,
      optimize: false,
    },
    summary: {
      totalDependencies: 0,
      totalSize: 0,
      totalGzip: 0,
      maxDepth: 0,
      vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 },
      licenseIssues: 0,
      optimizationCount: 0,
      deprecatedCount: 0,
    },
    bundles: [],
    health: [],
    licenses: [],
    security: [],
    optimizations: [],
  }
}

// =====================================================================
// 退出码
// =====================================================================

function decideExitCode(
  report: AnalysisReport,
  config: DepRadarConfig,
): ExitCode {
  // 1) security：跑了 security 维度且有 high/critical 漏洞 → HIGH_VULNERABILITY
  if (report.security.length > 0) {
    const { critical, high } = report.summary.vulnerabilities
    if (critical > 0 || high > 0) {
      logger.error(`检测到安全漏洞：${critical} 个 critical，${high} 个 high`)
      return EXIT_CODES.HIGH_VULNERABILITY
    }
  }

  // 2) license：跑了 license 维度且命中 high 风险 → LICENSE_CONFLICT
  if (report.licenses.length > 0) {
    const hasHigh = report.licenses.some(l => l.risk === 'high')
    if (hasHigh) {
      logger.error('检测到高风险许可证冲突')
      return EXIT_CODES.LICENSE_CONFLICT
    }
  }

  // 2) bundle budget：跑了 size 维度时校验
  if (report.bundles.length > 0) {
    if (config.budget?.totalGzip != null) {
      if (report.summary.totalGzip > config.budget.totalGzip) {
        logger.error(
          `体积超出预算：${report.summary.totalGzip} > ${config.budget.totalGzip} bytes`,
        )
        return EXIT_CODES.BUDGET_EXCEEDED
      }
    }
    if (config.budget?.perPackage) {
      for (const b of report.bundles) {
        const limit = config.budget.perPackage[b.name]
        if (limit != null && b.gzip > limit) {
          logger.error(`${b.name} 体积超出单包预算：${b.gzip} > ${limit} bytes`)
          return EXIT_CODES.BUDGET_EXCEEDED
        }
      }
    }
  }

  return EXIT_CODES.OK
}

function filterDeps(
  deps: Record<string, string> | undefined,
  names: Set<string>,
): Record<string, string> | undefined {
  if (!deps) return deps
  const filtered: Record<string, string> = {}
  for (const [name, version] of Object.entries(deps)) {
    if (names.has(name)) filtered[name] = version
  }
  return filtered
}
