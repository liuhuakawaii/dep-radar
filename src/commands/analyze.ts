/**
 * `analyze` 命令：组装 config → fetcher → analyzer → report → exitCode
 *
 * 当前阶段（Phase 1）只串通包体积分析；health/license/security 维度会随
 * 各 analyzer 的实现（Step 11/12/15）逐步接入此处。
 */

import { writeFile } from 'node:fs/promises'
import ora from 'ora'

import { analyzeBundleSize } from '../analyzers/bundle.js'
import { loadUserConfig } from '../config/loader.js'
import { PackageNotFoundError, ConfigError } from '../errors/index.js'
import { renderJsonReport } from '../report/json.js'
import { renderTerminalReport } from '../report/terminal.js'
import type { AnalysisReport } from '../types/analysis.js'
import type { DepRadarConfig } from '../types/config.js'
import type { PackageJson } from '../types/package.js'
import { EXIT_CODES, type ExitCode } from '../utils/exitCode.js'
import { readPackageJson } from '../utils/fs.js'
import { logger } from '../utils/logger.js'
import { detectPackageManager } from '../utils/packageManager.js'

import { buildBundleFetcher } from './buildBundleFetcher.js'

export interface AnalyzeOptions {
  /** 输出格式：terminal（默认）/ json */
  format?: 'terminal' | 'json'
  /** 输出到文件（不传则打到 stdout） */
  output?: string
  /** topN 体积大户 */
  top?: number
  /** 是否同时分析 devDependencies */
  includeDev?: boolean
  /** （为 Step 11+ 预留）只分析特定维度：size / health / license / security */
  only?: 'size' | 'health' | 'license' | 'security'
}

/**
 * `analyze` 命令的真实入口
 *
 * @returns CLI 退出码
 */
export async function analyzeCommand(
  projectPath: string,
  options: AnalyzeOptions = {},
): Promise<ExitCode> {
  const { format = 'terminal', output, top = 10, includeDev = false } = options

  // ============================================================
  // 1. 加载配置 + 读 package.json + 检测包管理器
  // ============================================================
  let config: DepRadarConfig
  try {
    config = await loadUserConfig(projectPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(err.message)
      return EXIT_CODES.ERROR
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
      return EXIT_CODES.ERROR
    }
    throw err
  }

  const pm = detectPackageManager(projectPath)

  // ============================================================
  // 2. 构建数据源 + 跑 analyzer
  // ============================================================
  const spinner = ora('正在分析依赖体积...').start()

  let bundleResult
  try {
    const fetcher = buildBundleFetcher({ dataSource: config.dataSource })
    bundleResult = await analyzeBundleSize(pkg, fetcher, {
      concurrency: 5,
      topN: top,
      includeDev,
      ignore: config.ignore,
    })
    spinner.succeed('分析完成')
  } catch (err) {
    spinner.fail('分析失败')
    logger.error(err instanceof Error ? err.message : String(err))
    return EXIT_CODES.ERROR
  }

  // ============================================================
  // 3. 组装 AnalysisReport
  //   （其他维度 health/license/security 等待对应 analyzer 实现后接入）
  // ============================================================
  const report: AnalysisReport = {
    project: pkg.name,
    timestamp: new Date().toISOString(),
    packageManager: pm,
    summary: {
      totalDependencies: bundleResult.bundles.length,
      totalSize: bundleResult.totalSize,
      totalGzip: bundleResult.totalGzip,
      maxDepth: 0, // tree 命令实现后接入
      vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 },
      licenseIssues: 0,
      optimizationCount: 0,
      deprecatedCount: 0,
    },
    bundles: bundleResult.bundles,
    health: [],
    licenses: [],
    security: [],
    optimizations: [],
  }

  // 给被跳过的包打 info 提示，避免用户疑惑"为什么少了包"
  if (bundleResult.skipped.length > 0) {
    logger.info(
      `已跳过 ${bundleResult.skipped.length} 个非标依赖：${bundleResult.skipped
        .map(s => `${s.name}(${s.reason})`)
        .join(', ')}`,
    )
  }

  // ============================================================
  // 4. 输出
  // ============================================================
  const rendered =
    format === 'json' ? renderJsonReport(report) : renderTerminalReport(report)

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
  // 5. 退出码判定
  //   当前只检查 budget；fail-on 等待 security analyzer
  // ============================================================
  return decideExitCode(report, config)
}

function decideExitCode(
  report: AnalysisReport,
  config: DepRadarConfig,
): ExitCode {
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
  return EXIT_CODES.OK
}
