/**
 * dep-radar 自定义错误类
 *
 * 所有内部抛出的错误均继承自 DepRadarError，便于 CLI 顶层统一捕获、
 * 给用户友好的中文提示，并按错误类别决定退出码。
 *
 * 注意：
 * - 每个子类都需要自己设置 `name`，否则继承自父类的 `name` 会被错误使用
 * - 通过 `options.cause` 透传原始错误（Node 18+ Error 标准 cause 选项），
 *   方便排错时看到完整堆栈链
 */

interface ErrorOptions {
  cause?: unknown
}

/**
 * 所有 dep-radar 错误的基类
 *
 * 子类应：
 * 1. 调用 super(message, { cause }) 透传原始错误
 * 2. 自己设置 this.name
 * 3. 调用 super(message, code) 设置错误码（用于退出码映射）
 */
export class DepRadarError extends Error {
  /** 错误码，用于程序化判断与 CI 退出码映射 */
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options as { cause?: unknown })
    this.code = code
    this.name = 'DepRadarError'
  }
}

/**
 * 网络相关错误（HTTP 请求失败、超时、连接错误等）
 *
 * @param status HTTP 状态码；0 表示非 HTTP 错误（如 ECONNREFUSED）
 */
export class NetworkError extends DepRadarError {
  readonly status: number

  constructor(message: string, status = 0, options?: ErrorOptions) {
    super(message, 'NETWORK_ERROR', options)
    this.name = 'NetworkError'
    this.status = status
  }
}

/**
 * API 限流（HTTP 429 或 GitHub 类 rate limit header）
 *
 * 与 NetworkError 分开是因为：
 * - 限流通常需要更长的退避时间
 * - 限流不应被当作 5xx 服务异常对待
 */
export class RateLimitError extends DepRadarError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'RATE_LIMIT', options)
    this.name = 'RateLimitError'
  }
}

/**
 * 包不存在（npm registry 返回 404 / 本地 package.json 不存在）
 */
export class PackageNotFoundError extends DepRadarError {
  readonly packageName: string

  constructor(packageName: string, options?: ErrorOptions) {
    super(`未找到依赖包：${packageName}`, 'PACKAGE_NOT_FOUND', options)
    this.name = 'PackageNotFoundError'
    this.packageName = packageName
  }
}

/**
 * 用户配置文件出错（dep-radar.config.ts 解析失败、字段非法等）
 */
export class ConfigError extends DepRadarError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'CONFIG_ERROR', options)
    this.name = 'ConfigError'
  }
}
