import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.FORCE_COLOR = '0'

const { explainCommand } = await import('./explain.js')
const { EXIT_CODES } = await import('../utils/exitCode.js')

describe('explainCommand', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dep-radar-explain-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writePkg(
    deps: Record<string, string> = {},
    devDeps: Record<string, string> = {},
  ) {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        dependencies: deps,
        devDependencies: devDeps,
      }),
      'utf-8',
    )
  }

  it('package.json 不存在时返回 ERROR', async () => {
    const code = await explainCommand('react', dir)
    expect(code).toBe(EXIT_CODES.ERROR)
  })

  it('未找到的包名应返回 ERROR', async () => {
    writePkg({ react: '^18.0.0' })
    const code = await explainCommand('nonexistent', dir, { format: 'json' })
    expect(code).toBe(EXIT_CODES.ERROR)
  })

  it('直接依赖应显示声明位置和 isDirect=true', async () => {
    writePkg({ react: '^18.0.0' })

    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true)
    try {
      const code = await explainCommand('react', dir, { format: 'json' })
      expect(code).toBe(EXIT_CODES.OK)

      const output = writeSpy.mock.calls.map(c => String(c[0])).join('')
      const result = JSON.parse(output)
      expect(result.packageName).toBe('react')
      expect(result.isDirect).toBe(true)
      expect(result.declaredIn).toBe('dependencies')
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('默认不包含 devDependency', async () => {
    writePkg({}, { vitest: '^1.0.0' })

    const code = await explainCommand('vitest', dir, { format: 'json' })
    expect(code).toBe(EXIT_CODES.ERROR)
  })

  it('--include-dev 时 devDependency 应显示 declaredIn=devDependencies', async () => {
    writePkg({}, { vitest: '^1.0.0' })

    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true)
    try {
      const code = await explainCommand('vitest', dir, {
        format: 'json',
        includeDev: true,
      })
      expect(code).toBe(EXIT_CODES.OK)

      const output = writeSpy.mock.calls.map(c => String(c[0])).join('')
      const result = JSON.parse(output)
      expect(result.declaredIn).toBe('devDependencies')
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('非法 format 应返回 ERROR', async () => {
    writePkg({ react: '^18.0.0' })
    const code = await explainCommand('react', dir, { format: 'yaml' as never })
    expect(code).toBe(EXIT_CODES.ERROR)
  })

  it('terminal 格式应输出到 stdout', async () => {
    writePkg({ react: '^18.0.0' })

    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true)
    try {
      const code = await explainCommand('react', dir, { format: 'terminal' })
      expect(code).toBe(EXIT_CODES.OK)

      const output = writeSpy.mock.calls.map(c => String(c[0])).join('')
      expect(output).toContain('react')
      expect(output).toContain('dependencies')
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('JSON 格式应输出合法 JSON', async () => {
    writePkg({ lodash: '^4.0.0' })

    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true)
    try {
      await explainCommand('lodash', dir, { format: 'json' })
      const output = writeSpy.mock.calls.map(c => String(c[0])).join('')
      const result = JSON.parse(output)
      expect(result).toHaveProperty('packageName')
      expect(result).toHaveProperty('isDirect')
      expect(result).toHaveProperty('declaredIn')
      expect(result).toHaveProperty('isImported')
      expect(result).toHaveProperty('canRemove')
      expect(result).toHaveProperty('suggestedAction')
    } finally {
      writeSpy.mockRestore()
    }
  })
})
