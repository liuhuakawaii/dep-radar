import { describe, expect, it } from 'vitest'

import { checkExpoCompatibility, detectProject } from './projectDetector.js'

describe('detectProject', () => {
  it('有 expo 依赖 → Expo 项目', () => {
    const result = detectProject({
      name: 'app',
      version: '1.0.0',
      dependencies: { expo: '~52.0.0', react: '18.3.1' },
    })
    expect(result.type).toBe('expo')
    expect(result.framework).toBe('Expo')
    expect(result.reactVersion).toBe('18.3.1')
  })

  it('有 react-native 无 expo → React Native', () => {
    const result = detectProject({
      name: 'app',
      version: '1.0.0',
      dependencies: { 'react-native': '0.76.0', react: '18.3.1' },
    })
    expect(result.type).toBe('react-native')
    expect(result.framework).toBe('React Native')
  })

  it('有 next → Next.js', () => {
    const result = detectProject({
      name: 'app',
      version: '1.0.0',
      dependencies: { next: '14.2.0', react: '18.3.1' },
    })
    expect(result.type).toBe('next')
    expect(result.framework).toBe('Next.js')
  })

  it('有 vite 在 devDependencies → Vite', () => {
    const result = detectProject({
      name: 'app',
      version: '1.0.0',
      devDependencies: { vite: '^5.0.0' },
    })
    expect(result.type).toBe('vite')
    expect(result.framework).toBe('Vite')
  })

  it('无框架依赖 → unknown', () => {
    const result = detectProject({
      name: 'lib',
      version: '1.0.0',
      dependencies: { lodash: '^4.0.0' },
    })
    expect(result.type).toBe('unknown')
  })

  it('版本号应去掉范围前缀', () => {
    const result = detectProject({
      name: 'app',
      version: '1.0.0',
      dependencies: { expo: '~52.0.0' },
    })
    expect(result.frameworkVersion).toBe('52.0.0')
  })
})

describe('checkExpoCompatibility', () => {
  it('兼容版本返回空数组', () => {
    const info = detectProject({
      name: 'app',
      version: '1.0.0',
      dependencies: { expo: '~52.0.0', react: '18.3.1' },
    })
    const issues = checkExpoCompatibility(info)
    expect(issues).toEqual([])
  })

  it('不兼容 react 版本返回问题', () => {
    const info = detectProject({
      name: 'app',
      version: '1.0.0',
      dependencies: { expo: '~52.0.0', react: '18.2.0' },
    })
    const issues = checkExpoCompatibility(info)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.name).toBe('react')
    expect(issues[0]!.actual).toBe('18.2.0')
    expect(issues[0]!.expected).toContain('18.3.1')
  })

  it('非 Expo 项目返回空数组', () => {
    const info = detectProject({
      name: 'app',
      version: '1.0.0',
      dependencies: { next: '14.0.0', react: '18.2.0' },
    })
    const issues = checkExpoCompatibility(info)
    expect(issues).toEqual([])
  })

  it('未知 Expo SDK 版本返回空数组', () => {
    const info = detectProject({
      name: 'app',
      version: '1.0.0',
      dependencies: { expo: '~99.0.0', react: '18.2.0' },
    })
    const issues = checkExpoCompatibility(info)
    expect(issues).toEqual([])
  })
})
