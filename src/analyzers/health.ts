/**
 * 依赖健康度分析器
 *
 * 输入：DependencyEntry[]（来自 DependencyInventory）+ HealthFetcher
 * 输出：每个依赖的 HealthInfo + 总览
 *
 * 健康度算法（0-100，与 PLAN Step 11 一致）：
 *   - deprecated → 直接 0
 *   - weeklyDownloads: 25
 *   - 最近发布时间:    25
 *   - GitHub stars:    15
 *   - maintainers:     10
 *   - TS 类型支持:     10
 *   - 下载量趋势:      15
 *
 * 数据来源（通过 HealthFetcher 注入，便于测试与换源）：
 *   - getLiteDoc(name) — 仅 /latest manifest（deprecated / types / typings / repository）
 *   - getMeta(name) — 轻量元数据（time / maintainers / dist-tags），不含 versions map
 *   - getDownloadStats(name) — 一次性返回 { weekly, trend }（共享 last-month range 数据）
 *   - getGitHubRepo(owner, repo) — GitHub 仓库（软失败：失败返回 null）
 *
 * 直接依赖 vs 子依赖：
 *   - 直接依赖：跑全套（full doc + download stats + github），用于评分
 *   - 子依赖：只跑 lite doc（取 deprecated 字段），用于 transitive 归并；
 *     其余字段全填默认零值，不计算 healthScore
 *
 * 错误处理策略：
 *   - 包级失败（npm manifest 拿不到）→ 整条 skipped，不阻断其他包
 *   - GitHub 失败 → 该包的 stars / lastPush 缺失，按其他维度评分
 *   - 子依赖 lite 检查失败 → 跳过该子依赖（不当作 skipped 报错）
 */

import pLimit from 'p-limit'

import { parseGitHubUrl } from '../data/github.js'
import type {
  GithubRepoResponse,
  NpmPackageMetaResponse,
  NpmRegistryResponse,
} from '../types/api.js'
import type { HealthInfo } from '../types/analysis.js'
import type { DependencyEntry } from '../types/inventory.js'
import type { PackageJson } from '../types/package.js'
import { buildIgnoreMatcher } from '../utils/ignore.js'
import { logger } from '../utils/logger.js'

// =====================================================================
// 公开类型
// =====================================================================

/** 直接依赖完整流程需要的数据源 */
export interface HealthFetcher {
  /** 仅 /latest manifest；用于 direct 的 deprecated/types/typings/repository + transitive 的 deprecated */
  getLiteDoc(name: string): Promise<NpmRegistryResponse>
  /** 轻量元数据（time + maintainers + dist-tags）；不包含 versions map */
  getMeta(name: string): Promise<NpmPackageMetaResponse>
  /** 一次性返回周下载量与趋势（共享 last-month range 接口数据） */
  getDownloadStats(
    name: string,
  ): Promise<{ weekly: number; trend: 'up' | 'down' | 'stable' }>
  /** 返回 null 表示无法获取（非 GitHub / 私有 / 限流 / 404 等） */
  getGitHubRepo(owner: string, repo: string): Promise<GithubRepoResponse | null>
}

export interface AnalyzeHealthOptions {
  /** 并发数；默认 15 */
  concurrency?: number
  /** @deprecated 使用 entries 的 declaredIn 过滤代替 */
  includeDev?: boolean
  /** @deprecated 使用 buildIgnoreMatcher 代替 */
  ignore?: string[]
  /** 健康度评分权重；未指定的字段使用默认值 */
  healthWeights?: HealthWeights
  /** 每个包完成时的进度回调 */
  onProgress?: (info: { current: number; total: number; name: string }) => void
}

export interface HealthWeights {
  weeklyDownloads?: number
  lastPublish?: number
  githubStars?: number
  maintainers?: number
  hasTypeScriptTypes?: number
  downloadTrend?: number
}

export interface HealthAnalysisResult {
  health: HealthInfo[]
  /** 因解析问题被跳过的包；reason 简短人类可读 */
  skipped: Array<{ name: string; reason: string }>
}

// =====================================================================
// 主入口（新版：接受 DependencyEntry[]）
// =====================================================================

export async function analyzeHealth(
  entries: DependencyEntry[],
  fetcher: HealthFetcher,
  options: AnalyzeHealthOptions = {},
): Promise<HealthAnalysisResult> {
  const { concurrency = 15, ignore, healthWeights, onProgress } = options

  const isIgnored = buildIgnoreMatcher(ignore ?? [])
  const skipped: HealthAnalysisResult['skipped'] = []
  const targets = entries.filter(e => !isIgnored(e.name))

  const limit = pLimit(concurrency)
  let completed = 0
  const total = targets.length
  const results = await Promise.all(
    targets.map(entry =>
      limit(async () => {
        try {
          const result = entry.isDirect
            ? await analyzeDirect(entry.name, fetcher, healthWeights)
            : await analyzeTransitive(entry.name, fetcher)
          completed++
          onProgress?.({ current: completed, total, name: entry.name })
          return result
        } catch (err) {
          completed++
          onProgress?.({ current: completed, total, name: entry.name })
          // 子依赖失败常见（私有 / 4xx 已被负缓存），不当 skipped 噪音
          if (!entry.isDirect) return null
          skipped.push({
            name: entry.name,
            reason: err instanceof Error ? err.message : String(err),
          })
          return null
        }
      }),
    ),
  )

  return {
    health: results.filter((x): x is HealthInfo => x !== null),
    skipped,
  }
}

// =====================================================================
// 旧版兼容入口（接受 PackageJson）
// =====================================================================

/**
 * 旧版入口：接受 PackageJson
 *
 * @deprecated 新代码应使用 buildInventory() + analyzeHealth(entries, fetcher)
 */
export async function analyzeHealthFromPackage(
  pkg: PackageJson,
  fetcher: HealthFetcher,
  options: AnalyzeHealthOptions = {},
): Promise<HealthAnalysisResult> {
  const {
    concurrency = 15,
    includeDev = false,
    ignore,
    healthWeights,
    onProgress,
  } = options

  const deps: Record<string, string> = {
    ...pkg.dependencies,
    ...(includeDev ? pkg.devDependencies : {}),
  }

  const isIgnored = buildIgnoreMatcher(ignore ?? [])
  const skipped: HealthAnalysisResult['skipped'] = []
  const targets: string[] = []

  for (const name of Object.keys(deps)) {
    if (isIgnored(name)) continue
    targets.push(name)
  }

  const limit = pLimit(concurrency)
  let completed = 0
  const total = targets.length
  const results = await Promise.all(
    targets.map(name =>
      limit(async () => {
        try {
          const result = await analyzeDirect(name, fetcher, healthWeights)
          completed++
          onProgress?.({ current: completed, total, name })
          return result
        } catch (err) {
          completed++
          onProgress?.({ current: completed, total, name })
          skipped.push({
            name,
            reason: err instanceof Error ? err.message : String(err),
          })
          return null
        }
      }),
    ),
  )

  return {
    health: results.filter((x): x is HealthInfo => x !== null),
    skipped,
  }
}

// =====================================================================
// 单包流水线 — 直接依赖（全套）
// =====================================================================

async function analyzeDirect(
  name: string,
  fetcher: HealthFetcher,
  weights?: HealthWeights,
): Promise<HealthInfo> {
  // 1) 并行拉 /latest manifest + 轻量元数据 + 下载统计
  //    getLiteDoc → deprecated / types / typings / repository（~5KB）
  //    getMeta → time / maintainers / dist-tags（~1KB，不含 versions map）
  const [manifest, meta, downloadStats] = await Promise.all([
    fetcher.getLiteDoc(name),
    fetcher.getMeta(name),
    safeDownloadStats(fetcher.getDownloadStats(name)),
  ])
  const { weekly: weeklyDownloads, trend: downloadTrend } = downloadStats

  // 2) 从两个轻量源中拆解关键字段
  const latestVersion = meta['dist-tags']?.latest

  // lastPublish 优先用 latest 版本的发布时间；fallback 到 modified；再不行用 created
  const lastPublish =
    (latestVersion && meta.time?.[latestVersion]) ||
    meta.time?.['modified'] ||
    meta.time?.['created'] ||
    ''

  const maintainers = meta.maintainers?.length ?? 0
  const deprecated = Boolean(manifest?.deprecated)
  const deprecatedMessage = manifest?.deprecated
  const hasTypeScriptTypes = Boolean(manifest?.types ?? manifest?.typings)

  // 3) GitHub 数据（软失败）
  const repoUrl = extractRepositoryUrl(meta) ?? extractRepositoryUrl(manifest)
  let githubStars: number | undefined
  let githubLastPush: string | undefined
  let openIssues = 0

  const gh = repoUrl ? parseGitHubUrl(repoUrl) : null
  if (gh) {
    const repoInfo = await fetcher.getGitHubRepo(gh.owner, gh.repo)
    if (repoInfo) {
      githubStars = repoInfo.stargazers_count
      githubLastPush = repoInfo.pushed_at
      openIssues = repoInfo.open_issues_count
    }
  }

  // 4) 计算分数
  const info: HealthInfo = {
    name,
    weeklyDownloads,
    downloadTrend,
    lastPublish,
    maintainers,
    openIssues,
    githubStars,
    githubLastPush,
    deprecated,
    deprecatedMessage,
    hasTypeScriptTypes,
    healthScore: 0, // 占位，下一行覆盖
    isDirect: true,
  }
  info.healthScore = computeHealthScore(info, weights)
  return info
}

// =====================================================================
// 单包流水线 — 子依赖（轻量：只看 deprecated）
// =====================================================================

/**
 * 子依赖只取 deprecated 字段。
 *
 * 用一次 /latest 调用代替完整 document + 下载量 + trend + github 三件套，
 * 大量减少网络请求与数据量。其他字段填默认零值；optimizer 只关心 deprecated。
 */
async function analyzeTransitive(
  name: string,
  fetcher: HealthFetcher,
): Promise<HealthInfo> {
  const latest = await fetcher.getLiteDoc(name)
  const deprecated = Boolean(latest.deprecated)
  return {
    name,
    weeklyDownloads: 0,
    downloadTrend: 'stable',
    lastPublish: '',
    maintainers: 0,
    openIssues: 0,
    deprecated,
    deprecatedMessage: latest.deprecated,
    hasTypeScriptTypes: Boolean(latest.types ?? latest.typings),
    healthScore: deprecated ? 0 : 100, // transitive 健康度不参与展示，给一个不会触发规则 4 的值
    isDirect: false,
  }
}

// =====================================================================
// 评分算法
// =====================================================================

/**
 * 按加权公式计算 0-100 分
 *
 * 权重可自定义，各维度按比例缩放。
 * 导出以供单元测试覆盖所有边界。
 */
export function computeHealthScore(
  info: HealthInfo,
  weights?: HealthWeights,
): number {
  if (info.deprecated) return 0

  const w = {
    weeklyDownloads: weights?.weeklyDownloads ?? 25,
    lastPublish: weights?.lastPublish ?? 25,
    githubStars: weights?.githubStars ?? 15,
    maintainers: weights?.maintainers ?? 10,
    hasTypeScriptTypes: weights?.hasTypeScriptTypes ?? 10,
    downloadTrend: weights?.downloadTrend ?? 15,
  }

  let score = 0

  // 下载量
  if (info.weeklyDownloads > 100_000) score += w.weeklyDownloads
  else if (info.weeklyDownloads > 10_000) score += w.weeklyDownloads * 0.72
  else if (info.weeklyDownloads > 1_000) score += w.weeklyDownloads * 0.4
  else score += w.weeklyDownloads * 0.12

  // 最近发布
  const m = monthsSince(info.lastPublish)
  if (m !== null) {
    if (m < 1) score += w.lastPublish
    else if (m < 6) score += w.lastPublish * 0.72
    else if (m < 12) score += w.lastPublish * 0.4
    else if (m < 24) score += w.lastPublish * 0.12
    // > 2 年不加分
  }

  // GitHub stars
  const stars = info.githubStars ?? 0
  if (stars > 10_000) score += w.githubStars
  else if (stars > 1_000) score += w.githubStars * (2 / 3)
  else if (stars > 100) score += w.githubStars / 3

  // maintainers
  if (info.maintainers > 3) score += w.maintainers
  else if (info.maintainers > 1) score += w.maintainers * 0.6
  else score += w.maintainers * 0.2

  // TS 类型支持
  if (info.hasTypeScriptTypes) score += w.hasTypeScriptTypes

  // 下载趋势
  if (info.downloadTrend === 'up') score += w.downloadTrend
  else if (info.downloadTrend === 'stable') score += w.downloadTrend * (2 / 3)
  // down: 0

  return Math.min(100, Math.round(score))
}

// =====================================================================
// 工具
// =====================================================================

/**
 * 从 ISO 时间到现在的月数（向下取整）
 *
 * 时间无效或空字符串返回 null。
 */
export function monthsSince(
  iso: string,
  now: Date = new Date(),
): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const diffMs = now.getTime() - t
  if (diffMs < 0) return 0 // 时钟漂移容忍：未来时间视为刚发布
  return Math.floor(diffMs / (30 * 24 * 60 * 60 * 1000))
}

/**
 * 从 npm document 提取 repository URL（容忍 string / object 两种格式）
 */
export function extractRepositoryUrl(
  doc: { repository?: { type: string; url: string } | string } | undefined,
): string | undefined {
  const r = doc?.repository
  if (!r) return undefined
  return typeof r === 'string' ? r : r.url
}

/** 在数据获取失败时给一个合理默认值，避免单一字段失败影响整条记录 */
async function safeDownloadStats(
  p: Promise<{ weekly: number; trend: 'up' | 'down' | 'stable' }>,
): Promise<{ weekly: number; trend: 'up' | 'down' | 'stable' }> {
  try {
    return await p
  } catch (err) {
    logger.debug(
      `downloadStats 拉取失败：${err instanceof Error ? err.message : String(err)}`,
    )
    return { weekly: 0, trend: 'stable' }
  }
}
