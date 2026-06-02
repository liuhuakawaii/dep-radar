/**
 * 包体积分析器
 *
 * 输入：DependencyEntry[]（来自 DependencyInventory）+ BundleFetcher（数据源由调用方注入）
 * 输出：每个依赖的 BundleInfo + 总体积 + topN 体积大户
 *
 * 设计要点：
 * - 依赖注入：analyzer 不直接 import 数据源，便于测试与多源 fallback
 * - 并发控制：用 p-limit 控制并发数，避免触发 API 限流
 * - 容错：单个包获取失败不阻断整体分析，标记为 source='unknown'
 * - 版本来源：使用 inventory 中的 resolvedVersion（lockfile / node_modules），而非声明版本
 */

import pLimit from 'p-limit'

import type { BundleInfo } from '../types/analysis.js'
import type { DependencyEntry } from '../types/inventory.js'
import type { PackageJson } from '../types/package.js'
import { buildIgnoreMatcher } from '../utils/ignore.js'

/**
 * 数据源接口：根据包名与版本号返回 BundleInfo
 *
 * 实现由调用方提供，可以是 pkg-size / bundlephobia / 本地 esbuild 等任一数据源，
 * 也可以是多源 fallback 的组合（见 commands/analyze.ts 中的 buildBundleFetcher）。
 */
export type BundleFetcher = (
  name: string,
  version?: string,
) => Promise<BundleInfo>

export interface AnalyzeBundleOptions {
  /** 同时进行的请求数，默认 5；过高会触发 API 限流 */
  concurrency?: number
  /** topN 体积大户的 N，默认 10 */
  topN?: number
  /** 是否同时分析 devDependencies，默认 false（只看运行时） */
  includeDev?: boolean
  /**
   * 分析范围过滤
   *
   * - 'runtime': 只分析 runtime 和 unknown 的包（默认）
   * - 'all': 分析所有包（旧行为）
   * - 'non-runtime': 只分析 build/test/script/config 的包
   */
  scope?: 'runtime' | 'all' | 'non-runtime'
  /**
   * 忽略的包名模式列表
   *
   * 支持：
   * - 精确匹配：`'lodash'`
   * - 末尾通配符：`'@internal/*'`（匹配该 scope 下所有包）
   *
   * 不支持完整 glob（避免引入 micromatch 依赖）。
   */
  ignore?: string[]
  /** 每个包完成时的进度回调 */
  onProgress?: (info: { current: number; total: number; name: string }) => void
  /** 每个包完成时的结果回调（verbose 模式逐包输出用） */
  onResult?: (info: {
    current: number
    total: number
    result: BundleInfo
  }) => void
}

export interface BundleAnalysisResult {
  /** 全部依赖的体积信息（含失败项，按依赖顺序） */
  bundles: BundleInfo[]
  /** 全部依赖 minified 字节数总和 */
  totalSize: number
  /** 全部依赖 gzip 字节数总和 */
  totalGzip: number
  /** 体积最大的前 N 个（按 gzip 降序） */
  topN: BundleInfo[]
  /** 被 ignore 配置或非标协议跳过的包名列表（便于日志展示） */
  skipped: Array<{ name: string; reason: string }>
}

// =====================================================================
// 主函数（新版：接受 DependencyEntry[]）
// =====================================================================

export async function analyzeBundleSize(
  entries: DependencyEntry[],
  fetchSize: BundleFetcher,
  options: AnalyzeBundleOptions = {},
): Promise<BundleAnalysisResult> {
  const {
    concurrency = 5,
    topN = 10,
    ignore = [],
    scope = 'runtime',
    onProgress,
    onResult,
  } = options

  const limit = pLimit(Math.max(1, concurrency))
  const isIgnored = buildIgnoreMatcher(ignore)

  const skipped: Array<{ name: string; reason: string }> = []
  const bundles: BundleInfo[] = []

  // 过滤 + 准备 fetch 列表
  const toFetch: Array<{ name: string; packageName: string; version: string }> =
    []
  for (const entry of entries) {
    if (isIgnored(entry.name)) {
      skipped.push({ name: entry.name, reason: '被 ignore 配置匹配' })
      continue
    }

    // scope 过滤：根据 usageClass 决定是否参与体积分析
    if (scope !== 'all' && entry.usageClass) {
      const isRuntime =
        entry.usageClass === 'runtime' || entry.usageClass === 'unknown'
      if (scope === 'runtime' && !isRuntime) {
        skipped.push({
          name: entry.name,
          reason: `分类为 ${entry.usageClass}，不在 runtime 分析范围内`,
        })
        continue
      }
      if (scope === 'non-runtime' && isRuntime) {
        skipped.push({
          name: entry.name,
          reason: `分类为 ${entry.usageClass}，不在 non-runtime 分析范围内`,
        })
        continue
      }
    }

    // 跳过非 npm 协议（workspace/file/link 等）且 confidence 为 low 的
    if (entry.resolvedVersion === '0.0.0' && entry.confidence === 'low') {
      // package.json fallback 时无法解析版本的条目
      skipped.push({
        name: entry.name,
        reason: '版本号无法解析（package.json fallback）',
      })
      continue
    }
    toFetch.push({
      name: entry.name,
      packageName: entry.packageName,
      version: entry.resolvedVersion,
    })
  }

  let completed = 0
  const total = toFetch.length

  const fetched = await Promise.all(
    toFetch.map(({ name, packageName, version }) =>
      limit(async (): Promise<BundleInfo> => {
        let result: BundleInfo
        try {
          result = await fetchSize(packageName, version)
        } catch (err) {
          // 单包失败不阻断整体；记录错误信息让用户能定位
          result = {
            name,
            version,
            size: 0,
            gzip: 0,
            dependencyCount: 0,
            hasJSModule: false,
            hasJSNext: false,
            source: 'unknown',
            error: err instanceof Error ? err.message : String(err),
          }
        }
        // 标注 resolvedVersion
        result.resolvedVersion = version
        completed++
        onProgress?.({ current: completed, total, name })
        onResult?.({ current: completed, total, result })
        return result
      }),
    ),
  )

  bundles.push(...fetched)

  const sorted = [...bundles].sort((a, b) => b.gzip - a.gzip)

  return {
    bundles,
    totalSize: bundles.reduce((s, b) => s + b.size, 0),
    totalGzip: bundles.reduce((s, b) => s + b.gzip, 0),
    topN: sorted.slice(0, Math.max(0, topN)),
    skipped,
  }
}

// =====================================================================
// 旧版兼容入口（接受 PackageJson，内部走 resolveSpec）
// =====================================================================

/**
 * 旧版入口：接受 PackageJson，内部解析版本
 *
 * @deprecated 新代码应使用 buildInventory() + analyzeBundleSize(entries, fetcher)
 */
export async function analyzeBundleSizeFromPackage(
  pkg: PackageJson,
  fetchSize: BundleFetcher,
  options: AnalyzeBundleOptions = {},
): Promise<BundleAnalysisResult> {
  const {
    concurrency = 5,
    topN = 10,
    includeDev = false,
    ignore = [],
    onProgress,
    onResult,
  } = options

  const limit = pLimit(Math.max(1, concurrency))
  const isIgnored = buildIgnoreMatcher(ignore)

  // 合并要分析的依赖列表
  const deps: Array<[string, string]> = [
    ...Object.entries(pkg.dependencies ?? {}),
    ...(includeDev ? Object.entries(pkg.devDependencies ?? {}) : []),
  ]

  const skipped: Array<{ name: string; reason: string }> = []
  const bundles: BundleInfo[] = []

  // 先扫一遍做协议/ignore 过滤，再发起并发请求
  const toFetch: Array<{ name: string; version?: string }> = []
  for (const [name, raw] of deps) {
    if (isIgnored(name)) {
      skipped.push({ name, reason: '被 ignore 配置匹配' })
      continue
    }
    const spec = resolveSpec(raw)
    if (spec.skip) {
      skipped.push({ name, reason: spec.skip })
      continue
    }
    toFetch.push({ name, version: spec.version })
  }

  let completed = 0
  const total = toFetch.length

  const fetched = await Promise.all(
    toFetch.map(({ name, version }) =>
      limit(async (): Promise<BundleInfo> => {
        let result: BundleInfo
        try {
          result = await fetchSize(name, version)
        } catch (err) {
          result = {
            name,
            version: version ?? '',
            size: 0,
            gzip: 0,
            dependencyCount: 0,
            hasJSModule: false,
            hasJSNext: false,
            source: 'unknown',
            error: err instanceof Error ? err.message : String(err),
          }
        }
        completed++
        onProgress?.({ current: completed, total, name })
        onResult?.({ current: completed, total, result })
        return result
      }),
    ),
  )

  bundles.push(...fetched)

  const sorted = [...bundles].sort((a, b) => b.gzip - a.gzip)

  return {
    bundles,
    totalSize: bundles.reduce((s, b) => s + b.size, 0),
    totalGzip: bundles.reduce((s, b) => s + b.gzip, 0),
    topN: sorted.slice(0, Math.max(0, topN)),
    skipped,
  }
}

// =====================================================================
// 辅助函数（保留供旧版入口和外部使用）
// =====================================================================

/**
 * 解析 package.json dependencies 的版本号字符串
 *
 * @returns
 * - `{ version: '1.2.3' }`         — 正常解析
 * - `{ version: undefined }`       — `*` / `latest` 等，让数据源用最新版本
 * - `{ skip: '原因' }`             — 非 npm 标准协议（workspace/file/link/git/http 等）
 *
 * @example
 * resolveSpec('^1.2.3')        → { version: '1.2.3' }
 * resolveSpec('~4.5.0')        → { version: '4.5.0' }
 * resolveSpec('>=1 <2')        → { version: '1' }
 * resolveSpec('*')             → { version: undefined }
 * resolveSpec('latest')        → { version: undefined }
 * resolveSpec('workspace:*')   → { skip: 'workspace 协议' }
 * resolveSpec('file:../x')     → { skip: 'file 协议' }
 * resolveSpec('npm:react@^18') → { version: '18' }
 */
export function resolveSpec(raw: string): { version?: string; skip?: string } {
  if (!raw) return { skip: '版本号为空' }

  // 协议前缀：workspace / file / link / portal / patch / git+https / http(s) / catalog / jsr 等
  // 这些都不是 npm registry 上能拉到的包
  // RFC 3986 URL scheme：ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )，要允许 `git+https` 这种带 `+` 的
  const protocolMatch = raw.match(/^([a-z][a-z0-9+.-]*):/i)
  if (protocolMatch) {
    const protocol = protocolMatch[1]!.toLowerCase()
    if (protocol === 'npm') {
      // npm:react@^18 → 提取 ^18，再次走 resolveSpec
      const inner = raw.slice('npm:'.length)
      const at = inner.lastIndexOf('@')
      if (at <= 0) return { version: undefined }
      return resolveSpec(inner.slice(at + 1))
    }
    return { skip: `${protocol} 协议` }
  }

  // 通配符或 latest tag
  if (raw === '*' || raw === 'x' || raw === '' || /^[a-z]+$/i.test(raw)) {
    return { version: undefined }
  }

  // 标准 semver range：去掉前缀符号 + 取第一段
  // ^1.2.3 → 1.2.3
  // ~4.5.0 → 4.5.0
  // >=1 <2 → 1
  const cleaned = raw.replace(/^[\^~>=<]+/, '').split(' ')[0] ?? ''
  return cleaned ? { version: cleaned } : { version: undefined }
}
