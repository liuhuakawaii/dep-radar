/**
 * 多版本库检测器
 *
 * 检测同包多版本并存的问题，特别处理 alias 和 transitive 版本。
 *
 * 典型场景：
 *   - three@0.165.0 + three149@npm:three@0.149.0 + stats-gl 引入 three@0.170.0
 *   - lodash@4.17.21 + lodash-es@4.17.21（两个包但功能重叠）
 *
 * 输入：inventory entries
 * 输出：DuplicateVersionInfo[]
 */

import type { DependencyEntry } from '../types/inventory.js'

// =====================================================================
// 公开类型
// =====================================================================

export interface DuplicateVersionInfo {
  /** 实际包名（alias 解析后） */
  packageName: string
  /** 存在的版本列表 */
  versions: Array<{
    version: string
    /** 引入方式 */
    source: 'direct' | 'alias' | 'transitive'
    /** 声明名（alias 时为 alias 名） */
    declaredName: string
    /** 依赖路径 */
    paths: string[][]
  }>
  /** 直接依赖的包名列表 */
  directPackages: string[]
  /** alias 包名列表 */
  aliases: string[]
  /** 建议 */
  recommendation: string
  /** 是否为大型基础库 */
  isLargeLibrary: boolean
  /** 是否有版本从 src 可达 */
  runtimeReachable: boolean
}

// =====================================================================
// 大型基础库列表
// =====================================================================

const LARGE_LIBRARIES = new Set([
  'three',
  'react',
  'react-dom',
  'lodash',
  'lodash-es',
  'rxjs',
  'monaco-editor',
  'moment',
  'vue',
  'angular',
  'd3',
  'chart.js',
  'leaflet',
  'pixi.js',
  'phaser',
])

// =====================================================================
// 主函数
// =====================================================================

/**
 * 检测同包多版本并存
 *
 * @param entries inventory entries
 * @returns DuplicateVersionInfo[]
 */
export function detectDuplicateVersions(
  entries: DependencyEntry[],
): DuplicateVersionInfo[] {
  // 按 packageName 聚合
  const byPackage = new Map<string, DependencyEntry[]>()
  for (const entry of entries) {
    const list = byPackage.get(entry.packageName) ?? []
    list.push(entry)
    byPackage.set(entry.packageName, list)
  }

  const results: DuplicateVersionInfo[] = []

  for (const [packageName, pkgEntries] of byPackage) {
    // 收集所有唯一版本
    const versionMap = new Map<string, DuplicateVersionInfo['versions'][0]>()

    for (const entry of pkgEntries) {
      const existing = versionMap.get(entry.resolvedVersion)
      if (existing) {
        // 同版本不同引入方式，合并 paths
        existing.paths.push(...entry.paths)
      } else {
        versionMap.set(entry.resolvedVersion, {
          version: entry.resolvedVersion,
          source: entry.isAlias
            ? 'alias'
            : entry.isDirect
              ? 'direct'
              : 'transitive',
          declaredName: entry.name,
          paths: [...entry.paths],
        })
      }
    }

    // 只有多个不同版本时才算重复
    if (versionMap.size <= 1) continue

    const versions = [...versionMap.values()]
    const directPackages = pkgEntries
      .filter(e => e.isDirect && !e.isAlias)
      .map(e => e.name)
    const aliases = pkgEntries.filter(e => e.isAlias).map(e => e.name)
    const isLargeLibrary = LARGE_LIBRARIES.has(packageName)

    // 生成建议
    const recommendation = buildRecommendation(
      packageName,
      versions,
      directPackages,
      aliases,
      isLargeLibrary,
    )

    results.push({
      packageName,
      versions,
      directPackages,
      aliases,
      recommendation,
      isLargeLibrary,
      runtimeReachable: pkgEntries.some(e => e.isDirect && !e.isAlias),
    })
  }

  // 按影响排序：大型库优先，版本数多的优先
  results.sort((a, b) => {
    if (a.isLargeLibrary !== b.isLargeLibrary) return a.isLargeLibrary ? -1 : 1
    return b.versions.length - a.versions.length
  })

  return results
}

// =====================================================================
// 工具
// =====================================================================

function buildRecommendation(
  packageName: string,
  versions: DuplicateVersionInfo['versions'],
  directPackages: string[],
  aliases: string[],
  isLargeLibrary: boolean,
): string {
  const parts: string[] = []

  if (isLargeLibrary) {
    parts.push(`${packageName} 是大型基础库，多版本并存会显著增加 bundle 体积`)
  }

  if (aliases.length > 0) {
    parts.push(
      `alias 包（${aliases.join(', ')}）指向不同版本，建议评估是否可统一`,
    )
  }

  if (directPackages.length > 1) {
    parts.push(`多个直接依赖声明了不同版本，建议统一到一个版本`)
  }

  if (versions.some(v => v.source === 'transitive')) {
    parts.push(`部分版本由传递依赖引入，可尝试升级直接依赖来统一版本`)
  }

  parts.push(
    `当前共 ${versions.length} 个版本：${versions.map(v => v.version).join(', ')}`,
  )

  return parts.join('。')
}
