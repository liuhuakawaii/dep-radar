/**
 * 跨平台文件级缓存
 *
 * 设计原则：
 * - 用 env-paths 自动得到符合 OS 规范的缓存目录（避免污染用户 home）
 * - 简单文件存储：每个 key 一个 .json 文件，便于人工查看与清理
 * - TTL 通过文件 mtime 判断，不在文件内额外存元数据
 * - 不做并发保护：CLI 单进程内已用 p-limit 控制；多进程并行运行时
 *   最坏只是写竞争丢失，下次 cache miss 重拉一次即可
 *
 * 缓存目录由系统决定（env-paths('dep-radar').cache）：
 * - macOS:   ~/Library/Caches/dep-radar-nodejs/
 * - Linux:   ~/.cache/dep-radar-nodejs/
 * - Windows: %LOCALAPPDATA%\dep-radar-nodejs\Cache\
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import envPaths from 'env-paths'

export interface DataCacheOptions {
  /** TTL（毫秒），默认 1 小时 */
  ttl?: number
  /** 自定义缓存目录；不传则使用 env-paths('dep-radar').cache */
  cacheDir?: string
}

/**
 * 文件级 K/V 缓存
 *
 * key 设计：建议用 `{source}/{package}@{version}` 形式，方便人工浏览。
 * key 中的 `/` 会被映射为目录分隔符，自动分桶（如 `pkg-size/lodash@4.17.21.json`）。
 *
 * @example
 * const cache = new DataCache()
 * const hit = await cache.get<PkgSizeResponse>('pkg-size/lodash@4.17.21')
 * if (!hit) {
 *   const data = await fetchFromApi()
 *   await cache.set('pkg-size/lodash@4.17.21', data)
 * }
 */
export class DataCache {
  private readonly dir: string
  private readonly ttl: number

  constructor(options: DataCacheOptions = {}) {
    this.dir = options.cacheDir ?? envPaths('dep-radar').cache
    this.ttl = options.ttl ?? 60 * 60 * 1000
  }

  /**
   * 缓存目录的绝对路径（便于 logger 提示用户与测试断言）
   */
  get rootDir(): string {
    return this.dir
  }

  /**
   * 读取缓存
   *
   * @returns 命中且未过期则返回数据，否则返回 null（不抛错）
   */
  async get<T>(key: string): Promise<T | null> {
    const file = this.keyToPath(key)
    try {
      const st = await stat(file)
      if (Date.now() - st.mtimeMs > this.ttl) return null
      const content = await readFile(file, 'utf-8')
      return JSON.parse(content) as T
    } catch {
      // 任何错误（文件不存在、JSON 损坏、权限错误）都视为 cache miss
      return null
    }
  }

  /**
   * 写入缓存
   *
   * 写入失败不会抛错，只会静默失败：缓存不可用时业务流程应继续。
   */
  async set<T>(key: string, value: T): Promise<void> {
    const file = this.keyToPath(key)
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify(value), 'utf-8')
    } catch {
      // 静默：缓存写入失败不应影响主流程
    }
  }

  /**
   * 带缓存的异步操作包装
   *
   * 先查缓存，命中则直接返回；未命中则执行 fetchFn，成功后写入缓存。
   * fetchFn 抛错时不写缓存，直接向上抛出。
   *
   * @example
   * const data = await cache.withCache('pkg-size/lodash@4.17.21', () =>
   *   fetchJson('https://pkg-size.dev/api/lodash@4.17.21')
   * )
   */
  async withCache<T>(key: string, fetchFn: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key)
    if (cached !== null) return cached
    const result = await fetchFn()
    await this.set(key, result)
    return result
  }

  /**
   * 清空整个缓存目录
   *
   * 用于 `dep-radar cache clear` 命令。
   */
  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true })
  }

  /**
   * 把 cache key 映射为文件路径
   *
   * 安全性：
   * - 保留 [A-Za-z0-9@/_.-]，便于按 `/` 分桶
   * - 其他字符（含 Windows 非法字符 `<>:"|?*` 与可疑字符 `\`）替换为 `_`
   * - `..` 会被替换为 `__` 防止路径穿越
   *
   * 写入前再用 path.resolve + 前缀比较确认最终路径仍在 cacheDir 内，
   * 双保险防御。
   */
  private keyToPath(key: string): string {
    const safe = key.replace(/[^A-Za-z0-9@/_.-]/g, '_').replace(/\.\./g, '__')
    return join(this.dir, `${safe}.json`)
  }
}
