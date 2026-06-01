/**
 * CLI 退出码契约
 *
 * 用于 CI 集成场景：CI 系统通过退出码判断分析结果是否符合预期，
 * 决定是否阻断 pipeline。
 *
 * 约定：退出码语义化，不复用通用错误码 1。
 */

export const EXIT_CODES = {
  /** 一切正常 */
  OK: 0,
  /** 程序内部错误（异常、Bug、不可恢复的 I/O 错误） */
  ERROR: 1,
  /** 发现高危/严重漏洞，由 --fail-on 选项触发 */
  HIGH_VULNERABILITY: 2,
  /** 体积超过用户配置的 budget */
  BUDGET_EXCEEDED: 3,
  /** 命中许可证冲突规则（如检测到 GPL 等 strong-copyleft） */
  LICENSE_CONFLICT: 4,
} as const

/**
 * 退出码类型
 *
 * 使用 `(typeof EXIT_CODES)[keyof typeof EXIT_CODES]` 得到 0|1|2|3|4 联合类型，
 * 比直接写 `number` 更严格，可防止误传任意整数。
 */
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES]
