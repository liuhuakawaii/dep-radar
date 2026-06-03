/**
 * dep-radar CLI 入口
 *
 * 命令地图：
 *   scan      ✅  日常依赖审查与优化建议（替代 analyze + optimize + report）
 *   explain   ✅  解释单个依赖为什么存在
 *   doctor    ✅  检查项目依赖健康基线
 *   diff      ✅  对比两次扫描报告，显示依赖变更
 *
 * 全局选项：
 *   --no-cache       禁用缓存
 *   --cache-dir      自定义缓存目录
 *   --verbose        详细日志
 *   --silent         静默
 *   --registry       自定义 npm registry（CLI 优先级高于配置文件）
 *   --concurrency    并发请求数（默认 5）
 *
 * Workspace 选项（scan）：
 *   --workspace <name>   分析指定工作区子包
 *   --all-workspaces     分析所有工作区子包并汇总
 */

import { resolve } from 'node:path'

import { Command } from 'commander'

import { diffCommand } from './commands/diff.js'
import { doctorCommand } from './commands/doctor.js'
import { explainCommand } from './commands/explain.js'
import { scanCommand } from './commands/scan.js'
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
// scan
// =====================================================================

program
  .command('scan')
  .description('扫描项目依赖，输出审查结果和优化建议')
  .argument('[path]', '项目路径', '.')
  .option('--ci', 'CI 模式：只对高优先级问题返回非零退出码', false)
  .option('--deep', '深度模式：完整 lock 文件扫描（更慢但更全面）', false)
  .option(
    '--format <type>',
    '输出格式: terminal|json|html|markdown',
    'terminal',
  )
  .option('--json', 'JSON 输出（--format json 的简写）', false)
  .option('--output <path>', '输出文件路径')
  .option('--include-dev', '同时分析 devDependencies', false)
  .option('--skip-health', '跳过健康度维度', false)
  .option('--skip-license', '跳过许可证维度', false)
  .option('--skip-security', '跳过安全审计维度', false)
  .option('--scope <scope>', '体积分析范围: runtime|all|non-runtime', 'runtime')
  .option('--stats <file>', 'webpack stats.json 路径')
  .option('--assets-dir <dir>', '构建输出目录')
  .option('--since <ref>', '增量分析：只分析相对于指定 git ref 变更的依赖')
  .option('--workspace <name>', '分析指定工作区子包')
  .option('--all-workspaces', '分析所有工作区子包并汇总', false)
  .action(async (path: string, options: Record<string, unknown>) => {
    const globals = program.opts()
    const baseOpts = {
      format: (options.json ? 'json' : options.format) as
        | 'terminal'
        | 'json'
        | 'html'
        | 'markdown',
      output: options.output as string | undefined,
      ci: Boolean(options.ci),
      deep: Boolean(options.deep),
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
      since: options.since as string | undefined,
    }

    const wsPaths = await resolveWorkspacePath(
      path,
      options.workspace as string | undefined,
      Boolean(options.allWorkspaces),
    )

    if (wsPaths && wsPaths.length > 1) {
      let worstCode: number = EXIT_CODES.OK
      for (const wsPath of wsPaths) {
        const code = await scanCommand(wsPath, baseOpts)
        if (code > worstCode) worstCode = code
      }
      process.exit(worstCode)
    } else {
      const targetPath = wsPaths?.[0] ?? path
      const exitCode = await scanCommand(targetPath, baseOpts)
      process.exit(exitCode)
    }
  })

// =====================================================================
// explain
// =====================================================================

program
  .command('explain')
  .description('解释单个依赖为什么存在于项目中')
  .argument('<package>', '要解释的包名')
  .argument('[path]', '项目路径', '.')
  .option('--format <type>', '输出格式: terminal|json', 'terminal')
  .option('--include-dev', '同时分析 devDependencies', false)
  .action(
    async (
      packageName: string,
      path: string,
      options: Record<string, unknown>,
    ) => {
      const globals = program.opts()
      const exitCode = await explainCommand(packageName, path, {
        format: (options.format as 'terminal' | 'json') ?? 'terminal',
        includeDev: Boolean(options.includeDev),
        cacheEnabled: globals.cache !== false,
        cacheDir: globals.cacheDir as string | undefined,
        registry: globals.registry as string | undefined,
        concurrency: globals.concurrency
          ? Number(globals.concurrency)
          : undefined,
      })
      process.exit(exitCode)
    },
  )

// =====================================================================
// doctor
// =====================================================================

program
  .command('doctor')
  .description('检查项目依赖健康基线（lock 文件一致性、项目类型等）')
  .argument('[path]', '项目路径', '.')
  .option('--format <type>', '输出格式: terminal|json', 'terminal')
  .action(async (path: string, options: Record<string, unknown>) => {
    const exitCode = await doctorCommand(path, {
      format: (options.format as 'terminal' | 'json') ?? 'terminal',
    })
    process.exit(exitCode)
  })

// =====================================================================
// diff
// =====================================================================

program
  .command('diff')
  .description('对比两次扫描报告，显示依赖变更')
  .argument('<before>', '基线报告（JSON 文件）')
  .argument('<after>', '当前报告（JSON 文件）')
  .option('--format <type>', '输出格式: terminal|json', 'terminal')
  .option('--json', 'JSON 输出（--format json 的简写）', false)
  .option('--output <path>', '输出文件路径')
  .action(
    async (before: string, after: string, options: Record<string, unknown>) => {
      const exitCode = await diffCommand(before, after, {
        format: (options.json ? 'json' : options.format) as 'terminal' | 'json',
        output: options.output as string | undefined,
      })
      process.exit(exitCode)
    },
  )

// =====================================================================
// 顶层错误处理
// =====================================================================

async function main(): Promise<void> {
  const opts = program.opts()
  const verbose = Boolean(opts.verbose)

  try {
    await program.parseAsync(process.argv)
  } catch (err) {
    const lines = formatError(err, verbose)
    for (const line of lines) {
      logger.error(line)
    }

    if (err instanceof DepRadarError) {
      process.exit(errorCodeToExitCode(err.code))
    }

    process.exit(EXIT_CODES.ERROR)
  }
}

void main()
