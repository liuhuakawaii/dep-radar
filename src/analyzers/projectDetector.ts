/**
 * 项目类型检测器
 *
 * 基于 package.json 依赖声明检测项目类型：
 * expo / react-native / next / vite / node
 */

import type { PackageJson } from '../types/package.js'

/**
 * Expo SDK 版本兼容性表
 *
 * key: Expo SDK 主版本（如 "52"）
 * value: 兼容的 react 和 react-native 版本范围
 */
const EXPO_SDK_COMPAT: Record<
  string,
  { react: string[]; reactNative: string[] }
> = {
  '52': {
    react: ['18.3.1'],
    reactNative: ['0.76.0', '0.76.1', '0.76.2', '0.76.3'],
  },
  '51': {
    react: ['18.2.0'],
    reactNative: ['0.74.0', '0.74.1', '0.74.2', '0.74.3'],
  },
  '50': {
    react: ['18.2.0'],
    reactNative: ['0.73.0', '0.73.1', '0.73.2', '0.73.4', '0.73.6'],
  },
  '49': {
    react: ['18.2.0'],
    reactNative: ['0.72.0', '0.72.1', '0.72.3', '0.72.4', '0.72.5', '0.72.6'],
  },
}

export type ProjectType =
  | 'expo'
  | 'react-native'
  | 'next'
  | 'vite'
  | 'node'
  | 'unknown'

export interface ProjectInfo {
  type: ProjectType
  /** 框架名称 */
  framework?: string
  /** 框架版本 */
  frameworkVersion?: string
  /** React 版本（RN/Next/Expo 项目） */
  reactVersion?: string
  /** Expo SDK 版本（仅 Expo 项目） */
  expoSdkVersion?: string
}

/**
 * 检测项目类型
 */
export function detectProject(pkg: PackageJson): ProjectInfo {
  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  }

  // Expo: 有 expo 依赖
  if (allDeps.expo) {
    return {
      type: 'expo',
      framework: 'Expo',
      frameworkVersion: cleanVersion(allDeps.expo),
      reactVersion: cleanVersion(allDeps.react),
      expoSdkVersion: cleanVersion(allDeps.expo),
    }
  }

  // React Native: 有 react-native 但没有 expo
  if (allDeps['react-native']) {
    return {
      type: 'react-native',
      framework: 'React Native',
      frameworkVersion: cleanVersion(allDeps['react-native']),
      reactVersion: cleanVersion(allDeps.react),
    }
  }

  // Next.js: 有 next
  if (allDeps.next) {
    return {
      type: 'next',
      framework: 'Next.js',
      frameworkVersion: cleanVersion(allDeps.next),
      reactVersion: cleanVersion(allDeps.react),
    }
  }

  // Vite: 有 vite 在 devDependencies
  if (pkg.devDependencies?.vite) {
    return {
      type: 'vite',
      framework: 'Vite',
      frameworkVersion: cleanVersion(pkg.devDependencies.vite),
    }
  }

  // Node.js: 有 express / koa / fastify 等
  const nodeFrameworks = ['express', 'koa', 'fastify', 'hapi', 'nest']
  for (const fw of nodeFrameworks) {
    if (allDeps[fw]) {
      return {
        type: 'node',
        framework: fw.charAt(0).toUpperCase() + fw.slice(1),
        frameworkVersion: cleanVersion(allDeps[fw]),
      }
    }
  }

  return { type: 'unknown' }
}

/** 去掉版本范围前缀（^ ~ >= 等） */
function cleanVersion(version: string | undefined): string | undefined {
  if (!version) return undefined
  return version.replace(/^[\^~>=<\s]+/, '')
}

/**
 * 检查 Expo SDK 版本兼容性
 *
 * 返回不兼容的依赖列表，空数组表示全部兼容。
 */
export function checkExpoCompatibility(
  info: ProjectInfo,
): Array<{ name: string; expected: string[]; actual: string | undefined }> {
  if (info.type !== 'expo' || !info.expoSdkVersion) return []

  // 从 expo 版本提取主版本号（如 "52.0.0" → "52"）
  const major = info.expoSdkVersion.split('.')[0]
  if (!major) return []

  const compat = EXPO_SDK_COMPAT[major]
  if (!compat) return []

  const issues: Array<{
    name: string
    expected: string[]
    actual: string | undefined
  }> = []

  // 检查 react 版本
  if (info.reactVersion && !compat.react.includes(info.reactVersion)) {
    issues.push({
      name: 'react',
      expected: compat.react,
      actual: info.reactVersion,
    })
  }

  return issues
}
