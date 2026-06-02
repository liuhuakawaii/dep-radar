/**
 * 构建产物分析器
 *
 * 从 webpack stats.json / Vite manifest / 构建输出目录读取真实 bundle 数据，
 * 区分"包级估算"和"项目 bundle 贡献"。
 *
 * 支持三类输入：
 *   1. webpack stats.json — 解析 chunks/assets/modules，按 node_modules/<pkg> 归因
 *   2. 构建输出目录 — 计算每个 JS/CSS 文件的 raw/gzip 大小
 *   3. 两者都没有时返回空（使用包级估算 fallback）
 */

import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'

// =====================================================================
// 公开类型
// =====================================================================

export interface AssetInfo {
  /** 文件名（如 main.js、vendors.js） */
  name: string
  /** 文件路径（相对于构建输出目录） */
  path: string
  /** 原始字节数 */
  size: number
  /** gzip 字节数 */
  gzip: number
  /** 所属 chunk 名称 */
  chunkName?: string
}

export interface PackageContribution {
  /** 包名 */
  packageName: string
  /** 在该包的模块总大小（bytes，未 gzip） */
  moduleSize: number
  /** 包含该包模块的 chunk 列表 */
  chunks: string[]
  /** 占总 bundle 的百分比（0-100） */
  percent: number
}

export interface BuildArtifactResult {
  /** 所有 JS/CSS 资源 */
  assets: AssetInfo[]
  /** 总 JS 原始大小 */
  totalJsSize: number
  /** 总 JS gzip 大小 */
  totalJsGzip: number
  /** 总 CSS 原始大小 */
  totalCssSize: number
  /** 总 CSS gzip 大小 */
  totalCssGzip: number
  /** 按包归因的贡献（从 stats.json 解析） */
  packageContributions: PackageContribution[]
  /** 数据来源 */
  source: 'webpack-stats' | 'assets-dir' | 'none'
  /** 警告信息 */
  warnings: string[]
}

export interface BuildArtifactOptions {
  /** webpack stats.json 文件路径 */
  statsFile?: string
  /** 构建输出目录路径 */
  assetsDir?: string
}

// =====================================================================
// 主函数
// =====================================================================

/**
 * 分析构建产物
 *
 * @param projectPath 项目根目录
 * @param options 选项
 * @returns BuildArtifactResult
 */
export async function analyzeBuildArtifacts(
  projectPath: string,
  options: BuildArtifactOptions = {},
): Promise<BuildArtifactResult> {
  const { statsFile, assetsDir } = options
  const warnings: string[] = []

  // 1. 尝试从 stats.json 解析
  if (statsFile) {
    const absStats = join(projectPath, statsFile)
    if (existsSync(absStats)) {
      try {
        return await parseWebpackStats(
          absStats,
          assetsDir ? join(projectPath, assetsDir) : undefined,
        )
      } catch (err) {
        warnings.push(
          `stats.json 解析失败：${err instanceof Error ? err.message : String(err)}`,
        )
      }
    } else {
      warnings.push(`stats 文件不存在：${absStats}`)
    }
  }

  // 2. 尝试从构建输出目录分析
  if (assetsDir) {
    const absDir = join(projectPath, assetsDir)
    if (existsSync(absDir)) {
      try {
        return await analyzeAssetsDir(absDir)
      } catch (err) {
        warnings.push(
          `构建目录分析失败：${err instanceof Error ? err.message : String(err)}`,
        )
      }
    } else {
      warnings.push(`构建目录不存在：${absDir}`)
    }
  }

  // 3. 无数据
  return {
    assets: [],
    totalJsSize: 0,
    totalJsGzip: 0,
    totalCssSize: 0,
    totalCssGzip: 0,
    packageContributions: [],
    source: 'none',
    warnings,
  }
}

// =====================================================================
// webpack stats.json 解析
// =====================================================================

interface WebpackStatsAsset {
  name: string
  size: number
  chunks?: Array<number | string>
}

interface WebpackStatsModule {
  name?: string
  size?: number
  chunks?: Array<number | string>
  modules?: Array<{
    name?: string
    size?: number
    chunks?: Array<number | string>
  }>
}

interface WebpackStatsChunk {
  id: number | string
  names?: string[]
  files?: string[]
}

interface WebpackStatsJson {
  assets?: WebpackStatsAsset[]
  modules?: WebpackStatsModule[]
  chunks?: WebpackStatsChunk[]
}

async function parseWebpackStats(
  statsPath: string,
  assetsDir?: string,
): Promise<BuildArtifactResult> {
  const raw = await readFile(statsPath, 'utf-8')
  const stats = JSON.parse(raw) as WebpackStatsJson

  const assets: AssetInfo[] = []
  const warnings: string[] = []

  // 解析 assets
  for (const asset of stats.assets ?? []) {
    const isJs = asset.name.endsWith('.js')
    const isCss = asset.name.endsWith('.css')
    if (!isJs && !isCss) continue

    let gzip = 0
    // 尝试从构建目录读取实际文件计算 gzip
    if (assetsDir) {
      const filePath = join(assetsDir, asset.name)
      if (existsSync(filePath)) {
        try {
          const content = await readFile(filePath)
          gzip = gzipSync(content).length
        } catch {
          gzip = Math.round(asset.size * 0.3) // 粗略估算
        }
      }
    }
    if (gzip === 0) {
      gzip = Math.round(asset.size * 0.3) // gzip 通常约为原始大小的 30%
    }

    // 找到 chunk 名称
    let chunkName: string | undefined
    if (asset.chunks && stats.chunks) {
      for (const chunk of stats.chunks) {
        if (asset.chunks.includes(chunk.id) && chunk.names?.length) {
          chunkName = chunk.names[0]
          break
        }
      }
    }

    assets.push({
      name: asset.name,
      path: asset.name,
      size: asset.size,
      gzip,
      chunkName,
    })
  }

  // 解析 modules 归因到包
  const packageSizes = new Map<string, { size: number; chunks: Set<string> }>()

  for (const mod of stats.modules ?? []) {
    const modName = mod.name ?? ''
    const modSize = mod.size ?? 0

    // 处理子模块（concatenated modules）
    const subModules = mod.modules ?? [mod]
    for (const sub of subModules) {
      const subName = sub.name ?? modName
      const subSize = sub.size ?? modSize
      const pkgName = extractPackageFromModulePath(subName)

      if (!pkgName) continue

      const existing = packageSizes.get(pkgName) ?? {
        size: 0,
        chunks: new Set<string>(),
      }
      existing.size += subSize

      // 关联 chunk
      const chunkIds = sub.chunks ?? mod.chunks ?? []
      for (const chunkId of chunkIds) {
        const chunk = stats.chunks?.find(c => c.id === chunkId)
        if (chunk?.names?.length) {
          existing.chunks.add(chunk.names[0]!)
        } else {
          existing.chunks.add(String(chunkId))
        }
      }

      packageSizes.set(pkgName, existing)
    }
  }

  // 计算总量和百分比
  const totalModuleSize = [...packageSizes.values()].reduce(
    (s, p) => s + p.size,
    0,
  )
  const packageContributions: PackageContribution[] = [
    ...packageSizes.entries(),
  ]
    .map(([packageName, { size, chunks }]) => ({
      packageName,
      moduleSize: size,
      chunks: [...chunks],
      percent: totalModuleSize > 0 ? (size / totalModuleSize) * 100 : 0,
    }))
    .sort((a, b) => b.moduleSize - a.moduleSize)

  const totalJsSize = assets
    .filter(a => a.name.endsWith('.js'))
    .reduce((s, a) => s + a.size, 0)
  const totalJsGzip = assets
    .filter(a => a.name.endsWith('.js'))
    .reduce((s, a) => s + a.gzip, 0)
  const totalCssSize = assets
    .filter(a => a.name.endsWith('.css'))
    .reduce((s, a) => s + a.size, 0)
  const totalCssGzip = assets
    .filter(a => a.name.endsWith('.css'))
    .reduce((s, a) => s + a.gzip, 0)

  return {
    assets,
    totalJsSize,
    totalJsGzip,
    totalCssSize,
    totalCssGzip,
    packageContributions,
    source: 'webpack-stats',
    warnings,
  }
}

/**
 * 从模块路径提取包名
 *
 * node_modules/lodash/lodash.js → lodash
 * node_modules/@babel/core/lib/index.js → @babel/core
 * ./src/App.tsx → null
 */
export function extractPackageFromModulePath(
  modulePath: string,
): string | null {
  // 标准化路径分隔符
  const normalized = modulePath.replace(/\\/g, '/')
  const nmMatch = normalized.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)
  if (nmMatch) return nmMatch[1] ?? null
  return null
}

// =====================================================================
// 构建输出目录分析
// =====================================================================

async function analyzeAssetsDir(dirPath: string): Promise<BuildArtifactResult> {
  const assets: AssetInfo[] = []
  const warnings: string[] = []

  let files: string[]
  try {
    files = await readdir(dirPath)
  } catch {
    return {
      assets: [],
      totalJsSize: 0,
      totalJsGzip: 0,
      totalCssSize: 0,
      totalCssGzip: 0,
      packageContributions: [],
      source: 'none',
      warnings: ['无法读取构建目录'],
    }
  }

  for (const file of files) {
    const isJs = file.endsWith('.js')
    const isCss = file.endsWith('.css')
    if (!isJs && !isCss) continue

    const filePath = join(dirPath, file)
    try {
      const fileStat = await stat(filePath)
      if (!fileStat.isFile()) continue

      const content = await readFile(filePath)
      const gzip = gzipSync(content).length

      assets.push({
        name: file,
        path: relative(dirPath, filePath),
        size: fileStat.size,
        gzip,
      })
    } catch {
      warnings.push(`无法读取文件：${file}`)
    }
  }

  const totalJsSize = assets
    .filter(a => a.name.endsWith('.js'))
    .reduce((s, a) => s + a.size, 0)
  const totalJsGzip = assets
    .filter(a => a.name.endsWith('.js'))
    .reduce((s, a) => s + a.gzip, 0)
  const totalCssSize = assets
    .filter(a => a.name.endsWith('.css'))
    .reduce((s, a) => s + a.size, 0)
  const totalCssGzip = assets
    .filter(a => a.name.endsWith('.css'))
    .reduce((s, a) => s + a.gzip, 0)

  return {
    assets,
    totalJsSize,
    totalJsGzip,
    totalCssSize,
    totalCssGzip,
    packageContributions: [],
    source: 'assets-dir',
    warnings,
  }
}
