/**
 * 依赖卫生检测器
 *
 * 检测两类问题：
 *   1. unused-direct: direct dependency 在 src/test/config/scripts 都没有 import 证据
 *   2. misplaced-dependency: 声明在 dependencies，但只在 test/build/config/script 中使用
 *
 * 输入：inventory entries（带 usageClass）+ reachability results
 * 输出：HygieneIssue[]
 */

import type { DependencyEntry } from '../types/inventory.js'
import type { ReachabilityResult, SourceBucket } from './reachability.js'

// =====================================================================
// 公开类型
// =====================================================================

export type HygieneIssueType = 'unused-direct' | 'misplaced-dependency'

export interface HygieneIssue {
  /** 问题包名 */
  packageName: string
  /** 问题类型 */
  type: HygieneIssueType
  /** 置信度 */
  confidence: 'high' | 'medium' | 'low'
  /** 问题描述 */
  description: string
  /** 证据 */
  evidence: string
  /** 建议操作 */
  suggestedAction: string
  /** 当前声明位置 */
  declaredIn: string
  /** 建议移动到的位置（仅 misplaced） */
  suggestedLocation?: string
}

export interface HygieneOptions {
  /** 忽略的包名列表 */
  ignore?: string[]
  /** 允许动态 import 的包名列表（不标记为 unused） */
  allowDynamic?: string[]
  /** 强制标记为 runtime 的包名列表（不标记为 misplaced） */
  runtimePackages?: string[]
}

// =====================================================================
// 主函数
// =====================================================================

/**
 * 检测依赖卫生问题
 *
 * @param entries inventory entries（带 usageClass）
 * @param reachabilityResults 可达性分析结果
 * @param options 选项
 * @returns HygieneIssue[]
 */
export function detectHygieneIssues(
  entries: DependencyEntry[],
  reachabilityResults: ReachabilityResult[],
  options: HygieneOptions = {},
): HygieneIssue[] {
  const { ignore = [], allowDynamic = [], runtimePackages = [] } = options
  const ignoreSet = new Set(ignore)
  const allowDynamicSet = new Set(allowDynamic)
  const runtimePackagesSet = new Set(runtimePackages)

  // 构建可达性索引
  const reachabilityMap = new Map<string, ReachabilityResult>()
  for (const r of reachabilityResults) {
    reachabilityMap.set(r.packageName, r)
  }

  const issues: HygieneIssue[] = []

  // 只检查直接依赖
  const directEntries = entries.filter(e => e.isDirect)

  for (const entry of directEntries) {
    // 忽略列表
    if (ignoreSet.has(entry.name) || ignoreSet.has(entry.packageName)) continue

    // 强制 runtime 列表
    if (
      runtimePackagesSet.has(entry.name) ||
      runtimePackagesSet.has(entry.packageName)
    )
      continue

    const reach =
      reachabilityMap.get(entry.name) ?? reachabilityMap.get(entry.packageName)
    const usageClass = entry.usageClass

    // 1. 检查 unused-direct：无任何 import 证据
    if (!reach || reach.importCount === 0) {
      // 允许动态 import 的包不标记
      if (
        allowDynamicSet.has(entry.name) ||
        allowDynamicSet.has(entry.packageName)
      )
        continue

      issues.push({
        packageName: entry.name,
        type: 'unused-direct',
        confidence: 'medium', // 可能有动态 import 未被正则捕获
        description: `${entry.name} 在源码中无静态 import 证据`,
        evidence: `声明在 ${entry.declaredIn}，但 src/test/config 中均未发现引用`,
        suggestedAction: '确认是否仍在使用，如不使用可移除',
        declaredIn: entry.declaredIn,
      })
      continue
    }

    // 2. 检查 misplaced-dependency：声明在 dependencies 但只在非 runtime 场景使用
    if (entry.declaredIn === 'dependencies') {
      // runtime src 引用 → 不是 misplaced
      if (reach.reachableFromRuntimeEntry) continue

      // 只在 test/config/script 中使用 → 应该移到 devDependencies
      const bucket = reach.sourceBucket
      if (bucket === 'test' || bucket === 'config' || bucket === 'script') {
        const bucketLabels: Record<SourceBucket, string> = {
          src: '源码',
          test: '测试',
          config: '配置',
          script: '脚本',
        }
        issues.push({
          packageName: entry.name,
          type: 'misplaced-dependency',
          confidence:
            usageClass === 'build' || usageClass === 'test' ? 'high' : 'medium',
          description: `${entry.name} 声明在 dependencies，但仅在${bucketLabels[bucket]}中使用`,
          evidence: `分类为 ${usageClass ?? 'unknown'}，import 来源: ${reach.importers
            .map(i => i.file)
            .slice(0, 3)
            .join(', ')}`,
          suggestedAction: `建议移到 devDependencies`,
          declaredIn: entry.declaredIn,
          suggestedLocation: 'devDependencies',
        })
      }
    }
  }

  return issues
}
