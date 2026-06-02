import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectPackageManager, PM_COMMANDS } from './packageManager.js'

describe('detectPackageManager', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dep-radar-pm-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('存在 pnpm-lock.yaml 时识别为 pnpm', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
    expect(detectPackageManager(dir)).toBe('pnpm')
  })

  it('存在 yarn.lock 时识别为 yarn', () => {
    writeFileSync(join(dir, 'yarn.lock'), '')
    expect(detectPackageManager(dir)).toBe('yarn')
  })

  it('pnpm 优先级高于 yarn（pnpm-lock 和 yarn.lock 同时存在）', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
    writeFileSync(join(dir, 'yarn.lock'), '')
    expect(detectPackageManager(dir)).toBe('pnpm')
  })

  it('存在 package-lock.json 时识别为 npm', () => {
    writeFileSync(join(dir, 'package-lock.json'), '{}')
    expect(detectPackageManager(dir)).toBe('npm')
  })

  it('无 lock 文件时回退到 npm', () => {
    expect(detectPackageManager(dir)).toBe('npm')
  })
})

describe('PM_COMMANDS', () => {
  it('为三种 PM 都提供 list 与 audit 命令', () => {
    for (const pm of ['npm', 'pnpm', 'yarn'] as const) {
      expect(PM_COMMANDS[pm].list.cmd).toBeTruthy()
      expect(Array.isArray(PM_COMMANDS[pm].list.args)).toBe(true)
      expect(PM_COMMANDS[pm].audit.cmd).toBeTruthy()
      expect(Array.isArray(PM_COMMANDS[pm].audit.args)).toBe(true)
    }
  })

  it('所有 audit 命令都输出 JSON（便于解析）', () => {
    for (const pm of ['npm', 'pnpm', 'yarn'] as const) {
      expect(PM_COMMANDS[pm].audit.args).toContain('--json')
    }
  })
})
