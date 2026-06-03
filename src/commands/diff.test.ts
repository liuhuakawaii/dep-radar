import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AnalysisReport } from '../types/analysis.js'
import { EXIT_CODES } from '../utils/exitCode.js'

import { diffCommand } from './diff.js'

process.env.FORCE_COLOR = '0'

function makeReport(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
  return {
    project: 'test-project',
    timestamp: '2026-06-03T00:00:00Z',
    packageManager: 'npm',
    dimensions: {
      size: true,
      health: true,
      license: true,
      security: true,
      optimize: true,
    },
    summary: {
      totalDependencies: 10,
      totalSize: 300_000,
      totalGzip: 100_000,
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

describe('diffCommand', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dep-radar-diff-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeReports(before: AnalysisReport, after: AnalysisReport) {
    writeFileSync(join(dir, 'before.json'), JSON.stringify(before), 'utf-8')
    writeFileSync(join(dir, 'after.json'), JSON.stringify(after), 'utf-8')
  }

  it('两份相同报告应返回 OK', async () => {
    const report = makeReport()
    writeReports(report, report)
    const code = await diffCommand(
      join(dir, 'before.json'),
      join(dir, 'after.json'),
    )
    expect(code).toBe(EXIT_CODES.OK)
  })

  it('无效 JSON 文件应返回 ERROR', async () => {
    writeFileSync(join(dir, 'before.json'), 'not json', 'utf-8')
    writeFileSync(join(dir, 'after.json'), '{}', 'utf-8')
    const code = await diffCommand(
      join(dir, 'before.json'),
      join(dir, 'after.json'),
    )
    expect(code).toBe(EXIT_CODES.ERROR)
  })

  it('缺少 summary 字段应返回 ERROR', async () => {
    writeFileSync(join(dir, 'before.json'), '{}', 'utf-8')
    writeFileSync(join(dir, 'after.json'), '{}', 'utf-8')
    const code = await diffCommand(
      join(dir, 'before.json'),
      join(dir, 'after.json'),
    )
    expect(code).toBe(EXIT_CODES.ERROR)
  })

  it('新增包应出现在 diff 中', async () => {
    const before = makeReport()
    const after = makeReport({
      bundles: [
        {
          name: 'axios',
          version: '1.0.0',
          size: 50_000,
          gzip: 15_000,
          dependencyCount: 3,
          hasJSModule: true,
          hasJSNext: false,
          source: 'pkg-size',
          isDirect: true,
        },
      ],
    })
    writeReports(before, after)

    const outFile = join(dir, 'out.json')
    await diffCommand(join(dir, 'before.json'), join(dir, 'after.json'), {
      format: 'json',
      output: outFile,
    })

    const { readFileSync } = await import('node:fs')
    const diff = JSON.parse(readFileSync(outFile, 'utf-8'))
    expect(diff.bundles.added).toHaveLength(1)
    expect(diff.bundles.added[0].name).toBe('axios')
  })

  it('体积变化应计算 delta', async () => {
    const bundle = {
      name: 'react',
      version: '18.3.1',
      size: 100_000,
      gzip: 30_000,
      dependencyCount: 5,
      hasJSModule: true,
      hasJSNext: false,
      source: 'pkg-size' as const,
      isDirect: true,
    }
    const before = makeReport({ bundles: [bundle] })
    const after = makeReport({
      bundles: [{ ...bundle, gzip: 35_000, size: 120_000 }],
    })
    writeReports(before, after)

    const outFile = join(dir, 'out.json')
    await diffCommand(join(dir, 'before.json'), join(dir, 'after.json'), {
      format: 'json',
      output: outFile,
    })

    const { readFileSync } = await import('node:fs')
    const diff = JSON.parse(readFileSync(outFile, 'utf-8'))
    expect(diff.bundles.changed).toHaveLength(1)
    expect(diff.bundles.changed[0].delta).toBe(5_000)
  })

  it('新出现的 deprecated 应被标记', async () => {
    const before = makeReport({
      health: [
        {
          name: 'moment',
          weeklyDownloads: 100,
          downloadTrend: 'stable',
          lastPublish: '',
          maintainers: 0,
          openIssues: 0,
          deprecated: false,
          hasTypeScriptTypes: false,
          healthScore: 50,
          isDirect: true,
        },
      ],
    })
    const after = makeReport({
      summary: {
        ...makeReport().summary,
        deprecatedCount: 1,
      },
      health: [
        {
          name: 'moment',
          weeklyDownloads: 100,
          downloadTrend: 'stable',
          lastPublish: '',
          maintainers: 0,
          openIssues: 0,
          deprecated: true,
          deprecatedMessage: '已废弃',
          hasTypeScriptTypes: false,
          healthScore: 0,
          isDirect: true,
        },
      ],
    })
    writeReports(before, after)

    const outFile = join(dir, 'out.json')
    await diffCommand(join(dir, 'before.json'), join(dir, 'after.json'), {
      format: 'json',
      output: outFile,
    })

    const { readFileSync } = await import('node:fs')
    const diff = JSON.parse(readFileSync(outFile, 'utf-8'))
    expect(diff.health.newlyDeprecated).toHaveLength(1)
    expect(diff.health.newlyDeprecated[0].name).toBe('moment')
  })

  it('critical/high 漏洞应返回 HIGH_VULNERABILITY 退出码', async () => {
    const before = makeReport()
    const after = makeReport({
      summary: {
        ...makeReport().summary,
        vulnerabilities: { critical: 1, high: 0, moderate: 0, low: 0 },
      },
    })
    writeReports(before, after)
    const code = await diffCommand(
      join(dir, 'before.json'),
      join(dir, 'after.json'),
    )
    expect(code).toBe(EXIT_CODES.HIGH_VULNERABILITY)
  })

  it('JSON 格式输出应为合法 JSON', async () => {
    const report = makeReport()
    writeReports(report, report)
    const outFile = join(dir, 'out.json')
    await diffCommand(join(dir, 'before.json'), join(dir, 'after.json'), {
      format: 'json',
      output: outFile,
    })
    const { readFileSync } = await import('node:fs')
    const diff = JSON.parse(readFileSync(outFile, 'utf-8'))
    expect(diff.before.project).toBe('test-project')
    expect(diff.after.project).toBe('test-project')
    expect(diff.summary).toBeDefined()
    expect(diff.bundles).toBeDefined()
  })
})
