import { describe, expect, it } from 'vitest'

import {
  findWorkspace,
  matchSimpleGlob,
  parseWorkspacesField,
} from './workspace.js'

describe('parseWorkspacesField', () => {
  it('数组格式应直接返回', () => {
    expect(parseWorkspacesField(['packages/*', 'apps/*'])).toEqual([
      'packages/*',
      'apps/*',
    ])
  })

  it('对象格式（packages 字段）应返回 packages 数组', () => {
    expect(
      parseWorkspacesField({ packages: ['packages/*', 'apps/*'] }),
    ).toEqual(['packages/*', 'apps/*'])
  })

  it('无效格式应返回空数组', () => {
    expect(parseWorkspacesField(undefined)).toEqual([])
    expect(parseWorkspacesField(null)).toEqual([])
    expect(parseWorkspacesField('invalid')).toEqual([])
    expect(parseWorkspacesField(123)).toEqual([])
    expect(parseWorkspacesField({})).toEqual([])
    expect(parseWorkspacesField({ packages: 'invalid' })).toEqual([])
  })

  it('数组中应过滤非字符串元素', () => {
    expect(parseWorkspacesField(['packages/*', 123, null, 'apps/*'])).toEqual([
      'packages/*',
      'apps/*',
    ])
  })
})

describe('matchSimpleGlob', () => {
  it('* 应匹配单层目录名', () => {
    expect(matchSimpleGlob('*', 'packages')).toBe(true)
    expect(matchSimpleGlob('*', 'apps')).toBe(true)
  })

  it('* 应匹配单个路径段', () => {
    expect(matchSimpleGlob('*', 'core')).toBe(true)
    expect(matchSimpleGlob('*', 'utils')).toBe(true)
    expect(matchSimpleGlob('*', 'my-package')).toBe(true)
  })

  it('** 应匹配任意深度', () => {
    expect(matchSimpleGlob('**', 'anything')).toBe(true)
    expect(matchSimpleGlob('**', 'a/b/c')).toBe(true)
  })

  it('不匹配时应返回 false', () => {
    expect(matchSimpleGlob('core', 'utils')).toBe(false)
    expect(matchSimpleGlob('packages', 'apps')).toBe(false)
  })

  it('应正确转义特殊字符', () => {
    expect(matchSimpleGlob('@scope/*', '@scope/core')).toBe(true)
    expect(matchSimpleGlob('@scope/*', 'scope/core')).toBe(false)
  })
})

describe('findWorkspace', () => {
  const packages = [
    { name: '@my/core', path: './packages/core', packageJson: {} },
    { name: '@my/utils', path: './packages/utils', packageJson: {} },
    { name: 'app', path: './apps/web', packageJson: {} },
  ]

  it('应按 name 查找', () => {
    expect(findWorkspace(packages, '@my/core')).toEqual(packages[0])
  })

  it('应按 path 查找', () => {
    expect(findWorkspace(packages, './apps/web')).toEqual(packages[2])
  })

  it('应按不带 ./ 前缀的 path 查找', () => {
    expect(findWorkspace(packages, 'apps/web')).toEqual(packages[2])
  })

  it('找不到时应返回 undefined', () => {
    expect(findWorkspace(packages, 'nonexistent')).toBeUndefined()
  })
})
