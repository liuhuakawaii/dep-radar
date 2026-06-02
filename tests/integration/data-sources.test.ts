/**
 * 数据源集成测试
 *
 * 真实 API 调用，验证端到端行为。
 * 通过 INTEGRATION=1 环境变量启用（CI 中默认跳过）。
 *
 * 测试目标：
 * - npm registry（getPackageInfo / getFullPackageInfo / getDownloadCount / getDownloadTrend）
 * - pkg-size.dev（getPackageSize）
 * - GitHub API（getRepoInfo，需要 GITHUB_TOKEN）
 */

import { describe, expect, it } from 'vitest'

const runIntegration = !!process.env.INTEGRATION

describe.skipIf(!runIntegration)('npm registry 集成', () => {
  it('getPackageInfo — 获取 lodash latest manifest', async () => {
    const { getPackageInfo } = await import('../../src/data/npm.js')
    const info = await getPackageInfo('lodash')
    expect(info.name).toBe('lodash')
    expect(info.version).toBeDefined()
    expect(info.license).toBeDefined()
  }, 15_000)

  it('getFullPackageInfo — 获取 react 完整 document', async () => {
    const { getFullPackageInfo } = await import('../../src/data/npm.js')
    const doc = await getFullPackageInfo('react')
    expect(doc.name).toBe('react')
    expect(doc.time).toBeDefined()
    expect(doc.maintainers).toBeDefined()
    expect(Object.keys(doc.versions).length).toBeGreaterThan(0)
  }, 15_000)

  it('getDownloadCount — 获取 lodash 周下载量', async () => {
    const { getDownloadCount } = await import('../../src/data/npm.js')
    const count = await getDownloadCount('lodash', 'last-week')
    expect(count).toBeGreaterThan(0)
  }, 15_000)

  it('getDownloadTrend — 获取 chalk 趋势', async () => {
    const { getDownloadTrend } = await import('../../src/data/npm.js')
    const trend = await getDownloadTrend('chalk')
    expect(['up', 'down', 'stable']).toContain(trend)
  }, 15_000)

  it('不存在的包应抛出 PackageNotFoundError', async () => {
    const { getPackageInfo } = await import('../../src/data/npm.js')
    const { PackageNotFoundError } = await import('../../src/errors/index.js')
    await expect(
      getPackageInfo('this-package-definitely-does-not-exist-xyz123'),
    ).rejects.toThrow(PackageNotFoundError)
  }, 15_000)
})

describe.skipIf(!runIntegration)('pkg-size.dev 集成', () => {
  it('getPackageSize — 获取 ms 包体积', async () => {
    const { getPackageSize } = await import('../../src/data/pkg-size.js')
    const result = await getPackageSize('ms@2.1.3')
    expect(result).not.toBeNull()
    expect(result!.name).toBe('ms')
    expect(result!.version).toBe('2.1.3')
    expect(result!.gzip).toBeGreaterThan(0)
    expect(result!.size).toBeGreaterThan(0)
  }, 30_000)

  it('不存在的包应返回 null 或抛出错误', async () => {
    const { getPackageSize } = await import('../../src/data/pkg-size.js')
    // pkg-size.dev 对不存在的包可能返回 null 或抛出 404
    const result = await getPackageSize(
      'this-package-definitely-does-not-exist-xyz123',
    )
    // 如果返回 null 也算通过
    if (result !== null) {
      expect(result.gzip).toBeDefined()
    }
  }, 30_000)
})

describe.skipIf(!runIntegration)('GitHub API 集成', () => {
  it('getRepoInfo — 获取 react 仓库信息', async () => {
    const { getRepoInfo } = await import('../../src/data/github.js')
    const info = await getRepoInfo('facebook', 'react')
    expect(info.stargazers_count).toBeGreaterThan(100_000)
    expect(info.pushed_at).toBeDefined()
  }, 15_000)

  it('不存在的仓库应抛出错误', async () => {
    const { getRepoInfo } = await import('../../src/data/github.js')
    await expect(
      getRepoInfo(
        'this-owner-definitely-does-not-exist',
        'this-repo-definitely-does-not-exist',
      ),
    ).rejects.toThrow()
  }, 15_000)
})

describe.skipIf(!runIntegration)('缓存集成', () => {
  it('DataCache — 写入后读取应命中', async () => {
    const { DataCache } = await import('../../src/data/cache.js')
    const cache = new DataCache({ ttl: 60_000 })
    const key = `integration-test:${Date.now()}`
    const value = { hello: 'world', ts: Date.now() }

    await cache.set(key, value)
    const got = await cache.get(key)
    expect(got).toEqual(value)
  })

  it('DataCache — withCache 应缓存 fetchFn 结果', async () => {
    const { DataCache } = await import('../../src/data/cache.js')
    const cache = new DataCache({ ttl: 60_000 })
    const key = `integration-withCache:${Date.now()}`
    let callCount = 0

    const fetchFn = async () => {
      callCount++
      return { data: 'test', count: callCount }
    }

    // 第一次调用
    const r1 = await cache.withCache(key, fetchFn)
    expect(r1.count).toBe(1)

    // 第二次调用应命中缓存
    const r2 = await cache.withCache(key, fetchFn)
    expect(r2.count).toBe(1) // 仍然是 1，因为走了缓存
    expect(callCount).toBe(1)
  })
})
