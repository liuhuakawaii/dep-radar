import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NetworkError, RateLimitError } from '../errors/index.js'
import { fetchJson } from './http.js'

/**
 * 构造一个最小的、可控的 fetch mock
 *
 * 不引入 msw 等额外依赖，直接 stub 全局 fetch。
 */
function mockFetchResponse(init: {
  status?: number
  statusText?: string
  body?: unknown
  /** true 表示返回的 res.json() 会抛错 */
  badJson?: boolean
}): Response {
  const { status = 200, statusText = 'OK', body = {}, badJson = false } = init
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => {
      if (badJson) throw new SyntaxError('Unexpected token')
      return body
    },
  } as unknown as Response
}

describe('fetchJson', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('200 OK 应该解析并返回 JSON', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockFetchResponse({ body: { hello: 'world' } }),
    )
    const got = await fetchJson<{ hello: string }>('https://example.com/x')
    expect(got).toEqual({ hello: 'world' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('应该带上默认 User-Agent 与 Accept 头', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse({ body: {} }))
    await fetchJson('https://example.com/x')
    const [, init] = fetchSpy.mock.calls[0]!
    expect(init.headers['User-Agent']).toMatch(/^dep-radar\//)
    expect(init.headers.Accept).toBe('application/json')
  })

  it('应该允许调用方覆盖头', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse({ body: {} }))
    await fetchJson('https://example.com/x', {
      headers: { Authorization: 'Bearer xxx' },
    })
    const [, init] = fetchSpy.mock.calls[0]!
    expect(init.headers.Authorization).toBe('Bearer xxx')
  })

  it('HTTP 429 应该抛 RateLimitError 并触发重试', async () => {
    vi.useFakeTimers()
    fetchSpy
      .mockResolvedValueOnce(
        mockFetchResponse({ status: 429, statusText: 'Too Many Requests' }),
      )
      .mockResolvedValueOnce(mockFetchResponse({ body: { ok: true } }))

    const promise = fetchJson('https://example.com/x', { retries: 2 })
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toEqual({ ok: true })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('HTTP 500 应该抛 NetworkError 并触发重试', async () => {
    vi.useFakeTimers()
    fetchSpy
      .mockResolvedValueOnce(
        mockFetchResponse({ status: 500, statusText: 'Server Error' }),
      )
      .mockResolvedValueOnce(mockFetchResponse({ body: { ok: true } }))

    const promise = fetchJson('https://example.com/x', { retries: 2 })
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toEqual({ ok: true })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('HTTP 404 不应该重试，立即抛错', async () => {
    vi.useFakeTimers()
    fetchSpy.mockResolvedValue(
      mockFetchResponse({ status: 404, statusText: 'Not Found' }),
    )

    let caught: unknown
    const settled = fetchJson('https://example.com/x', { retries: 3 }).catch(
      e => {
        caught = e
      },
    )
    await vi.runAllTimersAsync()
    await settled
    expect(caught).toBeInstanceOf(NetworkError)
    expect((caught as NetworkError).status).toBe(404)
    // 4xx 不重试，只调用一次
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('429 重试到底仍失败应该抛 RateLimitError', async () => {
    vi.useFakeTimers()
    fetchSpy.mockResolvedValue(mockFetchResponse({ status: 429 }))

    let caught: unknown
    const settled = fetchJson('https://example.com/x', { retries: 2 }).catch(
      e => {
        caught = e
      },
    )
    await vi.runAllTimersAsync()
    await settled
    expect(caught).toBeInstanceOf(RateLimitError)
    expect(fetchSpy).toHaveBeenCalledTimes(3) // 1 + 2 retries
  })

  it('网络异常（DNS 失败等）应抛 NetworkError 并重试', async () => {
    vi.useFakeTimers()
    fetchSpy
      .mockImplementationOnce(async () => {
        throw new TypeError('fetch failed')
      })
      .mockResolvedValueOnce(mockFetchResponse({ body: { ok: true } }))

    const promise = fetchJson('https://example.com/x', { retries: 2 })
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toEqual({ ok: true })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('响应不是合法 JSON 时应抛 NetworkError', async () => {
    vi.useFakeTimers()
    fetchSpy.mockResolvedValue(
      mockFetchResponse({ status: 200, badJson: true }),
    )

    let caught: unknown
    const settled = fetchJson('https://example.com/x', { retries: 0 }).catch(
      e => {
        caught = e
      },
    )
    await vi.runAllTimersAsync()
    await settled
    expect(caught).toBeInstanceOf(NetworkError)
    expect((caught as NetworkError).message).toContain('JSON')
  })

  it('超时应抛 NetworkError(status=0)', async () => {
    vi.useFakeTimers()
    // 模拟一个永不 resolve 的 fetch；当 AbortController.abort() 被调用时，
    // signal.aborted 为 true，我们手动 throw 来触发超时分支
    fetchSpy.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init.signal
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        }
      })
    })

    let caught: unknown
    const settled = fetchJson('https://example.com/x', {
      timeout: 100,
      retries: 0,
    }).catch(e => {
      caught = e
    })
    // 推进 100ms 让超时触发
    await vi.advanceTimersByTimeAsync(150)
    await settled
    expect(caught).toBeInstanceOf(NetworkError)
    expect((caught as NetworkError).status).toBe(0)
    expect((caught as NetworkError).message).toContain('超时')
  })
})
