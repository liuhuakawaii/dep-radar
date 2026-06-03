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
 *   - getFullDoc(name) — npm 完整 document（含 time / maintainers / versions[latest]）
 *   - getWeeklyDownloads(name) — 周下载量
 *   - getTrend(name)   — 下载量趋势
 *   - getGitHubRepo(owner, repo) — GitHub 仓库（软失败：失败返回 null）
 *
 * 错误处理策略：
 *   - 包级失败（npm manifest 拿不到）→ 整条 skipped，不阻断其他包
 *   - GitHub 失败 → 该包的 stars / lastPush 缺失，按其他维度评分
 */

import pLimit from 'p-limit'

import { parseGitHubUrl } from '../data/github.js'
import type { GithubRepoResponse, NpmFullDocResponse } from '../types/api.js'
import type { HealthInfo } from '../types/analysis.js'
import type { DependencyEntry } from '../types/inventory.js'
import type { PackageJson } from '../types/package.js'
import { buildIgnoreMatcher } from '../utils/ignore.js'
import { logger } from '../utils/logger.js'

// =====================================================================
// 公开类型
// =====================================================================

/** 依赖注入的数据源 */
export interface HealthFetcher {
  getFullDoc(name: string): Promise<NpmFullDocResponse>
  getWeeklyDownloads(name: string): Promise<number>
  getTrend(name: string): Promise<'up' | 'down' | 'stable'>
  /** 返回 null 表示无法获取（非 GitHub / 私有 / 限流 / 404 等） */
  getGitHubRepo(owner: string, repo: string): Promise<GithubRepoResponse | null>
}

export interface AnalyzeHealthOptions {
  /** 并发数；默认 5（npm/github 限流友好） */
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
  const { concurrency = 5, ignore, healthWeights, onProgress } = options

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
          const result = await analyzeOne(
            entry.name,
            fetcher,
            healthWeights,
            entry.isDirect,
          )
          completed++
          onProgress?.({ current: completed, total, name: entry.name })
          return result
        } catch (err) {
          completed++
          onProgress?.({ current: completed, total, name: entry.name })
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
    concurrency = 5,
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
          const result = await analyzeOne(name, fetcher, healthWeights)
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
// 单包流水线
// =====================================================================

async function analyzeOne(
  name: string,
  fetcher: HealthFetcher,
  weights?: HealthWeights,
  isDirect: boolean = true,
): Promise<HealthInfo> {
  // 1) 并行拉 npm doc + weekly downloads + trend
  const [doc, weeklyDownloads, downloadTrend] = await Promise.all([
    fetcher.getFullDoc(name),
    safeNumber(fetcher.getWeeklyDownloads(name)),
    safeTrend(fetcher.getTrend(name)),
  ])

  // 2) 从 doc 中拆解关键字段
  const latestVersion = doc['dist-tags']?.latest
  const latestManifest = latestVersion
    ? doc.versions?.[latestVersion]
    : undefined

  // lastPublish 优先用 latest 版本的发布时间；fallback 到 modified；再不行用 created
  const lastPublish =
    (latestVersion && doc.time?.[latestVersion]) ||
    doc.time?.['modified'] ||
    doc.time?.['created'] ||
    ''

  const maintainers = doc.maintainers?.length ?? 0
  const deprecated = Boolean(latestManifest?.deprecated)
  const deprecatedMessage = latestManifest?.deprecated
  const hasTypeScriptTypes = Boolean(
    latestManifest?.types ?? latestManifest?.typings,
  )

  // 3) GitHub 数据（软失败）
  const repoUrl =
    extractRepositoryUrl(doc) ?? extractRepositoryUrl(latestManifest)
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
    isDirect,
  }
  info.healthScore = computeHealthScore(info, weights)
  return info
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
async function safeNumber(p: Promise<number>): Promise<number> {
  try {
    return await p
  } catch (err) {
    logger.debug(
      `weeklyDownloads 拉取失败：${err instanceof Error ? err.message : String(err)}`,
    )
    return 0
  }
}

async function safeTrend(
  p: Promise<'up' | 'down' | 'stable'>,
): Promise<'up' | 'down' | 'stable'> {
  try {
    return await p
  } catch (err) {
    logger.debug(
      `downloadTrend 拉取失败：${err instanceof Error ? err.message : String(err)}`,
    )
    return 'stable'
  }
}
