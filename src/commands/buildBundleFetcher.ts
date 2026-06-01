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
import { getPackageSize as fromPkgSize } from '../data/pkg-size.js'
import { PackageNotFoundError } from '../errors/index.js'
import { logger } from '../utils/logger.js'

/** 支持的数据源标识 */
export type DataSourceName = 'pkg-size' | 'bundlephobia' | 'local'

/** 各数据源的实现 map */
const SOURCES: Record<Exclude<DataSourceName, 'local'>, BundleFetcher> = {
  'pkg-size': fromPkgSize,
  bundlephobia: fromBundlephobia,
  // 'local': 在 Phase 3 实现（src/data/local-bundle.ts）
}

export interface BuildBundleFetcherOptions {
  /** 数据源优先级；默认 ['pkg-size', 'bundlephobia'] */
  dataSource?: DataSourceName[]
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
 * 当某源未在 SOURCES 中实现（如 'local'），会跳过并打 warn。
 */
export function buildBundleFetcher(
  options: BuildBundleFetcherOptions = {},
): BundleFetcher {
  const sources = (options.dataSource ?? ['pkg-size', 'bundlephobia']).filter(
    (s, i, arr) => arr.indexOf(s) === i, // 去重
  )

  const fetchers: Array<{ name: string; fn: BundleFetcher }> = []
  for (const s of sources) {
    if (s === 'local') {
      logger.warn(
        `数据源 "local" 暂未实现（将在 Phase 3 接入本地 esbuild），跳过`,
      )
      continue
    }
    fetchers.push({ name: s, fn: SOURCES[s] })
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
