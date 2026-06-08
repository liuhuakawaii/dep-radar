/**
 * `explain` 命令：解释单个依赖为什么存在
 *
 * 回答：这个包为什么在项目中？是直接依赖还是传递依赖？
 * 被源码引用了吗？可以删除/移动吗？
 */

import chalk from 'chalk'

import { classifyDependencies } from '../analyzers/classifier.js'
import { detectHygieneIssues } from '../analyzers/dependencyHygiene.js'
import { buildInventory } from '../analyzers/inventory.js'
import { analyzeReachability } from '../analyzers/reachability.js'
import type { ExplainResult } from '../types/analysis.js'
import type { DependencyEntry } from '../types/inventory.js'
import type { ReachabilityResult } from '../analyzers/reachability.js'
import { EXIT_CODES, type ExitCode } from '../utils/exitCode.js'
import { logger } from '../utils/logger.js'
import {
  isSimpleReportFormat,
  listChoices,
  SIMPLE_REPORT_FORMATS,
  type SimpleReportFormat,
} from './options.js'
import { loadSetup } from './shared.js'

// =====================================================================
// 公开类型
// =====================================================================

export interface ExplainOptions {
  format?: SimpleReportFormat
  includeDev?: boolean
  cacheEnabled?: boolean
  cacheDir?: string
  registry?: string
  concurrency?: number
}

// =====================================================================
// 主入口
// =====================================================================

export async function explainCommand(
  packageName: string,
  projectPath: string,
  options: ExplainOptions = {},
): Promise<ExitCode> {
  const { format: rawFormat = 'terminal', includeDev = false } = options
  if (!isSimpleReportFormat(rawFormat)) {
    logger.error(
      `不支持的输出格式 "${String(rawFormat)}"，可选值：${listChoices(SIMPLE_REPORT_FORMATS)}`,
    )
    return EXIT_CODES.ERROR
  }
  const format = rawFormat

  // 1. Setup
  const setup = await loadSetup(projectPath)
  if (setup === null) return EXIT_CODES.ERROR
  const { config, pkg, pm } = setup

  // 2. 构建 inventory
  let inventory
  try {
    inventory = await buildInventory(projectPath, pkg, {
      includeDev,
      ignore: config.ignore,
    })
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err))
    return EXIT_CODES.ERROR
  }

  // 3. 可达性分析
  let reachabilityResults: ReachabilityResult[] = []
  try {
    reachabilityResults = await analyzeReachability(
      projectPath,
      inventory.entries,
      { srcGlobs: config.classification?.runtimeEntryGlobs },
    )
  } catch {
    // 可达性分析失败不影响 explain
  }

  // 4. 分类
  const entries = classifyDependencies(inventory.entries, pkg, {
    overrides: config.classification?.overrides,
    reachabilityResults,
  })

  // 5. 查找目标包
  const entry = entries.find(
    e => e.name === packageName || e.packageName === packageName,
  )

  if (!entry) {
    logger.error(`未找到依赖 "${packageName}"`)
    const hint = includeDev
      ? '请检查包名是否正确'
      : '请检查包名是否正确，或使用 --include-dev 包含开发依赖'
    logger.info(hint)
    return EXIT_CODES.ERROR
  }

  // 6. 构建 ExplainResult
  const reachability = reachabilityResults.find(
    r => r.packageName === entry.packageName || r.packageName === entry.name,
  )

  const hygieneIssues = detectHygieneIssues(entries, reachabilityResults)
  const hygieneIssue = hygieneIssues.find(
    i => i.packageName === entry.name || i.packageName === entry.packageName,
  )

  const result = buildExplainResult(entry, reachability, hygieneIssue, pm)

  // 7. 输出
  if (format === 'json') {
    const output = JSON.stringify(result, null, 2)
    process.stdout.write(output + '\n')
  } else {
    renderTerminalExplain(result)
  }

  return EXIT_CODES.OK
}

// =====================================================================
// 构建结果
// =====================================================================

function buildExplainResult(
  entry: DependencyEntry,
  reachability: ReachabilityResult | undefined,
  hygieneIssue:
    | { type: string; suggestedAction: string; suggestedLocation?: string }
    | undefined,
  pm: string,
): ExplainResult {
  const isImported = reachability ? reachability.importCount > 0 : false
  const importLocations = reachability
    ? reachability.importers.slice(0, 5).map(i => ({
        file: i.file,
        line: i.line,
        specifier: i.specifier,
        importKind: i.importKind,
      }))
    : undefined

  // 判断是否可移除
  let canRemove: boolean | 'maybe' = false
  let suggestedAction = '保留'
  let suggestedCommand: string | undefined

  if (hygieneIssue) {
    if (hygieneIssue.type === 'unused-direct') {
      canRemove = true
      suggestedAction = '移除（未被源码引用）'
      suggestedCommand = getRemoveCommand(entry.name, pm)
    } else if (hygieneIssue.type === 'misplaced-dependency') {
      canRemove = false
      suggestedAction = `移动到 ${hygieneIssue.suggestedLocation ?? 'devDependencies'}`
      suggestedCommand = getMoveCommand(
        entry.name,
        hygieneIssue.suggestedLocation ?? 'devDependencies',
        pm,
      )
    }
  } else if (!entry.isDirect) {
    canRemove = 'maybe'
    suggestedAction = '传递依赖，需检查父依赖是否可移除'
  } else if (!isImported) {
    canRemove = 'maybe'
    suggestedAction = '未检测到静态引用，可能是动态 import 或误声明'
  }

  return {
    packageName: entry.name,
    version: entry.resolvedVersion,
    isDirect: entry.isDirect,
    declaredIn: entry.declaredIn,
    isImported,
    importLocations,
    sourceBucket: reachability?.sourceBucket,
    usageClass: entry.usageClass,
    dependencyPath: entry.paths[0],
    canRemove,
    suggestedAction,
    suggestedCommand,
  }
}

// =====================================================================
// 终端渲染
// =====================================================================

function renderTerminalExplain(result: ExplainResult): void {
  const lines: string[] = []

  lines.push('')
  lines.push(chalk.bold(`📦 ${result.packageName}@${result.version}`))
  lines.push('')

  // 基本信息
  lines.push(`  声明位置: ${formatDeclaredIn(result.declaredIn)}`)
  lines.push(`  直接依赖: ${result.isDirect ? '是' : '否'}`)

  if (result.usageClass) {
    lines.push(`  使用分类: ${result.usageClass}`)
  }

  // 源码引用
  if (result.isImported) {
    lines.push(
      `  源码引用: ${chalk.green('✓ 已引用')}（${result.importLocations?.length ?? 0} 处）`,
    )
    if (result.importLocations && result.importLocations.length > 0) {
      for (const loc of result.importLocations) {
        lines.push(`    - ${loc.file}:${loc.line} (${loc.importKind})`)
      }
    }
  } else {
    lines.push(`  源码引用: ${chalk.yellow('✗ 未检测到静态引用')}`)
  }

  // 依赖路径
  if (result.dependencyPath && result.dependencyPath.length > 0) {
    lines.push(`  依赖路径: ${result.dependencyPath.join(' → ')}`)
  }

  // 建议操作
  lines.push('')
  const removeIcon =
    result.canRemove === true
      ? chalk.green('✓ 可移除')
      : result.canRemove === 'maybe'
        ? chalk.yellow('? 需确认')
        : chalk.red('✗ 建议保留')
  lines.push(`  ${removeIcon}  ${result.suggestedAction}`)

  if (result.suggestedCommand) {
    lines.push(`  命令: ${chalk.cyan(result.suggestedCommand)}`)
  }

  lines.push('')
  process.stdout.write(lines.join('\n') + '\n')
}

function formatDeclaredIn(declaredIn: ExplainResult['declaredIn']): string {
  switch (declaredIn) {
    case 'dependencies':
      return 'dependencies'
    case 'devDependencies':
      return 'devDependencies'
    case 'peerDependencies':
      return 'peerDependencies'
    case 'optionalDependencies':
      return 'optionalDependencies'
    case 'transitive':
      return '传递依赖'
    default:
      return declaredIn
  }
}

// =====================================================================
// 包管理器命令
// =====================================================================

function getRemoveCommand(name: string, pm: string): string {
  switch (pm) {
    case 'pnpm':
      return `pnpm remove ${name}`
    case 'yarn':
      return `yarn remove ${name}`
    default:
      return `npm uninstall ${name}`
  }
}

function getMoveCommand(name: string, _target: string, pm: string): string {
  const addCmd =
    pm === 'pnpm'
      ? `pnpm add -D ${name}`
      : pm === 'yarn'
        ? `yarn add -D ${name}`
        : `npm install --save-dev ${name}`
  const removeCmd = getRemoveCommand(name, pm)
  return `${removeCmd} && ${addCmd}`
}
