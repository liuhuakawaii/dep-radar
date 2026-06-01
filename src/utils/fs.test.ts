import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConfigError, PackageNotFoundError } from '../errors/index.js'
import { findProjectRoot, readPackageJson } from './fs.js'

describe('readPackageJson', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dep-radar-fs-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('应该正确解析合法的 package.json', async () => {
    const pkg = {
      name: 'demo',
      version: '1.0.0',
      dependencies: { lodash: '^4' },
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg), 'utf-8')
    const got = await readPackageJson(dir)
    expect(got.name).toBe('demo')
    expect(got.dependencies?.lodash).toBe('^4')
  })

  it('文件不存在应该抛 PackageNotFoundError', async () => {
    await expect(readPackageJson(dir)).rejects.toBeInstanceOf(
      PackageNotFoundError,
    )
  })

  it('JSON 不合法应该抛 ConfigError', async () => {
    writeFileSync(join(dir, 'package.json'), '{ not-json', 'utf-8')
    await expect(readPackageJson(dir)).rejects.toBeInstanceOf(ConfigError)
  })
})

describe('findProjectRoot', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dep-radar-root-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('从子目录向上能找到含 package.json 的根', async () => {
    writeFileSync(join(dir, 'package.json'), '{}', 'utf-8')
    const sub = join(dir, 'a', 'b', 'c')
    mkdirSync(sub, { recursive: true })
    const root = await findProjectRoot(sub)
    expect(root).toBe(dir)
  })

  it('起始目录本身就有 package.json 时直接返回', async () => {
    writeFileSync(join(dir, 'package.json'), '{}', 'utf-8')
    const root = await findProjectRoot(dir)
    expect(root).toBe(dir)
  })

  // 注：findProjectRoot 在向上查找"找不到"时会一直走到文件系统根，
  // 这个分支无法在不 mock fs 的情况下做可靠测试（取决于运行环境上层目录是否
  // 含 package.json），暂留 happy path 覆盖。findProjectRoot 的负向路径
  // 由 readPackageJson 的"文件不存在抛错"间接保护。
})
