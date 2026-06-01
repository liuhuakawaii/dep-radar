import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { withRetry } from './withRetry.js'

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('首次成功不进入重试', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const got = await withRetry(fn)
    expect(got).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('失败后重试，最终成功', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockResolvedValueOnce('ok')

    const promise = withRetry(fn, { retries: 3, minDelay: 100 })
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('超过 retries 次仍失败时抛出最后一次错误', async () => {
    // vitest 的 fake timers + Node 18+ 严格的 unhandled rejection 检测会
    // 触发 PromiseRejectionHandledWarning（即便 await 最终捕获了 reject）。
    // 解法：立即挂 .catch 把 rejection 转为变量，避免出现 unhandled 窗口。
    let calls = 0
    const fn = async (): Promise<string> => {
      calls++
      throw new Error('boom')
    }
    let caught: unknown
    const settled = withRetry(fn, { retries: 2, minDelay: 1 }).catch(e => {
      caught = e
    })
    await vi.runAllTimersAsync()
    await settled
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('boom')
    // 第 1 次 + 2 次重试 = 3 次调用
    expect(calls).toBe(3)
  })

  it('shouldRetry 返回 false 时立即抛错，不再重试', async () => {
    let calls = 0
    const fn = async (): Promise<string> => {
      calls++
      throw new Error('client error')
    }
    const shouldRetry = vi.fn().mockReturnValue(false)
    let caught: unknown
    const settled = withRetry(fn, {
      retries: 5,
      minDelay: 1,
      shouldRetry,
    }).catch(e => {
      caught = e
    })
    await vi.runAllTimersAsync()
    await settled
    expect((caught as Error).message).toBe('client error')
    expect(calls).toBe(1)
    expect(shouldRetry).toHaveBeenCalledTimes(1)
  })

  it('指数退避：第 N 次失败后等待 minDelay * 2^N 毫秒', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('e1'))
      .mockResolvedValueOnce('ok')

    const promise = withRetry(fn, { retries: 3, minDelay: 200 })
    // 推进 199ms，应该还在第一次重试的延迟里
    await vi.advanceTimersByTimeAsync(199)
    expect(fn).toHaveBeenCalledTimes(1)
    // 再推进 1ms 跨过 200ms 阈值
    await vi.advanceTimersByTimeAsync(1)
    await expect(promise).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('延迟封顶 maxDelay', async () => {
    // 让退避算到 minDelay * 2^attempt = 100 * 2^3 = 800，超过 maxDelay=300
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('e1'))
      .mockRejectedValueOnce(new Error('e2'))
      .mockRejectedValueOnce(new Error('e3'))
      .mockResolvedValueOnce('ok')

    const promise = withRetry(fn, {
      retries: 5,
      minDelay: 100,
      maxDelay: 300,
    })
    // 累计延迟最多：100 + 200 + 300 = 600ms（第三次被封顶）
    await vi.advanceTimersByTimeAsync(700)
    await expect(promise).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(4)
  })
})
