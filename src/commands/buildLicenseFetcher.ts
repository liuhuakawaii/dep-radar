/**
 * LicenseFetcher 工厂
 *
 * 包装 npm `/latest` manifest 的 license 字段为 analyzer 所需的接口。
 *
 * 容错策略：
 * - 包不存在（PackageNotFoundError）→ 抛出，让 analyzer 记入 skipped
 * - 其他网络错误 → 抛出，让 analyzer 记入 skipped
 * - 包存在但 license 字段缺失/空 → 返回 undefined（analyzer 会把它判为 unknown）
 */

import {
  normalizeLicenseField,
  type LicenseFetcher,
} from '../analyzers/license.js'
import { getPackageInfo } from '../data/npm.js'

export function buildLicenseFetcher(): LicenseFetcher {
  return {
    getLicense: async name => {
      const manifest = await getPackageInfo(name)
      return normalizeLicenseField(manifest.license)
    },
  }
}
