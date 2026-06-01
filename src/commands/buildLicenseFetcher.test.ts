import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PackageNotFoundError } from '../errors/index.js'

vi.mock('../data/npm.js', () => ({
  getPackageInfo: vi.fn(),
}))

const { getPackageInfo } = await import('../data/npm.js')
const { buildLicenseFetcher } = await import('./buildLicenseFetcher.js')

const getInfo = getPackageInfo as unknown as ReturnType<typeof vi.fn>

describe('buildLicenseFetcher', () => {
  beforeEach(() => {
    getInfo.mockReset()
  })

  it('字符串形式 license → 原样返回', async () => {
    getInfo.mockResolvedValueOnce({
      name: 'react',
      version: '18',
      license: 'MIT',
    })
    const f = buildLicenseFetcher()
    expect(await f.getLicense('react')).toBe('MIT')
  })

  it('对象形式 license { type } → 提取 type 字段', async () => {
    getInfo.mockResolvedValueOnce({
      name: 'old',
      version: '1',
      license: { type: 'Apache-2.0' },
    })
    const f = buildLicenseFetcher()
    expect(await f.getLicense('old')).toBe('Apache-2.0')
  })

  it('license 字段缺失 → 返回 undefined', async () => {
    getInfo.mockResolvedValueOnce({ name: 'x', version: '1' })
    const f = buildLicenseFetcher()
    expect(await f.getLicense('x')).toBeUndefined()
  })

  it('包不存在 → PackageNotFoundError 透传', async () => {
    getInfo.mockRejectedValueOnce(new PackageNotFoundError('nope'))
    const f = buildLicenseFetcher()
    await expect(f.getLicense('nope')).rejects.toBeInstanceOf(
      PackageNotFoundError,
    )
  })
})
