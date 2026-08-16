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

class MemoryTransactionAdapter implements TransactionAdapter {
  readonly entries = new Map<string, string>();
  readonly atomicWrites: Array<{ path: string; contents: string }> = [];
  readonly exclusiveCreates: string[] = [];
  failRename: ((from: string, to: string) => Error | undefined) | undefined;
  failAtomicWrite: ((path: string, contents: string) => Error | undefined) | undefined;

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

  async createDirectoryExclusive(path: string): Promise<boolean> {
    this.exclusiveCreates.push(path);
    if (this.entries.has(path)) return false;
    this.entries.set(dirname(path), '<directory>');
    this.entries.set(path, '<directory>');
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
    const failure = this.failAtomicWrite?.(path, contents);
    if (failure !== undefined) throw failure;
    this.entries.set(dirname(path), '<directory>');
    this.entries.set(path, contents);
    this.atomicWrites.push({ path, contents });
  }

  async rename(from: string, to: string): Promise<void> {
    const failure = this.failRename?.(from, to);
    if (failure !== undefined) throw failure;
    const contents = this.entries.get(from);
    if (contents === undefined) throw new Error(`missing: ${from}`);
    if (this.entries.has(to)) throw new Error(`exists: ${to}`);
    this.entries.set(dirname(to), '<directory>');
    this.entries.set(to, contents);
    this.entries.delete(from);
  }

  async validateMutationPath(): Promise<void> {}

  create(path: string, contents = '<artifact>'): void {
    if (this.entries.has(path)) throw new Error(`exists: ${path}`);
    this.entries.set(dirname(path), '<directory>');
    this.entries.set(path, contents);
  }

  populate(path: string, contents = '<artifact>'): void {
    if (!this.entries.has(path)) throw new Error(`not reserved: ${path}`);
    this.entries.set(path, contents);
  }
}

const failureDiagnostic: Diagnostic = {
  code: 'E_TEST_STEP',
  severity: 'error',
  message: 'injected step failure',
  hint: 'test-only failure',
  evidence: 'local',
};

describe('runTransaction', () => {
  it.each([1, 2, 3])('rolls back artifacts when injected step %s fails', async (failureAt) => {
    const adapter = new MemoryTransactionAdapter();
    const dshHome = join('sandbox', `home-${failureAt}`);
    const artifacts = [
      { kind: 'profile' as const, path: join(dshHome, 'profiles', 'demo') },
      { kind: 'skill' as const, path: join(dshHome, 'skills', 'review') },
      { kind: 'preset' as const, path: join(dshHome, '.agent-presets', 'demo') },
    ];
    let step = 0;

    const result = await runTransaction(
      { adapter, dshHome, txid: `tx-step-${failureAt}` },
      async (transaction) => {
        for (const artifact of artifacts) {
          await transaction.create(artifact.kind, artifact.path, async () => {
            adapter.populate(artifact.path);
            step += 1;
            if (step === failureAt) {
              throw new TransactionFailure(23, [failureDiagnostic]);
            }
          });
        }
      },
    );

    expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 23 });
    expect(result.journal.actions).toHaveLength(failureAt);
    expect(result.journal.actions.every((action) => 'old' in action && 'new' in action)).toBe(true);
    for (const action of result.journal.actions) {
      expect(action.phase).toBe('rolled-back');
      if (action.kind === 'create') {
        expect(await adapter.pathExists(action.old.path)).toBe(false);
        expect(await adapter.pathExists(action.new.rollbackPath)).toBe(true);
      }
    }
    expect(result.journalPath).toBe(
      join(dshHome, '.dshpack', 'backups', `tx-step-${failureAt}`, 'journal.json'),
    );
    expect(JSON.parse(await adapter.readText(result.journalPath))).toMatchObject({
      txid: `tx-step-${failureAt}`,
      state: 'rolled-back',
    });
  });

  it('moves the replacement aside and restores the original profile', async () => {
    const adapter = new MemoryTransactionAdapter();
    const dshHome = join('sandbox', 'replace-home');
    const profilePath = join(dshHome, 'profiles', 'demo');
    adapter.create(profilePath, 'original-profile');

    const result = await runTransaction(
      { adapter, dshHome, txid: 'tx-replace' },
      async (transaction) => {
        await transaction.replaceProfile(profilePath);
        await transaction.create('profile', profilePath, async () => {
          adapter.populate(profilePath, 'replacement-profile');
        });
        throw new TransactionFailure(23, [failureDiagnostic]);
      },
    );

    expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 23 });
    expect(await adapter.readText(profilePath)).toBe('original-profile');
    expect(result.journal.actions.map(({ kind, phase }) => ({ kind, phase }))).toEqual([
      { kind: 'replace', phase: 'rolled-back' },
      { kind: 'create', phase: 'rolled-back' },
    ]);
    const createAction = result.journal.actions[1];
    expect(createAction?.kind).toBe('create');
    if (createAction?.kind === 'create') {
      expect(await adapter.readText(createAction.new.rollbackPath)).toBe('replacement-profile');
    }
    const replaceAction = result.journal.actions[0];
    expect(replaceAction?.kind).toBe('replace');
    if (replaceAction?.kind === 'replace') {
      expect(replaceAction.old).toEqual({ path: profilePath, exists: true });
      expect(replaceAction.new).toEqual({
        path: profilePath,
        exists: false,
        preservedAt: join(result.backupDirectory, 'old', 'action-0001'),
      });
    }
  });

  it('atomically restores the exact original settings document', async () => {
    const adapter = new MemoryTransactionAdapter();
    const dshHome = join('sandbox', 'settings-home');
    const settingsPath = join(dshHome, 'settings.yaml');
    const original = '# keep this comment\nagent-presets:\n  default: old\n';
    const changed = '# keep this comment\nagent-presets:\n  default: new\n';
    adapter.create(settingsPath, original);

    const result = await runTransaction(
      { adapter, dshHome, txid: 'tx-settings' },
      async (transaction) => {
        await transaction.writeSettings(settingsPath, original, changed);
        throw new TransactionFailure(30, [failureDiagnostic]);
      },
    );

    expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 30 });
    expect(await adapter.readText(settingsPath)).toBe(original);
    const settingsAction = result.journal.actions[0];
    expect(settingsAction?.kind).toBe('settings-write');
    if (settingsAction?.kind === 'settings-write' && settingsAction.old.exists) {
      expect(await adapter.readText(settingsAction.old.documentPath)).toBe(original);
      expect(settingsAction.old.path).toBe(settingsPath);
      expect(await adapter.readText(settingsAction.new.documentPath)).toBe(changed);
      expect(settingsAction.new.path).toBe(settingsPath);
      expect(settingsAction.phase).toBe('rolled-back');
    }
    expect(
      adapter.atomicWrites
        .filter(({ path }) => path === settingsPath)
        .map(({ contents }) => contents),
    ).toEqual([changed, original]);
  });

  // Same injected cause, only the rollback outcome differs. A caller must be able to
  // tell "machine is back to its pre-install state, retry is safe" from "machine was
  // left mid-flight, retry would write onto dirty state" from the exit code alone,
  // without parsing stdout.
  it('separates a clean rollback from a failed one by exit code alone', async () => {
    const scenario = async (breakRollback: boolean) => {
      const adapter = new MemoryTransactionAdapter();
      const dshHome = join('sandbox', `rollback-contrast-${breakRollback ? 'broken' : 'clean'}`);
      const profilePath = join(dshHome, 'profiles', 'demo');
      return await runTransaction(
        { adapter, dshHome, txid: `tx-rollback-contrast-${breakRollback}` },
        async (transaction) => {
          await transaction.create('profile', profilePath, async () => {
            adapter.populate(profilePath, 'partial-profile');
          });
          if (breakRollback) {
            adapter.failRename = (from) =>
              from === profilePath ? new Error('injected rollback rename failure') : undefined;
          }
          throw new TransactionFailure(23, [failureDiagnostic]);
        },
      );
    };

    const clean = await scenario(false);
    const broken = await scenario(true);

    expect(clean).toMatchObject({ status: 'rolled-back', exitCode: 23, manualRecovery: [] });
    expect(broken.status).toBe('rollback-failed');
    expect(broken.exitCode).not.toBe(clean.exitCode);
    expect(broken.exitCode).toBe(25);
    // The invariant that makes 25 mechanically checkable: it is raised exactly when
    // the caller is handed manual recovery work, and never otherwise.
    expect(broken.manualRecovery.length).toBeGreaterThan(0);
    expect(clean.exitCode).not.toBe(25);
  });

  it('returns rollback-failed with exit 25 and exact manual recovery paths', async () => {
    const adapter = new MemoryTransactionAdapter();
    const dshHome = join('sandbox', 'rollback-failure-home');
    const profilePath = join(dshHome, 'profiles', 'demo');

    const result = await runTransaction(
      { adapter, dshHome, txid: 'tx-rollback-failure' },
      async (transaction) => {
        await transaction.create('profile', profilePath, async () => {
          adapter.populate(profilePath, 'partial-profile');
        });
        adapter.failRename = (from) =>
          from === profilePath ? new Error('injected rollback rename failure') : undefined;
        throw new TransactionFailure(23, [failureDiagnostic]);
      },
    );

    const expectedBackupPath = join(result.backupDirectory, 'new', 'action-0001');
    expect(result).toMatchObject({
      ok: false,
      status: 'rollback-failed',
      exitCode: 25,
      manualRecovery: [
        {
          actionId: 'action-0001',
          operation: 'rename',
          sourcePath: profilePath,
          destinationPath: expectedBackupPath,
          reason: 'injected rollback rename failure',
        },
      ],
    });
    expect(result.diagnostics).toEqual([
      failureDiagnostic,
      expect.objectContaining({
        code: 'E_TRANSACTION_ROLLBACK_FAILED',
        message: expect.stringContaining('injected rollback rename failure'),
        hint: expect.stringContaining(`${profilePath} → ${expectedBackupPath}`),
      }),
    ]);
    expect(result.journal).toMatchObject({
      state: 'rollback-failed',
      actions: [{ phase: 'rollback-failed' }],
    });
    expect(await adapter.pathExists(profilePath)).toBe(true);
  });

  it('does not remove a pre-existing skill that was never created by this transaction', async () => {
    const adapter = new MemoryTransactionAdapter();
    const dshHome = join('sandbox', 'existing-skill-home');
    const skillPath = join(dshHome, 'skills', 'review');
    adapter.create(skillPath, 'user-owned-skill');
    let applyCalled = false;

    const result = await runTransaction(
      { adapter, dshHome, txid: 'tx-existing-skill' },
      async (transaction) => {
        await transaction.create('skill', skillPath, async () => {
          applyCalled = true;
        });
      },
    );

    expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 22 });
    expect(result.journal.actions).toMatchObject([{ kind: 'create', ownership: 'not-owned' }]);
    expect(applyCalled).toBe(false);
    expect(await adapter.readText(skillPath)).toBe('user-owned-skill');
  });

  it('returns a not-started Result when initial journal persistence fails', async () => {
    const adapter = new MemoryTransactionAdapter();
    adapter.failAtomicWrite = () => new Error('injected initial journal failure');

    const result = await runTransaction(
      { adapter, dshHome: join('sandbox', 'setup-failure-home'), txid: 'tx-setup-failure' },
      async () => undefined,
    );

    expect(result).toMatchObject({ ok: false, status: 'not-started', exitCode: 70 });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'E_TRANSACTION_SETUP_FAILED',
        message: expect.stringContaining('injected initial journal failure'),
      }),
    ]);
  });

  it('reports a rollback journal failure without inventing an artifact recovery move', async () => {
    const adapter = new MemoryTransactionAdapter();
    const dshHome = join('sandbox', 'rollback-journal-home');
    const profilePath = join(dshHome, 'profiles', 'demo');
    let injected = false;
    adapter.failAtomicWrite = (path, contents) => {
      if (
        !injected &&
        path.endsWith('journal.json') &&
        contents.includes('"phase": "rolled-back"')
      ) {
        injected = true;
        return new Error('injected rollback journal failure');
      }
      return undefined;
    };

    const result = await runTransaction(
      { adapter, dshHome, txid: 'tx-rollback-journal' },
      async (transaction) => {
        await transaction.create('profile', profilePath, async () => {
          adapter.populate(profilePath, 'partial-profile');
        });
        throw new TransactionFailure(23, [failureDiagnostic]);
      },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'rollback-failed',
      exitCode: 25,
      manualRecovery: [
        {
          actionId: 'journal',
          operation: 'write-journal',
          sourcePath: result.journalPath,
          destinationPath: result.journalPath,
          reason: 'injected rollback journal failure',
        },
      ],
    });
    expect(result.diagnostics.at(-1)).toMatchObject({
      code: 'E_TRANSACTION_JOURNAL_WRITE_FAILED',
      path: result.journalPath,
    });
    expect(await adapter.pathExists(profilePath)).toBe(false);
    const createAction = result.journal.actions[0];
    expect(createAction?.kind).toBe('create');
    if (createAction?.kind === 'create') {
      expect(await adapter.pathExists(createAction.new.rollbackPath)).toBe(true);
    }
  });
});
