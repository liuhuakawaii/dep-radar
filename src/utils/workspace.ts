/**
 * Monorepo workspace 检测工具
 *
 * 支持：
 *   - npm/yarn workspaces（package.json 的 workspaces 字段）
 *   - pnpm workspaces（pnpm-workspace.yaml）
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { logger } from './logger.js'

/** 子包信息 */
export interface WorkspacePackage {
  /** 子包名称（来自 package.json name 字段） */
  name: string
  /** 相对于根目录的路径 */
  path: string
  /** package.json 内容 */
  packageJson: Record<string, unknown>
}

/**
 * 从 package.json 的 workspaces 字段解析 glob 模式
 *
 * 支持两种格式：
 *   - 数组：["packages/*", "apps/*"]
 *   - 对象：{ packages: ["packages/*"] }
 */
export function parseWorkspacesField(workspaces: unknown): string[] {
  if (Array.isArray(workspaces)) {
    return workspaces.filter((w): w is string => typeof w === 'string')
  }
  if (
    workspaces &&
    typeof workspaces === 'object' &&
    'packages' in workspaces &&
    Array.isArray((workspaces as Record<string, unknown>).packages)
  ) {
    return (
      (workspaces as Record<string, unknown>).packages as unknown[]
    ).filter((w): w is string => typeof w === 'string')
  }
  return []
}

/**
 * 简易 glob 匹配（仅支持 * 和 ** 通配符）
 *
 * 工作区模式通常很简单（如 "packages/*"），不需要完整 glob 库。
 */
export function matchSimpleGlob(pattern: string, name: string): boolean {
  // 将 glob 模式转为正则
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{DOUBLE_STAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{DOUBLE_STAR\}\}/g, '.*')
  const regex = new RegExp(`^${regexStr}$`)
  return regex.test(name)
}

/**
 * 将 glob 模式展开为匹配的目录列表
 *
 * 对于 "packages/*"，读取 packages/ 下的一级子目录。
 * 对于 "packages/**"，递归读取所有子目录。
 */
async function expandGlob(rootDir: string, pattern: string): Promise<string[]> {
  // 拆分 pattern 为静态前缀和通配部分
  const parts = pattern.split('/')
  const staticParts: string[] = []
  let wildcardIndex = parts.length

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part) continue
    if (part.includes('*')) {
      wildcardIndex = i
      break
    }
    staticParts.push(part)
  }

  const staticDir = resolve(rootDir, ...staticParts)
  const remainingPattern = parts.slice(wildcardIndex).join('/')

  const results: string[] = []
  await collectMatches(staticDir, remainingPattern, results)
  return results
}

async function collectMatches(
  dir: string,
  pattern: string,
  results: string[],
): Promise<void> {
  const parts = pattern.split('/')
  const current = parts[0]
  const rest = parts.slice(1).join('/')

  if (!current) {
    results.push(dir)
    return
  }

  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue

    if (matchSimpleGlob(current, entry.name)) {
      const childPath = join(dir, entry.name)
      if (rest) {
        await collectMatches(childPath, rest, results)
      } else {
        results.push(childPath)
      }
    }
  }
}

/**
 * 检测项目是否为 monorepo，并返回所有子包信息
 *
 * 检测顺序：
 *   1. package.json 的 workspaces 字段（npm/yarn）
 *   2. pnpm-workspace.yaml（pnpm）
 *
 * @param rootDir 项目根目录
 * @returns 子包列表；非 monorepo 时返回空数组
 */
export async function detectWorkspaces(
  rootDir: string,
): Promise<WorkspacePackage[]> {
  // 1. 尝试 package.json workspaces
  try {
    const pkgContent = await readFile(join(rootDir, 'package.json'), 'utf-8')
    const pkg = JSON.parse(pkgContent) as Record<string, unknown>
    const patterns = parseWorkspacesField(pkg.workspaces)
    if (patterns.length > 0) {
      return await resolveWorkspacePackages(rootDir, patterns)
    }
  } catch {
    // package.json 不存在或解析失败，继续
  }

  // 2. 尝试 pnpm-workspace.yaml
  try {
    const yamlContent = await readFile(
      join(rootDir, 'pnpm-workspace.yaml'),
      'utf-8',
    )
    const patterns = parsePnpmWorkspaceYaml(yamlContent)
    if (patterns.length > 0) {
      return await resolveWorkspacePackages(rootDir, patterns)
    }
  } catch {
    // pnpm-workspace.yaml 不存在，继续
  }

  return []
}

/**
 * 解析 pnpm-workspace.yaml 的 packages 字段
 *
 * 格式示例：
 * ```yaml
 * packages:
 *   - 'packages/*'
 *   - 'apps/*'
 * ```
 */
function parsePnpmWorkspaceYaml(content: string): string[] {
  const patterns: string[] = []
  const lines = content.split('\n')
  let inPackages = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === 'packages:') {
      inPackages = true
      continue
    }
    if (inPackages) {
      if (trimmed.startsWith('- ')) {
        const value = trimmed
          .slice(2)
          .trim()
          .replace(/^['"]|['"]$/g, '')
        if (value) patterns.push(value)
      } else if (trimmed && !trimmed.startsWith('#')) {
        // 遇到新的顶级 key，结束
        break
      }
    }
  }

  return patterns
}

/**
 * 将 glob 模式列表展开为 WorkspacePackage 列表
 */
async function resolveWorkspacePackages(
  rootDir: string,
  patterns: string[],
): Promise<WorkspacePackage[]> {
  const packages: WorkspacePackage[] = []
  const seen = new Set<string>()

  for (const pattern of patterns) {
    const dirs = await expandGlob(rootDir, pattern)
    for (const dir of dirs) {
      if (seen.has(dir)) continue
      seen.add(dir)

      try {
        const pkgContent = await readFile(join(dir, 'package.json'), 'utf-8')
        const pkg = JSON.parse(pkgContent) as Record<string, unknown>
        const name = typeof pkg.name === 'string' ? pkg.name : dir
        const relPath = resolve(rootDir, dir).replace(resolve(rootDir), '.')
        packages.push({
          name,
          path: relPath.startsWith('.') ? relPath : `./${relPath}`,
          packageJson: pkg,
        })
      } catch {
        logger.warn(`跳过工作区目录（无法读取 package.json）：${dir}`)
      }
    }
  }

  return packages
}

/**
 * 根据名称或路径查找子包
 *
 * 支持按 name 或 path 匹配。
 */
export function findWorkspace(
  packages: WorkspacePackage[],
  query: string,
): WorkspacePackage | undefined {
  return (
    packages.find(p => p.name === query) ??
    packages.find(p => p.path === query) ??
    packages.find(p => p.path === `./${query}`)
  )
}
