/**
 * 优化建议引擎
 *
 * 一个**同步纯函数**：把已分析的 bundle/health/license/security 数据
 * 聚合为可操作的 OptimizationSuggestion[]。
 *
 * 规则（按优先级从高到低）：
 *   1. Deprecated 包（type=deprecated, priority=high）
 *   2. 命中 REPLACEMENTS 表（type=replace；priority 视体积/风险定）
 *   3. 体积大户：gzip > 50KB 且未在 REPLACEMENTS 中（type=replace, alternative=undefined）
 *   4. 健康度低：healthScore < 30（type=replace）
 *   5. License 高风险（type=replace）
 *   6. 安全漏洞 high/critical 且无修复方案（type=replace）
 *
 * 同一个包可能被多条规则命中，去重策略：
 *   - 按 packageName 聚合，取**最严重**的那一条作为结果
 *   - description 累积（用 "; " 连接），避免信息丢失
 *
 * 排序：score = priorityWeight * 1000 + (estimatedSavings ?? 0)，降序
 *   priorityWeight: high=3, medium=2, low=1
 *   常数 1000 让 priority 是首要排序键，savings 作为同优先级内的次要键
 */

import { mergeReplacements } from '../config/replacements.js'
import type {
  BundleInfo,
  HealthInfo,
  LicenseInfo,
  OptimizationSuggestion,
  OptimizationType,
  SecurityInfo,
} from '../types/analysis.js'
import type { ReplacementRule } from '../types/config.js'

// =====================================================================
// 公开类型
// =====================================================================

export interface OptimizerInput {
  bundles: BundleInfo[]
  health: HealthInfo[]
  licenses: LicenseInfo[]
  security: SecurityInfo[]
  /** 用户自定义替代方案；会与内置 REPLACEMENTS 合并，用户优先 */
  userReplacements?: Record<string, ReplacementRule>
}

// =====================================================================
// 阈值（与 PLAN 一致）
// =====================================================================

/** 单包 gzip 体积大户阈值（字节） */
const LARGE_BUNDLE_THRESHOLD = 50 * 1024
/** 健康度低于此分数触发替换建议 */
const LOW_HEALTH_THRESHOLD = 30

// =====================================================================
// 主入口
// =====================================================================

export function generateOptimizations(
  input: OptimizerInput,
): OptimizationSuggestion[] {
  const replacements = mergeReplacements(input.userReplacements)

  // 用 Map 累积同包的建议（同名包合并，取最严重）
  const acc = new Map<string, OptimizationSuggestion>()

  const bundleByName = indexBy(input.bundles, b => b.name)
  const healthByName = indexBy(input.health, h => h.name)

  // ----- 规则 1: deprecated -----
  for (const h of input.health) {
    if (h.deprecated) {
      const bundleSize = bundleByName.get(h.name)?.gzip
      const replace = replacements[h.name]
      mergeSuggestion(acc, {
        packageName: h.name,
        type: 'deprecated',
        priority: 'high',
        description:
          (h.deprecatedMessage ?? '该包已被作者标记为 deprecated') +
          (replace ? `；建议替换为 ${replace.alternative}` : ''),
        alternative: replace?.alternative,
        difficulty: replace?.difficulty ?? 'medium',
        breakingChange: replace?.breakingChange ?? true,
        estimatedSavings: estimateSavings(bundleSize, replace),
        estimatedSavingsPercent: replace?.estimatedSavingsPercent,
        caveats: replace?.caveats,
        migrationGuide: replace?.migrationGuide,
      })
    }
  }

  // ----- 规则 2: replacement 命中 -----
  for (const [name, rule] of Object.entries(replacements)) {
    if (!isInDeps(name, input)) continue
    const bundleSize = bundleByName.get(name)?.gzip
    const priority = decideReplacementPriority(bundleSize, rule)
    mergeSuggestion(acc, {
      packageName: name,
      type: 'replace',
      priority,
      description: rule.description,
      alternative: rule.alternative,
      difficulty: rule.difficulty,
      breakingChange: rule.breakingChange,
      estimatedSavings: estimateSavings(bundleSize, rule),
      estimatedSavingsPercent: rule.estimatedSavingsPercent,
      caveats: rule.caveats,
      migrationGuide: rule.migrationGuide,
    })
  }

  // ----- 规则 3: 体积大户 -----
  for (const b of input.bundles) {
    if (b.gzip <= LARGE_BUNDLE_THRESHOLD) continue
    if (replacements[b.name]) continue // 已被规则 2 处理
    mergeSuggestion(acc, {
      packageName: b.name,
      type: 'replace',
      priority: b.gzip > LARGE_BUNDLE_THRESHOLD * 2 ? 'high' : 'medium',
      description: `gzip 体积 ${(b.gzip / 1024).toFixed(1)}KB，超过阈值 ${LARGE_BUNDLE_THRESHOLD / 1024}KB；建议评估是否有更轻量的替代方案或按需引入`,
      difficulty: 'medium',
      breakingChange: false,
      estimatedSavings: 0,
    })
  }

  // ----- 规则 4: healthScore 过低 -----
  for (const h of input.health) {
    if (h.deprecated) continue // 已被规则 1 处理
    if (h.healthScore >= LOW_HEALTH_THRESHOLD) continue
    const bundleSize = bundleByName.get(h.name)?.gzip
    const replace = replacements[h.name]
    mergeSuggestion(acc, {
      packageName: h.name,
      type: 'replace',
      priority: 'medium',
      description: `健康度仅 ${h.healthScore}/100（${describeWhyLow(h)}），建议寻找替代`,
      alternative: replace?.alternative,
      difficulty: replace?.difficulty ?? 'medium',
      breakingChange: replace?.breakingChange ?? false,
      estimatedSavings: estimateSavings(bundleSize, replace),
      estimatedSavingsPercent: replace?.estimatedSavingsPercent,
      caveats: replace?.caveats,
      migrationGuide: replace?.migrationGuide,
    })
  }

  // ----- 规则 5: license 高风险 -----
  for (const l of input.licenses) {
    if (l.risk !== 'high') continue
    const bundleSize = bundleByName.get(l.name)?.gzip
    const replace = replacements[l.name]
    mergeSuggestion(acc, {
      packageName: l.name,
      type: 'replace',
      priority: 'high',
      description: `许可证 ${l.license} 风险较高${l.conflict ? `：${l.conflict}` : ''}`,
      alternative: replace?.alternative,
      difficulty: replace?.difficulty ?? 'high',
      breakingChange: replace?.breakingChange ?? true,
      estimatedSavings: estimateSavings(bundleSize, replace),
    })
  }

  // ----- 规则 6: 高危漏洞且无修复 -----
  for (const s of input.security) {
    if (s.totalVulnerabilities === 0) continue
    if (s.highestSeverity !== 'high' && s.highestSeverity !== 'critical')
      continue
    const unfixed = s.vulnerabilities.filter(v => !v.fixAvailable)
    if (unfixed.length === 0) continue
    const bundleSize = bundleByName.get(s.name)?.gzip
    const replace = replacements[s.name]
    mergeSuggestion(acc, {
      packageName: s.name,
      type: 'replace',
      priority: 'high',
      description: `存在 ${unfixed.length} 个 ${s.highestSeverity} 级别漏洞且暂无修复方案，建议替换`,
      alternative: replace?.alternative,
      difficulty: replace?.difficulty ?? 'medium',
      breakingChange: replace?.breakingChange ?? true,
      estimatedSavings: estimateSavings(bundleSize, replace),
    })
  }

  // 辅助：避免无效引用警告（healthByName 仅作语义自检入口）
  void healthByName

  // 排序
  return [...acc.values()].sort((a, b) => scoreOf(b) - scoreOf(a))
}

// =====================================================================
// 工具
// =====================================================================

function indexBy<T, K>(arr: T[], key: (t: T) => K): Map<K, T> {
  const m = new Map<K, T>()
  for (const x of arr) m.set(key(x), x)
  return m
}

/**
 * 合并同包建议：取 priority 最严重 + type 最具体；description 累积
 *
 * 优先级排序：deprecated > replace（规则 1 hard override）
 * 防止"deprecated"被后续 license 规则覆盖。
 */
function mergeSuggestion(
  acc: Map<string, OptimizationSuggestion>,
  next: OptimizationSuggestion,
): void {
  const prev = acc.get(next.packageName)
  if (!prev) {
    acc.set(next.packageName, { ...next })
    return
  }

  const winner = pickMoreSevere(prev, next)
  const loser = winner === prev ? next : prev

  acc.set(next.packageName, {
    ...winner,
    description:
      winner.description === loser.description
        ? winner.description
        : `${winner.description}；${loser.description}`,
    caveats: mergeUnique(winner.caveats, loser.caveats),
    // 替代/迁移信息以 winner 为准；winner 为空时回退到 loser
    alternative: winner.alternative ?? loser.alternative,
    estimatedSavings: maxOpt(winner.estimatedSavings, loser.estimatedSavings),
    estimatedSavingsPercent:
      winner.estimatedSavingsPercent ?? loser.estimatedSavingsPercent,
    migrationGuide: winner.migrationGuide ?? loser.migrationGuide,
  })
}

function pickMoreSevere(
  a: OptimizationSuggestion,
  b: OptimizationSuggestion,
): OptimizationSuggestion {
  // type 优先：deprecated > replace > 其他
  const typeRank: Record<OptimizationType, number> = {
    deprecated: 4,
    replace: 3,
    remove: 2,
    upgrade: 1,
    'tree-shake': 0,
    'import-style': 0,
  }
  if (typeRank[a.type] !== typeRank[b.type]) {
    return typeRank[a.type] > typeRank[b.type] ? a : b
  }
  // priority 次之
  const pri = { high: 3, medium: 2, low: 1 } as const
  if (pri[a.priority] !== pri[b.priority]) {
    return pri[a.priority] > pri[b.priority] ? a : b
  }
  return a // 平局保留先入者
}

function mergeUnique(
  a: string[] | undefined,
  b: string[] | undefined,
): string[] | undefined {
  if (!a && !b) return undefined
  const set = new Set([...(a ?? []), ...(b ?? [])])
  return [...set]
}

function maxOpt(a?: number, b?: number): number | undefined {
  if (a == null && b == null) return undefined
  return Math.max(a ?? 0, b ?? 0)
}

function scoreOf(s: OptimizationSuggestion): number {
  const pri = { high: 3, medium: 2, low: 1 } as const
  return pri[s.priority] * 1000 + (s.estimatedSavings ?? 0)
}

function estimateSavings(
  bundleGzip: number | undefined,
  rule: ReplacementRule | undefined,
): number {
  if (bundleGzip == null) return 0
  if (!rule) return 0
  return Math.round((bundleGzip * rule.estimatedSavingsPercent) / 100)
}

function decideReplacementPriority(
  bundleGzip: number | undefined,
  rule: ReplacementRule,
): 'high' | 'medium' | 'low' {
  // 节省百分比 >= 80% 且体积 > 10KB → high
  if (rule.estimatedSavingsPercent >= 80 && (bundleGzip ?? 0) > 10 * 1024) {
    return 'high'
  }
  // 节省百分比 >= 50% → medium
  if (rule.estimatedSavingsPercent >= 50) return 'medium'
  return 'low'
}

function isInDeps(name: string, input: OptimizerInput): boolean {
  return (
    input.bundles.some(b => b.name === name) ||
    input.health.some(h => h.name === name) ||
    input.licenses.some(l => l.name === name) ||
    input.security.some(s => s.name === name)
  )
}

function describeWhyLow(h: HealthInfo): string {
  const reasons: string[] = []
  if (h.weeklyDownloads < 1_000) reasons.push('下载量低')
  if (h.maintainers < 2) reasons.push('维护者少')
  if (!h.hasTypeScriptTypes) reasons.push('无 TS 类型')
  if (h.downloadTrend === 'down') reasons.push('下载量下滑')
  return reasons.length > 0 ? reasons.join('、') : '综合指标低'
}
