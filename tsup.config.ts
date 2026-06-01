import { createRequire } from 'node:module'
import { defineConfig } from 'tsup'

const require = createRequire(import.meta.url)
const pkg = require('./package.json') as { version: string }

export default defineConfig([
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    clean: true,
    sourcemap: true,
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
    define: {
      __DEP_RADAR_VERSION__: JSON.stringify(pkg.version),
    },
  },
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    sourcemap: true,
    target: 'node18',
  },
])
