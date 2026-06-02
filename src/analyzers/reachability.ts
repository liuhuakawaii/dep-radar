/**
 * 源码可达性分析器
 *
 * 扫描项目源码中的 import/require 语句，为每个 direct dependency 提供
 * import 证据（位置、频率、来源 bucket）。
 *
 * 扫描范围：
 *   - src: src 下的 js/jsx/ts/tsx/mjs/cjs 文件
 *   - config: vite.config、webpack.config 等（项目根目录）
 *   - test: *.test.*、*.spec.*、__tests__/**
 *
 * 解析方式：正则匹配 import/export/require 语句（轻量，无 AST 依赖）。
 * 子路径归一化：react-icons/fa → react-icons，@scope/pkg/sub → @scope/pkg
 */

import { readFile } from 'node:fs/promises'

import fg from 'fast-glob'

import type { DependencyEntry } from '../types/inventory.js'

// =====================================================================
// 公开类型
// =====================================================================

export interface ImportLocation {
  /** 相对于项目根的文件路径 */
  file: string
  /** 行号（1-based） */
  line: number
  /** 原始 import specifier（如 'react-icons/fa'） */
  specifier: string
  /** import 形式 */
  importKind: 'import' | 'require' | 'dynamic-import' | 're-export'
}

export type SourceBucket = 'src' | 'test' | 'config' | 'script'

export interface ReachabilityResult {
  /** 归一化后的包名 */
  packageName: string
  /** 所有 import 位置 */
  importers: ImportLocation[]
  /** 来源 bucket（取最优先的：src > config > test > script） */
  sourceBucket: SourceBucket
  /** 是否从 src 入口可达（sourceBucket === 'src'） */
  reachableFromRuntimeEntry: boolean
  /** 总 import 次数 */
  importCount: number
}

export interface ReachabilityOptions {
  /** src 文件 glob 模式列表；默认 ['src/**'] */
  srcGlobs?: string[]
  /** 要扫描的文件扩展名 */
  extensions?: string[]
  /** 忽略的目录 */
  ignore?: string[]
}

// =====================================================================
// Node 内置模块列表（不需要完整列表，覆盖常见的即可）
// =====================================================================

const NODE_BUILTINS = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
  // node: 前缀版本
  'node:assert',
  'node:async_hooks',
  'node:buffer',
  'node:child_process',
  'node:cluster',
  'node:console',
  'node:constants',
  'node:crypto',
  'node:dgram',
  'node:dns',
  'node:domain',
  'node:events',
  'node:fs',
  'node:http',
  'node:http2',
  'node:https',
  'node:inspector',
  'node:module',
  'node:net',
  'node:os',
  'node:path',
  'node:perf_hooks',
  'node:process',
  'node:punycode',
  'node:querystring',
  'node:readline',
  'node:repl',
  'node:stream',
  'node:string_decoder',
  'node:sys',
  'node:timers',
  'node:tls',
  'node:tty',
  'node:url',
  'node:util',
  'node:v8',
  'node:vm',
  'node:wasi',
  'node:worker_threads',
  'node:zlib',
])

// =====================================================================
// 子路径归一化
// =====================================================================

/**
 * 将 import specifier 归一化为包名
 *
 * - 'react' → 'react'
 * - 'react-icons/fa' → 'react-icons'
 * - '@scope/pkg/sub' → '@scope/pkg'
 * - './utils' → null（相对路径）
 * - 'fs' → null（node 内置模块）
 */
export function normalizeSpecifier(specifier: string): string | null {
  // 跳过相对路径
  if (specifier.startsWith('.')) return null

  // 跳过 node 内置模块
  if (NODE_BUILTINS.has(specifier)) return null

  // 跳过 URL（http/https/data/blob）
  if (/^(https?|data|blob):/.test(specifier)) return null

  // 跳过 CSS/JSON 等非 JS 文件导入
  if (
    /\.(css|scss|less|sass|json|png|jpg|gif|svg|woff|woff2|ttf|eot)$/.test(
      specifier,
    )
  )
    return null

  // Scoped 包：@scope/pkg/sub → @scope/pkg
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/')
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`
    return specifier
  }

  // 普通包：pkg/sub/path → pkg
  const slashIdx = specifier.indexOf('/')
  if (slashIdx > 0) return specifier.slice(0, slashIdx)
  return specifier
}

// =====================================================================
// 文件扫描
// =====================================================================

/** 默认 src 文件模式 */
const SRC_PATTERNS = (ext: string) => [`src/**/*.${ext}`]

/** 配置文件模式（项目根目录） */
const CONFIG_PATTERNS = (ext: string) => [
  `vite.config.${ext}`,
  `webpack.config.${ext}`,
  `rollup.config.${ext}`,
  `postcss.config.${ext}`,
  `tailwind.config.${ext}`,
  `craco.config.${ext}`,
  `.eslintrc.${ext}`,
  `.prettierrc.${ext}`,
]

/** 测试文件模式 */
const TEST_PATTERNS = (ext: string) => [
  `**/*.test.${ext}`,
  `**/*.spec.${ext}`,
  `**/__tests__/**/*.${ext}`,
]

/** 默认忽略目录 */
const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
]

// =====================================================================
// 主函数
// =====================================================================

/**
 * 分析项目源码中对依赖包的 import 情况
 *
 * @param projectPath 项目根目录
 * @param entries DependencyInventory 的 entries（用于匹配包名）
 * @param options 选项
 * @returns 每个被 import 的包的可达性结果
 */
export async function analyzeReachability(
  projectPath: string,
  entries: DependencyEntry[],
  options: ReachabilityOptions = {},
): Promise<ReachabilityResult[]> {
  const {
    srcGlobs,
    extensions = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'],
    ignore = DEFAULT_IGNORE,
  } = options

  // 构建已知包名集合（用于过滤 import 结果）
  const knownPackages = new Set<string>()
  for (const entry of entries) {
    knownPackages.add(entry.packageName)
    knownPackages.add(entry.name) // alias 名也需要
  }

  // 收集所有 import 位置
  const allImports: Array<ImportLocation & { packageName: string }> = []

  for (const ext of extensions) {
    // src 文件
    const srcPatterns = srcGlobs
      ? srcGlobs.map(g => g.replace(/\{ext\}/g, ext))
      : SRC_PATTERNS(ext)

    for (const pattern of srcPatterns) {
      const files = await fg(pattern, {
        cwd: projectPath,
        ignore,
        onlyFiles: true,
        absolute: false,
      })

      for (const file of files) {
        const imports = await scanFile(projectPath, file)
        for (const imp of imports) {
          const pkg = normalizeSpecifier(imp.specifier)
          if (pkg && knownPackages.has(pkg)) {
            allImports.push({ ...imp, packageName: pkg })
          }
        }
      }
    }

    // 配置文件
    for (const pattern of CONFIG_PATTERNS(ext)) {
      const files = await fg(pattern, {
        cwd: projectPath,
        ignore,
        onlyFiles: true,
        absolute: false,
      })
      for (const file of files) {
        const imports = await scanFile(projectPath, file)
        for (const imp of imports) {
          const pkg = normalizeSpecifier(imp.specifier)
          if (pkg && knownPackages.has(pkg)) {
            allImports.push({ ...imp, packageName: pkg })
          }
        }
      }
    }

    // 测试文件
    for (const pattern of TEST_PATTERNS(ext)) {
      const files = await fg(pattern, {
        cwd: projectPath,
        ignore,
        onlyFiles: true,
        absolute: false,
      })
      for (const file of files) {
        const imports = await scanFile(projectPath, file)
        for (const imp of imports) {
          const pkg = normalizeSpecifier(imp.specifier)
          if (pkg && knownPackages.has(pkg)) {
            allImports.push({ ...imp, packageName: pkg })
          }
        }
      }
    }
  }

  // 按 packageName 聚合
  return aggregateResults(allImports, projectPath, srcGlobs)
}

// =====================================================================
// 文件扫描
// =====================================================================

/**
 * 扫描单个文件中的 import/require 语句
 */
async function scanFile(
  projectPath: string,
  file: string,
): Promise<ImportLocation[]> {
  const absPath = `${projectPath}/${file}`
  let content: string
  try {
    content = await readFile(absPath, 'utf-8')
  } catch {
    return []
  }

  const results: ImportLocation[] = []
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    // ESM import
    const importMatches = line.matchAll(
      /^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    )
    for (const match of importMatches) {
      if (match[1]) {
        results.push({
          file,
          line: i + 1,
          specifier: match[1],
          importKind: 'import',
        })
      }
    }

    // ESM re-export
    const reExportMatches = line.matchAll(
      /^\s*export\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g,
    )
    for (const match of reExportMatches) {
      if (match[1]) {
        results.push({
          file,
          line: i + 1,
          specifier: match[1],
          importKind: 're-export',
        })
      }
    }

    // CJS require
    const requireMatches = line.matchAll(
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    )
    for (const match of requireMatches) {
      if (match[1]) {
        results.push({
          file,
          line: i + 1,
          specifier: match[1],
          importKind: 'require',
        })
      }
    }

    // Dynamic import（排除 static import 行）
    if (!/^\s*import\s/.test(line)) {
      const dynamicMatches = line.matchAll(
        /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      )
      for (const match of dynamicMatches) {
        if (match[1]) {
          results.push({
            file,
            line: i + 1,
            specifier: match[1],
            importKind: 'dynamic-import',
          })
        }
      }
    }
  }

  return results
}

// =====================================================================
// 聚合
// =====================================================================

/** bucket 优先级：src > config > test > script */
const BUCKET_PRIORITY: Record<SourceBucket, number> = {
  src: 4,
  config: 3,
  test: 2,
  script: 1,
}

/**
 * 判断文件属于哪个 source bucket
 */
function classifyFile(file: string): SourceBucket {
  // 测试文件
  if (/\.(test|spec)\.[^.]+$/.test(file) || file.includes('__tests__/')) {
    return 'test'
  }
  // 配置文件（项目根目录下的配置文件）
  const basename = file.split('/').pop() ?? ''
  if (
    /^(vite|webpack|rollup|postcss|tailwind|craco|eslint|prettier)\.config\./.test(
      basename,
    )
  ) {
    return 'config'
  }
  if (basename.startsWith('.eslintrc') || basename.startsWith('.prettierrc')) {
    return 'config'
  }
  // 默认为 src
  return 'src'
}

/**
 * 聚合 import 结果为按包名分组的可达性结果
 */
function aggregateResults(
  imports: Array<ImportLocation & { packageName: string }>,
  _projectPath: string,
  _srcGlobs?: string[],
): ReachabilityResult[] {
  const byPackage = new Map<string, ImportLocation[]>()

  for (const imp of imports) {
    const list = byPackage.get(imp.packageName) ?? []
    list.push({
      file: imp.file,
      line: imp.line,
      specifier: imp.specifier,
      importKind: imp.importKind,
    })
    byPackage.set(imp.packageName, list)
  }

  const results: ReachabilityResult[] = []

  for (const [packageName, importers] of byPackage) {
    // 确定最高优先级的 bucket
    let bestBucket: SourceBucket = 'script'
    let bestPriority = 0
    for (const imp of importers) {
      const bucket = classifyFile(imp.file)
      const priority = BUCKET_PRIORITY[bucket]
      if (priority > bestPriority) {
        bestPriority = priority
        bestBucket = bucket
      }
    }

    results.push({
      packageName,
      importers,
      sourceBucket: bestBucket,
      reachableFromRuntimeEntry: bestBucket === 'src',
      importCount: importers.length,
    })
  }

  return results
}

// =====================================================================
// 工具（导出供测试）
// =====================================================================

/**
 * 从文件内容中提取所有 import specifier（纯函数，便于测试）
 */
export function extractImportSpecifiers(content: string): Array<{
  specifier: string
  importKind: ImportLocation['importKind']
  line: number
}> {
  const results: Array<{
    specifier: string
    importKind: ImportLocation['importKind']
    line: number
  }> = []

  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    // ESM import
    for (const match of line.matchAll(
      /^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    )) {
      if (match[1])
        results.push({ specifier: match[1], importKind: 'import', line: i + 1 })
    }

    // ESM re-export
    for (const match of line.matchAll(
      /^\s*export\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g,
    )) {
      if (match[1])
        results.push({
          specifier: match[1],
          importKind: 're-export',
          line: i + 1,
        })
    }

    // CJS require
    for (const match of line.matchAll(
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    )) {
      if (match[1])
        results.push({
          specifier: match[1],
          importKind: 'require',
          line: i + 1,
        })
    }

    // Dynamic import
    if (!/^\s*import\s/.test(line)) {
      for (const match of line.matchAll(
        /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      )) {
        if (match[1])
          results.push({
            specifier: match[1],
            importKind: 'dynamic-import',
            line: i + 1,
          })
      }
    }
  }

  return results
}
