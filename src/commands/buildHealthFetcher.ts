/**
 * HealthFetcher 工厂
 *
 * 把 data 层的原子函数（npm latest manifest / npm meta / download stats / github）
 * 组合为 analyzer 需要的 HealthFetcher 接口；额外职责：
 *
 *   1. GitHub 调用**软失败**：私有仓库、限流、网络异常等情况下返回 null，
 *      让 analyzer 不必处理 GitHub 错误细节
 *   2. 启动时一次性提示 GITHUB_TOKEN 未设置（仅在用到 GitHub 数据时提示一次），
 *      避免每条记录都警告
 */

import type { HealthFetcher } from '../analyzers/health.js'
import type { DataCache } from '../data/cache.js'
import { getRepoInfo } from '../data/github.js'
import {
  getDownloadStats,
  getPackageInfo,
  getPackageMeta,
} from '../data/npm.js'
import { logger } from '../utils/logger.js'

let githubTokenWarned = false

export interface BuildHealthFetcherOptions {
  /** 缓存实例；不传则不缓存 */
  cache?: DataCache
  /** 自定义 npm registry URL */
  registry?: string
}

/**
 * 构造默认的 HealthFetcher 实现
 */
export function buildHealthFetcher(
  options: BuildHealthFetcherOptions = {},
): HealthFetcher {
  const { cache, registry } = options
  return {
    getLiteDoc: name => getPackageInfo(name, cache, registry),
    getMeta: name => getPackageMeta(name, cache, registry),
    getDownloadStats: name => getDownloadStats(name, cache),
    getGitHubRepo: async (owner, repo) => {
      maybeWarnGitHubToken()
      try {
        return await getRepoInfo(owner, repo, cache)
      } catch (err) {
        logger.debug(
          `GitHub 仓库 ${owner}/${repo} 拉取失败：${err instanceof Error ? err.message : String(err)}`,
        )
        return null
      }
    },
  }
}

/**
 * 在用到 GitHub 数据但未设置 GITHUB_TOKEN 时，整次运行只警告一次
 *
 * 公共 GitHub API 未认证为 60 次/小时，对依赖较多的项目会触发限流。
 */
function maybeWarnGitHubToken(): void {
  if (githubTokenWarned) return
  if (process.env.GITHUB_TOKEN) return
  logger.warn(
    '未检测到 GITHUB_TOKEN 环境变量。GitHub API 未认证时限流为 60 次/小时，' +
      '依赖较多的项目建议配置 GITHUB_TOKEN 以获取完整健康度数据。',
  )
  githubTokenWarned = true
}

/**
 * 仅测试用：重置 GITHUB_TOKEN 警告标志
 *
 * 让单元测试可以验证多次实例化的告警行为。
 */
export function _resetGithubTokenWarnedForTests(): void {
  githubTokenWarned = false
}
