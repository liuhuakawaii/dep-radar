import { describe, expect, it } from 'vitest'
import type { DependencyEntry } from '../types/inventory.js'
import type { ReachabilityResult } from './reachability.js'
import { detectHygieneIssues } from './dependencyHygiene.js'

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

function makeReach(
  packageName: string,
  bucket: 'src' | 'test' | 'config' | 'script',
  count = 1,
): ReachabilityResult {
  return {
    packageName,
    importers: Array.from({ length: count }, (_, i) => ({
      file: `src/file${i}.ts`,
      line: 1,
      specifier: packageName,
      importKind: 'import' as const,
    })),
    sourceBucket: bucket,
    reachableFromRuntimeEntry: bucket === 'src',
    importCount: count,
  }
}

describe('detectHygieneIssues', () => {
  it('无 import 证据的 direct dep → unused-direct', () => {
    const issues = detectHygieneIssues([makeEntry('lodash')], [])
    expect(issues).toHaveLength(1)
    expect(issues[0]!.type).toBe('unused-direct')
    expect(issues[0]!.packageName).toBe('lodash')
  })

  it('有 src import 的 dep 不标记为 unused', () => {
    const issues = detectHygieneIssues(
      [makeEntry('react')],
      [makeReach('react', 'src')],
    )
    expect(issues).toHaveLength(0)
  })

  it('声明在 dependencies 但只在 test 中使用 → misplaced', () => {
    const issues = detectHygieneIssues(
      [makeEntry('vitest')],
      [makeReach('vitest', 'test')],
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]!.type).toBe('misplaced-dependency')
    expect(issues[0]!.suggestedLocation).toBe('devDependencies')
  })

  it('ignore 列表中的包不检测', () => {
    const issues = detectHygieneIssues([makeEntry('lodash')], [], {
      ignore: ['lodash'],
    })
    expect(issues).toHaveLength(0)
  })

  it('allowDynamic 列表中的包不标记为 unused', () => {
    const issues = detectHygieneIssues([makeEntry('lodash')], [], {
      allowDynamic: ['lodash'],
    })
    expect(issues).toHaveLength(0)
  })

  it('空列表返回空', () => {
    expect(detectHygieneIssues([], [])).toEqual([])
  })
})
