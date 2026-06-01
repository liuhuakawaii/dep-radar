import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/cli.ts',
        'src/**/*.test.ts',
        'src/types/**',
        'src/errors/**',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 65,
      },
    },
  },
})
