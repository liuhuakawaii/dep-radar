/**
 * 命令层共享模块
 *
 * 从 analyze.ts 提取的公共函数，供 scan / explain / doctor 等命令复用。
 */

import { DataCache } from '../data/cache.js'
import { loadUserConfig } from '../config/loader.js'
import { ConfigError, PackageNotFoundError } from '../errors/index.js'
import { renderHtmlReport } from '../report/html.js'
import { renderJsonReport } from '../report/json.js'
import { renderMarkdownReport } from '../report/markdown.js'
import { renderTerminalReport } from '../report/terminal.js'
import type { AnalysisReport } from '../types/analysis.js'
import type { DepRadarConfig } from '../types/config.js'
import type { PackageJson } from '../types/package.js'
import { readPackageJson } from '../utils/fs.js'
import { logger } from '../utils/logger.js'
import { detectPackageManager } from '../utils/packageManager.js'

// =====================================================================
// Setup
// =====================================================================

export interface ProjectSetup {
  config: DepRadarConfig
  pkg: PackageJson
  pm: ReturnType<typeof detectPackageManager>
}

export async function loadSetup(
  projectPath: string,
): Promise<ProjectSetup | null> {
  let config: DepRadarConfig
  try {
    config = await loadUserConfig(projectPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(err.message)
      return null
    }
    throw err
  }

  let pkg: PackageJson
  try {
    pkg = await readPackageJson(projectPath)
  } catch (err) {
    if (err instanceof PackageNotFoundError) {
      logger.error(err.message)
      logger.info('请确认当前目录存在 package.json，或通过参数指定项目路径')
      return null
    }
    throw err
  }

  return { config, pkg, pm: detectPackageManager(projectPath) }
}

// =====================================================================
// Cache
// =====================================================================

export function createCacheFromGlobals(options: {
  cacheEnabled?: boolean
  cacheDir?: string
  cacheTTL?: number
}): DataCache | undefined {
  if (options.cacheEnabled === false) return undefined
  return new DataCache({
    cacheDir: options.cacheDir,
    ttl: options.cacheTTL ? options.cacheTTL * 1000 : undefined,
  })
}

// =====================================================================
// Report rendering
// =====================================================================

export function renderReport(
  report: AnalysisReport,
  format: 'terminal' | 'json' | 'html' | 'markdown',
  options?: { verbose?: boolean },
): string {
  switch (format) {
    case 'json':
      return renderJsonReport(report)
    case 'html':
      return renderHtmlReport(report)
    case 'markdown':
      return renderMarkdownReport(report)
    case 'terminal':
    default:
      return renderTerminalReport(report, { verbose: options?.verbose })
  }
}

// =====================================================================
// Empty report scaffold
// =====================================================================

export function makeEmptyReport(
  project: string,
  pm: ReturnType<typeof detectPackageManager>,
): AnalysisReport {
  return {
    project,
    timestamp: new Date().toISOString(),
    packageManager: pm,
    dimensions: {
      size: false,
      health: false,
      license: false,
      security: false,
      optimize: false,
    },
    summary: {
      totalDependencies: 0,
      totalSize: 0,
      totalGzip: 0,
      maxDepth: 0,
      vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 },
      licenseIssues: 0,
      optimizationCount: 0,
      deprecatedCount: 0,
    },
    bundles: [],
    health: [],
    licenses: [],
    security: [],
    optimizations: [],
  }
}
