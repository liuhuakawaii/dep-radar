/**
 * 依赖作用域分类器
 *
 * 基于包名规则 + package.json scripts 匹配，给每个 direct dependency 标注 usageClass。
 * 不做源码扫描（那是 P1-3 reachability 的事）。
 *
 * 分类规则优先级：
 *   1. 用户 override（config.classification.overrides）
 *   2. 包名规则（BUILD_PATTERNS / TEST_PATTERNS / CLI_PATTERNS）
 *   3. package.json scripts 文本命中
 *   4. 无证据 → unknown
 *
 * transitive 依赖默认 unknown（不做假设）。
 */

import type { ReachabilityResult } from './reachability.js'

import type {
  ClassifyOptions,
  ClassificationEvidence,
  UsageClass,
} from '../types/classifier.js'
import type { DependencyEntry } from '../types/inventory.js'
import type { PackageJson } from '../types/package.js'

// =====================================================================
// 包名规则
// =====================================================================

interface NameRule {
  pattern: RegExp
  usageClass: Exclude<UsageClass, 'unknown'>
  description: string
}

/**
 * 构建工具规则
 *
 * 覆盖 babel、rollup、webpack、vite、esbuild、postcss、tailwind、
 * TypeScript、ESLint、Prettier、husky、lint-staged 等。
 */
const BUILD_RULES: NameRule[] = [
  // Babel
  { pattern: /^@babel\//, usageClass: 'build', description: 'Babel 插件/预设' },
  { pattern: /^babel-/, usageClass: 'build', description: 'Babel 插件' },
  // Rollup
  { pattern: /^@rollup\//, usageClass: 'build', description: 'Rollup 插件' },
  { pattern: /^rollup-/, usageClass: 'build', description: 'Rollup 插件' },
  // Webpack
  {
    pattern: /^webpack(-|$)/,
    usageClass: 'build',
    description: 'Webpack 核心/插件',
  },
  {
    pattern: /^@webpack-cli\//,
    usageClass: 'build',
    description: 'Webpack CLI',
  },
  {
    pattern: /-webpack-plugin$/,
    usageClass: 'build',
    description: 'Webpack 插件',
  },
  { pattern: /-loader$/, usageClass: 'build', description: 'Webpack loader' },
  // Vite
  { pattern: /^vite$/, usageClass: 'build', description: 'Vite 核心' },
  { pattern: /^@vitejs\//, usageClass: 'build', description: 'Vite 插件' },
  { pattern: /^vite-/, usageClass: 'build', description: 'Vite 插件' },
  // esbuild
  { pattern: /^esbuild$/, usageClass: 'build', description: 'esbuild 核心' },
  {
    pattern: /^@esbuild\//,
    usageClass: 'build',
    description: 'esbuild 平台包',
  },
  // PostCSS
  { pattern: /^postcss$/, usageClass: 'build', description: 'PostCSS 核心' },
  { pattern: /^postcss-/, usageClass: 'build', description: 'PostCSS 插件' },
  { pattern: /^@csstools\//, usageClass: 'build', description: 'PostCSS 工具' },
  // Tailwind
  {
    pattern: /^tailwindcss$/,
    usageClass: 'build',
    description: 'Tailwind CSS 核心',
  },
  {
    pattern: /^@tailwindcss\//,
    usageClass: 'build',
    description: 'Tailwind CSS 插件',
  },
  // TypeScript
  {
    pattern: /^typescript$/,
    usageClass: 'build',
    description: 'TypeScript 编译器',
  },
  {
    pattern: /^@types\//,
    usageClass: 'build',
    description: 'TypeScript 类型定义',
  },
  {
    pattern: /^tslib$/,
    usageClass: 'build',
    description: 'TypeScript 运行时辅助（通常由编译器注入）',
  },
  // ESLint
  { pattern: /^eslint$/, usageClass: 'build', description: 'ESLint 核心' },
  { pattern: /^eslint-/, usageClass: 'build', description: 'ESLint 插件/配置' },
  { pattern: /^@eslint\//, usageClass: 'build', description: 'ESLint 官方包' },
  {
    pattern: /^@typescript-eslint\//,
    usageClass: 'build',
    description: 'TypeScript ESLint',
  },
  // Prettier
  {
    pattern: /^prettier$/,
    usageClass: 'build',
    description: 'Prettier 格式化',
  },
  { pattern: /^prettier-/, usageClass: 'build', description: 'Prettier 插件' },
  // Git hooks / code quality
  { pattern: /^husky$/, usageClass: 'build', description: 'Git hooks 管理' },
  {
    pattern: /^lint-staged$/,
    usageClass: 'build',
    description: '暂存文件 lint',
  },
  // CSS 工具
  { pattern: /^sass$/, usageClass: 'build', description: 'Sass 编译器' },
  { pattern: /^less$/, usageClass: 'build', description: 'Less 编译器' },
  { pattern: /^stylus$/, usageClass: 'build', description: 'Stylus 编译器' },
  // 其他构建工具
  {
    pattern: /^@changesets\//,
    usageClass: 'build',
    description: 'Changesets 版本管理',
  },
  { pattern: /^tsup$/, usageClass: 'build', description: 'tsup 打包工具' },
  { pattern: /^turbo$/, usageClass: 'build', description: 'Turborepo' },
  { pattern: /^@turbo\//, usageClass: 'build', description: 'Turborepo 相关' },
]

/**
 * 测试工具规则
 */
const TEST_RULES: NameRule[] = [
  {
    pattern: /^@testing-library\//,
    usageClass: 'test',
    description: 'Testing Library',
  },
  { pattern: /^vitest$/, usageClass: 'test', description: 'Vitest 测试框架' },
  { pattern: /^@vitest\//, usageClass: 'test', description: 'Vitest 相关' },
  { pattern: /^jest$/, usageClass: 'test', description: 'Jest 测试框架' },
  { pattern: /^jest-/, usageClass: 'test', description: 'Jest 插件' },
  { pattern: /^@jest\//, usageClass: 'test', description: 'Jest 相关' },
  { pattern: /^mocha$/, usageClass: 'test', description: 'Mocha 测试框架' },
  { pattern: /^chai$/, usageClass: 'test', description: 'Chai 断言库' },
  { pattern: /^chai-/, usageClass: 'test', description: 'Chai 插件' },
  { pattern: /^cypress$/, usageClass: 'test', description: 'Cypress E2E 测试' },
  { pattern: /^@cypress\//, usageClass: 'test', description: 'Cypress 插件' },
  {
    pattern: /^playwright$/,
    usageClass: 'test',
    description: 'Playwright E2E 测试',
  },
  {
    pattern: /^@playwright\//,
    usageClass: 'test',
    description: 'Playwright 相关',
  },
  {
    pattern: /^@storybook\//,
    usageClass: 'test',
    description: 'Storybook 组件开发',
  },
  { pattern: /^storybook$/, usageClass: 'test', description: 'Storybook 核心' },
  { pattern: /^sinon$/, usageClass: 'test', description: 'Sinon 测试桩' },
  { pattern: /^sinon-/, usageClass: 'test', description: 'Sinon 插件' },
  {
    pattern: /^@faker-js\//,
    usageClass: 'test',
    description: 'Faker 测试数据',
  },
  { pattern: /^faker$/, usageClass: 'test', description: 'Faker 测试数据' },
  { pattern: /^msw$/, usageClass: 'test', description: 'Mock Service Worker' },
  { pattern: /^nyc$/, usageClass: 'test', description: 'NYC 代码覆盖率' },
  {
    pattern: /^istanbul$/,
    usageClass: 'test',
    description: 'Istanbul 代码覆盖率',
  },
  {
    pattern: /^@istanbuljs\//,
    usageClass: 'test',
    description: 'Istanbul 工具',
  },
  { pattern: /^c8$/, usageClass: 'test', description: 'c8 代码覆盖率' },
]

/**
 * CLI / 脚本工具规则
 */
const CLI_RULES: NameRule[] = [
  {
    pattern: /^@sentry\/cli$/,
    usageClass: 'script',
    description: 'Sentry CLI 工具',
  },
  {
    pattern: /^cross-env$/,
    usageClass: 'script',
    description: '跨平台环境变量',
  },
  { pattern: /^rimraf$/, usageClass: 'script', description: '跨平台 rm -rf' },
  {
    pattern: /^concurrently$/,
    usageClass: 'script',
    description: '并行命令执行',
  },
  {
    pattern: /^npm-run-all/,
    usageClass: 'script',
    description: 'npm scripts 编排',
  },
  { pattern: /^shx$/, usageClass: 'script', description: '跨平台 shell 命令' },
  { pattern: /^serve$/, usageClass: 'script', description: '静态文件服务器' },
  {
    pattern: /^http-server$/,
    usageClass: 'script',
    description: 'HTTP 服务器',
  },
  {
    pattern: /^live-server$/,
    usageClass: 'script',
    description: '热重载服务器',
  },
  { pattern: /^json$/, usageClass: 'script', description: 'JSON CLI 工具' },
  { pattern: /^dotenv$/, usageClass: 'script', description: '环境变量加载' },
  { pattern: /^dotenv-cli$/, usageClass: 'script', description: 'dotenv CLI' },
]

/** 合并所有规则（按优先级：build > test > script） */
const ALL_RULES: NameRule[] = [...BUILD_RULES, ...TEST_RULES, ...CLI_RULES]

// =====================================================================
// 主函数
// =====================================================================

/**
 * 对依赖条目列表进行作用域分类
 *
 * @param entries DependencyInventory 的 entries
 * @param pkg 项目 package.json（用于 scripts 匹配）
 * @param options 分类选项
 * @returns 带分类信息的条目列表
 */
export function classifyDependencies(
  entries: DependencyEntry[],
  pkg: PackageJson,
  options: ClassifyOptions & {
    reachabilityResults?: ReachabilityResult[]
  } = {},
): Array<
  DependencyEntry & { usageClass: UsageClass; evidence: ClassificationEvidence }
> {
  const { overrides, reachabilityResults } = options
  const scripts = pkg.scripts ?? {}
  const scriptsText = Object.values(scripts).join(' ')

  // 构建可达性结果索引
  const reachabilityByPkg = new Map<string, ReachabilityResult>()
  if (reachabilityResults) {
    for (const r of reachabilityResults) {
      reachabilityByPkg.set(r.packageName, r)
    }
  }

  return entries.map(entry => {
    // 1. 用户 override 最高优先级
    if (overrides?.[entry.name]) {
      return {
        ...entry,
        usageClass: overrides[entry.name]!,
        evidence: {
          source: 'user-override',
          detail: `用户配置覆盖为 ${overrides[entry.name]}`,
        },
      }
    }

    // 2. transitive 依赖默认 unknown
    if (!entry.isDirect) {
      return {
        ...entry,
        usageClass: 'unknown' as const,
        evidence: {
          source: 'package-name-rule',
          detail: '传递依赖，无直接证据',
        },
      }
    }

    // 3. 包名规则匹配
    for (const rule of ALL_RULES) {
      if (
        rule.pattern.test(entry.name) ||
        rule.pattern.test(entry.packageName)
      ) {
        return {
          ...entry,
          usageClass: rule.usageClass,
          evidence: { source: 'package-name-rule', detail: rule.description },
        }
      }
    }

    // 4. scripts 文本匹配
    if (
      scriptsText.includes(entry.name) ||
      scriptsText.includes(entry.packageName)
    ) {
      return {
        ...entry,
        usageClass: 'script' as const,
        evidence: {
          source: 'scripts-match',
          detail: '出现在 package.json scripts 中',
        },
      }
    }

    // 5. 可达性分析结果
    const reachability =
      reachabilityByPkg.get(entry.name) ??
      reachabilityByPkg.get(entry.packageName)
    if (reachability) {
      if (reachability.reachableFromRuntimeEntry) {
        return {
          ...entry,
          usageClass: 'runtime' as const,
          evidence: {
            source: 'reachability',
            detail: `在 ${reachability.importCount} 个源文件中被引用（${reachability.importers
              .map(i => i.file)
              .slice(0, 3)
              .join(', ')}${reachability.importCount > 3 ? '...' : ''}）`,
          },
        }
      }
      // 非 src bucket（test/config）
      return {
        ...entry,
        usageClass: reachability.sourceBucket === 'test' ? 'test' : 'config',
        evidence: {
          source: 'reachability',
          detail: `仅在 ${reachability.sourceBucket} 文件中被引用（${reachability.importers
            .map(i => i.file)
            .slice(0, 3)
            .join(', ')}）`,
        },
      }
    }

    // 6. 无证据 → unknown
    return {
      ...entry,
      usageClass: 'unknown' as const,
      evidence: {
        source: 'package-name-rule',
        detail: '无匹配规则，需确认是否进入 bundle',
      },
    }
  })
}

// =====================================================================
// 工具（导出供测试）
// =====================================================================

/**
 * 检查单个包名是否匹配指定类别的规则
 *
 * 导出供外部快速查询（如 optimizer 想知道某包是否为构建工具）。
 */
export function matchesRule(
  name: string,
  usageClass: Exclude<UsageClass, 'unknown'>,
): string | null {
  const rules =
    usageClass === 'build'
      ? BUILD_RULES
      : usageClass === 'test'
        ? TEST_RULES
        : CLI_RULES
  for (const rule of rules) {
    if (rule.pattern.test(name)) return rule.description
  }
  return null
}
