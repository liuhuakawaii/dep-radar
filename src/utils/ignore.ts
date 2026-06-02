/**
 * 共享的 ignore 模式匹配工具
 *
 * 各 analyzer（bundle / license / health / security）统一使用此处的实现，
 * 避免四处各自维护不一致的 ignore 逻辑。
 *
 * 支持：
 * - 精确匹配：`'lodash'`           → `name === 'lodash'`
 * - 通配：`'@internal/*'`      → `name.startsWith('@internal/')`
 */

/**
 * 编译一条 ignore 模式为匹配函数
 *
 * 支持：
 * - 精确：`'lodash'`           → `name === 'lodash'`
 * - 通配：`'@internal/*'`      → `name.startsWith('@internal/')`
 */
export function compileIgnorePattern(
  pattern: string,
): (name: string) => boolean {
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1) // 保留末尾的 '/'
    return (name: string) => name.startsWith(prefix)
  }
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1)
    return (name: string) => name.startsWith(prefix)
  }
  return (name: string) => name === pattern
}

/**
 * 批量编译 ignore 模式列表并返回统一的匹配函数
 */
export function buildIgnoreMatcher(
  ignore: string[],
): (name: string) => boolean {
  if (ignore.length === 0) return () => false
  const matchers = ignore.map(compileIgnorePattern)
  return (name: string) => matchers.some(m => m(name))
}
