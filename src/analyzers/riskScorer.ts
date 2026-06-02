/**
 * 风险评分器
 *
 * 将各类分析结果统一映射为 P0-P3 优先级，用于 CI 退出码判定和报告排序。
 *
 * P0: 必须立即处理（direct prod critical/high 漏洞、高风险许可证冲突）
 * P1: 应尽快处理（direct prod moderate 漏洞、deprecated 包、高优先级优化建议）
 * P2: 建议处理（transitive high 漏洞、中等优先级建议、卫生问题）
 * P3: 信息性（transitive low/moderate、低优先级建议、info 级别问题）
 */

import type {
  AnalysisReport,
  OptimizationSuggestion,
  SecurityInfo,
} from '../types/analysis.js'
import type { HygieneIssue } from './dependencyHygiene.js'

export type RiskPriority = 'P0' | 'P1' | 'P2' | 'P3'

export interface ScoredFinding {
  priority: RiskPriority
  category: 'security' | 'license' | 'optimization' | 'hygiene' | 'budget'
  packageName: string
  summary: string
  actionable: boolean
}

/**
 * 将 AnalysisReport 中的所有发现统一评分为 P0-P3
 */
export function scoreFindings(report: AnalysisReport): ScoredFinding[] {
  const findings: ScoredFinding[] = []

  // 安全漏洞
  for (const s of report.security) {
    const finding = scoreSecurity(s)
    if (finding) findings.push(finding)
  }

  // 许可证问题
  for (const l of report.licenses) {
    if (l.risk === 'high') {
      findings.push({
        priority: 'P0',
        category: 'license',
        packageName: l.name,
        summary: `高风险许可证: ${l.license}`,
        actionable: true,
      })
    } else if (l.risk === 'medium') {
      findings.push({
        priority: 'P2',
        category: 'license',
        packageName: l.name,
        summary: `中风险许可证: ${l.license}`,
        actionable: false,
      })
    }
  }

  // 优化建议
  for (const o of report.optimizations) {
    const finding = scoreOptimization(o)
    findings.push(finding)
  }

  // 卫生问题
  if (report.hygieneIssues) {
    for (const h of report.hygieneIssues) {
      const finding = scoreHygiene(h)
      findings.push(finding)
    }
  }

  // budget
  if (report.bundles.length > 0 && report.summary.totalGzip > 0) {
    // budget 检查在 scan.ts 的 decideExitCode 中处理
    // 这里不重复添加 finding
  }

  return findings.sort((a, b) => {
    const pri = { P0: 4, P1: 3, P2: 2, P3: 1 }
    return (pri[b.priority] ?? 0) - (pri[a.priority] ?? 0)
  })
}

/**
 * 判断是否有 P0 级别的发现（CI 应失败）
 */
export function hasP0Findings(findings: ScoredFinding[]): boolean {
  return findings.some(f => f.priority === 'P0')
}

/**
 * 判断是否有 P0 或 P1 级别的发现
 */
export function hasHighPriorityFindings(findings: ScoredFinding[]): boolean {
  return findings.some(f => f.priority === 'P0' || f.priority === 'P1')
}

// =====================================================================
// 内部评分逻辑
// =====================================================================

function scoreSecurity(s: SecurityInfo): ScoredFinding | null {
  if (s.totalVulnerabilities === 0) return null

  const isDirect = s.isDirect !== false
  const isProd = s.scope !== 'dev'

  // P0: direct prod critical/high
  if (
    isDirect &&
    isProd &&
    (s.highestSeverity === 'critical' || s.highestSeverity === 'high')
  ) {
    return {
      priority: 'P0',
      category: 'security',
      packageName: s.name,
      summary: `${s.highestSeverity} 漏洞（${s.totalVulnerabilities} 个）`,
      actionable: true,
    }
  }

  // P1: direct prod moderate
  if (isDirect && isProd && s.highestSeverity === 'moderate') {
    return {
      priority: 'P1',
      category: 'security',
      packageName: s.name,
      summary: `moderate 漏洞（${s.totalVulnerabilities} 个）`,
      actionable: true,
    }
  }

  // P2: transitive high/critical
  if (
    !isDirect &&
    (s.highestSeverity === 'critical' || s.highestSeverity === 'high')
  ) {
    return {
      priority: 'P2',
      category: 'security',
      packageName: s.name,
      summary: `transitive ${s.highestSeverity} 漏洞`,
      actionable: false,
    }
  }

  // P3: 其他
  return {
    priority: 'P3',
    category: 'security',
    packageName: s.name,
    summary: `${s.highestSeverity} 漏洞`,
    actionable: false,
  }
}

function scoreOptimization(o: OptimizationSuggestion): ScoredFinding {
  // P0: deprecated high priority
  if (o.type === 'deprecated' && o.priority === 'high') {
    return {
      priority: 'P0',
      category: 'optimization',
      packageName: o.packageName,
      summary: o.description,
      actionable: true,
    }
  }

  // P1: high priority with ready actionability
  if (o.priority === 'high' && o.actionability !== 'info') {
    return {
      priority: 'P1',
      category: 'optimization',
      packageName: o.packageName,
      summary: o.description,
      actionable: o.actionability === 'ready',
    }
  }

  // P2: medium priority
  if (o.priority === 'medium') {
    return {
      priority: 'P2',
      category: 'optimization',
      packageName: o.packageName,
      summary: o.description,
      actionable: o.actionability === 'ready',
    }
  }

  // P3: low priority or info
  return {
    priority: 'P3',
    category: 'optimization',
    packageName: o.packageName,
    summary: o.description,
    actionable: false,
  }
}

function scoreHygiene(h: HygieneIssue): ScoredFinding {
  if (h.type === 'unused-direct' && h.confidence === 'high') {
    return {
      priority: 'P2',
      category: 'hygiene',
      packageName: h.packageName,
      summary: h.description,
      actionable: true,
    }
  }

  if (h.type === 'misplaced-dependency' && h.confidence === 'high') {
    return {
      priority: 'P2',
      category: 'hygiene',
      packageName: h.packageName,
      summary: h.description,
      actionable: true,
    }
  }

  return {
    priority: 'P3',
    category: 'hygiene',
    packageName: h.packageName,
    summary: h.description,
    actionable: false,
  }
}
