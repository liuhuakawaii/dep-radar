/**
 * 分析结果相关的领域类型
 *
 * 每个分析器（bundle / health / license / security / optimizer）
 * 都基于这里的类型产出结果，最终聚合为 AnalysisReport。
 */

import type { PackageManager } from './package.js'

// =====================================================================
// 包体积分析（bundle analyzer）
// =====================================================================

export interface BundleInfo {
  name: string
  version: string
  /** minified 字节数 */
  size: number
  /** gzip 后字节数 */
  gzip: number
  /** brotli 后字节数（仅 pkg-size.dev 提供） */
  brotli?: number
  /** 直接依赖数 */
  dependencyCount: number
  /** 是否提供 ESM 入口（package.json#module） */
  hasJSModule: boolean
  /** 是否提供 jsnext:main 入口（老规范） */
  hasJSNext: boolean
  /** 数据来源（pkg-size / bundlephobia / local esbuild） */
  source: 'pkg-size' | 'bundlephobia' | 'local' | 'unknown'
  /** 数据获取失败原因（如"私有包"、"网络超时"） */
  error?: string
}

// =====================================================================
// 健康度分析（health analyzer）
// =====================================================================

export interface HealthInfo {
  name: string
  /** 周下载量（npm registry） */
  weeklyDownloads: number
  /** 下载量趋势（基于近一月的前半 vs 后半比较） */
  downloadTrend: 'up' | 'down' | 'stable'
  /** 最近发布时间（ISO 字符串） */
  lastPublish: string
  /** 维护者人数（npm registry maintainers） */
  maintainers: number
  /** GitHub open issues 数（若有 repo） */
  openIssues: number
  /** GitHub stars（可选，无 repo 信息时为空） */
  githubStars?: number
  /** GitHub 最近一次 push 时间（ISO） */
  githubLastPush?: string
  /** 是否已被 npm 标记为 deprecated */
  deprecated: boolean
  /** deprecated 时 npm registry 给出的原因字符串 */
  deprecatedMessage?: string
  /** 是否提供 TypeScript 类型（types/typings 字段或 @types/* 包） */
  hasTypeScriptTypes: boolean
  /** 综合健康度 0-100；算法见 src/analyzers/health.ts */
  healthScore: number
}

// =====================================================================
// 许可证分析（license analyzer）
// =====================================================================

/**
 * 许可证分类
 *
 * - permissive: 宽松许可（MIT/BSD/ISC/Apache-2.0 等）
 * - weak-copyleft: 弱传染（LGPL/MPL/EPL）
 * - strong-copyleft: 强传染（GPL/AGPL）
 * - proprietary: 商业/私有
 * - unknown: 无法识别
 */
export type LicenseCategory =
  | 'permissive'
  | 'weak-copyleft'
  | 'strong-copyleft'
  | 'proprietary'
  | 'unknown'

export interface LicenseInfo {
  name: string
  /** 原始许可证字符串（如 "MIT"、"(MIT OR Apache-2.0)") */
  license: string
  licenseType: LicenseCategory
  /** 法律风险评级 */
  risk: 'low' | 'medium' | 'high'
  /** 命中冲突规则时给出的描述（如"GPL 可能要求开源"） */
  conflict?: string
}

// =====================================================================
// 安全审计（security analyzer）
// =====================================================================

export interface Vulnerability {
  severity: 'low' | 'moderate' | 'high' | 'critical'
  title: string
  url: string
  /** 是否存在已发布的修复版本 */
  fixAvailable: boolean
}

export interface SecurityInfo {
  name: string
  vulnerabilities: Vulnerability[]
  totalVulnerabilities: number
  /** 该包所有漏洞中的最高严重度 */
  highestSeverity: 'low' | 'moderate' | 'high' | 'critical' | 'none'
}

// =====================================================================
// 优化建议（optimizer）
// =====================================================================

/**
 * 优化建议类型
 *
 * - replace: 替换为更优替代包
 * - tree-shake: 通过按需引入或 ESM 改写实现 tree-shaking
 * - import-style: 改变 import 写法（如 lodash 子路径引用）
 * - remove: 移除冗余依赖
 * - upgrade: 升级到更新版本以获得修复或体积优化
 * - deprecated: 该包已废弃，建议替换
 */
export type OptimizationType =
  | 'replace'
  | 'tree-shake'
  | 'import-style'
  | 'remove'
  | 'upgrade'
  | 'deprecated'

export interface OptimizationSuggestion {
  packageName: string
  type: OptimizationType
  priority: 'high' | 'medium' | 'low'
  description: string
  /** 推荐的替代方案名（如 "dayjs"） */
  alternative?: string
  /** 预估可节省的字节数 */
  estimatedSavings?: number
  /** 预估可节省的百分比（0-100） */
  estimatedSavingsPercent?: number
  /**
   * 迁移难度
   * - low: drop-in 替换
   * - medium: 需小幅适配
   * - high: 需重构
   */
  difficulty: 'low' | 'medium' | 'high'
  /** 替代是否会引入破坏性 API 变更 */
  breakingChange: boolean
  /** 不适用场景说明（避免误导用户） */
  caveats?: string[]
  /** 迁移指南链接 */
  migrationGuide?: string
}

// =====================================================================
// 顶层报告聚合
// =====================================================================

export interface AnalysisReport {
  project: string
  /** 分析时间（ISO 字符串） */
  timestamp: string
  packageManager: PackageManager
  /**
   * 本次分析实际运行的维度。
   *
   * 渲染层据此决定是否输出对应 section——未运行的维度不应作为"无数据"展示，
   * 避免误导用户以为该维度尚未实现。
   */
  dimensions: {
    size: boolean
    health: boolean
    license: boolean
    security: boolean
    optimize: boolean
  }
  summary: {
    totalDependencies: number
    totalSize: number
    totalGzip: number
    /** 依赖树最大深度 */
    maxDepth: number
    vulnerabilities: {
      critical: number
      high: number
      moderate: number
      low: number
    }
    /** 命中许可证冲突规则的数量 */
    licenseIssues: number
    /** 生成的优化建议数 */
    optimizationCount: number
    /** 被标记为 deprecated 的包数 */
    deprecatedCount: number
  }
  bundles: BundleInfo[]
  health: HealthInfo[]
  licenses: LicenseInfo[]
  security: SecurityInfo[]
  optimizations: OptimizationSuggestion[]
}
