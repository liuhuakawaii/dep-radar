/**
 * 依赖作用域分类类型
 *
 * 用于区分依赖的使用场景：
 * - runtime: 浏览器运行时代码（src 中被 import）
 * - build: 构建工具（babel/rollup/webpack/vite 插件等）
 * - test: 测试框架和工具
 * - script: 仅在 package.json scripts 中使用的 CLI 工具
 * - config: 仅在配置文件中出现的依赖
 * - unknown: 无明确证据，不能假设进入浏览器
 */

import type { DependencyEntry } from './inventory.js'

/**
 * 依赖使用分类
 */
export type UsageClass =
  | 'runtime'
  | 'build'
  | 'test'
  | 'script'
  | 'config'
  | 'unknown'

/**
 * 分类证据
 */
export interface ClassificationEvidence {
  /** 证据来源 */
  source:
    | 'package-name-rule'
    | 'scripts-match'
    | 'config-file'
    | 'user-override'
    | 'reachability'
  /** 证据描述（如 "匹配 @babel/* 构建工具规则"） */
  detail: string
}

/**
 * 带分类信息的依赖条目
 */
export interface ClassifiedEntry extends DependencyEntry {
  usageClass: UsageClass
  evidence: ClassificationEvidence
}

/**
 * 分类器选项
 */
export interface ClassifyOptions {
  /** 用户自定义分类覆盖 */
  overrides?: Record<string, UsageClass>
}
