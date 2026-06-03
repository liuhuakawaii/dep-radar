/**
 * 本地 esbuild 体积分析
 *
 * 用 esbuild 在本地打包 node_modules 中的包，测量 minified + gzip 体积。
 * 适用于私有包 / 离线环境 / pkg-size.dev 和 bundlephobia 不可用的场景。
 *
 * esbuild 为 optionalDependency——未安装时 buildBundleFetcher 会跳过本数据源。
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

import type { BundleInfo } from '../types/analysis.js'
import { PackageNotFoundError } from '../errors/index.js'
import type { DataCache } from './cache.js'

/**
 * 用 esbuild 本地分析包体积
 *
 * @param name 包名
 * @param version 版本号（仅用于缓存 key 和结果标记，不影响解析）
 * @param cache 缓存实例
 * @param projectPath 项目根目录（用于定位 node_modules）
 */
export async function getPackageSize(
  name: string,
  version?: string,
  cache?: DataCache,
  projectPath?: string,
): Promise<BundleInfo> {
  const cacheKey = `local:${name}@${version ?? 'latest'}`

  const fetchFn = async (): Promise<BundleInfo> => {
    // 动态导入 esbuild（optionalDependency）
    let esbuild: Record<string, unknown>
    try {
      const mod = 'esbuild'
      esbuild = (await import(mod)) as Record<string, unknown>
    } catch {
      throw new Error(
        'esbuild 未安装。local 数据源需要 esbuild，请运行: pnpm add -D esbuild',
      )
    }

    const basePath = projectPath ?? process.cwd()
    const nmDir = resolve(basePath, 'node_modules')
    const pkgDir = join(nmDir, name)

    if (!existsSync(join(pkgDir, 'package.json'))) {
      throw new PackageNotFoundError(name)
    }

    // 读取包的 package.json
    const raw = await readFile(join(pkgDir, 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as Record<string, unknown>
    const pkgVersion = (pkg.version as string) ?? version ?? '0.0.0'

    // 确定入口文件
    const entryPoint = resolveEntry(pkgDir, pkg) ?? join(pkgDir, 'index.js')

    if (!existsSync(entryPoint)) {
      throw new PackageNotFoundError(name)
    }

    // esbuild 打包
    const buildFn = esbuild.build as (
      opts: Record<string, unknown>,
    ) => Promise<{ outputFiles: Array<{ text: string }> }>
    const result = await buildFn({
      entryPoints: [entryPoint],
      bundle: true,
      minify: true,
      format: 'esm',
      write: false,
      platform: 'neutral',
      logLevel: 'silent',
    })

    const output = result.outputFiles[0]
    if (!output) {
      throw new Error(`esbuild 未产生输出：${name}`)
    }

    const size = output.text.length
    const gzip = gzipSync(Buffer.from(output.text)).length

    // 读取依赖数
    const deps = pkg.dependencies as Record<string, string> | undefined
    const dependencyCount = deps ? Object.keys(deps).length : 0

    return {
      name,
      version: pkgVersion,
      size,
      gzip,
      dependencyCount,
      hasJSModule: typeof pkg.module === 'string',
      hasJSNext: typeof pkg['jsnext:main'] === 'string',
      source: 'local',
      isDirect: false, // 由调用方覆盖
    }
  }

  if (cache) return cache.withCacheOrError(cacheKey, fetchFn)
  return fetchFn()
}

/**
 * 解析包的入口文件
 *
 * 优先级：module > main > index.js
 */
function resolveEntry(
  pkgDir: string,
  pkg: Record<string, unknown>,
): string | null {
  // module > main > index.js
  const simpleEntry = pkg.module ?? pkg.main
  if (typeof simpleEntry === 'string' && simpleEntry) {
    return join(pkgDir, simpleEntry)
  }

  // exports 可能是 { ".": "./index.js" } 形式
  if (pkg.exports && typeof pkg.exports === 'object') {
    const exports = pkg.exports as Record<string, unknown>
    const dot = exports['.']
    if (typeof dot === 'string') return join(pkgDir, dot)
    if (dot && typeof dot === 'object') {
      const dotObj = dot as Record<string, string>
      return join(
        pkgDir,
        dotObj.import ?? dotObj.default ?? dotObj.require ?? '',
      )
    }
  }

  return join(pkgDir, 'index.js')
}
