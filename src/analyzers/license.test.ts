import { describe, expect, it, vi } from 'vitest'

import type { PackageJson } from '../types/package.js'

import {
  analyzeLicenses,
  normalizeLicenseField,
  parseLicenseCategory,
  type LicenseFetcher,
} from './license.js'

// =====================================================================
// 工具
// =====================================================================

function makeFetcher(
  responses: Record<string, string | undefined>,
  fail: Set<string> = new Set(),
): LicenseFetcher {
  return {
    getLicense: vi.fn(async (name: string) => {
      if (fail.has(name)) throw new Error(`fetch failed for ${name}`)
      return responses[name]
    }),
  }
}

function pkg(
  deps: Record<string, string> = {},
  dev: Record<string, string> = {},
): PackageJson {
  return {
    name: 'demo',
    version: '1.0.0',
    dependencies: deps,
    devDependencies: dev,
  }
}

// =====================================================================
// parseLicenseCategory
// =====================================================================

describe('parseLicenseCategory', () => {
  it('单一标识：MIT → permissive', () => {
    expect(parseLicenseCategory('MIT')).toBe('permissive')
  })

  it('单一标识：GPL-3.0 → strong-copyleft', () => {
    expect(parseLicenseCategory('GPL-3.0')).toBe('strong-copyleft')
  })

  it('UNLICENSED → proprietary', () => {
    expect(parseLicenseCategory('UNLICENSED')).toBe('proprietary')
  })

  it('未知 SPDX 标识 → unknown', () => {
    expect(parseLicenseCategory('SOME-UNKNOWN-LICENSE-1.0')).toBe('unknown')
  })

  it('非法 SPDX 表达式（自由文本）→ unknown', () => {
    expect(parseLicenseCategory('see LICENSE file')).toBe('unknown')
  })

  it('OR 表达式取最宽松：(MIT OR GPL-3.0) → permissive', () => {
    expect(parseLicenseCategory('(MIT OR GPL-3.0)')).toBe('permissive')
  })

  it('OR 表达式：(LGPL-3.0 OR MPL-2.0) → weak-copyleft', () => {
    expect(parseLicenseCategory('(LGPL-3.0 OR MPL-2.0)')).toBe('weak-copyleft')
  })

  it('AND 表达式取最严格：(MIT AND GPL-3.0) → strong-copyleft', () => {
    expect(parseLicenseCategory('(MIT AND GPL-3.0)')).toBe('strong-copyleft')
  })

  it('嵌套：((MIT OR ISC) AND Apache-2.0) → permissive', () => {
    expect(parseLicenseCategory('((MIT OR ISC) AND Apache-2.0)')).toBe(
      'permissive',
    )
  })

  it('嵌套：(MIT AND (GPL-3.0 OR LGPL-3.0)) → weak-copyleft', () => {
    // 内部 OR 取 LGPL-3.0 (weak); 与 MIT AND → 取较严 = weak-copyleft
    expect(parseLicenseCategory('(MIT AND (GPL-3.0 OR LGPL-3.0))')).toBe(
      'weak-copyleft',
    )
  })

  it('GPL-3.0-only / GPL-3.0-or-later 等变体也应识别', () => {
    expect(parseLicenseCategory('GPL-3.0-only')).toBe('strong-copyleft')
    expect(parseLicenseCategory('LGPL-2.1-or-later')).toBe('weak-copyleft')
  })
})

// =====================================================================
// normalizeLicenseField
// =====================================================================

describe('normalizeLicenseField', () => {
  it.each([
    ['MIT', 'MIT'],
    [{ type: 'MIT' }, 'MIT'],
    [undefined, undefined],
  ])('%j → %j', (input, expected) => {
    expect(
      normalizeLicenseField(input as string | { type: string } | undefined),
    ).toBe(expected)
  })

  it('对象但 type 缺失 → undefined', () => {
    expect(
      normalizeLicenseField({} as unknown as { type: string }),
    ).toBeUndefined()
  })
})

// =====================================================================
// analyzeLicenses 集成
// =====================================================================

describe('analyzeLicenses', () => {
  it('happy path：MIT 包评级为 low，无 conflict 文案', async () => {
    const fetcher = makeFetcher({ react: 'MIT' })
    const r = await analyzeLicenses(pkg({ react: '^18' }), fetcher)
    expect(r.licenses).toHaveLength(1)
    expect(r.licenses[0]).toMatchObject({
      name: 'react',
      license: 'MIT',
      licenseType: 'permissive',
      risk: 'low',
    })
    expect(r.licenses[0]!.conflict).toBeUndefined()
  })

  it('GPL 包应被评级为 high，并返回项目级冲突规则', async () => {
    const fetcher = makeFetcher({ a: 'MIT', b: 'GPL-3.0' })
    const r = await analyzeLicenses(pkg({ a: '1', b: '1' }), fetcher)
    expect(r.licenses.find(l => l.name === 'b')!.risk).toBe('high')
    expect(r.projectConflicts).toHaveLength(1)
    expect(r.projectConflicts[0]!.severity).toBe('high')
    expect(r.projectConflicts[0]!.message).toMatch(/Copyleft/)
  })

  it('未声明 license → unknown + 提示人工核实', async () => {
    const fetcher = makeFetcher({ x: undefined })
    const r = await analyzeLicenses(pkg({ x: '1' }), fetcher)
    expect(r.licenses[0]).toMatchObject({
      license: 'UNKNOWN',
      licenseType: 'unknown',
      risk: 'medium',
    })
    expect(r.licenses[0]!.conflict).toMatch(/人工核实/)
    expect(r.projectConflicts.map(c => c.severity)).toContain('medium')
  })

  it('UNLICENSED 应触发 proprietary 冲突规则', async () => {
    const fetcher = makeFetcher({ proprietary: 'UNLICENSED' })
    const r = await analyzeLicenses(pkg({ proprietary: '1' }), fetcher)
    expect(r.licenses[0]!.licenseType).toBe('proprietary')
    expect(r.projectConflicts.some(c => c.message.includes('私有'))).toBe(true)
  })

  it('全部 permissive → 无 projectConflicts', async () => {
    const fetcher = makeFetcher({ a: 'MIT', b: 'Apache-2.0', c: 'ISC' })
    const r = await analyzeLicenses(pkg({ a: '1', b: '1', c: '1' }), fetcher)
    expect(r.projectConflicts).toHaveLength(0)
  })

  it('单包 fetch 失败 → 加入 skipped，不影响其他', async () => {
    const fetcher = makeFetcher({ ok: 'MIT', bad: 'MIT' }, new Set(['bad']))
    const r = await analyzeLicenses(pkg({ ok: '1', bad: '1' }), fetcher)
    expect(r.licenses.map(l => l.name)).toEqual(['ok'])
    expect(r.skipped).toEqual([{ name: 'bad', reason: 'fetch failed for bad' }])
  })

  it('includeDev=true 时应包含 devDependencies', async () => {
    const fetcher = makeFetcher({ a: 'MIT', b: 'MIT' })
    const r = await analyzeLicenses(pkg({ a: '1' }, { b: '1' }), fetcher, {
      includeDev: true,
    })
    expect(r.licenses.map(l => l.name).sort()).toEqual(['a', 'b'])
  })

  it('ignore 模式应过滤匹配包', async () => {
    const fetcher = makeFetcher({
      react: 'MIT',
      '@internal/a': 'UNLICENSED',
      '@internal/b': 'UNLICENSED',
    })
    const r = await analyzeLicenses(
      pkg({ react: '1', '@internal/a': '1', '@internal/b': '1' }),
      fetcher,
      { ignore: ['@internal/*'] },
    )
    expect(r.licenses.map(l => l.name)).toEqual(['react'])
    // 被忽略的包不该触发冲突规则
    expect(r.projectConflicts).toHaveLength(0)
  })

  it('SPDX 复合表达式应正确分类：(MIT OR Apache-2.0) → low risk', async () => {
    const fetcher = makeFetcher({ x: '(MIT OR Apache-2.0)' })
    const r = await analyzeLicenses(pkg({ x: '1' }), fetcher)
    expect(r.licenses[0]!.risk).toBe('low')
    expect(r.licenses[0]!.licenseType).toBe('permissive')
  })
})
