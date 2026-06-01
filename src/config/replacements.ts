/**
 * 内置替代方案表
 *
 * 收录原则：
 *   - 收录有"明确的、社区广泛认可的"替代方案的包
 *   - estimatedSavingsPercent 偏保守（基于公开 benchmark / pkg-size 对比）
 *   - caveats 说明不适用场景，避免误导用户盲目替换
 *
 * 用户可通过 DepRadarConfig.replacements 追加或覆盖（同名时用户优先）。
 */

import type { ReplacementRule } from '../types/config.js'

export const REPLACEMENTS: Record<string, ReplacementRule> = {
  moment: {
    alternative: 'dayjs',
    altPackage: 'dayjs',
    estimatedSavingsPercent: 97,
    difficulty: 'low',
    breakingChange: false,
    description: 'dayjs API 与 moment 高度兼容，体积仅 2KB',
    migrationGuide: 'https://day.js.org/docs/en/guides/migration-from-moment',
  },
  lodash: {
    alternative: 'es-toolkit (推荐) 或 lodash-es',
    altPackage: 'es-toolkit',
    estimatedSavingsPercent: 90,
    difficulty: 'medium',
    breakingChange: false,
    description:
      'es-toolkit 是 lodash 的现代化重写，更小更快，API 兼容主流方法；lodash-es 配合 Tree-shaking 也可',
    caveats: [
      'es-toolkit 未覆盖 lodash 全部 300+ 方法，使用前请确认目标函数已实现',
    ],
    migrationGuide: 'https://es-toolkit.slash.page/migrate-from-lodash',
  },
  jquery: {
    alternative: '原生 DOM API',
    altPackage: '',
    estimatedSavingsPercent: 100,
    difficulty: 'high',
    breakingChange: true,
    description:
      '现代浏览器原生 API（querySelector / fetch / classList）已足够强大',
    caveats: ['需重写所有 $(...) 调用，工作量大；老 IE 兼容需求请保留'],
  },
  classnames: {
    alternative: 'clsx',
    altPackage: 'clsx',
    estimatedSavingsPercent: 60,
    difficulty: 'low',
    breakingChange: false,
    description: 'clsx 更小（~200B vs 500B），API 完全兼容',
  },
  uuid: {
    alternative: 'crypto.randomUUID()',
    altPackage: '',
    estimatedSavingsPercent: 100,
    difficulty: 'low',
    breakingChange: false,
    description: 'Node.js 19+ 和现代浏览器内置 crypto.randomUUID()',
    caveats: [
      '仅支持 v4 UUID；如需 v1/v3/v5 仍需保留 uuid 包',
      '需要确认运行环境 >= Node 19 / Chrome 92 / Safari 15.4',
    ],
  },
  request: {
    alternative: 'ofetch / undici / 原生 fetch',
    altPackage: 'ofetch',
    estimatedSavingsPercent: 80,
    difficulty: 'medium',
    breakingChange: true,
    description: 'request 已于 2020 年废弃，停止维护',
  },
  'node-sass': {
    alternative: 'sass (dart-sass)',
    altPackage: 'sass',
    estimatedSavingsPercent: 0,
    difficulty: 'low',
    breakingChange: false,
    description: 'node-sass 已废弃，sass (dart-sass) 是官方替代',
  },
  formik: {
    alternative: 'react-hook-form',
    altPackage: 'react-hook-form',
    estimatedSavingsPercent: 50,
    difficulty: 'high',
    breakingChange: true,
    description: 'react-hook-form 性能更好，重渲染次数更少',
    caveats: ['API 完全不同，迁移需重写表单逻辑'],
  },
  yup: {
    alternative: 'zod',
    altPackage: 'zod',
    estimatedSavingsPercent: 30,
    difficulty: 'medium',
    breakingChange: true,
    description: 'zod 类型推导更优秀，TypeScript 集成更好',
  },
  'react-icons': {
    alternative: 'lucide-react',
    altPackage: 'lucide-react',
    estimatedSavingsPercent: 70,
    difficulty: 'low',
    breakingChange: true,
    description: 'lucide-react 支持 Tree-shaking，按需引入；图标风格统一',
    caveats: ['图标集不完全重叠，需对照检查所需图标是否存在'],
  },
}

/**
 * 合并内置规则与用户自定义规则
 *
 * 用户配置（DepRadarConfig.replacements）优先；同名 key 覆盖内置规则。
 */
export function mergeReplacements(
  user?: Record<string, ReplacementRule>,
): Record<string, ReplacementRule> {
  if (!user) return REPLACEMENTS
  return { ...REPLACEMENTS, ...user }
}
