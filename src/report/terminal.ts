/**
 * 终端报告生成器
 *
 * 将 AnalysisReport 渲染为人类可读的彩色字符串（含 ANSI 转义码）。
 *
 * 设计原则：
 * - 各 section 独立函数，按需组合
 * - 数据为空的 section 友好提示而非崩溃
 * - 终端宽度固定布局（不读 process.stdout.columns），保证 CI 输出一致
 * - 所有展示数字/日期都走 utils/format，统一风格
 */

import boxen from 'boxen'
import chalk from 'chalk'
import Table from 'cli-table3'

import type {
  AnalysisReport,
  BundleInfo,
  HealthInfo,
  LicenseInfo,
  OptimizationSuggestion,
  SecurityInfo,
} from '../types/analysis.js'
import { formatBytes, formatDate, formatNumber } from '../utils/format.js'

/**
 * 渲染完整报告
 *
 * 返回值是一个完整字符串，调用方决定是 print 还是写文件。
 */
export function renderTerminalReport(report: AnalysisReport): string {
  const sections = [
    renderHeader(report),
    renderSummary(report),
    renderBundleSection(report.bundles),
    renderHealthSection(report.health),
    renderLicenseSection(report.licenses),
    renderSecuritySection(report.security),
    renderOptimizationSection(report.optimizations),
  ]
  return sections.filter(Boolean).join('\n\n') + '\n'
}

// =====================================================================
// Header
// =====================================================================

function renderHeader(report: AnalysisReport): string {
  const title = `${chalk.bold.cyan('dep-radar')} 分析报告`
  const meta = [
    chalk.gray('项目'),
    chalk.white(report.project),
    chalk.gray('·'),
    chalk.gray('时间'),
    chalk.white(formatDate(report.timestamp)),
    chalk.gray('·'),
    chalk.gray('包管理器'),
    chalk.white(report.packageManager),
  ].join(' ')

  return boxen(`${title}\n${meta}`, {
    padding: { top: 0, bottom: 0, left: 2, right: 2 },
    borderColor: 'cyan',
    borderStyle: 'round',
  })
}

// =====================================================================
// Summary
// =====================================================================

function renderSummary(report: AnalysisReport): string {
  const s = report.summary
  const lines = [
    chalk.bold.underline('概览'),
    `  ${chalk.gray('依赖总数：')}${chalk.white(formatNumber(s.totalDependencies))}`,
    `  ${chalk.gray('总体积：')}${chalk.white(formatBytes(s.totalSize))} ${chalk.gray('(minified)')}`,
    `  ${chalk.gray('总体积：')}${chalk.green(formatBytes(s.totalGzip))} ${chalk.gray('(gzip)')}`,
  ]

  if (s.deprecatedCount > 0) {
    lines.push(
      `  ${chalk.red('⚠ 已废弃：')}${chalk.red.bold(s.deprecatedCount)} ${chalk.gray('个')}`,
    )
  }
  if (s.licenseIssues > 0) {
    lines.push(
      `  ${chalk.yellow('⚠ 许可证问题：')}${chalk.yellow.bold(s.licenseIssues)} ${chalk.gray('个')}`,
    )
  }
  const vTotal =
    s.vulnerabilities.critical +
    s.vulnerabilities.high +
    s.vulnerabilities.moderate +
    s.vulnerabilities.low
  if (vTotal > 0) {
    const parts: string[] = []
    if (s.vulnerabilities.critical > 0)
      parts.push(chalk.red.bold(`critical=${s.vulnerabilities.critical}`))
    if (s.vulnerabilities.high > 0)
      parts.push(chalk.red(`high=${s.vulnerabilities.high}`))
    if (s.vulnerabilities.moderate > 0)
      parts.push(chalk.yellow(`moderate=${s.vulnerabilities.moderate}`))
    if (s.vulnerabilities.low > 0)
      parts.push(chalk.gray(`low=${s.vulnerabilities.low}`))
    lines.push(`  ${chalk.gray('安全漏洞：')}${parts.join(' / ')}`)
  }
  if (s.optimizationCount > 0) {
    lines.push(
      `  ${chalk.cyan('💡 优化建议：')}${chalk.cyan.bold(s.optimizationCount)} ${chalk.gray('条')}`,
    )
  }

  return lines.join('\n')
}

// =====================================================================
// Bundle section
// =====================================================================

function renderBundleSection(bundles: BundleInfo[]): string {
  if (bundles.length === 0) {
    return chalk.bold.underline('包体积') + '\n' + chalk.gray('  （无数据）')
  }

  const sorted = [...bundles].sort((a, b) => b.gzip - a.gzip)
  const totalGzip = sorted.reduce((s, b) => s + b.gzip, 0)

  const table = new Table({
    head: ['包名', '版本', 'gzip', '占比', '来源'].map(s => chalk.cyan(s)),
    colWidths: [32, 14, 14, 10, 14],
    style: { head: [], border: [] },
    wordWrap: true,
  })

  for (const b of sorted) {
    const percent =
      totalGzip > 0 ? ((b.gzip / totalGzip) * 100).toFixed(1) + '%' : '—'
    const name = b.error ? chalk.red(b.name) : b.name
    const source = renderSource(b.source)
    const sizeCol = b.error ? chalk.gray('—') : formatBytes(b.gzip)
    table.push([name, b.version || chalk.gray('—'), sizeCol, percent, source])
  }

  return chalk.bold.underline('包体积') + '\n' + table.toString()
}

function renderSource(source: BundleInfo['source']): string {
  switch (source) {
    case 'pkg-size':
      return chalk.green('pkg-size')
    case 'bundlephobia':
      return chalk.yellow('bundlephobia')
    case 'local':
      return chalk.blue('local')
    case 'unknown':
      return chalk.gray('unknown')
  }
}

// =====================================================================
// Health section
// =====================================================================

function renderHealthSection(health: HealthInfo[]): string {
  if (health.length === 0) {
    return (
      chalk.bold.underline('依赖健康度') +
      '\n' +
      chalk.gray('  （该维度待 Phase 2 实现）')
    )
  }

  const table = new Table({
    head: ['包名', '健康度', '周下载', '最近发布', '废弃', '类型支持'].map(s =>
      chalk.cyan(s),
    ),
    colWidths: [26, 10, 14, 14, 8, 10],
    style: { head: [], border: [] },
  })

  for (const h of health) {
    const scoreColor =
      h.healthScore >= 70
        ? chalk.green
        : h.healthScore >= 40
          ? chalk.yellow
          : chalk.red
    table.push([
      h.name,
      scoreColor(`${h.healthScore}`),
      formatNumber(h.weeklyDownloads),
      formatDate(h.lastPublish),
      h.deprecated ? chalk.red('是') : chalk.gray('否'),
      h.hasTypeScriptTypes ? chalk.green('✓') : chalk.gray('—'),
    ])
  }

  return chalk.bold.underline('依赖健康度') + '\n' + table.toString()
}

// =====================================================================
// License section
// =====================================================================

function renderLicenseSection(licenses: LicenseInfo[]): string {
  if (licenses.length === 0) {
    return (
      chalk.bold.underline('许可证合规') +
      '\n' +
      chalk.gray('  （该维度待 Phase 2 实现）')
    )
  }

  const risky = licenses.filter(l => l.risk !== 'low')
  if (risky.length === 0) {
    return (
      chalk.bold.underline('许可证合规') +
      '\n' +
      chalk.green(`  ✓ 全部 ${licenses.length} 个依赖许可证均为低风险`)
    )
  }

  const table = new Table({
    head: ['包名', '许可证', '类型', '风险', '冲突说明'].map(s =>
      chalk.cyan(s),
    ),
    colWidths: [26, 20, 18, 8, 30],
    style: { head: [], border: [] },
    wordWrap: true,
  })

  for (const l of risky) {
    const riskColor =
      l.risk === 'high'
        ? chalk.red
        : l.risk === 'medium'
          ? chalk.yellow
          : chalk.gray
    table.push([
      l.name,
      l.license,
      l.licenseType,
      riskColor(l.risk),
      l.conflict ?? chalk.gray('—'),
    ])
  }

  return chalk.bold.underline('许可证合规') + '\n' + table.toString()
}

// =====================================================================
// Security section
// =====================================================================

function renderSecuritySection(security: SecurityInfo[]): string {
  if (security.length === 0) {
    return (
      chalk.bold.underline('安全审计') +
      '\n' +
      chalk.gray('  （该维度待 Phase 3 实现）')
    )
  }

  const vuln = security.filter(s => s.totalVulnerabilities > 0)
  if (vuln.length === 0) {
    return (
      chalk.bold.underline('安全审计') +
      '\n' +
      chalk.green('  ✓ 未发现已知漏洞')
    )
  }

  const lines: string[] = [chalk.bold.underline('安全审计')]
  for (const s of vuln) {
    const sevColor =
      s.highestSeverity === 'critical'
        ? chalk.red.bold
        : s.highestSeverity === 'high'
          ? chalk.red
          : s.highestSeverity === 'moderate'
            ? chalk.yellow
            : chalk.gray
    lines.push(
      `  ${sevColor('●')} ${chalk.bold(s.name)} ${chalk.gray(`(${s.totalVulnerabilities} 个漏洞，最高 ${s.highestSeverity})`)}`,
    )
    for (const v of s.vulnerabilities.slice(0, 3)) {
      lines.push(
        `    ${chalk.gray('-')} ${v.title} ${chalk.gray(`(${v.severity})`)} ${v.fixAvailable ? chalk.green('[可修复]') : chalk.red('[暂无修复]')}`,
      )
    }
    if (s.vulnerabilities.length > 3) {
      lines.push(
        chalk.gray(`    ...还有 ${s.vulnerabilities.length - 3} 个漏洞`),
      )
    }
  }
  return lines.join('\n')
}

// =====================================================================
// Optimization section
// =====================================================================

function renderOptimizationSection(
  optimizations: OptimizationSuggestion[],
): string {
  if (optimizations.length === 0) {
    return (
      chalk.bold.underline('优化建议') +
      '\n' +
      chalk.gray('  （该维度待 Phase 2 实现）')
    )
  }

  // 按优先级 + 预估节省量降序
  const sorted = [...optimizations].sort((a, b) => {
    const pri = { high: 3, medium: 2, low: 1 }
    const dp = pri[b.priority] - pri[a.priority]
    if (dp !== 0) return dp
    return (b.estimatedSavings ?? 0) - (a.estimatedSavings ?? 0)
  })

  const lines: string[] = [chalk.bold.underline('优化建议')]
  for (const o of sorted) {
    const priIcon =
      o.priority === 'high'
        ? chalk.red('●')
        : o.priority === 'medium'
          ? chalk.yellow('●')
          : chalk.gray('●')
    const head = `  ${priIcon} ${chalk.bold(o.packageName)} ${chalk.gray(`[${o.type}]`)}`
    const savings =
      o.estimatedSavings && o.estimatedSavings > 0
        ? chalk.green(
            `节省 ~${formatBytes(o.estimatedSavings)}` +
              (o.estimatedSavingsPercent
                ? ` (${o.estimatedSavingsPercent}%)`
                : ''),
          )
        : ''
    lines.push(head + (savings ? ` ${savings}` : ''))
    lines.push(`    ${o.description}`)
    if (o.alternative) {
      lines.push(
        `    ${chalk.gray('建议替代：')}${chalk.cyan(o.alternative)} ${chalk.gray(`(难度: ${o.difficulty}${o.breakingChange ? ', 破坏性变更' : ''})`)}`,
      )
    }
    if (o.caveats && o.caveats.length > 0) {
      for (const c of o.caveats) {
        lines.push(`    ${chalk.yellow('⚠')} ${chalk.gray(c)}`)
      }
    }
    if (o.migrationGuide) {
      lines.push(
        `    ${chalk.gray('迁移指南：')}${chalk.underline.gray(o.migrationGuide)}`,
      )
    }
  }
  return lines.join('\n')
}
