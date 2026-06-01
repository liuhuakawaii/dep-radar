/**
 * 用户配置文件加载
 *
 * 基于 cosmiconfig，支持多种位置/格式：
 * - `dep-radar.config.ts` / `.js` / `.cjs` / `.mjs` / `.json`
 * - `.deprdarrc` / `.deprdarrc.json` / `.deprdarrc.yaml` / `.deprdarrc.yml`
 * - `package.json` 中的 `"dep-radar"` 字段
 *
 * 解析失败时抛 ConfigError，让 CLI 顶层捕获并友好提示。
 */

import { cosmiconfig } from 'cosmiconfig'

import { ConfigError } from '../errors/index.js'
import type { DepRadarConfig } from '../types/config.js'

const MODULE_NAME = 'dep-radar'

/**
 * 加载用户配置；找不到时返回空对象（不报错）
 *
 * @param cwd 起始搜索目录；cosmiconfig 会从该目录向上查找
 */
export async function loadUserConfig(cwd: string): Promise<DepRadarConfig> {
  const explorer = cosmiconfig(MODULE_NAME, {
    searchPlaces: [
      'package.json',
      `.${MODULE_NAME}rc`,
      `.${MODULE_NAME}rc.json`,
      `.${MODULE_NAME}rc.yaml`,
      `.${MODULE_NAME}rc.yml`,
      `.${MODULE_NAME}rc.js`,
      `.${MODULE_NAME}rc.cjs`,
      `${MODULE_NAME}.config.js`,
      `${MODULE_NAME}.config.cjs`,
      `${MODULE_NAME}.config.mjs`,
      `${MODULE_NAME}.config.ts`,
    ],
  })

  let result
  try {
    result = await explorer.search(cwd)
  } catch (err) {
    throw new ConfigError(
      `加载配置失败：${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }

  if (!result || result.isEmpty) {
    return {}
  }

  const config = result.config as unknown
  if (typeof config !== 'object' || config === null) {
    throw new ConfigError(`配置文件内容不是对象：${result.filepath}`)
  }

  return config as DepRadarConfig
}
