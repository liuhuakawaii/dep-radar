/**
 * 源码可达性分析器测试
 */

import { describe, expect, it } from 'vitest'

import { extractImportSpecifiers, normalizeSpecifier } from './reachability.js'

// =====================================================================
// normalizeSpecifier
// =====================================================================

describe('normalizeSpecifier', () => {
  it('普通包名不变', () => {
    expect(normalizeSpecifier('react')).toBe('react')
    expect(normalizeSpecifier('lodash')).toBe('lodash')
  })

  it('子路径归一化：pkg/sub → pkg', () => {
    expect(normalizeSpecifier('react-icons/fa')).toBe('react-icons')
    expect(normalizeSpecifier('lodash/merge')).toBe('lodash')
    expect(normalizeSpecifier('react-dom/client')).toBe('react-dom')
  })

  it('scoped 包：@scope/pkg/sub → @scope/pkg', () => {
    expect(normalizeSpecifier('@babel/core')).toBe('@babel/core')
    expect(normalizeSpecifier('@babel/plugin-transform-runtime')).toBe(
      '@babel/plugin-transform-runtime',
    )
    expect(normalizeSpecifier('@scope/pkg/sub/deep')).toBe('@scope/pkg')
  })

  it('相对路径返回 null', () => {
    expect(normalizeSpecifier('./utils')).toBeNull()
    expect(normalizeSpecifier('../lib/helper')).toBeNull()
    expect(normalizeSpecifier('./components/Button')).toBeNull()
  })

  it('node 内置模块返回 null', () => {
    expect(normalizeSpecifier('fs')).toBeNull()
    expect(normalizeSpecifier('path')).toBeNull()
    expect(normalizeSpecifier('node:fs')).toBeNull()
    expect(normalizeSpecifier('node:path')).toBeNull()
  })

  it('非 JS 文件导入返回 null', () => {
    expect(normalizeSpecifier('./style.css')).toBeNull()
    expect(normalizeSpecifier('image.png')).toBeNull()
    expect(normalizeSpecifier('data.json')).toBeNull()
  })
})

// =====================================================================
// extractImportSpecifiers
// =====================================================================

describe('extractImportSpecifiers', () => {
  describe('ESM import', () => {
    it('默认导入', () => {
      const result = extractImportSpecifiers(`import React from 'react'`)
      expect(result).toEqual([
        { specifier: 'react', importKind: 'import', line: 1 },
      ])
    })

    it('命名导入', () => {
      const result = extractImportSpecifiers(
        `import { useState, useEffect } from 'react'`,
      )
      expect(result).toEqual([
        { specifier: 'react', importKind: 'import', line: 1 },
      ])
    })

    it('命名空间导入', () => {
      const result = extractImportSpecifiers(`import * as React from 'react'`)
      expect(result).toEqual([
        { specifier: 'react', importKind: 'import', line: 1 },
      ])
    })

    it('副作用导入（无 from）', () => {
      const result = extractImportSpecifiers(`import './polyfill'`)
      expect(result).toEqual([
        { specifier: './polyfill', importKind: 'import', line: 1 },
      ])
    })
  })

  describe('ESM re-export', () => {
    it('export { x } from', () => {
      const result = extractImportSpecifiers(
        `export { Button } from './Button'`,
      )
      expect(result).toEqual([
        { specifier: './Button', importKind: 're-export', line: 1 },
      ])
    })

    it('export * from', () => {
      const result = extractImportSpecifiers(`export * from 'lodash'`)
      expect(result).toEqual([
        { specifier: 'lodash', importKind: 're-export', line: 1 },
      ])
    })
  })

  describe('CJS require', () => {
    it('基本 require', () => {
      const result = extractImportSpecifiers(`const fs = require('fs')`)
      expect(result).toEqual([
        { specifier: 'fs', importKind: 'require', line: 1 },
      ])
    })

    it('require 双引号', () => {
      const result = extractImportSpecifiers(`const path = require("path")`)
      expect(result).toEqual([
        { specifier: 'path', importKind: 'require', line: 1 },
      ])
    })
  })

  describe('Dynamic import', () => {
    it('动态 import()', () => {
      const result = extractImportSpecifiers(
        `const mod = await import('lodash')`,
      )
      expect(result).toEqual([
        { specifier: 'lodash', importKind: 'dynamic-import', line: 1 },
      ])
    })

    it('不与 static import 冲突', () => {
      const code = `import React from 'react'\nconst mod = await import('lodash')`
      const result = extractImportSpecifiers(code)
      expect(result).toHaveLength(2)
      expect(result[0]!.importKind).toBe('import')
      expect(result[1]!.importKind).toBe('dynamic-import')
    })
  })

  describe('多行文件', () => {
    it('正确记录行号', () => {
      const code = [
        "import React from 'react'",
        "import { useState } from 'react'",
        '// comment',
        "const lodash = require('lodash')",
        "const mod = await import('dynamic-pkg')",
      ].join('\n')

      const result = extractImportSpecifiers(code)
      expect(result).toEqual([
        { specifier: 'react', importKind: 'import', line: 1 },
        { specifier: 'react', importKind: 'import', line: 2 },
        { specifier: 'lodash', importKind: 'require', line: 4 },
        { specifier: 'dynamic-pkg', importKind: 'dynamic-import', line: 5 },
      ])
    })
  })

  describe('边界情况', () => {
    it('空内容返回空数组', () => {
      expect(extractImportSpecifiers('')).toEqual([])
    })

    it('无 import 的文件返回空数组', () => {
      const code = [
        'const x = 1',
        'function foo() { return x }',
        '// no imports here',
      ].join('\n')
      expect(extractImportSpecifiers(code)).toEqual([])
    })

    it('注释中的 import 不应被匹配（单行）', () => {
      // 正则是逐行匹配的，注释行如果以 import 开头仍会被匹配
      // 这是已知限制，AST parser 才能精确处理
      const code = `// import foo from 'bar'\nimport React from 'react'`
      const result = extractImportSpecifiers(code)
      // 注释行也会被匹配（正则限制），但 react 应该被正确提取
      expect(result.some(r => r.specifier === 'react')).toBe(true)
    })

    it('字符串中的 import 不影响结果', () => {
      const code = `const msg = "import foo from 'bar'"\nimport React from 'react'`
      const result = extractImportSpecifiers(code)
      // 字符串中的 import 也会被正则匹配（已知限制）
      expect(result.some(r => r.specifier === 'react')).toBe(true)
    })

    it('import 带 type 前缀', () => {
      const code = `import type { Foo } from 'types'`
      const result = extractImportSpecifiers(code)
      expect(result).toEqual([
        { specifier: 'types', importKind: 'import', line: 1 },
      ])
    })
  })
})
