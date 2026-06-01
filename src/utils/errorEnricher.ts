/**
 * 错误信息增强工具
 *
 * 为原始错误追加上下文提示（代理设置、认证、私有包等），
 * 帮助用户自助排查常见问题，而不是只看到一段晦涩的网络错误。
 *
 * 设计为纯函数，不修改原始错误对象，只返回增强后的提示字符串数组。
 */

import {
  ConfigError,
  NetworkError,
  PackageNotFoundError,
  RateLimitError,
} from '../errors/index.js'
import { EXIT_CODES, type ExitCode } from './exitCode.js'

// =====================================================================
// 公开 API
// =====================================================================

/**
 * 根据错误类型生成上下文提示列表
 *
 * 返回空数组表示无额外提示。
 */
export function getErrorHints(err: unknown): string[] {
  if (err instanceof NetworkError) return networkHints(err)
  if (err instanceof RateLimitError) return rateLimitHints()
  if (err instanceof PackageNotFoundError) return packageNotFoundHints()
  if (err instanceof ConfigError) return configHints(err)
  return []
}

/**
 * 将 DepRadarError.code 映射为 CLI 退出码
 *
 * 未映射的 code 统一返回 EXIT_CODES.ERROR (1)。
 */
export function errorCodeToExitCode(code: string): ExitCode {
  switch (code) {
    case 'NETWORK_ERROR':
    case 'RATE_LIMIT':
    case 'PACKAGE_NOT_FOUND':
    case 'CONFIG_ERROR':
      return EXIT_CODES.ERROR
    default:
      return EXIT_CODES.ERROR
  }
}

/**
 * 格式化错误输出：错误类名 + 消息 + 提示
 *
 * @param verbose 是否显示 error code（CI 调试用）
 */
export function formatError(err: unknown, verbose = false): string[] {
  const lines: string[] = []

  // 错误消息
  const msg = err instanceof Error ? err.message : String(err)
  lines.push(msg)

  // verbose 模式显示错误码
  if (verbose && err instanceof Error && 'code' in err) {
    lines.push(`[错误码: ${(err as { code: string }).code}]`)
  }

  // 上下文提示
  const hints = getErrorHints(err)
  for (const hint of hints) {
    lines.push(hint)
  }

  return lines
}

// =====================================================================
// 各错误类型的提示逻辑
// =====================================================================

function networkHints(err: NetworkError): string[] {
  const hints: string[] = []

  // 超时 / 连接失败 → 提示代理
  if (err.status === 0) {
    hints.push(
      '提示：如处于代理/内网环境，请检查 HTTPS_PROXY 环境变量或 --registry 选项',
    )
  }

  // 401/403 → 提示认证
  if (err.status === 401 || err.status === 403) {
    hints.push(
      '提示：该 API 需要认证，请检查 GITHUB_TOKEN 或 npm registry 的认证配置',
    )
  }

  // 404 from npm registry → 可能是私有包
  if (err.status === 404 && err.message.includes('registry.npmjs.org')) {
    hints.push('提示：该包可能为私有包或尚未发布，已标记为 unknown 继续分析')
  }

  return hints
}

function rateLimitHints(): string[] {
  return [
    '提示：已自动重试；如频繁触发限流，请设置 GITHUB_TOKEN 或减少并发（--concurrency）',
  ]
}

function packageNotFoundHints(): string[] {
  return ['提示：请确认当前目录存在 package.json，或通过参数指定项目路径']
}

function configHints(err: ConfigError): string[] {
  const hints: string[] = []
  if (err.message.includes('加载配置失败')) {
    hints.push(
      '提示：请检查配置文件语法是否正确（dep-radar.config.ts / .js / .json）',
    )
  }
  return hints
}
