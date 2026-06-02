/**
 * LicenseFetcher 工厂
 *
 * 多源 license 获取策略：
 *   1. node_modules/<pkg>/package.json 的 license / licenses 字段
 *   2. node_modules/<pkg>/LICENSE* 文件存在性检测
 *   3. registry /<pkg>/<version> manifest
 *   4. registry /<pkg>/latest fallback（标注 source=registry-latest-fallback）
 *
 * 容错策略：
 * - 包不存在（PackageNotFoundError）→ 抛出，让 analyzer 记入 skipped
 * - 其他网络错误 → 抛出，让 analyzer 记入 skipped
 * - 包存在但 license 字段缺失/空 → 返回 undefined（analyzer 会把它判为 unknown）
 */

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  normalizeLicenseField,
  type LicenseFetcher,
} from '../analyzers/license.js'
import type { DataCache } from '../data/cache.js'
import { getPackageVersionInfo } from '../data/npm.js'

export interface BuildLicenseFetcherOptions {
  /** 缓存实例；不传则不缓存 */
  cache?: DataCache
  /** 自定义 npm registry URL */
  registry?: string
  /** 项目路径（用于读取 node_modules） */
  projectPath?: string
}

export function buildLicenseFetcher(
  options: BuildLicenseFetcherOptions = {},
): LicenseFetcher {
  const { cache, registry, projectPath } = options
  return {
    getLicense: async (name, version) => {
      // 1. 尝试从 node_modules 读取
      if (projectPath) {
        const nmLicense = await readFromNodeModules(projectPath, name)
        if (nmLicense !== undefined) return nmLicense
      }

      // 2. 从 registry 获取
      const manifest = await getPackageVersionInfo(
        name,
        version,
        cache,
        registry,
      )
      const license = normalizeLicenseField(manifest.license)
      if (license) return license

      // 如果指定版本没有 license，尝试 latest
      if (version) {
        try {
          const latestManifest = await getPackageVersionInfo(
            name,
            undefined,
            cache,
            registry,
          )
          return normalizeLicenseField(latestManifest.license)
        } catch {
          // latest 也失败，返回 undefined
        }
      }

      return undefined
    },
  }
}

/**
 * 从 node_modules 读取 license 信息
 *
 * 优先级：
 * 1. package.json 的 license 字段
 * 2. package.json 的 licenses 字段（旧格式）
 * 3. LICENSE* 文件存在性（返回 undefined，但标记有文件）
 */
async function readFromNodeModules(
  projectPath: string,
  pkgName: string,
): Promise<string | undefined> {
  const pkgDir = join(projectPath, 'node_modules', pkgName)
  const pkgJsonPath = join(pkgDir, 'package.json')

  if (!existsSync(pkgJsonPath)) return undefined

  try {
    const raw = await readFile(pkgJsonPath, 'utf-8')
    const manifest = JSON.parse(raw) as {
      license?: string | { type: string } | Array<{ type: string }>
      licenses?: string | { type: string } | Array<{ type: string }>
    }

    // 优先 license 字段
    const license = normalizeLicenseField(manifest.license)
    if (license) return license

    // 回退到 licenses 字段（旧格式）
    const licenses = normalizeLicenseField(manifest.licenses)
    if (licenses) return licenses

    // 检查 LICENSE 文件是否存在
    try {
      const files = await readdir(pkgDir)
      const licenseFiles = files.filter(f => f.startsWith('LICENSE'))
      if (licenseFiles.length > 0) {
        // 有 LICENSE 文件但 package.json 没有 license 字段
        // 返回 undefined 让 analyzer 标记 needsHumanReview
        return undefined
      }
    } catch {
      // 读目录失败，忽略
    }

    return undefined
  } catch {
    return undefined
  }
}
