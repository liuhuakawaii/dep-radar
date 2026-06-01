/**
 * 许可证合规分析器
 *
 * 输入：项目 package.json
 * 输出：每个依赖的 LicenseInfo + 项目级冲突规则触发情况
 *
 * 数据流：
 *   1. 拉取每个依赖的 npm /latest manifest（轻量；只看 license 字段）
 *   2. 用 spdx-expression-parse 解析 SPDX 表达式
 *      - 简单：'MIT' → permissive
 *      - 复合：'(MIT OR Apache-2.0)' → OR 取最宽松 = permissive
 *      - 复合：'GPL-3.0 AND MIT' → AND 取最严格 = strong-copyleft
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
import type { PackageJson } from '../types/package.js'

// =====================================================================
// 公开类型
// =====================================================================

/**
 * 数据源接口（依赖注入）
 *
 * fetcher 只负责返回原始 license 字符串（兼容 string / {type} / undefined），
 * 由 analyzer 负责后续 SPDX 解析与分类。
 */
export interface LicenseFetcher {
  /** 返回原始 license 字符串；包不存在或无 license 字段返回 undefined */
  getLicense(name: string): Promise<string | undefined>
}

export interface AnalyzeLicensesOptions {
  concurrency?: number
  includeDev?: boolean
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
// 主入口
// =====================================================================

export async function analyzeLicenses(
  pkg: PackageJson,
  fetcher: LicenseFetcher,
  options: AnalyzeLicensesOptions = {},
): Promise<LicenseAnalysisResult> {
  const { concurrency = 5, includeDev = false, ignore } = options

  const deps: Record<string, string> = {
    ...pkg.dependencies,
    ...(includeDev ? pkg.devDependencies : {}),
  }

  const ignorePatterns = (ignore ?? []).map(compileIgnorePattern)
  const skipped: LicenseAnalysisResult['skipped'] = []

  const targets = Object.keys(deps).filter(
    name => !ignorePatterns.some(p => p.test(name)),
  )

  const limit = pLimit(concurrency)
  const results = await Promise.all(
    targets.map(name =>
      limit(async () => {
        try {
          return await analyzeOne(name, fetcher)
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
// 单包流水线
// =====================================================================

async function analyzeOne(
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

// =====================================================================
// 工具
// =====================================================================

function compileIgnorePattern(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
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
  raw: string | { type: string } | undefined,
): string | undefined {
  if (!raw) return undefined
  if (typeof raw === 'string') return raw
  if (typeof raw === 'object' && typeof raw.type === 'string') return raw.type
  return undefined
}
