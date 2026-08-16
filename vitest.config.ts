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
        'packages/cli/src/adapters/source.ts': { branches: 90 },
        'packages/cli/src/adapters/source-archive.ts': { branches: 90 },
        'packages/cli/src/adapters/source-network.ts': { branches: 90 },
        'packages/cli/src/transaction-journal.ts': { branches: 90 },
        'packages/cli/src/transaction-node-adapter.ts': { branches: 90 },
        'packages/cli/src/transaction-rollback.ts': { branches: 90 },
        'packages/cli/src/transaction-types.ts': { branches: 90 },
        'packages/cli/src/transaction.ts': { branches: 90 },
        // W10/W11：doctor 与 export 的全部核心逻辑都受同一门槛约束，
        // 不只是 engine——DSH001-018 的判定本体在 checks.ts，
        // export 的采集与脱敏决策在 collect.ts / support.ts，
        // 它们才是最需要分支覆盖的地方。
        'packages/cli/src/doctor/engine.ts': { branches: 90 },
        'packages/cli/src/doctor/checks.ts': { branches: 90 },
        'packages/cli/src/doctor/support.ts': { branches: 90 },
        'packages/cli/src/export/engine.ts': { branches: 90 },
        'packages/cli/src/export/collect.ts': { branches: 90 },
        'packages/cli/src/export/support.ts': { branches: 90 },
        'packages/cli/src/validation/validate-pack.ts': { branches: 90 },
      },
    },
  },
});
