/**
 * 统一 HTTP 客户端
 *
 * 集中处理：超时、重试、错误分类、统一 User-Agent。
 * 所有外部 API 调用都应通过 fetchJson 走这里，便于：
 * 1. 统一改 User-Agent / Accept 头
 * 2. 统一控制超时与重试策略
 * 3. 统一把网络层错误转换为 dep-radar 自定义错误类
 * 4. 离线模式下直接拦截，避免无意义的网络等待
 *
 * 注意：使用 Node 18+ 原生 fetch（基于 undici），无需 axios 等第三方库。
 */

import { NetworkError, RateLimitError } from '../errors/index.js'
import { withRetry } from '../utils/withRetry.js'

// =====================================================================
// 离线模式
// =====================================================================

let offlineOverride: boolean | null = null

/**
 * 设置离线模式（由 CLI --offline 选项调用）
 *
 * 传 null 恢复自动检测。
 */
export function setOfflineMode(value: boolean | null): void {
  offlineOverride = value
}

/**
 * 检测当前是否处于离线模式
 *
 * 优先级：setOfflineMode() 设置 > OFFLINE 环境变量 > 默认在线
 */
export function isOffline(): boolean {
  if (offlineOverride !== null) return offlineOverride
  return process.env.OFFLINE === '1' || process.env.OFFLINE === 'true'
}

/**
 * 全局 User-Agent
 *
 * 版本号通过 tsup define 在构建时注入（仅 CLI 入口）。
 */
declare const __DEP_RADAR_VERSION__: string
const USER_AGENT = `dep-radar/${typeof __DEP_RADAR_VERSION__ !== 'undefined' ? __DEP_RADAR_VERSION__ : 'dev'}`

export interface FetchOptions {
  /** 单次请求超时（毫秒），默认 10000 */
  timeout?: number
  /** 失败时最大重试次数，默认 3 */
  retries?: number
  /** 额外 HTTP 头（会与默认的 User-Agent/Accept 合并） */
  headers?: Record<string, string>
}

/**
 * 获取 JSON 数据，自动处理超时/重试/错误分类
 *
 * 错误映射规则：
 * - HTTP 429 → RateLimitError（会被重试）
 * - HTTP 5xx → NetworkError(status>=500)（会被重试）
 * - HTTP 4xx（除 429） → NetworkError（不会被重试，立即抛出）
 * - 超时 / AbortError → NetworkError(status=0)（会被重试）
 * - 其他网络异常（DNS 失败、TLS 错误等） → NetworkError(status=0)（会被重试）
 *
 * @example
 * const data = await fetchJson<NpmRegistryResponse>(
 *   `https://registry.npmjs.org/${name}/latest`
 * )
 */
export async function fetchJson<T>(
  url: string,
  options: FetchOptions = {},
): Promise<T> {
  // 离线模式：直接拦截，避免无意义的网络等待
  if (isOffline()) {
    throw new NetworkError(`离线模式下跳过网络请求：${url}`, 0)
  }

  const { timeout = 10000, retries = 3, headers = {} } = options

  return withRetry(
    async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        let res: Response
        try {
          res = await fetch(url, {
            signal: controller.signal,
            headers: {
              'User-Agent': USER_AGENT,
              Accept: 'application/json',
              ...headers,
            },
          })
        } catch (err) {
          // 区分超时与其他网络错误，给用户更准确的提示
          if (controller.signal.aborted) {
            throw new NetworkError(`请求超时（${timeout}ms）：${url}`, 0, {
              cause: err,
            })
          }
          throw new NetworkError(`网络请求失败：${url}`, 0, { cause: err })
        }

        if (res.status === 429) {
          throw new RateLimitError(`触发 API 限流（HTTP 429）：${url}`)
        }
        if (!res.ok) {
          throw new NetworkError(
            `HTTP ${res.status} ${res.statusText || ''}: ${url}`.trim(),
            res.status,
          )
        }

        try {
          return (await res.json()) as T
        } catch (err) {
          // 响应不是合法 JSON，多半是 API 异常返回了 HTML 错误页
          throw new NetworkError(`响应解析为 JSON 失败：${url}`, res.status, {
            cause: err,
          })
        }
      } finally {
        clearTimeout(timer)
      }
    },
    {
      retries,
      shouldRetry: err => {
        // 限流总是重试（指数退避会等更长时间）
        if (err instanceof RateLimitError) return true
        // 网络异常（status=0）或服务端错误（5xx）才重试；4xx 不重试
        if (err instanceof NetworkError) {
          return err.status === 0 || err.status >= 500
        }
        return false
      },
    },
  )
}
