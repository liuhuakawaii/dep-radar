/**
 * 包管理器检测与命令分发
 *
 * 不同 PM 的 list / audit 命令参数不同，业务层应通过 PM_COMMANDS 拿到对应规格，
 * 避免散落在各处的 if-else 判断。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { PackageManager } from '../types/package.js'

/**
 * 根据项目目录下的 lock 文件推断包管理器
 *
 * 优先级：pnpm > yarn > npm（与"用户最有可能优先安装的"次序一致）。
 * 没有任何 lock 文件时默认 npm（npm 是 Node 默认捆绑，最安全的兜底）。
 */
export function detectPackageManager(cwd: string): PackageManager {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

/**
 * 单条命令的可执行规格
 *
 * 注意 args 是数组：调用方应使用 child_process.execFile 而非 exec，
 * 避免 shell 注入风险。
 */
export interface CommandSpec {
  cmd: string
  args: string[]
}

/**
 * 各包管理器的 list / audit 命令规格
 *
 * - list:  列出所有依赖（用于 tree 命令）。json 输出便于解析
 * - audit: 安全审计。json 输出便于解析
 *
 * 注意：
 * - npm/pnpm 用相同 `audit --json`，但输出 schema 不同，解析层需各自适配
 * - yarn 1.x 和 yarn 2+/berry 的 audit 子命令不同；此处按 berry 写法
 *   （`yarn npm audit --json`），yarn 1.x 项目可能需要后续适配
 */
export const PM_COMMANDS: Record<
  PackageManager,
  { list: CommandSpec; audit: CommandSpec }
> = {
  npm: {
    list: { cmd: 'npm', args: ['ls', '--all', '--json'] },
    audit: { cmd: 'npm', args: ['audit', '--json'] },
  },
  pnpm: {
    list: { cmd: 'pnpm', args: ['list', '--depth=Infinity', '--json'] },
    audit: { cmd: 'pnpm', args: ['audit', '--json'] },
  },
  yarn: {
    list: { cmd: 'yarn', args: ['info', '--json', '--recursive'] },
    audit: { cmd: 'yarn', args: ['npm', 'audit', '--json'] },
  },
}
