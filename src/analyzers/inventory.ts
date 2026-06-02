/**
 * DependencyInventory 构建器
 *
 * 从 lockfile / node_modules / package.json 构建统一的依赖清单。
 *
 * 解析优先级（按可靠性降序）：
 *   1. package-lock.json（npm lockfile v2/v3）
 *   2. pnpm-lock.yaml（pnpm lockfile v9+）
 *   3. node_modules 直接读取（yarn 或无 lockfile 时的 fallback）
 *   4. package.json 声明粗略解析（最低可靠性）
 *
 * 关键能力：
 *   - npm alias 检测（three149@npm:three@0.149.0 → packageName=three）
 *   - transitive dependency 收集
 *   - 版本解析来源和置信度标注
 *   - ignore 集中过滤
 */

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { load as yamlLoad } from 'js-yaml'
import semver from 'semver'

import type {
  BuildInventoryOptions,
  DeclaredIn,
  DependencyEntry,
  DependencyInventory,
  ResolvedFrom,
} from '../types/inventory.js'
import type { PackageJson } from '../types/package.js'
import { buildIgnoreMatcher } from '../utils/ignore.js'

// =====================================================================
// 主入口
// =====================================================================

/**
 * 构建项目依赖清单
 *
 * @param projectPath 项目根目录
 * @param pkg 已读取的 package.json
 * @param options 选项
 * @returns DependencyInventory
 */
export async function buildInventory(
  projectPath: string,
  pkg: PackageJson,
  options: BuildInventoryOptions = {},
): Promise<DependencyInventory> {
  const { includeDev = false, ignore = [] } = options
  const isIgnored = buildIgnoreMatcher(ignore)

  // 按 fallback 链尝试各数据源
  const result =
    (await tryNpmLockfile(projectPath, pkg, includeDev)) ??
    (await tryPnpmLockfile(projectPath, pkg, includeDev)) ??
    (await tryNodeModules(projectPath, pkg, includeDev)) ??
    fallbackFromPackageJson(pkg, includeDev)

  // 应用 ignore 过滤
  const filtered = result.entries.filter(e => !isIgnored(e.name))

  // 统计
  const directCount = filtered.filter(e => e.isDirect).length
  const transitiveCount = filtered.filter(e => !e.isDirect).length

  return {
    entries: filtered,
    directCount,
    transitiveCount,
    resolvedFrom: result.resolvedFrom,
    warnings: result.warnings,
  }
}

// =====================================================================
// npm lockfile (package-lock.json v2/v3)
// =====================================================================

interface NpmLockPackages {
  [path: string]: {
    version?: string
    resolved?: string
    dependencies?: Record<string, string>
    dev?: boolean
    optional?: boolean
    peer?: boolean
    name?: string
    link?: boolean
  }
}

interface NpmLockfile {
  lockfileVersion?: number
  packages?: NpmLockPackages
  dependencies?: Record<
    string,
    {
      version?: string
      requires?: Record<string, string>
      dependencies?: Record<string, unknown>
    }
  >
}

async function tryNpmLockfile(
  projectPath: string,
  pkg: PackageJson,
  includeDev: boolean,
): Promise<ParseResult | null> {
  const lockPath = join(projectPath, 'package-lock.json')
  if (!existsSync(lockPath)) return null

  try {
    const raw = await readFile(lockPath, 'utf-8')
    const lockfile = JSON.parse(raw) as NpmLockfile

    if (!lockfile.packages || typeof lockfile.packages !== 'object') return null

    return parseNpmLockPackages(lockfile.packages, pkg, includeDev)
  } catch {
    return null
  }
}

function parseNpmLockPackages(
  packages: NpmLockPackages,
  pkg: PackageJson,
  includeDev: boolean,
): ParseResult {
  const entries: DependencyEntry[] = []
  const warnings: string[] = []

  // 收集 direct dependencies
  const directDeps = collectDirectDeps(pkg, includeDev)

  // 遍历所有 packages 条目
  for (const [pkgPath, manifest] of Object.entries(packages)) {
    if (pkgPath === '') continue // 跳过 root
    if (manifest.link) continue // 跳过 workspace links

    // 从路径提取包名：node_modules/@scope/pkg → @scope/pkg，node_modules/pkg → pkg
    const name = extractNameFromNpmPath(pkgPath)
    if (!name) continue

    const version = manifest.version
    if (!version) continue

    // 检查是否为直接依赖
    const directSpec = directDeps.get(name)
    const isDirect = directSpec !== undefined

    // 检查是否为 alias
    const { packageName, isAlias, aliasOf, requestedSpec } = resolveAlias(
      name,
      directSpec ?? '',
      pkg,
    )

    entries.push({
      name,
      packageName,
      requestedSpec: requestedSpec || `transitive:${name}`,
      resolvedVersion: version,
      declaredIn: isDirect
        ? getDeclaredIn(name, pkg, includeDev)
        : 'transitive',
      isDirect,
      isAlias,
      aliasOf,
      resolvedFrom: 'package-lock.json',
      confidence: 'high',
      paths: [[name]],
    })
  }

  return { entries, resolvedFrom: 'package-lock.json', warnings }
}

/**
 * 从 npm lockfile 路径提取包名
 *
 * node_modules/lodash → lodash
 * node_modules/@scope/pkg → @scope/pkg
 * node_modules/foo/node_modules/bar → bar
 */
function extractNameFromNpmPath(pkgPath: string): string | null {
  // 取最后一个 node_modules/ 之后的部分
  const lastNm = pkgPath.lastIndexOf('node_modules/')
  if (lastNm === -1) return null
  const afterNm = pkgPath.slice(lastNm + 'node_modules/'.length)
  if (!afterNm) return null
  // 去掉尾部斜杠
  return afterNm.endsWith('/') ? afterNm.slice(0, -1) : afterNm
}

// =====================================================================
// pnpm lockfile (pnpm-lock.yaml v9+)
// =====================================================================

interface PnpmLockfile {
  lockfileVersion?: string
  importers?: Record<
    string,
    {
      dependencies?: Record<
        string,
        {
          specifier?: string
          version?: string
        }
      >
      devDependencies?: Record<
        string,
        {
          specifier?: string
          version?: string
        }
      >
      optionalDependencies?: Record<
        string,
        {
          specifier?: string
          version?: string
        }
      >
    }
  >
  packages?: Record<
    string,
    {
      resolution?: { integrity?: string; tarball?: string }
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      dev?: boolean
      optional?: boolean
    }
  >
}

async function tryPnpmLockfile(
  projectPath: string,
  pkg: PackageJson,
  includeDev: boolean,
): Promise<ParseResult | null> {
  const lockPath = join(projectPath, 'pnpm-lock.yaml')
  if (!existsSync(lockPath)) return null

  try {
    const raw = await readFile(lockPath, 'utf-8')
    const lockfile = yamlLoad(raw) as PnpmLockfile

    if (!lockfile.importers) return null

    return parsePnpmLockfile(lockfile, pkg, includeDev)
  } catch {
    return null
  }
}

function parsePnpmLockfile(
  lockfile: PnpmLockfile,
  pkg: PackageJson,
  includeDev: boolean,
): ParseResult {
  const entries: DependencyEntry[] = []
  const warnings: string[] = []

  // root importer
  const rootImporter = lockfile.importers?.['.']
  if (!rootImporter) {
    warnings.push('pnpm-lock.yaml 中未找到 root importer')
    return { entries, resolvedFrom: 'pnpm-lock.yaml', warnings }
  }

  // 收集直接依赖
  const allDirect = {
    ...(rootImporter.dependencies ?? {}),
    ...(includeDev ? (rootImporter.devDependencies ?? {}) : {}),
    ...(rootImporter.optionalDependencies ?? {}),
  }

  // packages 中的版本信息（用于解析 transitive）
  const packageVersions = new Map<string, string>()
  if (lockfile.packages) {
    for (const [pkgId, _manifest] of Object.entries(lockfile.packages)) {
      // pnpm v9 key 格式: name@version 或 @scope/pkg@version
      const parsed = parsePnpmPackageKey(pkgId)
      if (parsed) {
        // 保留每个包的最新版本（如果有多个）
        const existing = packageVersions.get(parsed.name)
        if (!existing || semver.gt(parsed.version, existing)) {
          packageVersions.set(parsed.name, parsed.version)
        }
      }
    }
  }

  // 处理直接依赖
  for (const [name, depInfo] of Object.entries(allDirect)) {
    const version = resolvePnpmVersion(depInfo.version, name, lockfile.packages)
    if (!version) {
      warnings.push(`pnpm: 无法解析 ${name} 的版本`)
      continue
    }

    const directSpec = getDirectSpec(name, pkg, includeDev)
    const { packageName, isAlias, aliasOf, requestedSpec } = resolveAlias(
      name,
      directSpec,
      pkg,
    )

    entries.push({
      name,
      packageName,
      requestedSpec: requestedSpec || depInfo.specifier || `transitive:${name}`,
      resolvedVersion: version,
      declaredIn: getDeclaredIn(name, pkg, includeDev),
      isDirect: true,
      isAlias,
      aliasOf,
      resolvedFrom: 'pnpm-lock.yaml',
      confidence: 'high',
      paths: [[name]],
    })
  }

  // 收集 transitive 依赖
  const directNames = new Set(entries.map(e => e.packageName))
  if (lockfile.packages) {
    for (const [pkgId] of Object.entries(lockfile.packages)) {
      const parsed = parsePnpmPackageKey(pkgId)
      if (!parsed) continue
      if (directNames.has(parsed.name)) continue // 已作为直接依赖处理

      entries.push({
        name: parsed.name,
        packageName: parsed.name,
        requestedSpec: `transitive:${parsed.name}`,
        resolvedVersion: parsed.version,
        declaredIn: 'transitive',
        isDirect: false,
        isAlias: false,
        resolvedFrom: 'pnpm-lock.yaml',
        confidence: 'high',
        paths: [[parsed.name]],
      })
    }
  }

  return { entries, resolvedFrom: 'pnpm-lock.yaml', warnings }
}

/**
 * 解析 pnpm lockfile package key
 *
 * v9 格式: /name@version 或 /@scope/name@version
 * 也可能带其他后缀如 (peer-dep@version)
 */
function parsePnpmPackageKey(
  key: string,
): { name: string; version: string } | null {
  // 去掉开头的 /
  const clean = key.startsWith('/') ? key.slice(1) : key
  if (!clean) return null

  // 找到最后一个 @（分隔包名和版本）
  // 对于 @scope/pkg@version，最后一个 @ 在 @scope/pkg 之后
  const lastAt = clean.lastIndexOf('@')
  if (lastAt <= 0) return null

  const name = clean.slice(0, lastAt)
  const versionWithSuffix = clean.slice(lastAt + 1)

  // 版本可能带括号后缀如 (peer-dep@version)，去掉
  const parenIdx = versionWithSuffix.indexOf('(')
  const version =
    parenIdx >= 0 ? versionWithSuffix.slice(0, parenIdx) : versionWithSuffix

  if (!name || !version) return null

  return { name, version }
}

/**
 * 从 pnpm lockfile 的版本引用中解析实际版本
 *
 * pnpm lockfile 中的 version 可能是:
 * - 直接版本: "4.17.21"
 * - 带目录引用: "4.17.21(@types/node@20.16.0)"
 * - peer dep 引用: "18.2.0(react@18.2.0)"
 */
function resolvePnpmVersion(
  versionRef: string | undefined,
  _name: string,
  _packages?: Record<string, unknown>,
): string | null {
  if (!versionRef) return null
  // 去掉括号后缀
  const parenIdx = versionRef.indexOf('(')
  const cleaned = parenIdx >= 0 ? versionRef.slice(0, parenIdx) : versionRef
  // 可能有 /name@version 格式（symlinked）
  const lastAt = cleaned.lastIndexOf('@')
  if (lastAt > 0) {
    return cleaned.slice(lastAt + 1)
  }
  return semver.valid(cleaned) ? cleaned : null
}

// =====================================================================
// node_modules fallback
// =====================================================================

async function tryNodeModules(
  projectPath: string,
  pkg: PackageJson,
  includeDev: boolean,
): Promise<ParseResult | null> {
  const nmPath = join(projectPath, 'node_modules')
  if (!existsSync(nmPath)) return null

  const entries: DependencyEntry[] = []
  const warnings: string[] = []
  const directDeps = collectDirectDeps(pkg, includeDev)

  for (const [name, rawSpec] of directDeps) {
    const { packageName, isAlias, aliasOf, requestedSpec } = resolveAlias(
      name,
      rawSpec,
      pkg,
    )

    // 读取 node_modules/<pkg>/package.json
    const pkgJsonPath = join(nmPath, packageName, 'package.json')
    let version: string | null = null
    try {
      const raw = await readFile(pkgJsonPath, 'utf-8')
      const manifest = JSON.parse(raw) as { version?: string }
      version = manifest.version ?? null
    } catch {
      // 包可能未安装
    }

    if (!version) {
      warnings.push(`node_modules: ${packageName} 未安装或无法读取版本`)
      continue
    }

    entries.push({
      name,
      packageName,
      requestedSpec: requestedSpec || rawSpec,
      resolvedVersion: version,
      declaredIn: getDeclaredIn(name, pkg, includeDev),
      isDirect: true,
      isAlias,
      aliasOf,
      resolvedFrom: 'node_modules',
      confidence: 'medium',
      paths: [[name]],
    })
  }

  // 尝试收集 node_modules 中的 transitive 依赖（仅顶层）
  try {
    const topLevel = await readdir(nmPath)
    const directNames = new Set(entries.map(e => e.packageName))

    for (const item of topLevel) {
      // 跳过 . 开头的目录和 .package-lock.json
      if (item.startsWith('.')) continue

      const scopeOrPkg = item
      if (scopeOrPkg.startsWith('@')) {
        // scoped packages: @scope/xxx
        const scopeDir = join(nmPath, scopeOrPkg)
        try {
          const scopedPkgs = await readdir(scopeDir)
          for (const scopedPkg of scopedPkgs) {
            const fullPkgName = `${scopeOrPkg}/${scopedPkg}`
            if (directNames.has(fullPkgName)) continue
            const version = await readNodeModulesVersion(nmPath, fullPkgName)
            if (version) {
              entries.push({
                name: fullPkgName,
                packageName: fullPkgName,
                requestedSpec: `transitive:${fullPkgName}`,
                resolvedVersion: version,
                declaredIn: 'transitive',
                isDirect: false,
                isAlias: false,
                resolvedFrom: 'node_modules',
                confidence: 'medium',
                paths: [[fullPkgName]],
              })
            }
          }
        } catch {
          // 不是目录，跳过
        }
      } else {
        if (directNames.has(scopeOrPkg)) continue
        const version = await readNodeModulesVersion(nmPath, scopeOrPkg)
        if (version) {
          entries.push({
            name: scopeOrPkg,
            packageName: scopeOrPkg,
            requestedSpec: `transitive:${scopeOrPkg}`,
            resolvedVersion: version,
            declaredIn: 'transitive',
            isDirect: false,
            isAlias: false,
            resolvedFrom: 'node_modules',
            confidence: 'medium',
            paths: [[scopeOrPkg]],
          })
        }
      }
    }
  } catch {
    warnings.push('node_modules: 无法读取目录列表')
  }

  if (entries.length === 0) return null
  return { entries, resolvedFrom: 'node_modules', warnings }
}

async function readNodeModulesVersion(
  nmPath: string,
  pkgName: string,
): Promise<string | null> {
  try {
    const raw = await readFile(join(nmPath, pkgName, 'package.json'), 'utf-8')
    const manifest = JSON.parse(raw) as { version?: string }
    return manifest.version ?? null
  } catch {
    return null
  }
}

// =====================================================================
// package.json fallback
// =====================================================================

function fallbackFromPackageJson(
  pkg: PackageJson,
  includeDev: boolean,
): ParseResult {
  const entries: DependencyEntry[] = []
  const warnings = [
    '无法读取 lockfile 或 node_modules，版本信息来自 package.json 声明（置信度低）',
  ]

  const directDeps = collectDirectDeps(pkg, includeDev)

  for (const [name, rawSpec] of directDeps) {
    const { packageName, isAlias, aliasOf, requestedSpec, version } =
      resolveAliasWithVersion(name, rawSpec, pkg)

    entries.push({
      name,
      packageName,
      requestedSpec: requestedSpec || rawSpec,
      resolvedVersion: version || '0.0.0',
      declaredIn: getDeclaredIn(name, pkg, includeDev),
      isDirect: true,
      isAlias,
      aliasOf,
      resolvedFrom: 'package-json-fallback',
      confidence: 'low',
      paths: [[name]],
    })
  }

  return { entries, resolvedFrom: 'package-json-fallback', warnings }
}

// =====================================================================
// 共享工具
// =====================================================================

interface ParseResult {
  entries: DependencyEntry[]
  resolvedFrom: ResolvedFrom
  warnings: string[]
}

/**
 * 收集直接依赖（name → rawSpec）
 */
function collectDirectDeps(
  pkg: PackageJson,
  includeDev: boolean,
): Map<string, string> {
  const deps = new Map<string, string>()
  for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
    deps.set(name, spec)
  }
  if (includeDev) {
    for (const [name, spec] of Object.entries(pkg.devDependencies ?? {})) {
      if (!deps.has(name)) deps.set(name, spec)
    }
  }
  // peerDependencies 和 optionalDependencies 也作为直接依赖
  for (const [name, spec] of Object.entries(pkg.peerDependencies ?? {})) {
    if (!deps.has(name)) deps.set(name, spec)
  }
  for (const [name, spec] of Object.entries(pkg.optionalDependencies ?? {})) {
    if (!deps.has(name)) deps.set(name, spec)
  }
  return deps
}

/**
 * 获取依赖在 package.json 中的声明位置
 */
function getDeclaredIn(
  name: string,
  pkg: PackageJson,
  includeDev: boolean,
): DeclaredIn {
  if (pkg.dependencies?.[name] !== undefined) return 'dependencies'
  if (includeDev && pkg.devDependencies?.[name] !== undefined)
    return 'devDependencies'
  if (pkg.peerDependencies?.[name] !== undefined) return 'peerDependencies'
  if (pkg.optionalDependencies?.[name] !== undefined)
    return 'optionalDependencies'
  return 'dependencies' // fallback
}

/**
 * 获取直接依赖的原始声明
 */
function getDirectSpec(
  name: string,
  pkg: PackageJson,
  includeDev: boolean,
): string {
  return (
    pkg.dependencies?.[name] ??
    (includeDev ? pkg.devDependencies?.[name] : undefined) ??
    pkg.peerDependencies?.[name] ??
    pkg.optionalDependencies?.[name] ??
    ''
  )
}

/**
 * 解析 npm alias
 *
 * 格式: npm:<pkg>@<version>
 * 例如: three149@npm:three@0.149.0
 *   → name=three149, packageName=three, resolvedVersion=0.149.0
 */
function resolveAlias(
  name: string,
  rawSpec: string,
  _pkg: PackageJson,
): {
  packageName: string
  isAlias: boolean
  aliasOf?: { name: string; spec: string }
  requestedSpec: string
} {
  // 检查是否为 npm alias（在 dependencies 中 name 对应的 spec 是 npm:xxx@version）
  if (rawSpec.startsWith('npm:')) {
    const inner = rawSpec.slice('npm:'.length)
    const at = inner.lastIndexOf('@')
    if (at > 0) {
      const targetName = inner.slice(0, at)
      const targetSpec = inner.slice(at + 1)
      return {
        packageName: targetName,
        isAlias: true,
        aliasOf: { name: targetName, spec: targetSpec },
        requestedSpec: rawSpec,
      }
    }
  }

  return {
    packageName: name,
    isAlias: false,
    requestedSpec: rawSpec,
  }
}

/**
 * 解析 alias 并尝试提取版本（用于 package.json fallback）
 */
function resolveAliasWithVersion(
  name: string,
  rawSpec: string,
  pkg: PackageJson,
): {
  packageName: string
  isAlias: boolean
  aliasOf?: { name: string; spec: string }
  requestedSpec: string
  version: string | undefined
} {
  const alias = resolveAlias(name, rawSpec, pkg)
  let version: string | undefined

  if (alias.isAlias) {
    // 从 alias spec 中提取版本
    const inner = rawSpec.slice('npm:'.length)
    const at = inner.lastIndexOf('@')
    if (at > 0) {
      version = cleanVersion(inner.slice(at + 1))
    }
  } else {
    version = cleanVersion(rawSpec)
  }

  return { ...alias, version }
}

/**
 * 从 semver range 中提取版本号
 *
 * ^1.2.3 → 1.2.3
 * ~4.5.0 → 4.5.0
 * >=1 <2 → 1
 * * → undefined
 */
function cleanVersion(raw: string): string | undefined {
  if (!raw) return undefined
  // 协议前缀
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !raw.startsWith('npm:'))
    return undefined
  // 通配符
  if (raw === '*' || raw === 'x' || raw === '') return undefined
  if (/^[a-z]+$/i.test(raw)) return undefined // latest, next 等 tag

  const cleaned = raw.replace(/^[\^~>=<]+/, '').split(' ')[0] ?? ''
  return cleaned || undefined
}
