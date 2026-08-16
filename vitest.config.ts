import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    exclude: ['packages/*/test/**/*.e2e.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      reportsDirectory: 'coverage',
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
        'packages/core/src/secrets.ts': { branches: 90 },
        'packages/core/src/lock.ts': { branches: 90 },
      },
    },
  },
});
