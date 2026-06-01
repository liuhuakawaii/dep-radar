/**
 * 外部 API 响应类型
 *
 * 仅声明 dep-radar 实际消费的字段，未列出字段不参与类型校验。
 * 当外部 API schema 发生变化时，应优先在这里调整以避免影响业务层。
 */

// =====================================================================
// pkg-size.dev
// =====================================================================

/**
 * GET https://pkg-size.dev/api/{pkg}@{version}
 *
 * 文档：https://pkg-size.dev/
 */
export interface PkgSizeResponse {
  name: string
  version: string
  /** minified 字节数 */
  size: number
  /** gzip 字节数 */
  gzip: number
  /** brotli 字节数 */
  brotli: number
  dependencyCount: number
  hasJSModule: boolean
  hasJSNext: boolean
}

// =====================================================================
// npm registry
// =====================================================================

/**
 * GET https://registry.npmjs.org/{pkg}/latest
 *
 * 注意：实际响应字段非常多，这里只声明 dep-radar 需要的部分。
 * license 字段在历史上有两种格式：字符串 "MIT" 或对象 { type: "MIT" }
 */
export interface NpmRegistryResponse {
  name: string
  version: string
  /** 许可证；兼容字符串与旧版 { type: "MIT" } 对象格式 */
  license?: string | { type: string }
  maintainers?: Array<{ name: string }>
  /** 各版本的发布时间 map：{ "1.0.0": "2023-..." } */
  time?: Record<string, string>
  /** repository 字段；兼容字符串与对象两种格式 */
  repository?: { type: string; url: string } | string
  homepage?: string
  /** 被 npm 标记 deprecated 时给出的原因字符串 */
  deprecated?: string
  /** TypeScript 类型文件入口（types 优先于 typings） */
  types?: string
  typings?: string
}

/**
 * GET https://api.npmjs.org/downloads/point/{period}/{pkg}
 */
export interface NpmDownloadsResponse {
  downloads: number
  package: string
  start: string
  end: string
}

/**
 * GET https://api.npmjs.org/downloads/range/{period}/{pkg}
 */
export interface NpmDownloadsRangeResponse {
  downloads: Array<{ day: string; downloads: number }>
  package: string
  start: string
  end: string
}

// =====================================================================
// GitHub REST API
// =====================================================================

/**
 * GET https://api.github.com/repos/{owner}/{repo}
 *
 * 无 GITHUB_TOKEN 时限流为 60 次/小时；需提示用户配置。
 */
export interface GithubRepoResponse {
  stargazers_count: number
  open_issues_count: number
  pushed_at: string
  updated_at: string
  archived: boolean
  /** SPDX 标识；null 表示 GitHub 未识别出许可证 */
  license: { spdx_id: string } | null
}
