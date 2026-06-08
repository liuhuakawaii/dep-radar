/**
 * `diff` 命令：对比两次扫描报告
 *
 * 读取两个 JSON 报告文件，计算依赖变更（新增/移除/体积变化/健康度变化等），
 * 输出 diff 报告。适用于 PR 依赖审查场景。
 */

import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

import type {
  AnalysisReport,
  BundleInfo,
  DiffReport,
  SecurityInfo,
} from '../types/analysis.js'
import type { ExitCode } from '../utils/exitCode.js'
import { EXIT_CODES } from '../utils/exitCode.js'
import { logger } from '../utils/logger.js'
import { renderDiffReport } from '../report/diff.js'

export interface DiffOptions {
  format?: 'terminal' | 'json'
  output?: string
}

export async function diffCommand(
  beforePath: string,
  afterPath: string,
  options: DiffOptions = {},
): Promise<ExitCode> {
  const { format = 'terminal', output } = options

  // 1. 读取报告
  let before: AnalysisReport
  let after: AnalysisReport
  try {
    before = JSON.parse(readFileSync(beforePath, 'utf-8')) as AnalysisReport
    after = JSON.parse(readFileSync(afterPath, 'utf-8')) as AnalysisReport
  } catch (err) {
    logger.error(
      `无法读取报告文件：${err instanceof Error ? err.message : String(err)}`,
    )
    return EXIT_CODES.ERROR
  }

  // 2. 校验
  if (!before.summary || !after.summary) {
    logger.error('报告文件格式不正确，缺少 summary 字段')
    return EXIT_CODES.ERROR
  }

  // 3. 计算 diff
  const diff = computeDiff(before, after)

  // 4. 输出
  const rendered = renderDiffReport(diff, format)

  if (output) {
    await writeFile(output, rendered, 'utf-8')
    logger.success(`diff 报告已写入 ${output}`)
  } else {
    process.stdout.write(rendered + '\n')
  }

  // 5. 退出码：基于 after 报告的 summary 判断
  if (
    after.summary.vulnerabilities.critical > 0 ||
    after.summary.vulnerabilities.high > 0
  ) {
    return EXIT_CODES.HIGH_VULNERABILITY
  }
  if (after.summary.licenseIssues > 0) {
    return EXIT_CODES.LICENSE_CONFLICT
  }
  return EXIT_CODES.OK
}

function computeDiff(
  before: AnalysisReport,
  after: AnalysisReport,
): DiffReport {
  return {
    before: { project: before.project, timestamp: before.timestamp },
    after: { project: after.project, timestamp: after.timestamp },
    summary: {
      totalGzip: {
        before: before.summary.totalGzip,
        after: after.summary.totalGzip,
      },
      totalSize: {
        before: before.summary.totalSize,
        after: after.summary.totalSize,
      },
      totalDependencies: {
        before: before.summary.totalDependencies,
        after: after.summary.totalDependencies,
      },
      deprecatedCount: {
        before: before.summary.deprecatedCount,
        after: after.summary.deprecatedCount,
      },
      vulnerabilities: {
        before: before.summary.vulnerabilities,
        after: after.summary.vulnerabilities,
      },
    },
    bundles: diffBundles(before.bundles ?? [], after.bundles ?? []),
    health: diffHealth(before, after),
    security: diffSecurity(before.security ?? [], after.security ?? []),
  }
}

function diffBundles(
  before: BundleInfo[],
  after: BundleInfo[],
): DiffReport['bundles'] {
  const beforeMap = new Map(
    before.filter(b => b.isDirect).map(b => [b.name, b]),
  )
  const afterMap = new Map(after.filter(b => b.isDirect).map(b => [b.name, b]))

  const added: BundleInfo[] = []
  const removed: BundleInfo[] = []
  const changed: DiffReport['bundles']['changed'] = []

  for (const [name, afterBundle] of afterMap) {
    const beforeBundle = beforeMap.get(name)
    if (!beforeBundle) {
      added.push(afterBundle)
    } else if (beforeBundle.gzip !== afterBundle.gzip) {
      changed.push({
        name,
        beforeGzip: beforeBundle.gzip,
        afterGzip: afterBundle.gzip,
        delta: afterBundle.gzip - beforeBundle.gzip,
      })
    }
  }

  for (const [name, beforeBundle] of beforeMap) {
    if (!afterMap.has(name)) {
      removed.push(beforeBundle)
    }
  }

  // 按 |delta| 降序排列
  changed.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  return { added, removed, changed }
}

function diffHealth(
  before: AnalysisReport,
  after: AnalysisReport,
): DiffReport['health'] {
  const beforeHealth = new Map(
    (before.health ?? []).filter(h => h.isDirect).map(h => [h.name, h]),
  )
  const afterHealth = new Map(
    (after.health ?? []).filter(h => h.isDirect).map(h => [h.name, h]),
  )

  const newlyDeprecated: DiffReport['health']['newlyDeprecated'] = []
  const scoreChanges: DiffReport['health']['scoreChanges'] = []

  for (const [name, afterH] of afterHealth) {
    const beforeH = beforeHealth.get(name)
    if (afterH.deprecated && (!beforeH || !beforeH.deprecated)) {
      newlyDeprecated.push({ name, message: afterH.deprecatedMessage })
    }
    if (beforeH && beforeH.healthScore !== afterH.healthScore) {
      scoreChanges.push({
        name,
        before: beforeH.healthScore,
        after: afterH.healthScore,
      })
    }
  }

  scoreChanges.sort(
    (a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before),
  )

  return { newlyDeprecated, scoreChanges }
}

function diffSecurity(
  before: SecurityInfo[],
  after: SecurityInfo[],
): DiffReport['security'] {
  const beforeNames = new Set(before.map(s => s.name))
  const afterNames = new Set(after.map(s => s.name))

  const newVulns = after.filter(s => !beforeNames.has(s.name))
  const resolved = before.filter(s => !afterNames.has(s.name))

  return { new: newVulns, resolved }
}
