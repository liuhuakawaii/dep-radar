import { describe, expect, it } from 'vitest'

import type { AnalysisReport } from '../types/analysis.js'

import { escapeHtml, renderHtmlReport } from './html.js'

function emptyReport(over: Partial<AnalysisReport> = {}): AnalysisReport {
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
    ...over,
  }
}

describe('escapeHtml', () => {
  it.each([
    ['<script>', '&lt;script&gt;'],
    ['a & b', 'a &amp; b'],
    ['"quote"', '&quot;quote&quot;'],
    ["'apos'", '&#39;apos&#39;'],
    [undefined, ''],
    [null, ''],
    [123, '123'],
  ])('%j → %j', (input, expected) => {
    expect(escapeHtml(input as string | number | null | undefined)).toBe(
      expected,
    )
  })
})

describe('renderHtmlReport', () => {
  it('应产出合法 HTML5 文档（含 doctype 与 lang）', () => {
    const html = renderHtmlReport(emptyReport())
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<html lang="zh-CN">')
    expect(html).toContain('<meta charset="utf-8">')
  })

  it('title 应包含项目名', () => {
    const html = renderHtmlReport(emptyReport({ project: 'my-app' }))
    expect(html).toContain('<title>dep-radar 报告 - my-app</title>')
  })

  it('应内联 CSS（含 :root 变量），不引用外部 css', () => {
    const html = renderHtmlReport(emptyReport())
    expect(html).toContain('<style>')
    expect(html).toContain(':root')
    expect(html).not.toMatch(/<link[^>]+rel=["']?stylesheet/i)
  })

  it('XSS 防护：项目名应被转义', () => {
    const html = renderHtmlReport(
      emptyReport({ project: '<script>alert(1)</script>' }),
    )
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('全维度开启 + 数据为空时各 section 应有友好提示', () => {
    const html = renderHtmlReport(emptyReport())
    expect(html).toContain('包体积')
    expect(html).toContain('优化建议')
    expect(html).toContain('依赖健康度')
    expect(html).toContain('许可证合规')
    expect(html).toContain('安全审计')
  })

  it('维度关闭时对应 section 不应出现', () => {
    const html = renderHtmlReport(
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
    expect(html).toContain('包体积')
    expect(html).not.toContain('优化建议')
    expect(html).not.toContain('依赖健康度')
    expect(html).not.toContain('许可证合规')
    expect(html).not.toContain('安全审计')
  })

  it('bundle 数据应渲染为表格 + 进度条', () => {
    const html = renderHtmlReport(
      emptyReport({
        bundles: [
          {
            name: 'react',
            version: '18.3.1',
            size: 10_000,
            gzip: 3_000,
            dependencyCount: 0,
            hasJSModule: true,
            hasJSNext: false,
            source: 'pkg-size',
            isDirect: true,
          },
        ],
      }),
    )
    expect(html).toContain('react')
    expect(html).toContain('18.3.1')
    expect(html).toContain('class="bar"')
    expect(html).toContain('pkg-size')
  })

  it('优化建议应按 priority 着色 + 显示节省量', () => {
    const html = renderHtmlReport(
      emptyReport({
        optimizations: [
          {
            packageName: 'moment',
            type: 'replace',
            priority: 'high',
            description: '体积大',
            alternative: 'dayjs',
            estimatedSavings: 67_000,
            estimatedSavingsPercent: 97,
            difficulty: 'low',
            breakingChange: false,
            migrationGuide: 'https://day.js.org',
            caveats: ['时区处理略有差异'],
          },
        ],
      }),
    )
    expect(html).toContain('class="suggestion high"')
    expect(html).toContain('dayjs')
    expect(html).toContain('节省')
    expect(html).toContain('时区处理略有差异')
    expect(html).toContain('https://day.js.org')
  })

  it('health 数据应根据健康度分色（高分 green）', () => {
    const html = renderHtmlReport(
      emptyReport({
        health: [
          {
            name: 'react',
            weeklyDownloads: 1_000_000,
            downloadTrend: 'up',
            lastPublish: '2026-05-01T00:00:00Z',
            maintainers: 10,
            openIssues: 0,
            deprecated: false,
            hasTypeScriptTypes: true,
            healthScore: 95,
            isDirect: true,
          },
        ],
      }),
    )
    expect(html).toContain('class="badge green">95<')
  })

  it('license 全 low risk → 显示"全部低风险"', () => {
    const html = renderHtmlReport(
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
    expect(html).toContain('全部 1 个依赖')
  })

  it('license 含 high → 显示风险表', () => {
    const html = renderHtmlReport(
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
    expect(html).toContain('GPL-3.0')
    expect(html).toContain('GPL 可能要求开源')
    expect(html).toContain('badge red">high<')
  })

  it('XSS 防护：bundle 名/license/optimization 中的 < > 都应被转义', () => {
    const html = renderHtmlReport(
      emptyReport({
        bundles: [
          {
            name: '<bad>',
            version: '<v>',
            size: 0,
            gzip: 0,
            dependencyCount: 0,
            hasJSModule: false,
            hasJSNext: false,
            source: 'pkg-size',
            isDirect: true,
          },
        ],
      }),
    )
    expect(html).not.toContain('<bad>')
    expect(html).toContain('&lt;bad&gt;')
  })
})
