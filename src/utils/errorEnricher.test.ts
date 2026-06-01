import { describe, expect, it } from 'vitest'

import {
  ConfigError,
  NetworkError,
  PackageNotFoundError,
  RateLimitError,
} from '../errors/index.js'

import {
  errorCodeToExitCode,
  formatError,
  getErrorHints,
} from './errorEnricher.js'
import { EXIT_CODES } from './exitCode.js'

// =====================================================================
// getErrorHints
// =====================================================================

describe('getErrorHints', () => {
  it('NetworkError（status=0，超时/连接失败）应提示代理', () => {
    const hints = getErrorHints(new NetworkError('请求超时', 0))
    expect(hints).toHaveLength(1)
    expect(hints[0]).toContain('HTTPS_PROXY')
  })

  it('NetworkError（status=401）应提示认证', () => {
    const hints = getErrorHints(new NetworkError('HTTP 401', 401))
    expect(hints).toHaveLength(1)
    expect(hints[0]).toContain('认证')
  })

  it('NetworkError（status=403）应提示认证', () => {
    const hints = getErrorHints(new NetworkError('HTTP 403', 403))
    expect(hints).toHaveLength(1)
    expect(hints[0]).toContain('GITHUB_TOKEN')
  })

  it('NetworkError（status=404 + registry.npmjs.org）应提示私有包', () => {
    const hints = getErrorHints(
      new NetworkError(
        'HTTP 404: https://registry.npmjs.org/@private/pkg',
        404,
      ),
    )
    expect(hints).toHaveLength(1)
    expect(hints[0]).toContain('私有包')
  })

  it('NetworkError（status=404 + 非 registry URL）不应提示私有包', () => {
    const hints = getErrorHints(
      new NetworkError('HTTP 404: https://api.github.com/repos/x/y', 404),
    )
    expect(hints).toHaveLength(0)
  })

  it('NetworkError（status=500）应无额外提示', () => {
    const hints = getErrorHints(new NetworkError('HTTP 500', 500))
    expect(hints).toHaveLength(0)
  })

  it('RateLimitError 应提示限流', () => {
    const hints = getErrorHints(new RateLimitError('限流'))
    expect(hints).toHaveLength(1)
    expect(hints[0]).toContain('GITHUB_TOKEN')
  })

  it('PackageNotFoundError 应提示检查路径', () => {
    const hints = getErrorHints(new PackageNotFoundError('test'))
    expect(hints).toHaveLength(1)
    expect(hints[0]).toContain('package.json')
  })

  it('ConfigError（加载失败）应提示检查语法', () => {
    const hints = getErrorHints(new ConfigError('加载配置失败：syntax error'))
    expect(hints).toHaveLength(1)
    expect(hints[0]).toContain('语法')
  })

  it('ConfigError（非加载失败）应无额外提示', () => {
    const hints = getErrorHints(new ConfigError('配置文件内容不是对象'))
    expect(hints).toHaveLength(0)
  })

  it('普通 Error 应无额外提示', () => {
    expect(getErrorHints(new Error('boom'))).toHaveLength(0)
  })

  it('非 Error 值应无额外提示', () => {
    expect(getErrorHints('string error')).toHaveLength(0)
    expect(getErrorHints(null)).toHaveLength(0)
  })
})

// =====================================================================
// errorCodeToExitCode
// =====================================================================

describe('errorCodeToExitCode', () => {
  it.each([
    ['NETWORK_ERROR', EXIT_CODES.ERROR],
    ['RATE_LIMIT', EXIT_CODES.ERROR],
    ['PACKAGE_NOT_FOUND', EXIT_CODES.ERROR],
    ['CONFIG_ERROR', EXIT_CODES.ERROR],
    ['UNKNOWN_CODE', EXIT_CODES.ERROR],
  ])('code=%s → exit %d', (code, expected) => {
    expect(errorCodeToExitCode(code)).toBe(expected)
  })
})

// =====================================================================
// formatError
// =====================================================================

describe('formatError', () => {
  it('应包含错误消息', () => {
    const lines = formatError(new Error('something broke'))
    expect(lines).toContain('something broke')
  })

  it('DepRadarError 应包含上下文提示', () => {
    const lines = formatError(new NetworkError('请求超时', 0))
    // 至少有消息 + 1 条提示
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines.some(l => l.includes('HTTPS_PROXY'))).toBe(true)
  })

  it('verbose=true 且有 code 时应显示错误码', () => {
    const lines = formatError(new NetworkError('err', 0), true)
    expect(lines.some(l => l.includes('NETWORK_ERROR'))).toBe(true)
  })

  it('verbose=false 时不应显示错误码', () => {
    const lines = formatError(new NetworkError('err', 0), false)
    expect(lines.some(l => l.includes('NETWORK_ERROR'))).toBe(false)
  })

  it('普通 Error 无 code 时 verbose 也不显示错误码', () => {
    const lines = formatError(new Error('plain'), true)
    expect(lines).toEqual(['plain'])
  })
})
