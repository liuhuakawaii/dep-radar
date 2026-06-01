/**
 * 统一日志器
 *
 * 基于 consola，提供分等级输出（info / success / warn / error / debug）。
 * 由 CLI 全局选项 --verbose / --silent 控制日志等级。
 *
 * 业务代码应统一通过 logger 输出（而非 console.log），
 * 这样：
 * 1. 受 --silent 控制可被静默
 * 2. 受 --verbose 控制可查看调试信息
 * 3. 风格与等级图标一致
 */

import { consola, type ConsolaInstance, type LogLevel } from 'consola'

export const logger: ConsolaInstance = consola.create({
  defaults: {
    tag: 'dep-radar',
  },
})

/**
 * 日志等级语义化别名
 *
 * - silent:  关闭所有输出（CI 中静默场景）
 * - normal:  默认等级，info+ 可见
 * - verbose: 输出 debug+，方便排查问题
 */
export type LogVerbosity = 'silent' | 'normal' | 'verbose'

/**
 * consola 等级映射表
 *
 * consola 等级约定（从 v3 起）：
 *   -999=silent, 0=fatal/error, 1=warn, 2=normal/log, 3=info/success/start/ready
 *   4=debug, 5=trace, +999=verbose
 *
 * 见：https://github.com/unjs/consola#log-level
 */
const LEVEL_MAP: Record<LogVerbosity, LogLevel> = {
  silent: -999 as LogLevel,
  normal: 3 as LogLevel,
  verbose: 5 as LogLevel,
}

/**
 * 设置全局日志等级
 *
 * 由 CLI 的 --silent / --verbose 选项触发；默认 normal。
 */
export function setLogLevel(verbosity: LogVerbosity): void {
  logger.level = LEVEL_MAP[verbosity]
}
