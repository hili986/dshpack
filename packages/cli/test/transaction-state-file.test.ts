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
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_CODES } from '../src/exit-codes.js';
import type { BoundedReadDependencies, SnapshotStat } from '../src/install/snapshot-capture.js';
import type { TransactionContext } from '../src/transaction.js';
import {
  createNodeTransactionAdapter,
  MAX_TRANSACTION_STATE_BYTES,
  runTransaction,
  TransactionFailure,
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
  const token = value.slice('sha256-'.length);
  return join(dshHome, '.dshpack', 'store', token.slice(0, 2), value);
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

  it('moves a post-rename tampered CAS block back instead of swallowing it into the backup', async () => {
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
    expect(await readFile(path)).toEqual(tampered);
  });

  it('moves a post-rename nonempty state directory back instead of swallowing unknown files', async () => {
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
    expect(await readFile(join(directory, unknown), 'utf8')).toBe('external');
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
