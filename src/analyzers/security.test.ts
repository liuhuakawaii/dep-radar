import { describe, expect, it, vi } from 'vitest'

import {
  analyzeSecurity,
  parseAuditOutput,
  type AuditExecutor,
} from './security.js'

// =====================================================================
// 工具
// =====================================================================

function makeExecutor(
  impl?: (
    cmd: string,
    args: string[],
    cwd: string,
  ) => Promise<{ stdout: string; stderr: string }>,
): AuditExecutor {
  return {
    execute: vi.fn(impl ?? (async () => ({ stdout: '{}', stderr: '' }))),
  }
}

function makeNpmAuditData(
  vulns: Record<
    string,
    { severity: string; title?: string; url?: string; fixAvailable?: boolean }
  > = {},
) {
  return JSON.stringify({ vulnerabilities: vulns })
}

function makePnpmAuditDataOld(
  advisories: Record<
    string,
    {
      module_name: string
      severity: string
      title?: string
      url?: string
      patched_versions?: string
    }
  > = {},
) {
  return JSON.stringify({ advisories })
}

function makePnpmAuditDataNew(
  vulns: Array<{
    name: string
    severity: string
    title?: string
    url?: string
    fixAvailable?: boolean
  }> = [],
) {
  return JSON.stringify({ vulnerabilities: vulns })
}

function makeYarnAuditData(
  vulns: Record<
    string,
    { severity: string; title?: string; url?: string; fixAvailable?: boolean }
  > = {},
) {
  return JSON.stringify({ vulnerabilities: vulns })
}

// =====================================================================
// parseAuditOutput
// =====================================================================

describe('parseAuditOutput', () => {
  describe('npm', () => {
    it('应解析标准 npm audit 输出', () => {
      const stdout = makeNpmAuditData({
        lodash: {
          severity: 'high',
          title: 'Prototype Pollution',
          url: 'https://nvd.nist.gov/...',
          fixAvailable: true,
        },
        minimist: {
          severity: 'critical',
          title: 'Prototype Pollution',
          fixAvailable: false,
        },
      })
      const result = parseAuditOutput(stdout, 'npm')
      expect(result).toHaveLength(2)

      const lodash = result.find(e => e.name === 'lodash')!
      expect(lodash.vulnerabilities).toHaveLength(1)
      expect(lodash.vulnerabilities[0]).toMatchObject({
        severity: 'high',
        title: 'Prototype Pollution',
        fixAvailable: true,
      })

      const minimist = result.find(e => e.name === 'minimist')!
      expect(minimist.vulnerabilities[0]!.severity).toBe('critical')
      expect(minimist.vulnerabilities[0]!.fixAvailable).toBe(false)
    })

    it('空 vulnerabilities 应返回空数组', () => {
      expect(parseAuditOutput(makeNpmAuditData(), 'npm')).toEqual([])
    })

    it('fixAvailable 为对象时应映射为 true', () => {
      const stdout = JSON.stringify({
        vulnerabilities: {
          lodash: {
            severity: 'high',
            fixAvailable: { name: 'lodash', version: '4.17.21' },
          },
        },
      })
      const result = parseAuditOutput(stdout, 'npm')
      expect(result[0]!.vulnerabilities[0]!.fixAvailable).toBe(true)
    })
  })

  describe('pnpm', () => {
    it('应解析旧格式（advisories）', () => {
      const stdout = makePnpmAuditDataOld({
        '12345': {
          module_name: 'axios',
          severity: 'moderate',
          title: 'SSRF',
          patched_versions: '>=0.21.1',
        },
      })
      const result = parseAuditOutput(stdout, 'pnpm')
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        name: 'axios',
        vulnerabilities: [
          { severity: 'moderate', title: 'SSRF', fixAvailable: true },
        ],
      })
    })

    it('应解析新格式（vulnerabilities 数组，pnpm >= 9）', () => {
      const stdout = makePnpmAuditDataNew([
        {
          name: 'lodash',
          severity: 'high',
          title: 'Prototype Pollution',
          fixAvailable: true,
        },
        {
          name: 'lodash',
          severity: 'moderate',
          title: 'ReDoS',
          fixAvailable: false,
        },
      ])
      const result = parseAuditOutput(stdout, 'pnpm')
      expect(result).toHaveLength(1)
      expect(result[0]!.name).toBe('lodash')
      expect(result[0]!.vulnerabilities).toHaveLength(2)
      expect(result[0]!.vulnerabilities[0]!.severity).toBe('high')
      expect(result[0]!.vulnerabilities[1]!.severity).toBe('moderate')
    })

    it('空 advisories 应返回空数组', () => {
      expect(parseAuditOutput(makePnpmAuditDataOld(), 'pnpm')).toEqual([])
    })
  })

  describe('yarn', () => {
    it('应解析 yarn audit 输出', () => {
      const stdout = makeYarnAuditData({
        express: {
          severity: 'low',
          title: 'Open Redirect',
          fixAvailable: true,
        },
      })
      const result = parseAuditOutput(stdout, 'yarn')
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        name: 'express',
        vulnerabilities: [
          { severity: 'low', title: 'Open Redirect', fixAvailable: true },
        ],
      })
    })

    it('空 vulnerabilities 应返回空数组', () => {
      expect(parseAuditOutput(makeYarnAuditData(), 'yarn')).toEqual([])
    })

    it('应解析 Yarn Classic NDJSON audit 输出', () => {
      const stdout = [
        JSON.stringify({
          type: 'auditAdvisory',
          data: {
            resolution: {
              id: 1,
              path: 'express>qs',
              dev: false,
              optional: false,
              bundled: false,
            },
            advisory: {
              module_name: 'qs',
              severity: 'high',
              title: 'Prototype Pollution',
              url: 'https://npmjs.com/advisories/1234',
              patched_versions: '>=6.5.3',
            },
          },
        }),
        JSON.stringify({
          type: 'auditAdvisory',
          data: {
            resolution: {
              id: 2,
              path: 'express>qs',
              dev: false,
              optional: false,
              bundled: false,
            },
            advisory: {
              module_name: 'qs',
              severity: 'moderate',
              title: 'ReDoS',
              url: 'https://npmjs.com/advisories/5678',
              patched_versions: '>=6.5.4',
            },
          },
        }),
        JSON.stringify({
          type: 'auditAdvisory',
          data: {
            resolution: {
              id: 3,
              path: 'express>lodash',
              dev: false,
              optional: false,
              bundled: false,
            },
            advisory: {
              module_name: 'lodash',
              severity: 'critical',
              title: 'Prototype Pollution',
              url: 'https://npmjs.com/advisories/9999',
            },
          },
        }),
        JSON.stringify({
          type: 'auditSummary',
          data: {
            vulnerabilities: {
              info: 0,
              low: 0,
              moderate: 1,
              high: 1,
              critical: 1,
            },
            dependencies: 100,
            devDependencies: 50,
            optionalDependencies: 10,
            totalDependencies: 160,
          },
        }),
      ].join('\n')

      const result = parseAuditOutput(stdout, 'yarn')
      expect(result).toHaveLength(2)

      const qs = result.find(e => e.name === 'qs')!
      expect(qs.vulnerabilities).toHaveLength(2)
      expect(qs.vulnerabilities[0]!.severity).toBe('high')
      expect(qs.vulnerabilities[1]!.severity).toBe('moderate')

      const lodash = result.find(e => e.name === 'lodash')!
      expect(lodash.vulnerabilities).toHaveLength(1)
      expect(lodash.vulnerabilities[0]!.severity).toBe('critical')
      expect(lodash.vulnerabilities[0]!.fixAvailable).toBe(false) // 无 patched_versions
    })
  })

  it('未知严重度应降级为 low', () => {
    const stdout = JSON.stringify({
      vulnerabilities: {
        pkg: { severity: 'unknown-level' },
      },
    })
    const result = parseAuditOutput(stdout, 'npm')
    expect(result[0]!.vulnerabilities[0]!.severity).toBe('low')
  })

  it('缺失 title 时应使用默认文案', () => {
    const stdout = JSON.stringify({
      vulnerabilities: {
        lodash: { severity: 'high' },
      },
    })
    const result = parseAuditOutput(stdout, 'npm')
    expect(result[0]!.vulnerabilities[0]!.title).toBe('lodash 安全漏洞')
  })

  it('非法 JSON 应抛出 SyntaxError', () => {
    expect(() => parseAuditOutput('not json', 'npm')).toThrow(SyntaxError)
  })
})

// =====================================================================
// analyzeSecurity — 集成
// =====================================================================

describe('analyzeSecurity', () => {
  const auditCmd = { cmd: 'npm', args: ['audit', '--json'] }

  it('happy path：有漏洞时应正确返回 SecurityInfo', async () => {
    const stdout = makeNpmAuditData({
      lodash: {
        severity: 'high',
        title: 'Prototype Pollution',
        url: 'https://nvd.nist.gov/',
        fixAvailable: true,
      },
    })
    const executor = makeExecutor(async () => ({ stdout, stderr: '' }))

    const result = await analyzeSecurity(auditCmd, 'npm', '/project', executor)
    expect(result.security).toHaveLength(1)
    expect(result.security[0]).toMatchObject({
      name: 'lodash',
      totalVulnerabilities: 1,
      highestSeverity: 'high',
    })
    expect(result.summary).toEqual({
      critical: 0,
      high: 1,
      moderate: 0,
      low: 0,
    })
    expect(result.skipped).toHaveLength(0)
  })

  it('无漏洞（空输出）应返回空结果', async () => {
    const executor = makeExecutor(async () => ({
      stdout: makeNpmAuditData(),
      stderr: '',
    }))

    const result = await analyzeSecurity(auditCmd, 'npm', '/project', executor)
    expect(result.security).toHaveLength(0)
    expect(result.summary).toEqual({
      critical: 0,
      high: 0,
      moderate: 0,
      low: 0,
    })
  })

  it('audit 命令非零退出但 stdout 合法时应仍解析成功', async () => {
    const stdout = makeNpmAuditData({
      lodash: { severity: 'critical', title: 'Vuln' },
    })
    const executor = makeExecutor(async () => {
      const err = new Error('exit code 1') as Error & { stdout: string }
      err.stdout = stdout
      throw err
    })

    const result = await analyzeSecurity(auditCmd, 'npm', '/project', executor)
    expect(result.security).toHaveLength(1)
    expect(result.security[0]!.highestSeverity).toBe('critical')
  })

  it('audit 命令失败且无 stdout 时应加入 skipped', async () => {
    const executor = makeExecutor(async () => {
      throw new Error('command not found')
    })

    const result = await analyzeSecurity(auditCmd, 'npm', '/project', executor)
    expect(result.security).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]!.reason).toMatch(/command not found/)
  })

  it('audit 输出非法 JSON 时应加入 skipped', async () => {
    const executor = makeExecutor(async () => ({
      stdout: 'not json at all',
      stderr: '',
    }))

    const result = await analyzeSecurity(auditCmd, 'npm', '/project', executor)
    expect(result.security).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]!.reason).toMatch(/解析失败/)
  })

  it('ignore 模式应过滤匹配包', async () => {
    const stdout = makeNpmAuditData({
      lodash: { severity: 'high', title: 'Vuln' },
      '@internal/pkg': { severity: 'critical', title: 'Internal Vuln' },
    })
    const executor = makeExecutor(async () => ({ stdout, stderr: '' }))

    const result = await analyzeSecurity(
      auditCmd,
      'npm',
      '/project',
      executor,
      {
        ignore: ['@internal/*'],
      },
    )
    expect(result.security).toHaveLength(1)
    expect(result.security[0]!.name).toBe('lodash')
    expect(result.summary).toEqual({
      critical: 0,
      high: 1,
      moderate: 0,
      low: 0,
    })
  })

  it('多个漏洞应正确汇总 summary', async () => {
    const stdout = makeNpmAuditData({
      a: { severity: 'critical', title: 'A' },
      b: { severity: 'high', title: 'B' },
      c: { severity: 'moderate', title: 'C' },
      d: { severity: 'low', title: 'D' },
    })
    const executor = makeExecutor(async () => ({ stdout, stderr: '' }))

    const result = await analyzeSecurity(auditCmd, 'npm', '/project', executor)
    expect(result.summary).toEqual({
      critical: 1,
      high: 1,
      moderate: 1,
      low: 1,
    })
  })

  it('highestSeverity 应取该包所有漏洞中最高者', async () => {
    // pnpm 新格式：同名包多个漏洞
    const stdout = makePnpmAuditDataNew([
      { name: 'lodash', severity: 'moderate', title: 'ReDoS' },
      { name: 'lodash', severity: 'high', title: 'Prototype Pollution' },
    ])
    const executor = makeExecutor(async () => ({ stdout, stderr: '' }))
    const pnpmCmd = { cmd: 'pnpm', args: ['audit', '--json'] }

    const result = await analyzeSecurity(pnpmCmd, 'pnpm', '/project', executor)
    expect(result.security).toHaveLength(1)
    expect(result.security[0]!.highestSeverity).toBe('high')
    expect(result.security[0]!.totalVulnerabilities).toBe(2)
  })

  it('应正确传参给 executor', async () => {
    const executor = makeExecutor(async () => ({
      stdout: makeNpmAuditData(),
      stderr: '',
    }))
    const customCmd = { cmd: 'pnpm', args: ['audit', '--json'] }

    await analyzeSecurity(customCmd, 'pnpm', '/my/project', executor)
    expect(executor.execute).toHaveBeenCalledWith(
      'pnpm',
      ['audit', '--json'],
      '/my/project',
    )
  })
})
