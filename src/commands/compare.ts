/**
 * `compare` 命令：对比两个项目的依赖差异
 *
 * 支持多维度对比：
 *   - size（默认）：体积 diff
 *   - health：健康度分数 diff
 *   - license：许可证风险 diff
 *
 * 每个维度独立渲染为一个 section。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import chalk from 'chalk'
import Table from 'cli-table3'
import ora from 'ora'

const execFileP = promisify(execFile)

import { analyzeBundleSize } from '../analyzers/bundle.js'
import { analyzeHealth } from '../analyzers/health.js'
import { analyzeLicenses } from '../analyzers/license.js'
import type { BundleInfo, HealthInfo, LicenseInfo } from '../types/analysis.js'
import type { PackageJson } from '../types/package.js'
import { EXIT_CODES, type ExitCode } from '../utils/exitCode.js'
import { formatBytes } from '../utils/format.js'
import { readPackageJson } from '../utils/fs.js'
import { logger } from '../utils/logger.js'

import { buildBundleFetcher } from './buildBundleFetcher.js'
import { buildHealthFetcher } from './buildHealthFetcher.js'
import { buildLicenseFetcher } from './buildLicenseFetcher.js'

const ALL_COMPARE_DIMENSIONS = ['size', 'health', 'license'] as const
type CompareDimension = (typeof ALL_COMPARE_DIMENSIONS)[number]

// =====================================================================
// 公开类型
// =====================================================================

export interface CompareOptions {
  /** 同时比较 devDependencies */
  includeDev?: boolean
  /** 要比较的维度；默认 ['size'] */
  dimensions?: string[]
  /** 是否禁用缓存 */
  cacheEnabled?: boolean
  /** 自定义缓存目录 */
  cacheDir?: string
  /** 自定义 npm registry */
  registry?: string
  /** 并发请求数 */
  concurrency?: number
  /** 增量对比：与指定 git ref 的 package.json 对比（忽略 pathB） */
  since?: string
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

// ---- health diff ----

export interface HealthDiffEntry {
  name: string
  fromScore: number
  toScore: number
  scoreDelta: number
  fromDeprecated: boolean
  toDeprecated: boolean
}

export interface HealthDiffResult {
  entries: HealthDiffEntry[]
  onlyInA: string[]
  onlyInB: string[]
}

// ---- license diff ----

export interface LicenseDiffEntry {
  name: string
  fromLicense: string
  toLicense: string
  fromRisk: string
  toRisk: string
  riskChanged: boolean
}

export interface LicenseDiffResult {
  entries: LicenseDiffEntry[]
  onlyInA: string[]
  onlyInB: string[]
}

// =====================================================================
// 主入口
// =====================================================================

export async function compareCommand(
  pathA: string,
  pathB: string,
  options: CompareOptions = {},
): Promise<ExitCode> {
  const {
    includeDev = false,
    dimensions: dimOpt,
    registry,
    concurrency = 5,
    since,
  } = options

  const dimensions = parseCompareDimensions(dimOpt)
  const wantSize = dimensions.includes('size')
  const wantHealth = dimensions.includes('health')
  const wantLicense = dimensions.includes('license')

  // 1) 读取两份 package.json
  let pkgA: PackageJson
  let pkgB: PackageJson

  if (since) {
    // 增量对比模式：pathA 为当前项目，pathB 被忽略
    try {
      pkgA = await readPackageJson(pathA)
    } catch {
      logger.error(`无法读取当前项目 package.json：${pathA}`)
      return EXIT_CODES.ERROR
    }
    try {
      const { stdout } = await execFileP(
        'git',
        ['show', `${since}:package.json`],
        {
          cwd: pathA,
          timeout: 10_000,
        },
      )
      pkgB = JSON.parse(stdout) as PackageJson
    } catch {
      logger.error(`无法读取 git ref "${since}" 的 package.json`)
      return EXIT_CODES.ERROR
    }
  } else {
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
  }

  // 2) 渲染标题
  const sections: string[] = []
  const titleB = since ? `${since}` : pkgB.name
  sections.push(chalk.bold(`依赖对比：${pkgA.name} → ${titleB}`))

  // 3) 按维度分析

  // size 维度
  if (wantSize) {
    const fetcher = buildBundleFetcher()
    const spinner = ora('正在分析基准项目体积...').start()
    let bundlesA: BundleInfo[]
    try {
      const result = await analyzeBundleSize(pkgA, fetcher, {
        concurrency,
        includeDev,
      })
      bundlesA = result.bundles
      spinner.succeed('基准项目体积分析完成')
    } catch (err) {
      spinner.fail('基准项目体积分析失败')
      throw err
    }

    spinner.start('正在分析对比项目体积...')
    let bundlesB: BundleInfo[]
    try {
      const result = await analyzeBundleSize(pkgB, fetcher, {
        concurrency,
        includeDev,
      })
      bundlesB = result.bundles
      spinner.succeed('对比项目体积分析完成')
    } catch (err) {
      spinner.fail('对比项目体积分析失败')
      throw err
    }

    const sizeResult = diffBundles(bundlesA, bundlesB)
    sections.push(renderSizeSection(sizeResult))
  }

  // health 维度
  if (wantHealth) {
    const spinner = ora('正在分析健康度...').start()
    try {
      const fetcher = buildHealthFetcher({ registry })
      const [hA, hB] = await Promise.all([
        analyzeHealth(pkgA, fetcher, { concurrency, includeDev }),
        analyzeHealth(pkgB, fetcher, { concurrency, includeDev }),
      ])
      const healthResult = diffHealth(hA.health, hB.health)
      sections.push(renderHealthSection(healthResult))
      spinner.succeed('健康度对比完成')
    } catch (err) {
      spinner.fail('健康度分析失败')
      logger.warn(
        `健康度对比跳过：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // license 维度
  if (wantLicense) {
    const spinner = ora('正在分析许可证...').start()
    try {
      const fetcher = buildLicenseFetcher({ registry })
      const [lA, lB] = await Promise.all([
        analyzeLicenses(pkgA, fetcher),
        analyzeLicenses(pkgB, fetcher),
      ])
      const licenseResult = diffLicenses(lA.licenses, lB.licenses)
      sections.push(renderLicenseSection(licenseResult))
      spinner.succeed('许可证对比完成')
    } catch (err) {
      spinner.fail('许可证分析失败')
      logger.warn(
        `许可证对比跳过：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  process.stdout.write(sections.join('\n\n') + '\n')
  return EXIT_CODES.OK
}

function parseCompareDimensions(input?: string[]): CompareDimension[] {
  if (!input || input.length === 0) return ['size']
  const valid: CompareDimension[] = []
  for (const d of input) {
    if (ALL_COMPARE_DIMENSIONS.includes(d as CompareDimension)) {
      valid.push(d as CompareDimension)
    } else {
      logger.warn(
        `未知维度 "${d}"，已跳过（可选：${ALL_COMPARE_DIMENSIONS.join(', ')}）`,
      )
    }
  }
  return valid.length > 0 ? valid : ['size']
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
 * 将 CompareResult 渲染为体积 diff section
 */
export function renderSizeSection(result: CompareResult): string {
  const sections: string[] = []

  sections.push(
    chalk.bold('[ 体积对比 ]') +
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

// =====================================================================
// Health diff + render
// =====================================================================

export function diffHealth(
  healthA: HealthInfo[],
  healthB: HealthInfo[],
): HealthDiffResult {
  const mapA = new Map<string, HealthInfo>()
  const mapB = new Map<string, HealthInfo>()
  for (const h of healthA) mapA.set(h.name, h)
  for (const h of healthB) mapB.set(h.name, h)

  const entries: HealthDiffEntry[] = []
  const onlyInA: string[] = []
  const onlyInB: string[] = []

  for (const [name, a] of mapA) {
    if (!mapB.has(name)) {
      onlyInA.push(name)
      continue
    }
    const b = mapB.get(name)!
    entries.push({
      name,
      fromScore: a.healthScore,
      toScore: b.healthScore,
      scoreDelta: b.healthScore - a.healthScore,
      fromDeprecated: a.deprecated,
      toDeprecated: b.deprecated,
    })
  }

  for (const [name] of mapB) {
    if (!mapA.has(name)) onlyInB.push(name)
  }

  entries.sort((a, b) => Math.abs(b.scoreDelta) - Math.abs(a.scoreDelta))

  return { entries, onlyInA, onlyInB }
}

function renderHealthSection(result: HealthDiffResult): string {
  const sections: string[] = []
  sections.push(chalk.bold('[ 健康度对比 ]'))

  if (
    result.entries.length === 0 &&
    result.onlyInA.length === 0 &&
    result.onlyInB.length === 0
  ) {
    sections.push(chalk.green('  无共同依赖可对比'))
    return sections.join('\n')
  }

  const table = new Table({
    head: ['包名', '基准分数', '对比分数', '差异'].map(s => chalk.cyan(s)),
    colWidths: [28, 12, 12, 12],
  })

  for (const e of result.entries) {
    const deltaStr =
      e.scoreDelta === 0 ? '0' : `${e.scoreDelta > 0 ? '+' : ''}${e.scoreDelta}`
    const color =
      e.scoreDelta > 0 ? chalk.green : e.scoreDelta < 0 ? chalk.red : chalk.gray
    const deprecated = e.toDeprecated ? chalk.red(' [deprecated]') : ''
    table.push([
      e.name + deprecated,
      String(e.fromScore),
      String(e.toScore),
      color(deltaStr),
    ])
  }

  sections.push(table.toString())

  const parts: string[] = []
  if (result.onlyInA.length > 0)
    parts.push(chalk.red(`-${result.onlyInA.length} 仅在基准`))
  if (result.onlyInB.length > 0)
    parts.push(chalk.green(`+${result.onlyInB.length} 仅在对比`))
  if (parts.length > 0) sections.push(`  ${parts.join('，')}`)

  return sections.join('\n')
}

// =====================================================================
// License diff + render
// =====================================================================

export function diffLicenses(
  licensesA: LicenseInfo[],
  licensesB: LicenseInfo[],
): LicenseDiffResult {
  const mapA = new Map<string, LicenseInfo>()
  const mapB = new Map<string, LicenseInfo>()
  for (const l of licensesA) mapA.set(l.name, l)
  for (const l of licensesB) mapB.set(l.name, l)

  const entries: LicenseDiffEntry[] = []
  const onlyInA: string[] = []
  const onlyInB: string[] = []

  for (const [name, a] of mapA) {
    if (!mapB.has(name)) {
      onlyInA.push(name)
      continue
    }
    const b = mapB.get(name)!
    entries.push({
      name,
      fromLicense: a.license ?? 'unknown',
      toLicense: b.license ?? 'unknown',
      fromRisk: a.risk,
      toRisk: b.risk,
      riskChanged: a.risk !== b.risk,
    })
  }

  for (const [name] of mapB) {
    if (!mapA.has(name)) onlyInB.push(name)
  }

  // 风险升高的排前面
  const riskOrder: Record<string, number> = { low: 0, medium: 1, high: 2 }
  entries.sort((a, b) => {
    if (a.riskChanged !== b.riskChanged) return a.riskChanged ? -1 : 1
    return (riskOrder[b.toRisk] ?? 0) - (riskOrder[a.toRisk] ?? 0)
  })

  return { entries, onlyInA, onlyInB }
}

function renderLicenseSection(result: LicenseDiffResult): string {
  const sections: string[] = []
  sections.push(chalk.bold('[ 许可证对比 ]'))

  if (
    result.entries.length === 0 &&
    result.onlyInA.length === 0 &&
    result.onlyInB.length === 0
  ) {
    sections.push(chalk.green('  无共同依赖可对比'))
    return sections.join('\n')
  }

  const changed = result.entries.filter(e => e.riskChanged)
  if (changed.length === 0) {
    sections.push(chalk.green('  所有共同依赖的许可证风险等级一致'))
  } else {
    const table = new Table({
      head: ['包名', '基准许可证', '对比许可证', '基准风险', '对比风险'].map(
        s => chalk.cyan(s),
      ),
      colWidths: [24, 16, 16, 10, 10],
    })

    for (const e of changed) {
      const riskColor = (r: string) =>
        r === 'high'
          ? chalk.red(r)
          : r === 'medium'
            ? chalk.yellow(r)
            : chalk.green(r)
      table.push([
        e.name,
        e.fromLicense,
        e.toLicense,
        riskColor(e.fromRisk),
        riskColor(e.toRisk),
      ])
    }

    sections.push(table.toString())
  }

  const parts: string[] = []
  if (result.onlyInA.length > 0)
    parts.push(chalk.red(`-${result.onlyInA.length} 仅在基准`))
  if (result.onlyInB.length > 0)
    parts.push(chalk.green(`+${result.onlyInB.length} 仅在对比`))
  if (parts.length > 0) sections.push(`  ${parts.join('，')}`)

  return sections.join('\n')
}
