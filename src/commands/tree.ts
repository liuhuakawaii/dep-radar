/**
 * `tree` 命令：依赖树可视化
 *
 * 调用对应包管理器的 `list --json`，解析后渲染为 ASCII 树状结构。
 *
 * 当前支持：
 * - npm：`npm ls --all --json` 输出嵌套 dependencies map
 * - pnpm：`pnpm list --depth=Infinity --json` 输出数组（每个工作区一项）
 * - yarn berry：`yarn info --json --recursive`
 * - yarn classic：`yarn list --json`（NDJSON 格式）
 *
 * 失败场景（如 `npm ls` 因 peerDep 冲突返回非 0）会从 stdout 读取尽力解析的内容，
 * 不直接报错——保持工具的"可用性优先"原则。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import chalk from 'chalk'

import { loadUserConfig } from '../config/loader.js'
import { mergeReplacements } from '../config/replacements.js'
import { ConfigError } from '../errors/index.js'
import type { ReplacementRule } from '../types/config.js'
import type { PackageManager } from '../types/package.js'
import { EXIT_CODES, type ExitCode } from '../utils/exitCode.js'
import { logger } from '../utils/logger.js'
import {
  detectPackageManager,
  detectYarnVersion,
  PM_COMMANDS,
  YARN_CLASSIC_COMMANDS,
} from '../utils/packageManager.js'

const execFileP = promisify(execFile)

export interface TreeOptions {
  /** 最大渲染深度，超出后用省略号；0 表示只显示根 */
  depth?: number
  /** 是否显示优化提示（[!] 建议替换等）；默认 true */
  hints?: boolean
}

/** 解析后的统一依赖树节点 */
export interface TreeNode {
  name: string
  version: string
  children: TreeNode[]
}

/**
 * `tree` 命令入口
 */
export async function treeCommand(
  projectPath: string,
  options: TreeOptions = {},
): Promise<ExitCode> {
  const { depth = Infinity, hints = true } = options
  const pm = detectPackageManager(projectPath)

  // 加载用户配置，获取自定义替代方案
  let replacements: Record<string, ReplacementRule> | undefined
  if (hints) {
    try {
      const config = await loadUserConfig(projectPath)
      replacements = mergeReplacements(config.replacements)
    } catch (err) {
      if (err instanceof ConfigError) {
        logger.warn(`配置加载失败，使用内置替代方案表：${err.message}`)
        replacements = mergeReplacements()
      } else {
        throw err
      }
    }
  }

  // yarn 需要区分 classic / berry 以选择不同命令
  let listCmd: { cmd: string; args: string[] }
  if (pm === 'yarn') {
    const yarnVersion = await detectYarnVersion(projectPath)
    listCmd =
      yarnVersion === 'classic'
        ? YARN_CLASSIC_COMMANDS.list
        : PM_COMMANDS.yarn.list
  } else {
    listCmd = PM_COMMANDS[pm].list
  }

  const { cmd, args } = listCmd
  let stdout = ''
  try {
    const r = await execFileP(cmd, args, {
      cwd: projectPath,
      maxBuffer: 50 * 1024 * 1024, // 大型项目 list 输出可能 >10MB
    })
    stdout = r.stdout
  } catch (err) {
    // npm ls 在 peerDep 冲突时退出码非 0，但 stdout 仍有合法 JSON
    const e = err as { stdout?: string; message?: string; code?: string }
    if (e.stdout) {
      stdout = e.stdout
    } else if (e.code === 'ENOENT') {
      logger.error(
        `找不到命令 "${cmd}"，请确认已安装并在 PATH 中可用。` +
          (cmd === 'npm'
            ? '\n提示：如果你使用 nvm/fnm，请先运行对应的 shell 初始化脚本。'
            : ''),
      )
      return EXIT_CODES.ERROR
    } else {
      logger.error(
        `执行 ${cmd} ${args.join(' ')} 失败：${e.message ?? String(err)}`,
      )
      return EXIT_CODES.ERROR
    }
  }

  let tree: TreeNode
  try {
    tree = parseDepTree(stdout, pm)
  } catch (err) {
    logger.error(
      `解析依赖树失败：${err instanceof Error ? err.message : String(err)}`,
    )
    return EXIT_CODES.ERROR
  }

  process.stdout.write(renderTree(tree, depth, replacements) + '\n')
  return EXIT_CODES.OK
}

// =====================================================================
// Parser
// =====================================================================

/**
 * 解析 list 命令的 JSON 输出为统一 TreeNode 结构
 *
 * 导出供单元测试使用。
 */
export function parseDepTree(stdout: string, pm: PackageManager): TreeNode {
  if (pm === 'yarn') return parseYarnClassicTree(stdout)
  const json = JSON.parse(stdout)
  if (pm === 'npm') return parseNpmTree(json)
  if (pm === 'pnpm') return parsePnpmTree(json)
  throw new Error(`不支持的包管理器：${pm}`)
}

interface NpmNode {
  name?: string
  version?: string
  dependencies?: Record<string, NpmNode>
}

function parseNpmTree(root: NpmNode): TreeNode {
  return convertNpm(root.name ?? '(root)', root)
}

function convertNpm(name: string, node: NpmNode): TreeNode {
  const children: TreeNode[] = []
  if (node.dependencies) {
    for (const [childName, childNode] of Object.entries(node.dependencies)) {
      children.push(convertNpm(childName, childNode))
    }
  }
  return {
    name,
    version: node.version ?? '?',
    children,
  }
}

interface PnpmNode {
  name?: string
  version?: string
  dependencies?: Record<
    string,
    { version: string; dependencies?: Record<string, unknown> }
  >
  devDependencies?: Record<
    string,
    { version: string; dependencies?: Record<string, unknown> }
  >
}

function parsePnpmTree(json: unknown): TreeNode {
  // pnpm 输出是数组：每个 workspace 一项；非 monorepo 通常只有一项
  const root: PnpmNode = Array.isArray(json)
    ? (json[0] ?? {})
    : (json as PnpmNode)
  return convertPnpm(root.name ?? '(root)', root.version ?? '?', {
    ...root.dependencies,
    ...root.devDependencies,
  } as Record<
    string,
    { version: string; dependencies?: Record<string, unknown> }
  >)
}

function convertPnpm(
  name: string,
  version: string,
  deps: Record<
    string,
    { version: string; dependencies?: Record<string, unknown> }
  >,
): TreeNode {
  const children: TreeNode[] = []
  for (const [childName, childInfo] of Object.entries(deps)) {
    const sub = (childInfo.dependencies ?? {}) as Record<
      string,
      { version: string; dependencies?: Record<string, unknown> }
    >
    children.push(convertPnpm(childName, childInfo.version, sub))
  }
  return { name, version, children }
}

// ----- yarn classic -----

interface YarnClassicTreeLine {
  type: string
  data: {
    type: string
    trees?: Array<{
      name: string // "lodash@4.17.21"
      children?: YarnClassicTreeLine['data']['trees']
      color?: string | null
      shadow?: boolean
    }>
  }
}

/**
 * Yarn Classic `yarn list --json` 输出 NDJSON（每行一个 JSON 对象）
 *
 * 我们只需取 type="tree" 的那一行，解析其 data.trees 递归结构。
 */
function parseYarnClassicTree(stdout: string): TreeNode {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line) as YarnClassicTreeLine
      if (obj.type === 'tree' && obj.data?.trees) {
        return convertYarnClassicTrees(obj.data.trees)
      }
    } catch {
      // 跳过非 JSON 行（进度信息等）
    }
  }
  throw new Error('Yarn Classic 输出中未找到 tree 数据')
}

function convertYarnClassicTrees(
  trees: NonNullable<YarnClassicTreeLine['data']['trees']>,
): TreeNode {
  const children: TreeNode[] = []
  for (const t of trees) {
    // 跳过 shadow 节点（幽灵依赖）
    if (t.shadow) continue
    const { name, version } = splitNameVersion(t.name)
    const subChildren = t.children
      ? convertYarnClassicTrees(t.children).children
      : []
    children.push({ name, version, children: subChildren })
  }
  return { name: '(root)', version: '0.0.0', children }
}

/** 将 "lodash@4.17.21" 拆分为 { name: "lodash", version: "4.17.21" } */
function splitNameVersion(raw: string): { name: string; version: string } {
  const atIdx = raw.lastIndexOf('@')
  if (atIdx <= 0) return { name: raw, version: '?' }
  return { name: raw.slice(0, atIdx), version: raw.slice(atIdx + 1) }
}

// =====================================================================
// Renderer
// =====================================================================

/**
 * 渲染 TreeNode 为 ASCII 树
 *
 * @param replacements 可选的替代方案映射表；传入时匹配的包会显示 [!] 优化提示
 *
 * 导出供单元测试使用。
 */
export function renderTree(
  node: TreeNode,
  maxDepth: number = Infinity,
  replacements?: Record<string, ReplacementRule>,
): string {
  const lines: string[] = []
  lines.push(chalk.bold(`${node.name}@${node.version}`))
  renderChildren(node.children, '', 1, maxDepth, replacements, lines)
  return lines.join('\n')
}

function renderChildren(
  children: TreeNode[],
  prefix: string,
  depth: number,
  maxDepth: number,
  replacements: Record<string, ReplacementRule> | undefined,
  out: string[],
): void {
  if (depth > maxDepth) {
    if (children.length > 0) {
      out.push(prefix + chalk.gray('└── ...'))
    }
    return
  }
  children.forEach((child, idx) => {
    const isLast = idx === children.length - 1
    const branch = isLast ? '└── ' : '├── '
    const hint = buildHint(child.name, replacements)
    out.push(
      prefix + branch + `${child.name}@${chalk.gray(child.version)}${hint}`,
    )
    const nextPrefix = prefix + (isLast ? '    ' : '│   ')
    renderChildren(
      child.children,
      nextPrefix,
      depth + 1,
      maxDepth,
      replacements,
      out,
    )
  })
}

/**
 * 为单个包生成 [!] 优化提示
 *
 * 匹配 REPLACEMENTS 表时显示替代建议和预估节省百分比。
 */
function buildHint(
  name: string,
  replacements: Record<string, ReplacementRule> | undefined,
): string {
  if (!replacements) return ''
  const rule = replacements[name]
  if (!rule) return ''

  const savings =
    rule.estimatedSavingsPercent > 0
      ? ` (节省 ${rule.estimatedSavingsPercent}%)`
      : ''
  return chalk.yellow(`  [!] 建议替换为 ${rule.alternative}${savings}`)
}
