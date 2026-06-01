import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NetworkError, PackageNotFoundError } from '../errors/index.js'

vi.mock('./http.js', () => ({
  fetchJson: vi.fn(),
}))

const { fetchJson } = await import('./http.js')
const { parseGitHubUrl, getRepoInfo } = await import('./github.js')

const mockedFetchJson = fetchJson as unknown as ReturnType<typeof vi.fn>

describe('parseGitHubUrl', () => {
  it('解析 https://github.com/owner/repo', () => {
    expect(parseGitHubUrl('https://github.com/lodash/lodash')).toEqual({
      owner: 'lodash',
      repo: 'lodash',
    })
  })

  it('解析 git+https URL（带 .git 后缀）', () => {
    expect(parseGitHubUrl('git+https://github.com/facebook/react.git')).toEqual(
      {
        owner: 'facebook',
        repo: 'react',
      },
    )
  })

  it('解析 git@github.com SSH 形式', () => {
    expect(parseGitHubUrl('git@github.com:vuejs/core.git')).toEqual({
      owner: 'vuejs',
      repo: 'core',
    })
  })

  it('解析 npm 简写 "github:owner/repo"', () => {
    expect(parseGitHubUrl('github:tj/commander.js')).toEqual({
      owner: 'tj',
      repo: 'commander.js',
    })
  })

  it('解析对象形式 { url: "..." }', () => {
    expect(
      parseGitHubUrl({ url: 'https://github.com/sindresorhus/ky' }),
    ).toEqual({ owner: 'sindresorhus', repo: 'ky' })
  })

  it('能识别带子路径的 URL', () => {
    expect(
      parseGitHubUrl(
        'https://github.com/withastro/astro/tree/main/packages/astro',
      ),
    ).toEqual({ owner: 'withastro', repo: 'astro' })
  })

  it('GitLab/Bitbucket 等非 GitHub URL 应返回 null', () => {
    expect(parseGitHubUrl('https://gitlab.com/owner/repo')).toBeNull()
    expect(parseGitHubUrl('https://bitbucket.org/owner/repo')).toBeNull()
  })

  it('undefined / null / 空对象 应返回 null', () => {
    expect(parseGitHubUrl(undefined)).toBeNull()
    expect(parseGitHubUrl('')).toBeNull()
    expect(parseGitHubUrl({})).toBeNull()
    expect(parseGitHubUrl({ url: '' })).toBeNull()
  })
})

describe('getRepoInfo', () => {
  const originalToken = process.env.GITHUB_TOKEN

  beforeEach(() => {
    mockedFetchJson.mockReset()
    delete process.env.GITHUB_TOKEN
  })

  afterEach(() => {
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = originalToken
  })

  it('正常响应直接透传', async () => {
    const payload = {
      stargazers_count: 1000,
      open_issues_count: 10,
      pushed_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
      archived: false,
      license: { spdx_id: 'MIT' },
    }
    mockedFetchJson.mockResolvedValueOnce(payload)
    const got = await getRepoInfo('lodash', 'lodash')
    expect(got).toEqual(payload)
  })

  it('应该请求正确的 endpoint 并 URL 编码 owner/repo', async () => {
    mockedFetchJson.mockResolvedValueOnce({})
    await getRepoInfo('@scope', 'pkg')
    const [url] = mockedFetchJson.mock.calls[0]!
    expect(url).toBe('https://api.github.com/repos/%40scope/pkg')
  })

  it('无 GITHUB_TOKEN 时不应带 Authorization 头', async () => {
    mockedFetchJson.mockResolvedValueOnce({})
    await getRepoInfo('a', 'b')
    const [, opts] = mockedFetchJson.mock.calls[0]!
    expect(opts.headers).toEqual({})
  })

  it('有 GITHUB_TOKEN 时带 Bearer 认证头', async () => {
    process.env.GITHUB_TOKEN = 'ghp_secret'
    mockedFetchJson.mockResolvedValueOnce({})
    await getRepoInfo('a', 'b')
    const [, opts] = mockedFetchJson.mock.calls[0]!
    expect(opts.headers.Authorization).toBe('Bearer ghp_secret')
  })

  it('404 应转抛 PackageNotFoundError', async () => {
    mockedFetchJson.mockRejectedValueOnce(new NetworkError('not found', 404))
    let caught: unknown
    await getRepoInfo('a', 'b').catch(e => {
      caught = e
    })
    expect(caught).toBeInstanceOf(PackageNotFoundError)
  })

  it('其他错误（如 401 鉴权）应原样向上抛', async () => {
    mockedFetchJson.mockRejectedValueOnce(new NetworkError('unauth', 401))
    let caught: unknown
    await getRepoInfo('a', 'b').catch(e => {
      caught = e
    })
    expect(caught).toBeInstanceOf(NetworkError)
    expect(caught).not.toBeInstanceOf(PackageNotFoundError)
  })
})
