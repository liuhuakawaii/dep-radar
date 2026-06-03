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

import {
  generateCommands,
  generateExplainHint,
} from '../analyzers/suggestionCommands.js'
import type {
  AnalysisReport,
  BundleInfo,
  HealthInfo,
  LicenseInfo,
  OptimizationSuggestion,
  SecurityInfo,
} from '../types/analysis.js'
import type { PackageManager } from '../types/package.js'
import {
  formatBytes,
  formatDate,
  formatNumber,
  formatRelativeTime,
} from '../utils/format.js'

export interface TerminalReportOptions {
  /** 显示完整输出（不过滤条目数） */
  verbose?: boolean
  /** 每个 section 默认最多显示的条目数；默认 10 */
  maxItems?: number
  /**
   * 是否在 bundle / health / license / security 表中显示子依赖。
   *
   * 默认 false：只显示直接依赖。子依赖的问题已在「优化建议」中归并到对应直接依赖。
   * 设为 true（对应 `--deep` 模式）时把所有 transitive 也列出来。
   */
  showTransitive?: boolean
}

/**
 * 渲染完整报告
 *
 * 返回值是一个完整字符串，调用方决定是 print 还是写文件。
 */
export function renderTerminalReport(
  report: AnalysisReport,
  options: TerminalReportOptions = {},
): string {
  const { verbose = false, maxItems = 10, showTransitive = false } = options

  const sections = [
    renderHeader(report),
    renderSummary(report),
    report.dimensions.optimize ? renderRecommendedActions(report) : '',
    report.dimensions.size
      ? renderBundleSection(report.bundles, verbose, maxItems, showTransitive)
      : '',
    report.dimensions.health
      ? renderHealthSection(report.health, verbose, maxItems, showTransitive)
      : '',
    report.dimensions.license
      ? renderLicenseSection(report.licenses, verbose, maxItems, showTransitive)
      : '',
    report.dimensions.security
      ? renderSecuritySection(
          report.security,
          verbose,
          maxItems,
          showTransitive,
        )
      : '',
    report.dimensions.optimize
      ? renderOptimizationSection(
          report.optimizations,
          verbose,
          maxItems,
          report.packageManager,
        )
      : '',
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
// Recommended actions
// =====================================================================

function renderRecommendedActions(report: AnalysisReport): string {
  const pm = report.packageManager
  const actions: string[] = []

  // 从优化建议中提取 top 3 高优先级项（优化建议已是直接依赖维度）
  const topOpts = [...report.optimizations]
    .sort((a, b) => {
      const pri = { high: 3, medium: 2, low: 1 }
      return (pri[b.priority] ?? 0) - (pri[a.priority] ?? 0)
    })
    .slice(0, 3)

  for (const o of topOpts) {
    const cmd = generateCommands(o, pm)
    if (cmd) {
      actions.push(
        `  ${chalk.cyan('▶')} ${cmd.description}: ${chalk.cyan(cmd.command)}`,
      )
    }
  }

  // 从安全漏洞中提取「直接依赖」可修复项；子依赖漏洞应升级父直接依赖，不在此处单列
  const fixable = report.security
    .filter(
      s =>
        s.isDirect !== false &&
        s.totalVulnerabilities > 0 &&
        s.vulnerabilities.some(v => v.fixAvailable),
    )
    .slice(0, 2)
  for (const s of fixable) {
    const fixCmd =
      pm === 'pnpm'
        ? 'pnpm audit fix'
        : pm === 'yarn'
          ? 'yarn npm audit fix'
          : 'npm audit fix'
    actions.push(
      `  ${chalk.cyan('▶')} 修复 ${s.name} 漏洞: ${chalk.cyan(fixCmd)}`,
    )
  }

  if (actions.length === 0) return ''

  return [
    chalk.bold.underline('推荐操作'),
    ...actions,
    chalk.gray('  使用 dep-radar explain <包名> 查看单个依赖详情'),
  ].join('\n')
}

// =====================================================================
// Bundle section
// =====================================================================

function renderBundleSection(
  bundles: BundleInfo[],
  verbose: boolean,
  maxItems: number,
  showTransitive: boolean,
): string {
  if (bundles.length === 0) {
    return chalk.bold.underline('包体积') + '\n' + chalk.gray('  （无数据）')
  }

  // 默认只展示直接依赖；子依赖的体积无法由项目直接干预
  const filtered = showTransitive ? bundles : bundles.filter(b => b.isDirect)
  const transitiveHidden = bundles.length - filtered.length

  if (filtered.length === 0) {
    return (
      chalk.bold.underline('包体积') +
      '\n' +
      chalk.gray(
        `  （无直接依赖体积数据；隐藏了 ${transitiveHidden} 个子依赖，--deep 查看全部）`,
      )
    )
  }

  const sorted = [...filtered].sort((a, b) => b.gzip - a.gzip)
  const shown = verbose ? sorted : sorted.slice(0, maxItems)
  const hidden = sorted.length - shown.length
  const totalGzip = sorted.reduce((s, b) => s + b.gzip, 0)

  const table = new Table({
    head: ['包名', '版本', 'gzip', '占比', '来源'].map(s => chalk.cyan(s)),
    colWidths: [32, 14, 14, 10, 14],
    style: { head: [], border: [] },
    wordWrap: true,
  })

  for (const b of shown) {
    const percent =
      totalGzip > 0 ? ((b.gzip / totalGzip) * 100).toFixed(1) + '%' : '—'
    const name = b.error ? chalk.red(b.name) : b.name
    const source = renderSource(b.source)
    const sizeCol = b.error ? chalk.gray('—') : formatBytes(b.gzip)
    table.push([name, b.version || chalk.gray('—'), sizeCol, percent, source])
  }

  const hiddenMsg =
    hidden > 0
      ? chalk.gray(`\n  ... 还有 ${hidden} 个包未显示（--verbose 查看全部）`)
      : ''
  const transitiveMsg =
    transitiveHidden > 0
      ? chalk.gray(
          `\n  （隐藏了 ${transitiveHidden} 个子依赖；--deep 查看全部）`,
        )
      : ''
  return (
    chalk.bold.underline('包体积') +
    '\n' +
    table.toString() +
    hiddenMsg +
    transitiveMsg
  )
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

function renderHealthSection(
  health: HealthInfo[],
  verbose: boolean,
  maxItems: number,
  showTransitive: boolean,
): string {
  if (health.length === 0) {
    return (
      chalk.bold.underline('依赖健康度') + '\n' + chalk.gray('  （无数据）')
    )
  }

  const filtered = showTransitive ? health : health.filter(h => h.isDirect)
  const transitiveHidden = health.length - filtered.length

  if (filtered.length === 0) {
    return (
      chalk.bold.underline('依赖健康度') +
      '\n' +
      chalk.gray(
        `  （无直接依赖健康度数据；隐藏了 ${transitiveHidden} 个子依赖，--deep 查看全部）`,
      )
    )
  }

  const sorted = [...filtered].sort((a, b) => a.healthScore - b.healthScore)
  const shown = verbose ? sorted : sorted.slice(0, maxItems)
  const hidden = sorted.length - shown.length

  const table = new Table({
    head: ['包名', '健康度', '周下载', '最近发布', '废弃', '类型支持'].map(s =>
      chalk.cyan(s),
    ),
    colWidths: [26, 10, 14, 14, 8, 10],
    style: { head: [], border: [] },
  })

  for (const h of shown) {
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
      formatRelativeTime(h.lastPublish),
      h.deprecated ? chalk.red('是') : chalk.gray('否'),
      h.hasTypeScriptTypes ? chalk.green('✓') : chalk.gray('—'),
    ])
  }

  const hiddenMsg =
    hidden > 0
      ? chalk.gray(`\n  ... 还有 ${hidden} 个包未显示（--verbose 查看全部）`)
      : ''
  const transitiveMsg =
    transitiveHidden > 0
      ? chalk.gray(
          `\n  （隐藏了 ${transitiveHidden} 个子依赖；--deep 查看全部）`,
        )
      : ''
  return (
    chalk.bold.underline('依赖健康度') +
    '\n' +
    table.toString() +
    hiddenMsg +
    transitiveMsg
  )
}

// =====================================================================
// License section
// =====================================================================

function renderLicenseSection(
  licenses: LicenseInfo[],
  verbose: boolean,
  maxItems: number,
  showTransitive: boolean,
): string {
  if (licenses.length === 0) {
    return (
      chalk.bold.underline('许可证合规') + '\n' + chalk.gray('  （无数据）')
    )
  }

  const scope = showTransitive ? licenses : licenses.filter(l => l.isDirect)
  const transitiveHidden = licenses.length - scope.length
  const risky = scope.filter(l => l.risk !== 'low')
  if (risky.length === 0) {
    const total = scope.length
    const note =
      transitiveHidden > 0
        ? chalk.gray(
            `（${transitiveHidden} 个子依赖未纳入展示；--deep 查看全部）`,
          )
        : ''
    return (
      chalk.bold.underline('许可证合规') +
      '\n' +
      chalk.green(`  ✓ 全部 ${total} 个直接依赖许可证均为低风险 `) +
      note
    )
  }

  const shown = verbose ? risky : risky.slice(0, maxItems)
  const hidden = risky.length - shown.length

  const table = new Table({
    head: ['包名', '版本', '许可证', '类型', '风险', '来源', '冲突说明'].map(
      s => chalk.cyan(s),
    ),
    colWidths: [20, 10, 16, 14, 8, 18, 24],
    style: { head: [], border: [] },
    wordWrap: true,
  })

  for (const l of shown) {
    const riskColor =
      l.risk === 'high'
        ? chalk.red
        : l.risk === 'medium'
          ? chalk.yellow
          : chalk.gray
    const humanReview = l.needsHumanReview ? chalk.yellow(' [需人工审核]') : ''
    table.push([
      l.name + humanReview,
      l.version ?? chalk.gray('—'),
      l.license,
      l.licenseType,
      riskColor(l.risk),
      l.source ?? chalk.gray('—'),
      l.conflict ?? chalk.gray('—'),
    ])
  }

  const hiddenMsg =
    hidden > 0
      ? chalk.gray(
          `\n  ... 还有 ${hidden} 个许可证问题未显示（--verbose 查看全部）`,
        )
      : ''
  const transitiveMsg =
    transitiveHidden > 0
      ? chalk.gray(
          `\n  （隐藏了 ${transitiveHidden} 个子依赖；--deep 查看全部）`,
        )
      : ''
  return (
    chalk.bold.underline('许可证合规') +
    '\n' +
    table.toString() +
    hiddenMsg +
    transitiveMsg
  )
}

// =====================================================================
// Security section
// =====================================================================

function renderSecuritySection(
  security: SecurityInfo[],
  verbose: boolean,
  maxItems: number,
  showTransitive: boolean,
): string {
  if (security.length === 0) {
    return (
      chalk.bold.underline('安全审计') +
      '\n' +
      chalk.green('  ✓ 未发现已知漏洞')
    )
  }

  const allVuln = security.filter(s => s.totalVulnerabilities > 0)
  const directVuln = allVuln.filter(s => s.isDirect !== false)
  const vuln = showTransitive ? allVuln : directVuln
  const transitiveHidden = allVuln.length - vuln.length

  if (allVuln.length === 0) {
    return (
      chalk.bold.underline('安全审计') +
      '\n' +
      chalk.green('  ✓ 未发现已知漏洞')
    )
  }

  if (vuln.length === 0) {
    return (
      chalk.bold.underline('安全审计') +
      '\n' +
      chalk.green('  ✓ 未发现直接依赖的漏洞 ') +
      chalk.gray(
        `（${transitiveHidden} 个子依赖漏洞已归并到优化建议；--deep 查看全部）`,
      )
    )
  }

  const shown = verbose ? vuln : vuln.slice(0, maxItems)
  const hidden = vuln.length - shown.length

  const lines: string[] = [chalk.bold.underline('安全审计')]
  for (const s of shown) {
    const sevColor =
      s.highestSeverity === 'critical'
        ? chalk.red.bold
        : s.highestSeverity === 'high'
          ? chalk.red
          : s.highestSeverity === 'moderate'
            ? chalk.yellow
            : chalk.gray
    const scopeLabel = s.scope ? chalk.gray(` [${s.scope}]`) : ''
    const directLabel = s.isDirect
      ? chalk.cyan(' [direct]')
      : chalk.gray(' [transitive]')
    lines.push(
      `  ${sevColor('●')} ${chalk.bold(s.name)}${directLabel}${scopeLabel} ${chalk.gray(`(${s.totalVulnerabilities} 个漏洞，最高 ${s.highestSeverity})`)}`,
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
  if (hidden > 0) {
    lines.push(
      chalk.gray(`  ... 还有 ${hidden} 个漏洞未显示（--verbose 查看全部）`),
    )
  }
  if (transitiveHidden > 0) {
    lines.push(
      chalk.gray(
        `  （隐藏了 ${transitiveHidden} 个子依赖漏洞，已归并到优化建议；--deep 查看全部）`,
      ),
    )
  }
  return lines.join('\n')
}

// =====================================================================
// Optimization section
// =====================================================================

function renderOptimizationSection(
  optimizations: OptimizationSuggestion[],
  verbose: boolean,
  maxItems: number,
  pm?: PackageManager,
): string {
  if (optimizations.length === 0) {
    return (
      chalk.bold.underline('优化建议') +
      '\n' +
      chalk.green('  ✓ 未发现明显优化空间')
    )
  }

  // 按优先级 + 预估节省量降序
  const sorted = [...optimizations].sort((a, b) => {
    const pri = { high: 3, medium: 2, low: 1 }
    const dp = pri[b.priority] - pri[a.priority]
    if (dp !== 0) return dp
    return (b.estimatedSavings ?? 0) - (a.estimatedSavings ?? 0)
  })

  const shown = verbose ? sorted : sorted.slice(0, maxItems)
  const hidden = sorted.length - shown.length

  const lines: string[] = [chalk.bold.underline('优化建议')]
  for (const o of shown) {
    const priIcon =
      o.priority === 'high'
        ? chalk.red('●')
        : o.priority === 'medium'
          ? chalk.yellow('●')
          : chalk.gray('●')
    const confBadge = o.confidence ? chalk.gray(`[${o.confidence}]`) : ''
    const actBadge = o.actionability ? chalk.gray(`[${o.actionability}]`) : ''
    const head = `  ${priIcon} ${chalk.bold(o.packageName)} ${chalk.gray(`[${o.type}]`)} ${confBadge} ${actBadge}`
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
    // 证据
    if (o.evidence && o.evidence.length > 0) {
      for (const ev of o.evidence) {
        const loc = ev.file
          ? ` (${ev.file}${ev.line ? `:${ev.line}` : ''})`
          : ''
        lines.push(
          `    ${chalk.gray('📎')} ${chalk.gray(ev.source)}${chalk.gray(loc)}: ${chalk.gray(ev.detail)}`,
        )
      }
    }
    // 前提条件
    if (o.preconditions && o.preconditions.length > 0) {
      for (const p of o.preconditions) {
        lines.push(`    ${chalk.yellow('⚠ 前提：')}${chalk.gray(p)}`)
      }
    }
    // 假设
    if (o.assumptions && o.assumptions.length > 0) {
      for (const a of o.assumptions) {
        lines.push(`    ${chalk.gray('ℹ 假设：')}${chalk.gray(a)}`)
      }
    }
    if (o.caveats && o.caveats.length > 0) {
      for (const c of o.caveats) {
        lines.push(`    ${chalk.yellow('⚠')} ${chalk.gray(c)}`)
      }
    }
    // 建议步骤
    if (o.suggestedSteps && o.suggestedSteps.length > 0) {
      lines.push(`    ${chalk.gray('操作步骤：')}`)
      o.suggestedSteps.forEach((step, i) => {
        lines.push(`      ${chalk.gray(`${i + 1}.`)} ${step}`)
      })
    }
    if (o.migrationGuide) {
      lines.push(
        `    ${chalk.gray('迁移指南：')}${chalk.underline.gray(o.migrationGuide)}`,
      )
    }
    // PM 命令
    if (pm) {
      const cmd = generateCommands(o, pm)
      if (cmd) {
        lines.push(`    ${chalk.cyan('▶')} ${chalk.cyan(cmd.command)}`)
      }
    }
    // 低置信度时提示 explain
    if (o.confidence === 'low' || o.actionability === 'needs-review') {
      lines.push(
        `    ${chalk.gray('💡')} ${chalk.gray(generateExplainHint(o.packageName))}`,
      )
    }
  }
  if (hidden > 0) {
    lines.push(
      chalk.gray(`  ... 还有 ${hidden} 条建议未显示（--verbose 查看全部）`),
    )
  }
  return lines.join('\n')
}
