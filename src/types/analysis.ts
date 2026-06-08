/**
 * 分析结果相关的领域类型
 *
 * 每个分析器（bundle / health / license / security / optimizer）
 * 都基于这里的类型产出结果，最终聚合为 AnalysisReport。
 */

import type { UsageClass } from './classifier.js'
import type { BuildArtifactResult } from '../analyzers/buildArtifacts.js'
import type { DuplicateVersionInfo } from '../analyzers/duplicateVersions.js'
import type { HygieneIssue } from '../analyzers/dependencyHygiene.js'
import type { DependencyInventory } from './inventory.js'
import type { PackageManager } from './package.js'

// =====================================================================
// 包体积分析（bundle analyzer）
// =====================================================================

export interface BundleInfo {
  name: string
  version: string
  /** lockfile / node_modules 中的实际版本（与 version 可能不同） */
  resolvedVersion?: string
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
  /** 是否为直接依赖 */
  isDirect: boolean
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
  /** 是否为直接依赖 */
  isDirect: boolean
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
  /** 实际解析版本（来自 lockfile / node_modules） */
  version?: string
  /** 原始许可证字符串（如 "MIT"、"(MIT OR Apache-2.0)") */
  license: string
  licenseType: LicenseCategory
  /** 法律风险评级 */
  risk: 'low' | 'medium' | 'high'
  /** 命中冲突规则时给出的描述（如"GPL 可能要求开源"） */
  conflict?: string
  /** 许可证数据来源 */
  source?: string
  /** 原始 license 字段（未 normalize） */
  rawLicense?: string
  /** 归一化后的 license 字段（如从 licenses: [{type}] 提取） */
  normalizedLicense?: string
  /** 是否需要人工审核（UNLICENSED/proprietary/Commercial/SEE LICENSE IN） */
  needsHumanReview?: boolean
  /** 人工审核原因 */
  humanReviewReason?: string
  /** 是否为直接依赖 */
  isDirect: boolean
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
  /** npm audit vulnerability ID */
  id?: string
  /** 漏洞来源（如 GitHub Advisory URL） */
  source?: string
  /** 受影响版本范围 */
  range?: string
  /** 漏洞传递路径（直接漏洞名或 CVE） */
  via?: string[]
  /** 受影响的包列表 */
  effects?: string[]
  /** 修复版本号 */
  fixVersion?: string
  /** 修复命令（如 npm audit fix） */
  fixCommand?: string
}

export interface SecurityInfo {
  name: string
  vulnerabilities: Vulnerability[]
  totalVulnerabilities: number
  /** 该包所有漏洞中的最高严重度 */
  highestSeverity: 'low' | 'moderate' | 'high' | 'critical' | 'none'
  /** 漏洞范围：prod（生产依赖）/ dev（开发依赖）/ mixed / unknown */
  scope?: 'prod' | 'dev' | 'mixed' | 'unknown'
  /** 是否为直接依赖 */
  isDirect?: boolean
  /** 从 root 到漏洞包的依赖路径 */
  dependencyPaths?: string[]
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
  /** 建议置信度 */
  confidence?: 'high' | 'medium' | 'low'
  /** 可操作性 */
  actionability?: 'ready' | 'needs-review' | 'info'
  /** 证据列表 */
  evidence?: Array<{
    source: string
    file?: string
    line?: number
    detail: string
  }>
  /** 前提假设 */
  assumptions?: string[]
  /** 前置条件 */
  preconditions?: string[]
  /** 阻塞因素 */
  blockedBy?: string[]
  /** 建议操作步骤 */
  suggestedSteps?: string[]
}

// =====================================================================
// 顶层报告聚合
// =====================================================================

export interface AnalysisReport {
  project: string
  /** 分析时间（ISO 字符串） */
  timestamp: string
  packageManager: PackageManager
  /** 依赖清单（来自 lockfile / node_modules / package.json） */
  inventory?: DependencyInventory
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
  /**
   * 数据完整性与降级信息。
   *
   * skipped 表示某个维度没有成功覆盖全部目标，warnings 表示分析过程中
   * 发生过降级或高噪声提示。报告层必须把它和“没有发现问题”区分开。
   */
  diagnostics?: {
    partial: boolean
    skipped: Array<{
      dimension:
        | 'inventory'
        | 'size'
        | 'health'
        | 'license'
        | 'security'
        | 'build-artifacts'
      name: string
      reason: string
    }>
    warnings: string[]
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
    /** 依赖分类统计 */
    classified?: Record<UsageClass, number>
  }
  bundles: BundleInfo[]
  health: HealthInfo[]
  licenses: LicenseInfo[]
  security: SecurityInfo[]
  optimizations: OptimizationSuggestion[]
  /** 依赖卫生问题 */
  hygieneIssues?: HygieneIssue[]
  /** 多版本并存问题 */
  duplicateVersions?: DuplicateVersionInfo[]
  /** 构建产物分析结果 */
  buildArtifacts?: BuildArtifactResult
}

// =====================================================================
// diff 命令结果
// =====================================================================

export interface DiffReport {
  before: { project: string; timestamp: string }
  after: { project: string; timestamp: string }
  summary: {
    totalGzip: { before: number; after: number }
    totalSize: { before: number; after: number }
    totalDependencies: { before: number; after: number }
    deprecatedCount: { before: number; after: number }
    vulnerabilities: {
      before: { critical: number; high: number; moderate: number; low: number }
      after: { critical: number; high: number; moderate: number; low: number }
    }
  }
  bundles: {
    added: BundleInfo[]
    removed: BundleInfo[]
    changed: Array<{
      name: string
      beforeGzip: number
      afterGzip: number
      delta: number
    }>
  }
  health: {
    newlyDeprecated: Array<{ name: string; message?: string }>
    scoreChanges: Array<{ name: string; before: number; after: number }>
  }
  security: {
    new: SecurityInfo[]
    resolved: SecurityInfo[]
  }
}

// =====================================================================
// explain 命令结果
// =====================================================================

/**
 * `dep-radar explain <package>` 的输出类型
 *
 * 解释单个依赖为什么存在于项目中，以及是否可以删除/移动/升级。
 */
export interface ExplainResult {
  /** 包名 */
  packageName: string
  /** 实际安装版本 */
  version: string
  /** 是否为直接依赖 */
  isDirect: boolean
  /** 声明位置 */
  declaredIn:
    | 'dependencies'
    | 'devDependencies'
    | 'peerDependencies'
    | 'optionalDependencies'
    | 'transitive'
  /** 是否被源码 import/require */
  isImported: boolean
  /** 源码引用位置（最多 5 个） */
  importLocations?: Array<{
    file: string
    line: number
    specifier: string
    importKind: string
  }>
  /** 来源 bucket */
  sourceBucket?: 'src' | 'test' | 'config' | 'script'
  /** 依赖使用分类 */
  usageClass?: string
  /** transitive 时的最短依赖路径 */
  dependencyPath?: string[]
  /** 是否可以移除 */
  canRemove: boolean | 'maybe'
  /** 建议操作 */
  suggestedAction: string
  /** 建议操作命令（如 "pnpm remove X"） */
  suggestedCommand?: string
}
