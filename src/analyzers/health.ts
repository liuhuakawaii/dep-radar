/**
 * 依赖健康度分析器
 *
 * 输入：项目的 package.json（dependencies + 可选 devDependencies）
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

import type { GithubRepoResponse, NpmFullDocResponse } from '../types/api.js'
import type { HealthInfo } from '../types/analysis.js'
import type { PackageJson } from '../types/package.js'
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
  /** 是否同时分析 devDependencies；默认 false */
  includeDev?: boolean
  /** glob 模式数组，匹配的包跳过；与 bundle analyzer 共用语义 */
  ignore?: string[]
}

export interface HealthAnalysisResult {
  health: HealthInfo[]
  /** 因解析问题被跳过的包；reason 简短人类可读 */
  skipped: Array<{ name: string; reason: string }>
}

// =====================================================================
// 主入口
// =====================================================================

export async function analyzeHealth(
  pkg: PackageJson,
  fetcher: HealthFetcher,
  options: AnalyzeHealthOptions = {},
): Promise<HealthAnalysisResult> {
  const { concurrency = 5, includeDev = false, ignore } = options

  const deps: Record<string, string> = {
    ...pkg.dependencies,
    ...(includeDev ? pkg.devDependencies : {}),
  }

  const ignorePatterns = (ignore ?? []).map(compileIgnorePattern)
  const skipped: HealthAnalysisResult['skipped'] = []
  const targets: string[] = []

  for (const name of Object.keys(deps)) {
    if (ignorePatterns.some(p => p.test(name))) continue
    targets.push(name)
  }

  const limit = pLimit(concurrency)
  const results = await Promise.all(
    targets.map(name =>
      limit(async () => {
        try {
          return await analyzeOne(name, fetcher)
        } catch (err) {
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

  const gh = repoUrl ? parseGitHubOwnerRepo(repoUrl) : null
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
  }
  info.healthScore = computeHealthScore(info)
  return info
}

// =====================================================================
// 评分算法
// =====================================================================

/**
 * 按 PLAN Step 11 的加权公式计算 0-100 分
 *
 * 导出以供单元测试覆盖所有边界。
 */
export function computeHealthScore(info: HealthInfo): number {
  if (info.deprecated) return 0

  let score = 0

  // 下载量（25 分）
  if (info.weeklyDownloads > 100_000) score += 25
  else if (info.weeklyDownloads > 10_000) score += 18
  else if (info.weeklyDownloads > 1_000) score += 10
  else score += 3

  // 最近发布（25 分）
  const m = monthsSince(info.lastPublish)
  if (m !== null) {
    if (m < 1) score += 25
    else if (m < 6) score += 18
    else if (m < 12) score += 10
    else if (m < 24) score += 3
    // > 2 年不加分
  }
  // 无 lastPublish 时不加分

  // GitHub stars（15 分）
  const stars = info.githubStars ?? 0
  if (stars > 10_000) score += 15
  else if (stars > 1_000) score += 10
  else if (stars > 100) score += 5

  // maintainers（10 分）
  if (info.maintainers > 3) score += 10
  else if (info.maintainers > 1) score += 6
  else score += 2

  // TS 类型支持（10 分）
  if (info.hasTypeScriptTypes) score += 10

  // 下载趋势（15 分）
  if (info.downloadTrend === 'up') score += 15
  else if (info.downloadTrend === 'stable') score += 10
  // down: 0

  return Math.min(100, score)
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

/** 把 ignore 中的 glob 模式编译为正则（仅支持 * 与 ? 两种通配符） */
function compileIgnorePattern(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
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

/**
 * 从 repository URL 抽取 owner / repo
 *
 * 支持：
 *   - git+https://github.com/owner/repo.git
 *   - https://github.com/owner/repo
 *   - git://github.com/owner/repo.git
 *   - github:owner/repo
 *   - git@github.com:owner/repo.git
 *
 * 非 GitHub URL 返回 null。
 */
export function parseGitHubOwnerRepo(
  url: string,
): { owner: string; repo: string } | null {
  if (!url) return null

  // github:owner/repo 短格式
  const shortMatch = url.match(/^github:([^/\s]+)\/([^/\s#?]+)/i)
  if (shortMatch) {
    return { owner: shortMatch[1]!, repo: stripGitSuffix(shortMatch[2]!) }
  }

  // git@github.com:owner/repo.git
  const sshMatch = url.match(/git@github\.com:([^/]+)\/([^/\s#?]+)/i)
  if (sshMatch) {
    return { owner: sshMatch[1]!, repo: stripGitSuffix(sshMatch[2]!) }
  }

  // 通用 URL（github.com/owner/repo）
  const urlMatch = url.match(/github\.com[/:]([^/]+)\/([^/\s#?]+)/i)
  if (urlMatch) {
    return { owner: urlMatch[1]!, repo: stripGitSuffix(urlMatch[2]!) }
  }

  return null
}

function stripGitSuffix(s: string): string {
  return s.replace(/\.git$/, '')
}
