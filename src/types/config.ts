import type { UsageClass } from './classifier.js'

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
 * import { defineConfig } from '@liuhuakawaii/dep-radar'
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
  /** 并发请求数；默认 15，建议范围 1-20 */
  concurrency?: number
  /**
   * 是否向 Bundlephobia 写入查询记录
   *
   * 默认 false（不替用户向第三方服务写入数据）。
   * 设为 true 可帮助 Bundlephobia 建立更完整的包体积数据库。
   */
  bundlephobiaRecord?: boolean
  /**
   * 健康度评分权重
   *
   * 各维度权重之和建议为 100；不足 100 时满分不到 100，超过 100 时封顶 100。
   * 未指定的字段使用默认值。
   */
  healthWeights?: {
    /** 周下载量权重；默认 25 */
    weeklyDownloads?: number
    /** 最近发布时间权重；默认 25 */
    lastPublish?: number
    /** GitHub stars 权重；默认 15 */
    githubStars?: number
    /** 维护者数量权重；默认 10 */
    maintainers?: number
    /** TypeScript 类型支持权重；默认 10 */
    hasTypeScriptTypes?: number
    /** 下载趋势权重；默认 15 */
    downloadTrend?: number
  }
  /**
   * 依赖分类配置
   */
  classification?: {
    /**
     * 手动覆盖特定包的分类
     *
     * key 为包名，value 为 UsageClass。
     * 优先级最高，会覆盖内置规则。
     */
    overrides?: Record<string, UsageClass>
    /**
     * 运行时入口 glob 模式列表
     *
     * 默认 ['src/**'']，用于判断哪些文件中的 import 视为 runtime。
     */
    runtimeEntryGlobs?: string[]
  }
  /**
   * 构建产物分析配置
   */
  buildArtifacts?: {
    /** webpack stats.json 文件路径（相对于项目根） */
    statsFile?: string
    /** 构建输出目录路径（相对于项目根） */
    assetsDir?: string
  }
  /**
   * 依赖卫生检测配置
   */
  hygiene?: {
    /** 忽略的包名列表（不检测 unused/misplaced） */
    ignore?: string[]
    /** 允许动态 import 的包名列表（不标记为 unused） */
    allowDynamic?: string[]
    /** 强制标记为 runtime 的包名列表（不标记为 misplaced） */
    runtimePackages?: string[]
  }
}
