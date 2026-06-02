import { describe, expect, it } from 'vitest'
import {
  analyzeBuildArtifacts,
  extractPackageFromModulePath,
} from './buildArtifacts.js'

describe('extractPackageFromModulePath', () => {
  it('普通包', () => {
    expect(extractPackageFromModulePath('node_modules/lodash/lodash.js')).toBe(
      'lodash',
    )
  })
  it('scoped 包', () => {
    expect(
      extractPackageFromModulePath('node_modules/@babel/core/lib/index.js'),
    ).toBe('@babel/core')
  })
  it('相对路径返回 null', () => {
    expect(extractPackageFromModulePath('./src/App.tsx')).toBeNull()
  })
  it('Windows 路径', () => {
    expect(extractPackageFromModulePath('node_modules\\react\\index.js')).toBe(
      'react',
    )
  })
})

describe('analyzeBuildArtifacts', () => {
  it('无输入返回 source=none', async () => {
    const result = await analyzeBuildArtifacts('/nonexistent')
    expect(result.source).toBe('none')
    expect(result.assets).toEqual([])
  })
  it('stats 文件不存在返回 warnings', async () => {
    const result = await analyzeBuildArtifacts('/nonexistent', {
      statsFile: 'missing.json',
    })
    expect(result.source).toBe('none')
    expect(result.warnings.some(w => w.includes('不存在'))).toBe(true)
  })
})
