import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { NetworkError } from '../errors/index.js'

vi.mock('../data/npm.js', () => ({
  getFullPackageInfo: vi.fn(),
  getDownloadCount: vi.fn(),
  getDownloadTrend: vi.fn(),
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

const { getFullPackageInfo, getDownloadCount, getDownloadTrend } =
  await import('../data/npm.js')
const { getRepoInfo } = await import('../data/github.js')
const { logger } = await import('../utils/logger.js')
const { buildHealthFetcher, _resetGithubTokenWarnedForTests } =
  await import('./buildHealthFetcher.js')

const fullDoc = getFullPackageInfo as unknown as ReturnType<typeof vi.fn>
const dlCount = getDownloadCount as unknown as ReturnType<typeof vi.fn>
const trend = getDownloadTrend as unknown as ReturnType<typeof vi.fn>
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
    fullDoc.mockReset()
    dlCount.mockReset()
    trend.mockReset()
    repoInfo.mockReset()
    warn.mockReset()
    delete process.env.GITHUB_TOKEN
    _resetGithubTokenWarnedForTests()
  })

  it('getFullDoc 应代理到 npm.getFullPackageInfo', async () => {
    fullDoc.mockResolvedValueOnce({ name: 'react' })
    const f = buildHealthFetcher()
    const got = await f.getFullDoc('react')
    expect(got).toEqual({ name: 'react' })
    expect(fullDoc).toHaveBeenCalledWith('react', undefined, undefined)
  })

  it('getWeeklyDownloads 应使用 last-week 周期', async () => {
    dlCount.mockResolvedValueOnce(123)
    const f = buildHealthFetcher()
    await f.getWeeklyDownloads('react')
    expect(dlCount).toHaveBeenCalledWith('react', 'last-week', undefined)
  })

  it('getTrend 应代理到 npm.getDownloadTrend', async () => {
    trend.mockResolvedValueOnce('up')
    const f = buildHealthFetcher()
    expect(await f.getTrend('react')).toBe('up')
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
