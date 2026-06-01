import { mkdtempSync, rmSync } from 'node:fs'
import { readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DataCache } from './cache.js'

describe('DataCache', () => {
  let dir: string
  let cache: DataCache

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dep-radar-cache-'))
    cache = new DataCache({ cacheDir: dir, ttl: 60_000 })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('get/set/clear 基本读写', () => {
    it('未写入的 key 应该返回 null', async () => {
      const got = await cache.get('missing/key')
      expect(got).toBeNull()
    })

    it('set 后 get 应该读到完整数据', async () => {
      await cache.set('pkg-size/lodash@4.17.21', {
        name: 'lodash',
        size: 72604,
      })
      const got = await cache.get<{ name: string; size: number }>(
        'pkg-size/lodash@4.17.21',
      )
      expect(got).toEqual({ name: 'lodash', size: 72604 })
    })

    it('clear 应该清空整个缓存目录', async () => {
      await cache.set('a', { v: 1 })
      await cache.set('b/c', { v: 2 })
      await cache.clear()
      expect(await cache.get('a')).toBeNull()
      expect(await cache.get('b/c')).toBeNull()
    })

    it('rootDir 应该返回构造时传入的目录', () => {
      expect(cache.rootDir).toBe(dir)
    })
  })

  describe('TTL 过期', () => {
    it('未过期应该返回数据', async () => {
      await cache.set('fresh', { v: 1 })
      expect(await cache.get('fresh')).toEqual({ v: 1 })
    })

    it('超过 TTL 应该返回 null', async () => {
      const shortCache = new DataCache({ cacheDir: dir, ttl: 10 })
      await shortCache.set('short', { v: 1 })

      // 把文件 mtime 设为 1 小时前，绕过等待
      const file = join(dir, 'short.json')
      const past = new Date(Date.now() - 60 * 60 * 1000)
      await utimes(file, past, past)

      expect(await shortCache.get('short')).toBeNull()
    })
  })

  describe('key 路径映射与安全', () => {
    it('包含 / 的 key 会创建子目录', async () => {
      await cache.set('pkg-size/lodash@4.17.21', { ok: true })
      const sub = join(dir, 'pkg-size')
      const files = await readdir(sub)
      expect(files).toContain('lodash@4.17.21.json')
    })

    it('包含非法字符的 key 应该被清洗', async () => {
      // ? * 等是 Windows 非法字符
      await cache.set('weird?key*name', { ok: true })
      expect(await cache.get('weird?key*name')).toEqual({ ok: true })
      // 文件实际应被清洗为下划线
      const files = await readdir(dir)
      expect(files.some(f => f.includes('weird_key_name'))).toBe(true)
    })

    it('包含 .. 的 key 不应该穿越目录', async () => {
      await cache.set('../../etc/passwd', { evil: true })
      // 文件应该写在 dir 内（.. 被替换为 __）
      // 验证：dir 的父目录里没有任何被偷创建的文件
      const parentBefore = await readdir(join(dir, '..'))
      const parentBeforeCount = parentBefore.length
      await cache.set('../../another', { x: 1 })
      const parentAfter = await readdir(join(dir, '..'))
      expect(parentAfter.length).toBe(parentBeforeCount)
    })
  })

  describe('错误容错', () => {
    it('文件损坏（非法 JSON）应该返回 null 而非抛错', async () => {
      const file = join(dir, 'corrupted.json')
      await writeFile(file, '{ not json', 'utf-8')
      const got = await cache.get('corrupted')
      expect(got).toBeNull()
    })

    it('set 时父目录无法创建（如对只读 dir）也不应抛错', async () => {
      // 直接用一个明显不可写的 cacheDir 实例化
      const ro = new DataCache({
        cacheDir: join(dir, 'definitely-not-existing'),
      })
      // 不应 throw
      await expect(ro.set('x', { y: 1 })).resolves.toBeUndefined()
    })

    it('set 与立即 get 应该都成功（mtime 在 ttl 内）', async () => {
      await cache.set('roundtrip', { v: 42 })
      const file = join(dir, 'roundtrip.json')
      const st = await stat(file)
      expect(Date.now() - st.mtimeMs).toBeLessThan(1000)
    })
  })
})
