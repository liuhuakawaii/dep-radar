/**
 * Doctor 检查项
 *
 * 纯本地检查，不发网络请求。
 * 检查 lock 文件一致性、多 lock 文件、node_modules 状态等。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { PackageJson } from '../types/package.js'
import { detectPackageManager } from '../utils/packageManager.js'
import {
  checkExpoCompatibility,
  detectProject,
  type ProjectInfo,
} from './projectDetector.js'

export interface DoctorCheckResult {
  id: string
  name: string
  status: 'pass' | 'warn' | 'fail'
  message: string
  detail?: string
}

/**
 * 运行所有 doctor 检查项
 */
export async function runDoctorChecks(
  projectPath: string,
): Promise<DoctorCheckResult[]> {
  const results: DoctorCheckResult[] = []

  // 1. 检测包管理器
  const pm = detectPackageManager(projectPath)

  // 2. Lock 文件一致性
  results.push(checkLockFileConsistency(projectPath, pm))

  // 3. 多 lock 文件
  results.push(checkMultipleLockFiles(projectPath))

  // 4. node_modules 状态
  results.push(checkNodeModules(projectPath, pm))

  // 5. packageManager 字段（corepack）
  results.push(checkPackageManagerField(projectPath, pm))

  // 6. 项目类型检测 + Expo 版本兼容性
  try {
    const pkgPath = join(projectPath, 'package.json')
    const pkg: PackageJson = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    const projectInfo = detectProject(pkg)
    results.push(...checkProjectType(projectInfo))
    results.push(...checkExpoVersionCompat(projectInfo))
    results.push(...checkAppJsonPlugins(projectPath, pkg))
    results.push(checkDocConsistency(projectPath, pkg))
  } catch {
    // package.json 读取失败，跳过项目类型检查
  }

  return results
}

// =====================================================================
// 检查项实现
// =====================================================================

function checkLockFileConsistency(
  projectPath: string,
  pm: ReturnType<typeof detectPackageManager>,
): DoctorCheckResult {
  const lockFiles: Record<string, string> = {
    npm: 'package-lock.json',
    pnpm: 'pnpm-lock.yaml',
    yarn: 'yarn.lock',
    bun: 'bun.lock',
  }

  const expectedLock = lockFiles[pm] ?? 'package-lock.json'
  const lockPath = join(projectPath, expectedLock)

  if (existsSync(lockPath)) {
    return {
      id: 'lock-file',
      name: 'Lock 文件一致性',
      status: 'pass',
      message: `${expectedLock} 与包管理器 ${pm} 匹配`,
    }
  }

  return {
    id: 'lock-file',
    name: 'Lock 文件一致性',
    status: 'warn',
    message: `未找到 ${expectedLock}`,
    detail: `检测到包管理器为 ${pm}，但未找到对应的 lock 文件。运行 \`${pm} install\` 生成。`,
  }
}

function checkMultipleLockFiles(projectPath: string): DoctorCheckResult {
  const lockFiles = [
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
  ]

  const found = lockFiles.filter(f => existsSync(join(projectPath, f)))

  if (found.length <= 1) {
    return {
      id: 'multiple-locks',
      name: 'Lock 文件唯一性',
      status: 'pass',
      message: found.length === 0 ? '未找到 lock 文件' : `仅有 ${found[0]}`,
    }
  }

  return {
    id: 'multiple-locks',
    name: 'Lock 文件唯一性',
    status: 'warn',
    message: `发现多个 lock 文件：${found.join(', ')}`,
    detail:
      '多个 lock 文件可能导致依赖安装不一致，建议删除不需要的 lock 文件。',
  }
}

function checkNodeModules(
  projectPath: string,
  pm: ReturnType<typeof detectPackageManager>,
): DoctorCheckResult {
  const nmPath = join(projectPath, 'node_modules')

  if (!existsSync(nmPath)) {
    return {
      id: 'node-modules',
      name: 'node_modules 状态',
      status: 'warn',
      message: 'node_modules 不存在',
      detail: `运行 \`${pm} install\` 安装依赖。`,
    }
  }

  // 检查包管理器特定的元数据文件
  const metaFiles: Record<string, string> = {
    npm: 'node_modules/.package-lock.json',
    pnpm: 'node_modules/.modules.yaml',
    yarn: 'node_modules/.yarn-integrity',
    bun: 'node_modules/.package-lock.json',
  }

  const metaFile = metaFiles[pm]
  if (metaFile && !existsSync(join(projectPath, metaFile))) {
    return {
      id: 'node-modules',
      name: 'node_modules 状态',
      status: 'warn',
      message: `node_modules 存在但缺少 ${pm} 元数据`,
      detail: `可能需要运行 \`${pm} install\` 重新安装。`,
    }
  }

  return {
    id: 'node-modules',
    name: 'node_modules 状态',
    status: 'pass',
    message: 'node_modules 已安装且元数据一致',
  }
}

function checkPackageManagerField(
  projectPath: string,
  pm: ReturnType<typeof detectPackageManager>,
): DoctorCheckResult {
  // 读取 package.json 的 packageManager 字段（corepack）
  try {
    const pkgPath = join(projectPath, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))

    if (!pkg.packageManager) {
      return {
        id: 'pm-field',
        name: 'packageManager 字段',
        status: 'pass',
        message: '未声明 packageManager 字段（可选）',
      }
    }

    const declaredPm = pkg.packageManager.split('@')[0]
    if (declaredPm === pm) {
      return {
        id: 'pm-field',
        name: 'packageManager 字段',
        status: 'pass',
        message: `packageManager 字段 "${pkg.packageManager}" 与检测到的 ${pm} 一致`,
      }
    }

    return {
      id: 'pm-field',
      name: 'packageManager 字段',
      status: 'warn',
      message: `packageManager 字段 "${pkg.packageManager}" 与检测到的 ${pm} 不一致`,
      detail: '这可能导致 CI 和本地环境使用不同的包管理器。',
    }
  } catch {
    return {
      id: 'pm-field',
      name: 'packageManager 字段',
      status: 'pass',
      message: '无法读取 package.json',
    }
  }
}

// =====================================================================
// 项目类型检查
// =====================================================================

function checkProjectType(info: ProjectInfo): DoctorCheckResult[] {
  if (info.type === 'unknown') {
    return [
      {
        id: 'project-type',
        name: '项目类型',
        status: 'pass',
        message: '未识别特定框架（Node.js / 通用项目）',
      },
    ]
  }

  const fw = info.framework
  const ver = info.frameworkVersion ? `@${info.frameworkVersion}` : ''
  return [
    {
      id: 'project-type',
      name: '项目类型',
      status: 'pass',
      message: `${fw}${ver}`,
    },
  ]
}

// =====================================================================
// Expo 版本兼容性检查
// =====================================================================

function checkExpoVersionCompat(info: ProjectInfo): DoctorCheckResult[] {
  const issues = checkExpoCompatibility(info)

  if (issues.length === 0) {
    if (info.type === 'expo') {
      return [
        {
          id: 'expo-compat',
          name: 'Expo 版本兼容性',
          status: 'pass',
          message: `Expo SDK ${info.expoSdkVersion} 版本兼容`,
        },
      ]
    }
    return []
  }

  return issues.map(issue => ({
    id: `expo-compat-${issue.name}`,
    name: `Expo 兼容性: ${issue.name}`,
    status: 'warn' as const,
    message: `${issue.name}@${issue.actual ?? '未安装'} 与 Expo SDK ${info.expoSdkVersion} 不兼容`,
    detail: `期望版本：${issue.expected.join(' 或 ')}`,
  }))
}

// =====================================================================
// app.json / app.config.* plugins 检查
// =====================================================================

function checkAppJsonPlugins(
  projectPath: string,
  pkg: PackageJson,
): DoctorCheckResult[] {
  // 尝试读取 app.json 或 app.config.js
  let appConfig: Record<string, unknown> | undefined

  const configFiles = ['app.json', 'app.config.json']
  for (const file of configFiles) {
    const configPath = join(projectPath, file)
    if (existsSync(configPath)) {
      try {
        const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
        appConfig = raw.expo ?? raw
        break
      } catch {
        // JSON 解析失败，跳过
      }
    }
  }

  if (!appConfig) {
    return []
  }

  const plugins = appConfig.plugins
  if (!Array.isArray(plugins) || plugins.length === 0) {
    return []
  }

  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  }

  const missing: string[] = []
  for (const plugin of plugins) {
    // plugin 可以是字符串或 [string, options] 数组
    const pluginName = typeof plugin === 'string' ? plugin : plugin[0]
    if (typeof pluginName !== 'string') continue

    // Expo 内置插件不需要检查（如 expo-router, expo-camera 等以 expo- 开头的）
    if (pluginName.startsWith('expo-')) continue

    // 检查是否在依赖中
    if (!allDeps[pluginName]) {
      missing.push(pluginName)
    }
  }

  if (missing.length === 0) {
    return [
      {
        id: 'app-json-plugins',
        name: 'app.json plugins',
        status: 'pass',
        message: `所有 plugins 已安装`,
      },
    ]
  }

  return [
    {
      id: 'app-json-plugins',
      name: 'app.json plugins',
      status: 'warn',
      message: `${missing.length} 个 plugin 未安装：${missing.join(', ')}`,
      detail: 'app.json 中声明的 plugins 需要在 dependencies 中安装对应包。',
    },
  ]
}

// =====================================================================
// 文档一致性检查
// =====================================================================

function checkDocConsistency(
  projectPath: string,
  pkg: PackageJson,
): DoctorCheckResult {
  const readmePath = join(projectPath, 'README.md')
  if (!existsSync(readmePath)) {
    return {
      id: 'doc-consistency',
      name: '文档一致性',
      status: 'pass',
      message: '无 README.md，跳过文档一致性检查',
    }
  }

  try {
    const readme = readFileSync(readmePath, 'utf-8').toLowerCase()
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    }

    // 检查 README 提到的框架是否与实际依赖一致
    const frameworkChecks: Array<{
      keyword: string
      dep: string
      name: string
    }> = [
      { keyword: 'react native', dep: 'react-native', name: 'React Native' },
      { keyword: 'expo', dep: 'expo', name: 'Expo' },
      { keyword: 'next.js', dep: 'next', name: 'Next.js' },
      { keyword: 'nextjs', dep: 'next', name: 'Next.js' },
      { keyword: 'vite', dep: 'vite', name: 'Vite' },
    ]

    for (const check of frameworkChecks) {
      const mentionedInReadme = readme.includes(check.keyword)
      const hasDep = allDeps[check.dep] !== undefined

      if (mentionedInReadme && !hasDep) {
        return {
          id: 'doc-consistency',
          name: '文档一致性',
          status: 'warn',
          message: `README 提到 ${check.name}，但 package.json 中未找到 ${check.dep} 依赖`,
          detail: '文档描述与实际依赖可能不一致。',
        }
      }
    }

    return {
      id: 'doc-consistency',
      name: '文档一致性',
      status: 'pass',
      message: '文档与依赖声明基本一致',
    }
  } catch {
    return {
      id: 'doc-consistency',
      name: '文档一致性',
      status: 'pass',
      message: '无法读取 README.md',
    }
  }
}
