/**
 * 优化建议引擎（重构版：以直接依赖为中心）
 *
 * 一个**同步纯函数**：把已分析的 bundle/health/license/security 数据
 * 聚合为可操作的 OptimizationSuggestion[]。
 *
 * 核心设计原则：
 *   - 只对**直接依赖**生成优化建议
 *   - 子依赖的问题归入其直接依赖，作为直接依赖建议的"证据"
 *   - 用户只需关注直接依赖的建议，无需处理子依赖
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
import type { ReachabilityResult } from './reachability.js'

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
  /** 可达性分析结果（用于设置置信度和证据） */
  reachabilityResults?: ReachabilityResult[]
  /** 依赖分类结果 */
  usageClassMap?: Map<string, string>
}

/** 子依赖问题类型 */
export interface TransitiveIssue {
  name: string
  type: 'deprecated' | 'security' | 'license' | 'health'
  description: string
  severity: 'high' | 'medium' | 'low'
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

  // 构建可达性索引
  const reachabilityMap = new Map<string, ReachabilityResult>()
  if (input.reachabilityResults) {
    for (const r of input.reachabilityResults) {
      reachabilityMap.set(r.packageName, r)
    }
  }

  // 构建子依赖问题索引：直接依赖名 → 子依赖问题列表
  const transitiveIssuesMap = buildTransitiveIssuesMap(input)

  // 只处理直接依赖
  const directBundles = input.bundles.filter(b => b.isDirect)
  const directHealth = input.health.filter(h => h.isDirect)
  const directLicenses = input.licenses.filter(l => l.isDirect)
  const directSecurity = input.security.filter(s => s.isDirect !== false)

  // ----- 规则 1: deprecated -----
  for (const h of directHealth) {
    if (h.deprecated) {
      const bundleSize = bundleByName.get(h.name)?.gzip
      const replace = replacements[h.name]
      const reach = reachabilityMap.get(h.name)
      const importCount = reach?.importCount ?? 0
      const isSingleUse = importCount === 1
      const transitiveIssues = transitiveIssuesMap.get(h.name) ?? []

      mergeSuggestion(acc, {
        packageName: h.name,
        type: 'deprecated',
        priority: 'high',
        description:
          (h.deprecatedMessage ?? '该包已被作者标记为 deprecated') +
          (replace ? `；建议替换为 ${replace.alternative}` : '') +
          (transitiveIssues.length > 0
            ? `；其子依赖存在 ${transitiveIssues.length} 个问题`
            : ''),
        alternative: replace?.alternative,
        difficulty: isSingleUse ? 'low' : (replace?.difficulty ?? 'medium'),
        breakingChange: replace?.breakingChange ?? true,
        estimatedSavings: estimateSavings(bundleSize, replace),
        estimatedSavingsPercent: replace?.estimatedSavingsPercent,
        caveats: [
          ...(replace?.caveats ?? []),
          ...transitiveIssues.map(i => `子依赖 ${i.name}: ${i.description}`),
        ],
        migrationGuide: replace?.migrationGuide,
        confidence: 'high',
        actionability: replace ? 'ready' : 'needs-review',
        evidence: [
          {
            source: 'npm-registry',
            detail: h.deprecatedMessage ?? '标记为 deprecated',
          },
          ...(reach
            ? [
                {
                  source: 'reachability' as const,
                  detail: `在 ${importCount} 个源文件中被引用${isSingleUse ? '（单点使用，迁移成本低）' : ''}`,
                },
              ]
            : []),
          ...transitiveIssues.map(i => ({
            source: 'transitive-dep' as const,
            detail: `子依赖 ${i.name}: ${i.description}`,
          })),
        ],
        suggestedSteps: replace
          ? [
              `安装 ${replace.alternative}`,
              `将 ${h.name} 的 import 替换为 ${replace.alternative}`,
              `运行测试确认功能正常`,
            ]
          : [`评估 ${h.name} 的功能是否必需`, `寻找替代方案或自行实现`],
      })
    }
  }

  // ----- 规则 2: replacement 命中 -----
  for (const [name, rule] of Object.entries(replacements)) {
    const bundleInfo = bundleByName.get(name)
    const healthInfo = healthByName.get(name)
    // 只处理直接依赖
    if (!bundleInfo?.isDirect && !healthInfo?.isDirect) continue

    const bundleSize = bundleInfo?.gzip
    const reach = reachabilityMap.get(name)
    const importCount = reach?.importCount ?? 0
    const usageClass = input.usageClassMap?.get(name)
    const transitiveIssues = transitiveIssuesMap.get(name) ?? []

    // 根据使用面调整难度
    let adjustedDifficulty = rule.difficulty
    if (importCount > 10 && rule.difficulty === 'low') {
      adjustedDifficulty = 'medium' // 大量使用时不能标为低难度
    }

    const priority = decideReplacementPriority(bundleSize, rule)

    mergeSuggestion(acc, {
      packageName: name,
      type: 'replace',
      priority,
      description:
        rule.description +
        (transitiveIssues.length > 0
          ? `；其子依赖存在 ${transitiveIssues.length} 个问题`
          : ''),
      alternative: rule.alternative,
      difficulty: adjustedDifficulty,
      breakingChange: rule.breakingChange,
      estimatedSavings: estimateSavings(bundleSize, rule),
      estimatedSavingsPercent: rule.estimatedSavingsPercent,
      caveats: [
        ...(rule.caveats ?? []),
        ...transitiveIssues.map(i => `子依赖 ${i.name}: ${i.description}`),
      ],
      migrationGuide: rule.migrationGuide,
      confidence: reach ? 'high' : 'medium',
      actionability: 'ready',
      evidence: [
        { source: 'replacement-rule', detail: rule.description },
        ...(reach
          ? [
              {
                source: 'reachability' as const,
                detail: `在 ${importCount} 个源文件中被引用`,
              },
            ]
          : []),
        ...(usageClass
          ? [{ source: 'classifier' as const, detail: `分类为 ${usageClass}` }]
          : []),
        ...transitiveIssues.map(i => ({
          source: 'transitive-dep' as const,
          detail: `子依赖 ${i.name}: ${i.description}`,
        })),
      ],
      assumptions: rule.caveats,
      suggestedSteps: [
        `安装 ${rule.alternative}`,
        `参考迁移指南替换 ${name} 的用法`,
        `运行测试确认功能正常`,
      ],
    })
  }

  // ----- 规则 3: 体积大户 -----
  for (const b of directBundles) {
    if (b.gzip <= LARGE_BUNDLE_THRESHOLD) continue
    if (replacements[b.name]) continue // 已被规则 2 处理
    const reach = reachabilityMap.get(b.name)
    const importCount = reach?.importCount ?? 0
    const usageClass = input.usageClassMap?.get(b.name)
    const transitiveIssues = transitiveIssuesMap.get(b.name) ?? []

    // build/test/script 类不参与体积报警
    if (usageClass && usageClass !== 'runtime' && usageClass !== 'unknown')
      continue

    mergeSuggestion(acc, {
      packageName: b.name,
      type: 'replace',
      priority: b.gzip > LARGE_BUNDLE_THRESHOLD * 2 ? 'high' : 'medium',
      description:
        `gzip 体积 ${(b.gzip / 1024).toFixed(1)}KB，超过阈值 ${LARGE_BUNDLE_THRESHOLD / 1024}KB；建议评估是否有更轻量的替代方案或按需引入` +
        (transitiveIssues.length > 0
          ? `；其子依赖存在 ${transitiveIssues.length} 个问题`
          : ''),
      difficulty: importCount > 10 ? 'high' : 'medium',
      breakingChange: false,
      estimatedSavings: 0,
      caveats: transitiveIssues.map(i => `子依赖 ${i.name}: ${i.description}`),
      confidence: reach ? 'medium' : 'low',
      actionability: 'needs-review',
      evidence: [
        {
          source: 'bundle-analysis',
          detail: `gzip ${(b.gzip / 1024).toFixed(1)}KB`,
        },
        ...(reach
          ? [
              {
                source: 'reachability' as const,
                detail: `在 ${importCount} 个源文件中被引用`,
              },
            ]
          : []),
        ...transitiveIssues.map(i => ({
          source: 'transitive-dep' as const,
          detail: `子依赖 ${i.name}: ${i.description}`,
        })),
      ],
      assumptions: ['体积为包级估算，非项目 bundle 实际贡献'],
      preconditions: ['需确认该包是否可通过 tree-shaking 或按需引入减少体积'],
    })
  }

  // ----- 规则 4: healthScore 过低 -----
  for (const h of directHealth) {
    if (h.deprecated) continue // 已被规则 1 处理
    if (h.healthScore >= LOW_HEALTH_THRESHOLD) continue
    const bundleSize = bundleByName.get(h.name)?.gzip
    const replace = replacements[h.name]
    const transitiveIssues = transitiveIssuesMap.get(h.name) ?? []

    mergeSuggestion(acc, {
      packageName: h.name,
      type: 'replace',
      priority: 'medium',
      description:
        `健康度仅 ${h.healthScore}/100（${describeWhyLow(h)}），建议寻找替代` +
        (transitiveIssues.length > 0
          ? `；其子依赖存在 ${transitiveIssues.length} 个问题`
          : ''),
      alternative: replace?.alternative,
      difficulty: replace?.difficulty ?? 'medium',
      breakingChange: replace?.breakingChange ?? false,
      estimatedSavings: estimateSavings(bundleSize, replace),
      estimatedSavingsPercent: replace?.estimatedSavingsPercent,
      caveats: [
        ...(replace?.caveats ?? []),
        ...transitiveIssues.map(i => `子依赖 ${i.name}: ${i.description}`),
      ],
      migrationGuide: replace?.migrationGuide,
      confidence: 'medium',
      actionability: 'needs-review',
      evidence: [
        {
          source: 'health-analysis',
          detail: `健康度 ${h.healthScore}/100（${describeWhyLow(h)}）`,
        },
        ...transitiveIssues.map(i => ({
          source: 'transitive-dep' as const,
          detail: `子依赖 ${i.name}: ${i.description}`,
        })),
      ],
    })
  }

  // ----- 规则 5: license 高风险 -----
  for (const l of directLicenses) {
    if (l.risk !== 'high') continue
    const bundleSize = bundleByName.get(l.name)?.gzip
    const replace = replacements[l.name]
    const transitiveIssues = transitiveIssuesMap.get(l.name) ?? []

    mergeSuggestion(acc, {
      packageName: l.name,
      type: 'replace',
      priority: 'high',
      description:
        `许可证 ${l.license} 风险较高${l.conflict ? `：${l.conflict}` : ''}` +
        (transitiveIssues.length > 0
          ? `；其子依赖存在 ${transitiveIssues.length} 个问题`
          : ''),
      alternative: replace?.alternative,
      difficulty: replace?.difficulty ?? 'high',
      breakingChange: replace?.breakingChange ?? true,
      estimatedSavings: estimateSavings(bundleSize, replace),
      confidence: 'high',
      actionability: 'needs-review',
      evidence: [
        {
          source: 'license-analysis',
          detail: `license=${l.license}，${l.conflict ?? ''}`,
        },
        ...(l.source
          ? [{ source: 'license-source' as const, detail: `来源: ${l.source}` }]
          : []),
        ...transitiveIssues.map(i => ({
          source: 'transitive-dep' as const,
          detail: `子依赖 ${i.name}: ${i.description}`,
        })),
      ],
      preconditions: ['需确认项目的 license 合规要求'],
    })
  }

  // ----- 规则 6: 高危漏洞且无修复 -----
  for (const s of directSecurity) {
    if (s.totalVulnerabilities === 0) continue
    if (s.highestSeverity !== 'high' && s.highestSeverity !== 'critical')
      continue
    const unfixed = s.vulnerabilities.filter(v => !v.fixAvailable)
    if (unfixed.length === 0) continue
    const bundleSize = bundleByName.get(s.name)?.gzip
    const replace = replacements[s.name]
    const transitiveIssues = transitiveIssuesMap.get(s.name) ?? []

    mergeSuggestion(acc, {
      packageName: s.name,
      type: 'replace',
      priority: 'high',
      description:
        `存在 ${unfixed.length} 个 ${s.highestSeverity} 级别漏洞且暂无修复方案，建议替换` +
        (transitiveIssues.length > 0
          ? `；其子依赖存在 ${transitiveIssues.length} 个问题`
          : ''),
      alternative: replace?.alternative,
      difficulty: replace?.difficulty ?? 'medium',
      breakingChange: replace?.breakingChange ?? true,
      estimatedSavings: estimateSavings(bundleSize, replace),
      confidence: 'high',
      actionability: s.isDirect !== false ? 'ready' : 'needs-review',
      evidence: [
        {
          source: 'security-audit',
          detail: `${s.totalVulnerabilities} 个漏洞（最高 ${s.highestSeverity}）`,
        },
        ...(s.scope
          ? [{ source: 'audit-scope' as const, detail: `范围: ${s.scope}` }]
          : []),
        ...transitiveIssues.map(i => ({
          source: 'transitive-dep' as const,
          detail: `子依赖 ${i.name}: ${i.description}`,
        })),
      ],
      preconditions:
        s.isDirect !== false ? [] : ['需先升级引入该漏洞的直接依赖'],
      suggestedSteps:
        s.isDirect !== false
          ? [`检查 ${s.name} 是否有修复版本`, `如无修复方案，寻找替代包`]
          : [`定位引入 ${s.name} 的直接依赖`, `升级该直接依赖到修复版本`],
    })
  }

  // 辅助：避免无效引用警告（healthByName 仅作语义自检入口）
  void healthByName

  // 排序：ready + high confidence + high impact 优先
  return [...acc.values()].sort((a, b) => scoreOf(b) - scoreOf(a))
}

// =====================================================================
// 子依赖问题收集
// =====================================================================

/**
 * 构建子依赖问题索引：直接依赖名 → 子依赖问题列表
 *
 * 遍历所有非直接依赖，收集它们的问题（deprecated、安全漏洞、许可证风险、健康度低），
 * 并归入它们的直接依赖。
 */
function buildTransitiveIssuesMap(
  input: OptimizerInput,
): Map<string, TransitiveIssue[]> {
  const result = new Map<string, TransitiveIssue[]>()

  // 构建包名到直接依赖的映射（从 bundle 或 health 的 isDirect 判断）
  const directDeps = new Set<string>()
  for (const b of input.bundles) {
    if (b.isDirect) directDeps.add(b.name)
  }
  for (const h of input.health) {
    if (h.isDirect) directDeps.add(h.name)
  }

  // 收集子依赖的 deprecated 问题
  for (const h of input.health) {
    if (h.isDirect) continue
    if (h.deprecated) {
      // 找到引入这个子依赖的直接依赖
      const parentDeps = findParentDirectDeps(h.name, input, directDeps)
      for (const parent of parentDeps) {
        addTransitiveIssue(result, parent, {
          name: h.name,
          type: 'deprecated',
          description: h.deprecatedMessage ?? '该包已被标记为 deprecated',
          severity: 'high',
        })
      }
    }
  }

  // 收集子依赖的安全漏洞问题
  for (const s of input.security) {
    if (s.isDirect !== false) continue // 跳过直接依赖
    if (s.totalVulnerabilities === 0) continue
    if (s.highestSeverity !== 'high' && s.highestSeverity !== 'critical')
      continue

    const parentDeps = findParentDirectDeps(s.name, input, directDeps)
    for (const parent of parentDeps) {
      addTransitiveIssue(result, parent, {
        name: s.name,
        type: 'security',
        description: `存在 ${s.totalVulnerabilities} 个 ${s.highestSeverity} 级别漏洞`,
        severity: s.highestSeverity === 'critical' ? 'high' : 'medium',
      })
    }
  }

  // 收集子依赖的许可证风险问题
  for (const l of input.licenses) {
    if (l.isDirect) continue
    if (l.risk !== 'high') continue

    const parentDeps = findParentDirectDeps(l.name, input, directDeps)
    for (const parent of parentDeps) {
      addTransitiveIssue(result, parent, {
        name: l.name,
        type: 'license',
        description: `许可证 ${l.license} 风险较高`,
        severity: 'medium',
      })
    }
  }

  // 收集子依赖的健康度低问题
  for (const h of input.health) {
    if (h.isDirect) continue
    if (h.healthScore >= LOW_HEALTH_THRESHOLD) continue

    const parentDeps = findParentDirectDeps(h.name, input, directDeps)
    for (const parent of parentDeps) {
      addTransitiveIssue(result, parent, {
        name: h.name,
        type: 'health',
        description: `健康度仅 ${h.healthScore}/100`,
        severity: 'low',
      })
    }
  }

  return result
}

/**
 * 查找引入指定子依赖的直接依赖
 *
 * 简化实现：返回所有直接依赖（实际应该通过依赖图查找）
 * TODO: 后续可以通过依赖图精确查找父依赖
 */
function findParentDirectDeps(
  _transitiveName: string,
  _input: OptimizerInput,
  directDeps: Set<string>,
): string[] {
  // 简化实现：返回所有直接依赖
  // 实际应该通过依赖图（如 inventory 中的 paths）来精确查找
  return [...directDeps]
}

/**
 * 添加子依赖问题
 */
function addTransitiveIssue(
  map: Map<string, TransitiveIssue[]>,
  directDep: string,
  issue: TransitiveIssue,
): void {
  const existing = map.get(directDep) ?? []
  existing.push(issue)
  map.set(directDep, existing)
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
  const act = { ready: 3, 'needs-review': 2, info: 1 } as const
  const conf = { high: 3, medium: 2, low: 1 } as const
  return (
    pri[s.priority] * 10000 +
    act[s.actionability ?? 'info'] * 1000 +
    conf[s.confidence ?? 'low'] * 100 +
    (s.estimatedSavings ?? 0)
  )
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

function describeWhyLow(h: HealthInfo): string {
  const reasons: string[] = []
  if (h.weeklyDownloads < 1_000) reasons.push('下载量低')
  if (h.maintainers < 2) reasons.push('维护者少')
  if (!h.hasTypeScriptTypes) reasons.push('无 TS 类型')
  if (h.downloadTrend === 'down') reasons.push('下载量下滑')
  return reasons.length > 0 ? reasons.join('、') : '综合指标低'
}
