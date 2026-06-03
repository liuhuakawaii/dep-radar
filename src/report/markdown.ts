/**
 * Markdown 报告生成器
 *
 * 将 AnalysisReport 渲染为标准 Markdown，适合嵌入 GitHub PR description 或 README。
 * 使用标准 markdown 表格语法，不依赖 HTML 标签。
 */

import type {
  AnalysisReport,
  BundleInfo,
  HealthInfo,
  LicenseInfo,
  OptimizationSuggestion,
  SecurityInfo,
} from '../types/analysis.js'
import {
  formatBytes,
  formatDate,
  formatNumber,
  formatRelativeTime,
} from '../utils/format.js'

export interface MarkdownReportOptions {
  /** 是否展示子依赖（默认 false，--deep 时为 true） */
  showTransitive?: boolean
}

export function renderMarkdownReport(
  report: AnalysisReport,
  options: MarkdownReportOptions = {},
): string {
  const showTransitive = options.showTransitive ?? false
  const sections = [
    renderHeader(report),
    renderSummary(report),
    report.dimensions.size
      ? renderBundleSection(report.bundles, showTransitive)
      : '',
    report.dimensions.health
      ? renderHealthSection(report.health, showTransitive)
      : '',
    report.dimensions.license
      ? renderLicenseSection(report.licenses, showTransitive)
      : '',
    report.dimensions.security
      ? renderSecuritySection(report.security, showTransitive)
      : '',
    report.dimensions.optimize
      ? renderOptimizationSection(report.optimizations)
      : '',
  ]
  return sections.filter(Boolean).join('\n\n') + '\n'
}

function renderHeader(report: AnalysisReport): string {
  return [
    `# dep-radar 分析报告`,
    '',
    `| 项目 | 时间 | 包管理器 |`,
    `|------|------|----------|`,
    `| ${report.project} | ${formatDate(report.timestamp)} | ${report.packageManager} |`,
  ].join('\n')
}

function renderSummary(report: AnalysisReport): string {
  const s = report.summary
  const lines = ['## 概览', '']
  lines.push(`- 依赖总数：**${formatNumber(s.totalDependencies)}**`)
  lines.push(
    `- 总体积：**${formatBytes(s.totalSize)}** (minified) / **${formatBytes(s.totalGzip)}** (gzip)`,
  )

  if (s.deprecatedCount > 0) {
    lines.push(`- 已废弃：**${s.deprecatedCount}** 个`)
  }
  if (s.licenseIssues > 0) {
    lines.push(`- 许可证问题：**${s.licenseIssues}** 个`)
  }

  const vTotal =
    s.vulnerabilities.critical +
    s.vulnerabilities.high +
    s.vulnerabilities.moderate +
    s.vulnerabilities.low
  if (vTotal > 0) {
    const parts: string[] = []
    if (s.vulnerabilities.critical > 0)
      parts.push(`critical=${s.vulnerabilities.critical}`)
    if (s.vulnerabilities.high > 0) parts.push(`high=${s.vulnerabilities.high}`)
    if (s.vulnerabilities.moderate > 0)
      parts.push(`moderate=${s.vulnerabilities.moderate}`)
    if (s.vulnerabilities.low > 0) parts.push(`low=${s.vulnerabilities.low}`)
    lines.push(`- 安全漏洞：${parts.join(' / ')}`)
  }

  return lines.join('\n')
}

function renderBundleSection(
  bundles: BundleInfo[],
  showTransitive: boolean,
): string {
  if (bundles.length === 0) return ''

  const scoped = showTransitive ? bundles : bundles.filter(b => b.isDirect)
  const transitiveHidden = bundles.length - scoped.length
  if (scoped.length === 0) {
    return [
      '## 包体积',
      '',
      `_无直接依赖体积数据（隐藏了 ${transitiveHidden} 个子依赖，--deep 查看全部）_`,
    ].join('\n')
  }

  const sorted = [...scoped].sort((a, b) => b.gzip - a.gzip)
  const totalGzip = sorted.reduce((s, b) => s + b.gzip, 0)

  const lines = [
    '## 包体积',
    '',
    '| 包名 | 版本 | gzip | 占比 | 来源 |',
    '|------|------|------|------|------|',
  ]

  for (const b of sorted) {
    const percent =
      totalGzip > 0 ? ((b.gzip / totalGzip) * 100).toFixed(1) + '%' : '—'
    const size = b.error ? '—' : formatBytes(b.gzip)
    const name = b.error ? `~~${b.name}~~` : b.name
    lines.push(
      `| ${name} | ${b.version || '—'} | ${size} | ${percent} | ${b.source} |`,
    )
  }

  if (transitiveHidden > 0) {
    lines.push('')
    lines.push(`_隐藏了 ${transitiveHidden} 个子依赖；--deep 查看全部_`)
  }
  return lines.join('\n')
}

function renderHealthSection(
  health: HealthInfo[],
  showTransitive: boolean,
): string {
  if (health.length === 0) return ''

  const scoped = showTransitive ? health : health.filter(h => h.isDirect)
  const transitiveHidden = health.length - scoped.length
  if (scoped.length === 0) {
    return [
      '## 健康度',
      '',
      `_无直接依赖健康度数据（隐藏了 ${transitiveHidden} 个子依赖，--deep 查看全部）_`,
    ].join('\n')
  }

  const sorted = [...scoped].sort((a, b) => b.healthScore - a.healthScore)

  const lines = [
    '## 健康度',
    '',
    '| 包名 | 分数 | 周下载 | 最近发布 | 趋势 | TS | 废弃 |',
    '|------|------|--------|----------|------|----|------|',
  ]

  for (const h of sorted) {
    const score = h.deprecated ? '0' : String(h.healthScore)
    const downloads = formatNumber(h.weeklyDownloads)
    const lastPublish = h.lastPublish ? formatRelativeTime(h.lastPublish) : '—'
    const trend =
      h.downloadTrend === 'up' ? '↑' : h.downloadTrend === 'down' ? '↓' : '—'
    const ts = h.hasTypeScriptTypes ? 'Y' : '—'
    const deprecated = h.deprecated ? 'Y' : '—'
    lines.push(
      `| ${h.name} | ${score} | ${downloads} | ${lastPublish} | ${trend} | ${ts} | ${deprecated} |`,
    )
  }

  if (transitiveHidden > 0) {
    lines.push('')
    lines.push(`_隐藏了 ${transitiveHidden} 个子依赖；--deep 查看全部_`)
  }
  return lines.join('\n')
}

function renderLicenseSection(
  licenses: LicenseInfo[],
  showTransitive: boolean,
): string {
  if (licenses.length === 0) return ''

  const scoped = showTransitive ? licenses : licenses.filter(l => l.isDirect)
  const transitiveHidden = licenses.length - scoped.length
  // 只显示非 low 风险的包
  const issues = scoped.filter(l => l.risk !== 'low')
  if (issues.length === 0) {
    if (transitiveHidden > 0) {
      return [
        '## 许可证风险',
        '',
        `_直接依赖许可证全部为低风险；隐藏了 ${transitiveHidden} 个子依赖，--deep 查看全部_`,
      ].join('\n')
    }
    return ''
  }

  const lines = [
    '## 许可证风险',
    '',
    '| 包名 | 版本 | 许可证 | 风险 | 来源 | 说明 |',
    '|------|------|--------|------|------|------|',
  ]

  for (const l of issues) {
    const risk = l.risk === 'high' ? '**high**' : l.risk
    const review = l.needsHumanReview ? ' ⚠需审核' : ''
    lines.push(
      `| ${l.name}${review} | ${l.version ?? '—'} | ${l.license} | ${risk} | ${l.source ?? '—'} | ${l.conflict || '—'} |`,
    )
  }

  if (transitiveHidden > 0) {
    lines.push('')
    lines.push(`_隐藏了 ${transitiveHidden} 个子依赖；--deep 查看全部_`)
  }
  return lines.join('\n')
}

function renderSecuritySection(
  security: SecurityInfo[],
  showTransitive: boolean,
): string {
  if (security.length === 0) return ''

  const allVulns = security.filter(s => s.totalVulnerabilities > 0)
  const directVulns = allVulns.filter(s => s.isDirect !== false)
  const withVulns = showTransitive ? allVulns : directVulns
  const transitiveHidden = allVulns.length - withVulns.length
  if (withVulns.length === 0) {
    if (transitiveHidden > 0) {
      return [
        '## 安全漏洞',
        '',
        `_未发现直接依赖漏洞；隐藏了 ${transitiveHidden} 个子依赖漏洞（已归并到优化建议），--deep 查看全部_`,
      ].join('\n')
    }
    return ''
  }

  const lines = [
    '## 安全漏洞',
    '',
    '| 包名 | 类型 | 范围 | 漏洞数 | 最高严重度 | 详情 |',
    '|------|------|------|--------|------------|------|',
  ]

  for (const s of withVulns) {
    const direct = s.isDirect ? 'direct' : 'transitive'
    const scope = s.scope ?? '—'
    const details = s.vulnerabilities
      .map(v => {
        const fix = v.fixAvailable ? ' [可修复]' : ' [暂无修复]'
        const ver = v.fixVersion ? ` → ${v.fixVersion}` : ''
        return `${v.severity}: ${v.title}${fix}${ver}`
      })
      .join('; ')
    lines.push(
      `| ${s.name} | ${direct} | ${scope} | ${s.totalVulnerabilities} | ${s.highestSeverity} | ${details} |`,
    )
  }

  if (transitiveHidden > 0) {
    lines.push('')
    lines.push(
      `_隐藏了 ${transitiveHidden} 个子依赖漏洞（已归并到优化建议）；--deep 查看全部_`,
    )
  }
  return lines.join('\n')
}

function renderOptimizationSection(opts: OptimizationSuggestion[]): string {
  if (opts.length === 0) return ''

  const sorted = [...opts].sort((a, b) => {
    const pri = { high: 3, medium: 2, low: 1 }
    return (pri[b.priority] ?? 0) - (pri[a.priority] ?? 0)
  })

  const lines = ['## 优化建议', '']

  for (const o of sorted) {
    const confBadge = o.confidence ? ` [${o.confidence}]` : ''
    const actBadge = o.actionability ? ` [${o.actionability}]` : ''
    const savings =
      o.estimatedSavings && o.estimatedSavings > 0
        ? ` (节省 ~${formatBytes(o.estimatedSavings)}${o.estimatedSavingsPercent ? ` ${o.estimatedSavingsPercent}%` : ''})`
        : ''

    lines.push(
      `### ${o.priority === 'high' ? '🔴' : o.priority === 'medium' ? '🟡' : '⚪'} ${o.packageName} [${o.type}]${confBadge}${actBadge}${savings}`,
    )
    lines.push('')
    lines.push(o.description)

    if (o.alternative) {
      lines.push(
        `- 建议替代: **${o.alternative}** (难度: ${o.difficulty}${o.breakingChange ? ', 破坏性变更' : ''})`,
      )
    }

    if (o.evidence && o.evidence.length > 0) {
      lines.push('- 证据:')
      for (const ev of o.evidence) {
        const loc = ev.file
          ? ` \`${ev.file}${ev.line ? `:${ev.line}` : ''}\``
          : ''
        lines.push(`  - ${ev.source}${loc}: ${ev.detail}`)
      }
    }

    if (o.preconditions && o.preconditions.length > 0) {
      for (const p of o.preconditions) {
        lines.push(`- ⚠ 前提: ${p}`)
      }
    }

    if (o.suggestedSteps && o.suggestedSteps.length > 0) {
      lines.push('- 操作步骤:')
      o.suggestedSteps.forEach((step, i) => {
        lines.push(`  ${i + 1}. ${step}`)
      })
    }

    if (o.caveats && o.caveats.length > 0) {
      for (const c of o.caveats) {
        lines.push(`- ⚠ ${c}`)
      }
    }

    if (o.migrationGuide) {
      lines.push(`- [迁移指南](${o.migrationGuide})`)
    }

    lines.push('')
  }

  return lines.join('\n')
}
