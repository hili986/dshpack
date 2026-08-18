import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createNodeTransactionAdapter,
  runTransaction,
  type TransactionAdapter,
  TransactionFailure,
} from '../src/transaction.js';

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'dshpack-transaction-managed-'));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const injected = new TransactionFailure(23, [
  {
    code: 'E_TEST_MANAGED',
    severity: 'error',
    message: 'injected managed action failure',
    hint: 'test only',
    evidence: 'local',
  },
]);

describe('managed transaction actions', () => {
  it.each([
    ['skill', 'skills'],
    ['preset', '.agent-presets'],
  ] as const)(
    'backs up and restores a force-replaced %s without deleting either copy',
    async (kind, root) => {
      await withHome(async (home) => {
        const target = join(home, root, 'demo');
        await mkdir(target, { recursive: true });
        await writeFile(join(target, 'owner.txt'), 'user-original', 'utf8');

        const result = await runTransaction(
          { adapter: createNodeTransactionAdapter(), dshHome: home, txid: `replace-${kind}` },
          async (transaction) => {
            await transaction.replaceArtifact(kind, target);
            await transaction.create(kind, target, async () => {
              await writeFile(join(target, 'owner.txt'), 'pack-replacement', 'utf8');
            });
            throw injected;
          },
        );

        expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 23 });
        expect(await readFile(join(target, 'owner.txt'), 'utf8')).toBe('user-original');
        const replacement = result.journal.actions[1];
        expect(replacement?.kind).toBe('create');
        if (replacement?.kind !== 'create') throw new Error('missing replacement create action');
        expect(await readFile(join(replacement.new.rollbackPath, 'owner.txt'), 'utf8')).toBe(
          'pack-replacement',
        );
        expect(result.journal.actions[0]).toMatchObject({ kind: 'replace', artifact: kind });
      });
    },
  );

  it('durably journals a replace before the first rename', async () => {
    await withHome(async (home) => {
      const target = join(home, 'skills', 'demo');
      await mkdir(target, { recursive: true });
      const base = createNodeTransactionAdapter();
      let sawPlannedJournal = false;
      const adapter: TransactionAdapter = {
        ...base,
        async moveArtifactPath(lock, artifact, artifactPath, backupPath, direction, identity) {
          if (direction === 'to-backup' && artifactPath === target) {
            const journal = JSON.parse(
              await readFile(
                join(home, '.dshpack', 'backups', 'journal-before-rename', 'journal.json'),
                'utf8',
              ),
            ) as { actions: Array<{ artifact: string; phase: string }> };
            sawPlannedJournal = journal.actions.some(
              (action) => action.artifact === 'skill' && action.phase === 'planned',
            );
          }
          return base.moveArtifactPath(
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
        { adapter, dshHome: home, txid: 'journal-before-rename' },
        async (transaction) => transaction.replaceArtifact('skill', target),
      );

      expect(result.ok).toBe(true);
      expect(sawPlannedJournal).toBe(true);
    });
  });

  it('restores an overwritten installed record byte-for-byte and journals both documents', async () => {
    await withHome(async (home) => {
      const record = join(home, '.dshpack', 'installed', 'demo.json');
      const original = '{\n  "owner": "user"\n}\n';
      const replacement = '{"owner":"dshpack"}\n';
      await mkdir(join(home, '.dshpack', 'installed'), { recursive: true });
      await writeFile(record, original, 'utf8');

      const result = await runTransaction(
        { adapter: createNodeTransactionAdapter(), dshHome: home, txid: 'record-overwrite' },
        async (transaction) => {
          await transaction.writeManagedDocument(record, replacement);
          throw injected;
        },
      );

      expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 23 });
      expect(await readFile(record, 'utf8')).toBe(original);
      const action = result.journal.actions.find(
        (
          entry,
        ): entry is Extract<
          (typeof result.journal.actions)[number],
          { kind: 'managed-document-write' }
        > => entry.kind === 'managed-document-write',
      );
      expect(action).toMatchObject({ kind: 'managed-document-write', phase: 'rolled-back' });
      if (action?.kind !== 'managed-document-write' || !action.old.exists) {
        throw new Error('missing managed document action');
      }
      expect(await readFile(action.old.documentPath, 'utf8')).toBe(original);
      expect(await readFile(action.new.documentPath, 'utf8')).toBe(replacement);
    });
  });

  it('moves a newly-created installed record into backup during rollback', async () => {
    await withHome(async (home) => {
      const record = join(home, '.dshpack', 'installed', 'new.json');
      const replacement = '{"new":true}\n';
      const result = await runTransaction(
        { adapter: createNodeTransactionAdapter(), dshHome: home, txid: 'record-new' },
        async (transaction) => {
          await transaction.writeManagedDocument(record, replacement);
          throw injected;
        },
      );

      expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 23 });
      await expect(readFile(record, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const action = result.journal.actions.find(
        (
          entry,
        ): entry is Extract<
          (typeof result.journal.actions)[number],
          { kind: 'managed-document-write' }
        > => entry.kind === 'managed-document-write',
      );
      if (action?.kind !== 'managed-document-write') {
        throw new Error('missing managed document action');
      }
      expect(await readFile(action.new.rollbackPath, 'utf8')).toBe(replacement);
    });
  });

  it('restores a transaction-bound deleted installed marker byte-for-byte on rollback', async () => {
    await withHome(async (home) => {
      const record = join(home, '.dshpack', 'installed', 'demo-pack.json');
      const original = '{\n  "metadataVersion": 1\n}\n';
      await mkdir(join(home, '.dshpack', 'installed'), { recursive: true });
      await writeFile(record, original, 'utf8');
      const stats = await lstat(record, { bigint: true });
      const identity = `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;

      const result = await runTransaction(
        { adapter: createNodeTransactionAdapter(), dshHome: home, txid: 'record-delete' },
        async (transaction) => {
          await transaction.deleteManagedDocument(record, original, identity);
          await expect(readFile(record, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
          throw injected;
        },
      );

      expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 23 });
      expect(await readFile(record, 'utf8')).toBe(original);
      expect(result.journal.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            artifact: 'managed-document',
            kind: 'replace',
            phase: 'rolled-back',
          }),
        ]),
      );
    });
  });

  it('reports exit 25 and exact manual paths when managed-record rollback itself fails', async () => {
    await withHome(async (home) => {
      const record = join(home, '.dshpack', 'installed', 'blocked.json');
      const base = createNodeTransactionAdapter();
      const adapter: TransactionAdapter = {
        ...base,
        async compareAndMoveManagedDocument(path, expected, destination) {
          if (path === record) throw new Error('injected managed rollback failure');
          if (base.compareAndMoveManagedDocument === undefined)
            throw new Error('managed document rollback is required');
          return base.compareAndMoveManagedDocument(path, expected, destination);
        },
      };
      const result = await runTransaction(
        { adapter, dshHome: home, txid: 'record-rollback-failed' },
        async (transaction) => {
          await transaction.writeManagedDocument(record, '{"partial":true}\n');
          throw injected;
        },
      );

      const action = result.journal.actions.find(
        (
          entry,
        ): entry is Extract<
          (typeof result.journal.actions)[number],
          { kind: 'managed-document-write' }
        > => entry.kind === 'managed-document-write',
      );
      if (action?.kind !== 'managed-document-write') {
        throw new Error('missing managed document action');
      }
      expect(result).toMatchObject({ ok: false, status: 'rollback-failed', exitCode: 25 });
      expect(result.manualRecovery).toEqual(
        expect.arrayContaining([
          {
            actionId: action.id,
            operation: 'rename',
            sourcePath: record,
            destinationPath: action.new.rollbackPath,
            reason: 'injected managed rollback failure',
          },
        ]),
      );
      expect(
        result.diagnostics.find(
          (item) => item.code === 'E_TRANSACTION_ROLLBACK_FAILED' && item.path === record,
        ),
      ).toMatchObject({
        code: 'E_TRANSACTION_ROLLBACK_FAILED',
        path: record,
        hint: expect.stringContaining(action.new.rollbackPath),
      });
      expect(await readFile(record, 'utf8')).toBe('{"partial":true}\n');
    });
  });

  it('rejects installed records outside the exact managed leaf scope', async () => {
    await withHome(async (home) => {
      const outside = join(home, '.dshpack', 'other', 'demo.json');
      const nested = join(home, '.dshpack', 'installed', 'nested', 'demo.json');
      for (const [txid, path] of [
        ['record-other', outside],
        ['record-nested', nested],
      ] as const) {
        const result = await runTransaction(
          { adapter: createNodeTransactionAdapter(), dshHome: home, txid },
          async (transaction) => transaction.writeManagedDocument(path, '{}\n'),
        );
        expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 31 });
        expect(result.diagnostics).toEqual([
          expect.objectContaining({ code: 'E_TRANSACTION_MANAGED_DOCUMENT_PATH_SCOPE', path }),
        ]);
      }
    });
  });

  it('fails closed on an installed-directory alias that escapes DSH_HOME', async () => {
    await withHome(async (home) => {
      const outside = await mkdtemp(join(tmpdir(), 'dshpack-installed-outside-'));
      try {
        await mkdir(join(home, '.dshpack'), { recursive: true });
        await symlink(
          outside,
          join(home, '.dshpack', 'installed'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        const record = join(home, '.dshpack', 'installed', 'demo.json');
        const result = await runTransaction(
          { adapter: createNodeTransactionAdapter(), dshHome: home, txid: 'record-alias' },
          async (transaction) => transaction.writeManagedDocument(record, '{}\n'),
        );
        expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 31 });
        expect(result.diagnostics).toEqual([
          expect.objectContaining({
            code: 'E_TRANSACTION_MANAGED_DOCUMENT_PATH_SCOPE',
            path: record,
          }),
        ]);
        await expect(readFile(join(outside, 'demo.json'), 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});
