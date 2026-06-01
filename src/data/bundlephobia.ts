/**
 * Bundlephobia 数据源（备用）
 *
 * Bundlephobia 历史上常因高负载返回 503，且数据库更新存在滞后；
 * 因此本工具默认走 pkg-size.dev，只在主源失败时 fallback 到这里。
 *
 * API: `GET https://bundlephobia.com/api/size?package={spec}&record=true`
 *
 * `record=true` 让 Bundlephobia 把查询结果记入它自己的 DB，
 * 后续其他用户查同包会更快——这对开源生态有益。
 */

import { NetworkError, PackageNotFoundError } from '../errors/index.js'
import type { BundleInfo } from '../types/analysis.js'
import { fetchJson } from './http.js'

const BASE_URL = 'https://bundlephobia.com/api'

/**
 * Bundlephobia 的响应字段（仅声明我们用到的部分）
 *
 * 注意：Bundlephobia **不提供 brotli 字段**；BundleInfo.brotli 为 optional 即可。
 */
interface BundlephobiaResponse {
  name: string
  version: string
  /** minified 字节数 */
  size: number
  /** gzip 字节数 */
  gzip: number
  dependencyCount: number
  hasJSModule: boolean
  hasJSNext: boolean
}

/**
 * 拉取包体积（备用源）
 *
 * @throws PackageNotFoundError 包不存在
 * @throws NetworkError         其他网络异常
 */
export async function getPackageSize(
  name: string,
  version?: string,
): Promise<BundleInfo> {
  const spec = version ? `${name}@${version}` : name
  const url = `${BASE_URL}/size?package=${encodeURIComponent(spec)}&record=true`

  let data: BundlephobiaResponse
  try {
    data = await fetchJson<BundlephobiaResponse>(url, { timeout: 15000 })
  } catch (err) {
    if (err instanceof NetworkError && err.status === 404) {
      throw new PackageNotFoundError(spec, { cause: err })
    }
    throw err
  }

  return {
    name: data.name,
    version: data.version,
    size: data.size,
    gzip: data.gzip,
    // brotli 故意不设：Bundlephobia 没有这个数据
    dependencyCount: data.dependencyCount,
    hasJSModule: data.hasJSModule,
    hasJSNext: data.hasJSNext,
    source: 'bundlephobia',
  }
}
