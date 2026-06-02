/**
 * 依赖作用域分类器测试
 */

import { describe, expect, it } from 'vitest'

import type { DependencyEntry } from '../types/inventory.js'
import type { PackageJson } from '../types/package.js'

import { classifyDependencies, matchesRule } from './classifier.js'

// =====================================================================
// 测试工具
// =====================================================================

function makeEntry(
  name: string,
  overrides: Partial<DependencyEntry> = {},
): DependencyEntry {
  return {
    name,
    packageName: name,
    requestedSpec: '^1.0.0',
    resolvedVersion: '1.0.0',
    declaredIn: 'dependencies',
    isDirect: true,
    isAlias: false,
    resolvedFrom: 'package-json-fallback',
    confidence: 'low',
    paths: [[name]],
    ...overrides,
  }
}

function minimalPkg(overrides: Partial<PackageJson> = {}): PackageJson {
  return {
    name: 'test-project',
    version: '1.0.0',
    dependencies: {},
    ...overrides,
  }
}

// =====================================================================
// classifyDependencies
// =====================================================================

describe('classifyDependencies', () => {
  describe('包名规则 - build', () => {
    it.each([
      ['@babel/core', 'Babel 插件/预设'],
      ['@babel/plugin-transform-private-methods', 'Babel 插件/预设'],
      ['@rollup/plugin-terser', 'Rollup 插件'],
      ['webpack', 'Webpack 核心/插件'],
      ['vite', 'Vite 核心'],
      ['@vitejs/plugin-react', 'Vite 插件'],
      ['esbuild', 'esbuild 核心'],
      ['postcss', 'PostCSS 核心'],
      ['postcss-preset-env', 'PostCSS 插件'],
      ['tailwindcss', 'Tailwind CSS 核心'],
      ['typescript', 'TypeScript 编译器'],
      ['@types/node', 'TypeScript 类型定义'],
      ['eslint', 'ESLint 核心'],
      ['prettier', 'Prettier 格式化'],
      ['husky', 'Git hooks 管理'],
      ['lint-staged', '暂存文件 lint'],
      ['sass', 'Sass 编译器'],
    ])('%s → build (%s)', (name, expectedDetail) => {
      const result = classifyDependencies([makeEntry(name)], minimalPkg())
      expect(result[0]!.usageClass).toBe('build')
      expect(result[0]!.evidence.source).toBe('package-name-rule')
      expect(result[0]!.evidence.detail).toBe(expectedDetail)
    })
  })

  describe('包名规则 - test', () => {
    it.each([
      ['@testing-library/react', 'Testing Library'],
      ['vitest', 'Vitest 测试框架'],
      ['jest', 'Jest 测试框架'],
      ['cypress', 'Cypress E2E 测试'],
      ['playwright', 'Playwright E2E 测试'],
      ['@storybook/react', 'Storybook 组件开发'],
      ['msw', 'Mock Service Worker'],
    ])('%s → test (%s)', (name, expectedDetail) => {
      const result = classifyDependencies([makeEntry(name)], minimalPkg())
      expect(result[0]!.usageClass).toBe('test')
      expect(result[0]!.evidence.detail).toBe(expectedDetail)
    })
  })

  describe('包名规则 - script (CLI)', () => {
    it.each([
      ['@sentry/cli', 'Sentry CLI 工具'],
      ['cross-env', '跨平台环境变量'],
      ['rimraf', '跨平台 rm -rf'],
      ['concurrently', '并行命令执行'],
    ])('%s → script (%s)', (name, expectedDetail) => {
      const result = classifyDependencies([makeEntry(name)], minimalPkg())
      expect(result[0]!.usageClass).toBe('script')
      expect(result[0]!.evidence.detail).toBe(expectedDetail)
    })
  })

  describe('scripts 文本匹配', () => {
    it('包名出现在 scripts 中 → script', () => {
      const result = classifyDependencies(
        [makeEntry('my-cli-tool')],
        minimalPkg({
          scripts: {
            build: 'my-cli-tool build',
            start: 'my-cli-tool serve',
          },
        }),
      )
      expect(result[0]!.usageClass).toBe('script')
      expect(result[0]!.evidence.source).toBe('scripts-match')
    })
  })

  describe('用户 override', () => {
    it('用户 override 优先级最高', () => {
      const result = classifyDependencies(
        [makeEntry('eslint')], // 内置规则为 build
        minimalPkg(),
        { overrides: { eslint: 'runtime' } },
      )
      expect(result[0]!.usageClass).toBe('runtime')
      expect(result[0]!.evidence.source).toBe('user-override')
    })
  })

  describe('transitive 依赖', () => {
    it('transitive 依赖默认 unknown', () => {
      const result = classifyDependencies(
        [makeEntry('some-transitive', { isDirect: false })],
        minimalPkg(),
      )
      expect(result[0]!.usageClass).toBe('unknown')
      expect(result[0]!.evidence.detail).toBe('传递依赖，无直接证据')
    })
  })

  describe('无匹配规则', () => {
    it('无匹配规则 → unknown', () => {
      const result = classifyDependencies([makeEntry('react')], minimalPkg())
      expect(result[0]!.usageClass).toBe('unknown')
      expect(result[0]!.evidence.source).toBe('package-name-rule')
    })
  })

  describe('空依赖', () => {
    it('空列表返回空', () => {
      const result = classifyDependencies([], minimalPkg())
      expect(result).toEqual([])
    })
  })

  describe('多条目混合', () => {
    it('混合分类正确', () => {
      const result = classifyDependencies(
        [
          makeEntry('react'),
          makeEntry('@babel/core'),
          makeEntry('vitest'),
          makeEntry('@sentry/cli'),
          makeEntry('lodash'),
        ],
        minimalPkg(),
      )
      expect(result.map(e => e.usageClass)).toEqual([
        'unknown', // react
        'build', // @babel/core
        'test', // vitest
        'script', // @sentry/cli
        'unknown', // lodash
      ])
    })
  })
})

// =====================================================================
// matchesRule
// =====================================================================

describe('matchesRule', () => {
  it('匹配时返回描述', () => {
    expect(matchesRule('@babel/core', 'build')).toBe('Babel 插件/预设')
    expect(matchesRule('vitest', 'test')).toBe('Vitest 测试框架')
    expect(matchesRule('rimraf', 'script')).toBe('跨平台 rm -rf')
  })

  it('不匹配时返回 null', () => {
    expect(matchesRule('react', 'build')).toBeNull()
    expect(matchesRule('lodash', 'test')).toBeNull()
  })
})
