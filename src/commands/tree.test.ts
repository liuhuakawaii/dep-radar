import { beforeAll, describe, expect, it } from 'vitest'

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
