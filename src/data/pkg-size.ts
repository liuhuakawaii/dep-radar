/**
 * pkg-size.dev 数据源（主）
 *
 * 通过 pkg-size.dev 的 JSON API 获取包的真实 esbuild 打包体积。
 *
 * 注意：
 * - API 路径基于 PLAN 中的设计，若未来 pkg-size.dev 调整 endpoint，
 *   只需在此文件改 BASE_URL；不影响业务层
 * - 该数据源失败时由 buildBundleFetcher（commands/analyze.ts）自动 fallback
 *   到 Bundlephobia 或本地 esbuild
 */

import { NetworkError, PackageNotFoundError } from '../errors/index.js'
import type { BundleInfo } from '../types/analysis.js'
import type { PkgSizeResponse } from '../types/api.js'
import type { DataCache } from './cache.js'
import { fetchJson } from './http.js'

const BASE_URL = 'https://pkg-size.dev/api'

/**
 * 拉取指定包的体积信息
 *
 * @param name    包名，支持 scoped（如 `@scope/pkg`）
 * @param version 指定版本；不传则按 latest 解析
 * @throws PackageNotFoundError 包不存在（HTTP 404）
 * @throws NetworkError         其他网络异常（已含 5xx 重试）
 */
export async function getPackageSize(
  name: string,
  version?: string,
  cache?: DataCache,
): Promise<BundleInfo> {
  // pkg-size.dev 的 URL 格式接受 scoped 包名中的 `@` 和 `/`，
  // 因此用 encodeURI 而非 encodeURIComponent，避免把它们编码掉
  const spec = version ? `${name}@${version}` : name
  const url = `${BASE_URL}/${encodeURI(spec)}`

  const fetchFn = async (): Promise<BundleInfo> => {
    let data: PkgSizeResponse
    try {
      data = await fetchJson<PkgSizeResponse>(url, {
        timeout: 15000,
        retries: 1,
      })
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
      brotli: data.brotli,
      dependencyCount: data.dependencyCount,
      hasJSModule: data.hasJSModule,
      hasJSNext: data.hasJSNext,
      source: 'pkg-size',
      isDirect: true, // 默认值，调用方会覆盖
    }
  }

  if (cache) return cache.withCacheOrError(`pkg-size:${spec}`, fetchFn)
  return fetchFn()
}
