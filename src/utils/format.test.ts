import { describe, it, expect } from 'vitest'
import {
  formatBytes,
  formatDate,
  formatNumber,
  formatRelativeTime,
} from './format.js'

describe('formatBytes', () => {
  it('应该处理 0 字节', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  it('应该处理小于 1KB 的字节数', () => {
    expect(formatBytes(512)).toBe('512 B')
  })

  it('应该正确换算 KB / MB / GB', () => {
    expect(formatBytes(1024)).toBe('1.00 KB')
    expect(formatBytes(320_000)).toMatch(/^312\.50 KB$/)
    expect(formatBytes(1_200_000)).toMatch(/^1\.14 MB$/)
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB')
  })

  it('应该对非法输入返回占位符', () => {
    expect(formatBytes(-1)).toBe('— B')
    expect(formatBytes(Number.NaN)).toBe('— B')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('— B')
  })
})

describe('formatDate', () => {
  it('应该格式化 ISO 字符串为 YYYY-MM-DD（UTC）', () => {
    expect(formatDate('2026-06-01T10:00:00.000Z')).toBe('2026-06-01')
  })

  it('应该补零', () => {
    expect(formatDate('2026-01-05T00:00:00.000Z')).toBe('2026-01-05')
  })

  it('应该对非法输入原样返回', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date')
  })
})

describe('formatNumber', () => {
  it('应该加千位分隔符', () => {
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(1234)).toBe('1,234')
    expect(formatNumber(1234567)).toBe('1,234,567')
  })

  it('应该对非有限数原样返回字符串', () => {
    expect(formatNumber(Number.NaN)).toBe('NaN')
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('Infinity')
  })
})

describe('formatRelativeTime', () => {
  const now = new Date('2026-06-01T12:00:00Z').getTime()

  it('1 分钟内应该返回"刚刚"', () => {
    const t = new Date('2026-06-01T11:59:30Z').toISOString()
    expect(formatRelativeTime(t, now)).toBe('刚刚')
  })

  it('应该正确换算分钟', () => {
    const t = new Date('2026-06-01T11:55:00Z').toISOString()
    expect(formatRelativeTime(t, now)).toBe('5 分钟前')
  })

  it('应该正确换算小时', () => {
    const t = new Date('2026-06-01T09:00:00Z').toISOString()
    expect(formatRelativeTime(t, now)).toBe('3 小时前')
  })

  it('应该正确换算天', () => {
    const t = new Date('2026-05-25T12:00:00Z').toISOString()
    expect(formatRelativeTime(t, now)).toBe('7 天前')
  })

  it('应该正确换算月', () => {
    const t = new Date('2026-01-01T12:00:00Z').toISOString()
    expect(formatRelativeTime(t, now)).toBe('5 个月前')
  })

  it('应该正确换算年', () => {
    const t = new Date('2023-06-01T12:00:00Z').toISOString()
    expect(formatRelativeTime(t, now)).toBe('3 年前')
  })

  it('未来时间应该带"后"后缀', () => {
    const t = new Date('2026-06-01T12:05:00Z').toISOString()
    expect(formatRelativeTime(t, now)).toBe('5 分钟后')
  })

  it('非法输入原样返回', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('not-a-date')
  })
})
