import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Keep workspace tests on the current source tree. Resolving the package's
    // stale dist sourcemap here can merge two generated files into one V8 path.
    alias: {
      '@dshpack/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/cli/test/export.e2e.test.ts'],
    exclude: ['packages/cli/test/help.e2e.test.ts', 'packages/cli/test/process.e2e.test.ts'],
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
        'packages/core/src/patch.ts': { branches: 90 },
        'packages/core/src/patch-export.ts': { branches: 90 },
        'packages/cli/src/adapters/settings.ts': { branches: 90 },
        'packages/cli/src/adapters/settings-lock.ts': { branches: 90 },
        'packages/cli/src/transaction-journal.ts': { branches: 90 },
        'packages/cli/src/transaction-node-adapter.ts': { branches: 90 },
        'packages/cli/src/transaction-rollback.ts': { branches: 90 },
        'packages/cli/src/transaction-types.ts': { branches: 90 },
        'packages/cli/src/transaction.ts': { branches: 90 },
        'packages/cli/src/doctor/engine.ts': { branches: 90 },
        'packages/cli/src/export/engine.ts': { branches: 90 },
      },
    },
  },
});
