/**
 * 通用指数退避重试
 *
 * 用于包裹可能瞬时失败的异步操作（HTTP 请求、I/O 等）。
 * 配合 shouldRetry 可控制只对特定错误类型重试（如 5xx / RateLimitError），
 * 避免对 4xx 这类"调用方错误"做无意义重试。
 */

export interface WithRetryOptions {
  /** 最大重试次数（不含第一次调用），默认 3 */
  retries?: number
  /** 第一次重试前的延迟（毫秒），默认 500 */
  minDelay?: number
  /** 退避延迟上限（毫秒），默认 5000 */
  maxDelay?: number
  /**
   * 决定是否对当前错误重试
   *
   * 返回 false 时立即抛出错误，不再重试。
   * 不传时默认所有错误都重试。
   */
  shouldRetry?: (err: unknown, attempt: number) => boolean
}

/**
 * 指数退避重试包装器
 *
 * 退避策略：minDelay * 2^attempt，封顶 maxDelay
 *
 * @example
 * await withRetry(() => fetch(url), {
 *   retries: 3,
 *   shouldRetry: err => err instanceof NetworkError && err.status >= 500,
 * })
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: WithRetryOptions = {},
): Promise<T> {
  const { retries = 3, minDelay = 500, maxDelay = 5000, shouldRetry } = options

  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === retries) break
      if (shouldRetry && !shouldRetry(err, attempt)) break
      const delay = Math.min(minDelay * 2 ** attempt, maxDelay)
      await new Promise<void>(r => setTimeout(r, delay))
    }
  }
  throw lastErr
}
