/**
 * `doctor` 命令：检查项目依赖健康基线
 *
 * 纯本地检查，不发网络请求。
 * 检查：lock 文件一致性、node_modules 状态、项目类型检测等。
 */

import chalk from 'chalk'

import {
  runDoctorChecks,
  type DoctorCheckResult,
} from '../analyzers/doctorChecks.js'
import {
  detectProject,
  type ProjectInfo,
} from '../analyzers/projectDetector.js'
import { PackageNotFoundError } from '../errors/index.js'
import { EXIT_CODES, type ExitCode } from '../utils/exitCode.js'
import { readPackageJson } from '../utils/fs.js'
import { logger } from '../utils/logger.js'
import {
  isSimpleReportFormat,
  listChoices,
  SIMPLE_REPORT_FORMATS,
  type SimpleReportFormat,
} from './options.js'

// =====================================================================
// 公开类型
// =====================================================================

export interface DoctorOptions {
  format?: SimpleReportFormat
}

export interface DoctorResult {
  project: string
  projectInfo: ProjectInfo
  checks: DoctorCheckResult[]
  summary: {
    passed: number
    warned: number
    failed: number
  }
}

// =====================================================================
// 主入口
// =====================================================================

export async function doctorCommand(
  projectPath: string,
  options: DoctorOptions = {},
): Promise<ExitCode> {
  const { format: rawFormat = 'terminal' } = options
  if (!isSimpleReportFormat(rawFormat)) {
    logger.error(
      `不支持的输出格式 "${String(rawFormat)}"，可选值：${listChoices(SIMPLE_REPORT_FORMATS)}`,
    )
    return EXIT_CODES.ERROR
  }
  const format = rawFormat

  // 1. 读 package.json
  let pkg
  try {
    pkg = await readPackageJson(projectPath)
  } catch (err) {
    if (err instanceof PackageNotFoundError) {
      logger.error(err.message)
      logger.info('请确认当前目录存在 package.json')
      return EXIT_CODES.ERROR
    }
    throw err
  }

  // 2. 检测项目类型
  const projectInfo = detectProject(pkg)

  // 3. 运行检查项
  const checks = await runDoctorChecks(projectPath)

  // 4. 汇总
  const summary = {
    passed: checks.filter(c => c.status === 'pass').length,
    warned: checks.filter(c => c.status === 'warn').length,
    failed: checks.filter(c => c.status === 'fail').length,
  }

  const result: DoctorResult = {
    project: pkg.name,
    projectInfo,
    checks,
    summary,
  }

  // 5. 输出
  if (format === 'json') {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } else {
    renderTerminalDoctor(result)
  }

  return summary.failed > 0 ? EXIT_CODES.ERROR : EXIT_CODES.OK
}

// =====================================================================
// 终端渲染
// =====================================================================

function renderTerminalDoctor(result: DoctorResult): void {
  const lines: string[] = []

  lines.push('')
  lines.push(chalk.bold(`🏥 Doctor 检查结果：${result.project}`))
  lines.push('')

  // 项目类型
  if (result.projectInfo.type !== 'unknown') {
    const fw = result.projectInfo.framework
    const ver = result.projectInfo.frameworkVersion
      ? `@${result.projectInfo.frameworkVersion}`
      : ''
    lines.push(`  项目类型: ${fw}${ver}`)
  } else {
    lines.push('  项目类型: 未识别')
  }
  lines.push('')

  // 检查项
  for (const check of result.checks) {
    const icon =
      check.status === 'pass'
        ? chalk.green('[PASS]')
        : check.status === 'warn'
          ? chalk.yellow('[WARN]')
          : chalk.red('[FAIL]')
    lines.push(`  ${icon} ${check.name}: ${check.message}`)
    if (check.detail) {
      lines.push(`         ${chalk.gray(check.detail)}`)
    }
  }

  // 汇总
  lines.push('')
  const parts: string[] = []
  if (result.summary.passed > 0)
    parts.push(chalk.green(`${result.summary.passed} passed`))
  if (result.summary.warned > 0)
    parts.push(chalk.yellow(`${result.summary.warned} warned`))
  if (result.summary.failed > 0)
    parts.push(chalk.red(`${result.summary.failed} failed`))
  lines.push(`  ${parts.join(', ')}`)
  lines.push('')

  process.stdout.write(lines.join('\n') + '\n')
}
