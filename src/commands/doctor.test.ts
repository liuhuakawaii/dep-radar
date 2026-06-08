import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.FORCE_COLOR = '0'

const { doctorCommand } = await import('./doctor.js')
const { EXIT_CODES } = await import('../utils/exitCode.js')

describe('doctorCommand', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dep-radar-doctor-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writePkg(extra: Record<string, unknown> = {}) {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', ...extra }),
      'utf-8',
    )
  }

  it('package.json 不存在时返回 ERROR', async () => {
    const code = await doctorCommand(dir)
    expect(code).toBe(EXIT_CODES.ERROR)
  })

  it('正常项目应返回 OK', async () => {
    writePkg()
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '', 'utf-8')
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '.modules.yaml'), '', 'utf-8')

    const code = await doctorCommand(dir)
    expect(code).toBe(EXIT_CODES.OK)
  })

  it('JSON 格式应输出合法 JSON', async () => {
    writePkg()

    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true)
    try {
      const code = await doctorCommand(dir, { format: 'json' })
      expect(code).toBe(EXIT_CODES.OK)

      const output = writeSpy.mock.calls.map(c => String(c[0])).join('')
      const result = JSON.parse(output)
      expect(result).toHaveProperty('project', 'demo')
      expect(result).toHaveProperty('projectInfo')
      expect(result).toHaveProperty('checks')
      expect(result).toHaveProperty('summary')
      expect(result.summary).toHaveProperty('passed')
      expect(result.summary).toHaveProperty('warned')
      expect(result.summary).toHaveProperty('failed')
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('terminal 格式应输出到 stdout', async () => {
    writePkg()

    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true)
    try {
      const code = await doctorCommand(dir, { format: 'terminal' })
      expect(code).toBe(EXIT_CODES.OK)

      const output = writeSpy.mock.calls.map(c => String(c[0])).join('')
      expect(output).toContain('Doctor')
      expect(output).toContain('demo')
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('非法 format 应返回 ERROR', async () => {
    writePkg()
    const code = await doctorCommand(dir, { format: 'markdown' as never })
    expect(code).toBe(EXIT_CODES.ERROR)
  })

  it('Expo 项目应检测到框架类型', async () => {
    writePkg({ dependencies: { expo: '~52.0.0', react: '18.3.1' } })

    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true)
    try {
      await doctorCommand(dir, { format: 'terminal' })
      const output = writeSpy.mock.calls.map(c => String(c[0])).join('')
      expect(output).toContain('Expo')
    } finally {
      writeSpy.mockRestore()
    }
  })
})
