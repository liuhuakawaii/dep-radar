import { describe, expect, it } from 'vitest'

import type { OptimizationSuggestion } from '../types/analysis.js'
import {
  generateCommands,
  generateExplainHint,
  generateOverrideCommand,
} from './suggestionCommands.js'

function makeSuggestion(
  over: Partial<OptimizationSuggestion> = {},
): OptimizationSuggestion {
  return {
    packageName: 'pkg',
    type: 'replace',
    priority: 'medium',
    description: '建议替换',
    difficulty: 'low',
    breakingChange: false,
    ...over,
  }
}

describe('generateCommands', () => {
  it('deprecated 建议 → remove 命令', () => {
    const result = generateCommands(
      makeSuggestion({ type: 'deprecated', packageName: 'request' }),
      'pnpm',
    )
    expect(result).not.toBeNull()
    expect(result!.action).toBe('remove')
    expect(result!.command).toContain('pnpm remove request')
  })

  it('replace 建议有 alternative → remove + add 命令', () => {
    const result = generateCommands(
      makeSuggestion({
        type: 'replace',
        packageName: 'moment',
        alternative: 'dayjs',
      }),
      'npm',
    )
    expect(result).not.toBeNull()
    expect(result!.command).toContain('npm uninstall moment')
    expect(result!.command).toContain('npm install dayjs')
  })

  it('replace 建议无 alternative → null', () => {
    const result = generateCommands(
      makeSuggestion({ type: 'replace', alternative: undefined }),
      'pnpm',
    )
    expect(result).toBeNull()
  })

  it('upgrade 建议 → update 命令', () => {
    const result = generateCommands(
      makeSuggestion({ type: 'upgrade', packageName: 'axios' }),
      'yarn',
    )
    expect(result).not.toBeNull()
    expect(result!.action).toBe('update')
    expect(result!.command).toContain('yarn upgrade axios')
  })

  it('pnpm/yarn/npm 命令格式正确', () => {
    const s = makeSuggestion({ type: 'remove', packageName: 'lodash' })

    expect(generateCommands(s, 'pnpm')!.command).toBe('pnpm remove lodash')
    expect(generateCommands(s, 'yarn')!.command).toBe('yarn remove lodash')
    expect(generateCommands(s, 'npm')!.command).toBe('npm uninstall lodash')
  })
})

describe('generateOverrideCommand', () => {
  it('pnpm override 格式', () => {
    const result = generateOverrideCommand('semver', '7.5.4', 'pnpm')
    expect(result.command).toBe('pnpm override semver@7.5.4')
    expect(result.action).toBe('override')
  })

  it('npm override 格式', () => {
    const result = generateOverrideCommand('semver', '7.5.4', 'npm')
    expect(result.command).toContain('npm pkg set')
    expect(result.command).toContain('semver')
    expect(result.command).toContain('7.5.4')
  })

  it('yarn resolution 格式', () => {
    const result = generateOverrideCommand('semver', '7.5.4', 'yarn')
    expect(result.command).toBe('yarn set resolution semver@7.5.4')
  })
})

describe('generateExplainHint', () => {
  it('生成 explain 命令提示', () => {
    expect(generateExplainHint('lodash')).toBe('dep-radar explain lodash')
  })
})
