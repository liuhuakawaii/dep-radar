/**
 * dep-radar 库入口
 *
 * 暴露给外部使用者（写 dep-radar.config.ts 或以编程方式调用）的公开 API。
 * 业务功能将随 PLAN-v2.md Step 3 之后的实现陆续补全。
 */

import type { DepRadarConfig } from './types/config.js'

/**
 * 公开类型 re-export
 *
 * 外部用户可通过 `import type { DepRadarConfig } from 'dep-radar'` 引用。
 */
export type {
  DepRadarConfig,
  ReplacementRule,
  PackageManager,
  AnalysisReport,
  BundleInfo,
  HealthInfo,
  LicenseInfo,
  LicenseCategory,
  SecurityInfo,
  Vulnerability,
  OptimizationSuggestion,
  OptimizationType,
} from './types/index.js'

export const VERSION = '0.1.0'

/**
 * 用户配置文件助手，提供类型推导与字段补全。
 *
 * 不做任何运行时校验，仅做类型透传。
 *
 * @example
 * ```ts
 * // dep-radar.config.ts
 * import { defineConfig } from 'dep-radar'
 *
 * export default defineConfig({
 *   budget: { totalGzip: 500 * 1024 },
 *   ignore: ['@internal/*'],
 * })
 * ```
 */
export function defineConfig(config: DepRadarConfig): DepRadarConfig {
  return config
}
