/**
 * `optimize` 命令：聚合 bundle + health + license + security 数据并生成可操作建议
 *
 * 流程：
 *   1. 加载配置 + 读 package.json
 *   2. **并行**跑四个 analyzer（避免依赖串行带来的等待）
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

import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

import ora from 'ora'

const execFileP = promisify(execFile)

import { analyzeBundleSize } from '../analyzers/bundle.js'
import { analyzeHealth } from '../analyzers/health.js'
import { analyzeLicenses } from '../analyzers/license.js'
import { analyzeSecurity, type AuditExecutor } from '../analyzers/security.js'
import { generateOptimizations } from '../analyzers/optimizer.js'
import { loadUserConfig } from '../config/loader.js'
import { ConfigError, PackageNotFoundError } from '../errors/index.js'
import type { AnalysisReport } from '../types/analysis.js'
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

  // ----------- 2. 并行跑四个 analyzer -----------
  // yarn classic 使用不同的 audit 命令
  let auditCmd = PM_COMMANDS[pm].audit
  if (pm === 'yarn') {
    const yarnVersion = await detectYarnVersion(projectPath)
    if (yarnVersion === 'classic') auditCmd = YARN_CLASSIC_COMMANDS.audit
  }
  const defaultAuditExecutor: AuditExecutor = {
    async execute(cmd, args, cwd) {
      return execFileP(cmd, args, {
        cwd,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      })
    },
  }

  const spinner = ora('正在跑全维度分析...').start()
  let bundles, healthList, licenses, securityResult
  try {
    const bundleP = analyzeBundleSize(
      pkg,
      buildBundleFetcher({
        dataSource: config.dataSource,
        cache,
        bundlephobiaRecord: config.bundlephobiaRecord,
      }),
      {
        concurrency: resolvedConcurrency,
        includeDev,
        ignore: config.ignore,
        onProgress: ({ current, total, name }) => {
          spinner.text = `正在分析体积 [${current}/${total}] ${name}...`
        },
      },
    )
    const healthP = skipHealth
      ? Promise.resolve({ health: [], skipped: [] })
      : analyzeHealth(
          pkg,
          buildHealthFetcher({ cache, registry: resolvedRegistry }),
          {
            concurrency: resolvedConcurrency,
            includeDev,
            ignore: config.ignore,
            healthWeights: config.healthWeights,
            onProgress: ({ current, total, name }) => {
              spinner.text = `正在分析健康度 [${current}/${total}] ${name}...`
            },
          },
        )
    const licenseP = skipLicense
      ? Promise.resolve({ licenses: [], projectConflicts: [], skipped: [] })
      : analyzeLicenses(
          pkg,
          buildLicenseFetcher({ cache, registry: resolvedRegistry }),
          {
            concurrency: resolvedConcurrency,
            includeDev,
            ignore: config.ignore,
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
    spinner.succeed('分析完成')
    bundles = bRes
    healthList = hRes
    licenses = lRes
    securityResult = sRes
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
    security: securityResult.security,
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
    },
    bundles: bundles.bundles,
    health: healthList.health,
    licenses: licenses.licenses,
    security: securityResult.security,
    optimizations,
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
