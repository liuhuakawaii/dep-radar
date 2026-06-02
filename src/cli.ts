/**
 * dep-radar CLI 入口
 *
 * 命令地图：
 *   analyze   ✅  单/多维度分析（size/health/license/security，支持逗号分隔）
 *   tree      ✅  依赖树可视化（npm/pnpm/yarn，支持 monorepo workspace）
 *   optimize  ✅  跨维度聚合分析 + 优化建议（四维度并行）
 *   compare   ✅  对比两个项目的依赖差异（支持多维度 + --since 增量对比）
 *   report    ✅  生成完整分析报告（html/json/markdown）
 *
 * 全局选项：
 *   --no-cache       禁用缓存
 *   --cache-dir      自定义缓存目录
 *   --verbose        详细日志
 *   --silent         静默
 *   --registry       自定义 npm registry（CLI 优先级高于配置文件）
 *   --concurrency    并发请求数（默认 5）
 *
 * Workspace 选项（analyze / optimize / report / tree）：
 *   --workspace <name>   分析指定工作区子包
 *   --all-workspaces     分析所有工作区子包并汇总
 */

import { resolve } from 'node:path'

import { Command } from 'commander'

import { analyzeCommand } from './commands/analyze.js'
import { compareCommand } from './commands/compare.js'
import { optimizeCommand } from './commands/optimize.js'
import { treeCommand } from './commands/tree.js'
import { setOfflineMode } from './data/http.js'
import { DepRadarError } from './errors/index.js'
import { errorCodeToExitCode, formatError } from './utils/errorEnricher.js'
import { EXIT_CODES } from './utils/exitCode.js'
import { logger, setLogLevel } from './utils/logger.js'
import { detectWorkspaces, findWorkspace } from './utils/workspace.js'

declare const __DEP_RADAR_VERSION__: string

const program = new Command()

/**
 * 解析 workspace 路径
 *
 * 当指定 --workspace 时，查找子包并返回其绝对路径。
 * 当指定 --all-workspaces 时，返回所有子包路径列表。
 * 都未指定时返回 undefined（使用原始 path）。
 */
async function resolveWorkspacePath(
  projectPath: string,
  workspaceName?: string,
  allWorkspaces?: boolean,
): Promise<string[] | undefined> {
  const workspaces = await detectWorkspaces(projectPath)
  if (workspaces.length === 0) {
    if (workspaceName || allWorkspaces) {
      logger.error(
        '未检测到工作区配置（package.json workspaces 或 pnpm-workspace.yaml）',
      )
      return undefined
    }
    return undefined
  }

  if (workspaceName) {
    const found = findWorkspace(workspaces, workspaceName)
    if (!found) {
      logger.error(`未找到工作区 "${workspaceName}"`)
      logger.info(`可用工作区：${workspaces.map(w => w.name).join(', ')}`)
      return undefined
    }
    return [resolve(projectPath, found.path)]
  }

  if (allWorkspaces) {
    return workspaces.map(w => resolve(projectPath, w.path))
  }

  return undefined
}

program
  .name('dep-radar')
  .description('前端依赖雷达 — 一站式依赖分析与优化建议')
  .version(__DEP_RADAR_VERSION__)
  // 全局选项
  .option('--no-cache', '禁用缓存')
  .option('--cache-dir <path>', '自定义缓存目录')
  .option('--verbose', '显示详细日志')
  .option('--silent', '静默模式')
  .option('--registry <url>', '自定义 npm registry')
  .option('--concurrency <n>', '并发请求数（默认 5，建议 1-20）')
  .option(
    '--offline',
    '离线模式，跳过所有网络请求（也可通过 OFFLINE=1 环境变量启用）',
  )
  .hook('preAction', thisCommand => {
    const opts = thisCommand.opts()
    if (opts.silent) setLogLevel('silent')
    else if (opts.verbose) setLogLevel('verbose')
    if (opts.offline) {
      setOfflineMode(true)
      logger.info('已启用离线模式，所有网络请求将被跳过')
    }
  })

// =====================================================================
// analyze
// =====================================================================

program
  .command('analyze')
  .description('分析当前项目的依赖')
  .argument('[path]', '项目路径', '.')
  .option(
    '--only <dimensions>',
    '分析维度: size|health|license|security（逗号分隔或 all）',
    'size',
  )
  .option(
    '--format <type>',
    '输出格式: terminal|json|html|markdown',
    'terminal',
  )
  .option('--output <path>', '输出文件路径')
  .option('--top <n>', '显示 TOP N 体积大户', '10')
  .option('--include-dev', '同时分析 devDependencies', false)
  .option('--since <ref>', '增量分析：只分析相对于指定 git ref 变更的依赖')
  .option('--scope <scope>', '体积分析范围: runtime|all|non-runtime', 'runtime')
  .option('--stats <file>', 'webpack stats.json 路径（真实 bundle 分析）')
  .option('--assets-dir <dir>', '构建输出目录（计算实际 gzip）')
  .option('--workspace <name>', '分析指定工作区子包')
  .option('--all-workspaces', '分析所有工作区子包并汇总', false)
  .action(async (path: string, options: Record<string, unknown>) => {
    const globals = program.opts()
    const baseOpts = {
      format: options.format as 'terminal' | 'json' | 'html' | 'markdown',
      output: options.output as string | undefined,
      top: Number(options.top),
      includeDev: Boolean(options.includeDev),
      only: options.only as string,
      cacheEnabled: globals.cache !== false,
      cacheDir: globals.cacheDir as string | undefined,
      registry: globals.registry as string | undefined,
      concurrency: globals.concurrency
        ? Number(globals.concurrency)
        : undefined,
      since: options.since as string | undefined,
      verbose: Boolean(globals.verbose),
      scope: (options.scope as 'runtime' | 'all' | 'non-runtime') ?? 'runtime',
      statsFile: options.stats as string | undefined,
      assetsDir: options.assetsDir as string | undefined,
    }

    const wsPaths = await resolveWorkspacePath(
      path,
      options.workspace as string | undefined,
      Boolean(options.allWorkspaces),
    )

    if (wsPaths && wsPaths.length > 1) {
      // --all-workspaces：逐个分析并汇总
      let worstCode: number = EXIT_CODES.OK
      for (const wsPath of wsPaths) {
        const code = await analyzeCommand(wsPath, baseOpts)
        if (code > worstCode) worstCode = code
      }
      process.exit(worstCode)
    } else {
      const targetPath = wsPaths?.[0] ?? path
      const exitCode = await analyzeCommand(targetPath, baseOpts)
      process.exit(exitCode)
    }
  })

// =====================================================================
// tree
// =====================================================================

program
  .command('tree')
  .description('查看依赖树')
  .argument('[path]', '项目路径', '.')
  .option('--depth <n>', '最大深度', '5')
  .option('--no-hints', '不显示优化提示（[!] 替代建议等）')
  .option('--workspace <name>', '查看指定工作区子包的依赖树')
  .action(async (path: string, options: Record<string, unknown>) => {
    const wsPaths = await resolveWorkspacePath(
      path,
      options.workspace as string | undefined,
    )
    const targetPath = wsPaths?.[0] ?? path
    const exitCode = await treeCommand(targetPath, {
      depth: Number(options.depth),
      hints: Boolean(options.hints),
    })
    process.exit(exitCode)
  })

// =====================================================================
// optimize
// =====================================================================

program
  .command('optimize')
  .description('跨维度聚合分析并生成优化建议')
  .argument('[path]', '项目路径', '.')
  .option(
    '--format <type>',
    '输出格式: terminal|json|html|markdown',
    'terminal',
  )
  .option('--output <path>', '输出文件路径')
  .option('--include-dev', '同时分析 devDependencies', false)
  .option('--skip-health', '跳过健康度维度（避免 GitHub API 调用）', false)
  .option('--skip-license', '跳过许可证维度', false)
  .option('--skip-security', '跳过安全审计维度', false)
  .option('--scope <scope>', '体积分析范围: runtime|all|non-runtime', 'runtime')
  .option('--stats <file>', 'webpack stats.json 路径（真实 bundle 分析）')
  .option('--assets-dir <dir>', '构建输出目录（计算实际 gzip）')
  .option('--workspace <name>', '分析指定工作区子包')
  .option('--all-workspaces', '分析所有工作区子包并汇总', false)
  .action(async (path: string, options: Record<string, unknown>) => {
    const globals = program.opts()
    const baseOpts = {
      format: options.format as 'terminal' | 'json' | 'html',
      output: options.output as string | undefined,
      includeDev: Boolean(options.includeDev),
      skipHealth: Boolean(options.skipHealth),
      skipLicense: Boolean(options.skipLicense),
      skipSecurity: Boolean(options.skipSecurity),
      scope: (options.scope as 'runtime' | 'all' | 'non-runtime') ?? 'runtime',
      statsFile: options.stats as string | undefined,
      assetsDir: options.assetsDir as string | undefined,
      cacheEnabled: globals.cache !== false,
      cacheDir: globals.cacheDir as string | undefined,
      registry: globals.registry as string | undefined,
      concurrency: globals.concurrency
        ? Number(globals.concurrency)
        : undefined,
    }

    const wsPaths = await resolveWorkspacePath(
      path,
      options.workspace as string | undefined,
      Boolean(options.allWorkspaces),
    )

    if (wsPaths && wsPaths.length > 1) {
      let worstCode: number = EXIT_CODES.OK
      for (const wsPath of wsPaths) {
        const code = await optimizeCommand(wsPath, baseOpts)
        if (code > worstCode) worstCode = code
      }
      process.exit(worstCode)
    } else {
      const targetPath = wsPaths?.[0] ?? path
      const code = await optimizeCommand(targetPath, baseOpts)
      process.exit(code)
    }
  })

program
  .command('compare')
  .description('对比两个项目的依赖差异（支持多维度）')
  .argument('<pathA>', '基准项目路径')
  .argument('[pathB]', '对比项目路径（使用 --since 时可省略）')
  .option('--include-dev', '同时比较 devDependencies', false)
  .option(
    '--dimensions <dims>',
    '要比较的维度，逗号分隔（size,health,license）',
    'size',
  )
  .option(
    '--since <ref>',
    '增量对比：与指定 git ref 的 package.json 对比（忽略 pathB）',
  )
  .action(
    async (
      pathA: string,
      pathB: string | undefined,
      options: Record<string, unknown>,
    ) => {
      const globals = program.opts()
      const dims = (options.dimensions as string)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
      const exitCode = await compareCommand(pathA, pathB ?? '.', {
        includeDev: Boolean(options.includeDev),
        dimensions: dims,
        cacheEnabled: globals.cache !== false,
        cacheDir: globals.cacheDir as string | undefined,
        registry: globals.registry as string | undefined,
        concurrency: globals.concurrency
          ? Number(globals.concurrency)
          : undefined,
        since: options.since as string | undefined,
      })
      process.exit(exitCode)
    },
  )

program
  .command('report')
  .description('生成完整分析报告（支持 html/json/markdown 格式）')
  .argument('[path]', '项目路径', '.')
  .option('--format <type>', '输出格式: html|json|markdown', 'html')
  .option('--output <path>', '输出文件路径（默认按格式生成）')
  .option('--include-dev', '同时分析 devDependencies', false)
  .option('--skip-health', '跳过健康度维度（避免 GitHub API 调用）', false)
  .option('--skip-license', '跳过许可证维度', false)
  .option('--skip-security', '跳过安全审计维度', false)
  .option('--workspace <name>', '分析指定工作区子包')
  .option('--all-workspaces', '分析所有工作区子包并汇总', false)
  .action(async (path: string, options: Record<string, unknown>) => {
    const globals = program.opts()
    const format = (options.format as string) || 'html'
    const extMap: Record<string, string> = {
      html: '.html',
      json: '.json',
      markdown: '.md',
    }
    const ext = extMap[format] ?? '.html'
    const output = (options.output as string) ?? `dep-radar-report${ext}`
    const baseOpts = {
      format: format as 'html' | 'json' | 'markdown',
      output,
      includeDev: Boolean(options.includeDev),
      skipHealth: Boolean(options.skipHealth),
      skipLicense: Boolean(options.skipLicense),
      skipSecurity: Boolean(options.skipSecurity),
      cacheEnabled: globals.cache !== false,
      cacheDir: globals.cacheDir as string | undefined,
      registry: globals.registry as string | undefined,
      concurrency: globals.concurrency
        ? Number(globals.concurrency)
        : undefined,
    }

    const wsPaths = await resolveWorkspacePath(
      path,
      options.workspace as string | undefined,
      Boolean(options.allWorkspaces),
    )

    if (wsPaths && wsPaths.length > 1) {
      let worstCode: number = EXIT_CODES.OK
      for (const wsPath of wsPaths) {
        const code = await optimizeCommand(wsPath, baseOpts)
        if (code > worstCode) worstCode = code
      }
      process.exit(worstCode)
    } else {
      const targetPath = wsPaths?.[0] ?? path
      const code = await optimizeCommand(targetPath, baseOpts)
      process.exit(code)
    }
  })

// =====================================================================
// 顶层错误处理
// =====================================================================

async function main(): Promise<void> {
  const opts = program.opts()
  const verbose = Boolean(opts.verbose)

  try {
    await program.parseAsync(process.argv)
  } catch (err) {
    // 增强错误信息：追加上下文提示
    const lines = formatError(err, verbose)
    for (const line of lines) {
      logger.error(line)
    }

    // DepRadarError 子类：按 error code 映射退出码
    if (err instanceof DepRadarError) {
      process.exit(errorCodeToExitCode(err.code))
    }

    process.exit(EXIT_CODES.ERROR)
  }
}

void main()
