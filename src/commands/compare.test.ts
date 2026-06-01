import { beforeAll, describe, expect, it } from 'vitest'

import type { BundleInfo } from '../types/analysis.js'

import {
  diffBundles,
  renderCompareTable,
  type CompareResult,
} from './compare.js'

beforeAll(() => {
  process.env.FORCE_COLOR = '0'
})

// =====================================================================
// 工具
// =====================================================================

function bundle(
  name: string,
  version: string,
  gzip: number,
  size?: number,
): BundleInfo {
  return {
    name,
    version,
    size: size ?? gzip * 3,
    gzip,
    dependencyCount: 0,
    hasJSModule: false,
    hasJSNext: false,
    source: 'pkg-size',
  }
}

// =====================================================================
// diffBundles
// =====================================================================

describe('diffBundles', () => {
  it('两个空数组应返回全零结果', () => {
    const r = diffBundles([], [])
    expect(r.added).toHaveLength(0)
    expect(r.removed).toHaveLength(0)
    expect(r.changed).toHaveLength(0)
    expect(r.totalSizeDelta).toBe(0)
    expect(r.totalGzipDelta).toBe(0)
  })

  it('B 新增的包应出现在 added 中', () => {
    const a = [bundle('react', '18.3.1', 5000)]
    const b = [
      bundle('react', '18.3.1', 5000),
      bundle('lodash', '4.17.21', 25000),
    ]
    const r = diffBundles(a, b)
    expect(r.added).toHaveLength(1)
    expect(r.added[0]!.name).toBe('lodash')
    expect(r.added[0]!.gzip).toBe(25000)
    expect(r.removed).toHaveLength(0)
    expect(r.changed).toHaveLength(0)
    expect(r.totalGzipDelta).toBe(25000)
  })

  it('A 中有 B 中无的包应出现在 removed 中', () => {
    const a = [
      bundle('react', '18.3.1', 5000),
      bundle('moment', '2.30.1', 70000),
    ]
    const b = [bundle('react', '18.3.1', 5000)]
    const r = diffBundles(a, b)
    expect(r.removed).toHaveLength(1)
    expect(r.removed[0]!.name).toBe('moment')
    expect(r.totalGzipDelta).toBe(-70000)
  })

  it('版本变更的包应出现在 changed 中', () => {
    const a = [bundle('react', '18.2.0', 5000)]
    const b = [bundle('react', '18.3.1', 5200)]
    const r = diffBundles(a, b)
    expect(r.changed).toHaveLength(1)
    expect(r.changed[0]).toMatchObject({
      name: 'react',
      fromVersion: '18.2.0',
      toVersion: '18.3.1',
      gzipDelta: 200,
      sizeDelta: 600,
    })
    expect(r.totalGzipDelta).toBe(200)
  })

  it('版本相同但体积不同时也应视为变更', () => {
    const a = [bundle('react', '18.3.1', 5000)]
    const b = [bundle('react', '18.3.1', 5500)]
    const r = diffBundles(a, b)
    expect(r.changed).toHaveLength(1)
    expect(r.changed[0]!.gzipDelta).toBe(500)
  })

  it('版本和体积都相同时不应出现在 diff 中', () => {
    const a = [bundle('react', '18.3.1', 5000)]
    const b = [bundle('react', '18.3.1', 5000)]
    const r = diffBundles(a, b)
    expect(r.added).toHaveLength(0)
    expect(r.removed).toHaveLength(0)
    expect(r.changed).toHaveLength(0)
  })

  it('混合场景：同时有新增、移除和变更', () => {
    const a = [
      bundle('react', '18.2.0', 5000),
      bundle('moment', '2.30.1', 70000),
      bundle('lodash', '4.17.20', 25000),
    ]
    const b = [
      bundle('react', '18.3.1', 5200),
      bundle('dayjs', '1.11.10', 2000),
      bundle('lodash', '4.17.21', 25000),
    ]
    const r = diffBundles(a, b)
    // moment 移除，dayjs 新增，lodash 版本变更（体积相同但版本不同），react 版本+体积变更
    expect(r.added.map(e => e.name)).toContain('dayjs')
    expect(r.removed.map(e => e.name)).toContain('moment')
    // lodash 版本不同 → 出现在 changed（即使 size/gzip 相同）
    expect(r.changed.map(e => e.name).sort()).toEqual(['lodash', 'react'])
    expect(r.totalGzipDelta).toBe(200 + 0 + 2000 - 70000) // react delta + lodash delta + dayjs - moment
  })

  it('新增应按 gzip 降序排列', () => {
    const a: BundleInfo[] = []
    const b = [
      bundle('small', '1.0.0', 100),
      bundle('large', '1.0.0', 50000),
      bundle('medium', '1.0.0', 5000),
    ]
    const r = diffBundles(a, b)
    expect(r.added.map(e => e.name)).toEqual(['large', 'medium', 'small'])
  })

  it('移除应按 gzip 降序排列', () => {
    const a = [bundle('small', '1.0.0', 100), bundle('large', '1.0.0', 50000)]
    const b: BundleInfo[] = []
    const r = diffBundles(a, b)
    expect(r.removed.map(e => e.name)).toEqual(['large', 'small'])
  })

  it('变更应按 |gzipDelta| 降序排列', () => {
    const a = [
      bundle('a', '1.0.0', 100),
      bundle('b', '1.0.0', 50000),
      bundle('c', '1.0.0', 5000),
    ]
    const b = [
      bundle('a', '2.0.0', 200),
      bundle('b', '2.0.0', 49000),
      bundle('c', '2.0.0', 7000),
    ]
    const r = diffBundles(a, b)
    // |b delta|=1000, |c delta|=2000, |a delta|=100
    expect(r.changed.map(e => e.name)).toEqual(['c', 'b', 'a'])
  })

  it('totalSizeDelta 应综合计算新增 - 移除 + 变更', () => {
    const a = [bundle('x', '1.0.0', 1000, 3000)]
    const b = [bundle('x', '2.0.0', 1500, 4500)]
    const r = diffBundles(a, b)
    expect(r.totalSizeDelta).toBe(1500) // 4500 - 3000
    expect(r.totalGzipDelta).toBe(500) // 1500 - 1000
  })
})

// =====================================================================
// renderCompareTable
// =====================================================================

describe('renderCompareTable', () => {
  it('无差异时应显示"无差异"', () => {
    const r: CompareResult = {
      added: [],
      removed: [],
      changed: [],
      totalSizeDelta: 0,
      totalGzipDelta: 0,
    }
    const out = renderCompareTable(r, 'old-app', 'new-app')
    expect(out).toContain('old-app → new-app')
    expect(out).toContain('无差异')
  })

  it('新增包应在输出中标注 + 新增', () => {
    const r: CompareResult = {
      added: [{ name: 'lodash', version: '4.17.21', size: 72000, gzip: 25000 }],
      removed: [],
      changed: [],
      totalSizeDelta: 72000,
      totalGzipDelta: 25000,
    }
    const out = renderCompareTable(r, 'a', 'b')
    expect(out).toContain('新增')
    expect(out).toContain('lodash')
    expect(out).toContain('汇总')
    expect(out).toContain('+1 新增')
  })

  it('移除包应在输出中标注 - 移除', () => {
    const r: CompareResult = {
      added: [],
      removed: [
        { name: 'moment', version: '2.30.1', size: 300000, gzip: 70000 },
      ],
      changed: [],
      totalSizeDelta: -300000,
      totalGzipDelta: -70000,
    }
    const out = renderCompareTable(r, 'a', 'b')
    expect(out).toContain('移除')
    expect(out).toContain('moment')
    expect(out).toContain('-1 移除')
  })

  it('变更包应在输出中标注 ~ 变更', () => {
    const r: CompareResult = {
      added: [],
      removed: [],
      changed: [
        {
          name: 'react',
          fromVersion: '18.2.0',
          toVersion: '18.3.1',
          fromSize: 15000,
          toSize: 15600,
          sizeDelta: 600,
          gzipDelta: 200,
        },
      ],
      totalSizeDelta: 600,
      totalGzipDelta: 200,
    }
    const out = renderCompareTable(r, 'a', 'b')
    expect(out).toContain('变更')
    expect(out).toContain('react')
    expect(out).toContain('18.2.0 → 18.3.1')
    expect(out).toContain('~1 变更')
  })

  it('版本相同但体积不同时仍显示版本号（无箭头）', () => {
    const r: CompareResult = {
      added: [],
      removed: [],
      changed: [
        {
          name: 'react',
          fromVersion: '18.3.1',
          toVersion: '18.3.1',
          fromSize: 15000,
          toSize: 16000,
          sizeDelta: 1000,
          gzipDelta: 300,
        },
      ],
      totalSizeDelta: 1000,
      totalGzipDelta: 300,
    }
    const out = renderCompareTable(r, 'a', 'b')
    // 版本相同时表格中不应有箭头（标题中的 "a → b" 不算）
    const tableLines = out.split('\n').filter(l => l.includes('react'))
    expect(tableLines[0]).toContain('18.3.1')
    expect(tableLines[0]).not.toContain('→')
  })

  it('gzip 差异为正时应显示 + 前缀', () => {
    const r: CompareResult = {
      added: [{ name: 'x', version: '1.0.0', size: 3000, gzip: 1000 }],
      removed: [],
      changed: [],
      totalSizeDelta: 3000,
      totalGzipDelta: 1000,
    }
    const out = renderCompareTable(r, 'a', 'b')
    expect(out).toContain('+1000 B')
  })

  it('gzip 差异为负时应显示 - 前缀', () => {
    const r: CompareResult = {
      added: [],
      removed: [{ name: 'x', version: '1.0.0', size: 3000, gzip: 1000 }],
      changed: [],
      totalSizeDelta: -3000,
      totalGzipDelta: -1000,
    }
    const out = renderCompareTable(r, 'a', 'b')
    expect(out).toContain('-1000 B')
  })
})
