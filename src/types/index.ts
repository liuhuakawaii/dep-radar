/**
 * 类型 barrel
 *
 * 业务代码统一通过 `import type { ... } from '../types/index.js'` 引用，
 * 便于后续重构与重命名。
 *
 * 仅 re-export 类型，无运行时副作用。
 */

export type { PackageJson, PackageManager } from './package.js'

export type {
  BundleInfo,
  HealthInfo,
  LicenseCategory,
  LicenseInfo,
  Vulnerability,
  SecurityInfo,
  OptimizationType,
  OptimizationSuggestion,
  AnalysisReport,
} from './analysis.js'

export type {
  PkgSizeResponse,
  NpmRegistryResponse,
  NpmDownloadsResponse,
  NpmDownloadsRangeResponse,
  GithubRepoResponse,
} from './api.js'

export type { DepRadarConfig, ReplacementRule } from './config.js'
