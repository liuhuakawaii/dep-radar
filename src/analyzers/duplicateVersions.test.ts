import { describe, expect, it } from 'vitest'
import type { DependencyEntry } from '../types/inventory.js'
import { detectDuplicateVersions } from './duplicateVersions.js'

function makeEntry(
  name: string,
  packageName: string,
  version: string,
  overrides: Partial<DependencyEntry> = {},
): DependencyEntry {
  return {
    name,
    packageName,
    requestedSpec: `^${version}`,
    resolvedVersion: version,
    declaredIn: 'dependencies',
    isDirect: true,
    isAlias: false,
    resolvedFrom: 'package-json-fallback',
    confidence: 'low',
    paths: [[name]],
    ...overrides,
  }
}

describe('detectDuplicateVersions', () => {
  it('单版本不报告', () => {
    const entries = [makeEntry('react', 'react', '18.2.0')]
    expect(detectDuplicateVersions(entries)).toEqual([])
  })

  it('多版本并存应报告', () => {
    const entries = [
      makeEntry('three', 'three', '0.165.0'),
      makeEntry('three149', 'three', '0.149.0', {
        isAlias: true,
        aliasOf: { name: 'three', spec: '0.149.0' },
      }),
      makeEntry('stats-gl', 'three', '0.170.0', {
        isDirect: false,
        declaredIn: 'transitive',
      }),
    ]
    const result = detectDuplicateVersions(entries)
    expect(result).toHaveLength(1)
    expect(result[0]!.packageName).toBe('three')
    expect(result[0]!.versions).toHaveLength(3)
    expect(result[0]!.aliases).toContain('three149')
    expect(result[0]!.isLargeLibrary).toBe(true)
  })

  it('大型库标记正确', () => {
    const entries = [
      makeEntry('react', 'react', '18.0.0'),
      makeEntry('react-17', 'react', '17.0.2', { isAlias: true }),
    ]
    const result = detectDuplicateVersions(entries)
    expect(result[0]!.isLargeLibrary).toBe(true)
  })

  it('非大型库标记正确', () => {
    const entries = [
      makeEntry('some-pkg', 'some-pkg', '1.0.0'),
      makeEntry('some-pkg-old', 'some-pkg', '0.9.0', { isAlias: true }),
    ]
    const result = detectDuplicateVersions(entries)
    expect(result[0]!.isLargeLibrary).toBe(false)
  })

  it('空列表返回空', () => {
    expect(detectDuplicateVersions([])).toEqual([])
  })
})
