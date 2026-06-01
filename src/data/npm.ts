/**
 * npm registry & downloads API
 *
 * 提供：
 * - 包元信息（manifest / 完整 document）
 * - 下载量（点查询、范围查询）
 * - 下载量趋势（基于近一月数据的简易算法）
 *
 * API 端点：
 * - https://registry.npmjs.org/{name}        — 完整 document（含所有版本、time、tags）
 * - https://registry.npmjs.org/{name}/latest — 仅最新版本的 manifest（轻量）
 * - https://api.npmjs.org/downloads/{...}    — 下载量
 */

import { NetworkError, PackageNotFoundError } from '../errors/index.js'
import type {
  NpmDownloadsRangeResponse,
  NpmDownloadsResponse,
  NpmFullDocResponse,
  NpmRegistryResponse,
} from '../types/api.js'
import { fetchJson } from './http.js'

const REGISTRY_URL = 'https://registry.npmjs.org'
const DOWNLOADS_URL = 'https://api.npmjs.org/downloads'

/** 把任意源的 NetworkError(404) 统一转成 PackageNotFoundError */
async function withNotFound<T>(
  packageName: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof NetworkError && err.status === 404) {
      throw new PackageNotFoundError(packageName, { cause: err })
    }
    throw err
  }
}

/**
 * 拉取包的 latest manifest（轻量）
 *
 * 适合只需要"最新版本的 license/types/deprecated"等场景。
 * 注意：`time` 字段在 /latest 中不可用。
 */
export async function getPackageInfo(
  name: string,
): Promise<NpmRegistryResponse> {
  return withNotFound(name, () =>
    fetchJson<NpmRegistryResponse>(
      `${REGISTRY_URL}/${encodeURIComponent(name)}/latest`,
    ),
  )
}

/**
 * 拉取包的完整 document（含所有版本与 time）
 *
 * 适合 health analyzer 需要 lastPublish、maintainers 完整列表的场景。
 *
 * **注意**：完整 document 数据量较大（热门包可达数 MB），
 * 应配合缓存使用，避免每次 cold start 都拉。
 */
export async function getFullPackageInfo(
  name: string,
): Promise<NpmFullDocResponse> {
  return withNotFound(name, () =>
    fetchJson<NpmFullDocResponse>(
      `${REGISTRY_URL}/${encodeURIComponent(name)}`,
    ),
  )
}

/**
 * 拉取指定时段的下载总数
 *
 * @param period 'last-day' / 'last-week' / 'last-month'
 */
export async function getDownloadCount(
  name: string,
  period: 'last-day' | 'last-week' | 'last-month',
): Promise<number> {
  const res = await withNotFound(name, () =>
    fetchJson<NpmDownloadsResponse>(
      `${DOWNLOADS_URL}/point/${period}/${encodeURIComponent(name)}`,
    ),
  )
  return res.downloads
}

/**
 * 拉取近一月的每日下载量明细
 *
 * 用于 getDownloadTrend；其他场景一般不需要。
 */
export async function getDownloadRange(
  name: string,
): Promise<NpmDownloadsRangeResponse> {
  return withNotFound(name, () =>
    fetchJson<NpmDownloadsRangeResponse>(
      `${DOWNLOADS_URL}/range/last-month/${encodeURIComponent(name)}`,
    ),
  )
}

/**
 * 计算包的下载量趋势（up / down / stable）
 *
 * 算法：取近一月每日下载量，对比前半月与后半月总和。
 * - 后半月 / 前半月 > 1.1 → 'up'（增长 > 10%）
 * - 后半月 / 前半月 < 0.9 → 'down'（下降 > 10%）
 * - 其余 → 'stable'
 *
 * 数据点不足 14 天时（新包）一律返回 'stable'，避免误报。
 */
export async function getDownloadTrend(
  name: string,
): Promise<'up' | 'down' | 'stable'> {
  const res = await getDownloadRange(name)
  const days = res.downloads
  if (days.length < 14) return 'stable'

  const mid = Math.floor(days.length / 2)
  const firstHalf = days.slice(0, mid).reduce((s, d) => s + d.downloads, 0)
  const secondHalf = days.slice(mid).reduce((s, d) => s + d.downloads, 0)

  // 前半月为 0（如新包或异常）时，直接看后半月是否有下载
  if (firstHalf === 0) return secondHalf > 0 ? 'up' : 'stable'

  const ratio = secondHalf / firstHalf
  if (ratio > 1.1) return 'up'
  if (ratio < 0.9) return 'down'
  return 'stable'
}
