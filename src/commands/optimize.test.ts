import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.FORCE_COLOR = '0'

// 同 analyze.test.ts 一样 mock 数据层
vi.mock('../data/pkg-size.js', () => ({ getPackageSize: vi.fn() }))
vi.mock('../data/bundlephobia.js', () => ({ getPackageSize: vi.fn() }))
vi.mock('../data/npm.js', () => ({
  getFullPackageInfo: vi.fn(),
  getPackageInfo: vi.fn(),
  getDownloadCount: vi.fn(),
  getDownloadTrend: vi.fn(),
}))
vi.mock('../data/github.js', () => ({ getRepoInfo: vi.fn() }))

const { getPackageSize } = await import('../data/pkg-size.js')
const {
  getFullPackageInfo,
  getPackageInfo,
  getDownloadCount,
  getDownloadTrend,
} = await import('../data/npm.js')
const { getRepoInfo } = await import('../data/github.js')
const { _resetGithubTokenWarnedForTests } =
  await import('./buildHealthFetcher.js')
const { optimizeCommand } = await import('./optimize.js')
const { EXIT_CODES } = await import('../utils/exitCode.js')

const pkgSize = getPackageSize as unknown as ReturnType<typeof vi.fn>
const npmFullDoc = getFullPackageInfo as unknown as ReturnType<typeof vi.fn>
const npmInfo = getPackageInfo as unknown as ReturnType<typeof vi.fn>
const npmDl = getDownloadCount as unknown as ReturnType<typeof vi.fn>
const npmTrend = getDownloadTrend as unknown as ReturnType<typeof vi.fn>
const ghRepo = getRepoInfo as unknown as ReturnType<typeof vi.fn>

describe('optimizeCommand', () => {
  let dir: string

  beforeEach(() => {
    pkgSize.mockReset()
    npmFullDoc.mockReset()
    npmInfo.mockReset()
    npmDl.mockReset()
    npmTrend.mockReset()
    ghRepo.mockReset()
    _resetGithubTokenWarnedForTests()
    dir = mkdtempSync(join(tmpdir(), 'dep-radar-optimize-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writePkg(deps: Record<string, string>) {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: deps }),
    )
  }

  function mockHealthy(name: string) {
    npmFullDoc.mockImplementation(async (n: string) => ({
      name: n,
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { name: n, version: '1.0.0', types: './i.d.ts' } },
      time: { '1.0.0': new Date().toISOString() },
      maintainers: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
    }))
    npmDl.mockResolvedValue(500_000)
    npmTrend.mockResolvedValue('up')
    ghRepo.mockResolvedValue(null)
    return name
  }

  it('package.json 不存在 → ERROR', async () => {
    const code = await optimizeCommand(dir)
    expect(code).toBe(EXIT_CODES.ERROR)
  })

  it('happy path：含 moment 应生成 replace 建议', async () => {
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
    const code = await optimizeCommand(dir, { format: 'json', output: outFile })
    expect(code).toBe(EXIT_CODES.OK)
    const out = JSON.parse(readFileSync(outFile, 'utf-8'))
    expect(out.optimizations).toHaveLength(1)
    expect(out.optimizations[0].packageName).toBe('moment')
    expect(out.optimizations[0].alternative).toBe('dayjs')
    expect(out.summary.optimizationCount).toBe(1)
  })

  it('skipHealth=true 时不调用 health fetcher', async () => {
    writePkg({ react: '^18.0.0' })
    pkgSize.mockResolvedValueOnce({
      name: 'react',
      version: '18.3.1',
      size: 10_000,
      gzip: 3_000,
      dependencyCount: 0,
      hasJSModule: true,
      hasJSNext: false,
      source: 'pkg-size',
    })
    npmInfo.mockResolvedValue({
      name: 'react',
      version: '18.3.1',
      license: 'MIT',
    })

    const code = await optimizeCommand(dir, {
      format: 'json',
      output: join(dir, 'r.json'),
      skipHealth: true,
    })
    expect(code).toBe(EXIT_CODES.OK)
    expect(npmFullDoc).not.toHaveBeenCalled()
    expect(npmDl).not.toHaveBeenCalled()
    expect(npmTrend).not.toHaveBeenCalled()
  })

  it('skipLicense=true 时不调用 license fetcher', async () => {
    writePkg({ react: '^18.0.0' })
    pkgSize.mockResolvedValueOnce({
      name: 'react',
      version: '18.3.1',
      size: 10_000,
      gzip: 3_000,
      dependencyCount: 0,
      hasJSModule: true,
      hasJSNext: false,
      source: 'pkg-size',
    })
    mockHealthy('react')

    await optimizeCommand(dir, {
      format: 'json',
      output: join(dir, 'r.json'),
      skipLicense: true,
    })
    expect(npmInfo).not.toHaveBeenCalled()
  })

  it('无优化空间时 summary.optimizationCount = 0', async () => {
    writePkg({ react: '^18.0.0' })
    pkgSize.mockResolvedValueOnce({
      name: 'react',
      version: '18.3.1',
      size: 10_000,
      gzip: 3_000,
      dependencyCount: 0,
      hasJSModule: true,
      hasJSNext: false,
      source: 'pkg-size',
    })
    mockHealthy('react')
    npmInfo.mockResolvedValue({
      name: 'react',
      version: '18.3.1',
      license: 'MIT',
    })

    const outFile = join(dir, 'r.json')
    await optimizeCommand(dir, { format: 'json', output: outFile })
    const out = JSON.parse(readFileSync(outFile, 'utf-8'))
    expect(out.summary.optimizationCount).toBe(0)
    expect(out.optimizations).toEqual([])
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
    mockHealthy('my-internal')
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
    await optimizeCommand(dir, { format: 'json', output: outFile })
    const out = JSON.parse(readFileSync(outFile, 'utf-8'))
    expect(
      out.optimizations.find(
        (o: { packageName: string }) => o.packageName === 'my-internal',
      )?.alternative,
    ).toBe('my-better-lib')
  })
})
