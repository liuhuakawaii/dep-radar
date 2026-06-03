import { beforeAll, describe, expect, it } from 'vitest'

import type { AnalysisReport } from '../types/analysis.js'
import { renderTerminalReport } from './terminal.js'

beforeAll(() => {
  // 关闭 chalk 颜色，使 assertion 不受 ANSI 干扰
  process.env.FORCE_COLOR = '0'
})

function emptyReport(override: Partial<AnalysisReport> = {}): AnalysisReport {
  return {
    project: 'demo',
    timestamp: '2026-06-01T10:00:00.000Z',
    packageManager: 'pnpm',
    dimensions: {
      size: true,
      health: true,
      license: true,
      security: true,
      optimize: true,
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
    ...override,
  }
}

describe('renderTerminalReport', () => {
  it('应该包含 header 中的项目名与时间', () => {
    const out = renderTerminalReport(emptyReport({ project: 'my-app' }))
    expect(out).toContain('dep-radar')
    expect(out).toContain('my-app')
    expect(out).toContain('2026-06-01')
    expect(out).toContain('pnpm')
  })

  it('全维度开启 + 数据为空时应显示各 section 标题和占位提示', () => {
    const out = renderTerminalReport(emptyReport())
    expect(out).toContain('包体积')
    expect(out).toContain('依赖健康度')
    expect(out).toContain('许可证合规')
    expect(out).toContain('安全审计')
    expect(out).toContain('优化建议')
    expect(out).toMatch(/无数据|未发现/)
  })

  it('维度关闭时对应 section 不应出现', () => {
    const out = renderTerminalReport(
      emptyReport({
        dimensions: {
          size: true,
          health: false,
          license: false,
          security: false,
          optimize: false,
        },
      }),
    )
    expect(out).toContain('包体积')
    expect(out).not.toContain('依赖健康度')
    expect(out).not.toContain('许可证合规')
    expect(out).not.toContain('安全审计')
    expect(out).not.toContain('优化建议')
  })

  it('summary 应该按需展示警告项', () => {
    const out = renderTerminalReport(
      emptyReport({
        summary: {
          totalDependencies: 50,
          totalSize: 1_000_000,
          totalGzip: 300_000,
          maxDepth: 5,
          vulnerabilities: { critical: 1, high: 2, moderate: 0, low: 0 },
          licenseIssues: 1,
          optimizationCount: 3,
          deprecatedCount: 2,
        },
      }),
    )
    expect(out).toContain('依赖总数')
    expect(out).toContain('50')
    expect(out).toContain('已废弃')
    expect(out).toContain('许可证问题')
    expect(out).toContain('优化建议')
    expect(out).toContain('critical=1')
    expect(out).toContain('high=2')
  })

  it('bundles 数据应渲染为表格，含 TOP 大户与失败项', () => {
    const out = renderTerminalReport(
      emptyReport({
        bundles: [
          {
            name: 'lodash',
            version: '4.17.21',
            size: 72_000,
            gzip: 25_000,
            dependencyCount: 0,
            hasJSModule: false,
            hasJSNext: false,
            source: 'pkg-size',
            isDirect: true,
          },
          {
            name: '@private/x',
            version: '1.0.0',
            size: 0,
            gzip: 0,
            dependencyCount: 0,
            hasJSModule: false,
            hasJSNext: false,
            source: 'unknown',
            error: 'private package',
            isDirect: true,
          },
        ],
      }),
    )
    expect(out).toContain('lodash')
    expect(out).toContain('4.17.21')
    expect(out).toContain('@private/x')
    // gzip 应被 formatBytes 渲染
    expect(out).toContain('24.41 KB')
    expect(out).toContain('pkg-size')
    expect(out).toContain('unknown')
  })

  it('health 数据应按健康度分色显示', () => {
    const out = renderTerminalReport(
      emptyReport({
        health: [
          {
            name: 'react',
            weeklyDownloads: 20_000_000,
            downloadTrend: 'stable',
            lastPublish: '2026-05-01T00:00:00Z',
            maintainers: 10,
            openIssues: 100,
            deprecated: false,
            hasTypeScriptTypes: true,
            healthScore: 95,
            isDirect: true,
          },
        ],
      }),
    )
    expect(out).toContain('react')
    expect(out).toContain('95')
    expect(out).toContain('20,000,000')
  })

  it('licenses 全部 low risk 时显示"全部低风险"', () => {
    const out = renderTerminalReport(
      emptyReport({
        licenses: [
          {
            name: 'react',
            license: 'MIT',
            licenseType: 'permissive',
            risk: 'low',
            isDirect: true,
          },
        ],
      }),
    )
    expect(out).toContain('全部 1 个依赖')
    expect(out).toContain('低风险')
  })

  it('licenses 含高风险时应展示冲突表', () => {
    const out = renderTerminalReport(
      emptyReport({
        licenses: [
          {
            name: 'risky',
            license: 'GPL-3.0',
            licenseType: 'strong-copyleft',
            risk: 'high',
            conflict: 'GPL 可能要求开源',
            isDirect: true,
          },
        ],
      }),
    )
    expect(out).toContain('risky')
    expect(out).toContain('GPL-3.0')
    expect(out).toContain('GPL 可能要求开源')
  })

  it('security 全部无漏洞时显示"未发现已知漏洞"', () => {
    const out1 = renderTerminalReport(
      emptyReport({
        security: [
          {
            name: 'safe',
            vulnerabilities: [],
            totalVulnerabilities: 0,
            highestSeverity: 'none',
          },
        ],
      }),
    )
    expect(out1).toContain('未发现已知漏洞')
  })

  it('optimizations 应按优先级 + 节省量降序', () => {
    const out = renderTerminalReport(
      emptyReport({
        optimizations: [
          {
            packageName: 'lodash',
            type: 'replace',
            priority: 'medium',
            description: '体积大',
            alternative: 'es-toolkit',
            estimatedSavings: 100_000,
            difficulty: 'medium',
            breakingChange: false,
          },
          {
            packageName: 'moment',
            type: 'replace',
            priority: 'high',
            description: '废弃且体积巨大',
            alternative: 'dayjs',
            estimatedSavings: 200_000,
            difficulty: 'low',
            breakingChange: false,
            caveats: ['时区处理略有差异'],
            migrationGuide: 'https://day.js.org/...',
          },
        ],
      }),
    )
    // moment 优先级 high 应排前
    expect(out.indexOf('moment')).toBeLessThan(out.indexOf('lodash'))
    expect(out).toContain('es-toolkit')
    expect(out).toContain('dayjs')
    expect(out).toContain('时区处理略有差异')
    expect(out).toContain('https://day.js.org/...')
  })
})
