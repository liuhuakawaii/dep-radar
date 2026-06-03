import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.FORCE_COLOR = '0'

// mock 数据层
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
  getPackageVersionInfo,
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
const npmVersionInfo = getPackageVersionInfo as unknown as ReturnType<
  typeof vi.fn
>
const npmDl = getDownloadCount as unknown as ReturnType<typeof vi.fn>
const npmTrend = getDownloadTrend as unknown as ReturnType<typeof vi.fn>
const npmDlStats = getDownloadStats as unknown as ReturnType<typeof vi.fn>
const ghRepo = getRepoInfo as unknown as ReturnType<typeof vi.fn>
const parseGH = parseGitHubUrl as unknown as ReturnType<typeof vi.fn>

describe('scanCommand', () => {
  let dir: string

  beforeEach(() => {
    pkgSize.mockReset()
    npmInfo.mockReset()
    npmMeta.mockReset()
    npmVersionInfo.mockReset()
    npmDl.mockReset()
    npmTrend.mockReset()
    npmDlStats.mockReset()
    ghRepo.mockReset()
    parseGH.mockReset()
    _resetGithubTokenWarnedForTests()
    dir = mkdtempSync(join(tmpdir(), 'dep-radar-scan-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writePkg(deps: Record<string, string> = {}) {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: deps }),
      'utf-8',
    )
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

  function mockHealthyReact() {
    parseGH.mockReturnValue({ owner: 'facebook', repo: 'react' })
    npmInfo.mockResolvedValue({
      name: 'react',
      version: '18.3.1',
      types: './index.d.ts',
    })
    npmMeta.mockResolvedValue({
      'dist-tags': { latest: '18.3.1' },
      time: { '18.3.1': new Date().toISOString() },
      maintainers: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
      repository: {
        type: 'git',
        url: 'git+https://github.com/facebook/react.git',
      },
    })
    npmDl.mockResolvedValue(500_000)
    npmTrend.mockResolvedValue('up')
    npmDlStats.mockResolvedValue({ weekly: 500_000, trend: 'up' })
    ghRepo.mockResolvedValue({
      stargazers_count: 200_000,
      open_issues_count: 800,
      pushed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      archived: false,
      license: { spdx_id: 'MIT' },
    })
  }

  // -----------------------------------------------------------------
  // 基础
  // -----------------------------------------------------------------

  it('package.json 不存在时返回 ERROR', async () => {
    const code = await scanCommand(dir)
    expect(code).toBe(EXIT_CODES.ERROR)
  })

  it('默认模式：分析直接依赖，返回 OK，JSON 有 bundles + optimizations', async () => {
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
    mockHealthyReact()
    npmInfo.mockResolvedValue({
      name: 'moment',
      version: '2.30.1',
      license: 'MIT',
    })

    const outFile = join(dir, 'r.json')
    const code = await scanCommand(dir, { format: 'json', output: outFile })
    expect(code).toBe(EXIT_CODES.OK)

    const out = JSON.parse(readFileSync(outFile, 'utf-8'))
    expect(out.project).toBe('demo')
    expect(out.bundles).toHaveLength(1)
    expect(out.optimizations).toHaveLength(1)
    expect(out.optimizations[0].packageName).toBe('moment')
  })

  it('--deep 模式：完整输出，包含 hygieneIssues 和 duplicateVersions', async () => {
    writePkg({ react: '^18.0.0' })
    pkgSize.mockResolvedValueOnce(bundleOf('react', 3000))
    mockHealthyReact()
    npmInfo.mockResolvedValue({
      name: 'react',
      version: '18.3.1',
      license: 'MIT',
    })

    const outFile = join(dir, 'r.json')
    const code = await scanCommand(dir, {
      format: 'json',
      output: outFile,
      deep: true,
    })
    expect(code).toBe(EXIT_CODES.OK)

    const out = JSON.parse(readFileSync(outFile, 'utf-8'))
    expect(out.hygieneIssues).toBeDefined()
    expect(out.duplicateVersions).toBeDefined()
  })

  // -----------------------------------------------------------------
  // --ci 模式
  // -----------------------------------------------------------------

  describe('--ci 模式', () => {
    it('budget 超出时返回 BUDGET_EXCEEDED', async () => {
      writePkg({ react: '^18.0.0' })
      pkgSize.mockResolvedValueOnce(bundleOf('react', 5000))
      mockHealthyReact()
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

    it('无高优先级问题时返回 OK', async () => {
      writePkg({ react: '^18.0.0' })
      pkgSize.mockResolvedValueOnce(bundleOf('react', 500))
      mockHealthyReact()
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
  })

  // -----------------------------------------------------------------
  // 选项
  // -----------------------------------------------------------------

  it('--skip-health 时不调用 health fetcher', async () => {
    writePkg({ react: '^18.0.0' })
    pkgSize.mockResolvedValueOnce(bundleOf('react', 3000))
    npmInfo.mockResolvedValue({
      name: 'react',
      version: '18.3.1',
      license: 'MIT',
    })

    const code = await scanCommand(dir, {
      format: 'json',
      output: join(dir, 'r.json'),
      skipHealth: true,
    })
    expect(code).toBe(EXIT_CODES.OK)
    expect(npmMeta).not.toHaveBeenCalled()
    expect(npmDl).not.toHaveBeenCalled()
    expect(npmTrend).not.toHaveBeenCalled()
  })

  it('ignore 配置应过滤包', async () => {
    writePkg({ '@internal/utils': '^1.0.0', react: '^18.0.0' })
    pkgSize.mockResolvedValueOnce(bundleOf('react', 1000))
    mockHealthyReact()
    npmInfo.mockResolvedValue({
      name: 'react',
      version: '18.3.1',
      license: 'MIT',
    })
    writeFileSync(
      join(dir, '.dep-radarrc.json'),
      JSON.stringify({ ignore: ['@internal/*'] }),
    )

    const outFile = join(dir, 'r.json')
    await scanCommand(dir, { format: 'json', output: outFile })
    const out = JSON.parse(readFileSync(outFile, 'utf-8'))
    expect(out.bundles).toHaveLength(1)
    expect(out.bundles[0].name).toBe('react')
  })

  it('用户自定义 replacements 应被传给 optimizer', async () => {
    writePkg({ 'my-internal': '^1.0.0' })
    pkgSize.mockResolvedValueOnce({
      name: 'my-internal',
      version: '1.0.0',
      size: 100_000,
      gzip: 30_000,
      dependencyCount: 0,
      hasJSModule: true,
      hasJSNext: false,
      source: 'pkg-size',
    })
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
    npmInfo.mockResolvedValue({
      name: 'my-internal',
      version: '1',
      license: 'MIT',
    })

    writeFileSync(
      join(dir, '.dep-radarrc.json'),
      JSON.stringify({
        replacements: {
          'my-internal': {
            alternative: 'my-better-lib',
            altPackage: 'my-better-lib',
            estimatedSavingsPercent: 60,
            difficulty: 'low',
            breakingChange: false,
            description: '内部新版',
          },
        },
      }),
    )

    const outFile = join(dir, 'r.json')
    await scanCommand(dir, { format: 'json', output: outFile })
    const out = JSON.parse(readFileSync(outFile, 'utf-8'))
    expect(
      out.optimizations.find(
        (o: { packageName: string }) => o.packageName === 'my-internal',
      )?.alternative,
    ).toBe('my-better-lib')
  })

  // -----------------------------------------------------------------
  // 格式
  // -----------------------------------------------------------------

  it('format=markdown 应生成合法 markdown', async () => {
    writePkg({ react: '^18.0.0' })
    pkgSize.mockResolvedValueOnce(bundleOf('react', 3000))
    mockHealthyReact()
    npmInfo.mockResolvedValue({
      name: 'react',
      version: '18.3.1',
      license: 'MIT',
    })

    const outFile = join(dir, 'r.md')
    const code = await scanCommand(dir, {
      format: 'markdown',
      output: outFile,
    })
    expect(code).toBe(EXIT_CODES.OK)

    const content = readFileSync(outFile, 'utf-8')
    expect(content).toContain('# dep-radar 分析报告')
    expect(content).toContain('## 包体积')
    expect(content).toContain('react')
  })

  it('terminal 格式写 stdout', async () => {
    writePkg({ react: '^18.0.0' })
    pkgSize.mockResolvedValueOnce(bundleOf('react', 3000))
    mockHealthyReact()
    npmInfo.mockResolvedValue({
      name: 'react',
      version: '18.3.1',
      license: 'MIT',
    })

    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true)
    try {
      const code = await scanCommand(dir, { format: 'terminal' })
      expect(code).toBe(EXIT_CODES.OK)
      const written = writeSpy.mock.calls.map(c => String(c[0])).join('')
      expect(written).toContain('react')
      expect(written).toContain('dep-radar')
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('无优化空间时 summary.optimizationCount = 0', async () => {
    writePkg({ react: '^18.0.0' })
    pkgSize.mockResolvedValueOnce(bundleOf('react', 3000))
    mockHealthyReact()
    npmInfo.mockResolvedValue({
      name: 'react',
      version: '18.3.1',
      license: 'MIT',
    })

    const outFile = join(dir, 'r.json')
    await scanCommand(dir, { format: 'json', output: outFile })
    const out = JSON.parse(readFileSync(outFile, 'utf-8'))
    expect(out.summary.optimizationCount).toBe(0)
    expect(out.optimizations).toEqual([])
  })
})
