/**
 * 与 package.json 文件结构相关的基础类型
 */

/**
 * package.json 的最小可消费形状
 *
 * 注意：仅声明 dep-radar 需要读取的字段；用户的 package.json 可能含更多字段，
 * 类型层不强行约束未声明字段（不使用 strict object 校验）。
 */
export interface PackageJson {
  name: string
  version: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  /** monorepo workspace 配置；支持数组或 { packages: [...] } 两种格式 */
  workspaces?: string[] | { packages: string[] }
}

/**
 * 支持的包管理器类型
 *
 * 后续若新增（如 bun / deno），请同步：
 * - src/utils/packageManager.ts: detectPackageManager / PM_COMMANDS
 * - src/analyzers/security.ts: audit 输出解析适配
 */
export type PackageManager = 'npm' | 'pnpm' | 'yarn'
