import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { NetworkError } from '../errors/index.js'

vi.mock('../data/npm.js', () => ({
  getPackageInfo: vi.fn(),
  getPackageMeta: vi.fn(),
  getDownloadStats: vi.fn(),
}))

vi.mock('../data/github.js', () => ({
  getRepoInfo: vi.fn(),
}))

vi.mock('../utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
  setLogLevel: vi.fn(),
}))

const { getPackageInfo, getPackageMeta, getDownloadStats } =
  await import('../data/npm.js')
const { getRepoInfo } = await import('../data/github.js')
const { logger } = await import('../utils/logger.js')
const { buildHealthFetcher, _resetGithubTokenWarnedForTests } =
  await import('./buildHealthFetcher.js')

const liteDoc = getPackageInfo as unknown as ReturnType<typeof vi.fn>
const meta = getPackageMeta as unknown as ReturnType<typeof vi.fn>
const dlStats = getDownloadStats as unknown as ReturnType<typeof vi.fn>
const repoInfo = getRepoInfo as unknown as ReturnType<typeof vi.fn>
const warn = logger.warn as unknown as ReturnType<typeof vi.fn>

const originalToken = process.env.GITHUB_TOKEN

afterAll(() => {
  if (originalToken === undefined) {
    delete process.env.GITHUB_TOKEN
  } else {
    process.env.GITHUB_TOKEN = originalToken
  }
})

describe('buildHealthFetcher', () => {
  beforeEach(() => {
    liteDoc.mockReset()
    meta.mockReset()
    dlStats.mockReset()
    repoInfo.mockReset()
    warn.mockReset()
    delete process.env.GITHUB_TOKEN
    _resetGithubTokenWarnedForTests()
  })

  it('getMeta 应代理到 npm.getPackageMeta', async () => {
    meta.mockResolvedValueOnce({
      'dist-tags': { latest: '18.3.1' },
      maintainers: [],
    })
    const f = buildHealthFetcher()
    const got = await f.getMeta('react')
    expect(got).toEqual({ 'dist-tags': { latest: '18.3.1' }, maintainers: [] })
    expect(meta).toHaveBeenCalledWith('react', undefined, undefined)
  })

  it('getLiteDoc 应代理到 npm.getPackageInfo', async () => {
    liteDoc.mockResolvedValueOnce({
      name: 'react',
      version: '18.3.1',
      deprecated: undefined,
    })
    const f = buildHealthFetcher()
    const got = await f.getLiteDoc('react')
    expect(got).toEqual({
      name: 'react',
      version: '18.3.1',
      deprecated: undefined,
    })
    expect(liteDoc).toHaveBeenCalledWith('react', undefined, undefined)
  })

  it('getDownloadStats 应代理到 npm.getDownloadStats', async () => {
    dlStats.mockResolvedValueOnce({ weekly: 500_000, trend: 'up' })
    const f = buildHealthFetcher()
    const got = await f.getDownloadStats('react')
    expect(got).toEqual({ weekly: 500_000, trend: 'up' })
    expect(dlStats).toHaveBeenCalledWith('react', undefined)
  })

  it('getGitHubRepo 成功路径直接返回数据', async () => {
    repoInfo.mockResolvedValueOnce({ stargazers_count: 100 })
    const f = buildHealthFetcher()
    const got = await f.getGitHubRepo('a', 'b')
    expect(got).toEqual({ stargazers_count: 100 })
    expect(repoInfo).toHaveBeenCalledWith('a', 'b', undefined)
  })

  it('getGitHubRepo 任意错误都应转 null（软失败）', async () => {
    repoInfo.mockRejectedValueOnce(new NetworkError('rate limited', 403))
    const f = buildHealthFetcher()
    expect(await f.getGitHubRepo('a', 'b')).toBeNull()
  })

  it('getGitHubRepo 非 Error 抛出（字符串等）也应被吞掉', async () => {
    repoInfo.mockRejectedValueOnce('weird')
    const f = buildHealthFetcher()
    expect(await f.getGitHubRepo('a', 'b')).toBeNull()
  })

  it('首次调用 getGitHubRepo 且无 GITHUB_TOKEN → 应警告一次', async () => {
    repoInfo.mockResolvedValue(null)
    const f = buildHealthFetcher()
    await f.getGitHubRepo('a', 'b')
    await f.getGitHubRepo('c', 'd')
    await f.getGitHubRepo('e', 'f')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('GITHUB_TOKEN')
  })

  it('已设置 GITHUB_TOKEN → 不应警告', async () => {
    process.env.GITHUB_TOKEN = 'fake'
    repoInfo.mockResolvedValue(null)
    const f = buildHealthFetcher()
    await f.getGitHubRepo('a', 'b')
    expect(warn).not.toHaveBeenCalled()
  })
})
