import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { Diagnostic } from '@dshpack/core';
import { describe, expect, it } from 'vitest';

import {
  createNodeTransactionAdapter,
  nodeTransactionAdapter,
  runTransaction,
  type TransactionAdapter,
  TransactionFailure,
} from '../src/transaction.js';

const failureDiagnostic: Diagnostic = {
  code: 'E_TEST_STEP',
  severity: 'error',
  message: 'injected later failure',
  evidence: 'local',
};

async function withTemporaryHome(operation: (dshHome: string) => Promise<void>): Promise<void> {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'dshpack-fresh-home-'));
  if (dirname(root) !== parent) throw new Error(`unsafe temporary path: ${root}`);
  try {
    await operation(join(root, 'DSH home'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('transaction fresh-home and identity safety', () => {
  it('moves a transaction-created settings file into backup when the original was absent', async () => {
    await withTemporaryHome(async (dshHome) => {
      const settingsPath = join(dshHome, 'settings.yaml');
      const replacement = 'agent-presets:\n  default: research\n';
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'fresh-settings-rollback' },
        async (transaction) => {
          await transaction.writeSettings(settingsPath, undefined, replacement);
          throw new TransactionFailure(23, [failureDiagnostic]);
        },
      );

      expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 23 });
      await expect(readFile(settingsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const action = result.journal.actions[0];
      expect(action?.kind).toBe('settings-write');
      if (action?.kind === 'settings-write') {
        expect(action.old).toEqual({ path: settingsPath, exists: false });
        expect(action.writeState).toBe('written');
        expect(await readFile(action.new.rollbackPath, 'utf8')).toBe(replacement);
      }
      expect(JSON.parse(await readFile(result.journalPath, 'utf8'))).toMatchObject({
        state: 'rolled-back',
        actions: [{ old: { path: settingsPath, exists: false } }],
      });
    });
  });

  it('does not move an external same-content settings file after a forward CAS mismatch', async () => {
    await withTemporaryHome(async (dshHome) => {
      const settingsPath = join(dshHome, 'settings.yaml');
      const replacement = 'agent-presets:\n  default: external\n';
      let injected = false;
      const adapter: TransactionAdapter = {
        ...nodeTransactionAdapter,
        async compareAndSwapText(path, expected, next) {
          if (!injected && path === settingsPath) {
            injected = true;
            expect(
              await nodeTransactionAdapter.compareAndSwapText(path, undefined, replacement),
            ).toBe(true);
          }
          return nodeTransactionAdapter.compareAndSwapText(path, expected, next);
        },
        async compareAndMoveText() {
          throw new Error('not-written settings must not be moved');
        },
      };

      const result = await runTransaction(
        { adapter, dshHome, txid: 'fresh-settings-same-content' },
        async (transaction) => transaction.writeSettings(settingsPath, undefined, replacement),
      );

      expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 30 });
      expect(result.journal.actions).toMatchObject([
        {
          kind: 'settings-write',
          writeState: 'not-written',
          old: { exists: false },
        },
      ]);
      expect(await readFile(settingsPath, 'utf8')).toBe(replacement);
    });
  });

  it('reports exact paths when an external write blocks fresh-settings rollback', async () => {
    await withTemporaryHome(async (dshHome) => {
      const settingsPath = join(dshHome, 'settings.yaml');
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'fresh-settings-conflict' },
        async (transaction) => {
          await transaction.writeSettings(settingsPath, undefined, 'agent-presets: {}\n');
          await writeFile(settingsPath, 'external: true\n', 'utf8');
          throw new TransactionFailure(23, [failureDiagnostic]);
        },
      );

      const action = result.journal.actions[0];
      expect(action?.kind).toBe('settings-write');
      if (action?.kind !== 'settings-write') throw new Error('missing settings action');
      expect(result).toMatchObject({
        ok: false,
        status: 'rollback-failed',
        exitCode: 25,
        manualRecovery: [
          expect.objectContaining({
            operation: 'rename',
            sourcePath: settingsPath,
            destinationPath: action.new.rollbackPath,
          }),
        ],
      });
      expect(await readFile(settingsPath, 'utf8')).toBe('external: true\n');
    });
  });

  it.each([
    { label: 'is missing', replace: false },
    { label: 'was replaced at the same path', replace: true },
  ])('does not move an owned artifact that $label', async ({ replace }) => {
    await withTemporaryHome(async (dshHome) => {
      const skillPath = join(dshHome, 'skills', 'identity-check');
      const relativeTarget = relative(dshHome, skillPath);
      if (relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) {
        throw new Error(`unsafe artifact path: ${skillPath}`);
      }
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: `artifact-${replace}` },
        async (transaction) => {
          await transaction.create('skill', skillPath, async () => {
            await writeFile(join(skillPath, 'SKILL.md'), 'transaction artifact', 'utf8');
            await rm(skillPath, { recursive: true, force: true });
            if (replace) {
              await mkdir(skillPath, { recursive: true });
              await writeFile(join(skillPath, 'external.txt'), 'external artifact', 'utf8');
            }
          });
          throw new TransactionFailure(23, [failureDiagnostic]);
        },
      );

      expect(result).toMatchObject({
        ok: false,
        status: 'rollback-failed',
        exitCode: 25,
        journal: { actions: [{ kind: 'create', ownership: 'owned' }] },
        manualRecovery: [
          expect.objectContaining({
            operation: 'rename',
            sourcePath: skillPath,
          }),
        ],
      });
      const action = result.journal.actions[0];
      if (action?.kind !== 'create') throw new Error('missing create action');
      expect(action.new.identity).toBeDefined();
      expect(await nodeTransactionAdapter.pathExists(action.new.rollbackPath)).toBe(false);
      if (replace) {
        expect(await nodeTransactionAdapter.pathIdentity(skillPath)).not.toBe(action.new.identity);
        expect(await readFile(join(skillPath, 'external.txt'), 'utf8')).toBe('external artifact');
      } else {
        expect(await nodeTransactionAdapter.pathIdentity(skillPath)).toBeUndefined();
      }
    });
  });

  it('retains the text from a non-Error operation failure', async () => {
    await withTemporaryHome(async (dshHome) => {
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'string-error' },
        async () => {
          throw 'plain failure';
        },
      );
      expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 70 });
      expect(result.diagnostics[0]?.message).toContain('plain failure');
    });
  });

  it('maps a production settings lock timeout to exit 22', async () => {
    await withTemporaryHome(async (dshHome) => {
      const settingsPath = join(dshHome, 'settings.yaml');
      await mkdir(dshHome, { recursive: true });
      await writeFile(`${settingsPath}.lock`, 'external owner', 'utf8');
      let now = 0;
      const adapter = createNodeTransactionAdapter({
        clock: {
          now: () => {
            now += 3_000;
            return now;
          },
          sleep: async () => {},
        },
      });

      await expect(
        adapter.compareAndSwapText(settingsPath, undefined, 'new'),
      ).rejects.toMatchObject({
        exitCode: 22,
        diagnostics: [{ code: 'E_SETTINGS_LOCK_TIMEOUT' }],
      });
    });
  });

  it('does not misclassify non-ENOENT identity and read errors as missing', async () => {
    await withTemporaryHome(async (dshHome) => {
      const invalidPath = `${dshHome}${String.fromCharCode(0)}child`;
      await expect(nodeTransactionAdapter.pathIdentity(invalidPath)).rejects.toBeDefined();
      await expect(nodeTransactionAdapter.readTextIfExists(invalidPath)).rejects.toBeDefined();
    });
  });

  it('returns exit 31 before acquiring a lock for an unsafe txid', async () => {
    await withTemporaryHome(async (dshHome) => {
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: '../escape' },
        async () => undefined,
      );
      expect(result).toMatchObject({ ok: false, status: 'not-started', exitCode: 31 });
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: 'E_TRANSACTION_ID', path: '../escape' }),
      ]);
    });
  });

  it('releases the artifact lock when a txid backup already exists', async () => {
    await withTemporaryHome(async (dshHome) => {
      const backup = join(dshHome, '.dshpack', 'backups', 'duplicate-tx');
      const journalPath = join(backup, 'journal.json');
      await mkdir(backup, { recursive: true });
      await writeFile(journalPath, 'previous journal', 'utf8');
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'duplicate-tx' },
        async () => undefined,
      );
      expect(result).toMatchObject({ ok: false, status: 'not-started', exitCode: 22 });
      expect(await readFile(journalPath, 'utf8')).toBe('previous journal');
      expect(
        await nodeTransactionAdapter.pathExists(join(dshHome, '.dshpack', 'artifacts.lock')),
      ).toBe(false);
    });
  });

  it('surfaces a caught missing-replace failure before commit', async () => {
    await withTemporaryHome(async (dshHome) => {
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'caught-replace' },
        async (transaction) => {
          try {
            await transaction.replaceProfile(join(dshHome, 'profiles', 'missing'));
          } catch {
            // A caught action error still marks the transaction failed.
          }
        },
      );
      expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 22 });
      expect(result.diagnostics[0]).toMatchObject({ code: 'E_TRANSACTION_REPLACE_MISSING' });
    });
  });
});
