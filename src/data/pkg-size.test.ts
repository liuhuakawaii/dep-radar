import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NetworkError, PackageNotFoundError } from '../errors/index.js'

// 必须在 import 被测模块之前 mock，vitest 会自动 hoist
vi.mock('./http.js', () => ({
  fetchJson: vi.fn(),
}))

const { fetchJson } = await import('./http.js')
const { getPackageSize } = await import('./pkg-size.js')

const mockedFetchJson = fetchJson as unknown as ReturnType<typeof vi.fn>

describe('getPackageSize (pkg-size.dev)', () => {
  beforeEach(() => {
    mockedFetchJson.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('正常响应应映射为 BundleInfo（含 source=pkg-size）', async () => {
    mockedFetchJson.mockResolvedValueOnce({
      name: 'lodash',
      version: '4.17.21',
      size: 72_604,
      gzip: 25_676,
      brotli: 22_000,
      dependencyCount: 0,
      hasJSModule: false,
      hasJSNext: false,
    })

    const got = await getPackageSize('lodash', '4.17.21')
    expect(got).toEqual({
      name: 'lodash',
      version: '4.17.21',
      size: 72_604,
      gzip: 25_676,
      brotli: 22_000,
      dependencyCount: 0,
      hasJSModule: false,
      hasJSNext: false,
      source: 'pkg-size',
      isDirect: true,
    })
  })

  it('URL 中保留 scoped 包名的 @ 与 /（不被 URL 编码）', async () => {
    mockedFetchJson.mockResolvedValueOnce({
      name: '@types/node',
      version: '20.0.0',
      size: 1,
      gzip: 1,
      brotli: 1,
      dependencyCount: 0,
      hasJSModule: false,
      hasJSNext: false,
    })

    await getPackageSize('@types/node', '20.0.0')
    const [url] = mockedFetchJson.mock.calls[0]!
    expect(url).toContain('@types/node@20.0.0')
    expect(url).not.toContain('%40')
    expect(url).not.toContain('%2F')
  })

  it('不传 version 时按 name 查询', async () => {
    mockedFetchJson.mockResolvedValueOnce({
      name: 'react',
      version: '18.3.1',
      size: 1,
      gzip: 1,
      brotli: 1,
      dependencyCount: 0,
      hasJSModule: true,
      hasJSNext: false,
    })

    await getPackageSize('react')
    const [url] = mockedFetchJson.mock.calls[0]!
    expect(url).toMatch(/\/react$/)
  })

  it('HTTP 404 应转抛 PackageNotFoundError', async () => {
    mockedFetchJson.mockRejectedValueOnce(
      new NetworkError('HTTP 404 Not Found', 404),
    )

    let caught: unknown
    await getPackageSize('not-exist-xxx').catch(e => {
      caught = e
    })
    expect(caught).toBeInstanceOf(PackageNotFoundError)
  })

  it('其他 NetworkError 应原样向上抛', async () => {
    mockedFetchJson.mockRejectedValueOnce(new NetworkError('HTTP 500', 500))

    let caught: unknown
    await getPackageSize('react').catch(e => {
      caught = e
    })
    expect(caught).toBeInstanceOf(NetworkError)
    expect(caught).not.toBeInstanceOf(PackageNotFoundError)
  })
})
