/**
 * Git diff 工具
 *
 * 用于增量分析：对比两个 ref 之间的 package.json 变更，
 * 提取新增 / 变更 / 移除的依赖列表。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export interface ChangedDependencies {
  /** 新增的依赖（B 有 A 无） */
  added: string[]
  /** 移除的依赖（A 有 B 无） */
  removed: string[]
  /** 版本变更的依赖 */
  changed: string[]
}

/**
 * 获取两个 ref 之间 package.json 中依赖的变更
 *
 * @param cwd 项目目录
 * @param ref git ref（如 'main', 'HEAD~1', 'abc1234'）
 * @returns 变更的依赖列表
 */
export async function getChangedDependencies(
  cwd: string,
  ref: string,
): Promise<ChangedDependencies> {
  // 获取 diff 前后的 package.json 内容
  const [oldContent, newContent] = await Promise.all([
    gitShowFile(cwd, `${ref}:package.json`),
    gitShowFile(cwd, 'HEAD:package.json'),
  ])

  const oldDeps = extractAllDeps(oldContent)
  const newDeps = extractAllDeps(newContent)

  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []

  for (const [name, version] of newDeps) {
    if (!oldDeps.has(name)) {
      added.push(name)
    } else if (oldDeps.get(name) !== version) {
      changed.push(name)
    }
  }

  for (const [name] of oldDeps) {
    if (!newDeps.has(name)) {
      removed.push(name)
    }
  }

  return { added, removed, changed }
}

/**
 * 读取 git 中指定 ref 的文件内容
 */
async function gitShowFile(cwd: string, spec: string): Promise<string> {
  try {
    const { stdout } = await execFileP('git', ['show', spec], {
      cwd,
      timeout: 10_000,
    })
    return stdout
  } catch {
    return '{}'
  }
}

/**
 * 从 package.json 内容中提取所有依赖（dependencies + devDependencies）
 */
function extractAllDeps(content: string): Map<string, string> {
  const deps = new Map<string, string>()
  try {
    const pkg = JSON.parse(content) as Record<string, unknown>
    const sections = ['dependencies', 'devDependencies'] as const
    for (const section of sections) {
      const sectionDeps = pkg[section] as Record<string, string> | undefined
      if (sectionDeps && typeof sectionDeps === 'object') {
        for (const [name, version] of Object.entries(sectionDeps)) {
          deps.set(name, version)
        }
      }
    }
  } catch {
    // 解析失败返回空 map
  }
  return deps
}
