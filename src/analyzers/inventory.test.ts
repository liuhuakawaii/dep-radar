/**
 * DependencyInventory 构建器测试
 */

import { describe, expect, it } from 'vitest'

import type { PackageJson } from '../types/package.js'

import { buildInventory } from './inventory.js'

// =====================================================================
// 测试工具
// =====================================================================

function minimalPkg(overrides: Partial<PackageJson> = {}): PackageJson {
  return {
    name: 'test-project',
    version: '1.0.0',
    dependencies: {},
    ...overrides,
  }
}

// =====================================================================
// buildInventory 测试
// =====================================================================

describe('buildInventory', () => {
  describe('package.json fallback（无 lockfile、无 node_modules）', () => {
    it('从 dependencies 构建直接依赖', async () => {
      // 使用一个不存在的路径，确保没有 lockfile 和 node_modules
      const pkg = minimalPkg({
        dependencies: {
          lodash: '^4.17.21',
          react: '~18.2.0',
        },
      })

      const inventory = await buildInventory('/nonexistent', pkg)

      expect(inventory.resolvedFrom).toBe('package-json-fallback')
      expect(inventory.directCount).toBe(2)
      expect(inventory.entries).toHaveLength(2)

      const lodash = inventory.entries.find(e => e.name === 'lodash')!
      expect(lodash.packageName).toBe('lodash')
      expect(lodash.resolvedVersion).toBe('4.17.21')
      expect(lodash.isDirect).toBe(true)
      expect(lodash.isAlias).toBe(false)
      expect(lodash.confidence).toBe('low')
      expect(lodash.declaredIn).toBe('dependencies')

      const react = inventory.entries.find(e => e.name === 'react')!
      expect(react.resolvedVersion).toBe('18.2.0')
    })

    it('解析 npm alias（npm:three@0.149.0）', async () => {
      const pkg = minimalPkg({
        dependencies: {
          three149: 'npm:three@0.149.0',
          three: '^0.165.0',
        },
      })

      const inventory = await buildInventory('/nonexistent', pkg)

      const alias = inventory.entries.find(e => e.name === 'three149')!
      expect(alias.packageName).toBe('three')
      expect(alias.isAlias).toBe(true)
      expect(alias.aliasOf).toEqual({ name: 'three', spec: '0.149.0' })
      expect(alias.resolvedVersion).toBe('0.149.0')

      const direct = inventory.entries.find(e => e.name === 'three')!
      expect(direct.isAlias).toBe(false)
      expect(direct.resolvedVersion).toBe('0.165.0')
    })

    it('includeDev 包含 devDependencies', async () => {
      const pkg = minimalPkg({
        dependencies: { lodash: '^4.17.21' },
        devDependencies: { vitest: '^2.1.0' },
      })

      const withoutDev = await buildInventory('/nonexistent', pkg)
      expect(withoutDev.directCount).toBe(1)
      expect(withoutDev.entries.find(e => e.name === 'vitest')).toBeUndefined()

      const withDev = await buildInventory('/nonexistent', pkg, {
        includeDev: true,
      })
      expect(withDev.directCount).toBe(2)
      const vitest = withDev.entries.find(e => e.name === 'vitest')!
      expect(vitest.declaredIn).toBe('devDependencies')
    })

    it('includeDev 避免重复（dependencies 优先于 devDependencies）', async () => {
      const pkg = minimalPkg({
        dependencies: { lodash: '^4.17.21' },
        devDependencies: { lodash: '^4.17.20' },
      })

      const inventory = await buildInventory('/nonexistent', pkg, {
        includeDev: true,
      })
      const lodashEntries = inventory.entries.filter(e => e.name === 'lodash')
      expect(lodashEntries).toHaveLength(1)
      expect(lodashEntries[0]!.declaredIn).toBe('dependencies')
    })

    it('ignore 过滤', async () => {
      const pkg = minimalPkg({
        dependencies: {
          lodash: '^4.17.21',
          react: '^18.2.0',
          '@internal/utils': '^1.0.0',
        },
      })

      const inventory = await buildInventory('/nonexistent', pkg, {
        ignore: ['lodash', '@internal/*'],
      })

      expect(inventory.directCount).toBe(1)
      expect(inventory.entries[0]!.name).toBe('react')
    })

    it('通配符版本返回 0.0.0', async () => {
      const pkg = minimalPkg({
        dependencies: { lodash: '*' },
      })

      const inventory = await buildInventory('/nonexistent', pkg)

      // * 无法解析版本，但仍会创建条目
      expect(inventory.entries).toHaveLength(1)
      expect(inventory.entries[0]!.resolvedVersion).toBe('0.0.0')
    })

    it('peerDependencies 和 optionalDependencies 被收集', async () => {
      const pkg = minimalPkg({
        dependencies: { react: '^18.2.0' },
        peerDependencies: { 'react-dom': '^18.2.0' },
        optionalDependencies: { fsevents: '^2.3.0' },
      })

      const inventory = await buildInventory('/nonexistent', pkg)

      expect(inventory.directCount).toBe(3)
      expect(
        inventory.entries.find(e => e.name === 'react-dom')!.declaredIn,
      ).toBe('peerDependencies')
      expect(
        inventory.entries.find(e => e.name === 'fsevents')!.declaredIn,
      ).toBe('optionalDependencies')
    })

    it('semver range 解析正确', async () => {
      const pkg = minimalPkg({
        dependencies: {
          a: '^1.2.3',
          b: '~4.5.0',
          c: '>=1 <2',
          d: '1.0.0',
        },
      })

      const inventory = await buildInventory('/nonexistent', pkg)

      const versions = new Map(
        inventory.entries.map(e => [e.name, e.resolvedVersion]),
      )
      expect(versions.get('a')).toBe('1.2.3')
      expect(versions.get('b')).toBe('4.5.0')
      expect(versions.get('c')).toBe('1')
      expect(versions.get('d')).toBe('1.0.0')
    })

    it('显示降级警告', async () => {
      const pkg = minimalPkg({
        dependencies: { lodash: '^4.17.21' },
      })

      const inventory = await buildInventory('/nonexistent', pkg)

      expect(inventory.warnings.length).toBeGreaterThan(0)
      expect(
        inventory.warnings.some(
          w => w.includes('package-json-fallback') || w.includes('lockfile'),
        ),
      ).toBe(true)
    })
  })

  describe('npm lockfile (package-lock.json)', () => {
    it('无 lockfile 时 fallback 到 package.json', async () => {
      const pkg = minimalPkg({
        dependencies: { lodash: '^4.17.21' },
      })

      const inventory = await buildInventory('/nonexistent', pkg)
      expect(inventory.resolvedFrom).toBe('package-json-fallback')
    })
  })

  describe('edge cases', () => {
    it('空 dependencies 返回空 inventory', async () => {
      const pkg = minimalPkg()
      const inventory = await buildInventory('/nonexistent', pkg)

      expect(inventory.entries).toHaveLength(0)
      expect(inventory.directCount).toBe(0)
      expect(inventory.transitiveCount).toBe(0)
    })

    it('warns 被正确收集', async () => {
      const pkg = minimalPkg({
        dependencies: { lodash: '^4.17.21' },
      })

      const inventory = await buildInventory('/nonexistent', pkg)
      expect(Array.isArray(inventory.warnings)).toBe(true)
    })

    it('paths 字段非空', async () => {
      const pkg = minimalPkg({
        dependencies: { lodash: '^4.17.21' },
      })

      const inventory = await buildInventory('/nonexistent', pkg)
      for (const entry of inventory.entries) {
        expect(entry.paths.length).toBeGreaterThan(0)
      }
    })
  })
})
