import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConfigError } from '../errors/index.js'
import { loadUserConfig } from './loader.js'

describe('loadUserConfig', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dep-radar-config-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('找不到任何配置文件时返回空对象', async () => {
    // 临时目录里只放一个 package.json（不含 dep-radar 字段），避免向上查找命中本项目根目录的配置
    writeFileSync(join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}')
    const got = await loadUserConfig(dir)
    expect(got).toEqual({})
  })

  it('应解析 .deprdarrc.json', async () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}')
    writeFileSync(
      join(dir, '.dep-radarrc.json'),
      JSON.stringify({
        budget: { totalGzip: 500_000 },
        ignore: ['@internal/*'],
      }),
    )
    const got = await loadUserConfig(dir)
    expect(got.budget?.totalGzip).toBe(500_000)
    expect(got.ignore).toEqual(['@internal/*'])
  })

  it('应解析 dep-radar.config.cjs', async () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}')
    writeFileSync(
      join(dir, 'dep-radar.config.cjs'),
      `module.exports = { cacheTTL: 7200, dataSource: ['pkg-size', 'bundlephobia'] }`,
    )
    const got = await loadUserConfig(dir)
    expect(got.cacheTTL).toBe(7200)
    expect(got.dataSource).toEqual(['pkg-size', 'bundlephobia'])
  })

  it('应读取 package.json 的 "dep-radar" 字段', async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'x',
        version: '1.0.0',
        'dep-radar': { registry: 'https://my-registry.example.com' },
      }),
    )
    const got = await loadUserConfig(dir)
    expect(got.registry).toBe('https://my-registry.example.com')
  })

  it('JSON 损坏应抛 ConfigError', async () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}')
    writeFileSync(join(dir, '.dep-radarrc.json'), '{ not json')
    await expect(loadUserConfig(dir)).rejects.toBeInstanceOf(ConfigError)
  })

  it('配置文件内容不是对象时抛 ConfigError', async () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}')
    writeFileSync(join(dir, '.dep-radarrc.json'), '"a string"')
    await expect(loadUserConfig(dir)).rejects.toBeInstanceOf(ConfigError)
  })
})
