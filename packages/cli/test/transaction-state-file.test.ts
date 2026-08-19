import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  appendFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../src/exit-codes.js';
import type { BoundedReadDependencies, SnapshotStat } from '../src/install/snapshot-capture.js';
import { casStoreShard } from '../src/metadata/state-storage.js';
import type { TransactionContext } from '../src/transaction.js';
import {
  createNodeTransactionAdapter,
  MAX_TRANSACTION_STATE_BYTES,
  runTransaction,
  TransactionFailure,
  TransactionPhysicalProgressError,
  TransactionStateReadLimitError,
  TransactionStateReadSecurityError,
} from '../src/transaction.js';
import { readBoundedTransactionStateFile } from '../src/transaction-node-adapter.js';

const roots: string[] = [];

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-transaction-state-file-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
}

function storePath(dshHome: string, bytes: Uint8Array): string {
  const value = digest(bytes);
  return join(dshHome, '.dshpack', 'store', casStoreShard(value), value);
}

function abort(): TransactionFailure {
  return new TransactionFailure(EXIT_CODES.POST_INSTALL_VERIFY_FAILURE, [
    {
      code: 'E_TEST_ABORT',
      severity: 'error',
      message: 'abort after state write',
      hint: 'test rollback',
      evidence: 'local',
    },
  ]);
}

async function createSparseFile(path: string, bytes: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'w');
  try {
    await handle.truncate(bytes);
  } finally {
    await handle.close();
  }
}

type StateReadSwap = 'fifo' | 'symlink' | 'changed-during-read';

function stateReadSwapDependencies(swap: StateReadSwap): {
  dependencies: BoundedReadDependencies;
  openedFlags(): number | undefined;
} {
  const stable: SnapshotStat = {
    kind: 'file',
    dev: 1,
    ino: 2,
    size: 2,
    birthtimeMs: 3,
    mtimeMs: 4,
    ctimeMs: 5,
    nlink: 1,
  };
  const changed: SnapshotStat = { ...stable, ino: 6, birthtimeMs: 7 };
  let lstatCalls = 0;
  let flags: number | undefined;
  return {
    dependencies: {
      lstatPath: async () => {
        lstatCalls += 1;
        return swap === 'changed-during-read' && lstatCalls > 1 ? changed : stable;
      },
      openFile: async (_path, receivedFlags?: number) => {
        flags = receivedFlags;
        if (swap === 'symlink') {
          throw Object.assign(new Error('open encountered a swapped symlink'), { code: 'ELOOP' });
        }
        return {
          stat: async () => (swap === 'fifo' ? { ...stable, kind: 'special' as const } : stable),
          read: async () => ({ bytesRead: 0 }),
          close: async () => undefined,
        };
      },
    },
    openedFlags: () => flags,
  };
}

async function snapshotStat(handle: Awaited<ReturnType<typeof open>>) {
  const stats = await handle.stat();
  return {
    kind: stats.isFile()
      ? ('file' as const)
      : stats.isDirectory()
        ? ('directory' as const)
        : ('special' as const),
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    birthtimeMs: stats.birthtimeMs,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    nlink: stats.nlink,
  };
}

async function lstatSnapshot(path: string): Promise<SnapshotStat> {
  const stats = await lstat(path);
  return {
    kind: stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'special',
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    birthtimeMs: stats.birthtimeMs,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    nlink: stats.nlink,
  };
}

describe('transaction binary state files', () => {
  it('permanently purges only an identity-and-digest verified GC quarantine payload', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('direct GC quarantine payload');
    const path = join(dshHome, '.dshpack', 'backups', 'gc-direct-purge', 'old', 'action-0001');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const adapter = createNodeTransactionAdapter();
    if (adapter.purgeGcQuarantineFile === undefined)
      throw new Error('GC quarantine purge adapter is required');
    const lock = await adapter.acquireArtifactLock(dshHome);
    const identity = await adapter.pathIdentity(path);
    if (identity === undefined) throw new Error('GC quarantine fixture identity is missing');

    try {
      await expect(
        adapter.purgeGcQuarantineFile(lock, path, digest(bytes), `${identity}-changed`),
      ).resolves.toBe(false);
      await expect(
        adapter.purgeGcQuarantineFile(lock, path, digest(Buffer.from('wrong')), identity),
      ).resolves.toBe(false);
      await expect(
        adapter.purgeGcQuarantineFile(lock, path, digest(bytes), identity),
      ).resolves.toBe(true);
    } finally {
      await lock.release();
    }

    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a GC quarantine purge path outside the exact committed action slot', async () => {
    const dshHome = await home();
    const path = join(dshHome, 'outside-quarantine');
    await writeFile(path, 'external');
    const adapter = createNodeTransactionAdapter();
    if (adapter.purgeGcQuarantineFile === undefined)
      throw new Error('GC quarantine purge adapter is required');
    const lock = await adapter.acquireArtifactLock(dshHome);

    try {
      await expect(
        adapter.purgeGcQuarantineFile(lock, path, digest(Buffer.from('external')), '1:2:3'),
      ).rejects.toMatchObject({
        exitCode: 31,
        diagnostics: [{ code: 'E_TRANSACTION_GC_QUARANTINE_SCOPE' }],
      });
    } finally {
      await lock.release();
    }

    expect(await readFile(path, 'utf8')).toBe('external');
  });

  it('moves a post-rename modified GC quarantine payload back instead of deleting it', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('GC quarantine original bytes');
    const tampered = Buffer.from('GC quarantine user replacement');
    const path = join(
      dshHome,
      '.dshpack',
      'backups',
      'gc-post-rename-content',
      'old',
      'action-0001',
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const adapter = createNodeTransactionAdapter({}, {
      afterGcQuarantineRename: async (_from: string, to: string) => writeFile(to, tampered),
    } as never);
    if (adapter.purgeGcQuarantineFile === undefined)
      throw new Error('GC quarantine purge adapter is required');
    const lock = await adapter.acquireArtifactLock(dshHome);
    const identity = await adapter.pathIdentity(path);
    if (identity === undefined) throw new Error('GC quarantine fixture identity is missing');

    try {
      await expect(
        adapter.purgeGcQuarantineFile(lock, path, digest(bytes), identity),
      ).resolves.toBe(false);
    } finally {
      await lock.release();
    }

    expect(await readFile(path)).toEqual(tampered);
  });

  it('moves an equal-byte post-rename GC quarantine replacement back instead of deleting it', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('GC quarantine equal-byte replacement');
    const path = join(
      dshHome,
      '.dshpack',
      'backups',
      'gc-post-rename-identity',
      'old',
      'action-0001',
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const adapter = createNodeTransactionAdapter({}, {
      afterGcQuarantineRename: async (_from: string, to: string) => {
        await rename(to, `${to}.external`);
        await writeFile(to, bytes);
      },
    } as never);
    if (adapter.purgeGcQuarantineFile === undefined)
      throw new Error('GC quarantine purge adapter is required');
    const lock = await adapter.acquireArtifactLock(dshHome);
    const identity = await adapter.pathIdentity(path);
    if (identity === undefined) throw new Error('GC quarantine fixture identity is missing');

    try {
      await expect(
        adapter.purgeGcQuarantineFile(lock, path, digest(bytes), identity),
      ).resolves.toBe(false);
    } finally {
      await lock.release();
    }

    expect(await readFile(path)).toEqual(bytes);
    expect(await adapter.pathIdentity(path)).not.toBe(identity);
  });

  it('restores a GC quarantine payload when post-rename verification throws', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('GC quarantine rollback after hook failure');
    const path = join(dshHome, '.dshpack', 'backups', 'gc-post-rename-error', 'old', 'action-0001');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const adapter = createNodeTransactionAdapter({}, {
      afterGcQuarantineRename: async () => {
        throw new Error('injected post-rename proof failure');
      },
    } as never);
    if (adapter.purgeGcQuarantineFile === undefined)
      throw new Error('GC quarantine purge adapter is required');
    const lock = await adapter.acquireArtifactLock(dshHome);
    const identity = await adapter.pathIdentity(path);
    if (identity === undefined) throw new Error('GC quarantine fixture identity is missing');

    try {
      await expect(
        adapter.purgeGcQuarantineFile(lock, path, digest(bytes), identity),
      ).rejects.toThrow('injected post-rename proof failure');
    } finally {
      await lock.release();
    }

    expect(await readFile(path)).toEqual(bytes);
  });

  it('does not follow a backup-root junction while compensating a post-rename GC purge failure', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('GC quarantine root-swap source');
    const txid = 'gc-post-rename-root-swap';
    const path = join(dshHome, '.dshpack', 'backups', txid, 'old', 'action-0001');
    const backups = join(dshHome, '.dshpack', 'backups');
    const external = join(dshHome, 'external-backups');
    let externalPurging: string | undefined;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const adapter = createNodeTransactionAdapter({}, {
      afterGcQuarantineRename: async (_from: string, to: string) => {
        await rename(backups, `${backups}.real`);
        await mkdir(external, { recursive: true });
        await symlink(external, backups, process.platform === 'win32' ? 'junction' : 'dir');
        await mkdir(dirname(to), { recursive: true });
        await writeFile(to, 'external purging sentinel');
        externalPurging = to;
      },
    } as never);
    if (adapter.purgeGcQuarantineFile === undefined)
      throw new Error('GC quarantine purge adapter is required');
    const lock = await adapter.acquireArtifactLock(dshHome);
    const identity = await adapter.pathIdentity(path);
    if (identity === undefined) throw new Error('GC quarantine fixture identity is missing');

    try {
      await expect(
        adapter.purgeGcQuarantineFile(lock, path, digest(bytes), identity),
      ).rejects.toBeInstanceOf(TransactionPhysicalProgressError);
    } finally {
      await lock.release();
    }

    if (externalPurging === undefined)
      throw new Error('root-swap hook did not publish its sentinel');
    expect(await readFile(externalPurging, 'utf8')).toBe('external purging sentinel');
  });

  it('returns false from dedicated current and marker CAS when their expected documents differ', async () => {
    const dshHome = await home();
    const current = join(dshHome, '.dshpack', 'generations', 'demo-pack', 'current');
    const marker = join(dshHome, '.dshpack', 'installed', 'demo-pack.json');
    await mkdir(dirname(current), { recursive: true });
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(current, '1\n');
    await writeFile(marker, '{"metadataVersion":1}\n');
    const adapter = createNodeTransactionAdapter();
    if (
      adapter.compareAndSwapGenerationCurrent === undefined ||
      adapter.compareAndSwapManagedDocument === undefined
    ) {
      throw new Error('bounded document CAS adapters are required');
    }

    await expect(adapter.compareAndSwapGenerationCurrent(current, '2\n', '3\n')).resolves.toBe(
      false,
    );
    await expect(
      adapter.compareAndSwapManagedDocument(
        marker,
        '{"metadataVersion":0}\n',
        '{"metadataVersion":1}\n',
      ),
    ).resolves.toBe(false);
    expect(await readFile(current, 'utf8')).toBe('1\n');
    expect(await readFile(marker, 'utf8')).toBe('{"metadataVersion":1}\n');
  });

  it('rejects an invalid GC quarantine action leaf before touching any bytes', async () => {
    const dshHome = await home();
    const path = join(dshHome, '.dshpack', 'backups', 'gc-invalid-action', 'old', 'not-an-action');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'external');
    const adapter = createNodeTransactionAdapter();
    if (adapter.purgeGcQuarantineFile === undefined)
      throw new Error('GC quarantine purge adapter is required');
    const lock = await adapter.acquireArtifactLock(dshHome);

    try {
      await expect(
        adapter.purgeGcQuarantineFile(lock, path, digest(Buffer.from('external')), '1:2:3'),
      ).rejects.toMatchObject({
        exitCode: 31,
        diagnostics: [{ code: 'E_TRANSACTION_GC_QUARANTINE_SCOPE' }],
      });
    } finally {
      await lock.release();
    }

    expect(await readFile(path, 'utf8')).toBe('external');
  });

  it.each(['fifo', 'symlink'] as const)(
    'opens a normal state file with O_NONBLOCK and rejects a pre-open %s swap',
    async (swap) => {
      const reader = stateReadSwapDependencies(swap);

      await expect(
        readBoundedTransactionStateFile('C:/isolated/state', reader.dependencies),
      ).rejects.toBeInstanceOf(TransactionStateReadSecurityError);
      expect(reader.openedFlags()).toBeDefined();
      expect(reader.openedFlags()).toBe(
        constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
      );
    },
  );

  it.each([
    ['generation current', 'current', 'hardlink'],
    ['generation current', 'current', 'directory'],
    ['generation current', 'current', 'changed-during-read'],
    ['installed marker', 'managed', 'hardlink'],
    ['installed marker', 'managed', 'directory'],
    ['installed marker', 'managed', 'changed-during-read'],
  ] as const)(
    'maps %s %s state input to exit 31 without modifying it',
    async (label, documentKind, scenario) => {
      const dshHome = await home();
      const path =
        documentKind === 'current'
          ? join(dshHome, '.dshpack', 'generations', 'demo-pack', 'current')
          : join(dshHome, '.dshpack', 'installed', 'demo-pack.json');
      const original = documentKind === 'current' ? '1\n' : '{"metadataVersion":1}\n';
      await mkdir(dirname(path), { recursive: true });
      if (scenario === 'hardlink') {
        const source = join(dshHome, `${documentKind}-source`);
        await writeFile(source, original, 'utf8');
        await link(source, path);
      } else if (scenario === 'directory') {
        await mkdir(path);
      } else {
        await writeFile(path, original, 'utf8');
      }
      const race =
        scenario === 'changed-during-read'
          ? stateReadSwapDependencies('changed-during-read')
          : undefined;
      const adapter =
        race === undefined
          ? createNodeTransactionAdapter()
          : createNodeTransactionAdapter({}, {
              stateReadDependencies: race.dependencies,
            } as unknown as Parameters<typeof createNodeTransactionAdapter>[1]);
      const result = await runTransaction(
        { adapter, dshHome, txid: `security-${documentKind}-${scenario}` },
        async (transaction) =>
          documentKind === 'current'
            ? transaction.writeGenerationCurrent(path, original, '2\n')
            : transaction.writeManagedDocument(path, '{"metadataVersion":2}\n'),
      );

      expect(label).toBeTypeOf('string');
      expect(result).toMatchObject({
        exitCode: 31,
        status: 'rolled-back',
        manualRecovery: [],
        diagnostics: [
          {
            code: documentKind === 'current' ? 'E_GENERATION_CURRENT' : 'E_MANAGED_DOCUMENT',
            path,
          },
        ],
      });
      if (scenario === 'directory') {
        expect((await lstat(path)).isDirectory()).toBe(true);
      } else {
        expect(await readFile(path, 'utf8')).toBe(original);
      }
    },
  );

  it('does not block on a FIFO swapped into a current rollback backup', async () => {
    const dshHome = await home();
    const txid = 'fifo-current-backup';
    const current = join(dshHome, '.dshpack', 'generations', 'demo-pack', 'current');
    await mkdir(dirname(current), { recursive: true });
    await writeFile(current, '1\n');
    const backup = join(
      dshHome,
      '.dshpack',
      'backups',
      txid,
      'documents',
      'action-0003-generation-current-new',
    );
    let backupOpened = false;
    const adapter = createNodeTransactionAdapter(
      {},
      {
        stateReadDependencies: {
          lstatPath: lstatSnapshot,
          openFile: async (path, flags) => {
            if (path === backup) {
              backupOpened = true;
              return {
                stat: async () => ({ ...(await lstatSnapshot(path)), kind: 'special' as const }),
                read: async () => ({ bytesRead: 0 }),
                close: async () => undefined,
              };
            }
            const handle = await open(path, flags);
            return {
              stat: () => snapshotStat(handle),
              read: (buffer, offset, length) => handle.read(buffer, offset, length, null),
              close: () => handle.close(),
            };
          },
        },
      },
    );
    const result = await runTransaction({ adapter, dshHome, txid }, async (transaction) => {
      await transaction.writeGenerationCurrent(current, '1\n', '2\n');
      throw abort();
    });

    expect(backupOpened).toBe(true);
    expect(result).toMatchObject({ exitCode: 25, status: 'rollback-failed' });
    expect(result.manualRecovery).not.toEqual([]);
    expect(await readFile(current, 'utf8')).toBe('2\n');
  });

  it('keeps state-directory capabilities out of the public generic artifact API', () => {
    type PublicCreateKind = Parameters<TransactionContext['create']>[0];
    const userArtifact: PublicCreateKind = 'profile';
    expect(userArtifact).toBe('profile');
    // @ts-expect-error state directory reservation is internal to transaction actions.
    const stateDirectory: PublicCreateKind = 'store-directory';
    expect(stateDirectory).toBe('store-directory');
  });

  it('moves an owned binary CAS block to the transaction backup on clean rollback', async () => {
    const dshHome = await home();
    const bytes = Buffer.from([0, 255, 1, 0, 128]);
    const path = storePath(dshHome, bytes);
    const result = await runTransaction(
      { adapter: createNodeTransactionAdapter(), dshHome, txid: 'binary-store-rollback' },
      async (transaction) => {
        expect(await transaction.writeStateFile('store-block', path, bytes)).toBe(true);
        expect(await readFile(path)).toEqual(bytes);
        throw abort();
      },
    );

    expect(result).toMatchObject({ exitCode: 24, status: 'rolled-back', manualRecovery: [] });
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    const action = result.journal.actions.find(
      (entry): entry is Extract<(typeof result.journal.actions)[number], { kind: 'create' }> =>
        entry.kind === 'create' && entry.artifact === 'store-block',
    );
    expect(action).toMatchObject({ kind: 'create', ownership: 'owned', phase: 'rolled-back' });
    if (action === undefined) throw new Error('state create action is required');
    expect(await readFile(action.new.rollbackPath)).toEqual(bytes);
  });

  it('restores a transactionally deleted CAS block when a later GC action fails', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('gc state block');
    const path = storePath(dshHome, bytes);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const adapter = createNodeTransactionAdapter();
    const identity = await adapter.pathIdentity(path);
    if (identity === undefined)
      throw new Error('fixture CAS block is missing its transaction identity');
    const result = await runTransaction(
      { adapter, dshHome, txid: 'gc-state-delete-rollback' },
      async (transaction) => {
        await transaction.deleteStateFile('store-block', path, digest(bytes), identity);
        await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
        throw abort();
      },
    );

    expect(result).toMatchObject({ exitCode: 24, status: 'rolled-back', manualRecovery: [] });
    expect(await readFile(path)).toEqual(bytes);
  });

  it('rejects a GC state deletion when its adapter lacks bounded binary reads', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('bounded deletion state');
    const path = storePath(dshHome, bytes);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const base = createNodeTransactionAdapter();
    const identity = await base.pathIdentity(path);
    if (identity === undefined) throw new Error('fixture CAS block identity is missing');
    const { readBytesIfExists: _unsupportedStateReader, ...withoutStateReader } = base;
    const result = await runTransaction(
      { adapter: withoutStateReader, dshHome, txid: 'gc-state-delete-no-bounded-reader' },
      async (transaction) =>
        transaction.deleteStateFile('store-block', path, digest(bytes), identity),
    );

    expect(result).toMatchObject({
      exitCode: 70,
      status: 'rolled-back',
      manualRecovery: [],
      diagnostics: [{ code: 'E_TRANSACTION_STATE_ADAPTER', path }],
      journal: { actions: [] },
    });
    expect(await readFile(path)).toEqual(bytes);
  });

  it('short-circuits a stale GC deletion identity before reading state bytes', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('stale deletion state');
    const path = storePath(dshHome, bytes);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const base = createNodeTransactionAdapter();
    let reads = 0;
    const result = await runTransaction(
      {
        adapter: {
          ...base,
          readBytesIfExists: async () => {
            reads += 1;
            return bytes;
          },
        },
        dshHome,
        txid: 'gc-state-delete-stale-identity',
      },
      async (transaction) =>
        transaction.deleteStateFile('store-block', path, digest(bytes), 'stale-identity'),
    );

    expect(result).toMatchObject({
      exitCode: 30,
      status: 'rolled-back',
      manualRecovery: [],
      diagnostics: [{ code: 'E_TRANSACTION_STATE_CHANGED', path }],
      journal: { actions: [] },
    });
    expect(reads).toBe(0);
    expect(await readFile(path)).toEqual(bytes);
  });

  it.each([
    ['an oversized state reader', 'limit'],
    ['a FIFO-like state reader', 'security'],
  ] as const)(
    'maps %s during GC deletion without moving the original',
    async (_label, scenario) => {
      const dshHome = await home();
      const bytes = Buffer.from('state reader failure');
      const path = storePath(dshHome, bytes);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      const base = createNodeTransactionAdapter();
      const identity = await base.pathIdentity(path);
      if (identity === undefined) throw new Error('fixture CAS block identity is missing');
      const error =
        scenario === 'limit'
          ? new TransactionStateReadLimitError(path, 1)
          : new TransactionStateReadSecurityError(path, 'FIFO swap');
      const result = await runTransaction(
        {
          adapter: {
            ...base,
            readBytesIfExists: async () => {
              throw error;
            },
          },
          dshHome,
          txid: `gc-state-delete-${scenario}`,
        },
        async (transaction) =>
          transaction.deleteStateFile('store-block', path, digest(bytes), identity),
      );

      expect(result).toMatchObject({
        exitCode: scenario === 'limit' ? 30 : 31,
        status: 'rolled-back',
        manualRecovery: [],
        diagnostics: [
          {
            code:
              scenario === 'limit'
                ? 'E_TRANSACTION_STATE_READ_LIMIT'
                : 'E_TRANSACTION_STATE_READ_SECURITY',
            path,
          },
        ],
        journal: { actions: [] },
      });
      expect(await readFile(path)).toEqual(bytes);
    },
  );

  it('requires manual recovery when forward GC deletion backup bytes change after rename', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('forward deletion source');
    const tampered = Buffer.from('unknown post-rename bytes');
    const path = storePath(dshHome, bytes);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const adapter = createNodeTransactionAdapter(
      {},
      {
        afterStateMoveRename: async (from, to) => {
          if (from === path) await writeFile(to, tampered);
        },
      },
    );
    const identity = await adapter.pathIdentity(path);
    if (identity === undefined) throw new Error('fixture CAS block identity is missing');
    const result = await runTransaction(
      { adapter, dshHome, txid: 'gc-state-delete-forward-content-change' },
      async (transaction) =>
        transaction.deleteStateFile('store-block', path, digest(bytes), identity),
    );

    expect(result).toMatchObject({
      exitCode: 25,
      status: 'rollback-failed',
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'E_TRANSACTION_STATE_CHANGED', path }),
    );
    expect(result.manualRecovery).toContainEqual(
      expect.objectContaining({ actionId: 'action-0001', operation: 'rename' }),
    );
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await readFile(
        join(
          dshHome,
          '.dshpack',
          'backups',
          'gc-state-delete-forward-content-change',
          'old',
          'action-0001',
        ),
      ),
    ).toEqual(tampered);
  });

  it('rolls back an earlier GC deletion when a later state move rejects the plan', async () => {
    const dshHome = await home();
    const first = Buffer.from('first gc state block');
    const second = Buffer.from('second gc state block');
    const firstPath = storePath(dshHome, first);
    const secondPath = storePath(dshHome, second);
    await mkdir(dirname(firstPath), { recursive: true });
    await mkdir(dirname(secondPath), { recursive: true });
    await writeFile(firstPath, first);
    await writeFile(secondPath, second);
    const base = createNodeTransactionAdapter();
    const firstIdentity = await base.pathIdentity(firstPath);
    const secondIdentity = await base.pathIdentity(secondPath);
    if (firstIdentity === undefined || secondIdentity === undefined)
      throw new Error('fixture CAS block identity is missing');
    let moves = 0;
    const result = await runTransaction(
      {
        adapter: {
          ...base,
          async moveArtifactPath(lock, kind, from, to, direction, expectedIdentity, condition) {
            if (direction === 'to-backup' && ++moves === 2) return false;
            return base.moveArtifactPath(
              lock,
              kind,
              from,
              to,
              direction,
              expectedIdentity,
              condition,
            );
          },
        },
        dshHome,
        txid: 'gc-state-delete-forward-failure',
      },
      async (transaction) => {
        await transaction.deleteStateFile('store-block', firstPath, digest(first), firstIdentity);
        await transaction.deleteStateFile(
          'store-block',
          secondPath,
          digest(second),
          secondIdentity,
        );
      },
    );

    expect(result).toMatchObject({ exitCode: 30, status: 'rolled-back', manualRecovery: [] });
    expect(await readFile(firstPath)).toEqual(first);
    expect(await readFile(secondPath)).toEqual(second);
  });

  it('reports manual recovery when an owned GC state deletion cannot be restored', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('manual recovery gc block');
    const path = storePath(dshHome, bytes);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const base = createNodeTransactionAdapter();
    const identity = await base.pathIdentity(path);
    if (identity === undefined) throw new Error('fixture CAS block identity is missing');
    const result = await runTransaction(
      {
        adapter: {
          ...base,
          async moveArtifactPath(lock, kind, from, to, direction, expectedIdentity, condition) {
            if (direction === 'from-backup') return false;
            return base.moveArtifactPath(
              lock,
              kind,
              from,
              to,
              direction,
              expectedIdentity,
              condition,
            );
          },
        },
        dshHome,
        txid: 'gc-state-delete-rollback-failure',
      },
      async (transaction) => {
        await transaction.deleteStateFile('store-block', path, digest(bytes), identity);
        throw abort();
      },
    );

    expect(result).toMatchObject({ exitCode: 25, status: 'rollback-failed' });
    expect(result.manualRecovery).not.toEqual([]);
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not restore a deleted CAS block whose backup bytes changed before rollback', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('delete rollback source');
    const tampered = Buffer.from('delete rollback tampered');
    const path = storePath(dshHome, bytes);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const adapter = createNodeTransactionAdapter();
    const identity = await adapter.pathIdentity(path);
    if (identity === undefined) throw new Error('fixture CAS block identity is missing');
    const txid = 'gc-state-delete-backup-content-changed';
    const backup = join(dshHome, '.dshpack', 'backups', txid, 'old', 'action-0001');
    const result = await runTransaction({ adapter, dshHome, txid }, async (transaction) => {
      await transaction.deleteStateFile('store-block', path, digest(bytes), identity);
      await writeFile(backup, tampered);
      throw abort();
    });

    expect(result).toMatchObject({ exitCode: 25, status: 'rollback-failed' });
    expect(result.manualRecovery).not.toEqual([]);
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(backup)).toEqual(tampered);
  });

  it('fails closed without manual recovery when binary state creation reports not-written or missing', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('state');
    const path = storePath(dshHome, bytes);
    const base = createNodeTransactionAdapter();
    const notWritten = await runTransaction(
      {
        adapter: { ...base, writeExclusiveBytes: async () => false },
        dshHome,
        txid: 'state-not-written',
      },
      async (transaction) => {
        expect(await transaction.writeStateFile('store-block', path, bytes)).toBe(false);
      },
    );
    expect(notWritten).toMatchObject({ exitCode: 0, status: 'committed', manualRecovery: [] });
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });

    const missing = await runTransaction(
      {
        adapter: { ...base, writeExclusiveBytes: async () => true },
        dshHome,
        txid: 'state-missing-after-write',
      },
      async (transaction) => transaction.writeStateFile('store-block', path, bytes),
    );
    expect(missing).toMatchObject({ exitCode: 70, status: 'rolled-back', manualRecovery: [] });
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when a state adapter cannot verify binary output after writing', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('state capability seal');
    const path = storePath(dshHome, bytes);
    const base = createNodeTransactionAdapter();
    const { readBytesIfExists: _readBytesIfExists, ...withoutPostwriteReader } = base;

    const result = await runTransaction(
      {
        adapter: withoutPostwriteReader,
        dshHome,
        txid: 'state-no-postwrite-reader',
      },
      async (transaction) => transaction.writeStateFile('store-block', path, bytes),
    );

    expect(result).toMatchObject({
      exitCode: 25,
      status: 'rollback-failed',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'E_TRANSACTION_STATE_ADAPTER' }),
      ]),
    });
    expect(result.manualRecovery.some((step) => step.sourcePath === path)).toBe(true);
    expect(await readFile(path)).toEqual(bytes);
  });

  it('requires manual recovery if an adapter throws after it has created a binary state file', async () => {
    const dshHome = await home();
    const bytes = Buffer.from([0, 255, 1, 0, 128]);
    const path = storePath(dshHome, bytes);
    const base = createNodeTransactionAdapter();
    if (base.writeExclusiveBytes === undefined) throw new Error('binary state writer is required');
    const baseWriteExclusiveBytes = base.writeExclusiveBytes;
    const result = await runTransaction(
      {
        adapter: {
          ...base,
          writeExclusiveBytes: async (file, contents) => {
            const written = await baseWriteExclusiveBytes(file, contents);
            if (written) throw new Error('injected post-write binary state failure');
            return written;
          },
        },
        dshHome,
        txid: 'state-post-write-failure',
      },
      async (transaction) => transaction.writeStateFile('store-block', path, bytes),
    );

    expect(result).toMatchObject({ exitCode: 25, status: 'rollback-failed' });
    expect(result.manualRecovery.some((step) => step.sourcePath === path)).toBe(true);
    expect(await readFile(path)).toEqual(bytes);
  });

  it('requires manual recovery when an exclusive binary write returns corrupt bytes', async () => {
    const dshHome = await home();
    const bytes = Buffer.from([0, 255, 1, 0, 128]);
    const tampered = Buffer.from([0, 255, 1, 0, 127]);
    const path = storePath(dshHome, bytes);
    const base = createNodeTransactionAdapter();
    if (base.writeExclusiveBytes === undefined) throw new Error('binary state writer is required');
    const baseWriteExclusiveBytes = base.writeExclusiveBytes;
    const result = await runTransaction(
      {
        adapter: {
          ...base,
          writeExclusiveBytes: async (file, contents) => {
            const written = await baseWriteExclusiveBytes(file, contents);
            if (written) await writeFile(file, tampered);
            return written;
          },
        },
        dshHome,
        txid: 'state-corrupt-post-write',
      },
      async (transaction) => transaction.writeStateFile('store-block', path, bytes),
    );

    expect(result).toMatchObject({ exitCode: 25, status: 'rollback-failed' });
    expect(result.manualRecovery.some((step) => step.sourcePath === path)).toBe(true);
    expect(await readFile(path)).toEqual(tampered);
  });

  it('requires manual recovery when an immutable generation write returns corrupt bytes', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('{"seq":1}\n');
    const tampered = Buffer.from('{"seq":2}\n');
    const path = join(dshHome, '.dshpack', 'generations', 'demo-pack', '0001.json');
    const base = createNodeTransactionAdapter();
    if (base.writeExclusiveBytes === undefined) throw new Error('binary state writer is required');
    const baseWriteExclusiveBytes = base.writeExclusiveBytes;
    const result = await runTransaction(
      {
        adapter: {
          ...base,
          writeExclusiveBytes: async (file, contents) => {
            const written = await baseWriteExclusiveBytes(file, contents);
            if (written) await writeFile(file, tampered);
            return written;
          },
        },
        dshHome,
        txid: 'generation-corrupt-post-write',
      },
      async (transaction) => transaction.writeStateFile('generation', path, bytes),
    );

    expect(result).toMatchObject({ exitCode: 25, status: 'rollback-failed' });
    expect(result.manualRecovery.some((step) => step.sourcePath === path)).toBe(true);
    expect(await readFile(path)).toEqual(tampered);
  });

  it('does not move a same-identity CAS file if its bytes changed before rollback', async () => {
    const dshHome = await home();
    const bytes = Buffer.from([0, 255, 1, 0, 128]);
    const tampered = Buffer.from([0, 255, 1, 0, 127]);
    const path = storePath(dshHome, bytes);
    const result = await runTransaction(
      { adapter: createNodeTransactionAdapter(), dshHome, txid: 'state-content-changed' },
      async (transaction) => {
        expect(await transaction.writeStateFile('store-block', path, bytes)).toBe(true);
        await writeFile(path, tampered);
        throw abort();
      },
    );

    expect(result).toMatchObject({ exitCode: 25, status: 'rollback-failed' });
    expect(result.manualRecovery.some((step) => step.sourcePath === path)).toBe(true);
    expect(await readFile(path)).toEqual(tampered);
  });

  it('leaves a post-rename tampered CAS block in its backup for manual recovery', async () => {
    const dshHome = await home();
    const bytes = Buffer.from([0, 255, 1, 0, 128]);
    const tampered = Buffer.from([0, 255, 1, 0, 127]);
    const path = storePath(dshHome, bytes);
    const adapter = createNodeTransactionAdapter(
      {},
      {
        afterStateMoveRename: async (from, to) => {
          if (from === path) await writeFile(to, tampered);
        },
      },
    );
    const result = await runTransaction(
      { adapter, dshHome, txid: 'state-post-rename-content-change' },
      async (transaction) => {
        await transaction.writeStateFile('store-block', path, bytes);
        throw abort();
      },
    );

    expect(result).toMatchObject({ exitCode: 25, status: 'rollback-failed' });
    expect(result.manualRecovery.some((step) => step.sourcePath === path)).toBe(true);
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    const action = result.journal.actions.find(
      (entry) => entry.kind === 'create' && entry.artifact === 'store-block',
    );
    if (action === undefined || action.kind !== 'create') throw new Error('state action missing');
    expect(await readFile(action.new.rollbackPath)).toEqual(tampered);
  });

  it('never restores an unknown post-rename replacement when the mutation hook then throws', async () => {
    const dshHome = await home();
    const bytes = Buffer.from([0, 255, 1, 0, 128]);
    const tampered = Buffer.from([0, 255, 1, 0, 126]);
    const path = storePath(dshHome, bytes);
    const adapter = createNodeTransactionAdapter(
      {},
      {
        afterStateMoveRename: async (from, to) => {
          if (from !== path) return;
          await writeFile(to, tampered);
          throw new Error('injected post-rename mutation failure');
        },
      },
    );
    const result = await runTransaction(
      { adapter, dshHome, txid: 'state-post-rename-tamper-throws' },
      async (transaction) => {
        await transaction.writeStateFile('store-block', path, bytes);
        throw abort();
      },
    );

    expect(result).toMatchObject({ exitCode: 25, status: 'rollback-failed' });
    expect(result.manualRecovery).not.toEqual([]);
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    const action = result.journal.actions.find(
      (entry) => entry.kind === 'create' && entry.artifact === 'store-block',
    );
    if (action === undefined || action.kind !== 'create') throw new Error('state action missing');
    expect(await readFile(action.new.rollbackPath)).toEqual(tampered);
  });

  it('leaves a post-rename nonempty state directory in backup for manual recovery', async () => {
    const dshHome = await home();
    const bytes = Buffer.from([0, 255, 1, 0, 128]);
    const path = storePath(dshHome, bytes);
    const directory = dirname(path);
    const unknown = 'user-created-after-check';
    const adapter = createNodeTransactionAdapter(
      {},
      {
        afterStateMoveRename: async (from, to) => {
          if (from === directory) await writeFile(join(to, unknown), 'external');
        },
      },
    );
    const result = await runTransaction(
      { adapter, dshHome, txid: 'state-post-rename-directory-change' },
      async (transaction) => {
        await transaction.writeStateFile('store-block', path, bytes);
        throw abort();
      },
    );

    expect(result).toMatchObject({ exitCode: 25, status: 'rollback-failed' });
    expect(result.manualRecovery.some((step) => step.sourcePath === directory)).toBe(true);
    await expect(readFile(join(directory, unknown), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const action = result.journal.actions.find(
      (entry) =>
        entry.kind === 'create' &&
        entry.artifact === 'store-directory' &&
        entry.new.path === directory,
    );
    if (action === undefined || action.kind !== 'create')
      throw new Error('state directory action missing');
    expect(await readFile(join(action.new.rollbackPath, unknown), 'utf8')).toBe('external');
  });

  it('does not remove an owned state parent directory after a concurrent unknown entry appears', async () => {
    const dshHome = await home();
    const bytes = Buffer.from([0, 255, 1, 0, 128]);
    const path = storePath(dshHome, bytes);
    const unknown = join(dirname(path), 'unknown-user-file');
    const result = await runTransaction(
      { adapter: createNodeTransactionAdapter(), dshHome, txid: 'state-parent-not-empty' },
      async (transaction) => {
        expect(await transaction.writeStateFile('store-block', path, bytes)).toBe(true);
        await writeFile(unknown, 'external');
        throw abort();
      },
    );

    expect(result).toMatchObject({ exitCode: 25, status: 'rollback-failed' });
    expect(result.manualRecovery.some((step) => step.sourcePath === dirname(path))).toBe(true);
    expect(await readFile(unknown, 'utf8')).toBe('external');
  });

  it.each(['cas', 'current'] as const)(
    'rejects an oversized pre-existing %s state file without changing its bytes or identity',
    async (kind) => {
      const dshHome = await home();
      const bytes = Buffer.from('state');
      const path =
        kind === 'cas'
          ? storePath(dshHome, bytes)
          : join(dshHome, '.dshpack', 'generations', 'demo-pack', 'current');
      await createSparseFile(path, MAX_TRANSACTION_STATE_BYTES + 1);
      const before = await lstat(path, { bigint: true });
      const result = await runTransaction(
        { adapter: createNodeTransactionAdapter(), dshHome, txid: `state-overlimit-${kind}` },
        async (transaction) =>
          kind === 'cas'
            ? transaction.readStateBytes(path)
            : transaction.readGenerationCurrent(path),
      );

      expect(result).toMatchObject({
        exitCode: 30,
        status: 'rolled-back',
        manualRecovery: [],
        diagnostics: [{ code: 'E_TRANSACTION_STATE_READ_LIMIT', path }],
      });
      const after = await lstat(path, { bigint: true });
      expect(after.size).toBe(before.size);
      expect(`${after.dev}:${after.ino}:${after.birthtimeNs}`).toBe(
        `${before.dev}:${before.ino}:${before.birthtimeNs}`,
      );
    },
  );

  it('rejects a state file that grows after handle stat instead of accepting a truncated prefix', async () => {
    const dshHome = await home();
    const path = storePath(dshHome, Buffer.from('stable-state'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'stable');
    let appended = false;

    await expect(
      readBoundedTransactionStateFile(path, {
        openFile: async (candidate) => {
          const handle = await open(candidate, 'r');
          return {
            async stat() {
              const stats = await snapshotStat(handle);
              if (!appended) {
                appended = true;
                await appendFile(path, '-appended-after-stat');
              }
              return stats;
            },
            read: (buffer, offset, length) => handle.read(buffer, offset, length, null),
            close: () => handle.close(),
          };
        },
      }),
    ).rejects.toBeInstanceOf(TransactionStateReadSecurityError);
    expect(await readFile(path, 'utf8')).toBe('stable-appended-after-stat');
  });

  it('rejects a named path swap before open and never accepts the replacement bytes', async () => {
    const dshHome = await home();
    const original = storePath(dshHome, Buffer.from('original-state'));
    const replacement = `${original}.replacement`;
    await mkdir(dirname(original), { recursive: true });
    await writeFile(original, 'original');
    await writeFile(replacement, 'replacement');
    let swapped = false;

    await expect(
      readBoundedTransactionStateFile(original, {
        openFile: async (candidate) => {
          if (!swapped) {
            swapped = true;
            await rename(replacement, original);
          }
          const handle = await open(candidate, 'r');
          return {
            stat: () => snapshotStat(handle),
            read: (buffer, offset, length) => handle.read(buffer, offset, length, null),
            close: () => handle.close(),
          };
        },
      }),
    ).rejects.toBeInstanceOf(TransactionStateReadSecurityError);
    expect(await readFile(original, 'utf8')).toBe('replacement');
  });

  it('rejects directory, symlink, hardlink, and FIFO probes before state bytes are read', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('regular-state');
    const regular = storePath(dshHome, bytes);
    const directory = join(dirname(regular), 'directory-state');
    const linked = join(dirname(regular), 'linked-state');
    await mkdir(dirname(regular), { recursive: true });
    await writeFile(regular, bytes);
    await mkdir(directory);
    await link(regular, linked);

    await expect(readBoundedTransactionStateFile(directory)).rejects.toBeInstanceOf(
      TransactionStateReadSecurityError,
    );
    await expect(
      readBoundedTransactionStateFile('C:/safe/symlink', {
        lstatPath: async () => ({
          kind: 'symlink',
          dev: 1,
          ino: 1,
          size: 0,
          birthtimeMs: 1,
          mtimeMs: 1,
          ctimeMs: 1,
          nlink: 1,
        }),
      }),
    ).rejects.toBeInstanceOf(TransactionStateReadSecurityError);
    await expect(readBoundedTransactionStateFile(linked)).rejects.toBeInstanceOf(
      TransactionStateReadSecurityError,
    );
    let opens = 0;
    await expect(
      readBoundedTransactionStateFile('C:/safe/fifo', {
        lstatPath: async () => ({
          kind: 'special',
          dev: 1,
          ino: 1,
          size: 0,
          birthtimeMs: 1,
          mtimeMs: 1,
          ctimeMs: 1,
          nlink: 1,
        }),
        openFile: async () => {
          opens += 1;
          throw new Error('FIFO open must not happen');
        },
      }),
    ).rejects.toBeInstanceOf(TransactionStateReadSecurityError);
    expect(opens).toBe(0);
  });

  it('fails closed when the adapter lacks bounded binary state reads', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('state');
    const base = createNodeTransactionAdapter();
    const { readBytesIfExists: _unsupportedStateRead, ...withoutStateRead } = base;
    const result = await runTransaction(
      {
        adapter: withoutStateRead,
        dshHome,
        txid: 'state-no-bounded-reader',
      },
      async (transaction) => transaction.readStateBytes(storePath(dshHome, bytes)),
    );

    expect(result).toMatchObject({
      exitCode: 70,
      status: 'rolled-back',
      manualRecovery: [],
      diagnostics: [{ code: 'E_TRANSACTION_STATE_ADAPTER' }],
    });
  });

  it('turns an unexpected bounded state read failure into an internal transaction failure', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('state');
    const base = createNodeTransactionAdapter();
    const result = await runTransaction(
      {
        adapter: {
          ...base,
          readBytesIfExists: async () => {
            throw new Error('injected bounded state read failure');
          },
        },
        dshHome,
        txid: 'state-unexpected-reader-failure',
      },
      async (transaction) => transaction.readStateBytes(storePath(dshHome, bytes)),
    );

    expect(result).toMatchObject({
      exitCode: 70,
      status: 'rolled-back',
      manualRecovery: [],
      diagnostics: [{ code: 'E_TRANSACTION_ABORTED' }],
    });
  });

  it('rejects a current pointer above its pointer-size bound', async () => {
    const dshHome = await home();
    const current = join(dshHome, '.dshpack', 'generations', 'demo-pack', 'current');
    const bytes = Buffer.alloc(129, '1');
    await mkdir(dirname(current), { recursive: true });
    await writeFile(current, bytes);

    const result = await runTransaction(
      { adapter: createNodeTransactionAdapter(), dshHome, txid: 'current-pointer-over-limit' },
      async (transaction) => transaction.readGenerationCurrent(current),
    );

    expect(result).toMatchObject({
      exitCode: 30,
      status: 'rolled-back',
      manualRecovery: [],
      diagnostics: [{ code: 'E_GENERATION_CURRENT', path: current }],
    });
    expect(await readFile(current)).toEqual(bytes);
  });

  it('rejects a current pointer that is not valid UTF-8', async () => {
    const dshHome = await home();
    const current = join(dshHome, '.dshpack', 'generations', 'demo-pack', 'current');
    const bytes = Buffer.from([0xff]);
    await mkdir(dirname(current), { recursive: true });
    await writeFile(current, bytes);

    const result = await runTransaction(
      { adapter: createNodeTransactionAdapter(), dshHome, txid: 'current-pointer-invalid-utf8' },
      async (transaction) => transaction.readGenerationCurrent(current),
    );

    expect(result).toMatchObject({
      exitCode: 30,
      status: 'rolled-back',
      manualRecovery: [],
      diagnostics: [{ code: 'E_GENERATION_CURRENT', path: current }],
    });
    expect(await readFile(current)).toEqual(bytes);
  });

  it('rejects a state file adapter that does not explicitly support binary writes', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('state');
    const base = createNodeTransactionAdapter();
    const { writeExclusiveBytes: _unsupportedStateWrite, ...withoutStateWrite } = base;
    const result = await runTransaction(
      {
        adapter: withoutStateWrite,
        dshHome,
        txid: 'state-no-adapter',
      },
      async (transaction) =>
        transaction.writeStateFile('store-block', storePath(dshHome, bytes), bytes),
    );
    expect(result).toMatchObject({
      exitCode: 70,
      status: 'rolled-back',
      manualRecovery: [],
      diagnostics: [{ code: 'E_TRANSACTION_STATE_ADAPTER' }],
    });
  });

  it.each([
    ['store-block', (dshHome: string, bytes: Uint8Array) => storePath(dshHome, bytes)],
    [
      'generation',
      (dshHome: string) => join(dshHome, '.dshpack', 'generations', 'demo-pack', '0001.json'),
    ],
  ] as const)(
    'rejects oversized %s writes before creating any state parent or journal action',
    async (kind, buildPath) => {
      const dshHome = await home();
      const bytes = Buffer.alloc(MAX_TRANSACTION_STATE_BYTES + 1, 1);
      const path = buildPath(dshHome, bytes);
      const result = await runTransaction(
        {
          adapter: createNodeTransactionAdapter(),
          dshHome,
          txid: `state-write-over-limit-${kind}`,
        },
        async (transaction) => transaction.writeStateFile(kind, path, bytes),
      );

      expect(result).toMatchObject({
        exitCode: 30,
        status: 'rolled-back',
        manualRecovery: [],
        diagnostics: [{ code: 'E_TRANSACTION_STATE_READ_LIMIT', path }],
      });
      expect(result.journal.actions).toEqual([]);
      await expect(lstat(dirname(path))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each(['0\n', '1', '1\nextra', `${'9'.repeat(130)}\n`] as const)(
    'rejects an invalid public generation current write before creating state: %j',
    async (replacement) => {
      const dshHome = await home();
      const current = join(dshHome, '.dshpack', 'generations', 'demo-pack', 'current');
      const result = await runTransaction(
        { adapter: createNodeTransactionAdapter(), dshHome, txid: 'invalid-current-write' },
        async (transaction) => transaction.writeGenerationCurrent(current, undefined, replacement),
      );

      expect(result).toMatchObject({
        exitCode: 30,
        status: 'rolled-back',
        manualRecovery: [],
        diagnostics: [{ code: 'E_GENERATION_CURRENT', path: current }],
      });
      expect(result.journal.actions).toEqual([]);
      await expect(lstat(dirname(current))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each(['not-a-pointer\n', `${'9'.repeat(129)}\n`] as const)(
    'rejects an invalid expected current pointer before reserving any state parent or journal action: %j',
    async (invalidExpected) => {
      const dshHome = await home();
      const current = join(dshHome, '.dshpack', 'generations', 'demo-pack', 'current');
      const base = createNodeTransactionAdapter();
      let compareCalls = 0;
      const result = await runTransaction(
        {
          adapter: {
            ...base,
            readGenerationCurrent: async () => invalidExpected,
            compareAndSwapGenerationCurrent: async () => {
              compareCalls += 1;
              return false;
            },
          },
          dshHome,
          txid: 'invalid-current-expected',
        },
        async (transaction) => transaction.writeGenerationCurrent(current, invalidExpected, '2\n'),
      );

      expect(result).toMatchObject({
        exitCode: 30,
        status: 'rolled-back',
        manualRecovery: [],
        diagnostics: [{ code: 'E_GENERATION_CURRENT', path: current }],
        journal: { actions: [] },
      });
      expect(compareCalls).toBe(0);
      await expect(lstat(dirname(current))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('rejects an oversized managed document before reserving any state parent or journal action', async () => {
    const dshHome = await home();
    const marker = join(dshHome, '.dshpack', 'installed', 'demo-pack.json');
    const oversized = 'x'.repeat(MAX_TRANSACTION_STATE_BYTES + 1);
    const result = await runTransaction(
      { adapter: createNodeTransactionAdapter(), dshHome, txid: 'managed-write-over-limit' },
      async (transaction) => transaction.writeManagedDocument(marker, oversized),
    );

    expect(result).toMatchObject({
      exitCode: 30,
      status: 'rolled-back',
      manualRecovery: [],
      diagnostics: [{ code: 'E_MANAGED_DOCUMENT', path: marker }],
      journal: { actions: [] },
    });
    await expect(lstat(dirname(marker))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses bounded current CAS and rollback primitives when current grows after its initial read', async () => {
    const dshHome = await home();
    const current = join(dshHome, '.dshpack', 'generations', 'demo-pack', 'current');
    await mkdir(dirname(current), { recursive: true });
    await writeFile(current, '1\n');
    const oversized = Buffer.alloc(129, '1');
    const base = createNodeTransactionAdapter();
    if (base.compareAndSwapGenerationCurrent === undefined)
      throw new Error('bounded generation current CAS is required');
    const casResult = await runTransaction(
      {
        adapter: {
          ...base,
          async compareAndSwapGenerationCurrent(path, expected, replacement) {
            await writeFile(path, oversized);
            return base.compareAndSwapGenerationCurrent?.(path, expected, replacement) ?? false;
          },
        },
        dshHome,
        txid: 'current-cas-overgrown',
      },
      async (transaction) => transaction.writeGenerationCurrent(current, '1\n', '2\n'),
    );
    expect(casResult).toMatchObject({ exitCode: 25, status: 'rollback-failed' });
    expect(casResult.manualRecovery).not.toEqual([]);
    expect(await readFile(current)).toEqual(oversized);

    await writeFile(current, '1\n');
    let swaps = 0;
    const rollbackResult = await runTransaction(
      {
        adapter: {
          ...base,
          async compareAndSwapGenerationCurrent(path, expected, replacement) {
            swaps += 1;
            if (swaps === 2) await writeFile(path, oversized);
            return base.compareAndSwapGenerationCurrent?.(path, expected, replacement) ?? false;
          },
        },
        dshHome,
        txid: 'current-rollback-overgrown',
      },
      async (transaction) => {
        await transaction.writeGenerationCurrent(current, '1\n', '2\n');
        throw abort();
      },
    );
    expect(rollbackResult).toMatchObject({ exitCode: 25, status: 'rollback-failed' });
    expect(rollbackResult.manualRecovery).not.toEqual([]);
    expect(await readFile(current)).toEqual(oversized);
  });

  it('fails closed on an oversized installed marker without reading it as unbounded text', async () => {
    const dshHome = await home();
    const marker = join(dshHome, '.dshpack', 'installed', 'demo-pack.json');
    const oversized = Buffer.alloc(MAX_TRANSACTION_STATE_BYTES + 1, 1);
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, oversized);
    const before = await lstat(marker, { bigint: true });
    const result = await runTransaction(
      { adapter: createNodeTransactionAdapter(), dshHome, txid: 'managed-document-over-limit' },
      async (transaction) => transaction.writeManagedDocument(marker, '{"metadataVersion":1}\n'),
    );

    expect(result).toMatchObject({
      exitCode: 30,
      status: 'rolled-back',
      manualRecovery: [],
      diagnostics: [{ code: 'E_MANAGED_DOCUMENT', path: marker }],
    });
    const after = await lstat(marker, { bigint: true });
    expect(`${after.dev}:${after.ino}:${after.birthtimeNs}`).toBe(
      `${before.dev}:${before.ino}:${before.birthtimeNs}`,
    );
  });

  it('fails closed when the adapter lacks bounded installed-marker reads', async () => {
    const dshHome = await home();
    const marker = join(dshHome, '.dshpack', 'installed', 'demo-pack.json');
    const base = createNodeTransactionAdapter();
    const { readManagedDocument: _unsupportedManagedRead, ...withoutManagedRead } = base;
    const result = await runTransaction(
      { adapter: withoutManagedRead, dshHome, txid: 'managed-document-no-reader' },
      async (transaction) => transaction.writeManagedDocument(marker, '{"metadataVersion":1}\n'),
    );

    expect(result).toMatchObject({
      exitCode: 70,
      status: 'rolled-back',
      manualRecovery: [],
      diagnostics: [{ code: 'E_TRANSACTION_STATE_ADAPTER', path: marker }],
    });
  });

  it('rejects stale or occupied bounded current and managed-document conditional mutations', async () => {
    const dshHome = await home();
    const current = join(dshHome, '.dshpack', 'generations', 'demo-pack', 'current');
    const marker = join(dshHome, '.dshpack', 'installed', 'demo-pack.json');
    const currentBackup = `${current}.backup`;
    const markerBackup = `${marker}.backup`;
    await mkdir(dirname(current), { recursive: true });
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(current, '1\n');
    await writeFile(marker, '{"metadataVersion":1}\n');
    await writeFile(currentBackup, 'occupied\n');
    await writeFile(markerBackup, 'occupied\n');
    const adapter = createNodeTransactionAdapter();
    if (
      adapter.compareAndSwapGenerationCurrent === undefined ||
      adapter.compareAndMoveGenerationCurrent === undefined ||
      adapter.compareAndSwapManagedDocument === undefined ||
      adapter.compareAndMoveManagedDocument === undefined
    ) {
      throw new Error('bounded state conditional mutations are required');
    }

    expect(await adapter.compareAndSwapGenerationCurrent(current, '2\n', '3\n')).toBe(false);
    await expect(
      adapter.compareAndMoveGenerationCurrent(current, '1\n', currentBackup),
    ).rejects.toThrow(/rollback target exists/u);
    expect(
      await adapter.compareAndSwapManagedDocument(marker, 'different\n', '{"replacement":true}\n'),
    ).toBe(false);
    await expect(
      adapter.compareAndMoveManagedDocument(marker, '{"metadataVersion":1}\n', markerBackup),
    ).rejects.toThrow(/rollback target exists/u);
  });

  it('refuses to move bounded current or a managed document that no longer holds the rolled-back value', async () => {
    const dshHome = await home();
    const current = join(dshHome, '.dshpack', 'generations', 'demo-pack', 'current');
    const marker = join(dshHome, '.dshpack', 'installed', 'demo-pack.json');
    const currentBackup = `${current}.backup`;
    const markerBackup = `${marker}.backup`;
    await mkdir(dirname(current), { recursive: true });
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(current, '7\n');
    await writeFile(marker, '{"metadataVersion":1,"generation":7}\n');
    const adapter = createNodeTransactionAdapter();
    if (
      adapter.compareAndMoveGenerationCurrent === undefined ||
      adapter.compareAndMoveManagedDocument === undefined
    ) {
      throw new Error('bounded state conditional mutations are required');
    }

    // Someone else advanced the state after this rollback was planned. Moving anyway would
    // file the wrong bytes under the backup name and destroy the only record of what to
    // recover, so the move must decline instead — and decline without touching either path.
    expect(await adapter.compareAndMoveGenerationCurrent(current, '1\n', currentBackup)).toBe(
      false,
    );
    expect(
      await adapter.compareAndMoveManagedDocument(marker, '{"metadataVersion":1}\n', markerBackup),
    ).toBe(false);
    expect(await readFile(current, 'utf8')).toBe('7\n');
    expect(await readFile(marker, 'utf8')).toBe('{"metadataVersion":1,"generation":7}\n');
    await expect(readFile(currentBackup, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(markerBackup, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects invalid UTF-8 through the dedicated bounded current and marker adapters', async () => {
    const dshHome = await home();
    const current = join(dshHome, '.dshpack', 'generations', 'demo-pack', 'current');
    const marker = join(dshHome, '.dshpack', 'installed', 'demo-pack.json');
    await mkdir(dirname(current), { recursive: true });
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(current, Buffer.from([0xff]));
    await writeFile(marker, Buffer.from([0xff]));
    const adapter = createNodeTransactionAdapter();
    if (
      adapter.compareAndSwapGenerationCurrent === undefined ||
      adapter.readManagedDocument === undefined
    )
      throw new Error('bounded current and marker adapters are required');

    await expect(
      adapter.compareAndSwapGenerationCurrent(current, '1\n', '2\n'),
    ).rejects.toMatchObject({
      exitCode: 30,
      diagnostics: [{ code: 'E_GENERATION_CURRENT', path: current }],
    });
    await expect(adapter.readManagedDocument(marker)).rejects.toMatchObject({
      exitCode: 30,
      diagnostics: [{ code: 'E_MANAGED_DOCUMENT', path: marker }],
    });
  });

  it('fails closed for missing and non-UTF-8 private rollback document backups', async () => {
    const dshHome = await home();
    const backup = join(dshHome, '.dshpack', 'backups', 'tx-private', 'documents', '0001-new');
    const adapter = createNodeTransactionAdapter();
    if (adapter.readTransactionBackupText === undefined)
      throw new Error('bounded private backup reader is required');

    await expect(adapter.readTransactionBackupText(backup, 128)).rejects.toThrow(
      /backup document is missing/u,
    );
    await mkdir(dirname(backup), { recursive: true });
    await writeFile(backup, Buffer.from([0xff]));
    await expect(adapter.readTransactionBackupText(backup, 128)).rejects.toBeInstanceOf(
      TransactionStateReadSecurityError,
    );
  });

  it('restores the exact previous current pointer after a later rollback and rejects stale or failed CAS writes', async () => {
    const dshHome = await home();
    const current = join(dshHome, '.dshpack', 'generations', 'demo-pack', 'current');
    await mkdir(join(current, '..'), { recursive: true });
    await writeFile(current, '1\n');
    const restored = await runTransaction(
      { adapter: createNodeTransactionAdapter(), dshHome, txid: 'current-restore' },
      async (transaction) => {
        await transaction.writeGenerationCurrent(current, '1\n', '2\n');
        expect(await readFile(current, 'utf8')).toBe('2\n');
        throw abort();
      },
    );
    expect(restored).toMatchObject({ exitCode: 24, status: 'rolled-back', manualRecovery: [] });
    expect(await readFile(current, 'utf8')).toBe('1\n');

    const stale = await runTransaction(
      { adapter: createNodeTransactionAdapter(), dshHome, txid: 'current-stale' },
      async (transaction) => transaction.writeGenerationCurrent(current, '2\n', '3\n'),
    );
    expect(stale).toMatchObject({
      exitCode: 30,
      status: 'rolled-back',
      diagnostics: [{ code: 'E_TRANSACTION_GENERATION_CURRENT_CHANGED' }],
    });

    const base = createNodeTransactionAdapter();
    const casFailed = await runTransaction(
      {
        adapter: { ...base, compareAndSwapGenerationCurrent: async () => false },
        dshHome,
        txid: 'current-cas-failed',
      },
      async (transaction) => transaction.writeGenerationCurrent(current, '1\n', '2\n'),
    );
    expect(casFailed).toMatchObject({
      exitCode: 30,
      status: 'rolled-back',
      manualRecovery: [],
      diagnostics: [{ code: 'E_TRANSACTION_GENERATION_CURRENT_CHANGED' }],
    });
    expect(await readFile(current, 'utf8')).toBe('1\n');
  });

  it('fails closed when bounded document CAS capabilities are absent', async () => {
    const dshHome = await home();
    const current = join(dshHome, '.dshpack', 'generations', 'demo-pack', 'current');
    const marker = join(dshHome, '.dshpack', 'installed', 'demo-pack.json');
    await mkdir(dirname(current), { recursive: true });
    await writeFile(current, '1\n');
    const base = createNodeTransactionAdapter();
    const {
      compareAndSwapGenerationCurrent: _compareAndSwapGenerationCurrent,
      ...withoutGenerationCurrentWriter
    } = base;
    const {
      compareAndSwapManagedDocument: _compareAndSwapManagedDocument,
      ...withoutManagedDocumentWriter
    } = base;

    const currentResult = await runTransaction(
      {
        adapter: withoutGenerationCurrentWriter,
        dshHome,
        txid: 'current-no-cas-capability',
      },
      async (transaction) => transaction.writeGenerationCurrent(current, '1\n', '2\n'),
    );
    expect(currentResult).toMatchObject({
      exitCode: 25,
      status: 'rollback-failed',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'E_TRANSACTION_STATE_ADAPTER' }),
      ]),
    });

    const markerResult = await runTransaction(
      {
        adapter: withoutManagedDocumentWriter,
        dshHome,
        txid: 'marker-no-cas-capability',
      },
      async (transaction) => transaction.writeManagedDocument(marker, '{"metadataVersion":1}\n'),
    );
    expect(markerResult).toMatchObject({
      exitCode: 25,
      status: 'rollback-failed',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'E_TRANSACTION_STATE_ADAPTER' }),
      ]),
    });
  });

  it('restores a transaction-bound deleted generation current pointer on rollback', async () => {
    const dshHome = await home();
    const current = join(dshHome, '.dshpack', 'generations', 'demo-pack', 'current');
    const original = '2\n';
    await mkdir(dirname(current), { recursive: true });
    await writeFile(current, original);
    const before = await lstat(current, { bigint: true });
    const identity = `${before.dev}:${before.ino}:${before.birthtimeNs}`;
    const result = await runTransaction(
      { adapter: createNodeTransactionAdapter(), dshHome, txid: 'current-delete-rollback' },
      async (transaction) => {
        await transaction.deleteStateFile(
          'generation-current',
          current,
          digest(Buffer.from(original)),
          identity,
        );
        await expect(readFile(current, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        throw abort();
      },
    );

    expect(result).toMatchObject({ exitCode: 24, status: 'rolled-back', manualRecovery: [] });
    expect(await readFile(current, 'utf8')).toBe(original);
  });

  it.each([
    ['new', 'hardlink'],
    ['original', 'hardlink'],
    ['new', 'directory'],
    ['original', 'directory'],
    ['new', 'oversized'],
    ['original', 'oversized'],
  ] as const)(
    'requires manual recovery instead of reading a %s current %s rollback backup',
    async (slot, attack) => {
      const dshHome = await home();
      const txid = `${attack}-current-${slot}-backup`;
      const current = join(dshHome, '.dshpack', 'generations', 'demo-pack', 'current');
      await mkdir(dirname(current), { recursive: true });
      await writeFile(current, '1\n');
      const backup = join(
        dshHome,
        '.dshpack',
        'backups',
        txid,
        'documents',
        `action-0003-generation-current-${slot}`,
      );
      const source = join(dshHome, `${attack}-${slot}-backup-source`);
      const base = createNodeTransactionAdapter();
      if (base.compareAndSwapGenerationCurrent === undefined)
        throw new Error('bounded generation current CAS is required');
      let swaps = 0;
      const result = await runTransaction(
        {
          adapter: {
            ...base,
            async compareAndSwapGenerationCurrent(path, expected, replacement) {
              const wrote = await base.compareAndSwapGenerationCurrent?.(
                path,
                expected,
                replacement,
              );
              swaps += 1;
              if (swaps === 1 && wrote) {
                await rm(backup);
                if (attack === 'hardlink') {
                  await writeFile(source, slot === 'new' ? '2\n' : '1\n');
                  await link(source, backup);
                } else if (attack === 'directory') {
                  await mkdir(backup);
                } else {
                  await createSparseFile(backup, MAX_TRANSACTION_STATE_BYTES + 1);
                }
              }
              return wrote ?? false;
            },
          },
          dshHome,
          txid,
        },
        async (transaction) => {
          await transaction.writeGenerationCurrent(current, '1\n', '2\n');
          throw abort();
        },
      );

      expect(result).toMatchObject({ exitCode: 25, status: 'rollback-failed' });
      expect(result.manualRecovery).not.toEqual([]);
      expect(await readFile(current, 'utf8')).toBe('2\n');
    },
  );
});
