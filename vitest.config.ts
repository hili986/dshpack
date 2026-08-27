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
    // Windows safety suites exercise real child processes and exclusive file locks.
    // Serial execution keeps the original timeouts deterministic without skipping
    // assertions or weakening any coverage gate.
    maxWorkers: 1,
    // Vitest's 5s default is a patience budget, not a correctness gate, and it was sized
    // for tests that only touch memory. These build real pack fixtures, run a full legacy
    // install, and snapshot whole directory trees; on a clean windows-latest runner that
    // crossed 5s and turned CI red on `migrate-engine` while every assertion still held.
    // Raising the wait changes nothing about what is asserted — a genuine deadlock still
    // fails, 15s later — and it removes a class of flake that was about to spread from one
    // test to its neighbours. Per-file overrides stay available for anything slower.
    //
    // 2026-08-19, second raise. It was made for four windows-latest failures, but only one of
    // them was actually a timing problem — recorded here because the first version of this
    // comment claimed all four were, and that reading is wrong:
    //
    //   restore  "restores only absent settings keys ... every conflict form"  6490ms local
    //
    // 6.5s of genuine work against a 20s ceiling is a ~3x margin, which cold small-file I/O on
    // a slower volume eats. That case is why the ceiling is 60s, and it passed after the raise.
    //
    // The other three (update-engine) measured 1951ms and 2252ms locally and were never slow.
    // They consumed exactly whatever ceiling was offered — 20s under a 20s limit, then 60407ms
    // and 60460ms under this one — which is the signature of a block, not of expense. Their
    // cause was separate: an uninstall probe reached the real doctor, which falls back to
    // `npx --yes @deepseek-ai/dsh` when `dsh` is absent from PATH, and that spawn cannot honour
    // its own 5s timeout while `killDescendants: false` leaves a grandchild holding the pipes.
    // Raising a ceiling never helps that shape, and the number above is not evidence for it.
    //
    // This still catches deadlocks — one minute later — and the job's own 30-minute cap is
    // the real backstop.
    testTimeout: 60_000,
    hookTimeout: 60_000,
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
        'packages/cli/src/adapters/process.ts': { branches: 90 },
        'packages/cli/src/install/build-plan.ts': { branches: 90 },
        'packages/cli/src/install/content-validation.ts': { branches: 90 },
        'packages/cli/src/install/engine.ts': { branches: 90 },
        'packages/cli/src/update/engine.ts': { branches: 90 },
        'packages/cli/src/update/merge.ts': { branches: 90 },
        'packages/cli/src/update/policy.ts': { branches: 90 },
        'packages/cli/src/install/engine-apply.ts': { branches: 90 },
        'packages/cli/src/install/engine-errors.ts': { branches: 90 },
        'packages/cli/src/install/engine-profile.ts': { branches: 90 },
        'packages/cli/src/install/metadata.ts': { branches: 90 },
        'packages/cli/src/compose/conflicts.ts': { branches: 90 },
        'packages/cli/src/compose/engine.ts': { branches: 90 },
        'packages/cli/src/compose/sources.ts': { branches: 90 },
        'packages/cli/src/commands/compose.ts': { branches: 90 },
        'packages/core/src/compose.ts': { branches: 90 },
        'packages/cli/src/install/plan.ts': { branches: 90 },
        'packages/cli/src/install/policy.ts': { branches: 90 },
        'packages/cli/src/install/read.ts': { branches: 90 },
        'packages/cli/src/install/reconcile.ts': { branches: 90 },
        'packages/cli/src/install/resolver.ts': { branches: 90 },
        'packages/cli/src/install/snapshot-capture.ts': { branches: 90 },
        'packages/cli/src/install/snapshot-path.ts': { branches: 90 },
        'packages/cli/src/install/profile-builds.ts': { branches: 90 },
        'packages/cli/src/install/profile-common.ts': { branches: 90 },
        'packages/cli/src/install/profile-fs.ts': { branches: 90 },
        'packages/cli/src/install/profile-init.ts': { branches: 90 },
        'packages/cli/src/install/profile-mcp.ts': { branches: 90 },
        'packages/cli/src/install/profile-plugin.ts': { branches: 90 },
        'packages/cli/src/install/profile-tarball.ts': { branches: 90 },
        'packages/cli/src/install/profile-workspace.ts': { branches: 90 },
        'packages/cli/src/install/plugin-download.ts': { branches: 90 },
        'packages/cli/src/install/runtime-assets.ts': { branches: 90 },
        'packages/cli/src/install/runtime-process.ts': { branches: 90 },
        'packages/cli/src/install/runtime-state.ts': { branches: 90 },
        'packages/cli/src/install/runtime.ts': { branches: 90 },
        // lock/engine.ts produces pack.lock.yml, the integrity record install verifies
        // against, and shipped at 71.64% branches because nothing gated it. The gate goes
        // in first so the gap cannot go quiet again; raise the tests to meet it.
        'packages/cli/src/lock/engine.ts': { branches: 90 },
        'packages/cli/src/commands/lock.ts': { branches: 90 },
        'packages/cli/src/cli.ts': { branches: 90 },
        'packages/cli/src/version.ts': { branches: 90 },
        'packages/cli/src/list/contracts.ts': { branches: 90 },
        'packages/cli/src/list/engine.ts': { branches: 90 },
        'packages/cli/src/list/metadata-contract.ts': { branches: 90 },
        'packages/cli/src/metadata/contracts.ts': { branches: 90 },
        'packages/cli/src/metadata/state-storage.ts': { branches: 90 },
        'packages/cli/src/list/safe-fs.ts': { branches: 90 },
        'packages/cli/src/switch/engine.ts': { branches: 90 },
        'packages/cli/src/switch/settings.ts': { branches: 90 },
        'packages/cli/src/commands/list.ts': { branches: 90 },
        'packages/cli/src/commands/switch.ts': { branches: 90 },
        'packages/cli/src/commands/install.ts': { branches: 90 },
        'packages/cli/src/commands/gc.ts': { branches: 90 },
        'packages/cli/src/commands/migrate.ts': { branches: 90 },
        'packages/cli/src/commands/update.ts': { branches: 90 },
        'packages/cli/src/commands/diff.ts': { branches: 90 },
        'packages/cli/src/commands/status.ts': { branches: 90 },
        'packages/cli/src/commands/init.ts': { branches: 90 },
        'packages/cli/src/init/engine.ts': { branches: 90 },
        'packages/cli/src/pack/engine.ts': { branches: 90 },
        'packages/cli/src/commands/pack.ts': { branches: 90 },
        'packages/cli/src/diff/engine.ts': { branches: 90 },
        'packages/cli/src/status/engine.ts': { branches: 90 },
        'packages/cli/src/management/attribution.ts': { branches: 90 },
        'packages/cli/src/management/state.ts': { branches: 90 },
        'packages/cli/src/commands/uninstall.ts': { branches: 90 },
        'packages/cli/src/terminal-safe.ts': { branches: 90 },
        'packages/cli/src/commands/restore.ts': { branches: 90 },
        'packages/cli/src/gc/engine.ts': { branches: 90 },
        'packages/cli/src/migrate/engine.ts': { branches: 90 },
        'packages/cli/src/uninstall/engine.ts': { branches: 90 },
        'packages/cli/src/restore/engine.ts': { branches: 90 },
        'packages/cli/src/transaction-journal.ts': { branches: 90 },
        'packages/cli/src/transaction-actions.ts': { branches: 90 },
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
        'packages/cli/src/commands/ui.ts': { branches: 90 },
        'packages/cli/src/ui/server.ts': { branches: 90 },
        'packages/cli/src/ui/compose.ts': { branches: 90 },
        'packages/cli/src/ui/skills.ts': { branches: 90 },
        'packages/cli/src/ui/wire.ts': { branches: 90 },
        'packages/ui/src/state.ts': { branches: 90 },
        'packages/ui/src/view.ts': { branches: 90 },
        'packages/ui/src/dom.ts': { branches: 90 },
        'packages/ui/src/main.ts': { branches: 90 },
        'packages/ui/src/messages.ts': { branches: 90 },
      },
    },
  },
});
