/**
 * dep-radar 库入口
 *
 * 当前为脚手架阶段，仅暴露最小公开 API。
 * 详细类型与功能将随 PLAN-v2.md Step 2 之后的实现陆续补全。
 */

export const VERSION = '0.1.0'

/**
 * 用户配置文件助手，提供类型推导。
 *
 * @example
 * ```ts
 * // dep-radar.config.ts
 * import { defineConfig } from 'dep-radar'
 *
 * export default defineConfig({
 *   budget: { totalGzip: 500 * 1024 },
 * })
 * ```
 */
export function defineConfig<T extends Record<string, unknown>>(config: T): T {
  return config
}
