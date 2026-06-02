import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runDoctorChecks } from './doctorChecks.js'

describe('runDoctorChecks', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dep-radar-doctor-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('有 pnpm-lock.yaml 时 lock-file 检查通过', async () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '', 'utf-8')
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'test', version: '1.0.0' }),
    )

    const results = await runDoctorChecks(dir)
    const lockCheck = results.find(r => r.id === 'lock-file')
    expect(lockCheck?.status).toBe('pass')
  })

  it('多个 lock 文件时应 warn', async () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '', 'utf-8')
    writeFileSync(join(dir, 'package-lock.json'), '{}', 'utf-8')
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'test', version: '1.0.0' }),
    )

    const results = await runDoctorChecks(dir)
    const multiCheck = results.find(r => r.id === 'multiple-locks')
    expect(multiCheck?.status).toBe('warn')
    expect(multiCheck?.message).toContain('多个 lock 文件')
  })

  it('node_modules 不存在时应 warn', async () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '', 'utf-8')
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'test', version: '1.0.0' }),
    )

    const results = await runDoctorChecks(dir)
    const nmCheck = results.find(r => r.id === 'node-modules')
    expect(nmCheck?.status).toBe('warn')
    expect(nmCheck?.message).toContain('不存在')
  })

  it('node_modules 存在且有元数据时通过', async () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '', 'utf-8')
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'test', version: '1.0.0' }),
    )
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '.modules.yaml'), '', 'utf-8')

    const results = await runDoctorChecks(dir)
    const nmCheck = results.find(r => r.id === 'node-modules')
    expect(nmCheck?.status).toBe('pass')
  })

  it('packageManager 字段匹配时通过', async () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '', 'utf-8')
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'test',
        version: '1.0.0',
        packageManager: 'pnpm@9.0.0',
      }),
    )

    const results = await runDoctorChecks(dir)
    const pmCheck = results.find(r => r.id === 'pm-field')
    expect(pmCheck?.status).toBe('pass')
  })

  it('所有检查项都有 id 和 status', async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'test', version: '1.0.0' }),
    )

    const results = await runDoctorChecks(dir)
    for (const r of results) {
      expect(r).toHaveProperty('id')
      expect(r).toHaveProperty('name')
      expect(r).toHaveProperty('status')
      expect(r).toHaveProperty('message')
      expect(['pass', 'warn', 'fail']).toContain(r.status)
    }
  })

  it('Expo 项目兼容版本应 pass', async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'expo-app',
        version: '1.0.0',
        dependencies: { expo: '~52.0.0', react: '18.3.1' },
      }),
    )

    const results = await runDoctorChecks(dir)
    const expoCheck = results.find(r => r.id === 'expo-compat')
    expect(expoCheck?.status).toBe('pass')
  })

  it('Expo 项目不兼容 react 版本应 warn', async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'expo-app',
        version: '1.0.0',
        dependencies: { expo: '~52.0.0', react: '18.2.0' },
      }),
    )

    const results = await runDoctorChecks(dir)
    const expoCheck = results.find(r => r.id === 'expo-compat-react')
    expect(expoCheck?.status).toBe('warn')
    expect(expoCheck?.message).toContain('react')
    expect(expoCheck?.message).toContain('不兼容')
  })

  it('app.json 中 plugin 未安装时应 warn', async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'expo-app',
        version: '1.0.0',
        dependencies: { expo: '~52.0.0' },
      }),
    )
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        expo: {
          name: 'MyApp',
          plugins: ['expo-camera', 'sentry-expo'],
        },
      }),
    )

    const results = await runDoctorChecks(dir)
    const pluginCheck = results.find(r => r.id === 'app-json-plugins')
    expect(pluginCheck?.status).toBe('warn')
    expect(pluginCheck?.message).toContain('sentry-expo')
  })

  it('app.json 中所有 plugin 已安装时应 pass', async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'expo-app',
        version: '1.0.0',
        dependencies: { expo: '~52.0.0' },
      }),
    )
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        expo: {
          name: 'MyApp',
          plugins: ['expo-camera'],
        },
      }),
    )

    const results = await runDoctorChecks(dir)
    const pluginCheck = results.find(r => r.id === 'app-json-plugins')
    expect(pluginCheck?.status).toBe('pass')
  })

  it('无 app.json 时跳过 plugins 检查', async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'test',
        version: '1.0.0',
        dependencies: {},
      }),
    )

    const results = await runDoctorChecks(dir)
    const pluginCheck = results.find(r => r.id === 'app-json-plugins')
    expect(pluginCheck).toBeUndefined()
  })
})
