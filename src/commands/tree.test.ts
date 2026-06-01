import { beforeAll, describe, expect, it } from 'vitest'

import type { ReplacementRule } from '../types/config.js'

import { parseDepTree, renderTree, type TreeNode } from './tree.js'

beforeAll(() => {
  process.env.FORCE_COLOR = '0'
})

describe('parseDepTree (npm)', () => {
  it('应解析 npm ls --json 的嵌套结构', () => {
    const stdout = JSON.stringify({
      name: 'my-app',
      version: '1.0.0',
      dependencies: {
        react: {
          version: '18.3.1',
          dependencies: {
            'loose-envify': { version: '1.4.0' },
          },
        },
        lodash: { version: '4.17.21' },
      },
    })
    const tree = parseDepTree(stdout, 'npm')
    expect(tree.name).toBe('my-app')
    expect(tree.version).toBe('1.0.0')
    expect(tree.children).toHaveLength(2)
    const react = tree.children.find(c => c.name === 'react')!
    expect(react.version).toBe('18.3.1')
    expect(react.children[0]?.name).toBe('loose-envify')
  })

  it('缺失字段时应回退到合理默认值', () => {
    const stdout = JSON.stringify({ dependencies: { x: {} } })
    const tree = parseDepTree(stdout, 'npm')
    expect(tree.name).toBe('(root)')
    expect(tree.version).toBe('?')
    expect(tree.children[0]?.version).toBe('?')
  })
})

describe('parseDepTree (pnpm)', () => {
  it('应解析 pnpm list --json 的数组结构', () => {
    const stdout = JSON.stringify([
      {
        name: 'my-app',
        version: '1.0.0',
        dependencies: {
          react: {
            version: '18.3.1',
            dependencies: {
              'loose-envify': { version: '1.4.0' },
            },
          },
        },
        devDependencies: {
          vitest: { version: '3.0.0' },
        },
      },
    ])
    const tree = parseDepTree(stdout, 'pnpm')
    expect(tree.name).toBe('my-app')
    // deps + devDeps 合并
    const names = tree.children.map(c => c.name).sort()
    expect(names).toEqual(['react', 'vitest'].sort())
    const react = tree.children.find(c => c.name === 'react')!
    expect(react.children[0]?.name).toBe('loose-envify')
  })

  it('非数组输入也应兼容（容错处理）', () => {
    const stdout = JSON.stringify({
      name: 'my-app',
      version: '1.0.0',
      dependencies: { x: { version: '1.0.0' } },
    })
    const tree = parseDepTree(stdout, 'pnpm')
    expect(tree.name).toBe('my-app')
    expect(tree.children).toHaveLength(1)
  })
})

describe('renderTree', () => {
  const sample: TreeNode = {
    name: 'my-app',
    version: '1.0.0',
    children: [
      {
        name: 'react',
        version: '18.3.1',
        children: [{ name: 'loose-envify', version: '1.4.0', children: [] }],
      },
      { name: 'lodash', version: '4.17.21', children: [] },
    ],
  }

  it('应渲染为 ASCII 树（含 ├ / └ 分支符）', () => {
    const out = renderTree(sample)
    expect(out).toContain('my-app@1.0.0')
    expect(out).toContain('├── react@18.3.1')
    expect(out).toContain('│   └── loose-envify@1.4.0')
    expect(out).toContain('└── lodash@4.17.21')
  })

  it('maxDepth 应控制渲染深度', () => {
    const out = renderTree(sample, 1)
    // depth=1 只显示一级子节点，loose-envify 应被省略
    expect(out).toContain('react@18.3.1')
    expect(out).not.toContain('loose-envify')
    expect(out).toContain('...')
  })

  it('maxDepth=0 时只显示根', () => {
    const out = renderTree(sample, 0)
    expect(out).toContain('my-app@1.0.0')
    expect(out).not.toContain('react')
    expect(out).toContain('...')
  })

  it('叶子节点不应输出多余的 ...', () => {
    const leaf: TreeNode = { name: 'x', version: '1', children: [] }
    const out = renderTree(leaf, 0)
    expect(out).toBe('x@1')
  })
})

describe('renderTree 优化提示', () => {
  const sample: TreeNode = {
    name: 'my-app',
    version: '1.0.0',
    children: [
      { name: 'react', version: '18.3.1', children: [] },
      { name: 'lodash', version: '4.17.21', children: [] },
      { name: 'moment', version: '2.30.1', children: [] },
      { name: 'ofetch', version: '1.4.0', children: [] },
    ],
  }

  const replacements: Record<string, ReplacementRule> = {
    lodash: {
      alternative: 'es-toolkit',
      altPackage: 'es-toolkit',
      estimatedSavingsPercent: 90,
      difficulty: 'medium',
      breakingChange: false,
      description: 'test',
    },
    moment: {
      alternative: 'dayjs',
      altPackage: 'dayjs',
      estimatedSavingsPercent: 97,
      difficulty: 'low',
      breakingChange: false,
      description: 'test',
    },
  }

  it('传入 replacements 时应为匹配包显示 [!] 提示', () => {
    const out = renderTree(sample, Infinity, replacements)
    expect(out).toContain('[!] 建议替换为 es-toolkit')
    expect(out).toContain('[!] 建议替换为 dayjs')
    expect(out).toContain('节省 90%')
    expect(out).toContain('节省 97%')
  })

  it('无 replacements 参数时不应显示 [!] 提示', () => {
    const out = renderTree(sample)
    expect(out).not.toContain('[!]')
  })

  it('replacements 为空对象时不应显示 [!] 提示', () => {
    const out = renderTree(sample, Infinity, {})
    expect(out).not.toContain('[!]')
  })

  it('不在 replacements 表中的包不应有提示', () => {
    const out = renderTree(sample, Infinity, replacements)
    expect(out).toContain('react@18.3.1')
    // react 行不应有 [!]
    const reactLine = out.split('\n').find(l => l.includes('react@'))
    expect(reactLine).not.toContain('[!]')
  })

  it('estimatedSavingsPercent 为 0 时不应显示百分比', () => {
    const rule: Record<string, ReplacementRule> = {
      lodash: {
        alternative: 'es-toolkit',
        altPackage: 'es-toolkit',
        estimatedSavingsPercent: 0,
        difficulty: 'medium',
        breakingChange: false,
        description: 'test',
      },
    }
    const out = renderTree(sample, Infinity, rule)
    expect(out).toContain('[!] 建议替换为 es-toolkit')
    expect(out).not.toContain('节省')
  })

  it('嵌套子节点也应显示提示', () => {
    const nested: TreeNode = {
      name: 'app',
      version: '1.0.0',
      children: [
        {
          name: 'moment',
          version: '2.30.1',
          children: [
            { name: 'moment-timezone', version: '0.5.45', children: [] },
          ],
        },
      ],
    }
    const out = renderTree(nested, Infinity, replacements)
    const momentLine = out.split('\n').find(l => l.includes('moment@'))
    expect(momentLine).toContain('[!] 建议替换为 dayjs')
    // moment-timezone 不在表中，不应有提示
    const tzLine = out.split('\n').find(l => l.includes('moment-timezone@'))
    expect(tzLine).not.toContain('[!]')
  })
})
