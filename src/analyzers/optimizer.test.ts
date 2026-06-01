import { describe, expect, it } from 'vitest'

import type {
  BundleInfo,
  HealthInfo,
  LicenseInfo,
  SecurityInfo,
} from '../types/analysis.js'

import { generateOptimizations, type OptimizerInput } from './optimizer.js'

// =====================================================================
// 工厂
// =====================================================================

function bundle(over: Partial<BundleInfo> = {}): BundleInfo {
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

function health(over: Partial<HealthInfo> = {}): HealthInfo {
  return {
    name: 'pkg',
    weeklyDownloads: 100,
    downloadTrend: 'stable',
    lastPublish: new Date().toISOString(),
    maintainers: 1,
    openIssues: 0,
    deprecated: false,
    hasTypeScriptTypes: false,
    healthScore: 50,
    ...over,
  }
}

function license(over: Partial<LicenseInfo> = {}): LicenseInfo {
  return {
    name: 'pkg',
    license: 'MIT',
    licenseType: 'permissive',
    risk: 'low',
    ...over,
  }
}

function security(over: Partial<SecurityInfo> = {}): SecurityInfo {
  return {
    name: 'pkg',
    vulnerabilities: [],
    totalVulnerabilities: 0,
    highestSeverity: 'none',
    ...over,
  }
}

function input(over: Partial<OptimizerInput> = {}): OptimizerInput {
  return {
    bundles: [],
    health: [],
    licenses: [],
    security: [],
    ...over,
  }
}

// =====================================================================
// 规则覆盖
// =====================================================================

describe('generateOptimizations', () => {
  it('空输入 → 空数组', () => {
    expect(generateOptimizations(input())).toEqual([])
  })

  // ----- 规则 1: deprecated -----
  it('deprecated 包 → 高优先级 deprecated 建议', () => {
    const out = generateOptimizations(
      input({
        health: [
          health({
            name: 'request',
            deprecated: true,
            deprecatedMessage: 'request 已废弃',
          }),
        ],
        bundles: [bundle({ name: 'request', gzip: 10000 })],
      }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe('deprecated')
    expect(out[0]!.priority).toBe('high')
    expect(out[0]!.description).toContain('已废弃')
    // request 在内置 REPLACEMENTS 中，应自动拉入替代信息
    expect(out[0]!.alternative).toMatch(/ofetch|undici|fetch/)
  })

  // ----- 规则 2: replacement -----
  it('moment 命中内置 REPLACEMENTS → replace 建议', () => {
    const out = generateOptimizations(
      input({
        bundles: [bundle({ name: 'moment', gzip: 70_000 })],
      }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe('replace')
    expect(out[0]!.alternative).toBe('dayjs')
    // moment 70KB * 97% ≈ 67900
    expect(out[0]!.estimatedSavings).toBeGreaterThan(60_000)
    expect(out[0]!.priority).toBe('high') // 节省 >=80% 且体积 > 10KB
  })

  it('lodash 体积中等 → medium 优先级（节省 90% 但体积小）', () => {
    const out = generateOptimizations(
      input({
        bundles: [bundle({ name: 'lodash', gzip: 5_000 })], // < 10KB
      }),
    )
    expect(out[0]!.priority).toBe('medium')
  })

  // ----- 规则 3: 体积大户 -----
  it('未在 REPLACEMENTS 中、gzip > 50KB → 体积大户 replace 建议', () => {
    const out = generateOptimizations(
      input({
        bundles: [bundle({ name: 'big-lib', gzip: 200_000 })],
      }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe('replace')
    expect(out[0]!.description).toContain('阈值')
    expect(out[0]!.alternative).toBeUndefined()
    expect(out[0]!.priority).toBe('high') // > 100KB
  })

  it('gzip <= 50KB 不应触发体积大户规则', () => {
    const out = generateOptimizations(
      input({
        bundles: [bundle({ name: 'small', gzip: 20_000 })],
      }),
    )
    expect(out).toHaveLength(0)
  })

  // ----- 规则 4: healthScore 低 -----
  it('healthScore < 30 → replace 建议', () => {
    const out = generateOptimizations(
      input({
        health: [
          health({
            name: 'bad-lib',
            healthScore: 15,
            weeklyDownloads: 100,
          }),
        ],
      }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.description).toContain('健康度仅 15')
    expect(out[0]!.description).toContain('下载量低')
  })

  it('deprecated 包不应被规则 4 重复触发（已被规则 1 处理）', () => {
    const out = generateOptimizations(
      input({
        health: [
          health({
            name: 'p',
            deprecated: true,
            healthScore: 0,
          }),
        ],
      }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe('deprecated')
  })

  // ----- 规则 5: license 高风险 -----
  it('license risk=high → replace 建议', () => {
    const out = generateOptimizations(
      input({
        licenses: [
          license({
            name: 'gpl-lib',
            license: 'GPL-3.0',
            licenseType: 'strong-copyleft',
            risk: 'high',
            conflict: 'GPL 风险',
          }),
        ],
      }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.priority).toBe('high')
    expect(out[0]!.description).toContain('GPL-3.0')
  })

  // ----- 规则 6: 高危漏洞且无修复 -----
  it('high 级别漏洞且 fixAvailable=false → replace 建议', () => {
    const out = generateOptimizations(
      input({
        security: [
          security({
            name: 'vuln',
            totalVulnerabilities: 2,
            highestSeverity: 'high',
            vulnerabilities: [
              {
                severity: 'high',
                title: 'XSS',
                url: '',
                fixAvailable: false,
              },
              {
                severity: 'high',
                title: 'Prototype Pollution',
                url: '',
                fixAvailable: false,
              },
            ],
          }),
        ],
      }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.priority).toBe('high')
    expect(out[0]!.description).toContain('漏洞')
  })

  it('high 漏洞但有 fix → 不触发（应靠 upgrade 解决）', () => {
    const out = generateOptimizations(
      input({
        security: [
          security({
            name: 'fixable',
            totalVulnerabilities: 1,
            highestSeverity: 'high',
            vulnerabilities: [
              { severity: 'high', title: 'X', url: '', fixAvailable: true },
            ],
          }),
        ],
      }),
    )
    expect(out).toHaveLength(0)
  })

  it('moderate 漏洞不触发（仅 high/critical 走 replace）', () => {
    const out = generateOptimizations(
      input({
        security: [
          security({
            name: 'p',
            totalVulnerabilities: 1,
            highestSeverity: 'moderate',
            vulnerabilities: [
              {
                severity: 'moderate',
                title: 'X',
                url: '',
                fixAvailable: false,
              },
            ],
          }),
        ],
      }),
    )
    expect(out).toHaveLength(0)
  })

  // ----- 多规则同包合并 -----
  it('同一包被多规则命中应合并为一条（deprecated > replace）', () => {
    const out = generateOptimizations(
      input({
        bundles: [bundle({ name: 'request', gzip: 100_000 })],
        health: [
          health({
            name: 'request',
            deprecated: true,
            deprecatedMessage: '已废弃',
            healthScore: 0,
          }),
        ],
        licenses: [
          license({ name: 'request', license: 'GPL-3.0', risk: 'high' }),
        ],
      }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe('deprecated') // deprecated 胜出
    // description 合并（含其他规则信息）
    expect(out[0]!.description).toMatch(/已废弃/)
  })

  // ----- 用户自定义 replacement -----
  it('用户自定义 replacement 应覆盖内置规则', () => {
    const out = generateOptimizations(
      input({
        bundles: [bundle({ name: 'moment', gzip: 70_000 })],
        userReplacements: {
          moment: {
            alternative: 'my-time',
            altPackage: 'my-time',
            estimatedSavingsPercent: 50,
            difficulty: 'low',
            breakingChange: false,
            description: '内部时间库',
          },
        },
      }),
    )
    expect(out[0]!.alternative).toBe('my-time')
  })

  // ----- 排序 -----
  it('排序：priority 优先，相同优先级按 estimatedSavings 降序', () => {
    // moment 70KB: high + savings≈67900 → score 70900
    // lodash 5KB:  medium + savings=4500  → score 6500
    // small 60KB:  medium + savings=0     → score 2000
    const out = generateOptimizations(
      input({
        bundles: [
          bundle({ name: 'small', gzip: 60_000 }),
          bundle({ name: 'moment', gzip: 70_000 }),
          bundle({ name: 'lodash', gzip: 5_000 }),
        ],
      }),
    )
    expect(out.map(o => o.packageName)).toEqual(['moment', 'lodash', 'small'])
  })

  // ----- estimatedSavings 计算 -----
  it('estimatedSavings = bundle.gzip * replacement.percent / 100', () => {
    const out = generateOptimizations(
      input({
        bundles: [bundle({ name: 'classnames', gzip: 500 })],
      }),
    )
    // classnames 60% 节省
    expect(out[0]!.estimatedSavings).toBe(300)
  })

  it('无 bundle 数据时 estimatedSavings = 0', () => {
    const out = generateOptimizations(
      input({
        health: [health({ name: 'moment', healthScore: 60 })], // 健康度足够，不触发规则 4
        bundles: [],
      }),
    )
    // 但 moment 在 REPLACEMENTS 表中，规则 2 会触发，但 isInDeps 需要在某个维度出现
    // 这里 health.name = 'moment' 满足 isInDeps
    expect(out).toHaveLength(1)
    expect(out[0]!.estimatedSavings).toBe(0)
  })
})
