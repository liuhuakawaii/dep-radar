/**
 * `optimize` 命令：聚合 bundle + health + license 数据并生成可操作建议
 *
 * 流程：
 *   1. 加载配置 + 读 package.json
 *   2. **并行**跑三个 analyzer（避免依赖串行带来的等待）
 *   3. 把结果喂给 generateOptimizations
 *   4. 把建议填到 AnalysisReport.optimizations 后渲染
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

import { writeFile } from 'node:fs/promises'

import ora from 'ora'

import { analyzeBundleSize } from '../analyzers/bundle.js'
import { analyzeHealth } from '../analyzers/health.js'
import { analyzeLicenses } from '../analyzers/license.js'
import { generateOptimizations } from '../analyzers/optimizer.js'
import { loadUserConfig } from '../config/loader.js'
import { ConfigError, PackageNotFoundError } from '../errors/index.js'
import type { AnalysisReport } from '../types/analysis.js'
import { EXIT_CODES, type ExitCode } from '../utils/exitCode.js'
import { readPackageJson } from '../utils/fs.js'
import { logger } from '../utils/logger.js'
import { detectPackageManager } from '../utils/packageManager.js'

import { renderReport } from './analyze.js'
import { buildBundleFetcher } from './buildBundleFetcher.js'
import { buildHealthFetcher } from './buildHealthFetcher.js'
import { buildLicenseFetcher } from './buildLicenseFetcher.js'

export interface OptimizeOptions {
  /** 输出格式；默认 terminal */
  format?: 'terminal' | 'json' | 'html'
  /** 输出文件 */
  output?: string
  /** 是否同时分析 devDependencies */
  includeDev?: boolean
  /** 跳过 health 维度（仅基于 size + license + 内置规则） */
  skipHealth?: boolean
  /** 跳过 license 维度（仅基于 size + health + 内置规则） */
  skipLicense?: boolean
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

  // ----------- 2. 并行跑三个 analyzer -----------
  const spinner = ora('正在跑全维度分析...').start()
  let bundles, healthList, licenses
  try {
    const bundleP = analyzeBundleSize(
      pkg,
      buildBundleFetcher({ dataSource: config.dataSource }),
      { concurrency: 5, includeDev, ignore: config.ignore },
    )
    const healthP = skipHealth
      ? Promise.resolve({ health: [], skipped: [] })
      : analyzeHealth(pkg, buildHealthFetcher(), {
          concurrency: 5,
          includeDev,
          ignore: config.ignore,
        })
    const licenseP = skipLicense
      ? Promise.resolve({ licenses: [], projectConflicts: [], skipped: [] })
      : analyzeLicenses(pkg, buildLicenseFetcher(), {
          concurrency: 5,
          includeDev,
          ignore: config.ignore,
        })

    const [bRes, hRes, lRes] = await Promise.all([bundleP, healthP, licenseP])
    spinner.succeed('分析完成')
    bundles = bRes
    healthList = hRes
    licenses = lRes
  } catch (err) {
    spinner.fail('分析失败')
    logger.error(err instanceof Error ? err.message : String(err))
    return EXIT_CODES.ERROR
  }

  // ----------- 3. 生成 optimization -----------
  const optimizations = generateOptimizations({
    bundles: bundles.bundles,
    health: healthList.health,
    licenses: licenses.licenses,
    security: [], // Phase 3 接入
    userReplacements: config.replacements,
  })

  // ----------- 4. 组装报告 -----------
  const report: AnalysisReport = {
    project: pkg.name,
    timestamp: new Date().toISOString(),
    packageManager: pm,
    dimensions: {
      size: true,
      health: !skipHealth,
      license: !skipLicense,
      security: false,
      optimize: true,
    },
    summary: {
      totalDependencies: bundles.bundles.length,
      totalSize: bundles.totalSize,
      totalGzip: bundles.totalGzip,
      maxDepth: 0,
      vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 },
      licenseIssues: licenses.licenses.filter(l => l.risk !== 'low').length,
      optimizationCount: optimizations.length,
      deprecatedCount: healthList.health.filter(h => h.deprecated).length,
    },
    bundles: bundles.bundles,
    health: healthList.health,
    licenses: licenses.licenses,
    security: [],
    optimizations,
  }

  // ----------- 5. 输出 -----------
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
