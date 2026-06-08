/**
 * diff 报告渲染器
 *
 * 支持 terminal（带颜色的终端输出）和 json 两种格式。
 */

import chalk from 'chalk'

import type { DiffReport } from '../types/analysis.js'
import { formatBytes } from '../utils/format.js'

export function renderDiffReport(
  diff: DiffReport,
  format: 'terminal' | 'json',
): string {
  if (format === 'json') return JSON.stringify(diff, null, 2)
  return renderTerminal(diff)
}

function renderTerminal(diff: DiffReport): string {
  const lines: string[] = []

  // Header
  lines.push(chalk.bold('dep-radar diff'))
  lines.push(
    chalk.gray(
      `${diff.before.project} (${diff.before.timestamp}) → ${diff.after.project} (${diff.after.timestamp})`,
    ),
  )
  lines.push('')

  // Summary
  lines.push(chalk.bold.underline('Summary'))
  lines.push(
    formatSummaryLine(
      'Total gzip',
      diff.summary.totalGzip.before,
      diff.summary.totalGzip.after,
    ),
  )
  lines.push(
    formatSummaryLine(
      'Total size',
      diff.summary.totalSize.before,
      diff.summary.totalSize.after,
    ),
  )
  lines.push(
    formatSummaryLine(
      'Dependencies',
      diff.summary.totalDependencies.before,
      diff.summary.totalDependencies.after,
      false,
    ),
  )
  lines.push(
    formatSummaryLine(
      'Deprecated',
      diff.summary.deprecatedCount.before,
      diff.summary.deprecatedCount.after,
      false,
    ),
  )
  lines.push('')

  // Bundles
  const { added, removed, changed } = diff.bundles
  if (added.length > 0 || removed.length > 0 || changed.length > 0) {
    lines.push(chalk.bold.underline('Bundle Changes'))
    for (const b of added) {
      lines.push(chalk.green(`  + ${b.name} (${formatBytes(b.gzip)})`))
    }
    for (const b of removed) {
      lines.push(chalk.red(`  - ${b.name} (${formatBytes(b.gzip)})`))
    }
    for (const c of changed) {
      const sign = c.delta > 0 ? '+' : ''
      const color = c.delta > 0 ? chalk.red : chalk.green
      lines.push(
        color(
          `  ~ ${c.name} ${formatBytes(c.beforeGzip)} → ${formatBytes(c.afterGzip)} (${sign}${formatBytes(c.delta)})`,
        ),
      )
    }
    lines.push('')
  }

  // Health
  if (diff.health.newlyDeprecated.length > 0) {
    lines.push(chalk.bold.underline('Newly Deprecated'))
    for (const d of diff.health.newlyDeprecated) {
      lines.push(
        chalk.yellow(`  ! ${d.name}${d.message ? `: ${d.message}` : ''}`),
      )
    }
    lines.push('')
  }

  if (diff.health.scoreChanges.length > 0) {
    lines.push(chalk.bold.underline('Health Score Changes'))
    for (const s of diff.health.scoreChanges.slice(0, 10)) {
      const sign = s.after > s.before ? '+' : ''
      const color = s.after < s.before ? chalk.red : chalk.green
      lines.push(
        color(
          `  ${s.name} ${s.before} → ${s.after} (${sign}${s.after - s.before})`,
        ),
      )
    }
    if (diff.health.scoreChanges.length > 10) {
      lines.push(
        chalk.gray(`  ... and ${diff.health.scoreChanges.length - 10} more`),
      )
    }
    lines.push('')
  }

  // Security
  if (diff.security.new.length > 0) {
    lines.push(chalk.bold.underline('New Vulnerabilities'))
    for (const s of diff.security.new) {
      lines.push(
        chalk.red(
          `  ! ${s.name}: ${s.totalVulnerabilities} vulnerability(ies), highest: ${s.highestSeverity}`,
        ),
      )
    }
    lines.push('')
  }

  if (diff.security.resolved.length > 0) {
    lines.push(chalk.bold.green.underline('Resolved Vulnerabilities'))
    for (const s of diff.security.resolved) {
      lines.push(chalk.green(`  ✓ ${s.name}`))
    }
    lines.push('')
  }

  if (
    added.length === 0 &&
    removed.length === 0 &&
    changed.length === 0 &&
    diff.health.newlyDeprecated.length === 0 &&
    diff.health.scoreChanges.length === 0 &&
    diff.security.new.length === 0 &&
    diff.security.resolved.length === 0
  ) {
    lines.push(chalk.green('No significant changes detected.'))
  }

  return lines.join('\n')
}

function formatSummaryLine(
  label: string,
  before: number,
  after: number,
  isBytes = true,
): string {
  const delta = after - before
  if (delta === 0)
    return chalk.gray(`  ${label}: ${isBytes ? formatBytes(before) : before}`)
  const sign = delta > 0 ? '+' : ''
  const color = delta > 0 ? chalk.red : chalk.green
  const fmt = isBytes ? formatBytes : (n: number) => String(n)
  return color(
    `  ${label}: ${fmt(before)} → ${fmt(after)} (${sign}${fmt(delta)})`,
  )
}
