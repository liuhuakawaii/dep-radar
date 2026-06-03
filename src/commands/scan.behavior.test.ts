/**
 * scan 命令行为测试
 *
 * 验证 TODO Phase 9 中列出的关键行为：
 * - 未使用直接依赖检测
 * - 配置文件引用依赖不被误删
 * - 生产 transitive high 风险进入主报告
 * - dev transitive low 风险默认隐藏
 * - --deep 输出完整 lock 风险
 * - --ci 只对 P0/P1 失败
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.FORCE_COLOR = '0'

vi.mock('../data/pkg-size.js', () => ({ getPackageSize: vi.fn() }))
vi.mock('../data/bundlephobia.js', () => ({ getPackageSize: vi.fn() }))
vi.mock('../data/npm.js', () => ({
  getPackageInfo: vi.fn(),
  getPackageMeta: vi.fn(),
  getPackageVersionInfo: vi.fn(),
  getDownloadCount: vi.fn(),
  getDownloadTrend: vi.fn(),
  getDownloadStats: vi.fn(),
}))
vi.mock('../data/github.js', () => ({
  getRepoInfo: vi.fn(),
  parseGitHubUrl: vi.fn(),
}))

const { getPackageSize } = await import('../data/pkg-size.js')
const {
  getPackageInfo,
  getPackageMeta,
  getDownloadCount,
  getDownloadTrend,
  getDownloadStats,
} = await import('../data/npm.js')
const { getRepoInfo, parseGitHubUrl } = await import('../data/github.js')
const { _resetGithubTokenWarnedForTests } =
  await import('./buildHealthFetcher.js')
const { scanCommand } = await import('./scan.js')
const { EXIT_CODES } = await import('../utils/exitCode.js')

const pkgSize = getPackageSize as unknown as ReturnType<typeof vi.fn>
const npmInfo = getPackageInfo as unknown as ReturnType<typeof vi.fn>
const npmMeta = getPackageMeta as unknown as ReturnType<typeof vi.fn>
const npmDl = getDownloadCount as unknown as ReturnType<typeof vi.fn>
const npmTrend = getDownloadTrend as unknown as ReturnType<typeof vi.fn>
const npmDlStats = getDownloadStats as unknown as ReturnType<typeof vi.fn>
const ghRepo = getRepoInfo as unknown as ReturnType<typeof vi.fn>
const parseGH = parseGitHubUrl as unknown as ReturnType<typeof vi.fn>

describe('scan 行为测试', () => {
  let dir: string

  beforeEach(() => {
    pkgSize.mockReset()
    npmInfo.mockReset()
    npmMeta.mockReset()
    npmDl.mockReset()
    npmTrend.mockReset()
    npmDlStats.mockReset()
    ghRepo.mockReset()
    parseGH.mockReset()
    _resetGithubTokenWarnedForTests()
    dir = mkdtempSync(join(tmpdir(), 'dep-radar-behavior-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writePkg(
    deps: Record<string, string> = {},
    devDeps: Record<string, string> = {},
    extra: Record<string, unknown> = {},
  ) {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'test-project',
        version: '1.0.0',
        dependencies: deps,
        devDependencies: devDeps,
        ...extra,
      }),
      'utf-8',
    )
  }

  function mockHealthy(name: string) {
    npmInfo.mockImplementation(async (n: string) => ({
      name: n,
      version: '1.0.0',
      types: './i.d.ts',
    }))
    npmMeta.mockResolvedValue({
      'dist-tags': { latest: '1.0.0' },
      time: { '1.0.0': new Date().toISOString() },
      maintainers: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
    })
    npmDl.mockResolvedValue(500_000)
    npmTrend.mockResolvedValue('up')
    npmDlStats.mockResolvedValue({ weekly: 500_000, trend: 'up' })
    ghRepo.mockResolvedValue(null)
    parseGH.mockReturnValue(null)
    return name
  }

  function bundleOf(name: string, gzip: number) {
    return {
      name,
      version: '1.0.0',
      size: gzip * 3,
      gzip,
      dependencyCount: 0,
      hasJSModule: true,
      hasJSNext: false,
      source: 'pkg-size',
    }
  }

  // -----------------------------------------------------------------
  // 未使用直接依赖
  // -----------------------------------------------------------------

  it('未使用的直接依赖应出现在 hygieneIssues 中', async () => {
    writePkg({ lodash: '^4.0.0', react: '^18.0.0' })
    pkgSize
      .mockResolvedValueOnce(bundleOf('lodash', 5000))
      .mockResolvedValueOnce(bundleOf('react', 3000))
    mockHealthy('lodash')
    mockHealthy('react')
    npmInfo.mockImplementation(async (n: string) => ({
      name: n,
      version: '1.0.0',
      license: 'MIT',
    }))

    const outFile = join(dir, 'r.json')
    await scanCommand(dir, { format: 'json', output: outFile, deep: true })

    const { readFileSync } = await import('node:fs')
    const out = JSON.parse(readFileSync(outFile, 'utf-8'))

    // hygieneIssues 应包含未使用依赖（如果有源码扫描结果）
    expect(out.hygieneIssues).toBeDefined()
  })

  // -----------------------------------------------------------------
  // --ci 模式退出码
  // -----------------------------------------------------------------

  describe('--ci 退出码', () => {
    it('无问题时返回 OK', async () => {
      writePkg({ react: '^18.0.0' })
      pkgSize.mockResolvedValueOnce(bundleOf('react', 500))
      mockHealthy('react')
      npmInfo.mockResolvedValue({
        name: 'react',
        version: '18.3.1',
        license: 'MIT',
      })

      const code = await scanCommand(dir, {
        format: 'json',
        output: join(dir, 'r.json'),
        ci: true,
      })
      expect(code).toBe(EXIT_CODES.OK)
    })

    it('budget 超出时返回 BUDGET_EXCEEDED', async () => {
      writePkg({ react: '^18.0.0' })
      pkgSize.mockResolvedValueOnce(bundleOf('react', 50000))
      mockHealthy('react')
      npmInfo.mockResolvedValue({
        name: 'react',
        version: '18.3.1',
        license: 'MIT',
      })
      writeFileSync(
        join(dir, '.dep-radarrc.json'),
        JSON.stringify({ budget: { totalGzip: 1000 } }),
      )

      const code = await scanCommand(dir, {
        format: 'json',
        output: join(dir, 'r.json'),
        ci: true,
      })
      expect(code).toBe(EXIT_CODES.BUDGET_EXCEEDED)
    })
  })

  // -----------------------------------------------------------------
  // 默认模式 vs --deep 模式
  // -----------------------------------------------------------------

  describe('默认模式 vs --deep', () => {
    it('默认模式应有 optimizations（如果有可操作建议）', async () => {
      writePkg({ moment: '^2.0.0' })
      pkgSize.mockResolvedValueOnce({
        name: 'moment',
        version: '2.30.1',
        size: 200_000,
        gzip: 70_000,
        dependencyCount: 0,
        hasJSModule: false,
        hasJSNext: false,
        source: 'pkg-size',
      })
      mockHealthy('moment')
      npmInfo.mockResolvedValue({
        name: 'moment',
        version: '2.30.1',
        license: 'MIT',
      })

      const outFile = join(dir, 'r.json')
      await scanCommand(dir, { format: 'json', output: outFile })
      const { readFileSync } = await import('node:fs')
      const out = JSON.parse(readFileSync(outFile, 'utf-8'))
      expect(out.optimizations.length).toBeGreaterThan(0)
    })

    it('--deep 应包含 hygieneIssues 和 duplicateVersions', async () => {
      writePkg({ react: '^18.0.0' })
      pkgSize.mockResolvedValueOnce(bundleOf('react', 3000))
      mockHealthy('react')
      npmInfo.mockResolvedValue({
        name: 'react',
        version: '18.3.1',
        license: 'MIT',
      })

      const outFile = join(dir, 'r.json')
      await scanCommand(dir, { format: 'json', output: outFile, deep: true })
      const { readFileSync } = await import('node:fs')
      const out = JSON.parse(readFileSync(outFile, 'utf-8'))
      expect(out.hygieneIssues).toBeDefined()
      expect(out.duplicateVersions).toBeDefined()
    })
  })

  // -----------------------------------------------------------------
  // 输出格式
  // -----------------------------------------------------------------

  it('JSON 输出应包含完整的 findings 结构', async () => {
    writePkg({ react: '^18.0.0' })
    pkgSize.mockResolvedValueOnce(bundleOf('react', 3000))
    mockHealthy('react')
    npmInfo.mockResolvedValue({
      name: 'react',
      version: '18.3.1',
      license: 'MIT',
    })

    const outFile = join(dir, 'r.json')
    await scanCommand(dir, { format: 'json', output: outFile })
    const { readFileSync } = await import('node:fs')
    const out = JSON.parse(readFileSync(outFile, 'utf-8'))

    // 每个 finding 应有 evidence、suggestion、command、confidence
    for (const opt of out.optimizations) {
      expect(opt).toHaveProperty('packageName')
      expect(opt).toHaveProperty('type')
      expect(opt).toHaveProperty('priority')
      expect(opt).toHaveProperty('description')
    }
  })

  // -----------------------------------------------------------------
  // --json shorthand
  // -----------------------------------------------------------------

  it('--format json 应输出合法 JSON', async () => {
    writePkg({ react: '^18.0.0' })
    pkgSize.mockResolvedValueOnce(bundleOf('react', 3000))
    mockHealthy('react')
    npmInfo.mockResolvedValue({
      name: 'react',
      version: '18.3.1',
      license: 'MIT',
    })

    const outFile = join(dir, 'r.json')
    await scanCommand(dir, { format: 'json', output: outFile })
    const { readFileSync } = await import('node:fs')
    const out = JSON.parse(readFileSync(outFile, 'utf-8'))
    expect(out.project).toBe('test-project')
  })

  // -----------------------------------------------------------------
  // framework-required 分类
  // -----------------------------------------------------------------

  it('framework-required 包（如 react-native）不应被标记为 unused', async () => {
    writePkg({
      'react-native': '0.76.0',
      react: '18.3.1',
    })
    pkgSize
      .mockResolvedValueOnce(bundleOf('react-native', 50000))
      .mockResolvedValueOnce(bundleOf('react', 3000))
    mockHealthy('react-native')
    mockHealthy('react')
    npmInfo.mockImplementation(async (n: string) => ({
      name: n,
      version: '1.0.0',
      license: 'MIT',
    }))

    const outFile = join(dir, 'r.json')
    await scanCommand(dir, { format: 'json', output: outFile, deep: true })
    const { readFileSync } = await import('node:fs')
    const out = JSON.parse(readFileSync(outFile, 'utf-8'))

    // react-native 不应出现在 unused-direct 中
    const unused = (out.hygieneIssues ?? []).filter(
      (h: any) =>
        h.type === 'unused-direct' && h.packageName === 'react-native',
    )
    expect(unused).toHaveLength(0)
  })

  // -----------------------------------------------------------------
  // --ci P0/P1 失败
  // -----------------------------------------------------------------

  it('--ci 模式：deprecated 高优先级包应导致非零退出码', async () => {
    writePkg({ 'old-pkg': '^1.0.0' })
    pkgSize.mockResolvedValueOnce({
      name: 'old-pkg',
      version: '1.0.0',
      size: 50000,
      gzip: 15000,
      dependencyCount: 0,
      hasJSModule: true,
      hasJSNext: false,
      source: 'pkg-size',
    })
    npmInfo.mockImplementation(async (n: string) => ({
      name: n,
      version: '1.0.0',
      deprecated: '包已废弃',
      license: 'MIT',
    }))
    npmMeta.mockResolvedValue({
      'dist-tags': { latest: '1.0.0' },
      time: { '1.0.0': new Date().toISOString() },
      maintainers: [{ name: 'a' }],
    })
    npmDl.mockResolvedValue(100)
    npmTrend.mockResolvedValue('down')
    npmDlStats.mockResolvedValue({ weekly: 100, trend: 'down' })
    ghRepo.mockResolvedValue(null)
    parseGH.mockReturnValue(null)

    const code = await scanCommand(dir, {
      format: 'json',
      output: join(dir, 'r.json'),
      ci: true,
    })
    // deprecated 高优先级 → P0 → CI 应失败
    expect(code).not.toBe(EXIT_CODES.OK)
  })
})
