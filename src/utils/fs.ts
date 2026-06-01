/**
 * 文件系统工具
 *
 * 封装对 package.json 与项目根目录的常用操作。
 * 抛出的错误统一为 dep-radar 自定义错误类，便于上层映射成用户友好提示。
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

import { ConfigError, PackageNotFoundError } from '../errors/index.js'
import type { PackageJson } from '../types/package.js'

/**
 * 读取并解析 package.json
 *
 * @param projectPath 项目目录路径（绝对或相对都可，相对路径基于 process.cwd()）
 * @throws PackageNotFoundError 文件不存在或目录里没有 package.json
 * @throws ConfigError          JSON 格式非法
 */
export async function readPackageJson(
  projectPath: string,
): Promise<PackageJson> {
  const abs = isAbsolute(projectPath) ? projectPath : resolve(projectPath)
  const file = resolve(abs, 'package.json')

  if (!existsSync(file)) {
    throw new PackageNotFoundError(file)
  }

  let raw: string
  try {
    raw = await readFile(file, 'utf-8')
  } catch (err) {
    throw new PackageNotFoundError(file, { cause: err })
  }

  try {
    return JSON.parse(raw) as PackageJson
  } catch (err) {
    throw new ConfigError(`package.json 不是合法 JSON：${file}`, { cause: err })
  }
}

/**
 * 向上查找包含 package.json 的最近目录
 *
 * 用于支持 `dep-radar analyze ./src/foo` 这类从子目录运行的场景。
 *
 * @param startPath 起始目录路径
 * @returns 找到的项目根目录（绝对路径）
 * @throws PackageNotFoundError 一路向上到文件系统根都没找到
 */
export async function findProjectRoot(startPath: string): Promise<string> {
  let current = isAbsolute(startPath) ? startPath : resolve(startPath)
  while (true) {
    if (existsSync(resolve(current, 'package.json'))) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) {
      throw new PackageNotFoundError(
        `<向上查找未找到 package.json，起点 ${startPath}>`,
      )
    }
    current = parent
  }
}
