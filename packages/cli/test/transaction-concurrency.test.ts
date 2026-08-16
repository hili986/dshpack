import { dirname, join } from 'node:path';

import type { Diagnostic } from '@dshpack/core';
import { describe, expect, it } from 'vitest';

import {
  runTransaction,
  type TransactionAdapter,
  type TransactionArtifactKind,
  type TransactionArtifactLock,
  type TransactionArtifactMoveDirection,
  TransactionFailure,
} from '../src/transaction.js';

class OwnedMemoryAdapter implements TransactionAdapter {
  readonly entries = new Map<string, string>();
  readonly exclusiveCreates: string[] = [];
  readonly events: string[] = [];
  failAfterAtomicWrite: ((path: string, contents: string) => Error | undefined) | undefined;

  async acquireArtifactLock(dshHome: string): Promise<TransactionArtifactLock> {
    return { dshHome, lockPath: `${dshHome}.lock`, release: async () => {} };
  }

  async compareAndMoveText(path: string, expected: string, destination: string): Promise<boolean> {
    if (this.entries.get(path) !== expected) return false;
    await this.rename(path, destination);
    return true;
  }

  async compareAndSwapText(
    path: string,
    expected: string | undefined,
    replacement: string,
  ): Promise<boolean> {
    if (this.entries.get(path) !== expected) return false;
    await this.atomicWriteText(path, replacement);
    return true;
  }

  async createDirectoryExclusive(path: string): Promise<boolean> {
    this.exclusiveCreates.push(path);
    this.events.push(`mkdir:${path}`);
    if (this.entries.has(path)) return false;
    this.entries.set(dirname(path), '<directory>');
    this.entries.set(path, '<directory>');
    return true;
  }

  async ensureDirectory(path: string): Promise<void> {
    this.entries.set(path, '<directory>');
  }

  async pathExists(path: string): Promise<boolean> {
    return this.entries.has(path);
  }

  async pathIdentity(path: string): Promise<string | undefined> {
    return this.entries.has(path) ? path : undefined;
  }

  async moveArtifactPath(
    _lock: TransactionArtifactLock,
    _artifact: TransactionArtifactKind,
    artifactPath: string,
    backupPath: string,
    direction: TransactionArtifactMoveDirection,
    expectedIdentity?: string,
  ): Promise<boolean> {
    if (
      expectedIdentity !== undefined &&
      (await this.pathIdentity(artifactPath)) !== expectedIdentity
    )
      return false;
    await this.rename(
      direction === 'to-backup' ? artifactPath : backupPath,
      direction === 'to-backup' ? backupPath : artifactPath,
    );
    return true;
  }

  async readText(path: string): Promise<string> {
    const contents = this.entries.get(path);
    if (contents === undefined || contents === '<directory>') throw new Error(`missing: ${path}`);
    return contents;
  }

  async readTextIfExists(path: string): Promise<string | undefined> {
    return this.entries.has(path) ? this.readText(path) : undefined;
  }

  async atomicWriteText(path: string, contents: string): Promise<void> {
    this.entries.set(dirname(path), '<directory>');
    this.entries.set(path, contents);
    if (path.endsWith('journal.json')) this.events.push(`journal:${contents}`);
    const failure = this.failAfterAtomicWrite?.(path, contents);
    if (failure !== undefined) throw failure;
  }

  async rename(from: string, to: string): Promise<void> {
    const contents = this.entries.get(from);
    if (contents === undefined) throw new Error(`missing: ${from}`);
    if (this.entries.has(to)) throw new Error(`exists: ${to}`);
    this.entries.set(dirname(to), '<directory>');
    this.entries.set(to, contents);
    this.entries.delete(from);
  }

  async validateMutationPath(): Promise<void> {}

  populate(path: string, contents = '<artifact>'): void {
    if (!this.entries.has(path)) throw new Error(`not reserved: ${path}`);
    this.entries.set(path, contents);
  }

  seed(path: string, contents: string): void {
    this.entries.set(dirname(path), '<directory>');
    this.entries.set(path, contents);
  }
}

const failureDiagnostic: Diagnostic = {
  code: 'E_TEST_STEP',
  severity: 'error',
  message: 'injected step failure',
  evidence: 'local',
};

describe('transaction ownership and serialization', () => {
  it('exclusively reserves a new artifact before apply and commits it', async () => {
    const adapter = new OwnedMemoryAdapter();
    const dshHome = join('sandbox', 'commit-home');
    const skillPath = join(dshHome, 'skills', 'review');
    const result = await runTransaction(
      { adapter, dshHome, txid: 'tx-commit' },
      async (transaction) => {
        await transaction.create('skill', skillPath, async () => {
          expect(await adapter.pathExists(skillPath)).toBe(true);
          adapter.populate(skillPath, 'installed-skill');
        });
        return 'installed';
      },
    );

    expect(result).toMatchObject({
      ok: true,
      status: 'committed',
      exitCode: 0,
      value: 'installed',
    });
    expect(adapter.exclusiveCreates).toEqual([result.backupDirectory, skillPath]);
    const intent = adapter.events.findIndex(
      (event) => event.startsWith('journal:') && event.includes('"ownership": "pending"'),
    );
    expect(intent).toBeGreaterThanOrEqual(0);
    expect(intent).toBeLessThan(adapter.events.indexOf(`mkdir:${skillPath}`));
    expect(await adapter.readText(skillPath)).toBe('installed-skill');
    expect(result.journal).toMatchObject({ state: 'committed', actions: [{ phase: 'applied' }] });
  });

  it('serializes concurrent create calls so journal ids and rollback paths stay unique', async () => {
    const adapter = new OwnedMemoryAdapter();
    const dshHome = join('sandbox', 'parallel-home');
    const paths = [join(dshHome, 'skills', 'first'), join(dshHome, 'skills', 'second')];
    const result = await runTransaction(
      { adapter, dshHome, txid: 'tx-parallel' },
      async (transaction) => {
        await Promise.all(
          paths.map((path) =>
            transaction.create('skill', path, async () => adapter.populate(path)),
          ),
        );
        throw new TransactionFailure(23, [failureDiagnostic]);
      },
    );
    expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 23 });
    expect(result.journal.actions.map(({ id }) => id)).toEqual(['action-0001', 'action-0002']);
    const rollbackPaths = result.journal.actions.flatMap((action) =>
      action.kind === 'create' ? [action.new.rollbackPath] : [],
    );
    expect(new Set(rollbackPaths).size).toBe(2);
    await expect(Promise.all(rollbackPaths.map((path) => adapter.readText(path)))).resolves.toEqual(
      ['<artifact>', '<artifact>'],
    );
  });

  it('does not overwrite an external settings update during rollback', async () => {
    const adapter = new OwnedMemoryAdapter();
    const dshHome = join('sandbox', 'settings-race-home');
    const settingsPath = join(dshHome, 'settings.yaml');
    adapter.seed(settingsPath, 'preset: original\n');
    const result = await runTransaction(
      { adapter, dshHome, txid: 'tx-settings-race' },
      async (transaction) => {
        await transaction.writeSettings(
          settingsPath,
          'preset: original\n',
          'preset: transaction\n',
        );
        adapter.seed(settingsPath, 'preset: external\n');
        throw new TransactionFailure(30, [failureDiagnostic]);
      },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'rollback-failed',
      exitCode: 24,
      manualRecovery: [
        expect.objectContaining({
          actionId: 'action-0001',
          operation: 'atomic-write',
          destinationPath: settingsPath,
        }),
      ],
    });
    expect(await adapter.readText(settingsPath)).toBe('preset: external\n');
    expect(result.diagnostics.at(-1)).toMatchObject({
      code: 'E_TRANSACTION_ROLLBACK_FAILED',
      message: expect.stringContaining('changed after transaction write'),
    });
  });

  it('waits for an in-flight action before rollback when sibling work rejects', async () => {
    const adapter = new OwnedMemoryAdapter();
    const dshHome = join('sandbox', 'in-flight-home');
    const skillPath = join(dshHome, 'skills', 'slow');
    let applyFinished = false;
    let startedResolve = (): void => {};
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });

    const result = await runTransaction(
      { adapter, dshHome, txid: 'tx-in-flight' },
      async (transaction) => {
        const slowAction = transaction.create('skill', skillPath, async () => {
          adapter.populate(skillPath, 'completed-skill');
          startedResolve();
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          applyFinished = true;
        });
        const siblingFailure = (async (): Promise<void> => {
          await started;
          throw new TransactionFailure(23, [failureDiagnostic]);
        })();
        await Promise.all([slowAction, siblingFailure]);
      },
    );

    expect(applyFinished).toBe(true);
    expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 23 });
    expect(result.journal.actions).toMatchObject([{ phase: 'rolled-back' }]);
    const action = result.journal.actions[0];
    expect(action?.kind).toBe('create');
    if (action?.kind === 'create') {
      expect(await adapter.readText(action.new.rollbackPath)).toBe('completed-skill');
    }
  });

  it('replaces a post-write committed journal with rollback state before undoing actions', async () => {
    const adapter = new OwnedMemoryAdapter();
    const dshHome = join('sandbox', 'commit-journal-failure-home');
    const skillPath = join(dshHome, 'skills', 'review');
    let injected = false;
    adapter.failAfterAtomicWrite = (path, contents) => {
      if (!injected && path.endsWith('journal.json') && contents.includes('"state": "committed"')) {
        injected = true;
        return new Error('post-write directory fsync failure');
      }
      return undefined;
    };

    const result = await runTransaction(
      { adapter, dshHome, txid: 'tx-commit-journal-failure' },
      async (transaction) => {
        await transaction.create('skill', skillPath, async () => {
          adapter.populate(skillPath, 'installed-skill');
        });
      },
    );

    expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 70 });
    expect(result.diagnostics[0]).toMatchObject({
      code: 'E_TRANSACTION_ABORTED',
      message: expect.stringContaining('post-write directory fsync failure'),
    });
    expect(JSON.parse(await adapter.readText(result.journalPath))).toMatchObject({
      state: 'rolled-back',
      actions: [{ phase: 'rolled-back' }],
    });
  });

  it.each(['rolling-back', 'rolled-back'])(
    'returns exit 24 when the %s journal write fails',
    async (failedState) => {
      const adapter = new OwnedMemoryAdapter();
      const dshHome = join('sandbox', `${failedState}-journal-home`);
      const skillPath = join(dshHome, 'skills', 'review');
      let injected = false;
      adapter.failAfterAtomicWrite = (path, contents) => {
        if (
          !injected &&
          path.endsWith('journal.json') &&
          contents.includes(`"state": "${failedState}"`)
        ) {
          injected = true;
          return new Error(`injected ${failedState} journal failure`);
        }
        return undefined;
      };

      const result = await runTransaction(
        { adapter, dshHome, txid: `tx-${failedState}-journal` },
        async (transaction) => {
          await transaction.create('skill', skillPath, async () => {
            adapter.populate(skillPath, 'installed-skill');
          });
          throw new TransactionFailure(23, [failureDiagnostic]);
        },
      );

      expect(result).toMatchObject({ ok: false, status: 'rollback-failed', exitCode: 24 });
      expect(result.manualRecovery).toEqual([
        expect.objectContaining({ actionId: 'journal', operation: 'write-journal' }),
      ]);
      const action = result.journal.actions[0];
      expect(action?.kind).toBe('create');
      if (action?.kind === 'create') {
        expect(await adapter.readText(action.new.rollbackPath)).toBe('installed-skill');
      }
    },
  );

  it('reports both a sibling failure and a later queued action failure', async () => {
    const adapter = new OwnedMemoryAdapter();
    const dshHome = join('sandbox', 'double-failure-home');
    const paths = [join(dshHome, 'skills', 'first'), join(dshHome, 'skills', 'second')];
    const actionDiagnostic: Diagnostic = { ...failureDiagnostic, code: 'E_ACTION_STEP' };
    let startedResolve = (): void => {};
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });

    const result = await runTransaction(
      { adapter, dshHome, txid: 'tx-double-failure' },
      async (transaction) => {
        const first = transaction.create('skill', paths[0] as string, async () => {
          adapter.populate(paths[0] as string);
          startedResolve();
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          throw new TransactionFailure(30, [actionDiagnostic]);
        });
        const queued = transaction.create('skill', paths[1] as string, async () => {
          adapter.populate(paths[1] as string);
        });
        const sibling = (async (): Promise<void> => {
          await started;
          throw new TransactionFailure(23, [failureDiagnostic]);
        })();
        await Promise.all([first, queued, sibling]);
      },
    );
    expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 23 });
    expect(result.diagnostics.map(({ code }) => code)).toEqual(['E_TEST_STEP', 'E_ACTION_STEP']);
    expect(result.journal.actions).toHaveLength(1);
  });

  it('reports exact replace recovery paths when an external target blocks restoration', async () => {
    const adapter = new OwnedMemoryAdapter();
    const dshHome = join('sandbox', 'replace-conflict-home');
    const profilePath = join(dshHome, 'profiles', 'demo');
    adapter.seed(profilePath, 'original-profile');

    const result = await runTransaction(
      { adapter, dshHome, txid: 'tx-replace-conflict' },
      async (transaction) => {
        await transaction.replaceProfile(profilePath);
        adapter.seed(profilePath, 'external-profile');
        throw new TransactionFailure(23, [failureDiagnostic]);
      },
    );

    const preservedAt = join(result.backupDirectory, 'old', 'action-0001');
    expect(result).toMatchObject({
      ok: false,
      status: 'rollback-failed',
      exitCode: 24,
      manualRecovery: [
        expect.objectContaining({
          operation: 'rename',
          sourcePath: preservedAt,
          destinationPath: profilePath,
        }),
      ],
    });
    expect(await adapter.readText(profilePath)).toBe('external-profile');
    expect(await adapter.readText(preservedAt)).toBe('original-profile');
  });
});
