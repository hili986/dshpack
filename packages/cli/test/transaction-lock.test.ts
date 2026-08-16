import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createNodeTransactionAdapter,
  nodeTransactionAdapter,
  runTransaction,
  type TransactionAdapter,
  TransactionFailure,
  type TransactionJournal,
} from '../src/transaction.js';
import { rollbackTransaction } from '../src/transaction-rollback.js';

async function withTemporaryHome(operation: (dshHome: string) => Promise<void>): Promise<void> {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'dshpack-transaction-lock-'));
  if (dirname(root) !== parent) throw new Error(`unsafe temporary path: ${root}`);
  try {
    await operation(join(root, 'DSH home'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fastContender(): TransactionAdapter {
  let now = 0;
  return createNodeTransactionAdapter({
    clock: {
      now: () => {
        now += 3_000;
        return now;
      },
      sleep: async () => {},
    },
  });
}

async function expectCompetingWriterBlocked(
  dshHome: string,
  profilePath: string,
  txid: string,
): Promise<void> {
  let operationEntered = false;
  const result = await runTransaction(
    { adapter: fastContender(), dshHome, txid },
    async (transaction) => {
      operationEntered = true;
      await transaction.replaceProfile(profilePath);
    },
  );
  expect(result).toMatchObject({ ok: false, status: 'not-started', exitCode: 22 });
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      code: 'E_SETTINGS_LOCK_TIMEOUT',
      path: join(dshHome, '.dshpack', 'artifacts.lock'),
    }),
  );
  expect(operationEntered).toBe(false);
  expect(await nodeTransactionAdapter.pathExists(result.backupDirectory)).toBe(false);
}

describe('transaction artifact lease', () => {
  it('blocks protocol writers before identity recording and throughout apply', async () => {
    await withTemporaryHome(async (dshHome) => {
      const profilePath = join(dshHome, 'profiles', 'leased');
      let identityWindowChecked = false;
      const ownerAdapter: TransactionAdapter = {
        ...nodeTransactionAdapter,
        async pathIdentity(path) {
          if (path === profilePath && !identityWindowChecked) {
            identityWindowChecked = true;
            await expectCompetingWriterBlocked(dshHome, profilePath, 'identity-contender');
          }
          return nodeTransactionAdapter.pathIdentity(path);
        },
      };

      const result = await runTransaction(
        { adapter: ownerAdapter, dshHome, txid: 'lease-owner' },
        async (transaction) => {
          await transaction.create('profile', profilePath, async () => {
            await expectCompetingWriterBlocked(dshHome, profilePath, 'apply-contender');
            await writeFile(join(profilePath, 'package.json'), '{"private":true}\n', 'utf8');
          });
          throw new TransactionFailure(23, [
            { code: 'E_TEST_STEP', severity: 'error', message: 'rollback', evidence: 'local' },
          ]);
        },
      );

      expect(identityWindowChecked).toBe(true);
      expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 23 });
      const action = result.journal.actions[0];
      if (action?.kind !== 'create') throw new Error('missing create action');
      expect(await readFile(join(action.new.rollbackPath, 'package.json'), 'utf8')).toBe(
        '{"private":true}\n',
      );

      let nextOperationEntered = false;
      const next = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'post-release-writer' },
        async () => {
          nextOperationEntered = true;
        },
      );
      expect(next).toMatchObject({ ok: true, status: 'committed', exitCode: 0 });
      expect(nextOperationEntered).toBe(true);
    });
  });

  it('blocks a protocol writer between an observed identity and the final checked rename', async () => {
    await withTemporaryHome(async (dshHome) => {
      const profilePath = join(dshHome, 'profiles', 'final-check');
      let finalWindowChecked = false;
      const ownerAdapter: TransactionAdapter = {
        ...nodeTransactionAdapter,
        async moveArtifactPath(lock, artifact, artifactPath, backupPath, direction, identity) {
          expect(await nodeTransactionAdapter.pathIdentity(artifactPath)).toBe(identity);
          finalWindowChecked = true;
          await expectCompetingWriterBlocked(dshHome, profilePath, 'final-check-contender');
          return nodeTransactionAdapter.moveArtifactPath(
            lock,
            artifact,
            artifactPath,
            backupPath,
            direction,
            identity,
          );
        },
      };

      const result = await runTransaction(
        { adapter: ownerAdapter, dshHome, txid: 'final-check-owner' },
        async (transaction) => {
          await transaction.create('profile', profilePath, async () => {
            await writeFile(join(profilePath, 'package.json'), '{"private":true}\n', 'utf8');
          });
          throw new Error('trigger rollback');
        },
      );

      expect(finalWindowChecked).toBe(true);
      expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 70 });
      const action = result.journal.actions[0];
      if (action?.kind !== 'create') throw new Error('missing create action');
      expect(await readFile(join(action.new.rollbackPath, 'package.json'), 'utf8')).toBe(
        '{"private":true}\n',
      );
    });
  });

  it('keeps a durable committed state when lock release reports failure after commit', async () => {
    await withTemporaryHome(async (dshHome) => {
      const profilePath = join(dshHome, 'profiles', 'committed');
      const adapter = createNodeTransactionAdapter({
        async removeLock() {
          throw new Error('injected post-release failure');
        },
      });
      const result = await runTransaction(
        { adapter, dshHome, txid: 'commit-release-failure' },
        async (transaction) => {
          await transaction.create('profile', profilePath, async () => {
            await writeFile(join(profilePath, 'package.json'), '{"private":true}\n', 'utf8');
          });
        },
      );

      expect(result).toMatchObject({
        ok: false,
        status: 'committed',
        exitCode: 24,
        journal: { state: 'committed', actions: [{ phase: 'applied' }] },
        manualRecovery: [{ actionId: 'artifact-lock', operation: 'inspect-lock' }],
      });
      expect(await readFile(join(profilePath, 'package.json'), 'utf8')).toBe('{"private":true}\n');
      expect(JSON.parse(await readFile(result.journalPath, 'utf8'))).toMatchObject({
        state: 'committed',
      });
    });
  });

  it('rejects an inactive lease and a lease scoped to another DSH_HOME', async () => {
    await withTemporaryHome(async (dshHome) => {
      const released = await nodeTransactionAdapter.acquireArtifactLock(dshHome);
      await released.release();
      await expect(
        nodeTransactionAdapter.moveArtifactPath(
          released,
          'profile',
          join(dshHome, 'profiles', 'missing'),
          join(dshHome, '.dshpack', 'backups', 'inactive'),
          'to-backup',
          'identity',
        ),
      ).rejects.toThrow('artifact lock is not held');

      const wrongScope: TransactionAdapter = {
        ...nodeTransactionAdapter,
        async acquireArtifactLock(home) {
          const lock = await nodeTransactionAdapter.acquireArtifactLock(home);
          return { ...lock, dshHome: join(home, 'other-home') };
        },
      };
      const result = await runTransaction(
        { adapter: wrongScope, dshHome, txid: 'wrong-lock-scope' },
        async () => undefined,
      );
      expect(result).toMatchObject({ ok: false, status: 'not-started', exitCode: 31 });
      expect(result.diagnostics[0]).toMatchObject({
        code: 'E_TRANSACTION_ARTIFACT_LOCK_SCOPE',
        path: join(dshHome, '.dshpack', 'artifacts.lock'),
      });
    });
  });

  it('rejects backup paths outside the lease scope and refuses an occupied move target', async () => {
    await withTemporaryHome(async (dshHome) => {
      const lock = await nodeTransactionAdapter.acquireArtifactLock(dshHome);
      const profile = join(dshHome, 'profiles', 'source');
      const backupRoot = join(dshHome, '.dshpack', 'backups');
      try {
        await expect(
          nodeTransactionAdapter.moveArtifactPath(
            lock,
            'profile',
            profile,
            join(dirname(dshHome), 'outside-backup'),
            'to-backup',
          ),
        ).rejects.toThrow('outside its DSH_HOME scope');
        await expect(
          nodeTransactionAdapter.moveArtifactPath(
            lock,
            'profile',
            profile,
            backupRoot,
            'to-backup',
          ),
        ).rejects.toThrow('outside its DSH_HOME scope');

        const occupied = join(backupRoot, 'occupied');
        await nodeTransactionAdapter.ensureDirectory(profile);
        await nodeTransactionAdapter.ensureDirectory(occupied);
        await expect(
          nodeTransactionAdapter.moveArtifactPath(lock, 'profile', profile, occupied, 'to-backup'),
        ).rejects.toThrow(`move target exists: ${occupied}`);
      } finally {
        await lock.release();
      }
    });
  });

  it('preserves setup diagnostics when releasing the acquired lease also fails', async () => {
    await withTemporaryHome(async (dshHome) => {
      const adapter: TransactionAdapter = {
        ...nodeTransactionAdapter,
        async acquireArtifactLock(home) {
          const lock = await nodeTransactionAdapter.acquireArtifactLock(home);
          return {
            ...lock,
            dshHome: join(home, 'other-home'),
            async release() {
              await lock.release();
              throw new Error('injected setup release failure');
            },
          };
        },
      };
      const result = await runTransaction(
        { adapter, dshHome, txid: 'setup-release-failure' },
        async () => undefined,
      );
      expect(result).toMatchObject({ ok: false, status: 'not-started', exitCode: 24 });
      expect(result.diagnostics.map(({ code }) => code)).toEqual([
        'E_TRANSACTION_ARTIFACT_LOCK_SCOPE',
        'E_TRANSACTION_ARTIFACT_LOCK_RELEASE_FAILED',
      ]);
      expect(result.manualRecovery).toEqual([
        expect.objectContaining({
          actionId: 'artifact-lock',
          operation: 'inspect-lock',
          sourcePath: join(dshHome, '.dshpack', 'artifacts.lock'),
        }),
      ]);
    });
  });

  it('fails safe when rollback has actions but no artifact lease', async () => {
    await withTemporaryHome(async (dshHome) => {
      const backupDirectory = join(dshHome, '.dshpack', 'backups', 'missing-lock');
      const journalPath = join(backupDirectory, 'journal.json');
      const artifactPath = join(dshHome, 'skills', 'pending');
      const journal: TransactionJournal = {
        version: 0,
        txid: 'missing-lock',
        dshHome,
        backupDirectory,
        state: 'active',
        actions: [
          {
            id: 'action-0001',
            kind: 'create',
            artifact: 'skill',
            ownership: 'pending',
            phase: 'planned',
            old: { path: artifactPath, exists: false },
            new: {
              path: artifactPath,
              exists: true,
              rollbackPath: join(backupDirectory, 'new', 'action-0001'),
            },
          },
        ],
      };
      const result = await rollbackTransaction({
        adapter: nodeTransactionAdapter,
        artifactLock: undefined,
        backupDirectory,
        failures: [],
        journal,
        journalPath,
      });
      expect(result).toMatchObject({ ok: false, status: 'rollback-failed', exitCode: 24 });
      expect(result.diagnostics.map(({ code }) => code)).toContain('E_TRANSACTION_ROLLBACK_FAILED');
    });
  });

  it('fails safe when a reserved artifact identity cannot be recorded', async () => {
    await withTemporaryHome(async (dshHome) => {
      const profilePath = join(dshHome, 'profiles', 'missing-identity');
      let identityCalls = 0;
      const adapter: TransactionAdapter = {
        ...nodeTransactionAdapter,
        async pathIdentity(path) {
          if (path === profilePath && identityCalls++ === 0) return undefined;
          return nodeTransactionAdapter.pathIdentity(path);
        },
      };
      const result = await runTransaction(
        { adapter, dshHome, txid: 'missing-identity' },
        async (transaction) => {
          await transaction.create('profile', profilePath, async () => {
            throw new Error('apply must not run');
          });
        },
      );
      expect(result).toMatchObject({
        ok: false,
        status: 'rollback-failed',
        exitCode: 24,
        journal: { actions: [{ ownership: 'pending', phase: 'rollback-failed' }] },
      });
      expect(await nodeTransactionAdapter.pathExists(profilePath)).toBe(true);
    });
  });
});
