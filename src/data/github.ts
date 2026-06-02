/**
 * GitHub REST API
 *
 * 用于获取仓库元信息：stars / open issues / 最近 push / 是否归档 / SPDX license。
 *
 * **限流提示**：未认证时 60 次/小时；认证后 5000 次/小时。
 * 通过 `GITHUB_TOKEN` 环境变量传入 token（CLI 启动时会检测并提示用户）。
 *
 * API 端点：`GET https://api.github.com/repos/{owner}/{repo}`
 */

import { NetworkError, PackageNotFoundError } from '../errors/index.js'
import type { GithubRepoResponse } from '../types/api.js'
import type { DataCache } from './cache.js'
import { fetchJson } from './http.js'

/**
 * 从 package.json 的 repository 字段中解析出 GitHub owner/repo
 *
 * 支持的输入格式：
 * - `"git+https://github.com/owner/repo.git"`
 * - `"https://github.com/owner/repo"`
 * - `"git@github.com:owner/repo.git"`
 * - `"github:owner/repo"`（npm 简写）
 * - `"owner/repo"`（npm 简写，但只有当 type 不明时才匹配）
 *
 * 非 GitHub 仓库（如 GitLab、Bitbucket）返回 null。
 *
 * @param repoUrl repository 字段值；可能是字符串或对象 `{ url: '...' }`
 */
export function parseGitHubUrl(
  repoUrl: string | { url?: string } | undefined,
): { owner: string; repo: string } | null {
  if (!repoUrl) return null
  const raw = typeof repoUrl === 'string' ? repoUrl : (repoUrl.url ?? '')
  if (!raw) return null

  // 处理 npm 简写 "github:owner/repo"
  const shorthand = raw.match(/^github:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/)
  if (shorthand) {
    const [, owner, repo] = shorthand
    return { owner: owner!, repo: repo! }
  }

  // 标准 URL 形式（http/https/ssh/git+...），核心是 `github.com[/:]owner/repo`
  const m = raw.match(
    /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:$|[/?#])/,
  )
  if (!m) return null
  const [, owner, repo] = m
  return { owner: owner!, repo: repo! }
}

/**
 * 拉取仓库元信息
 *
 * 自动从 `GITHUB_TOKEN` 读取认证 token。
 *
 * @throws PackageNotFoundError 仓库不存在或已被删除（HTTP 404）
 * @throws NetworkError         其他网络异常（含限流 429 / 鉴权 401）
 */
export async function getRepoInfo(
  owner: string,
  repo: string,
  cache?: DataCache,
): Promise<GithubRepoResponse> {
  const token = process.env.GITHUB_TOKEN
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`

  const fetchFn = async (): Promise<GithubRepoResponse> => {
    try {
      return await fetchJson<GithubRepoResponse>(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
    } catch (err) {
      if (err instanceof NetworkError && err.status === 404) {
        throw new PackageNotFoundError(`${owner}/${repo}`, { cause: err })
      }
      throw err
    }
  }

  if (cache) return cache.withCache(`github:${owner}/${repo}`, fetchFn)
  return fetchFn()
}
