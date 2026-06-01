/**
 * 格式化工具函数
 *
 * 纯函数，无副作用，零外部依赖。
 * 所有展示给用户的数字、日期都应通过这些函数统一格式，便于风格一致。
 */

/**
 * 字节数格式化为人类可读字符串
 *
 * 使用 1024 进制（二进制单位），与多数前端工具一致（webpack-bundle-analyzer 等）。
 *
 * @example
 * formatBytes(0)        // "0 B"
 * formatBytes(1024)     // "1.00 KB"
 * formatBytes(320_000)  // "312.50 KB"
 * formatBytes(1_200_000) // "1.14 MB"
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '— B'
  if (bytes === 0) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const k = 1024
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    units.length - 1,
  )
  const value = bytes / Math.pow(k, i)
  return i === 0 ? `${value} B` : `${value.toFixed(2)} ${units[i]}`
}

/**
 * ISO 字符串格式化为 YYYY-MM-DD
 *
 * 使用 UTC 避免时区差异（CI / 本地结果一致）。
 * 输入非法时返回原字符串。
 *
 * @example
 * formatDate("2026-06-01T10:00:00.000Z")  // "2026-06-01"
 */
export function formatDate(isoString: string): string {
  const d = new Date(isoString)
  if (Number.isNaN(d.getTime())) return isoString
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * 数字加千位分隔符
 *
 * @example
 * formatNumber(1234567)  // "1,234,567"
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  return n.toLocaleString('en-US')
}

/**
 * ISO 字符串格式化为中文相对时间
 *
 * 自实现以避免引入 date-fns / dayjs 等依赖（CLI 体积敏感）。
 * 用于"最近发布于 5 个月前"这类展示。
 *
 * @example
 * formatRelativeTime("2026-06-01T10:00:00Z", "2026-06-01T10:00:30Z")  // "刚刚"
 * formatRelativeTime("2026-05-25T00:00:00Z", "2026-06-01T00:00:00Z")  // "7 天前"
 *
 * @param isoString 目标时间 ISO 字符串
 * @param now      参考"现在"时间，默认为 Date.now()；测试中可注入
 */
export function formatRelativeTime(
  isoString: string,
  now: number = Date.now(),
): string {
  const t = new Date(isoString).getTime()
  if (Number.isNaN(t)) return isoString

  const diffSec = Math.floor((now - t) / 1000)
  const absSec = Math.abs(diffSec)
  const suffix = diffSec >= 0 ? '前' : '后'

  if (absSec < 60) return '刚刚'

  const units: Array<[number, string]> = [
    [60, '秒'],
    [60, '分钟'],
    [24, '小时'],
    [30, '天'],
    [12, '个月'],
    [Number.POSITIVE_INFINITY, '年'],
  ]

  let value = absSec
  for (let i = 0; i < units.length; i++) {
    const [divisor, label] = units[i]!
    if (i === units.length - 1 || value < divisor) {
      return `${Math.floor(value)} ${label}${suffix}`
    }
    value = value / divisor
  }
  return isoString
}
