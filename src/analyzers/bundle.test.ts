import { describe, expect, it, vi } from 'vitest'

import type { BundleInfo } from '../types/analysis.js'
import type { PackageJson } from '../types/package.js'
import { compileIgnorePattern } from '../utils/ignore.js'
import {
  analyzeBundleSizeFromPackage,
  resolveSpec,
  type BundleFetcher,
} from './bundle.js'

/** 构造一个标准的成功 BundleInfo（便于 mock fetcher） */
function makeBundle(
  name: string,
  version: string,
  gzip: number,
  source: BundleInfo['source'] = 'pkg-size',
): BundleInfo {
  return {
    name,
    version,
    size: gzip * 3,
    gzip,
    dependencyCount: 0,
    hasJSModule: true,
    hasJSNext: false,
    source,
    isDirect: true,
  }
}

const minimalPkg = (override: Partial<PackageJson> = {}): PackageJson => ({
  name: 'demo',
  version: '1.0.0',
  ...override,
})

// =====================================================================
// resolveSpec
// =====================================================================

describe('resolveSpec', () => {
  it('应去掉 caret/tilde 等前缀', () => {
    expect(resolveSpec('^1.2.3')).toEqual({ version: '1.2.3' })
    expect(resolveSpec('~4.5.0')).toEqual({ version: '4.5.0' })
    expect(resolveSpec('>=1 <2')).toEqual({ version: '1' })
  })

  it('"*" / "latest" / "x" 应返回 undefined（让数据源用最新）', () => {
    expect(resolveSpec('*')).toEqual({ version: undefined })
    expect(resolveSpec('latest')).toEqual({ version: undefined })
    expect(resolveSpec('x')).toEqual({ version: undefined })
  })

  it('workspace:/file:/link:/git:/http: 等协议应被 skip', () => {
    expect(resolveSpec('workspace:*').skip).toBe('workspace 协议')
    expect(resolveSpec('file:../local').skip).toBe('file 协议')
    expect(resolveSpec('link:../sibling').skip).toBe('link 协议')
    expect(resolveSpec('git+https://github.com/a/b').skip).toBeDefined()
    expect(resolveSpec('http://x').skip).toBe('http 协议')
  })

  it('npm: 协议应该剥离并取出实际 spec', () => {
    expect(resolveSpec('npm:react@^18.0.0')).toEqual({ version: '18.0.0' })
    expect(resolveSpec('npm:react@latest')).toEqual({ version: undefined })
  })

  it('空字符串应被 skip', () => {
    expect(resolveSpec('')).toEqual({ skip: '版本号为空' })
  })
})

// =====================================================================
// compileIgnorePattern
// =====================================================================

describe('compileIgnorePattern', () => {
  it('精确匹配', () => {
    const m = compileIgnorePattern('lodash')
    expect(m('lodash')).toBe(true)
    expect(m('lodash-es')).toBe(false)
    expect(m('not-lodash')).toBe(false)
  })

  it('末尾 /* 通配匹配 scope', () => {
    const m = compileIgnorePattern('@internal/*')
    expect(m('@internal/utils')).toBe(true)
    expect(m('@internal/foo')).toBe(true)
    expect(m('@external/utils')).toBe(false)
    expect(m('@internal')).toBe(false)
  })

  it('末尾 * 通配前缀', () => {
    const m = compileIgnorePattern('react-*')
    expect(m('react-router')).toBe(true)
    expect(m('react-dom')).toBe(true)
    expect(m('vue-router')).toBe(false)
  })
})

// =====================================================================
// analyzeBundleSizeFromPackage (旧版 API)
// =====================================================================

describe('analyzeBundleSizeFromPackage', () => {
  it('happy path：应正确累加 totalSize / totalGzip 并产出 topN', async () => {
    const fetcher: BundleFetcher = async (name, version) => {
      const sizeByName: Record<string, number> = {
        react: 5_000,
        lodash: 25_000,
        chalk: 1_000,
      }
      return makeBundle(name, version ?? 'latest', sizeByName[name] ?? 0)
    }

    const result = await analyzeBundleSizeFromPackage(
      minimalPkg({
        dependencies: {
          react: '^18.0.0',
          lodash: '^4.17.21',
          chalk: '^5.0.0',
        },
      }),
      fetcher,
    )

    expect(result.bundles).toHaveLength(3)
    expect(result.totalGzip).toBe(31_000)
    expect(result.totalSize).toBe(31_000 * 3)
    // topN 按 gzip 降序
    expect(result.topN[0]!.name).toBe('lodash')
    expect(result.topN[1]!.name).toBe('react')
    expect(result.topN[2]!.name).toBe('chalk')
    expect(result.skipped).toEqual([])
  })

  it('单包失败应回退为 source=unknown 并保留错误信息', async () => {
    const fetcher: BundleFetcher = async name => {
      if (name === 'broken') throw new Error('API 500')
      return makeBundle(name, '1.0.0', 1_000)
    }

    const result = await analyzeBundleSizeFromPackage(
      minimalPkg({
        dependencies: { ok: '^1.0.0', broken: '^2.0.0' },
      }),
      fetcher,
    )

    const broken = result.bundles.find(b => b.name === 'broken')!
    expect(broken.source).toBe('unknown')
    expect(broken.error).toBe('API 500')
    expect(broken.gzip).toBe(0)
    // 失败不影响其他包
    const ok = result.bundles.find(b => b.name === 'ok')!
    expect(ok.gzip).toBe(1_000)
    expect(result.totalGzip).toBe(1_000)
  })

  it('空 dependencies 应返回空结果，不抛错', async () => {
    const fetcher = vi.fn() as unknown as BundleFetcher
    const result = await analyzeBundleSizeFromPackage(minimalPkg(), fetcher)
    expect(result.bundles).toEqual([])
    expect(result.totalGzip).toBe(0)
    expect(result.topN).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('includeDev=true 时应一并分析 devDependencies', async () => {
    const fetcher: BundleFetcher = async name =>
      makeBundle(name, '1.0.0', 1_000)
    const pkg = minimalPkg({
      dependencies: { react: '^18.0.0' },
      devDependencies: { vitest: '^2.0.0' },
    })

    const without = await analyzeBundleSizeFromPackage(pkg, fetcher)
    expect(without.bundles).toHaveLength(1)

    const withDev = await analyzeBundleSizeFromPackage(pkg, fetcher, {
      includeDev: true,
    })
    expect(withDev.bundles).toHaveLength(2)
    expect(withDev.bundles.map(b => b.name).sort()).toEqual(['react', 'vitest'])
  })

  it('workspace:/file: 协议应跳过并记录 skipped', async () => {
    const fetcher = vi.fn(async (name, version) =>
      makeBundle(name, version ?? '1.0.0', 1_000),
    ) as unknown as BundleFetcher

    const result = await analyzeBundleSizeFromPackage(
      minimalPkg({
        dependencies: {
          react: '^18.0.0',
          '@my-org/utils': 'workspace:*',
          '@my-org/local': 'file:../local',
        },
      }),
      fetcher,
    )

    expect(result.bundles).toHaveLength(1)
    expect(result.bundles[0]!.name).toBe('react')
    expect(result.skipped).toHaveLength(2)
    expect(result.skipped.map(s => s.name).sort()).toEqual([
      '@my-org/local',
      '@my-org/utils',
    ])
    expect(vi.mocked(fetcher).mock.calls.length).toBe(1) // 跳过的不发请求
  })

  it('ignore 配置应过滤掉指定包', async () => {
    const fetcher = vi.fn(async (name, version) =>
      makeBundle(name, version ?? '1.0.0', 1_000),
    ) as unknown as BundleFetcher

    const result = await analyzeBundleSizeFromPackage(
      minimalPkg({
        dependencies: {
          react: '^18.0.0',
          '@internal/a': '^1.0.0',
          '@internal/b': '^1.0.0',
          lodash: '^4.0.0',
        },
      }),
      fetcher,
      { ignore: ['@internal/*', 'lodash'] },
    )

    expect(result.bundles).toHaveLength(1)
    expect(result.bundles[0]!.name).toBe('react')
    expect(result.skipped.map(s => s.name).sort()).toEqual([
      '@internal/a',
      '@internal/b',
      'lodash',
    ])
    expect(result.skipped.every(s => s.reason.includes('ignore'))).toBe(true)
  })

  it('topN=0 应返回空 topN（不抛错）', async () => {
    const fetcher: BundleFetcher = async name =>
      makeBundle(name, '1.0.0', 1_000)
    const result = await analyzeBundleSizeFromPackage(
      minimalPkg({ dependencies: { a: '^1', b: '^1' } }),
      fetcher,
      { topN: 0 },
    )
    expect(result.topN).toEqual([])
    expect(result.bundles).toHaveLength(2)
  })

  it('concurrency 应被 fetcher 调用次数证实（并发上限）', async () => {
    let inFlight = 0
    let maxConcurrent = 0
    const fetcher: BundleFetcher = async (name, version) => {
      inFlight++
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      // 微小延迟模拟异步
      await new Promise(r => setTimeout(r, 5))
      inFlight--
      return makeBundle(name, version ?? '1', 1)
    }

    const deps = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`pkg-${i}`, '^1.0.0']),
    )
    await analyzeBundleSizeFromPackage(
      minimalPkg({ dependencies: deps }),
      fetcher,
      {
        concurrency: 3,
      },
    )
    expect(maxConcurrent).toBeLessThanOrEqual(3)
    expect(maxConcurrent).toBeGreaterThan(0)
  })

  it('版本号 "*" 应以 version=undefined 调用 fetcher', async () => {
    const calls: Array<[string, string | undefined]> = []
    const fetcher: BundleFetcher = async (name, version) => {
      calls.push([name, version])
      return makeBundle(name, version ?? 'x', 1)
    }
    await analyzeBundleSizeFromPackage(
      minimalPkg({ dependencies: { foo: '*', bar: '^1.0.0' } }),
      fetcher,
    )
    expect(calls).toContainEqual(['foo', undefined])
    expect(calls).toContainEqual(['bar', '1.0.0'])
  })
})
