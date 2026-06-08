import { describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

const { execFile } = await import('node:child_process')
const { getChangedDependencies } = await import('./gitDiff.js')

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>

/** 模拟 git show 返回不同 ref 的 package.json 内容 */
function mockGitShow(oldContent: string, newContent: string) {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, result?: { stdout: string }) => void,
    ) => {
      const spec = args[1] as string
      if (spec.startsWith('HEAD:')) {
        cb(null, { stdout: newContent })
      } else {
        cb(null, { stdout: oldContent })
      }
    },
  )
}

/** 模拟 git show 对某个 ref 抛错（ref 不存在） */
function mockGitShowOldFails(newContent: string) {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, result?: { stdout: string }) => void,
    ) => {
      const spec = args[1] as string
      if (spec.startsWith('HEAD:')) {
        cb(null, { stdout: newContent })
      } else {
        cb(new Error('fatal: bad revision'))
      }
    },
  )
}

function makePkgJson(
  deps: Record<string, string> = {},
  devDeps: Record<string, string> = {},
): string {
  return JSON.stringify({ dependencies: deps, devDependencies: devDeps })
}

describe('getChangedDependencies', () => {
  it('happy path：应正确检测 added / removed / changed', async () => {
    const oldPkg = makePkgJson(
      { react: '^18.0.0', lodash: '^4.0.0' },
      { vitest: '^1.0.0' },
    )
    const newPkg = makePkgJson(
      { react: '^19.0.0', axios: '^1.0.0' },
      { vitest: '^2.0.0' },
    )
    mockGitShow(oldPkg, newPkg)

    const result = await getChangedDependencies('/project', 'main')
    expect(result.added).toEqual(['axios'])
    expect(result.removed).toEqual(['lodash'])
    expect(result.changed).toEqual(['react', 'vitest'])
  })

  it('无变更时三个数组都为空', async () => {
    const pkg = makePkgJson({ react: '^18.0.0' }, { vitest: '^1.0.0' })
    mockGitShow(pkg, pkg)

    const result = await getChangedDependencies('/project', 'main')
    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
    expect(result.changed).toEqual([])
  })

  it('ref 不存在时（git show 失败），HEAD 的依赖全部视为 added', async () => {
    const newPkg = makePkgJson({ react: '^18.0.0', axios: '^1.0.0' })
    mockGitShowOldFails(newPkg)

    const result = await getChangedDependencies('/project', 'nonexistent-ref')
    expect(result.added.sort()).toEqual(['axios', 'react'])
    expect(result.removed).toEqual([])
    expect(result.changed).toEqual([])
  })

  it('旧 package.json 为空对象时，HEAD 依赖全部 added', async () => {
    const newPkg = makePkgJson({ react: '^18.0.0' })
    mockGitShow('{}', newPkg)

    const result = await getChangedDependencies('/project', 'main')
    expect(result.added).toEqual(['react'])
    expect(result.removed).toEqual([])
    expect(result.changed).toEqual([])
  })

  it('新 package.json 为空对象时，旧依赖全部 removed', async () => {
    const oldPkg = makePkgJson({ react: '^18.0.0' })
    mockGitShow(oldPkg, '{}')

    const result = await getChangedDependencies('/project', 'main')
    expect(result.added).toEqual([])
    expect(result.removed).toEqual(['react'])
    expect(result.changed).toEqual([])
  })

  it('malformed JSON 不应抛错，返回空结果', async () => {
    mockGitShow('not valid json', 'also not valid')

    const result = await getChangedDependencies('/project', 'main')
    expect(result.added).toEqual([])
    expect(result.removed).toEqual([])
    expect(result.changed).toEqual([])
  })

  it('scoped 包名应正确处理', async () => {
    const oldPkg = makePkgJson({ '@scope/pkg': '^1.0.0' })
    const newPkg = makePkgJson({
      '@scope/pkg': '^2.0.0',
      '@other/lib': '^1.0.0',
    })
    mockGitShow(oldPkg, newPkg)

    const result = await getChangedDependencies('/project', 'main')
    expect(result.added).toEqual(['@other/lib'])
    expect(result.removed).toEqual([])
    expect(result.changed).toEqual(['@scope/pkg'])
  })

  it('dependencies 和 devDependencies 都应参与 diff', async () => {
    const oldPkg = makePkgJson({ a: '^1.0.0' }, { b: '^1.0.0' })
    const newPkg = makePkgJson({ a: '^2.0.0' }, { c: '^1.0.0' })
    mockGitShow(oldPkg, newPkg)

    const result = await getChangedDependencies('/project', 'main')
    expect(result.added).toEqual(['c'])
    expect(result.removed).toEqual(['b'])
    expect(result.changed).toEqual(['a'])
  })

  it('只有 dependencies 没有 devDependencies 时应正常工作', async () => {
    const oldPkg = makePkgJson({ a: '^1.0.0' })
    const newPkg = makePkgJson({ a: '^1.0.0', b: '^2.0.0' })
    mockGitShow(oldPkg, newPkg)

    const result = await getChangedDependencies('/project', 'main')
    expect(result.added).toEqual(['b'])
    expect(result.removed).toEqual([])
    expect(result.changed).toEqual([])
  })

  it('版本字符串不同即视为 changed（不做 semver 解析）', async () => {
    const oldPkg = makePkgJson({ react: '^18.0.0' })
    const newPkg = makePkgJson({ react: '~18.0.0' })
    mockGitShow(oldPkg, newPkg)

    const result = await getChangedDependencies('/project', 'main')
    expect(result.changed).toEqual(['react'])
  })

  it('版本完全相同不应出现在 changed 中', async () => {
    const oldPkg = makePkgJson({ react: '^18.0.0' })
    const newPkg = makePkgJson({ react: '^18.0.0' })
    mockGitShow(oldPkg, newPkg)

    const result = await getChangedDependencies('/project', 'main')
    expect(result.changed).toEqual([])
  })
})
