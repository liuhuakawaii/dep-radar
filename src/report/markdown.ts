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
  SecurityInfo,
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
    report.dimensions.size ? renderBundleSection(report.bundles) : '',
    report.dimensions.health ? renderHealthSection(report.health) : '',
    report.dimensions.license ? renderLicenseSection(report.licenses) : '',
    report.dimensions.security ? renderSecuritySection(report.security) : '',
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
    '| 包名 | 许可证 | 风险 | 说明 |',
    '|------|--------|------|------|',
  ]

  for (const l of issues) {
    const risk = l.risk === 'high' ? '**high**' : l.risk
    lines.push(`| ${l.name} | ${l.license} | ${risk} | ${l.conflict || '—'} |`)
  }

  return lines.join('\n')
}

function renderSecuritySection(security: SecurityInfo[]): string {
  if (security.length === 0) return ''

  const withVulns = security.filter(s => s.totalVulnerabilities > 0)
  if (withVulns.length === 0) return ''

  const lines = [
    '## 安全漏洞',
    '',
    '| 包名 | 漏洞数 | 最高严重度 | 详情 |',
    '|------|--------|------------|------|',
  ]

  for (const s of withVulns) {
    const details = s.vulnerabilities
      .map(v => `${v.severity}: ${v.title}`)
      .join('; ')
    lines.push(
      `| ${s.name} | ${s.totalVulnerabilities} | ${s.highestSeverity} | ${details} |`,
    )
  }

  return lines.join('\n')
}
