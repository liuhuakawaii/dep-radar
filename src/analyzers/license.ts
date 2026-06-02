/**
 * 许可证合规分析器
 *
 * 输入：DependencyEntry[]（来自 DependencyInventory）+ LicenseFetcher
 * 输出：每个依赖的 LicenseInfo + 项目级冲突规则触发情况
 *
 * 数据流：
 *   1. 用 packageName@resolvedVersion 调用 fetcher 获取 license
 *   2. 用 spdx-expression-parse 解析 SPDX 表达式
 *   3. 映射到 LicenseCategory + 风险等级
 *   4. 项目级 LICENSE_CONFLICTS 规则跑一遍，给出 conflict 文案
 */

import pLimit from 'p-limit'
import spdxParse from 'spdx-expression-parse'

import {
  CATEGORY_RISK,
  CATEGORY_SEVERITY,
  LICENSE_CATEGORIES,
  LICENSE_CONFLICTS,
  type LicenseConflictRule,
} from '../config/licenses.js'
import type { LicenseCategory, LicenseInfo } from '../types/analysis.js'
import type { DependencyEntry } from '../types/inventory.js'
import type { PackageJson } from '../types/package.js'
import { buildIgnoreMatcher } from '../utils/ignore.js'

// =====================================================================
// 公开类型
// =====================================================================

/**
 * 数据源接口（依赖注入）
 *
 * fetcher 负责返回原始 license 字符串（兼容 string / {type} / undefined），
 * 由 analyzer 负责后续 SPDX 解析与分类。
 */
export interface LicenseFetcher {
  /** 返回原始 license 字符串；包不存在或无 license 字段返回 undefined */
  getLicense(name: string, version?: string): Promise<string | undefined>
}

export interface AnalyzeLicensesOptions {
  concurrency?: number
  /** @deprecated 使用 entries 的 declaredIn 过滤代替 */
  includeDev?: boolean
  /** @deprecated 使用 buildIgnoreMatcher 代替 */
  ignore?: string[]
}

export interface LicenseAnalysisResult {
  licenses: LicenseInfo[]
  /** 命中的项目级冲突规则（用于退出码判定 / CLI 提示） */
  projectConflicts: LicenseConflictRule[]
  /** 因无法解析被跳过的包 */
  skipped: Array<{ name: string; reason: string }>
}

// =====================================================================
// 主入口（新版：接受 DependencyEntry[]）
// =====================================================================

export async function analyzeLicenses(
  entries: DependencyEntry[],
  fetcher: LicenseFetcher,
  options: AnalyzeLicensesOptions = {},
): Promise<LicenseAnalysisResult> {
  const { concurrency = 5, ignore = [] } = options

  const isIgnored = buildIgnoreMatcher(ignore)
  const skipped: LicenseAnalysisResult['skipped'] = []

  const targets = entries.filter(e => !isIgnored(e.name))

  const limit = pLimit(concurrency)
  const results = await Promise.all(
    targets.map(entry =>
      limit(async () => {
        try {
          return await analyzeOne(entry, fetcher)
        } catch (err) {
          skipped.push({
            name: entry.name,
            reason: err instanceof Error ? err.message : String(err),
          })
          return null
        }
      }),
    ),
  )

  const licenses = results.filter((x): x is LicenseInfo => x !== null)

  // 项目级冲突规则
  const allCats = licenses.map(l => l.licenseType)
  const projectConflicts = LICENSE_CONFLICTS.filter(rule => rule.match(allCats))

  return { licenses, projectConflicts, skipped }
}

// =====================================================================
// 旧版兼容入口（接受 PackageJson）
// =====================================================================

/**
 * 旧版入口：接受 PackageJson
 *
 * @deprecated 新代码应使用 buildInventory() + analyzeLicenses(entries, fetcher)
 */
export async function analyzeLicensesFromPackage(
  pkg: PackageJson,
  fetcher: LicenseFetcher,
  options: AnalyzeLicensesOptions = {},
): Promise<LicenseAnalysisResult> {
  const { concurrency = 5, includeDev = false, ignore = [] } = options

  const deps: Record<string, string> = {
    ...pkg.dependencies,
    ...(includeDev ? pkg.devDependencies : {}),
  }

  const isIgnored = buildIgnoreMatcher(ignore)
  const skipped: LicenseAnalysisResult['skipped'] = []

  const targets = Object.keys(deps).filter(name => !isIgnored(name))

  const limit = pLimit(concurrency)
  const results = await Promise.all(
    targets.map(name =>
      limit(async () => {
        try {
          return await analyzeOneLegacy(name, fetcher)
        } catch (err) {
          skipped.push({
            name,
            reason: err instanceof Error ? err.message : String(err),
          })
          return null
        }
      }),
    ),
  )

  const licenses = results.filter((x): x is LicenseInfo => x !== null)

  // 项目级冲突规则
  const allCats = licenses.map(l => l.licenseType)
  const projectConflicts = LICENSE_CONFLICTS.filter(rule => rule.match(allCats))

  return { licenses, projectConflicts, skipped }
}

// =====================================================================
// 单包流水线（新版：使用 entry）
// =====================================================================

async function analyzeOne(
  entry: DependencyEntry,
  fetcher: LicenseFetcher,
): Promise<LicenseInfo> {
  const raw = await fetcher.getLicense(entry.packageName, entry.resolvedVersion)
  const licenseStr = (raw ?? '').trim()

  if (!licenseStr) {
    return {
      name: entry.name,
      version: entry.resolvedVersion,
      license: 'UNKNOWN',
      licenseType: 'unknown',
      risk: CATEGORY_RISK.unknown,
      conflict: '未声明 license 字段，需人工核实',
      source: `resolved:${entry.resolvedVersion}`,
      rawLicense: raw ?? undefined,
      normalizedLicense: undefined,
      needsHumanReview: true,
      humanReviewReason: 'license 字段缺失或为空',
    }
  }

  // 特殊处理：SEE LICENSE IN ... → 需要人工查看 license 文件
  if (/^SEE LICENSE IN/i.test(licenseStr)) {
    return {
      name: entry.name,
      version: entry.resolvedVersion,
      license: licenseStr,
      licenseType: 'unknown',
      risk: CATEGORY_RISK.unknown,
      conflict: '指向 license 文件，需人工核实',
      source: `resolved:${entry.resolvedVersion}`,
      rawLicense: raw,
      normalizedLicense: licenseStr,
      needsHumanReview: true,
      humanReviewReason: `license 字段为 "${licenseStr}"，需查看实际 license 文件`,
    }
  }

  // 特殊处理：UNLICENSED / proprietary / Commercial → 商业/私有授权
  if (/^(UNLICENSED|proprietary|commercial)$/i.test(licenseStr.trim())) {
    return {
      name: entry.name,
      version: entry.resolvedVersion,
      license: licenseStr,
      licenseType: 'proprietary',
      risk: CATEGORY_RISK.proprietary,
      conflict: '私有/商业授权，需确认授权',
      source: `resolved:${entry.resolvedVersion}`,
      rawLicense: raw,
      normalizedLicense: licenseStr,
      needsHumanReview: true,
      humanReviewReason: `license 为 "${licenseStr}"，需确认商业授权`,
    }
  }

  const category = parseLicenseCategory(licenseStr)
  const risk = CATEGORY_RISK[category]

  return {
    name: entry.name,
    version: entry.resolvedVersion,
    license: licenseStr,
    licenseType: category,
    risk,
    conflict: explainSinglePackage(category),
    source: `resolved:${entry.resolvedVersion}`,
    rawLicense: raw,
    normalizedLicense: licenseStr,
    needsHumanReview: category === 'unknown',
    humanReviewReason:
      category === 'unknown' ? `无法识别 license "${licenseStr}"` : undefined,
  }
}

/**
 * 旧版单包流水线（不带版本信息）
 */
async function analyzeOneLegacy(
  name: string,
  fetcher: LicenseFetcher,
): Promise<LicenseInfo> {
  const raw = await fetcher.getLicense(name)
  const licenseStr = (raw ?? '').trim()

  if (!licenseStr) {
    return {
      name,
      license: 'UNKNOWN',
      licenseType: 'unknown',
      risk: CATEGORY_RISK.unknown,
      conflict: '未声明 license 字段，需人工核实',
      source: 'latest',
    }
  }

  const category = parseLicenseCategory(licenseStr)
  const risk = CATEGORY_RISK[category]

  return {
    name,
    license: licenseStr,
    licenseType: category,
    risk,
    conflict: explainSinglePackage(category),
    source: 'latest',
  }
}

/**
 * 解析 SPDX 表达式为 LicenseCategory
 *
 * 简单标识 → 查表
 * 复合表达式 → 用 spdx-expression-parse 拿 AST，递归取最宽松/最严格
 * 解析失败 → 当作 unknown（用户写了非标 license 字符串）
 *
 * 导出以供单元测试。
 */
export function parseLicenseCategory(license: string): LicenseCategory {
  // 1) 简单查表（覆盖最常见情况，避免 spdx-parser 的开销）
  const direct = LICENSE_CATEGORIES[license]
  if (direct) return direct

  // 2) 尝试 SPDX 解析
  let ast: SpdxAst
  try {
    ast = spdxParse(license) as SpdxAst
  } catch {
    // 非 SPDX 表达式（如 "(see LICENSE)" / "Custom"）
    return 'unknown'
  }

  return categorizeAst(ast)
}

// spdx-expression-parse 返回的 AST 结构
type SpdxAst =
  | { license: string; plus?: boolean; exception?: string }
  | { conjunction: 'and' | 'or'; left: SpdxAst; right: SpdxAst }

function categorizeAst(ast: SpdxAst): LicenseCategory {
  if ('license' in ast) {
    return LICENSE_CATEGORIES[ast.license] ?? 'unknown'
  }
  const leftCat = categorizeAst(ast.left)
  const rightCat = categorizeAst(ast.right)
  if (ast.conjunction === 'or') {
    // 取最宽松 = severity 最低
    return CATEGORY_SEVERITY[leftCat] <= CATEGORY_SEVERITY[rightCat]
      ? leftCat
      : rightCat
  }
  // and: 取最严格 = severity 最高
  return CATEGORY_SEVERITY[leftCat] >= CATEGORY_SEVERITY[rightCat]
    ? leftCat
    : rightCat
}

/**
 * 单包级 conflict 文案
 *
 * 与项目级 LICENSE_CONFLICTS 不同——这里只针对单包给一句话提示，
 * 用于 LicenseInfo.conflict 字段在表格中展示。
 */
function explainSinglePackage(category: LicenseCategory): string | undefined {
  switch (category) {
    case 'strong-copyleft':
      return 'GPL/AGPL 类传染性强，可能要求项目整体开源'
    case 'proprietary':
      return '私有/UNLICENSED，需确认授权'
    case 'unknown':
      return '无法识别，请人工核实'
    case 'weak-copyleft':
      return '修改源码部分需开源；动态链接通常可商用'
    case 'permissive':
      return undefined
  }
}

/**
 * 把 npm manifest 中的 license 字段统一为字符串
 *
 * 兼容形态：
 *   - "MIT"
 *   - { type: "MIT", url: "..." }（旧版规范）
 *   - undefined（未声明）
 *
 * 导出供 fetcher 使用。
 */
export function normalizeLicenseField(
  raw: string | { type: string } | Array<{ type: string }> | undefined,
): string | undefined {
  if (!raw) return undefined
  if (typeof raw === 'string') return raw
  // 旧格式：{ type: "MIT", url: "..." }
  if (
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    typeof raw.type === 'string'
  )
    return raw.type
  // 旧格式：[{ type: "MIT" }, { type: "ISC" }] → "MIT OR ISC"
  if (Array.isArray(raw) && raw.length > 0) {
    const types = raw.map(item => item.type).filter(Boolean)
    if (types.length === 1) return types[0]
    if (types.length > 1) return `(${types.join(' OR ')})`
  }
  return undefined
}
