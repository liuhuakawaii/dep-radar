import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NetworkError, PackageNotFoundError } from '../errors/index.js'

vi.mock('./http.js', () => ({
  fetchJson: vi.fn(),
}))

const { fetchJson } = await import('./http.js')
const { getPackageSize } = await import('./bundlephobia.js')

const mockedFetchJson = fetchJson as unknown as ReturnType<typeof vi.fn>

describe('getPackageSize (bundlephobia)', () => {
  beforeEach(() => {
    mockedFetchJson.mockReset()
  })

  it('正常响应应映射为 BundleInfo（source=bundlephobia，无 brotli）', async () => {
    mockedFetchJson.mockResolvedValueOnce({
      name: 'lodash',
      version: '4.17.21',
      size: 71_649,
      gzip: 25_667,
      dependencyCount: 0,
      hasJSModule: false,
      hasJSNext: false,
    })

    const got = await getPackageSize('lodash', '4.17.21')
    expect(got).toEqual({
      name: 'lodash',
      version: '4.17.21',
      size: 71_649,
      gzip: 25_667,
      dependencyCount: 0,
      hasJSModule: false,
      hasJSNext: false,
      source: 'bundlephobia',
    })
    expect(got.brotli).toBeUndefined()
  })

  it('URL 应包含 record=true（贡献到 Bundlephobia DB）', async () => {
    mockedFetchJson.mockResolvedValueOnce({
      name: 'react',
      version: '18.3.1',
      size: 1,
      gzip: 1,
      dependencyCount: 0,
      hasJSModule: true,
      hasJSNext: false,
    })

    await getPackageSize('react', '18.3.1')
    const [url] = mockedFetchJson.mock.calls[0]!
    expect(url).toContain('record=true')
    expect(url).toContain('package=')
  })

  it('HTTP 404 应转抛 PackageNotFoundError', async () => {
    mockedFetchJson.mockRejectedValueOnce(new NetworkError('not found', 404))

    let caught: unknown
    await getPackageSize('xxx').catch(e => {
      caught = e
    })
    expect(caught).toBeInstanceOf(PackageNotFoundError)
  })

  it('其他错误应原样向上抛', async () => {
    mockedFetchJson.mockRejectedValueOnce(new NetworkError('503', 503))

    let caught: unknown
    await getPackageSize('react').catch(e => {
      caught = e
    })
    expect(caught).toBeInstanceOf(NetworkError)
    expect(caught).not.toBeInstanceOf(PackageNotFoundError)
  })
})
