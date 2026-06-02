/**
 * HTML 报告生成器
 *
 * 设计要点：
 *   - 单文件输出：内联 CSS、无外部资源（除了 conic-gradient 等纯 CSS 特性）
 *   - 离线可用：不引入 CDN、字体、图表库
 *   - 深色主题：CSS 变量驱动，与终端报告色调一致
 *   - XSS 安全：所有用户数据走 escapeHtml
 *
 * 不做的事：
 *   - 不引 ECharts 等图表库（PLAN 明确"重依赖留给独立 Web 仪表板包"）
 *   - 不做交互式过滤/排序（保持静态文档简单）
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

// =====================================================================
// 主入口
// =====================================================================

export function renderHtmlReport(report: AnalysisReport): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    `<head>${renderHead(report)}</head>`,
    `<body>${renderBody(report)}</body>`,
    '</html>',
  ].join('\n')
}

// =====================================================================
// head + 内联 CSS
// =====================================================================

function renderHead(report: AnalysisReport): string {
  return `
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>dep-radar 报告 - ${escapeHtml(report.project)}</title>
  <style>${CSS}</style>`
}

const CSS = `
  :root {
    --bg: #0f1418;
    --bg-card: #1a2128;
    --bg-card-2: #232b34;
    --fg: #e6edf3;
    --fg-muted: #8b949e;
    --border: #30363d;
    --accent: #58a6ff;
    --green: #3fb950;
    --yellow: #d29922;
    --orange: #db8642;
    --red: #f85149;
    --purple: #bc8cff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 32px 20px;
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Microsoft YaHei", Roboto, sans-serif;
    font-size: 14px;
    line-height: 1.5;
  }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1, h2, h3 { color: var(--fg); margin: 0; }
  h1 { font-size: 24px; }
  h2 { font-size: 18px; margin: 32px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
  h3 { font-size: 15px; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .muted { color: var(--fg-muted); }
  .row { display: flex; flex-wrap: wrap; gap: 16px; }
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 20px;
  }
  .stat {
    flex: 1 1 180px;
    min-width: 180px;
  }
  .stat .label { color: var(--fg-muted); font-size: 12px; margin-bottom: 6px; }
  .stat .value { font-size: 22px; font-weight: 600; }
  .stat.warn .value { color: var(--yellow); }
  .stat.danger .value { color: var(--red); }
  .stat.ok .value { color: var(--green); }
  table { width: 100%; border-collapse: collapse; }
  th, td {
    padding: 8px 10px;
    text-align: left;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  th { color: var(--fg-muted); font-weight: 500; font-size: 12px; text-transform: uppercase; }
  tr:last-child td { border-bottom: none; }
  .bar {
    height: 6px;
    background: var(--bg-card-2);
    border-radius: 3px;
    overflow: hidden;
    margin-top: 4px;
  }
  .bar > span {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, var(--accent), var(--purple));
  }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 500;
    background: var(--bg-card-2);
    color: var(--fg-muted);
  }
  .badge.green  { color: var(--green); }
  .badge.yellow { color: var(--yellow); }
  .badge.orange { color: var(--orange); }
  .badge.red    { color: var(--red); }
  .badge.purple { color: var(--purple); }
  .header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 24px;
  }
  .header .meta { color: var(--fg-muted); font-size: 13px; }
  .suggestion {
    margin-bottom: 12px;
    padding: 14px 16px;
    border-left: 3px solid var(--border);
    border-radius: 0 6px 6px 0;
    background: var(--bg-card);
  }
  .suggestion.high   { border-left-color: var(--red); }
  .suggestion.medium { border-left-color: var(--yellow); }
  .suggestion.low    { border-left-color: var(--fg-muted); }
  .suggestion .title { font-weight: 600; }
  .suggestion .savings { color: var(--green); font-size: 12px; margin-left: 8px; }
  .empty { color: var(--fg-muted); padding: 12px; font-style: italic; }
  .pie {
    --p: 0;
    --c: var(--accent);
    width: 96px; height: 96px;
    border-radius: 50%;
    background:
      conic-gradient(var(--c) calc(var(--p) * 1%), var(--bg-card-2) 0);
    position: relative;
    display: inline-block;
  }
  .pie::after {
    content: attr(data-label);
    position: absolute;
    inset: 12px;
    background: var(--bg-card);
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    color: var(--fg);
    font-size: 14px;
    font-weight: 600;
  }
  .footer {
    margin-top: 40px;
    text-align: center;
    color: var(--fg-muted);
    font-size: 12px;
  }
`

// =====================================================================
// body 主体
// =====================================================================

function renderBody(report: AnalysisReport): string {
  return `
  <div class="wrap">
    ${renderHeader(report)}
    ${renderSummaryCards(report)}
    ${report.dimensions.size ? renderBundleSection(report.bundles) : ''}
    ${report.dimensions.optimize ? renderOptimizationSection(report.optimizations) : ''}
    ${report.dimensions.health ? renderHealthSection(report.health) : ''}
    ${report.dimensions.license ? renderLicenseSection(report.licenses) : ''}
    ${report.dimensions.security ? renderSecuritySection(report.security) : ''}
    ${renderFooter()}
  </div>`
}

function renderHeader(report: AnalysisReport): string {
  return `
  <div class="header">
    <div>
      <h1>${escapeHtml(report.project)}</h1>
      <div class="meta">分析时间 ${escapeHtml(formatDate(report.timestamp))} · 包管理器 ${escapeHtml(report.packageManager)}</div>
    </div>
    <div class="muted">由 <a href="https://github.com/" target="_blank" rel="noopener">dep-radar</a> 生成</div>
  </div>`
}

function renderSummaryCards(report: AnalysisReport): string {
  const s = report.summary
  const cards: string[] = [
    statCard('依赖总数', formatNumber(s.totalDependencies)),
    statCard('总体积 (gzip)', formatBytes(s.totalGzip), 'ok'),
  ]
  if (s.deprecatedCount > 0) {
    cards.push(statCard('已废弃', formatNumber(s.deprecatedCount), 'danger'))
  }
  if (s.licenseIssues > 0) {
    cards.push(statCard('许可证问题', formatNumber(s.licenseIssues), 'warn'))
  }
  const vTotal =
    s.vulnerabilities.critical +
    s.vulnerabilities.high +
    s.vulnerabilities.moderate +
    s.vulnerabilities.low
  if (vTotal > 0) {
    cards.push(statCard('安全漏洞', formatNumber(vTotal), 'danger'))
  }
  if (s.optimizationCount > 0) {
    cards.push(statCard('优化建议', formatNumber(s.optimizationCount), 'warn'))
  }
  return `<div class="row">${cards.join('')}</div>`
}

function statCard(label: string, value: string, severity = ''): string {
  return `
  <div class="card stat ${escapeHtml(severity)}">
    <div class="label">${escapeHtml(label)}</div>
    <div class="value">${escapeHtml(value)}</div>
  </div>`
}

// =====================================================================
// 各 section
// =====================================================================

function renderBundleSection(bundles: BundleInfo[]): string {
  if (bundles.length === 0) {
    return `<h2>包体积</h2><div class="empty">（无数据）</div>`
  }
  const sorted = [...bundles].sort((a, b) => b.gzip - a.gzip)
  const totalGzip = sorted.reduce((s, b) => s + b.gzip, 0)
  const rows = sorted
    .map(b => {
      const percent = totalGzip > 0 ? (b.gzip / totalGzip) * 100 : 0
      const sizeText = b.error
        ? `<span class="muted">—</span>`
        : escapeHtml(formatBytes(b.gzip))
      return `
      <tr>
        <td>${b.error ? `<span class="badge red">${escapeHtml(b.name)}</span>` : escapeHtml(b.name)}</td>
        <td class="muted">${escapeHtml(b.version || '—')}</td>
        <td>${sizeText}<div class="bar"><span style="width: ${percent.toFixed(1)}%"></span></div></td>
        <td class="muted">${percent.toFixed(1)}%</td>
        <td><span class="badge ${sourceBadge(b.source)}">${escapeHtml(b.source)}</span></td>
      </tr>`
    })
    .join('')
  return `
  <h2>包体积</h2>
  <div class="card">
    <table>
      <thead><tr><th>包名</th><th>版本</th><th>gzip</th><th>占比</th><th>来源</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`
}

function sourceBadge(src: BundleInfo['source']): string {
  switch (src) {
    case 'pkg-size':
      return 'green'
    case 'bundlephobia':
      return 'yellow'
    case 'local':
      return 'purple'
    default:
      return ''
  }
}

function renderOptimizationSection(opts: OptimizationSuggestion[]): string {
  if (opts.length === 0) {
    return `<h2>优化建议</h2><div class="card"><span class="badge green">✓</span> 未发现明显优化空间</div>`
  }
  const items = opts
    .map(
      o => `
    <div class="suggestion ${escapeHtml(o.priority)}">
      <div class="title">
        <span class="badge ${priorityBadge(o.priority)}">${escapeHtml(o.priority)}</span>
        ${escapeHtml(o.packageName)}
        <span class="muted" style="font-weight:400">[${escapeHtml(o.type)}]</span>
        ${
          o.estimatedSavings && o.estimatedSavings > 0
            ? `<span class="savings">节省 ~${escapeHtml(formatBytes(o.estimatedSavings))}${
                o.estimatedSavingsPercent
                  ? ` (${o.estimatedSavingsPercent}%)`
                  : ''
              }</span>`
            : ''
        }
      </div>
      <div style="margin-top:6px">${escapeHtml(o.description)}</div>
      ${
        o.alternative
          ? `<div class="muted" style="margin-top:6px">建议替代：<strong style="color:var(--accent)">${escapeHtml(o.alternative)}</strong> · 难度 ${escapeHtml(o.difficulty)}${o.breakingChange ? ' · 破坏性变更' : ''}</div>`
          : ''
      }
      ${
        o.caveats && o.caveats.length > 0
          ? `<ul class="muted" style="margin:6px 0 0 18px;padding:0">${o.caveats.map(c => `<li>⚠ ${escapeHtml(c)}</li>`).join('')}</ul>`
          : ''
      }
      ${
        o.migrationGuide
          ? `<div style="margin-top:6px">迁移指南：<a href="${escapeHtml(o.migrationGuide)}" target="_blank" rel="noopener">${escapeHtml(o.migrationGuide)}</a></div>`
          : ''
      }
    </div>`,
    )
    .join('')
  return `<h2>优化建议</h2>${items}`
}

function priorityBadge(p: string): string {
  if (p === 'high') return 'red'
  if (p === 'medium') return 'yellow'
  return ''
}

function renderHealthSection(health: HealthInfo[]): string {
  if (health.length === 0) {
    return `<h2>依赖健康度</h2><div class="empty">（无数据）</div>`
  }
  const rows = health
    .map(h => {
      const scoreColor =
        h.healthScore >= 70 ? 'green' : h.healthScore >= 40 ? 'yellow' : 'red'
      return `
      <tr>
        <td>${escapeHtml(h.name)}</td>
        <td><span class="badge ${scoreColor}">${h.healthScore}</span></td>
        <td>${escapeHtml(formatNumber(h.weeklyDownloads))}</td>
        <td>${escapeHtml(formatRelativeTime(h.lastPublish))}</td>
        <td>${h.deprecated ? '<span class="badge red">已废弃</span>' : '<span class="muted">否</span>'}</td>
        <td>${h.hasTypeScriptTypes ? '<span class="badge green">✓</span>' : '<span class="muted">—</span>'}</td>
      </tr>`
    })
    .join('')
  return `
  <h2>依赖健康度</h2>
  <div class="card">
    <table>
      <thead><tr><th>包名</th><th>健康度</th><th>周下载</th><th>最近发布</th><th>废弃</th><th>TS</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`
}

function renderLicenseSection(licenses: LicenseInfo[]): string {
  if (licenses.length === 0) {
    return `<h2>许可证合规</h2><div class="empty">（无数据）</div>`
  }
  const risky = licenses.filter(l => l.risk !== 'low')
  if (risky.length === 0) {
    return `<h2>许可证合规</h2><div class="card"><span class="badge green">✓</span> 全部 ${licenses.length} 个依赖许可证均为低风险</div>`
  }
  const rows = risky
    .map(
      l => `
    <tr>
      <td>${escapeHtml(l.name)}</td>
      <td>${escapeHtml(l.license)}</td>
      <td class="muted">${escapeHtml(l.licenseType)}</td>
      <td><span class="badge ${l.risk === 'high' ? 'red' : 'yellow'}">${escapeHtml(l.risk)}</span></td>
      <td class="muted">${escapeHtml(l.conflict ?? '—')}</td>
    </tr>`,
    )
    .join('')
  return `
  <h2>许可证合规</h2>
  <div class="card">
    <table>
      <thead><tr><th>包名</th><th>许可证</th><th>类型</th><th>风险</th><th>冲突说明</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`
}

function renderSecuritySection(security: SecurityInfo[]): string {
  if (security.length === 0) {
    return `<h2>安全审计</h2><div class="card"><span class="badge green">✓</span> 未发现已知漏洞</div>`
  }
  const vuln = security.filter(s => s.totalVulnerabilities > 0)
  if (vuln.length === 0) {
    return `<h2>安全审计</h2><div class="card"><span class="badge green">✓</span> 未发现已知漏洞</div>`
  }
  const items = vuln
    .map(
      s => `
    <div class="suggestion ${s.highestSeverity === 'critical' || s.highestSeverity === 'high' ? 'high' : 'medium'}">
      <div class="title">${escapeHtml(s.name)} <span class="muted">(${s.totalVulnerabilities} 个漏洞，最高 ${escapeHtml(s.highestSeverity)})</span></div>
      <ul style="margin:6px 0 0 18px;padding:0">${s.vulnerabilities
        .slice(0, 5)
        .map(
          v =>
            `<li>${escapeHtml(v.title)} <span class="muted">(${escapeHtml(v.severity)})</span> ${v.fixAvailable ? '<span class="badge green">可修复</span>' : '<span class="badge red">暂无修复</span>'}</li>`,
        )
        .join('')}</ul>
    </div>`,
    )
    .join('')
  return `<h2>安全审计</h2>${items}`
}

function renderFooter(): string {
  return `<div class="footer">本报告由 dep-radar 生成 · 数据来源：pkg-size.dev / Bundlephobia / npm registry / GitHub</div>`
}

// =====================================================================
// 工具
// =====================================================================

/**
 * 转义 HTML 字符（防 XSS）
 *
 * 对所有用户/远端数据使用；本身已是 HTML 的字符串（如本文件内的 CSS）不要套。
 */
export function escapeHtml(s: string | number | undefined | null): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
