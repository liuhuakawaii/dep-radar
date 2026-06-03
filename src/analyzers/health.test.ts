import { describe, expect, it, vi } from 'vitest'

import { parseGitHubUrl } from '../data/github.js'
import type { GithubRepoResponse, NpmFullDocResponse } from '../types/api.js'
import type { HealthInfo } from '../types/analysis.js'
import type { PackageJson } from '../types/package.js'

import {
  analyzeHealthFromPackage,
  computeHealthScore,
  extractRepositoryUrl,
  monthsSince,
  type HealthFetcher,
} from './health.js'

// =====================================================================
// 测试夹具
// =====================================================================

function makeFetcher(overrides: Partial<HealthFetcher> = {}): HealthFetcher {
  return {
    getFullDoc: vi.fn(),
    getWeeklyDownloads: vi.fn(),
    getTrend: vi.fn(),
    getGitHubRepo: vi.fn(),
    ...overrides,
  }
}

function makeDoc(
  partial: Partial<NpmFullDocResponse> = {},
  manifestPartial: Record<string, unknown> = {},
): NpmFullDocResponse {
  return {
    name: 'react',
    'dist-tags': { latest: '18.3.1' },
    versions: {
      '18.3.1': {
        name: 'react',
        version: '18.3.1',
        types: './index.d.ts',
        ...manifestPartial,
      },
    },
    time: {
      '18.3.1': '2026-05-01T00:00:00.000Z',
      modified: '2026-05-01T00:00:00.000Z',
    },
    maintainers: [{ name: 'gaearon' }, { name: 'sebmarkbage' }],
    repository: {
      type: 'git',
      url: 'git+https://github.com/facebook/react.git',
    },
    ...partial,
  }
}

function baseInfo(over: Partial<HealthInfo> = {}): HealthInfo {
  return {
    name: 'x',
    weeklyDownloads: 0,
    downloadTrend: 'stable',
    lastPublish: '',
    maintainers: 0,
    openIssues: 0,
    deprecated: false,
    hasTypeScriptTypes: false,
    healthScore: 0,
    isDirect: true,
    ...over,
  }
}

// =====================================================================
// computeHealthScore — 评分算法的各维度边界
// =====================================================================

describe('computeHealthScore', () => {
  it('deprecated 应直接 0 分（即使其他维度满分）', () => {
    const info = baseInfo({
      deprecated: true,
      weeklyDownloads: 10_000_000,
      lastPublish: new Date().toISOString(),
      githubStars: 100_000,
      maintainers: 10,
      hasTypeScriptTypes: true,
      downloadTrend: 'up',
    })
    expect(computeHealthScore(info)).toBe(0)
  })

  it('全维度满分应封顶 100', () => {
    const info = baseInfo({
      weeklyDownloads: 10_000_000,
      lastPublish: new Date().toISOString(),
      githubStars: 100_000,
      maintainers: 10,
      hasTypeScriptTypes: true,
      downloadTrend: 'up',
    })
    expect(computeHealthScore(info)).toBe(100)
  })

  it('下载量阶梯应正确：100k+/10k+/1k+/其他', () => {
    expect(
      computeHealthScore(baseInfo({ weeklyDownloads: 100_001 })),
    ).toBeGreaterThanOrEqual(25)
    expect(
      computeHealthScore(baseInfo({ weeklyDownloads: 50_000 })),
    ).toBeGreaterThanOrEqual(18)
    expect(
      computeHealthScore(baseInfo({ weeklyDownloads: 5_000 })),
    ).toBeGreaterThanOrEqual(10)
    expect(
      computeHealthScore(baseInfo({ weeklyDownloads: 50 })),
    ).toBeGreaterThanOrEqual(3)
  })

  it('最近发布阶梯：<1月 / <6月 / <12月 / <24月 / >24月', () => {
    const isoBefore = (days: number) =>
      new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()

    // 仅靠 "发布时间" 一项的增量 + 基线分（下载量 3 + maintainers 2 = 5）
    const baseScore = computeHealthScore(baseInfo())
    const recent = computeHealthScore(baseInfo({ lastPublish: isoBefore(15) }))
    const sixMonths = computeHealthScore(
      baseInfo({ lastPublish: isoBefore(100) }),
    )
    const oneYear = computeHealthScore(
      baseInfo({ lastPublish: isoBefore(300) }),
    )
    const twoYear = computeHealthScore(
      baseInfo({ lastPublish: isoBefore(500) }),
    )
    const stale = computeHealthScore(baseInfo({ lastPublish: isoBefore(1000) }))

    expect(recent - baseScore).toBe(25)
    expect(sixMonths - baseScore).toBe(18)
    expect(oneYear - baseScore).toBe(10)
    expect(twoYear - baseScore).toBe(3)
    expect(stale - baseScore).toBe(0)
  })

  it('githubStars 缺失（undefined）等同 0，不加分', () => {
    const a = computeHealthScore(baseInfo())
    const b = computeHealthScore(baseInfo({ githubStars: undefined }))
    expect(a).toBe(b)
  })

  it('downloadTrend: up=15, stable=10, down=0', () => {
    const base = computeHealthScore(baseInfo({ downloadTrend: 'down' }))
    const stable = computeHealthScore(baseInfo({ downloadTrend: 'stable' }))
    const up = computeHealthScore(baseInfo({ downloadTrend: 'up' }))
    expect(stable - base).toBe(10)
    expect(up - base).toBe(15)
  })

  it('自定义权重应改变分数', () => {
    const info = baseInfo({
      weeklyDownloads: 500_000,
      lastPublish: new Date().toISOString(),
      githubStars: 50_000,
      maintainers: 5,
      hasTypeScriptTypes: true,
      downloadTrend: 'up',
    })
    // 只关注下载量，其他权重为 0
    const downloadOnly = computeHealthScore(info, {
      weeklyDownloads: 100,
      lastPublish: 0,
      githubStars: 0,
      maintainers: 0,
      hasTypeScriptTypes: 0,
      downloadTrend: 0,
    })
    expect(downloadOnly).toBe(100) // 100 权重，满分档
    expect(downloadOnly).toBeLessThanOrEqual(100) // 封顶 100
  })

  it('自定义权重未指定的字段应使用默认值', () => {
    const info = baseInfo({ weeklyDownloads: 500_000 })
    const partial = computeHealthScore(info, { weeklyDownloads: 50 })
    // weeklyDownloads 满分档 50 + 默认 maintainers 基线 2 + 默认 downloadTrend stable 10 = 62
    expect(partial).toBe(62)
  })

  it('权重全为 0 应返回 0', () => {
    const info = baseInfo({
      weeklyDownloads: 500_000,
      hasTypeScriptTypes: true,
      downloadTrend: 'up',
    })
    expect(
      computeHealthScore(info, {
        weeklyDownloads: 0,
        lastPublish: 0,
        githubStars: 0,
        maintainers: 0,
        hasTypeScriptTypes: 0,
        downloadTrend: 0,
      }),
    ).toBe(0)
  })

  it('权重总和超过 100 应封顶 100', () => {
    const info = baseInfo({
      weeklyDownloads: 500_000,
      lastPublish: new Date().toISOString(),
      hasTypeScriptTypes: true,
      downloadTrend: 'up',
    })
    const score = computeHealthScore(info, {
      weeklyDownloads: 50,
      lastPublish: 50,
      githubStars: 50,
      maintainers: 50,
      hasTypeScriptTypes: 50,
      downloadTrend: 50,
    })
    expect(score).toBe(100)
  })
})

// =====================================================================
// monthsSince
// =====================================================================

describe('monthsSince', () => {
  it('应正确返回过去时间的月数', () => {
    const past = new Date('2026-01-01T00:00:00Z')
    const now = new Date('2026-06-01T00:00:00Z')
    expect(monthsSince(past.toISOString(), now)).toBe(5)
  })

  it('空字符串 / 非法时间返回 null', () => {
    expect(monthsSince('')).toBeNull()
    expect(monthsSince('not-a-date')).toBeNull()
  })

  it('未来时间（时钟漂移）应返回 0', () => {
    const future = new Date(Date.now() + 86400_000).toISOString()
    expect(monthsSince(future)).toBe(0)
  })
})

// =====================================================================
// extractRepositoryUrl
// =====================================================================

describe('extractRepositoryUrl', () => {
  it('对象格式', () => {
    expect(
      extractRepositoryUrl({ repository: { type: 'git', url: 'https://x' } }),
    ).toBe('https://x')
  })

  it('字符串格式', () => {
    expect(extractRepositoryUrl({ repository: 'https://x' })).toBe('https://x')
  })

  it('无 repository 返回 undefined', () => {
    expect(extractRepositoryUrl({})).toBeUndefined()
    expect(extractRepositoryUrl(undefined)).toBeUndefined()
  })
})

// =====================================================================
// parseGitHubUrl（来自 data/github.ts，health.ts 中使用）
// =====================================================================

describe('parseGitHubUrl（health 中使用）', () => {
  it.each([
    ['git+https://github.com/facebook/react.git', 'facebook', 'react'],
    ['https://github.com/facebook/react', 'facebook', 'react'],
    ['github:facebook/react', 'facebook', 'react'],
    ['git@github.com:facebook/react.git', 'facebook', 'react'],
  ])('应解析 %s', (url, owner, repo) => {
    expect(parseGitHubUrl(url)).toEqual({ owner, repo })
  })

  it('非 GitHub URL 返回 null', () => {
    expect(parseGitHubUrl('https://gitlab.com/x/y')).toBeNull()
    expect(parseGitHubUrl('https://example.com/x/y')).toBeNull()
    expect(parseGitHubUrl('')).toBeNull()
  })
})

// =====================================================================
// analyzeHealth — 集成
// =====================================================================

describe('analyzeHealth', () => {
  function makePkg(
    deps: Record<string, string> = {},
    devDeps: Record<string, string> = {},
  ): PackageJson {
    return {
      name: 'demo',
      version: '1.0.0',
      dependencies: deps,
      devDependencies: devDeps,
    }
  }

  it('happy path：拉取 + 评分 + 包含 GitHub 数据', async () => {
    const fetcher = makeFetcher({
      getFullDoc: vi.fn().mockResolvedValue(makeDoc()),
      getWeeklyDownloads: vi.fn().mockResolvedValue(500_000),
      getTrend: vi.fn().mockResolvedValue('up'),
      getGitHubRepo: vi.fn().mockResolvedValue({
        stargazers_count: 200_000,
        open_issues_count: 800,
        pushed_at: '2026-05-30T00:00:00Z',
        updated_at: '2026-05-30T00:00:00Z',
        archived: false,
        license: { spdx_id: 'MIT' },
      } satisfies GithubRepoResponse),
    })

    const result = await analyzeHealthFromPackage(
      makePkg({ react: '^18.0.0' }),
      fetcher,
    )
    expect(result.health).toHaveLength(1)
    expect(result.skipped).toHaveLength(0)

    const h = result.health[0]!
    expect(h.name).toBe('react')
    expect(h.weeklyDownloads).toBe(500_000)
    expect(h.downloadTrend).toBe('up')
    expect(h.deprecated).toBe(false)
    expect(h.hasTypeScriptTypes).toBe(true)
    expect(h.githubStars).toBe(200_000)
    expect(h.githubLastPush).toBe('2026-05-30T00:00:00Z')
    expect(h.openIssues).toBe(800)
    expect(h.maintainers).toBe(2)
    expect(h.lastPublish).toBe('2026-05-01T00:00:00.000Z')
    expect(h.healthScore).toBeGreaterThan(80)
  })

  it('deprecated 包应反映为 deprecated=true 且 healthScore=0', async () => {
    const doc = makeDoc({}, { deprecated: '已废弃，请使用 X 替代' })
    const fetcher = makeFetcher({
      getFullDoc: vi.fn().mockResolvedValue(doc),
      getWeeklyDownloads: vi.fn().mockResolvedValue(1_000_000),
      getTrend: vi.fn().mockResolvedValue('up'),
      getGitHubRepo: vi.fn().mockResolvedValue(null),
    })

    const result = await analyzeHealthFromPackage(
      makePkg({ moment: '^2.0.0' }),
      fetcher,
    )
    const h = result.health[0]!
    expect(h.deprecated).toBe(true)
    expect(h.deprecatedMessage).toBe('已废弃，请使用 X 替代')
    expect(h.healthScore).toBe(0)
  })

  it('GitHub 失败（fetcher 返回 null）应软退化：stars/lastPush 缺失但 healthScore 仍能算出', async () => {
    const fetcher = makeFetcher({
      getFullDoc: vi.fn().mockResolvedValue(makeDoc()),
      getWeeklyDownloads: vi.fn().mockResolvedValue(500_000),
      getTrend: vi.fn().mockResolvedValue('up'),
      getGitHubRepo: vi.fn().mockResolvedValue(null),
    })

    const result = await analyzeHealthFromPackage(
      makePkg({ react: '^18.0.0' }),
      fetcher,
    )
    const h = result.health[0]!
    expect(h.githubStars).toBeUndefined()
    expect(h.githubLastPush).toBeUndefined()
    expect(h.healthScore).toBeGreaterThan(0)
  })

  it('无 repository 时不应调用 getGitHubRepo', async () => {
    const ghMock = vi.fn()
    const fetcher = makeFetcher({
      getFullDoc: vi.fn().mockResolvedValue(makeDoc({ repository: undefined })),
      getWeeklyDownloads: vi.fn().mockResolvedValue(100),
      getTrend: vi.fn().mockResolvedValue('stable'),
      getGitHubRepo: ghMock,
    })
    await analyzeHealthFromPackage(makePkg({ x: '1' }), fetcher)
    expect(ghMock).not.toHaveBeenCalled()
  })

  it('非 GitHub 仓库不应调用 getGitHubRepo', async () => {
    const ghMock = vi.fn()
    const fetcher = makeFetcher({
      getFullDoc: vi.fn().mockResolvedValue(
        makeDoc({
          repository: { type: 'git', url: 'https://gitlab.com/a/b' },
        }),
      ),
      getWeeklyDownloads: vi.fn().mockResolvedValue(100),
      getTrend: vi.fn().mockResolvedValue('stable'),
      getGitHubRepo: ghMock,
    })
    await analyzeHealthFromPackage(makePkg({ x: '1' }), fetcher)
    expect(ghMock).not.toHaveBeenCalled()
  })

  it('npm doc 拉取失败 → 该包整条 skipped，其他包不受影响', async () => {
    const fetcher = makeFetcher({
      getFullDoc: vi.fn().mockImplementation(async name => {
        if (name === 'broken') throw new Error('boom')
        return makeDoc()
      }),
      getWeeklyDownloads: vi.fn().mockResolvedValue(100),
      getTrend: vi.fn().mockResolvedValue('stable'),
      getGitHubRepo: vi.fn().mockResolvedValue(null),
    })

    const result = await analyzeHealthFromPackage(
      makePkg({ react: '^18.0.0', broken: '^1.0.0' }),
      fetcher,
    )
    expect(result.health.map(h => h.name)).toEqual(['react'])
    expect(result.skipped).toEqual([{ name: 'broken', reason: 'boom' }])
  })

  it('includeDev=false 时不应分析 devDependencies', async () => {
    const fetcher = makeFetcher({
      getFullDoc: vi.fn().mockResolvedValue(makeDoc()),
      getWeeklyDownloads: vi.fn().mockResolvedValue(100),
      getTrend: vi.fn().mockResolvedValue('stable'),
      getGitHubRepo: vi.fn().mockResolvedValue(null),
    })
    const r = await analyzeHealthFromPackage(
      makePkg({ a: '1' }, { b: '1' }),
      fetcher,
    )
    expect(r.health.map(h => h.name)).toEqual(['a'])
  })

  it('includeDev=true 时应包含 devDependencies', async () => {
    const fetcher = makeFetcher({
      getFullDoc: vi.fn().mockResolvedValue(makeDoc()),
      getWeeklyDownloads: vi.fn().mockResolvedValue(100),
      getTrend: vi.fn().mockResolvedValue('stable'),
      getGitHubRepo: vi.fn().mockResolvedValue(null),
    })
    const r = await analyzeHealthFromPackage(
      makePkg({ a: '1' }, { b: '1' }),
      fetcher,
      {
        includeDev: true,
      },
    )
    expect(r.health.map(h => h.name).sort()).toEqual(['a', 'b'])
  })

  it('ignore 模式（glob *）应跳过匹配包', async () => {
    const fetcher = makeFetcher({
      getFullDoc: vi.fn().mockResolvedValue(makeDoc()),
      getWeeklyDownloads: vi.fn().mockResolvedValue(100),
      getTrend: vi.fn().mockResolvedValue('stable'),
      getGitHubRepo: vi.fn().mockResolvedValue(null),
    })
    const r = await analyzeHealthFromPackage(
      makePkg({ '@internal/a': '1', '@internal/b': '1', react: '1' }),
      fetcher,
      { ignore: ['@internal/*'] },
    )
    expect(r.health.map(h => h.name)).toEqual(['react'])
  })

  it('类型字段缺失时 hasTypeScriptTypes=false', async () => {
    const doc = makeDoc({}, { types: undefined, typings: undefined })
    const fetcher = makeFetcher({
      getFullDoc: vi.fn().mockResolvedValue(doc),
      getWeeklyDownloads: vi.fn().mockResolvedValue(100),
      getTrend: vi.fn().mockResolvedValue('stable'),
      getGitHubRepo: vi.fn().mockResolvedValue(null),
    })
    const r = await analyzeHealthFromPackage(makePkg({ a: '1' }), fetcher)
    expect(r.health[0]!.hasTypeScriptTypes).toBe(false)
  })

  it('typings 字段（旧名）也应识别为有 TS 支持', async () => {
    const doc = makeDoc({}, { types: undefined, typings: './index.d.ts' })
    const fetcher = makeFetcher({
      getFullDoc: vi.fn().mockResolvedValue(doc),
      getWeeklyDownloads: vi.fn().mockResolvedValue(100),
      getTrend: vi.fn().mockResolvedValue('stable'),
      getGitHubRepo: vi.fn().mockResolvedValue(null),
    })
    const r = await analyzeHealthFromPackage(makePkg({ a: '1' }), fetcher)
    expect(r.health[0]!.hasTypeScriptTypes).toBe(true)
  })

  it('weeklyDownloads / trend 单字段拉取失败应有合理 fallback（0 / stable）', async () => {
    const fetcher = makeFetcher({
      getFullDoc: vi.fn().mockResolvedValue(makeDoc()),
      getWeeklyDownloads: vi
        .fn()
        .mockRejectedValue(new Error('downloads down')),
      getTrend: vi.fn().mockRejectedValue(new Error('trend down')),
      getGitHubRepo: vi.fn().mockResolvedValue(null),
    })
    const r = await analyzeHealthFromPackage(makePkg({ react: '^18' }), fetcher)
    expect(r.health[0]!.weeklyDownloads).toBe(0)
    expect(r.health[0]!.downloadTrend).toBe('stable')
    // 单字段失败不应导致整条 skipped
    expect(r.skipped).toHaveLength(0)
  })
})
