import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NetworkError, PackageNotFoundError } from '../errors/index.js'

vi.mock('./http.js', () => ({
  fetchJson: vi.fn(),
}))

const { fetchJson } = await import('./http.js')
const {
  getPackageInfo,
  getFullPackageInfo,
  getDownloadCount,
  getDownloadRange,
  getDownloadTrend,
} = await import('./npm.js')

const mockedFetchJson = fetchJson as unknown as ReturnType<typeof vi.fn>

describe('npm registry & downloads', () => {
  beforeEach(() => {
    mockedFetchJson.mockReset()
  })

  describe('getPackageInfo (latest manifest)', () => {
    it('应该请求 /latest 端点', async () => {
      mockedFetchJson.mockResolvedValueOnce({
        name: 'react',
        version: '18.3.1',
      })
      await getPackageInfo('react')
      const [url] = mockedFetchJson.mock.calls[0]!
      expect(url).toBe('https://registry.npmjs.org/react/latest')
    })

    it('scoped 包名应被 URL 编码', async () => {
      mockedFetchJson.mockResolvedValueOnce({
        name: '@types/node',
        version: '20',
      })
      await getPackageInfo('@types/node')
      const [url] = mockedFetchJson.mock.calls[0]!
      expect(url).toContain('%40types%2Fnode')
    })

    it('404 应转抛 PackageNotFoundError', async () => {
      mockedFetchJson.mockRejectedValueOnce(new NetworkError('not found', 404))
      let caught: unknown
      await getPackageInfo('nope').catch(e => {
        caught = e
      })
      expect(caught).toBeInstanceOf(PackageNotFoundError)
    })
  })

  describe('getFullPackageInfo (完整 document)', () => {
    it('应该请求不带 /latest 的端点', async () => {
      mockedFetchJson.mockResolvedValueOnce({
        name: 'react',
        version: '18.3.1',
      })
      await getFullPackageInfo('react')
      const [url] = mockedFetchJson.mock.calls[0]!
      expect(url).toBe('https://registry.npmjs.org/react')
    })
  })

  describe('getDownloadCount', () => {
    it('返回 res.downloads 数字', async () => {
      mockedFetchJson.mockResolvedValueOnce({
        downloads: 1_234_567,
        package: 'react',
        start: '2026-05-01',
        end: '2026-05-31',
      })
      const got = await getDownloadCount('react', 'last-month')
      expect(got).toBe(1_234_567)
    })

    it('period 参数应该出现在 URL 中', async () => {
      mockedFetchJson.mockResolvedValueOnce({ downloads: 0 })
      await getDownloadCount('react', 'last-week')
      const [url] = mockedFetchJson.mock.calls[0]!
      expect(url).toContain('/point/last-week/react')
    })
  })

  describe('getDownloadRange', () => {
    it('请求 /range/last-month 端点', async () => {
      mockedFetchJson.mockResolvedValueOnce({ downloads: [] })
      await getDownloadRange('react')
      const [url] = mockedFetchJson.mock.calls[0]!
      expect(url).toContain('/range/last-month/react')
    })
  })

  describe('getDownloadTrend', () => {
    function days(values: number[]) {
      return {
        downloads: values.map((downloads, i) => ({
          day: `2026-05-${String(i + 1).padStart(2, '0')}`,
          downloads,
        })),
      }
    }

    it('数据点不足 14 天 → stable', async () => {
      mockedFetchJson.mockResolvedValueOnce(days([100, 100, 100]))
      const got = await getDownloadTrend('react')
      expect(got).toBe('stable')
    })

    it('后半月增长 > 10% → up', async () => {
      // 14 天：前 7 天每天 100，后 7 天每天 200 → 比率 = 2.0 > 1.1
      const arr = [...Array<number>(7).fill(100), ...Array<number>(7).fill(200)]
      mockedFetchJson.mockResolvedValueOnce(days(arr))
      const got = await getDownloadTrend('react')
      expect(got).toBe('up')
    })

    it('后半月下降 > 10% → down', async () => {
      const arr = [...Array<number>(7).fill(200), ...Array<number>(7).fill(100)]
      mockedFetchJson.mockResolvedValueOnce(days(arr))
      const got = await getDownloadTrend('react')
      expect(got).toBe('down')
    })

    it('波动 < 10% → stable', async () => {
      // 比率 105/100 = 1.05，在 [0.9, 1.1] 区间
      const arr = [...Array<number>(7).fill(100), ...Array<number>(7).fill(105)]
      mockedFetchJson.mockResolvedValueOnce(days(arr))
      const got = await getDownloadTrend('react')
      expect(got).toBe('stable')
    })

    it('前半月为 0 且后半月有下载 → up', async () => {
      const arr = [...Array<number>(7).fill(0), ...Array<number>(7).fill(100)]
      mockedFetchJson.mockResolvedValueOnce(days(arr))
      const got = await getDownloadTrend('react')
      expect(got).toBe('up')
    })

    it('前后半月均为 0 → stable', async () => {
      const arr = Array<number>(14).fill(0)
      mockedFetchJson.mockResolvedValueOnce(days(arr))
      const got = await getDownloadTrend('react')
      expect(got).toBe('stable')
    })
  })
})
