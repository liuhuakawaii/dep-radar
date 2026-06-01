/**
 * 用户配置文件（dep-radar.config.ts）相关的类型
 *
 * 加载机制由 src/config/loader.ts 通过 cosmiconfig 实现，
 * 这里仅定义类型契约。
 */

// =====================================================================
// 替代方案规则
// =====================================================================

/**
 * 单条替代建议规则
 *
 * 内置规则见 src/config/replacements.ts；用户可通过
 * DepRadarConfig.replacements 追加或覆盖。
 */
export interface ReplacementRule {
  /** 给用户的展示文案（如 "dayjs" 或 "原生 fetch") */
  alternative: string
  /** 实际可安装的 npm 包名；若替代是平台原生 API，则为空字符串 */
  altPackage: string
  /** 预估节省百分比（0-100） */
  estimatedSavingsPercent: number
  /** 迁移难度：drop-in / 需小幅适配 / 需重构 */
  difficulty: 'low' | 'medium' | 'high'
  /** 替代是否会引入破坏性 API 变更 */
  breakingChange: boolean
  /** 一句话理由（终端报告会展示） */
  description: string
  /** 不适用场景说明（避免误导，例如"仅支持 v4 UUID"） */
  caveats?: string[]
  /** 迁移指南链接 */
  migrationGuide?: string
}

// =====================================================================
// 顶层用户配置
// =====================================================================

/**
 * dep-radar 用户配置
 *
 * 支持的配置文件位置（由 cosmiconfig 自动发现）：
 * - dep-radar.config.ts / .js / .json
 * - .deprdarrc / .deprdarrc.json
 * - package.json 的 "dep-radar" 字段
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
export interface DepRadarConfig {
  /**
   * 体积预算
   *
   * CI 中超过则以退出码 3 (BUDGET_EXCEEDED) 失败。
   */
  budget?: {
    /** 项目总 gzip 体积上限（字节） */
    totalGzip?: number
    /** 单包体积上限 map：{ "moment": 0 } 表示禁止使用 moment */
    perPackage?: Record<string, number>
  }
  /**
   * 忽略的包，不参与任何分析
   *
   * 支持 glob 模式（如 "@internal/*"），匹配规则由分析器内部处理。
   */
  ignore?: string[]
  /**
   * 自定义替代方案
   *
   * key 为包名，value 为规则；会与内置 REPLACEMENTS 表合并，
   * 同名时用户配置优先。
   */
  replacements?: Record<string, ReplacementRule>
  /**
   * 数据源优先级
   *
   * 默认 ['pkg-size', 'bundlephobia']；
   * 加入 'local' 可启用本地 esbuild fallback（适合离线/私有包场景）。
   */
  dataSource?: Array<'pkg-size' | 'bundlephobia' | 'local'>
  /** 自定义 npm registry URL */
  registry?: string
  /** 缓存 TTL（秒）；默认 3600 */
  cacheTTL?: number
}
