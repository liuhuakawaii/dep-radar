/**
 * Command option validation shared by CLI entrypoints and command tests.
 */

export const SCAN_REPORT_FORMATS = [
  'terminal',
  'json',
  'html',
  'markdown',
] as const

export type ScanReportFormat = (typeof SCAN_REPORT_FORMATS)[number]

export const SIMPLE_REPORT_FORMATS = ['terminal', 'json'] as const

export type SimpleReportFormat = (typeof SIMPLE_REPORT_FORMATS)[number]

export const SCAN_SCOPES = ['runtime', 'all', 'non-runtime'] as const

export type ScanScope = (typeof SCAN_SCOPES)[number]

export function isScanReportFormat(value: unknown): value is ScanReportFormat {
  return (
    typeof value === 'string' &&
    (SCAN_REPORT_FORMATS as readonly string[]).includes(value)
  )
}

export function isSimpleReportFormat(
  value: unknown,
): value is SimpleReportFormat {
  return (
    typeof value === 'string' &&
    (SIMPLE_REPORT_FORMATS as readonly string[]).includes(value)
  )
}

export function isScanScope(value: unknown): value is ScanScope {
  return (
    typeof value === 'string' &&
    (SCAN_SCOPES as readonly string[]).includes(value)
  )
}

export function validateConcurrency(value: unknown): number | undefined {
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  if (value < 1 || value > 20) return undefined
  return value
}

export function listChoices(choices: readonly string[]): string {
  return choices.join('|')
}
