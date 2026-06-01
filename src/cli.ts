/**
 * dep-radar CLI 入口
 *
 * 命令地图：
 *   analyze   ✅  分析依赖（包体积，更多维度随后续 analyzer 接入）
 *   tree      ✅  依赖树可视化（npm/pnpm，yarn 待支持）
 *   optimize  🚧  优化建议（依赖 Phase 2 的 optimizer analyzer）
 *   compare   🚧  对比两次分析（依赖 analyze 完整链路 + diff 算法）
 *   report    🚧  生成 HTML 报告（依赖 Phase 2 的 HTML renderer）
 *
 * 全局选项：
 *   --no-cache       禁用缓存（缓存集成在后续步骤接入 data 层）
 *   --cache-dir      自定义缓存目录
 *   --verbose        详细日志
 *   --silent         静默
 *   --registry       自定义 npm registry（短期暂未应用，待 data 层接入）
 */

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

declare const __DEP_RADAR_VERSION__: string

const program = new Command()

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
    '--only <dimension>',
    '只分析特定维度: size|health|license|security',
    'size',
  )
  .option('--format <type>', '输出格式: terminal|json|html', 'terminal')
  .option('--output <path>', '输出文件路径')
  .option('--top <n>', '显示 TOP N 体积大户', '10')
  .option('--include-dev', '同时分析 devDependencies', false)
  .action(async (path: string, options: Record<string, unknown>) => {
    const exitCode = await analyzeCommand(path, {
      format: options.format as 'terminal' | 'json' | 'html',
      output: options.output as string | undefined,
      top: Number(options.top),
      includeDev: Boolean(options.includeDev),
      only: options.only as 'size' | 'health' | 'license' | 'security',
    })
    process.exit(exitCode)
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
  .action(async (path: string, options: Record<string, unknown>) => {
    const exitCode = await treeCommand(path, {
      depth: Number(options.depth),
      hints: Boolean(options.hints),
    })
    process.exit(exitCode)
  })

// =====================================================================
// 占位命令（依赖后续 Phase 的 analyzer / renderer）
// =====================================================================

program
  .command('optimize')
  .description('跨维度聚合分析并生成优化建议')
  .argument('[path]', '项目路径', '.')
  .option('--format <type>', '输出格式: terminal|json|html', 'terminal')
  .option('--output <path>', '输出文件路径')
  .option('--include-dev', '同时分析 devDependencies', false)
  .option('--skip-health', '跳过健康度维度（避免 GitHub API 调用）', false)
  .option('--skip-license', '跳过许可证维度', false)
  .action(async (path: string, options: Record<string, unknown>) => {
    const code = await optimizeCommand(path, {
      format: options.format as 'terminal' | 'json' | 'html',
      output: options.output as string | undefined,
      includeDev: Boolean(options.includeDev),
      skipHealth: Boolean(options.skipHealth),
      skipLicense: Boolean(options.skipLicense),
    })
    process.exit(code)
  })

program
  .command('compare')
  .description('对比两个项目的依赖差异（体积）')
  .argument('<pathA>', '基准项目路径')
  .argument('<pathB>', '对比项目路径')
  .option('--include-dev', '同时比较 devDependencies', false)
  .action(
    async (pathA: string, pathB: string, options: Record<string, unknown>) => {
      const exitCode = await compareCommand(pathA, pathB, {
        includeDev: Boolean(options.includeDev),
      })
      process.exit(exitCode)
    },
  )

program
  .command('report')
  .description('生成完整 HTML 报告（optimize --format html 的快捷方式）')
  .argument('[path]', '项目路径', '.')
  .option('--output <path>', '输出文件路径', 'dep-radar-report.html')
  .option('--include-dev', '同时分析 devDependencies', false)
  .option('--skip-health', '跳过健康度维度（避免 GitHub API 调用）', false)
  .option('--skip-license', '跳过许可证维度', false)
  .action(async (path: string, options: Record<string, unknown>) => {
    const code = await optimizeCommand(path, {
      format: 'html',
      output: options.output as string,
      includeDev: Boolean(options.includeDev),
      skipHealth: Boolean(options.skipHealth),
      skipLicense: Boolean(options.skipLicense),
    })
    process.exit(code)
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
