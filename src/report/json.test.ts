import { describe, expect, it } from 'vitest'

import type { AnalysisReport } from '../types/analysis.js'
import { renderJsonReport } from './json.js'

const sample: AnalysisReport = {
  project: 'demo',
  timestamp: '2026-06-01T10:00:00.000Z',
  packageManager: 'pnpm',
  summary: {
    totalDependencies: 1,
    totalSize: 100,
    totalGzip: 30,
    maxDepth: 1,
    vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 },
    licenseIssues: 0,
    optimizationCount: 0,
    deprecatedCount: 0,
  },
  bundles: [
    {
      name: 'react',
      version: '18.3.1',
      size: 100,
      gzip: 30,
      dependencyCount: 0,
      hasJSModule: true,
      hasJSNext: false,
      source: 'pkg-size',
    },
  ],
  health: [],
  licenses: [],
  security: [],
  optimizations: [],
}

describe('renderJsonReport', () => {
  it('默认 pretty=true 应带缩进', () => {
    const out = renderJsonReport(sample)
    expect(out).toContain('\n')
    expect(out).toContain('  "project"')
  })

  it('pretty=false 应紧凑输出', () => {
    const out = renderJsonReport(sample, false)
    expect(out).not.toContain('\n')
    expect(JSON.parse(out)).toEqual(sample)
  })

  it('输出应为合法 JSON，可双向还原', () => {
    const out = renderJsonReport(sample)
    expect(JSON.parse(out)).toEqual(sample)
  })
})
