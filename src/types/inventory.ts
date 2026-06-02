import type { ClassificationEvidence, UsageClass } from './classifier.js'

/**
 * DependencyInventory 相关类型
 *
 * 为所有 analyzer 提供统一的依赖事实来源：
 * - 版本来自 lockfile / node_modules，而非 package.json 声明
 * - alias 被解析为真实包名
 * - transitive 依赖被收集
 * - 每条记录标注数据来源和置信度
 */

/**
 * 依赖声明位置
 *
 * - dependencies / devDependencies / peerDependencies / optionalDependencies: 直接声明
 * - transitive: 传递依赖（lockfile 中存在但 package.json 未直接声明）
 */
export type DeclaredIn =
  | 'dependencies'
  | 'devDependencies'
  | 'peerDependencies'
  | 'optionalDependencies'
  | 'transitive'

/**
 * 版本解析来源（按可靠性降序）
 *
 * - package-lock.json: npm lockfile v2/v3
 * - pnpm-lock.yaml: pnpm lockfile
 * - yarn.lock: yarn lockfile
 * - node_modules: 直接读 node_modules/<pkg>/package.json
 * - package-json-fallback: 从 package.json 声明粗略解析（最低可靠性）
 */
export type ResolvedFrom =
  | 'package-lock.json'
  | 'pnpm-lock.yaml'
  | 'yarn.lock'
  | 'node_modules'
  | 'package-json-fallback'

/**
 * 单个依赖的完整信息
 */
export interface DependencyEntry {
  /** 用户声明名（alias 时为 alias 名，如 "three149"） */
  name: string
  /** 实际 npm 包名（alias 解析后，如 "three"） */
  packageName: string
  /** package.json 中的原始声明（如 "npm:three@0.149.0"、"^1.2.3"） */
  requestedSpec: string
  /** lockfile / node_modules 中的实际版本（如 "0.149.0"） */
  resolvedVersion: string
  /** 依赖声明位置 */
  declaredIn: DeclaredIn
  /** 是否为 root 直接依赖 */
  isDirect: boolean
  /** 是否为 npm alias（如 three149@npm:three@0.149.0） */
  isAlias: boolean
  /** alias 指向的原始包名和版本声明 */
  aliasOf?: { name: string; spec: string }
  /** 版本解析来源 */
  resolvedFrom: ResolvedFrom
  /** 数据置信度 */
  confidence: 'high' | 'medium' | 'low'
  /** 从 root 到该包的依赖路径（安全和多版本分析用） */
  paths: string[][]
  /** 依赖使用分类（由 classifier 标注） */
  usageClass?: UsageClass
  /** 分类证据 */
  classificationEvidence?: ClassificationEvidence
}

/**
 * 项目依赖清单
 *
 * 由 buildInventory() 构建，传给各 analyzer 消费。
 */
export interface DependencyInventory {
  /** 全部依赖条目（direct + transitive） */
  entries: DependencyEntry[]
  /** 直接依赖数 */
  directCount: number
  /** 传递依赖数 */
  transitiveCount: number
  /** 整体数据来源 */
  resolvedFrom: ResolvedFrom
  /** 降级或不完整的警告信息 */
  warnings: string[]
}

/**
 * buildInventory 的选项
 */
export interface BuildInventoryOptions {
  /** 是否包含 devDependencies */
  includeDev?: boolean
  /** 忽略的包名模式列表 */
  ignore?: string[]
}
