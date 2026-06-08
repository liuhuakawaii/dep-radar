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

import { NetworkError, PackageNotFoundError } from '../errors/index.js'

/** 默认 TTL：7 天。npm 已发布的版本是不可变的，对带版本号的请求可以再放大 */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 负缓存默认 TTL：24 小时（用于 404 / 4xx 这类「确定不存在」的响应） */
export const DEFAULT_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000

export interface DataCacheOptions {
  /** 正常值 TTL（毫秒），默认 7 天 */
  ttl?: number
  /** 负缓存 TTL（毫秒），默认 24 小时；只用于 PackageNotFoundError 与 4xx NetworkError */
  negativeTtl?: number
  /** 自定义缓存目录；不传则使用 env-paths('dep-radar').cache */
  cacheDir?: string
}

/** 缓存文件的结构（v1） */
interface CacheEntryV1<T> {
  v: 1
  /** 'ok' 正常值；'err' 失败 sentinel（负缓存） */
  k: 'ok' | 'err'
  /** k='ok' 时的载荷 */
  value?: T
  /** k='err' 时的错误信息 */
  error?: {
    name: string
    message: string
    status?: number
    packageName?: string
  }
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
export interface CacheStats {
  hits: number
  misses: number
  writes: number
}

export class DataCache {
  private readonly dir: string
  private readonly ttl: number
  private readonly negativeTtl: number
  private _stats: CacheStats = { hits: 0, misses: 0, writes: 0 }

  constructor(options: DataCacheOptions = {}) {
    this.dir = options.cacheDir ?? envPaths('dep-radar').cache
    this.ttl = options.ttl ?? DEFAULT_TTL_MS
    this.negativeTtl = options.negativeTtl ?? DEFAULT_NEGATIVE_TTL_MS
  }

  /**
   * 缓存目录的绝对路径（便于 logger 提示用户与测试断言）
   */
  get rootDir(): string {
    return this.dir
  }

  /**
   * 缓存命中/未命中统计
   */
  get stats(): Readonly<CacheStats> {
    return this._stats
  }

  /**
   * 读取缓存
   *
   * @returns 命中且未过期则返回数据，否则返回 null（不抛错）
   *
   * 兼容两种文件格式：
   *  - 新格式：{ v:1, k:'ok'|'err', value?|error? }
   *  - 旧格式：直接 JSON.stringify(value)（早期写入的文件）
   *
   * 命中负缓存（k='err'）时也返回 null —— 调用方应改用 getEntry 才能拿到错误。
   */
  async get<T>(key: string): Promise<T | null> {
    const entry = await this.getEntry<T>(key)
    if (entry.kind === 'hit') return entry.value
    return null
  }

  /**
   * 读取详细缓存项（区分正命中 / 负命中 / 未命中）
   */
  async getEntry<T>(
    key: string,
  ): Promise<
    | { kind: 'hit'; value: T }
    | { kind: 'neg-hit'; error: Error }
    | { kind: 'miss' }
  > {
    const file = this.keyToPath(key)
    let st: Awaited<ReturnType<typeof stat>>
    let content: string
    try {
      st = await stat(file)
      content = await readFile(file, 'utf-8')
    } catch {
      this._stats.misses++
      return { kind: 'miss' }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      this._stats.misses++
      return { kind: 'miss' }
    }

    const envelope = asEnvelope<T>(parsed)
    const age = Date.now() - st.mtimeMs

    if (envelope) {
      const ttl = envelope.k === 'err' ? this.negativeTtl : this.ttl
      if (age > ttl) {
        this._stats.misses++
        return { kind: 'miss' }
      }
      if (envelope.k === 'ok') {
        this._stats.hits++
        return { kind: 'hit', value: envelope.value as T }
      }
      // 负缓存
      this._stats.hits++
      return { kind: 'neg-hit', error: reviveError(envelope.error) }
    }

    // 旧格式：直接当作 value，遵循正常 TTL
    if (age > this.ttl) {
      this._stats.misses++
      return { kind: 'miss' }
    }
    this._stats.hits++
    return { kind: 'hit', value: parsed as T }
  }

  /**
   * 写入缓存（正常值）
   *
   * 写入失败不会抛错，只会静默失败：缓存不可用时业务流程应继续。
   */
  async set<T>(key: string, value: T): Promise<void> {
    await this.writeEnvelope(key, { v: 1, k: 'ok', value })
  }

  /**
   * 写入负缓存
   *
   * 只用于「确定不存在」类错误：PackageNotFoundError、4xx NetworkError。
   * 5xx / 超时 / 限流等瞬态错误不应进入负缓存（否则会持续放大故障）。
   */
  async setError(key: string, error: Error): Promise<void> {
    const status = error instanceof NetworkError ? error.status : undefined
    const packageName =
      error instanceof PackageNotFoundError ? error.packageName : undefined
    await this.writeEnvelope(key, {
      v: 1,
      k: 'err',
      error: { name: error.name, message: error.message, status, packageName },
    })
  }

  private async writeEnvelope<T>(
    key: string,
    envelope: CacheEntryV1<T>,
  ): Promise<void> {
    const file = this.keyToPath(key)
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify(envelope), 'utf-8')
      this._stats.writes++
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
   * 注意：本方法不读取负缓存；如果需要利用「确定不存在」的负缓存能力，
   * 请改用 withCacheOrError。
   */
  async withCache<T>(key: string, fetchFn: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key)
    if (cached !== null) return cached
    const result = await fetchFn()
    await this.set(key, result)
    return result
  }

  /**
   * 带正/负缓存的异步操作包装
   *
   * - 正命中：返回值
   * - 负命中（之前确定包不存在 / 4xx）：直接重新抛出之前的错误，不再发请求
   * - 未命中：执行 fetchFn；成功写正缓存；命中 shouldCacheError 的错误写负缓存
   *
   * 默认 shouldCacheError 命中 PackageNotFoundError 与 4xx NetworkError。
   * 5xx / 超时 / 限流不进负缓存（持续故障不应阻塞后续重试）。
   */
  async withCacheOrError<T>(
    key: string,
    fetchFn: () => Promise<T>,
    shouldCacheError: (err: unknown) => boolean = defaultShouldCacheError,
  ): Promise<T> {
    const entry = await this.getEntry<T>(key)
    if (entry.kind === 'hit') return entry.value
    if (entry.kind === 'neg-hit') throw entry.error
    try {
      const result = await fetchFn()
      await this.set(key, result)
      return result
    } catch (err) {
      if (err instanceof Error && shouldCacheError(err)) {
        await this.setError(key, err)
      }
      throw err
    }
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

/**
 * 默认的负缓存判定：
 *  - PackageNotFoundError：包确定不存在 ✓
 *  - 4xx NetworkError（非 429）：客户端错误，重试也是同样结果 ✓
 *  - 5xx / 超时 / 限流 / 解析错误：瞬态故障 ✗
 */
function defaultShouldCacheError(err: unknown): boolean {
  if (err instanceof PackageNotFoundError) return true
  if (err instanceof NetworkError) {
    if (err.status === 0) return false // 0 = 网络异常 / 超时
    if (err.status === 429) return false // 限流
    if (err.status >= 400 && err.status < 500) return true
  }
  return false
}

/** 把磁盘上的 unknown 强制断言为 CacheEntryV1；不是则返回 null（旧格式） */
function asEnvelope<T>(parsed: unknown): CacheEntryV1<T> | null {
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'v' in parsed &&
    (parsed as { v?: unknown }).v === 1 &&
    'k' in parsed
  ) {
    return parsed as CacheEntryV1<T>
  }
  return null
}

/** 把负缓存条目还原为 Error 实例（尽量保留原类型） */
function reviveError(payload: CacheEntryV1<unknown>['error']): Error {
  if (!payload) return new Error('Unknown cached error')
  if (payload.name === 'PackageNotFoundError' && payload.packageName) {
    return new PackageNotFoundError(payload.packageName)
  }
  if (payload.name === 'NetworkError') {
    return new NetworkError(payload.message, payload.status)
  }
  const err = new Error(payload.message)
  err.name = payload.name
  return err
}
