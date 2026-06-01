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
import { treeCommand } from './commands/tree.js'
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
  .hook('preAction', thisCommand => {
    const opts = thisCommand.opts()
    if (opts.silent) setLogLevel('silent')
    else if (opts.verbose) setLogLevel('verbose')
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
  .option('--format <type>', '输出格式: terminal|json', 'terminal')
  .option('--output <path>', '输出文件路径')
  .option('--top <n>', '显示 TOP N 体积大户', '10')
  .option('--include-dev', '同时分析 devDependencies', false)
  .action(async (path: string, options: Record<string, unknown>) => {
    const exitCode = await analyzeCommand(path, {
      format: options.format as 'terminal' | 'json',
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
  .action(async (path: string, options: Record<string, unknown>) => {
    const exitCode = await treeCommand(path, {
      depth: Number(options.depth),
    })
    process.exit(exitCode)
  })

// =====================================================================
// 占位命令（依赖后续 Phase 的 analyzer / renderer）
// =====================================================================

program
  .command('optimize')
  .description('🚧 生成优化建议（待 Phase 2 实现）')
  .argument('[path]', '项目路径', '.')
  .action(() => {
    logger.warn(
      'optimize 命令将在 Phase 2 实现（依赖 health/license analyzer + optimizer）',
    )
    process.exit(EXIT_CODES.OK)
  })

program
  .command('compare')
  .description('🚧 对比两次分析（待 Phase 3 实现）')
  .argument('<pathA>', '基准项目路径')
  .argument('<pathB>', '对比项目路径')
  .action(() => {
    logger.warn(
      'compare 命令将在 Phase 3 实现（依赖 analyze 完整链路 + diff 算法）',
    )
    process.exit(EXIT_CODES.OK)
  })

program
  .command('report')
  .description('🚧 生成 HTML 报告（待 Phase 2 实现）')
  .argument('[path]', '项目路径', '.')
  .action(() => {
    logger.warn('report 命令将在 Phase 2 实现（依赖 HTML renderer）')
    process.exit(EXIT_CODES.OK)
  })

// =====================================================================
// 顶层错误处理
// =====================================================================

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv)
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err))
    process.exit(EXIT_CODES.ERROR)
  }
}

void main()
