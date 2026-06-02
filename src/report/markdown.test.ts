import { describe, expect, it } from 'vitest'

import type {
  AnalysisReport,
  BundleInfo,
  HealthInfo,
  LicenseInfo,
  OptimizationSuggestion,
  SecurityInfo,
} from '../types/analysis.js'
import { renderMarkdownReport } from './markdown.js'

// =====================================================================
// 工厂
// =====================================================================

function makeReport(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
  return {
    project: 'test-project',
    timestamp: '2026-06-01T10:00:00.000Z',
    packageManager: 'pnpm',
    dimensions: {
      size: true,
      health: false,
      license: false,
      security: false,
      optimize: false,
    },
    summary: {
      totalDependencies: 10,
      totalSize: 100000,
      totalGzip: 30000,
      maxDepth: 3,
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

function makeBundle(over: Partial<BundleInfo> = {}): BundleInfo {
  return {
    name: 'pkg',
    version: '1.0.0',
    size: 10000,
    gzip: 3000,
    dependencyCount: 0,
    hasJSModule: true,
    hasJSNext: false,
    source: 'pkg-size',
    ...over,
  }
}

function makeHealth(over: Partial<HealthInfo> = {}): HealthInfo {
  return {
    name: 'pkg',
    weeklyDownloads: 100,
    downloadTrend: 'stable',
    lastPublish: '2026-01-01T00:00:00Z',
    maintainers: 1,
    openIssues: 0,
    deprecated: false,
    hasTypeScriptTypes: false,
    healthScore: 50,
    ...over,
  }
}

function makeLicense(over: Partial<LicenseInfo> = {}): LicenseInfo {
  return {
    name: 'pkg',
    license: 'MIT',
    licenseType: 'permissive',
    risk: 'low',
    ...over,
  }
}

function makeSecurity(over: Partial<SecurityInfo> = {}): SecurityInfo {
  return {
    name: 'pkg',
    vulnerabilities: [],
    totalVulnerabilities: 0,
    highestSeverity: 'none',
    ...over,
  }
}

function makeOpt(
  over: Partial<OptimizationSuggestion> = {},
): OptimizationSuggestion {
  return {
    packageName: 'pkg',
    type: 'replace',
    priority: 'medium',
    description: '建议替换',
    difficulty: 'low',
    breakingChange: false,
    ...over,
  }
}

// =====================================================================
// 基础结构
// =====================================================================

describe('renderMarkdownReport', () => {
  it('应包含标题和项目信息', () => {
    const out = renderMarkdownReport(makeReport())
    expect(out).toContain('# dep-radar 分析报告')
    expect(out).toContain('test-project')
    expect(out).toContain('pnpm')
  })

  it('应包含概览 section', () => {
    const out = renderMarkdownReport(makeReport())
    expect(out).toContain('## 概览')
    expect(out).toContain('依赖总数')
  })

  it('未运行的维度不应输出对应 section', () => {
    const out = renderMarkdownReport(makeReport())
    expect(out).not.toContain('## 健康度')
    expect(out).not.toContain('## 许可证风险')
    expect(out).not.toContain('## 安全漏洞')
    expect(out).not.toContain('## 优化建议')
  })

  // -----------------------------------------------------------------
  // 包体积
  // -----------------------------------------------------------------

  describe('包体积 section', () => {
    it('有 bundle 数据时应输出表格', () => {
      const out = renderMarkdownReport(
        makeReport({
          bundles: [
            makeBundle({ name: 'react', version: '18.3.1', gzip: 5000 }),
            makeBundle({ name: 'lodash', version: '4.17.21', gzip: 3000 }),
          ],
        }),
      )
      expect(out).toContain('## 包体积')
      expect(out).toContain('| 包名 | 版本 | gzip | 占比 | 来源 |')
      expect(out).toContain('react')
      expect(out).toContain('lodash')
    })

    it('error 包应显示删除线', () => {
      const out = renderMarkdownReport(
        makeReport({
          bundles: [makeBundle({ name: 'private-pkg', error: '私有包' })],
        }),
      )
      expect(out).toContain('~~private-pkg~~')
    })
  })

  // -----------------------------------------------------------------
  // 健康度
  // -----------------------------------------------------------------

  describe('健康度 section', () => {
    it('有健康数据且维度开启时应输出', () => {
      const out = renderMarkdownReport(
        makeReport({
          dimensions: {
            size: false,
            health: true,
            license: false,
            security: false,
            optimize: false,
          },
          health: [makeHealth({ name: 'react', healthScore: 90 })],
        }),
      )
      expect(out).toContain('## 健康度')
      expect(out).toContain('react')
    })

    it('deprecated 包应在废弃列显示 Y', () => {
      const out = renderMarkdownReport(
        makeReport({
          dimensions: {
            size: false,
            health: true,
            license: false,
            security: false,
            optimize: false,
          },
          health: [
            makeHealth({ name: 'moment', deprecated: true, healthScore: 0 }),
          ],
        }),
      )
      expect(out).toContain('moment')
      // deprecated 列应显示 Y
      expect(out).toMatch(/\|.*Y.*\|/)
    })
  })

  // -----------------------------------------------------------------
  // 许可证
  // -----------------------------------------------------------------

  describe('许可证 section', () => {
    it('只有非 low 风险时才输出', () => {
      const out = renderMarkdownReport(
        makeReport({
          dimensions: {
            size: false,
            health: false,
            license: true,
            security: false,
            optimize: false,
          },
          licenses: [
            makeLicense({ name: 'react', risk: 'low' }),
            makeLicense({ name: 'gpl-pkg', risk: 'high', license: 'GPL-3.0' }),
          ],
        }),
      )
      expect(out).toContain('## 许可证风险')
      expect(out).not.toMatch(/\| react \|/) // low 风险不显示
      expect(out).toContain('gpl-pkg')
      expect(out).toContain('GPL-3.0')
    })

    it('全部 low 风险时不应输出 section', () => {
      const out = renderMarkdownReport(
        makeReport({
          dimensions: {
            size: false,
            health: false,
            license: true,
            security: false,
            optimize: false,
          },
          licenses: [makeLicense({ risk: 'low' })],
        }),
      )
      expect(out).not.toContain('## 许可证风险')
    })

    it('needsHumanReview 包应显示警告标记', () => {
      const out = renderMarkdownReport(
        makeReport({
          dimensions: {
            size: false,
            health: false,
            license: true,
            security: false,
            optimize: false,
          },
          licenses: [
            makeLicense({
              name: 'gsap',
              risk: 'medium',
              license: 'Custom',
              needsHumanReview: true,
              humanReviewReason: '非标准商业授权',
            }),
          ],
        }),
      )
      expect(out).toContain('gsap')
      expect(out).toContain('需审核')
    })
  })

  // -----------------------------------------------------------------
  // 安全漏洞
  // -----------------------------------------------------------------

  describe('安全漏洞 section', () => {
    it('有漏洞时应输出表格，包含 direct/transitive 和 scope', () => {
      const out = renderMarkdownReport(
        makeReport({
          dimensions: {
            size: false,
            health: false,
            license: false,
            security: true,
            optimize: false,
          },
          security: [
            makeSecurity({
              name: 'axios',
              isDirect: true,
              scope: 'prod',
              totalVulnerabilities: 1,
              highestSeverity: 'high',
              vulnerabilities: [
                {
                  severity: 'high',
                  title: 'CSRF',
                  url: '',
                  fixAvailable: true,
                },
              ],
            }),
            makeSecurity({
              name: 'semver',
              isDirect: false,
              scope: 'prod',
              totalVulnerabilities: 1,
              highestSeverity: 'moderate',
              vulnerabilities: [
                {
                  severity: 'moderate',
                  title: 'ReDoS',
                  url: '',
                  fixAvailable: false,
                },
              ],
            }),
          ],
        }),
      )
      expect(out).toContain('## 安全漏洞')
      expect(out).toContain('axios')
      expect(out).toContain('direct')
      expect(out).toContain('prod')
      expect(out).toContain('semver')
      expect(out).toContain('transitive')
      expect(out).toContain('[可修复]')
      expect(out).toContain('[暂无修复]')
    })

    it('无漏洞时不应输出 section', () => {
      const out = renderMarkdownReport(
        makeReport({
          dimensions: {
            size: false,
            health: false,
            license: false,
            security: true,
            optimize: false,
          },
          security: [makeSecurity({ totalVulnerabilities: 0 })],
        }),
      )
      expect(out).not.toContain('## 安全漏洞')
    })
  })

  // -----------------------------------------------------------------
  // 优化建议
  // -----------------------------------------------------------------

  describe('优化建议 section', () => {
    it('有建议时应按优先级排序输出', () => {
      const out = renderMarkdownReport(
        makeReport({
          dimensions: {
            size: false,
            health: false,
            license: false,
            security: false,
            optimize: true,
          },
          optimizations: [
            makeOpt({
              packageName: 'low-pkg',
              priority: 'low',
              description: '低优先级',
            }),
            makeOpt({
              packageName: 'high-pkg',
              priority: 'high',
              description: '高优先级',
            }),
          ],
        }),
      )
      expect(out).toContain('## 优化建议')
      // high 应排在 low 前面
      const highIdx = out.indexOf('high-pkg')
      const lowIdx = out.indexOf('low-pkg')
      expect(highIdx).toBeLessThan(lowIdx)
    })

    it('deprecated 建议应显示置信度和证据', () => {
      const out = renderMarkdownReport(
        makeReport({
          dimensions: {
            size: false,
            health: false,
            license: false,
            security: false,
            optimize: true,
          },
          optimizations: [
            makeOpt({
              packageName: 'react-mentions',
              type: 'deprecated',
              priority: 'high',
              confidence: 'high',
              actionability: 'ready',
              description: 'react-mentions 已废弃',
              evidence: [
                {
                  source: 'reachability',
                  file: 'src/components/Remix/index.tsx',
                  line: 2,
                  detail: '单点使用',
                },
              ],
              suggestedSteps: ['评估替代方案', '移除依赖'],
            }),
          ],
        }),
      )
      expect(out).toContain('react-mentions')
      expect(out).toContain('[high]') // confidence badge
      expect(out).toContain('[ready]') // actionability badge
      expect(out).toContain('证据:')
      expect(out).toContain('src/components/Remix/index.tsx')
      expect(out).toContain('操作步骤:')
    })

    it('needs-review 建议应显示前提条件', () => {
      const out = renderMarkdownReport(
        makeReport({
          dimensions: {
            size: false,
            health: false,
            license: false,
            security: false,
            optimize: true,
          },
          optimizations: [
            makeOpt({
              packageName: 'uuid',
              type: 'replace',
              priority: 'medium',
              confidence: 'medium',
              actionability: 'needs-review',
              description: 'uuid 可替换为 crypto.randomUUID()',
              preconditions: [
                '需要确认 browserslist 支持 crypto.randomUUID()',
                '仅使用 v4() 时可替换',
              ],
            }),
          ],
        }),
      )
      expect(out).toContain('uuid')
      expect(out).toContain('[medium]') // confidence
      expect(out).toContain('[needs-review]') // actionability
      expect(out).toContain('前提:')
      expect(out).toContain('browserslist')
    })

    it('应显示节省体积信息', () => {
      const out = renderMarkdownReport(
        makeReport({
          dimensions: {
            size: false,
            health: false,
            license: false,
            security: false,
            optimize: true,
          },
          optimizations: [
            makeOpt({
              packageName: 'moment',
              type: 'replace',
              priority: 'high',
              alternative: 'dayjs',
              difficulty: 'low',
              estimatedSavings: 65000,
              estimatedSavingsPercent: 97,
            }),
          ],
        }),
      )
      expect(out).toContain('moment')
      expect(out).toContain('dayjs')
      expect(out).toContain('63.48 KB') // 65000 bytes formatted
    })
  })

  // -----------------------------------------------------------------
  // 概览中的安全统计
  // -----------------------------------------------------------------

  describe('概览安全统计', () => {
    it('有漏洞时概览应显示安全漏洞统计', () => {
      const out = renderMarkdownReport(
        makeReport({
          summary: {
            totalDependencies: 10,
            totalSize: 100000,
            totalGzip: 30000,
            maxDepth: 3,
            vulnerabilities: { critical: 2, high: 3, moderate: 5, low: 1 },
            licenseIssues: 0,
            optimizationCount: 0,
            deprecatedCount: 0,
          },
        }),
      )
      expect(out).toContain('安全漏洞')
      expect(out).toContain('critical=2')
      expect(out).toContain('high=3')
    })

    it('deprecatedCount > 0 时概览应显示', () => {
      const out = renderMarkdownReport(
        makeReport({
          summary: {
            totalDependencies: 10,
            totalSize: 100000,
            totalGzip: 30000,
            maxDepth: 3,
            vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 },
            licenseIssues: 0,
            optimizationCount: 0,
            deprecatedCount: 3,
          },
        }),
      )
      expect(out).toContain('已废弃')
      expect(out).toContain('3')
    })
  })
})
