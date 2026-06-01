/**
 * 许可证分类表与项目级冲突规则
 *
 * 设计原则：
 * - 只收录主流 SPDX 标识；未列出的归为 'unknown'，由人工核实
 * - 分类只关心"传染性强弱"，不区分许可证版本细节
 * - 项目级规则（LICENSE_CONFLICTS）由 analyzer 在所有依赖跑完后统一应用
 */

import type { LicenseCategory } from '../types/analysis.js'

// =====================================================================
// SPDX → category 映射
// =====================================================================

/**
 * 主流许可证的分类
 *
 * 大小写敏感（与 SPDX 官方一致）；analyzer 内部会用 normalize() 转换大小写。
 *
 * 不在表中的许可证归 'unknown'（由 normalizeLicenseCategory 决定）。
 */
export const LICENSE_CATEGORIES: Record<string, LicenseCategory> = {
  // ---- permissive ----
  MIT: 'permissive',
  ISC: 'permissive',
  '0BSD': 'permissive',
  'BSD-2-Clause': 'permissive',
  'BSD-3-Clause': 'permissive',
  'BSD-3-Clause-Clear': 'permissive',
  'Apache-2.0': 'permissive',
  'CC0-1.0': 'permissive',
  'CC-BY-4.0': 'permissive',
  Unlicense: 'permissive',
  Zlib: 'permissive',
  'BlueOak-1.0.0': 'permissive',
  WTFPL: 'permissive',
  Python: 'permissive', // PSF-2.0 别名
  'PSF-2.0': 'permissive',

  // ---- weak-copyleft ----
  'LGPL-2.0': 'weak-copyleft',
  'LGPL-2.0-only': 'weak-copyleft',
  'LGPL-2.0-or-later': 'weak-copyleft',
  'LGPL-2.1': 'weak-copyleft',
  'LGPL-2.1-only': 'weak-copyleft',
  'LGPL-2.1-or-later': 'weak-copyleft',
  'LGPL-3.0': 'weak-copyleft',
  'LGPL-3.0-only': 'weak-copyleft',
  'LGPL-3.0-or-later': 'weak-copyleft',
  'MPL-1.1': 'weak-copyleft',
  'MPL-2.0': 'weak-copyleft',
  'EPL-1.0': 'weak-copyleft',
  'EPL-2.0': 'weak-copyleft',
  'CDDL-1.0': 'weak-copyleft',
  'CDDL-1.1': 'weak-copyleft',

  // ---- strong-copyleft ----
  'GPL-2.0': 'strong-copyleft',
  'GPL-2.0-only': 'strong-copyleft',
  'GPL-2.0-or-later': 'strong-copyleft',
  'GPL-3.0': 'strong-copyleft',
  'GPL-3.0-only': 'strong-copyleft',
  'GPL-3.0-or-later': 'strong-copyleft',
  'AGPL-3.0': 'strong-copyleft',
  'AGPL-3.0-only': 'strong-copyleft',
  'AGPL-3.0-or-later': 'strong-copyleft',

  // ---- proprietary / 私有 ----
  UNLICENSED: 'proprietary',
  'SEE LICENSE IN LICENSE': 'proprietary',
  'SEE LICENSE IN LICENSE.md': 'proprietary',
}

/**
 * 类别 → 风险等级
 *
 * 用于 LicenseInfo.risk 字段。
 */
export const CATEGORY_RISK: Record<LicenseCategory, 'low' | 'medium' | 'high'> =
  {
    permissive: 'low',
    'weak-copyleft': 'medium',
    'strong-copyleft': 'high',
    proprietary: 'high',
    unknown: 'medium',
  }

/**
 * 类别 → "传染性 / 风险" 排序权重
 *
 * 用于复合表达式解析时取最宽松或最严格的分类：
 * - OR 取最小（最宽松）
 * - AND 取最大（最严格）
 */
export const CATEGORY_SEVERITY: Record<LicenseCategory, number> = {
  permissive: 0,
  unknown: 1,
  'weak-copyleft': 2,
  proprietary: 3,
  'strong-copyleft': 4,
}

// =====================================================================
// 项目级冲突规则
// =====================================================================

export interface LicenseConflictRule {
  /** 命中条件：传入所有依赖的 category 数组，返回 true 触发规则 */
  match: (categories: LicenseCategory[]) => boolean
  /** 给用户的解释 */
  message: string
  severity: 'low' | 'medium' | 'high'
}

export const LICENSE_CONFLICTS: LicenseConflictRule[] = [
  {
    match: cats => cats.includes('strong-copyleft'),
    message:
      '依赖中存在 GPL/AGPL 等强 Copyleft 许可证，可能要求你的项目开源；如为商业闭源项目请评估法律风险',
    severity: 'high',
  },
  {
    match: cats => cats.includes('proprietary'),
    message: '存在标注为私有/UNLICENSED 的依赖，请确认授权',
    severity: 'high',
  },
  {
    match: cats => cats.includes('unknown'),
    message: '存在无法识别许可证的依赖，请人工核实',
    severity: 'medium',
  },
]
