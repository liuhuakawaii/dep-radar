/**
 * 可执行建议命令生成器
 *
 * 为 OptimizationSuggestion 生成具体的包管理器命令，
 * 让用户可以直接复制执行。
 */

import type { OptimizationSuggestion } from '../types/analysis.js'
import type { PackageManager } from '../types/package.js'

export interface CommandSuggestion {
  /** 原始建议的包名 */
  packageName: string
  /** 操作类型 */
  action: 'remove' | 'update' | 'move-to-dev' | 'override'
  /** 包管理器命令 */
  command: string
  /** 命令说明 */
  description: string
}

/**
 * 为优化建议生成可执行命令
 */
export function generateCommands(
  suggestion: OptimizationSuggestion,
  pm: PackageManager,
): CommandSuggestion | null {
  switch (suggestion.type) {
    case 'deprecated':
    case 'remove':
      return generateRemoveCommand(suggestion, pm)

    case 'replace':
      return generateReplaceCommand(suggestion, pm)

    case 'upgrade':
      return generateUpdateCommand(suggestion, pm)

    default:
      return null
  }
}

/**
 * 为 transitive 漏洞生成 override 建议
 */
export function generateOverrideCommand(
  packageName: string,
  fixVersion: string,
  pm: PackageManager,
): CommandSuggestion {
  switch (pm) {
    case 'pnpm':
      return {
        packageName,
        action: 'override',
        command: `pnpm override ${packageName}@${fixVersion}`,
        description: `通过 pnpm override 将 ${packageName} 升级到 ${fixVersion}`,
      }
    case 'yarn':
      return {
        packageName,
        action: 'override',
        command: `yarn set resolution ${packageName}@${fixVersion}`,
        description: `通过 yarn resolution 将 ${packageName} 升级到 ${fixVersion}`,
      }
    default:
      return {
        packageName,
        action: 'override',
        command: `npm pkg set overrides.${packageName}=${fixVersion}`,
        description: `通过 npm overrides 将 ${packageName} 升级到 ${fixVersion}`,
      }
  }
}

/**
 * 为无法判断的依赖生成 explain 建议
 */
export function generateExplainHint(packageName: string): string {
  return `dep-radar explain ${packageName}`
}

// =====================================================================
// 内部实现
// =====================================================================

function generateRemoveCommand(
  suggestion: OptimizationSuggestion,
  pm: PackageManager,
): CommandSuggestion {
  const cmd = getRemoveCmd(suggestion.packageName, pm)
  return {
    packageName: suggestion.packageName,
    action: 'remove',
    command: cmd,
    description: `移除 ${suggestion.packageName}`,
  }
}

function generateReplaceCommand(
  suggestion: OptimizationSuggestion,
  pm: PackageManager,
): CommandSuggestion | null {
  if (!suggestion.alternative) return null

  // 如果替代是原生 API（如 fetch），只生成 remove
  if (
    suggestion.alternative === '原生 fetch' ||
    suggestion.alternative === 'fetch'
  ) {
    return {
      packageName: suggestion.packageName,
      action: 'remove',
      command: getRemoveCmd(suggestion.packageName, pm),
      description: `移除 ${suggestion.packageName}，使用原生 ${suggestion.alternative}`,
    }
  }

  // 否则生成 remove + add
  const removeCmd = getRemoveCmd(suggestion.packageName, pm)
  const addCmd = getAddCmd(suggestion.alternative, pm)
  return {
    packageName: suggestion.packageName,
    action: 'remove',
    command: `${removeCmd} && ${addCmd}`,
    description: `替换 ${suggestion.packageName} 为 ${suggestion.alternative}`,
  }
}

function generateUpdateCommand(
  suggestion: OptimizationSuggestion,
  pm: PackageManager,
): CommandSuggestion {
  const cmd = getUpdateCmd(suggestion.packageName, pm)
  return {
    packageName: suggestion.packageName,
    action: 'update',
    command: cmd,
    description: `升级 ${suggestion.packageName}`,
  }
}

function getRemoveCmd(name: string, pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return `pnpm remove ${name}`
    case 'yarn':
      return `yarn remove ${name}`
    default:
      return `npm uninstall ${name}`
  }
}

function getAddCmd(name: string, pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return `pnpm add ${name}`
    case 'yarn':
      return `yarn add ${name}`
    default:
      return `npm install ${name}`
  }
}

function getUpdateCmd(name: string, pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return `pnpm update ${name}`
    case 'yarn':
      return `yarn upgrade ${name}`
    default:
      return `npm update ${name}`
  }
}
