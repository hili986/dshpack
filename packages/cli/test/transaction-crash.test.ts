import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { compareAndSwapText as compareSettingsText } from '../src/adapters/settings.js';
import {
  type CreateJournalAction,
  nodeTransactionAdapter,
  type ReplaceJournalAction,
  runTransaction,
  type TransactionAdapter,
  type TransactionArtifactLock,
  TransactionFailure,
} from '../src/transaction.js';
import { rollbackAction } from '../src/transaction-journal.js';

async function withTemporaryRoot(operation: (root: string) => Promise<void>): Promise<void> {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'dshpack-transaction-crash-'));
  if (dirname(root) !== parent) throw new Error(`unsafe temporary path: ${root}`);
  try {
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withArtifactLock<T>(
  dshHome: string,
  operation: (lock: TransactionArtifactLock) => Promise<T>,
): Promise<T> {
  const lock = await nodeTransactionAdapter.acquireArtifactLock(dshHome);
  try {
    return await operation(lock);
  } finally {
    await lock.release();
  }
}

describe('transaction crash windows', () => {
  it('retains a stable fallback message for a diagnostic-free internal failure', () => {
    expect(new TransactionFailure(70, []).message).toBe('事务步骤失败。');
  });

  it('requires manual recovery when mkdir succeeded but ownership was not confirmed', async () => {
    await withTemporaryRoot(async (root) => {
      const dshHome = join(root, 'home');
      const skillPath = join(dshHome, 'skills', 'ambiguous');
      const adapter: TransactionAdapter = {
        ...nodeTransactionAdapter,
        async createDirectoryExclusive(path) {
          const created = await nodeTransactionAdapter.createDirectoryExclusive(path);
          if (path === skillPath && created) throw new Error('crash after mkdir');
          return created;
        },
      };

      const result = await runTransaction(
        { adapter, dshHome, txid: 'pending-ownership' },
        async (transaction) => {
          await transaction.create('skill', skillPath, async () => {
            throw new Error('apply must not run');
          });
        },
      );

      expect(result).toMatchObject({
        ok: false,
        status: 'rollback-failed',
        exitCode: 24,
        journal: {
          actions: [{ ownership: 'pending', phase: 'rollback-failed' }],
        },
        manualRecovery: [
          expect.objectContaining({
            actionId: 'action-0001',
            operation: 'rename',
            sourcePath: skillPath,
          }),
        ],
      });
      await expect(stat(skillPath)).resolves.toBeDefined();
    });
  });

  it('returns exit 24 when settings changed but lock release leaves the result unknown', async () => {
    await withTemporaryRoot(async (root) => {
      const dshHome = join(root, 'home');
      const settingsPath = join(dshHome, 'settings.yaml');
      const original = '# original\nagent-presets: {}\n';
      const replacement = 'agent-presets:\n  default: research\n';
      await mkdir(dshHome, { recursive: true });
      await writeFile(settingsPath, original, 'utf8');
      let calls = 0;
      const adapter: TransactionAdapter = {
        ...nodeTransactionAdapter,
        async compareAndSwapText(path, expected, next) {
          calls += 1;
          const result = await compareSettingsText(path, expected, next, {
            removeLock: async () => {
              throw new Error('injected lock release failure');
            },
          });
          if (!result.ok || result.value === undefined) {
            throw new TransactionFailure(70, result.diagnostics);
          }
          return result.value;
        },
      };

      const result = await runTransaction(
        { adapter, dshHome, txid: 'settings-release-failure' },
        async (transaction) => transaction.writeSettings(settingsPath, original, replacement),
      );

      expect(result).toMatchObject({
        ok: false,
        status: 'rollback-failed',
        exitCode: 24,
        journal: { actions: [{ kind: 'settings-write', writeState: 'pending' }] },
        manualRecovery: [
          expect.objectContaining({
            actionId: 'action-0001',
            operation: 'atomic-write',
            destinationPath: settingsPath,
          }),
        ],
      });
      expect(result.diagnostics.map(({ code }) => code)).toEqual([
        'E_SETTINGS_IO',
        'E_TRANSACTION_ROLLBACK_FAILED',
      ]);
      expect(calls).toBe(1);
      expect(await readFile(settingsPath, 'utf8')).toBe(replacement);
    });
  });

  it('requires manual recovery when CAS succeeded before an unconfirmed adapter error', async () => {
    await withTemporaryRoot(async (root) => {
      const dshHome = join(root, 'home');
      const settingsPath = join(dshHome, 'settings.yaml');
      const original = 'agent-presets: {}\n';
      await mkdir(dshHome, { recursive: true });
      await writeFile(settingsPath, original, 'utf8');
      let calls = 0;
      const adapter: TransactionAdapter = {
        ...nodeTransactionAdapter,
        async compareAndSwapText(path, expected, replacement) {
          calls += 1;
          const swapped = await nodeTransactionAdapter.compareAndSwapText(
            path,
            expected,
            replacement,
          );
          if (calls === 1 && swapped) throw new Error('post-CAS acknowledgement failure');
          return swapped;
        },
      };

      const result = await runTransaction(
        { adapter, dshHome, txid: 'settings-unconfirmed-write' },
        async (transaction) =>
          transaction.writeSettings(
            settingsPath,
            original,
            'agent-presets:\n  default: research\n',
          ),
      );

      expect(result).toMatchObject({
        ok: false,
        status: 'rollback-failed',
        exitCode: 24,
        journal: {
          actions: [{ kind: 'settings-write', writeState: 'pending', phase: 'rollback-failed' }],
        },
        manualRecovery: [
          expect.objectContaining({
            actionId: 'action-0001',
            operation: 'atomic-write',
            destinationPath: settingsPath,
          }),
        ],
      });
      expect(calls).toBe(1);
      expect(await readFile(settingsPath, 'utf8')).toBe('agent-presets:\n  default: research\n');
    });
  });

  it('distinguishes an absent pending artifact from a lost replace backup', async () => {
    await withTemporaryRoot(async (root) => {
      const pending: CreateJournalAction = {
        id: 'action-0001',
        kind: 'create',
        artifact: 'skill',
        ownership: 'pending',
        phase: 'planned',
        old: { path: join(root, 'skills', 'missing-skill'), exists: false },
        new: {
          path: join(root, 'skills', 'missing-skill'),
          exists: true,
          rollbackPath: join(root, 'backup', 'new', 'action-0001'),
        },
      };
      await expect(
        withArtifactLock(root, (lock) => rollbackAction(nodeTransactionAdapter, lock, pending)),
      ).resolves.toBeUndefined();

      const replace: ReplaceJournalAction = {
        id: 'action-0002',
        kind: 'replace',
        artifact: 'profile',
        phase: 'planned',
        old: { path: join(root, 'profiles', 'missing-profile'), exists: true },
        new: {
          path: join(root, 'profiles', 'missing-profile'),
          exists: false,
          preservedAt: join(root, 'backup', 'old', 'action-0002'),
        },
      };
      await expect(
        withArtifactLock(root, (lock) => rollbackAction(nodeTransactionAdapter, lock, replace)),
      ).rejects.toThrow('preserved original is missing');
    });
  });

  it('preserves a typed settings failure raised during rollback', async () => {
    await withTemporaryRoot(async (root) => {
      const dshHome = join(root, 'home');
      const settingsPath = join(dshHome, 'settings.yaml');
      await mkdir(dshHome, { recursive: true });
      await writeFile(settingsPath, 'agent-presets: {}\n', 'utf8');
      let calls = 0;
      const adapter: TransactionAdapter = {
        ...nodeTransactionAdapter,
        async compareAndSwapText(path, expected, replacement) {
          calls += 1;
          if (calls === 1) {
            return nodeTransactionAdapter.compareAndSwapText(path, expected, replacement);
          }
          throw new TransactionFailure(22, [
            {
              code: 'E_SETTINGS_LOCK_TIMEOUT',
              severity: 'error',
              message: 'rollback lock timeout',
              path,
              evidence: 'local',
            },
          ]);
        },
      };

      const result = await runTransaction(
        { adapter, dshHome, txid: 'rollback-settings-lock' },
        async (transaction) => {
          await transaction.writeSettings(
            settingsPath,
            'agent-presets: {}\n',
            'agent-presets:\n  default: research\n',
          );
          throw new Error('later step failed');
        },
      );

      expect(result).toMatchObject({ ok: false, status: 'rollback-failed', exitCode: 24 });
      expect(result.diagnostics.map(({ code }) => code)).toEqual([
        'E_TRANSACTION_ABORTED',
        'E_SETTINGS_LOCK_TIMEOUT',
        'E_TRANSACTION_ROLLBACK_FAILED',
      ]);
      expect(calls).toBe(2);
    });
  });

  it('maps production settings CAS I/O errors to a typed transaction failure', async () => {
    await withTemporaryRoot(async (root) => {
      const blockingFile = join(root, 'not-a-directory');
      await writeFile(blockingFile, 'blocking parent', 'utf8');
      await expect(
        nodeTransactionAdapter.compareAndSwapText(
          join(blockingFile, 'settings.yaml'),
          'old',
          'new',
        ),
      ).rejects.toMatchObject({
        exitCode: 70,
        diagnostics: [{ code: 'E_SETTINGS_IO' }],
      });
    });
  });
});
