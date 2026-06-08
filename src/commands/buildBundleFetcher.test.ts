import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NetworkError, PackageNotFoundError } from '../errors/index.js'

// 必须在被测模块之前 mock 两个数据源
vi.mock('../data/pkg-size.js', () => ({
  getPackageSize: vi.fn(),
}))
vi.mock('../data/bundlephobia.js', () => ({
  getPackageSize: vi.fn(),
}))

const { getPackageSize: pkgSizeMock } = await import('../data/pkg-size.js')
const { getPackageSize: bundlephobiaMock } =
  await import('../data/bundlephobia.js')
const { buildBundleFetcher } = await import('./buildBundleFetcher.js')

const pkgSize = pkgSizeMock as unknown as ReturnType<typeof vi.fn>
const bundlephobia = bundlephobiaMock as unknown as ReturnType<typeof vi.fn>

const sampleBundle = (source: 'pkg-size' | 'bundlephobia') => ({
  name: 'react',
  version: '18.3.1',
  size: 100,
  gzip: 30,
  dependencyCount: 0,
  hasJSModule: true,
  hasJSNext: false,
  source,
})

describe('buildBundleFetcher', () => {
  beforeEach(() => {
    pkgSize.mockReset()
    bundlephobia.mockReset()
  })

  it('默认按 pkg-size → bundlephobia 顺序尝试', async () => {
    pkgSize.mockResolvedValueOnce(sampleBundle('pkg-size'))
    const fetcher = await buildBundleFetcher()
    const got = await fetcher('react', '18.3.1')
    expect(got.source).toBe('pkg-size')
    expect(pkgSize).toHaveBeenCalledTimes(1)
    expect(bundlephobia).not.toHaveBeenCalled()
  })

  it('pkg-size 失败时 fallback 到 bundlephobia', async () => {
    pkgSize.mockRejectedValueOnce(new NetworkError('boom', 500))
    bundlephobia.mockResolvedValueOnce(sampleBundle('bundlephobia'))
    const fetcher = await buildBundleFetcher()
    const got = await fetcher('react', '18.3.1')
    expect(got.source).toBe('bundlephobia')
    expect(pkgSize).toHaveBeenCalledTimes(1)
    expect(bundlephobia).toHaveBeenCalledTimes(1)
  })

  it('PackageNotFoundError 不应 fallback（包确实不存在）', async () => {
    pkgSize.mockRejectedValueOnce(new PackageNotFoundError('react'))
    const fetcher = await buildBundleFetcher()
    let caught: unknown
    await fetcher('react', '18.3.1').catch(e => {
      caught = e
    })
    expect(caught).toBeInstanceOf(PackageNotFoundError)
    expect(bundlephobia).not.toHaveBeenCalled()
  })

  it('全部源失败时抛最后一次错误', async () => {
    pkgSize.mockRejectedValueOnce(new NetworkError('a', 500))
    bundlephobia.mockRejectedValueOnce(new NetworkError('b', 503))
    const fetcher = await buildBundleFetcher()
    let caught: unknown
    await fetcher('x').catch(e => {
      caught = e
    })
    expect(caught).toBeInstanceOf(NetworkError)
    expect((caught as NetworkError).message).toBe('b')
  })

  it('dataSource 参数应改变优先级顺序', async () => {
    bundlephobia.mockResolvedValueOnce(sampleBundle('bundlephobia'))
    const fetcher = await buildBundleFetcher({
      dataSource: ['bundlephobia', 'pkg-size'],
    })
    const got = await fetcher('react')
    expect(got.source).toBe('bundlephobia')
    expect(pkgSize).not.toHaveBeenCalled()
  })

  it('local 数据源应被跳过并继续其他源', async () => {
    pkgSize.mockResolvedValueOnce(sampleBundle('pkg-size'))
    const fetcher = await buildBundleFetcher({
      dataSource: ['local', 'pkg-size'],
    })
    const got = await fetcher('react')
    expect(got.source).toBe('pkg-size')
  })

  it('dataSource 全为不可用源时应抛错', async () => {
    const fetcher = await buildBundleFetcher({ dataSource: ['local'] })
    await expect(fetcher('x')).rejects.toThrow()
  })

  it('dataSource 重复项应自动去重', async () => {
    pkgSize.mockRejectedValueOnce(new NetworkError('boom', 500))
    bundlephobia.mockResolvedValueOnce(sampleBundle('bundlephobia'))
    const fetcher = await buildBundleFetcher({
      dataSource: ['pkg-size', 'pkg-size', 'bundlephobia'],
    })
    await fetcher('x')
    // 即使配了两次 pkg-size，也只会调用一次
    expect(pkgSize).toHaveBeenCalledTimes(1)
  })
})
