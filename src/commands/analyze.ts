/**
 * `analyze` 命令：组装 config → fetcher → analyzer → report → exitCode
 *
 * 按 `--only` 维度分支：
 *   - size（默认）：体积分析（pkg-size / bundlephobia）
 *   - health：依赖健康度（npm registry + downloads + GitHub）
 *   - license / security：占位（待 Step 12/15 实现）
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
import { loadUserConfig } from '../config/loader.js'
import { ConfigError, PackageNotFoundError } from '../errors/index.js'
import { renderHtmlReport } from '../report/html.js'
import { renderJsonReport } from '../report/json.js'
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
import { logger } from '../utils/logger.js'
import { detectPackageManager, PM_COMMANDS } from '../utils/packageManager.js'

import { buildBundleFetcher } from './buildBundleFetcher.js'
import { buildHealthFetcher } from './buildHealthFetcher.js'
import { buildLicenseFetcher } from './buildLicenseFetcher.js'

export type AnalyzeDimension = 'size' | 'health' | 'license' | 'security'

export interface AnalyzeOptions {
  /** 输出格式：terminal（默认）/ json / html */
  format?: 'terminal' | 'json' | 'html'
  /** 输出到文件（不传则打到 stdout） */
  output?: string
  /** topN 体积大户（仅 size 维度有效） */
  top?: number
  /** 是否同时分析 devDependencies */
  includeDev?: boolean
  /** 分析维度；默认 size */
  only?: AnalyzeDimension
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
  } = options

  // ============================================================
  // 1. 加载配置 + 读 package.json + 检测包管理器
  // ============================================================
  const setup = await loadSetup(projectPath)
  if (setup === null) return EXIT_CODES.ERROR
  const { config, pkg, pm } = setup

  // ============================================================
  // 2. 按维度跑分析；组装报告
  // ============================================================
  const baseReport = makeEmptyReport(pkg.name, pm)
  let report: AnalysisReport

  try {
    if (only === 'size') {
      report = await runSize(baseReport, pkg, config, { top, includeDev })
    } else if (only === 'health') {
      report = await runHealth(baseReport, pkg, config, { includeDev })
    } else if (only === 'license') {
      report = await runLicense(baseReport, pkg, config, { includeDev })
    } else if (only === 'security') {
      report = await runSecurity(baseReport, pkg, projectPath, pm, config, {
        includeDev,
      })
    } else {
      logger.warn(`维度 "${only}" 尚未实现，将在后续 Phase 接入`)
      report = baseReport
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
      await writeFile(output, rendered, 'utf-8')
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
  format: 'terminal' | 'json' | 'html',
): string {
  switch (format) {
    case 'json':
      return renderJsonReport(report)
    case 'html':
      return renderHtmlReport(report)
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
}

async function runSize(
  base: AnalysisReport,
  pkg: PackageJson,
  config: DepRadarConfig,
  { top, includeDev }: SizeOptions,
): Promise<AnalysisReport> {
  const spinner = ora('正在分析依赖体积...').start()
  let result
  try {
    const fetcher = buildBundleFetcher({ dataSource: config.dataSource })
    result = await analyzeBundleSize(pkg, fetcher, {
      concurrency: 5,
      topN: top,
      includeDev,
      ignore: config.ignore,
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
}

async function runHealth(
  base: AnalysisReport,
  pkg: PackageJson,
  config: DepRadarConfig,
  { includeDev }: HealthDimOptions,
): Promise<AnalysisReport> {
  const spinner = ora('正在分析依赖健康度...').start()
  let result
  try {
    const fetcher = buildHealthFetcher()
    result = await analyzeHealth(pkg, fetcher, {
      concurrency: 5,
      includeDev,
      ignore: config.ignore,
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
}

async function runLicense(
  base: AnalysisReport,
  pkg: PackageJson,
  config: DepRadarConfig,
  { includeDev }: LicenseDimOptions,
): Promise<AnalysisReport> {
  const spinner = ora('正在分析许可证合规...').start()
  let result
  try {
    const fetcher = buildLicenseFetcher()
    result = await analyzeLicenses(pkg, fetcher, {
      concurrency: 5,
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
  const auditCmd = PM_COMMANDS[pm].audit
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
