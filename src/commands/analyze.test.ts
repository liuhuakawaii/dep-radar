import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 关闭 chalk 颜色避免测试 assertion 干扰
process.env.FORCE_COLOR = '0'

// mock 两个数据源；analyze 间接通过 buildBundleFetcher 调用它们
vi.mock('../data/pkg-size.js', () => ({
  getPackageSize: vi.fn(),
}))
vi.mock('../data/bundlephobia.js', () => ({
  getPackageSize: vi.fn(),
}))

const { getPackageSize } = await import('../data/pkg-size.js')
const { analyzeCommand } = await import('./analyze.js')
const { EXIT_CODES } = await import('../utils/exitCode.js')

const pkgSize = getPackageSize as unknown as ReturnType<typeof vi.fn>

describe('analyzeCommand', () => {
  let dir: string

  beforeEach(() => {
    pkgSize.mockReset()
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

  it('package.json 不存在时返回 ERROR 退出码', async () => {
    const code = await analyzeCommand(dir, { format: 'json' })
    expect(code).toBe(EXIT_CODES.ERROR)
  })

  it('happy path：分析 + JSON 输出到文件 → OK', async () => {
    writePkg({ react: '^18.0.0' })
    pkgSize.mockResolvedValueOnce(bundleOf('react', 5000))

    const outFile = join(dir, 'out.json')
    const code = await analyzeCommand(dir, { format: 'json', output: outFile })
    expect(code).toBe(EXIT_CODES.OK)

    const out = JSON.parse(readFileSync(outFile, 'utf-8'))
    expect(out.project).toBe('demo')
    expect(out.bundles).toHaveLength(1)
    expect(out.bundles[0].name).toBe('react')
    expect(out.summary.totalGzip).toBe(5000)
  })

  it('budget.totalGzip 超出 → 退出码 BUDGET_EXCEEDED', async () => {
    writePkg({ react: '^18.0.0' })
    pkgSize.mockResolvedValueOnce(bundleOf('react', 5000))

    // 配 budget 上限 1000
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

  it('budget.perPackage 超出某个包 → 退出码 BUDGET_EXCEEDED', async () => {
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

  it('budget 未超出 → 退出码 OK', async () => {
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

  it('terminal 格式不指定 output 时应写 stdout', async () => {
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
