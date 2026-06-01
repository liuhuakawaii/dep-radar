/**
 * `compare` 命令：对比两个项目的依赖差异
 *
 * 对两份 package.json 分别跑体积分析，然后 diff：
 *   - 新增依赖（B 有 A 无）
 *   - 移除依赖（A 有 B 无）
 *   - 版本变更（版本号不同，附带体积差 delta）
 *   - 总体积差 / 总 gzip 差
 *
 * 输出为终端 diff 风格表格：
 *   绿色 +  新增
 *   红色 -  移除
 *   黄色 ~  变更
 */

import chalk from 'chalk'
import Table from 'cli-table3'
import ora from 'ora'

import type { BundleInfo } from '../types/analysis.js'
import type { PackageJson } from '../types/package.js'
import { EXIT_CODES, type ExitCode } from '../utils/exitCode.js'
import { formatBytes } from '../utils/format.js'
import { readPackageJson } from '../utils/fs.js'
import { logger } from '../utils/logger.js'

import { analyzeBundleSize } from '../analyzers/bundle.js'
import { buildBundleFetcher } from './buildBundleFetcher.js'

// =====================================================================
// 公开类型
// =====================================================================

export interface CompareOptions {
  /** 同时比较 devDependencies */
  includeDev?: boolean
}

/** 单个新增包 */
export interface AddedEntry {
  name: string
  version: string
  size: number
  gzip: number
}

/** 单个移除包 */
export interface RemovedEntry {
  name: string
  version: string
  size: number
  gzip: number
}

/** 单个版本/体积变更包 */
export interface ChangedEntry {
  name: string
  fromVersion: string
  toVersion: string
  fromSize: number
  toSize: number
  sizeDelta: number
  gzipDelta: number
}

export interface CompareResult {
  added: AddedEntry[]
  removed: RemovedEntry[]
  changed: ChangedEntry[]
  totalSizeDelta: number
  totalGzipDelta: number
}

// =====================================================================
// 主入口
// =====================================================================

export async function compareCommand(
  pathA: string,
  pathB: string,
  options: CompareOptions = {},
): Promise<ExitCode> {
  const { includeDev = false } = options

  // 1) 读取两份 package.json
  let pkgA: PackageJson
  let pkgB: PackageJson
  try {
    pkgA = await readPackageJson(pathA)
  } catch {
    logger.error(`无法读取基准项目 package.json：${pathA}`)
    return EXIT_CODES.ERROR
  }
  try {
    pkgB = await readPackageJson(pathB)
  } catch {
    logger.error(`无法读取对比项目 package.json：${pathB}`)
    return EXIT_CODES.ERROR
  }

  // 2) 分别跑体积分析
  const fetcher = buildBundleFetcher()

  const spinner = ora('正在分析基准项目体积...').start()
  let bundlesA: BundleInfo[]
  try {
    const result = await analyzeBundleSize(pkgA, fetcher, {
      concurrency: 5,
      includeDev,
    })
    bundlesA = result.bundles
    spinner.succeed('基准项目分析完成')
  } catch (err) {
    spinner.fail('基准项目分析失败')
    throw err
  }

  spinner.start('正在分析对比项目体积...')
  let bundlesB: BundleInfo[]
  try {
    const result = await analyzeBundleSize(pkgB, fetcher, {
      concurrency: 5,
      includeDev,
    })
    bundlesB = result.bundles
    spinner.succeed('对比项目分析完成')
  } catch (err) {
    spinner.fail('对比项目分析失败')
    throw err
  }

  // 3) Diff
  const result = diffBundles(bundlesA, bundlesB)

  // 4) 渲染
  const output = renderCompareTable(result, pkgA.name, pkgB.name)
  process.stdout.write(output + '\n')

  return EXIT_CODES.OK
}

// =====================================================================
// Diff 纯函数（导出供测试）
// =====================================================================

/**
 * 对比两组 BundleInfo，计算新增 / 移除 / 变更
 *
 * 纯函数，无副作用。
 */
export function diffBundles(
  bundlesA: BundleInfo[],
  bundlesB: BundleInfo[],
): CompareResult {
  const mapA = new Map<string, BundleInfo>()
  const mapB = new Map<string, BundleInfo>()
  for (const b of bundlesA) mapA.set(b.name, b)
  for (const b of bundlesB) mapB.set(b.name, b)

  const added: AddedEntry[] = []
  const removed: RemovedEntry[] = []
  const changed: ChangedEntry[] = []

  // B 中有、A 中无 → 新增
  for (const [name, b] of mapB) {
    if (!mapA.has(name)) {
      added.push({
        name,
        version: b.version,
        size: b.size,
        gzip: b.gzip,
      })
    }
  }

  // A 中有、B 中无 → 移除
  for (const [name, a] of mapA) {
    if (!mapB.has(name)) {
      removed.push({
        name,
        version: a.version,
        size: a.size,
        gzip: a.gzip,
      })
    }
  }

  // 两边都有 → 检查版本 / 体积是否变更
  for (const [name, a] of mapA) {
    const b = mapB.get(name)
    if (!b) continue
    if (a.version === b.version && a.size === b.size && a.gzip === b.gzip) {
      continue
    }
    changed.push({
      name,
      fromVersion: a.version,
      toVersion: b.version,
      fromSize: a.size,
      toSize: b.size,
      sizeDelta: b.size - a.size,
      gzipDelta: b.gzip - a.gzip,
    })
  }

  // 排序：新增按 gzip 降序，移除按 gzip 降序，变更按 |gzipDelta| 降序
  added.sort((a, b) => b.gzip - a.gzip)
  removed.sort((a, b) => b.gzip - a.gzip)
  changed.sort((a, b) => Math.abs(b.gzipDelta) - Math.abs(a.gzipDelta))

  const totalSizeDelta =
    added.reduce((s, e) => s + e.size, 0) -
    removed.reduce((s, e) => s + e.size, 0) +
    changed.reduce((s, e) => s + e.sizeDelta, 0)

  const totalGzipDelta =
    added.reduce((s, e) => s + e.gzip, 0) -
    removed.reduce((s, e) => s + e.gzip, 0) +
    changed.reduce((s, e) => s + e.gzipDelta, 0)

  return { added, removed, changed, totalSizeDelta, totalGzipDelta }
}

// =====================================================================
// 渲染（导出供测试）
// =====================================================================

/**
 * 将 CompareResult 渲染为终端 diff 风格表格
 */
export function renderCompareTable(
  result: CompareResult,
  nameA: string,
  nameB: string,
): string {
  const sections: string[] = []

  // 标题
  sections.push(
    chalk.bold(`依赖对比：${nameA} → ${nameB}`) +
      chalk.gray(`  (gzip 差异：${formatDelta(result.totalGzipDelta)})`),
  )

  if (
    result.added.length === 0 &&
    result.removed.length === 0 &&
    result.changed.length === 0
  ) {
    sections.push(chalk.green('  无差异'))
    return sections.join('\n')
  }

  const table = new Table({
    head: ['状态', '包名', '版本 / 变更', 'gzip', 'gzip 差异'].map(s =>
      chalk.cyan(s),
    ),
    colWidths: [8, 28, 22, 14, 14],
  })

  // 新增
  for (const e of result.added) {
    table.push([
      chalk.green('+ 新增'),
      chalk.green(e.name),
      chalk.green(e.version),
      chalk.green(formatBytes(e.gzip)),
      chalk.green(`+${formatBytes(e.gzip)}`),
    ])
  }

  // 移除
  for (const e of result.removed) {
    table.push([
      chalk.red('- 移除'),
      chalk.red(e.name),
      chalk.red(e.version),
      chalk.red(formatBytes(e.gzip)),
      chalk.red(`-${formatBytes(e.gzip)}`),
    ])
  }

  // 变更
  for (const e of result.changed) {
    const versionStr =
      e.fromVersion === e.toVersion
        ? e.toVersion
        : `${e.fromVersion} → ${e.toVersion}`
    table.push([
      chalk.yellow('~ 变更'),
      chalk.yellow(e.name),
      chalk.yellow(versionStr),
      chalk.yellow(formatBytes(e.toSize)),
      chalk.yellow(formatDelta(e.gzipDelta)),
    ])
  }

  sections.push(table.toString())

  // 汇总行
  const summaryParts: string[] = []
  if (result.added.length > 0)
    summaryParts.push(chalk.green(`+${result.added.length} 新增`))
  if (result.removed.length > 0)
    summaryParts.push(chalk.red(`-${result.removed.length} 移除`))
  if (result.changed.length > 0)
    summaryParts.push(chalk.yellow(`~${result.changed.length} 变更`))

  sections.push(
    `  汇总：${summaryParts.join('，')}  |  gzip 总差异：${formatDelta(result.totalGzipDelta)}`,
  )

  return sections.join('\n')
}

// =====================================================================
// 工具
// =====================================================================

function formatDelta(delta: number): string {
  if (delta === 0) return '0 B'
  const sign = delta > 0 ? '+' : '-'
  return `${sign}${formatBytes(Math.abs(delta))}`
}
