/**
 * 多数据源 BundleFetcher 工厂
 *
 * 按 config.dataSource 顺序依次尝试，前一源失败（含 NetworkError / PackageNotFoundError）
 * 自动 fallback 到下一源。全部失败时抛最后一次的错误。
 *
 * 这是 PLAN 第四章"依赖注入模式"在 command 层的具体实现：
 * analyzer 只看到一个 BundleFetcher 接口，不关心背后是几个数据源。
 */

import type { BundleFetcher } from '../analyzers/bundle.js'
import { getPackageSize as fromBundlephobia } from '../data/bundlephobia.js'
import type { DataCache } from '../data/cache.js'
import { getPackageSize as fromPkgSize } from '../data/pkg-size.js'
import { PackageNotFoundError } from '../errors/index.js'
import { logger } from '../utils/logger.js'

/** 支持的数据源标识 */
export type DataSourceName = 'pkg-size' | 'bundlephobia' | 'local'

export interface BuildBundleFetcherOptions {
  /** 数据源优先级；默认 ['pkg-size', 'bundlephobia'] */
  dataSource?: DataSourceName[]
  /** 缓存实例；不传则不缓存 */
  cache?: DataCache
  /** 是否向 Bundlephobia 写入查询记录；默认 false */
  bundlephobiaRecord?: boolean
}

/**
 * 构造一个组合 fetcher
 *
 * 行为：
 * 1. 按 dataSource 顺序依次尝试
 * 2. 命中 PackageNotFoundError → 直接抛出（包确实不存在，无需 fallback）
 * 3. 其他错误（网络异常、限流等）→ 记 verbose 日志后 fallback 到下一源
 * 4. 全部源失败 → 抛最后一次错误
 *
 * 'local' 数据源通过动态导入 esbuild 实现（optionalDependency），
 * 未安装时自动跳过。
 */
export async function buildBundleFetcher(
  options: BuildBundleFetcherOptions = {},
): Promise<BundleFetcher> {
  const sources = (options.dataSource ?? ['pkg-size', 'bundlephobia']).filter(
    (s, i, arr) => arr.indexOf(s) === i, // 去重
  )

  const { cache, bundlephobiaRecord = false } = options
  const fetchers: Array<{ name: string; fn: BundleFetcher }> = []

  for (const s of sources) {
    if (s === 'pkg-size') {
      fetchers.push({
        name: s,
        fn: (name, version) => fromPkgSize(name, version, cache),
      })
    } else if (s === 'bundlephobia') {
      fetchers.push({
        name: s,
        fn: (name, version) =>
          fromBundlephobia(name, version, cache, bundlephobiaRecord),
      })
    } else if (s === 'local') {
      try {
        const { getPackageSize } = await import('../data/local-bundle.js')
        fetchers.push({
          name: s,
          fn: (name, version) => getPackageSize(name, version, cache),
        })
      } catch {
        logger.debug('local 数据源不可用（esbuild 未安装），跳过')
      }
    }
  }

  if (fetchers.length === 0) {
    throw new Error('无可用的数据源；请检查 config.dataSource 配置')
  }

  return async (name, version) => {
    let lastErr: unknown
    for (const { name: src, fn } of fetchers) {
      try {
        return await fn(name, version)
      } catch (err) {
        // 包确实不存在，不必再 fallback
        if (err instanceof PackageNotFoundError) throw err
        lastErr = err
        logger.debug(
          `数据源 "${src}" 拉取 ${name}@${version ?? 'latest'} 失败：${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    throw lastErr
  }
}
