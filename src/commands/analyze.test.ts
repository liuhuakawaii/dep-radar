import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.FORCE_COLOR = '0'

// mock 体积分析的两个数据源
vi.mock('../data/pkg-size.js', () => ({ getPackageSize: vi.fn() }))
vi.mock('../data/bundlephobia.js', () => ({ getPackageSize: vi.fn() }))

// mock health/license 分析需要的 npm/github
vi.mock('../data/npm.js', () => ({
  getFullPackageInfo: vi.fn(),
  getPackageInfo: vi.fn(),
  getDownloadCount: vi.fn(),
  getDownloadTrend: vi.fn(),
}))
vi.mock('../data/github.js', () => ({
  getRepoInfo: vi.fn(),
  parseGitHubUrl: vi.fn(),
}))

const { getPackageSize } = await import('../data/pkg-size.js')
const {
  getFullPackageInfo,
  getPackageInfo,
  getDownloadCount,
  getDownloadTrend,
} = await import('../data/npm.js')
const { getRepoInfo, parseGitHubUrl } = await import('../data/github.js')
const { _resetGithubTokenWarnedForTests } =
  await import('./buildHealthFetcher.js')
const { analyzeCommand } = await import('./analyze.js')
const { EXIT_CODES } = await import('../utils/exitCode.js')

const pkgSize = getPackageSize as unknown as ReturnType<typeof vi.fn>
const npmFullDoc = getFullPackageInfo as unknown as ReturnType<typeof vi.fn>
const npmInfo = getPackageInfo as unknown as ReturnType<typeof vi.fn>
const npmDl = getDownloadCount as unknown as ReturnType<typeof vi.fn>
const npmTrend = getDownloadTrend as unknown as ReturnType<typeof vi.fn>
const ghRepo = getRepoInfo as unknown as ReturnType<typeof vi.fn>
const parseGH = parseGitHubUrl as unknown as ReturnType<typeof vi.fn>

describe('analyzeCommand', () => {
  let dir: string

  beforeEach(() => {
    pkgSize.mockReset()
    npmFullDoc.mockReset()
    npmInfo.mockReset()
    npmDl.mockReset()
    npmTrend.mockReset()
    ghRepo.mockReset()
    parseGH.mockReset()
    _resetGithubTokenWarnedForTests()
    dir = mkdtempSync(join(tmpdir(), 'dep-radar-analyze-'))
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

  // -----------------------------------------------------------------
  // 通用
  // -----------------------------------------------------------------

  it('package.json 不存在时返回 ERROR 退出码', async () => {
    const code = await analyzeCommand(dir, { format: 'json' })
    expect(code).toBe(EXIT_CODES.ERROR)
  })

  // -----------------------------------------------------------------
  // size 维度
  // -----------------------------------------------------------------

  describe('--only size（默认）', () => {
    it('happy path：分析 + JSON 输出到文件 → OK', async () => {
      writePkg({ react: '^18.0.0' })
      pkgSize.mockResolvedValueOnce(bundleOf('react', 5000))

      const outFile = join(dir, 'out.json')
      const code = await analyzeCommand(dir, {
        format: 'json',
        output: outFile,
      })
      expect(code).toBe(EXIT_CODES.OK)

      const out = JSON.parse(readFileSync(outFile, 'utf-8'))
      expect(out.project).toBe('demo')
      expect(out.bundles).toHaveLength(1)
      expect(out.bundles[0].name).toBe('react')
      expect(out.summary.totalGzip).toBe(5000)
      expect(out.health).toEqual([]) // 未跑 health 维度
    })

    it('budget.totalGzip 超出 → BUDGET_EXCEEDED', async () => {
      writePkg({ react: '^18.0.0' })
      pkgSize.mockResolvedValueOnce(bundleOf('react', 5000))
      writeFileSync(
        join(dir, '.dep-radarrc.json'),
        JSON.stringify({ budget: { totalGzip: 1000 } }),
      )
      const code = await analyzeCommand(dir, {
        format: 'json',
        output: join(dir, 'r.json'),
      })
      expect(code).toBe(EXIT_CODES.BUDGET_EXCEEDED)
    })

    it('budget.perPackage 超出 → BUDGET_EXCEEDED', async () => {
      writePkg({ react: '^18.0.0', lodash: '^4.0.0' })
      pkgSize
        .mockResolvedValueOnce(bundleOf('react', 1000))
        .mockResolvedValueOnce(bundleOf('lodash', 50_000))
      writeFileSync(
        join(dir, '.dep-radarrc.json'),
        JSON.stringify({ budget: { perPackage: { lodash: 10_000 } } }),
      )
      const code = await analyzeCommand(dir, {
        format: 'json',
        output: join(dir, 'r.json'),
      })
      expect(code).toBe(EXIT_CODES.BUDGET_EXCEEDED)
    })

    it('budget 未超出 → OK', async () => {
      writePkg({ react: '^18.0.0' })
      pkgSize.mockResolvedValueOnce(bundleOf('react', 500))
      writeFileSync(
        join(dir, '.dep-radarrc.json'),
        JSON.stringify({ budget: { totalGzip: 1000 } }),
      )
      const code = await analyzeCommand(dir, {
        format: 'json',
        output: join(dir, 'r.json'),
      })
      expect(code).toBe(EXIT_CODES.OK)
    })

    it('ignore 配置应过滤包', async () => {
      writePkg({ '@internal/utils': '^1.0.0', react: '^18.0.0' })
      pkgSize.mockResolvedValueOnce(bundleOf('react', 1000))
      writeFileSync(
        join(dir, '.dep-radarrc.json'),
        JSON.stringify({ ignore: ['@internal/*'] }),
      )
      const outFile = join(dir, 'r.json')
      await analyzeCommand(dir, { format: 'json', output: outFile })
      const out = JSON.parse(readFileSync(outFile, 'utf-8'))
      expect(out.bundles).toHaveLength(1)
      expect(out.bundles[0].name).toBe('react')
    })

    it('terminal 格式不指定 output 应写 stdout', async () => {
      writePkg({ react: '^18.0.0' })
      pkgSize.mockResolvedValueOnce(bundleOf('react', 5000))
      const writeSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true)
      try {
        const code = await analyzeCommand(dir, { format: 'terminal' })
        expect(code).toBe(EXIT_CODES.OK)
        const written = writeSpy.mock.calls.map(c => String(c[0])).join('')
        expect(written).toContain('react')
        expect(written).toContain('dep-radar')
      } finally {
        writeSpy.mockRestore()
      }
    })
  })

  // -----------------------------------------------------------------
  // health 维度
  // -----------------------------------------------------------------

  describe('--only health', () => {
    function mockHealthyReact() {
      parseGH.mockReturnValue({ owner: 'facebook', repo: 'react' })
      npmFullDoc.mockResolvedValue({
        name: 'react',
        'dist-tags': { latest: '18.3.1' },
        versions: {
          '18.3.1': { name: 'react', version: '18.3.1', types: './index.d.ts' },
        },
        time: { '18.3.1': new Date().toISOString() },
        maintainers: [
          { name: 'a' },
          { name: 'b' },
          { name: 'c' },
          { name: 'd' },
        ],
        repository: {
          type: 'git',
          url: 'git+https://github.com/facebook/react.git',
        },
      })
      npmDl.mockResolvedValue(500_000)
      npmTrend.mockResolvedValue('up')
      ghRepo.mockResolvedValue({
        stargazers_count: 200_000,
        open_issues_count: 800,
        pushed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        archived: false,
        license: { spdx_id: 'MIT' },
      })
    }

    it('happy path：health 字段应被填充，bundles 应为空', async () => {
      writePkg({ react: '^18.0.0' })
      mockHealthyReact()

      const outFile = join(dir, 'r.json')
      const code = await analyzeCommand(dir, {
        only: 'health',
        format: 'json',
        output: outFile,
      })
      expect(code).toBe(EXIT_CODES.OK)

      const out = JSON.parse(readFileSync(outFile, 'utf-8'))
      expect(out.health).toHaveLength(1)
      expect(out.health[0].name).toBe('react')
      expect(out.health[0].weeklyDownloads).toBe(500_000)
      expect(out.health[0].downloadTrend).toBe('up')
      expect(out.health[0].githubStars).toBe(200_000)
      expect(out.health[0].healthScore).toBeGreaterThan(80)
      expect(out.bundles).toEqual([])
      expect(out.summary.totalDependencies).toBe(1)
    })

    it('deprecated 包应累计到 summary.deprecatedCount', async () => {
      writePkg({ moment: '^2.0.0' })
      npmFullDoc.mockResolvedValue({
        name: 'moment',
        'dist-tags': { latest: '2.30.1' },
        versions: {
          '2.30.1': {
            name: 'moment',
            version: '2.30.1',
            deprecated: '请用 dayjs',
          },
        },
        time: { '2.30.1': '2024-01-01T00:00:00Z' },
        maintainers: [{ name: 'a' }],
      })
      npmDl.mockResolvedValue(10_000_000)
      npmTrend.mockResolvedValue('stable')
      ghRepo.mockResolvedValue(null)

      const outFile = join(dir, 'r.json')
      await analyzeCommand(dir, {
        only: 'health',
        format: 'json',
        output: outFile,
      })
      const out = JSON.parse(readFileSync(outFile, 'utf-8'))
      expect(out.summary.deprecatedCount).toBe(1)
      expect(out.health[0].healthScore).toBe(0)
    })

    it('health 维度下 budget 校验应被跳过（不该误报 BUDGET_EXCEEDED）', async () => {
      writePkg({ react: '^18.0.0' })
      mockHealthyReact()
      writeFileSync(
        join(dir, '.dep-radarrc.json'),
        JSON.stringify({ budget: { totalGzip: 1 } }),
      )
      const code = await analyzeCommand(dir, {
        only: 'health',
        format: 'json',
        output: join(dir, 'r.json'),
      })
      expect(code).toBe(EXIT_CODES.OK)
    })
  })

  // -----------------------------------------------------------------
  // license 维度
  // -----------------------------------------------------------------

  describe('--only license', () => {
    it('全部 MIT → OK，无 conflict 文案', async () => {
      writePkg({ react: '^18.0.0' })
      npmInfo.mockResolvedValue({
        name: 'react',
        version: '18.3.1',
        license: 'MIT',
      })

      const outFile = join(dir, 'r.json')
      const code = await analyzeCommand(dir, {
        only: 'license',
        format: 'json',
        output: outFile,
      })
      expect(code).toBe(EXIT_CODES.OK)
      const out = JSON.parse(readFileSync(outFile, 'utf-8'))
      expect(out.licenses).toHaveLength(1)
      expect(out.licenses[0].risk).toBe('low')
      expect(out.summary.licenseIssues).toBe(0)
    })

    it('含 GPL-3.0 → LICENSE_CONFLICT (4)', async () => {
      writePkg({ a: '^1.0.0', b: '^1.0.0' })
      npmInfo.mockImplementation(async (name: string) => {
        if (name === 'a') return { name: 'a', version: '1', license: 'MIT' }
        return { name: 'b', version: '1', license: 'GPL-3.0' }
      })

      const outFile = join(dir, 'r.json')
      const code = await analyzeCommand(dir, {
        only: 'license',
        format: 'json',
        output: outFile,
      })
      expect(code).toBe(EXIT_CODES.LICENSE_CONFLICT)
      const out = JSON.parse(readFileSync(outFile, 'utf-8'))
      expect(out.summary.licenseIssues).toBe(1)
      expect(
        out.licenses.find((l: { name: string }) => l.name === 'b').risk,
      ).toBe('high')
    })
  })

  // -----------------------------------------------------------------
  // 占位维度
  // -----------------------------------------------------------------

  it('--only security 应返回 OK 并打 warn（占位维度，输出空报告）', async () => {
    writePkg({ react: '^18.0.0' })
    const code = await analyzeCommand(dir, {
      only: 'security',
      format: 'json',
      output: join(dir, 'r.json'),
    })
    expect(code).toBe(EXIT_CODES.OK)
    const out = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf-8'))
    expect(out.bundles).toEqual([])
    expect(out.health).toEqual([])
    expect(out.licenses).toEqual([])
  })
})
