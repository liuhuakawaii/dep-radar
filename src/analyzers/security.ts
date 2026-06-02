/**
 * 安全审计分析器
 *
 * 通过各包管理器的 `audit` 命令检测依赖中的已知漏洞。
 *
 * 数据流：
 *   1. 根据包管理器（npm/pnpm/yarn）选择对应的 audit 命令
 *   2. 通过注入的 executor 执行命令并拿到 JSON 输出
 *   3. 按 PM 格式解析为 SecurityInfo[]
 *   4. 聚合最高严重度、漏洞总数等汇总字段
 *
 * 错误处理：
 *   - audit 命令失败（非零退出码）→ stdout 可能仍是合法 JSON（有漏洞时 npm/pnpm 返回非零）
 *   - stdout 非法 → 整体 skipped，不阻断分析
 *   - 私有 registry 无 audit 端点 → 优雅降级，跳过并提示用户
 */

import type { SecurityInfo, Vulnerability } from '../types/analysis.js'
import type { PackageManager } from '../types/package.js'
import type { CommandSpec } from '../utils/packageManager.js'

// =====================================================================
// 公开类型
// =====================================================================

/** 依赖注入的命令执行器（便于测试 mock） */
export interface AuditExecutor {
  execute(
    cmd: string,
    args: string[],
    cwd: string,
  ): Promise<{ stdout: string; stderr: string }>
}

export interface AnalyzeSecurityOptions {
  /** 是否同时审计 devDependencies；默认 false */
  includeDev?: boolean
  /** 要跳过的包名 glob 模式数组 */
  ignore?: string[]
}

export interface SecurityAnalysisResult {
  security: SecurityInfo[]
  /** 因解析/执行问题被跳过的包 */
  skipped: Array<{ name: string; reason: string }>
  /** 整体漏洞汇总 */
  summary: {
    critical: number
    high: number
    moderate: number
    low: number
  }
}

// =====================================================================
// 主入口
// =====================================================================

export async function analyzeSecurity(
  auditCmd: CommandSpec,
  pm: PackageManager,
  projectPath: string,
  executor: AuditExecutor,
  options: AnalyzeSecurityOptions = {},
): Promise<SecurityAnalysisResult> {
  const { ignore } = options
  const ignorePatterns = (ignore ?? []).map(compileIgnorePattern)

  let stdout: string
  try {
    const result = await executor.execute(
      auditCmd.cmd,
      auditCmd.args,
      projectPath,
    )
    stdout = result.stdout
  } catch (err: unknown) {
    // 有漏洞时 npm/pnpm 以非零退出码退出，但 stdout 仍是 JSON
    const execErr = err as {
      stdout?: string
      stderr?: string
      message?: string
    }
    if (execErr.stdout) {
      stdout = execErr.stdout
    } else {
      return {
        security: [],
        skipped: [
          {
            name: '*',
            reason: `audit 命令执行失败：${execErr.message ?? String(err)}`,
          },
        ],
        summary: { critical: 0, high: 0, moderate: 0, low: 0 },
      }
    }
  }

  // 解析
  let parsed: ParsedAuditEntry[]
  try {
    parsed = parseAuditOutput(stdout, pm)
  } catch (err) {
    return {
      security: [],
      skipped: [
        {
          name: '*',
          reason: `audit 输出解析失败：${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      summary: { critical: 0, high: 0, moderate: 0, low: 0 },
    }
  }

  // 应用 ignore 过滤 + 转为 SecurityInfo
  const filtered = parsed.filter(
    entry => !ignorePatterns.some(p => p.test(entry.name)),
  )

  const security = filtered.map(buildSecurityInfo)

  // 汇总
  const summary = { critical: 0, high: 0, moderate: 0, low: 0 }
  for (const info of security) {
    for (const v of info.vulnerabilities) {
      summary[v.severity]++
    }
  }

  return { security, skipped: [], summary }
}

// =====================================================================
// 解析器
// =====================================================================

/** 中间格式：从各 PM 输出中提取的原始漏洞条目 */
interface ParsedAuditEntry {
  name: string
  vulnerabilities: Vulnerability[]
}

/**
 * 按 PM 分发解析
 *
 * 导出以供单元测试。
 */
export function parseAuditOutput(
  stdout: string,
  pm: PackageManager,
): ParsedAuditEntry[] {
  if (pm === 'yarn') return parseYarnAuditOutput(stdout)
  const data = JSON.parse(stdout) as unknown
  switch (pm) {
    case 'npm':
      return parseNpmAudit(data)
    case 'pnpm':
      return parsePnpmAudit(data)
  }
}

/**
 * Yarn audit 输出可能是：
 * - Berry: 单个 JSON 对象
 * - Classic: NDJSON（多行，每行一个 JSON）
 *
 * 先尝试整体 JSON.parse，失败则按 NDJSON 处理。
 */
function parseYarnAuditOutput(stdout: string): ParsedAuditEntry[] {
  // 尝试 Berry 格式（单个 JSON）
  try {
    const data = JSON.parse(stdout) as unknown
    return parseYarnAudit(data)
  } catch {
    // 不是合法的单个 JSON，按 Classic NDJSON 处理
  }

  const lines: unknown[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      lines.push(JSON.parse(line))
    } catch {
      // 跳过非 JSON 行
    }
  }
  return parseYarnAudit(lines)
}

// ----- npm -----

interface NpmAuditVulnerability {
  severity: string
  title?: string
  url?: string
  fixAvailable?: boolean | { name: string; version: string }
}

interface NpmAuditData {
  vulnerabilities?: Record<string, NpmAuditVulnerability>
}

/**
 * npm audit --json 输出格式：
 * { "vulnerabilities": { "lodash": { "severity": "high", "title": "...", ... } } }
 */
function parseNpmAudit(data: unknown): ParsedAuditEntry[] {
  const d = data as NpmAuditData
  if (!d.vulnerabilities || typeof d.vulnerabilities !== 'object') return []

  return Object.entries(d.vulnerabilities).map(([name, vuln]) => ({
    name,
    vulnerabilities: [
      {
        severity: normalizeSeverity(vuln.severity),
        title: vuln.title ?? `${name} 安全漏洞`,
        url: vuln.url ?? '',
        fixAvailable: normalizeFixAvailable(vuln.fixAvailable),
      },
    ],
  }))
}

// ----- pnpm -----

interface PnpmAuditAdvisory {
  module_name: string
  severity: string
  title?: string
  url?: string
  patched_versions?: string
}

interface PnpmAuditData {
  advisories?: Record<string, PnpmAuditAdvisory>
  /** pnpm audit >= 9 输出格式 */
  vulnerabilities?: Array<{
    name: string
    severity: string
    title?: string
    url?: string
    fixAvailable?: boolean
  }>
}

/**
 * pnpm audit --json 输出格式有多个版本：
 *
 * pnpm < 9:
 * { "advisories": { "12345": { "module_name": "lodash", "severity": "high", ... } } }
 *
 * pnpm >= 9:
 * { "vulnerabilities": [{ "name": "lodash", "severity": "high", ... }] }
 */
function parsePnpmAudit(data: unknown): ParsedAuditEntry[] {
  const d = data as PnpmAuditData

  // 新格式（pnpm >= 9）
  if (Array.isArray(d.vulnerabilities)) {
    const byName = new Map<string, Vulnerability[]>()
    for (const v of d.vulnerabilities) {
      const list = byName.get(v.name) ?? []
      list.push({
        severity: normalizeSeverity(v.severity),
        title: v.title ?? `${v.name} 安全漏洞`,
        url: v.url ?? '',
        fixAvailable: v.fixAvailable ?? false,
      })
      byName.set(v.name, list)
    }
    return Array.from(byName.entries()).map(([name, vulnerabilities]) => ({
      name,
      vulnerabilities,
    }))
  }

  // 旧格式
  if (d.advisories && typeof d.advisories === 'object') {
    const byName = new Map<string, Vulnerability[]>()
    for (const adv of Object.values(d.advisories)) {
      const list = byName.get(adv.module_name) ?? []
      list.push({
        severity: normalizeSeverity(adv.severity),
        title: adv.title ?? `${adv.module_name} 安全漏洞`,
        url: adv.url ?? '',
        fixAvailable: Boolean(adv.patched_versions),
      })
      byName.set(adv.module_name, list)
    }
    return Array.from(byName.entries()).map(([name, vulnerabilities]) => ({
      name,
      vulnerabilities,
    }))
  }

  return []
}

// ----- yarn -----

interface YarnAuditData {
  vulnerabilities?: Record<
    string,
    {
      severity: string
      title?: string
      url?: string
      fixAvailable?: boolean
    }
  >
}

/**
 * yarn audit 输出格式：
 *
 * Berry（yarn npm audit --json）：单个 JSON，与 npm 类似
 *   { "vulnerabilities": { "pkg": { "severity": "...", ... } } }
 *
 * Classic（yarn audit --json）：NDJSON，每行一个 JSON 对象
 *   - type="auditAdvisory": 单条漏洞，含 data.advisory.module_name / severity / title / url
 *   - type="auditSummary": 汇总（忽略）
 */
function parseYarnAudit(data: unknown): ParsedAuditEntry[] {
  // Berry 格式：单个 JSON 对象
  const d = data as YarnAuditData
  if (d && typeof d === 'object' && 'vulnerabilities' in d) {
    if (!d.vulnerabilities || typeof d.vulnerabilities !== 'object') return []
    return Object.entries(d.vulnerabilities).map(([name, vuln]) => ({
      name,
      vulnerabilities: [
        {
          severity: normalizeSeverity(vuln.severity),
          title: vuln.title ?? `${name} 安全漏洞`,
          url: vuln.url ?? '',
          fixAvailable: vuln.fixAvailable ?? false,
        },
      ],
    }))
  }

  // Classic NDJSON 格式：data 是已解析的行数组
  if (Array.isArray(data)) {
    return parseYarnClassicAuditNdjson(data)
  }

  return []
}

interface YarnClassicAuditLine {
  type: string
  data?: {
    advisory?: {
      module_name?: string
      severity?: string
      title?: string
      url?: string
      patched_versions?: string
    }
  }
}

/**
 * 解析 Yarn Classic NDJSON audit 输出
 *
 * 输入为已按行分割并 JSON.parse 后的对象数组。
 * 只取 type="auditAdvisory" 的行。
 */
function parseYarnClassicAuditNdjson(lines: unknown[]): ParsedAuditEntry[] {
  const byName = new Map<string, Vulnerability[]>()
  for (const line of lines) {
    const obj = line as YarnClassicAuditLine
    if (obj.type !== 'auditAdvisory' || !obj.data?.advisory) continue
    const adv = obj.data.advisory
    const name = adv.module_name ?? 'unknown'
    const list = byName.get(name) ?? []
    list.push({
      severity: normalizeSeverity(adv.severity ?? 'low'),
      title: adv.title ?? `${name} 安全漏洞`,
      url: adv.url ?? '',
      fixAvailable: Boolean(adv.patched_versions),
    })
    byName.set(name, list)
  }
  return Array.from(byName.entries()).map(([name, vulnerabilities]) => ({
    name,
    vulnerabilities,
  }))
}

// =====================================================================
// 工具
// =====================================================================

type RawSeverity = string

const VALID_SEVERITIES: Vulnerability['severity'][] = [
  'low',
  'moderate',
  'high',
  'critical',
]

function normalizeSeverity(raw: RawSeverity): Vulnerability['severity'] {
  const lower = raw.toLowerCase()
  if (VALID_SEVERITIES.includes(lower as Vulnerability['severity'])) {
    return lower as Vulnerability['severity']
  }
  return 'low'
}

function normalizeFixAvailable(
  raw: boolean | { name: string; version: string } | undefined,
): boolean {
  if (typeof raw === 'boolean') return raw
  if (raw && typeof raw === 'object') return true
  return false
}

function buildSecurityInfo(entry: ParsedAuditEntry): SecurityInfo {
  const totalVulnerabilities = entry.vulnerabilities.length
  const severityOrder: Record<string, number> = {
    low: 0,
    moderate: 1,
    high: 2,
    critical: 3,
  }

  let highest: SecurityInfo['highestSeverity'] = 'none'
  let highestRank = -1
  for (const v of entry.vulnerabilities) {
    const rank = severityOrder[v.severity] ?? 0
    if (rank > highestRank) {
      highestRank = rank
      highest = v.severity
    }
  }

  return {
    name: entry.name,
    vulnerabilities: entry.vulnerabilities,
    totalVulnerabilities,
    highestSeverity: highest,
  }
}

function compileIgnorePattern(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}
