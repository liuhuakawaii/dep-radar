import { describe, expect, it } from 'vitest'

import type { AnalysisReport } from '../types/analysis.js'
import {
  hasP0Findings,
  hasHighPriorityFindings,
  scoreFindings,
} from './riskScorer.js'

function makeReport(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
  return {
    project: 'test',
    timestamp: new Date().toISOString(),
    packageManager: 'pnpm',
    dimensions: {
      size: false,
      health: false,
      license: false,
      security: false,
      optimize: false,
    },
    summary: {
      totalDependencies: 0,
      totalSize: 0,
      totalGzip: 0,
      maxDepth: 0,
      vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 },
      licenseIssues: 0,
      optimizationCount: 0,
      deprecatedCount: 0,
    },
    bundles: [],
    health: [],
    licenses: [],
    security: [],
    optimizations: [],
    ...overrides,
  }
}

describe('scoreFindings', () => {
  it('空报告返回空数组', () => {
    expect(scoreFindings(makeReport())).toEqual([])
  })

  it('direct prod critical 漏洞 → P0', () => {
    const findings = scoreFindings(
      makeReport({
        security: [
          {
            name: 'fast-xml-parser',
            vulnerabilities: [],
            totalVulnerabilities: 1,
            highestSeverity: 'critical',
            isDirect: true,
            scope: 'prod',
          },
        ],
      }),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.priority).toBe('P0')
    expect(findings[0]!.category).toBe('security')
    expect(findings[0]!.actionable).toBe(true)
  })

  it('direct prod moderate 漏洞 → P1', () => {
    const findings = scoreFindings(
      makeReport({
        security: [
          {
            name: 'uuid',
            vulnerabilities: [],
            totalVulnerabilities: 1,
            highestSeverity: 'moderate',
            isDirect: true,
            scope: 'prod',
          },
        ],
      }),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.priority).toBe('P1')
  })

  it('transitive high 漏洞 → P2', () => {
    const findings = scoreFindings(
      makeReport({
        security: [
          {
            name: 'semver',
            vulnerabilities: [],
            totalVulnerabilities: 1,
            highestSeverity: 'high',
            isDirect: false,
            scope: 'prod',
          },
        ],
      }),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.priority).toBe('P2')
    expect(findings[0]!.actionable).toBe(false)
  })

  it('高风险许可证 → P0', () => {
    const findings = scoreFindings(
      makeReport({
        licenses: [
          {
            name: 'gpl-lib',
            license: 'GPL-3.0',
            licenseType: 'strong-copyleft',
            risk: 'high',
          },
        ],
      }),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.priority).toBe('P0')
  })

  it('deprecated 高优先级建议 → P0', () => {
    const findings = scoreFindings(
      makeReport({
        optimizations: [
          {
            packageName: 'react-mentions',
            type: 'deprecated',
            priority: 'high',
            description: '已废弃',
            difficulty: 'medium',
            breakingChange: false,
          },
        ],
      }),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.priority).toBe('P0')
  })

  it('high 优先级 ready 建议 → P1', () => {
    const findings = scoreFindings(
      makeReport({
        optimizations: [
          {
            packageName: 'moment',
            type: 'replace',
            priority: 'high',
            description: '建议替换',
            alternative: 'dayjs',
            difficulty: 'low',
            breakingChange: false,
            actionability: 'ready',
          },
        ],
      }),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]!.priority).toBe('P1')
    expect(findings[0]!.actionable).toBe(true)
  })

  it('结果按优先级降序排列', () => {
    const findings = scoreFindings(
      makeReport({
        security: [
          {
            name: 'low-pkg',
            vulnerabilities: [],
            totalVulnerabilities: 1,
            highestSeverity: 'low',
            isDirect: false,
            scope: 'dev',
          },
        ],
        optimizations: [
          {
            packageName: 'deprecated-pkg',
            type: 'deprecated',
            priority: 'high',
            description: '已废弃',
            difficulty: 'medium',
            breakingChange: false,
          },
        ],
      }),
    )
    expect(findings[0]!.priority).toBe('P0')
    expect(findings[1]!.priority).toBe('P3')
  })
})

describe('hasP0Findings', () => {
  it('无 P0 时返回 false', () => {
    expect(hasP0Findings([])).toBe(false)
    expect(
      hasP0Findings([
        {
          priority: 'P1',
          category: 'security',
          packageName: 'x',
          summary: '',
          actionable: true,
        },
      ]),
    ).toBe(false)
  })

  it('有 P0 时返回 true', () => {
    expect(
      hasP0Findings([
        {
          priority: 'P0',
          category: 'security',
          packageName: 'x',
          summary: '',
          actionable: true,
        },
      ]),
    ).toBe(true)
  })
})

describe('hasHighPriorityFindings', () => {
  it('P0 或 P1 返回 true', () => {
    expect(
      hasHighPriorityFindings([
        {
          priority: 'P0',
          category: 'security',
          packageName: 'x',
          summary: '',
          actionable: true,
        },
      ]),
    ).toBe(true)
    expect(
      hasHighPriorityFindings([
        {
          priority: 'P1',
          category: 'security',
          packageName: 'x',
          summary: '',
          actionable: true,
        },
      ]),
    ).toBe(true)
  })

  it('P2 或 P3 返回 false', () => {
    expect(
      hasHighPriorityFindings([
        {
          priority: 'P2',
          category: 'security',
          packageName: 'x',
          summary: '',
          actionable: false,
        },
      ]),
    ).toBe(false)
  })
})
