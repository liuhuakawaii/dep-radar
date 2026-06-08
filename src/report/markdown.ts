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
} from '../types/analysis.js'
import {
  formatBytes,
  formatDate,
  formatNumber,
  formatRelativeTime,
} from '../utils/format.js'

export function renderMarkdownReport(report: AnalysisReport): string {
  const sections = [
    renderHeader(report),
    renderSummary(report),
    renderDiagnostics(report),
    report.dimensions.size ? renderBundleSection(report.bundles) : '',
    report.dimensions.health ? renderHealthSection(report.health) : '',
    report.dimensions.license ? renderLicenseSection(report.licenses) : '',
    report.dimensions.security ? renderSecuritySection(report) : '',
    report.dimensions.optimize
      ? renderOptimizationSection(report.optimizations)
      : '',
  ]
  return sections.filter(Boolean).join('\n\n') + '\n'
}

function renderDiagnostics(report: AnalysisReport): string {
  const diagnostics = report.diagnostics
  if (!diagnostics?.partial) return ''

  const lines = ['## 数据完整性', '']
  for (const warning of diagnostics.warnings.slice(0, 10)) {
    lines.push(`- ⚠ ${warning}`)
  }

  const skippedByDimension = new Map<string, number>()
  for (const item of diagnostics.skipped) {
    skippedByDimension.set(
      item.dimension,
      (skippedByDimension.get(item.dimension) ?? 0) + 1,
    )
  }
  for (const [dimension, count] of skippedByDimension) {
    lines.push(`- ⚠ ${dimension} 有 ${count} 项未覆盖，结论为部分结果`)
  }

  return lines.join('\n')
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

function renderBundleSection(bundles: BundleInfo[]): string {
  if (bundles.length === 0) return ''

  const sorted = [...bundles].sort((a, b) => b.gzip - a.gzip)
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

  return lines.join('\n')
}

function renderHealthSection(health: HealthInfo[]): string {
  if (health.length === 0) return ''

  const sorted = [...health].sort((a, b) => b.healthScore - a.healthScore)

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

  return lines.join('\n')
}

function renderLicenseSection(licenses: LicenseInfo[]): string {
  if (licenses.length === 0) return ''

  // 只显示非 low 风险的包
  const issues = licenses.filter(l => l.risk !== 'low')
  if (issues.length === 0) return ''

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

  return lines.join('\n')
}

function renderSecuritySection(report: AnalysisReport): string {
  const { security } = report
  const skippedCount =
    report.diagnostics?.skipped.filter(s => s.dimension === 'security')
      .length ?? 0
  if (skippedCount > 0 && security.length === 0) {
    return `## 安全漏洞\n\n⚠ 安全审计未完整运行，${skippedCount} 项被跳过`
  }
  if (security.length === 0) return ''

  const withVulns = security.filter(s => s.totalVulnerabilities > 0)
  if (withVulns.length === 0) {
    return skippedCount > 0
      ? `## 安全漏洞\n\n⚠ 未发现已知漏洞，但 ${skippedCount} 项审计结果被跳过`
      : ''
  }

  const lines = [
    '## 安全漏洞',
    '',
    '| 包名 | 类型 | 范围 | 漏洞数 | 最高严重度 | 详情 |',
    '|------|------|------|--------|------------|------|',
  ]
  if (skippedCount > 0) {
    lines.splice(2, 0, `> ⚠ ${skippedCount} 项安全审计结果被跳过`, '')
  }

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
