/**
 * 包体积分析器
 *
 * 输入：PackageJson + 一个 BundleFetcher（数据源由调用方注入）
 * 输出：每个依赖的 BundleInfo + 总体积 + topN 体积大户
 *
 * 设计要点：
 * - 依赖注入：analyzer 不直接 import 数据源，便于测试与多源 fallback
 * - 并发控制：用 p-limit 控制并发数，避免触发 API 限流
 * - 容错：单个包获取失败不阻断整体分析，标记为 source='unknown'
 * - 协议过滤：跳过 workspace:/file:/link:/git: 等非 npm 标准依赖
 * - ignore 支持：精确匹配 + 末尾 `*` 通配符（如 `@internal/*`）
 */

import pLimit from 'p-limit'

import type { BundleInfo } from '../types/analysis.js'
import type { PackageJson } from '../types/package.js'

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
   * 忽略的包名模式列表
   *
   * 支持：
   * - 精确匹配：`'lodash'`
   * - 末尾通配符：`'@internal/*'`（匹配该 scope 下所有包）
   *
   * 不支持完整 glob（避免引入 micromatch 依赖）。
   */
  ignore?: string[]
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
// 主函数
// =====================================================================

export async function analyzeBundleSize(
  pkg: PackageJson,
  fetchSize: BundleFetcher,
  options: AnalyzeBundleOptions = {},
): Promise<BundleAnalysisResult> {
  const {
    concurrency = 5,
    topN = 10,
    includeDev = false,
    ignore = [],
  } = options

  const limit = pLimit(Math.max(1, concurrency))
  const ignoreMatchers = ignore.map(compileIgnorePattern)

  // 合并要分析的依赖列表
  const entries: Array<[string, string]> = [
    ...Object.entries(pkg.dependencies ?? {}),
    ...(includeDev ? Object.entries(pkg.devDependencies ?? {}) : []),
  ]

  const skipped: Array<{ name: string; reason: string }> = []
  const bundles: BundleInfo[] = []

  // 先扫一遍做协议/ignore 过滤，再发起并发请求
  const toFetch: Array<{ name: string; version?: string }> = []
  for (const [name, raw] of entries) {
    if (ignoreMatchers.some(m => m(name))) {
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

  const fetched = await Promise.all(
    toFetch.map(({ name, version }) =>
      limit(async (): Promise<BundleInfo> => {
        try {
          return await fetchSize(name, version)
        } catch (err) {
          // 单包失败不阻断整体；记录错误信息让用户能定位
          return {
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
// 辅助函数
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

/**
 * 编译一条 ignore 模式为匹配函数
 *
 * 支持：
 * - 精确：`'lodash'`           → `name === 'lodash'`
 * - 通配：`'@internal/*'`      → `name.startsWith('@internal/')`
 */
export function compileIgnorePattern(
  pattern: string,
): (name: string) => boolean {
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1) // 保留末尾的 '/'
    return name => name.startsWith(prefix)
  }
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1)
    return name => name.startsWith(prefix)
  }
  return name => name === pattern
}
