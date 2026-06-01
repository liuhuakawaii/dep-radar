/**
 * JSON 报告生成器
 *
 * 直接 stringify AnalysisReport，主要服务于：
 * 1. `--format json` CLI 输出
 * 2. CI 集成（被其他工具读取）
 *
 * 由于 AnalysisReport 是纯数据结构（无函数、无循环引用），
 * 可以无损 JSON 序列化。
 */

import type { AnalysisReport } from '../types/analysis.js'

/**
 * 渲染为 JSON 字符串
 *
 * @param report 待渲染的报告
 * @param pretty 是否带缩进，默认 true（便于人工阅读）
 */
export function renderJsonReport(
  report: AnalysisReport,
  pretty = true,
): string {
  return pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report)
}
