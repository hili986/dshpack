import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const openedPaths = vi.hoisted<string[]>(() => []);
const syncedPaths = vi.hoisted<string[]>(() => []);
const syncFailure = vi.hoisted(() => ({
  path: undefined as string | undefined,
  remaining: 0,
  secondPath: undefined as string | undefined,
  secondRemaining: 0,
}));
const recursiveMkdirFailure = vi.hoisted(() => ({
  path: undefined as string | undefined,
  calls: 0,
}));
const exclusiveMkdirFailure = vi.hoisted(() => ({
  path: undefined as string | undefined,
  calls: 0,
}));
const raceExistingMkdir = vi.hoisted(() => ({
  path: undefined as string | undefined,
  calls: 0,
}));
const lstatFailure = vi.hoisted(() => ({
  path: undefined as string | undefined,
  calls: 0,
}));

function consumeSyncFailure(path: string): void {
  if (syncFailure.path === path && syncFailure.remaining > 0) {
    syncFailure.remaining -= 1;
    throw Object.assign(new Error('injected directory sync failure'), { code: 'EIO' });
  }
  if (syncFailure.secondPath === path && syncFailure.secondRemaining > 0) {
    syncFailure.secondRemaining -= 1;
    throw Object.assign(new Error('injected directory sync failure'), { code: 'EIO' });
  }
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    lstat: async (...args: Parameters<typeof original.lstat>) => {
      const path = String(args[0]);
      if (lstatFailure.path === path) {
        lstatFailure.calls += 1;
        throw Object.assign(new Error('injected metadata ancestor lstat failure'), {
          code: 'EACCES',
        });
      }
      return original.lstat(...args);
    },
    mkdir: async (...args: Parameters<typeof original.mkdir>) => {
      const path = String(args[0]);
      if (
        recursiveMkdirFailure.path === path &&
        typeof args[1] === 'object' &&
        args[1] !== null &&
        args[1].recursive === true
      ) {
        recursiveMkdirFailure.calls += 1;
        await original.mkdir(...args);
        throw Object.assign(new Error('injected recursive mkdir failure after creation'), {
          code: 'EIO',
        });
      }
      if (exclusiveMkdirFailure.path === path) {
        exclusiveMkdirFailure.calls += 1;
        throw Object.assign(new Error('injected exclusive mkdir failure after prefix creation'), {
          code: 'EIO',
        });
      }
      if (raceExistingMkdir.path === path) {
        raceExistingMkdir.calls += 1;
        await original.mkdir(...args);
        throw Object.assign(new Error('injected concurrent directory creator'), { code: 'EEXIST' });
      }
      return original.mkdir(...args);
    },
    open: async (...args: Parameters<typeof original.open>) => {
      openedPaths.push(String(args[0]));
      try {
        if ((await original.lstat(args[0])).isDirectory()) {
          return {
            sync: async () => {
              syncedPaths.push(String(args[0]));
              consumeSyncFailure(String(args[0]));
            },
            close: async () => undefined,
          } as Awaited<ReturnType<typeof original.open>>;
        }
      } catch {
        // New temporary files do not exist before exclusive open; use the real file handle below.
      }
      const handle = await original.open(...args);
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'sync')
            return async () => {
              syncedPaths.push(String(args[0]));
              consumeSyncFailure(String(args[0]));
              return target.sync();
            };
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { casStoreShard } from '../src/metadata/state-storage.js';
import {
  createNodeTransactionAdapter,
  runTransaction,
  TransactionPhysicalProgressError,
} from '../src/transaction.js';

const roots: string[] = [];

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-state-durability-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  openedPaths.splice(0);
  syncedPaths.splice(0);
  syncFailure.path = undefined;
  syncFailure.remaining = 0;
  syncFailure.secondPath = undefined;
  syncFailure.secondRemaining = 0;
  recursiveMkdirFailure.path = undefined;
  recursiveMkdirFailure.calls = 0;
  exclusiveMkdirFailure.path = undefined;
  exclusiveMkdirFailure.calls = 0;
  raceExistingMkdir.path = undefined;
  raceExistingMkdir.calls = 0;
  lstatFailure.path = undefined;
  lstatFailure.calls = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('transaction binary state durability', () => {
  it('fsyncs fresh metadata ancestors before publishing a transaction setup directory', async () => {
    const root = await home();
    const dshHome = join(root, 'fresh-home');
    syncedPaths.splice(0);

    const result = await runTransaction(
      {
        adapter: createNodeTransactionAdapter(),
        dshHome,
        txid: 'gc-fresh-metadata-fsync',
        purpose: 'gc',
      },
      async () => undefined,
    );

    expect(result).toMatchObject({ exitCode: 0, status: 'committed' });
    expect(syncedPaths).toEqual(
      expect.arrayContaining([dirname(dshHome), dshHome, join(dshHome, '.dshpack')]),
    );
  });

  it('does not require the parent of an existing DSH_HOME to be readable', async () => {
    const dshHome = await home();
    const parent = dirname(dshHome);
    syncedPaths.splice(0);
    openedPaths.splice(0);

    const result = await runTransaction(
      {
        adapter: createNodeTransactionAdapter(),
        dshHome,
        txid: 'gc-existing-home-parent-capability',
        purpose: 'gc',
      },
      async () => undefined,
    );

    expect(result).toMatchObject({ exitCode: 0, status: 'committed', manualRecovery: [] });
    expect(openedPaths).not.toContain(parent);
    expect(syncedPaths).not.toContain(parent);
  });

  it('does not leave a partially-created recursive DSH_HOME prefix unaccounted for', async () => {
    const root = await home();
    const dshHome = join(root, 'recursive-mkdir-failure');
    recursiveMkdirFailure.path = dshHome;

    const result = await runTransaction(
      {
        adapter: createNodeTransactionAdapter(),
        dshHome,
        txid: 'gc-recursive-mkdir-prefix-failure',
        purpose: 'gc',
      },
      async () => undefined,
    );

    expect(result).toMatchObject({ exitCode: 0, status: 'committed', manualRecovery: [] });
    expect(recursiveMkdirFailure.calls).toBe(0);
  });

  it('requires manual recovery if a later metadata ancestor mkdir fails after an owned prefix', async () => {
    const root = await home();
    const prefix = join(root, 'owned-prefix');
    const dshHome = join(prefix, 'home');
    exclusiveMkdirFailure.path = dshHome;

    const result = await runTransaction(
      {
        adapter: createNodeTransactionAdapter(),
        dshHome,
        txid: 'gc-exclusive-prefix-then-failure',
        purpose: 'gc',
      },
      async () => undefined,
    );

    expect(result).toMatchObject({ exitCode: 25, status: 'not-started' });
    expect(result.manualRecovery).not.toEqual([]);
    expect(exclusiveMkdirFailure.calls).toBe(1);
    await expect(lstat(prefix)).resolves.toBeDefined();
  });

  it('keeps a first metadata-ancestor mkdir failure free of manual recovery', async () => {
    const root = await home();
    const dshHome = join(root, 'not-created');
    exclusiveMkdirFailure.path = dshHome;

    const result = await runTransaction(
      {
        adapter: createNodeTransactionAdapter(),
        dshHome,
        txid: 'gc-first-metadata-mkdir-failure',
        purpose: 'gc',
      },
      async () => undefined,
    );

    expect(result).toMatchObject({ exitCode: 70, status: 'not-started', manualRecovery: [] });
    expect(exclusiveMkdirFailure.calls).toBe(1);
    await expect(lstat(dshHome)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not treat a concurrent metadata-ancestor creator as a transaction-owned directory', async () => {
    const root = await home();
    const dshHome = join(root, 'raced-home');
    raceExistingMkdir.path = dshHome;

    const result = await runTransaction(
      {
        adapter: createNodeTransactionAdapter(),
        dshHome,
        txid: 'gc-concurrent-metadata-prefix',
        purpose: 'gc',
      },
      async () => undefined,
    );

    expect(result).toMatchObject({ exitCode: 0, status: 'committed', manualRecovery: [] });
    expect(raceExistingMkdir.calls).toBe(1);
    await expect(lstat(dshHome)).resolves.toBeDefined();
  });

  it('fails before writing when metadata-ancestor discovery cannot be read safely', async () => {
    const root = await home();
    const dshHome = join(root, 'unreadable-home');
    lstatFailure.path = dshHome;

    const result = await runTransaction(
      {
        adapter: createNodeTransactionAdapter(),
        dshHome,
        txid: 'gc-unreadable-metadata-ancestor',
        purpose: 'gc',
      },
      async () => undefined,
    );

    expect(result).toMatchObject({ exitCode: 70, status: 'not-started', manualRecovery: [] });
    expect(lstatFailure.calls).toBe(1);
    lstatFailure.path = undefined;
    await expect(lstat(dshHome)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fsyncs the exclusive state file and every newly-created state directory parent', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('state');
    const digest = `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
    const path = join(dshHome, '.dshpack', 'store', casStoreShard(digest), digest);
    const result = await runTransaction(
      { adapter: createNodeTransactionAdapter(), dshHome, txid: 'state-parent-fsync' },
      async (transaction) => transaction.writeStateFile('store-block', path, bytes),
    );

    expect(result).toMatchObject({ exitCode: 0, status: 'committed' });
    expect(openedPaths).toContain(dirname(path));
    expect(syncedPaths).toEqual(
      expect.arrayContaining([
        path,
        dirname(path),
        join(dshHome, '.dshpack', 'store'),
        join(dshHome, '.dshpack'),
      ]),
    );
  });

  it('requires manual recovery when fresh metadata mkdir reaches parent fsync before failing', async () => {
    const root = await home();
    const dshHome = join(root, 'fresh-home-fsync-failure');
    syncFailure.path = dshHome;
    syncFailure.remaining = 1;

    const result = await runTransaction(
      {
        adapter: createNodeTransactionAdapter(),
        dshHome,
        txid: 'gc-fresh-metadata-fsync-failure',
        purpose: 'gc',
      },
      async () => undefined,
    );

    expect(result).toMatchObject({ exitCode: 25, status: 'not-started' });
    expect(result.manualRecovery).not.toEqual([]);
    await expect(lstat(join(dshHome, '.dshpack'))).resolves.toBeDefined();
  });

  it('removes a provisional GC setup directory when mkdir succeeded but its parent fsync failed', async () => {
    const dshHome = await home();
    const txid = 'gc-setup-parent-sync-failure';
    const backupDirectory = join(dshHome, '.dshpack', 'backups', txid);
    syncFailure.path = dirname(backupDirectory);
    syncFailure.remaining = 1;

    const result = await runTransaction(
      { adapter: createNodeTransactionAdapter(), dshHome, txid, purpose: 'gc' },
      async () => undefined,
    );

    expect(result).toMatchObject({ exitCode: 70, status: 'not-started', manualRecovery: [] });
    await expect(lstat(backupDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    const backups = dirname(backupDirectory);
    expect((await import('node:fs/promises')).readdir(backups)).resolves.toEqual([]);
  });

  it('requires manual recovery when stale provisional setup removal reaches rmdir before parent fsync fails', async () => {
    const dshHome = await home();
    const txid = 'gc-stale-setup-parent-sync';
    const backups = join(dshHome, '.dshpack', 'backups');
    const setup = join(backups, '.setup-11111111-1111-4111-8111-111111111111');
    await mkdir(setup, { recursive: true });
    await writeFile(
      join(setup, 'journal.json'),
      `${JSON.stringify({
        version: 0,
        txid: 'gc-stale-setup-parent-sync',
        dshHome,
        backupDirectory: join(backups, 'gc-stale-setup-parent-sync'),
        state: 'active',
        actions: [],
      })}\n`,
    );
    syncFailure.path = backups;
    syncFailure.remaining = 1;

    const result = await runTransaction(
      { adapter: createNodeTransactionAdapter(), dshHome, txid, purpose: 'gc' },
      async () => undefined,
    );

    expect(result).toMatchObject({ exitCode: 25, status: 'not-started' });
    expect(result.manualRecovery).not.toEqual([]);
    await expect(lstat(setup)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers an empty stale provisional setup directory', async () => {
    const dshHome = await home();
    const setup = join(
      dshHome,
      '.dshpack',
      'backups',
      '.setup-33333333-3333-4333-8333-333333333333',
    );
    await mkdir(setup, { recursive: true });

    const result = await runTransaction(
      {
        adapter: createNodeTransactionAdapter(),
        dshHome,
        txid: 'gc-recover-empty-setup',
        purpose: 'gc',
      },
      async () => undefined,
    );

    expect(result).toMatchObject({ exitCode: 0, status: 'committed', manualRecovery: [] });
    await expect(lstat(setup)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['unknown child', 'unknown'],
    ['non-UTF-8 journal', 'journal.json'],
    ['non-object journal', 'journal.json'],
  ] as const)('fails closed for a stale provisional setup with %s', async (label, leaf) => {
    const dshHome = await home();
    const setup = join(
      dshHome,
      '.dshpack',
      'backups',
      `.setup-44444444-4444-4444-8444-44444444444${label === 'unknown child' ? '4' : '5'}`,
    );
    await mkdir(setup, { recursive: true });
    await writeFile(
      join(setup, leaf),
      label === 'non-UTF-8 journal'
        ? Buffer.from([0xff])
        : label === 'non-object journal'
          ? 'null'
          : 'x',
    );

    const result = await runTransaction(
      {
        adapter: createNodeTransactionAdapter(),
        dshHome,
        txid: `gc-reject-${leaf}`,
        purpose: 'gc',
      },
      async () => undefined,
    );

    expect(result).toMatchObject({ exitCode: 31, status: 'not-started', manualRecovery: [] });
    await expect(lstat(setup)).resolves.toBeDefined();
  });

  it('fails closed for an object-shaped provisional journal with an unsupported version', async () => {
    const dshHome = await home();
    const setup = join(
      dshHome,
      '.dshpack',
      'backups',
      '.setup-66666666-6666-4666-8666-666666666666',
    );
    await mkdir(setup, { recursive: true });
    await writeFile(join(setup, 'journal.json'), '{"version":1}');

    const result = await runTransaction(
      {
        adapter: createNodeTransactionAdapter(),
        dshHome,
        txid: 'gc-reject-version',
        purpose: 'gc',
      },
      async () => undefined,
    );

    expect(result).toMatchObject({ exitCode: 31, status: 'not-started', manualRecovery: [] });
    await expect(lstat(setup)).resolves.toBeDefined();
  });

  it('fails closed for a setup directory that resembles but is not a provisional UUID', async () => {
    const dshHome = await home();
    const setup = join(dshHome, '.dshpack', 'backups', '.setup-not-a-uuid');
    await mkdir(setup, { recursive: true });

    const result = await runTransaction(
      {
        adapter: createNodeTransactionAdapter(),
        dshHome,
        txid: 'gc-reject-setup-shape',
        purpose: 'gc',
      },
      async () => undefined,
    );

    expect(result).toMatchObject({ exitCode: 31, status: 'not-started', manualRecovery: [] });
    await expect(lstat(setup)).resolves.toBeDefined();
  });

  it('requires manual recovery when stale journal unlink reaches its setup-directory fsync before failing', async () => {
    const dshHome = await home();
    const txid = 'gc-stale-journal-sync';
    const setup = join(
      dshHome,
      '.dshpack',
      'backups',
      '.setup-55555555-5555-4555-8555-555555555555',
    );
    await mkdir(setup, { recursive: true });
    await writeFile(
      join(setup, 'journal.json'),
      JSON.stringify({
        version: 0,
        txid,
        dshHome,
        backupDirectory: join(dshHome, '.dshpack', 'backups', txid),
        state: 'active',
        actions: [],
      }),
    );
    syncFailure.path = setup;
    syncFailure.remaining = 1;

    const result = await runTransaction(
      {
        adapter: createNodeTransactionAdapter(),
        dshHome,
        txid: 'gc-recover-after-unlink',
        purpose: 'gc',
      },
      async () => undefined,
    );

    expect(result).toMatchObject({ exitCode: 25, status: 'not-started' });
    expect(result.manualRecovery).not.toEqual([]);
    await expect(lstat(join(setup, 'journal.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fsyncs both state-move parents after the irreversible GC quarantine rename', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('durable obsolete state');
    const digest = `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
    const source = join(dshHome, '.dshpack', 'store', casStoreShard(digest), digest);
    const destination = join(
      dshHome,
      '.dshpack',
      'backups',
      'gc-durable-move',
      'old',
      'action-0001',
    );
    await mkdir(dirname(source), { recursive: true });
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(source, bytes);
    const adapter = createNodeTransactionAdapter();
    const lock = await adapter.acquireArtifactLock(dshHome);
    const identity = `${(await lstat(source, { bigint: true })).dev}:${(await lstat(source, { bigint: true })).ino}:${(await lstat(source, { bigint: true })).birthtimeNs}`;
    syncedPaths.splice(0);

    try {
      await expect(
        adapter.moveArtifactPath(lock, 'store-block', source, destination, 'to-backup', identity, {
          contentSha256: digest,
        }),
      ).resolves.toBe(true);
    } finally {
      await lock.release();
    }

    expect(syncedPaths).toEqual(expect.arrayContaining([dirname(source), dirname(destination)]));
  });

  it('rolls a GC deletion back when the durable forward rename cannot fsync its destination', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('durability failure must not report a committed delete');
    const digest = `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
    const source = join(dshHome, '.dshpack', 'store', casStoreShard(digest), digest);
    const txid = 'gc-durable-sync-failure';
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, bytes);
    const stats = await lstat(source, { bigint: true });
    const identity = `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
    syncFailure.path = join(dshHome, '.dshpack', 'backups', txid, 'old');
    syncFailure.remaining = 1;

    const result = await runTransaction(
      { adapter: createNodeTransactionAdapter(), dshHome, txid },
      async (transaction) => transaction.deleteStateFile('store-block', source, digest, identity),
    );

    expect(result).toMatchObject({
      exitCode: 70,
      status: 'rolled-back',
      manualRecovery: [],
      diagnostics: [expect.objectContaining({ code: 'E_TRANSACTION_ABORTED' })],
    });
    expect(await readFile(source)).toEqual(bytes);
  });

  it('requires manual recovery when forward and compensating rename fsyncs both fail after moving bytes', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('both durable rename acknowledgements fail');
    const digest = `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
    const source = join(dshHome, '.dshpack', 'store', casStoreShard(digest), digest);
    const txid = 'gc-double-durable-sync-failure';
    const destination = join(dshHome, '.dshpack', 'backups', txid, 'old', 'action-0001');
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, bytes);
    const stats = await lstat(source, { bigint: true });
    const identity = `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
    syncFailure.path = dirname(destination);
    syncFailure.remaining = 1;
    syncFailure.secondPath = dirname(source);
    syncFailure.secondRemaining = 1;

    const result = await runTransaction(
      { adapter: createNodeTransactionAdapter(), dshHome, txid, purpose: 'gc' },
      async (transaction) => transaction.deleteStateFile('store-block', source, digest, identity),
    );

    expect(result).toMatchObject({ exitCode: 25, status: 'rollback-failed' });
    expect(result.manualRecovery).not.toEqual([]);
    expect(await readFile(source)).toEqual(bytes);
  });

  it('fsyncs the quarantine parent again after permanently unlinking a verified payload', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('durable permanent GC purge');
    const digest = `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
    const path = join(dshHome, '.dshpack', 'backups', 'gc-durable-purge', 'old', 'action-0001');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const adapter = createNodeTransactionAdapter();
    if (adapter.purgeGcQuarantineFile === undefined)
      throw new Error('GC quarantine purge adapter is required');
    const lock = await adapter.acquireArtifactLock(dshHome);
    const stats = await lstat(path, { bigint: true });
    const identity = `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
    syncedPaths.splice(0);

    try {
      await expect(adapter.purgeGcQuarantineFile(lock, path, digest, identity)).resolves.toBe(true);
    } finally {
      await lock.release();
    }

    const parent = dirname(path);
    // One sync is required for the rename into .purging-*; a second one proves unlink itself
    // is made durable rather than merely relying on the earlier rename synchronization.
    expect(syncedPaths.filter((candidate) => candidate === parent)).toHaveLength(2);
  });

  it('reports typed physical progress when unlink succeeds but its parent fsync fails', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('durable unlink acknowledgement failure');
    const digest = `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
    const path = join(
      dshHome,
      '.dshpack',
      'backups',
      'gc-unlink-sync-failure',
      'old',
      'action-0001',
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const adapter = createNodeTransactionAdapter(
      {},
      {
        afterGcQuarantineRename: async (_from, to) => {
          syncFailure.path = dirname(to);
          syncFailure.remaining = 1;
        },
      },
    );
    if (adapter.purgeGcQuarantineFile === undefined)
      throw new Error('GC quarantine purge adapter is required');
    const lock = await adapter.acquireArtifactLock(dshHome);
    const stats = await lstat(path, { bigint: true });
    const identity = `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;

    try {
      await expect(
        adapter.purgeGcQuarantineFile(lock, path, digest, identity),
      ).rejects.toBeInstanceOf(TransactionPhysicalProgressError);
    } finally {
      await lock.release();
    }
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports typed physical progress when quarantine rename completed before its parent fsync failed', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('durable rename acknowledgement failure');
    const digest = `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
    const path = join(
      dshHome,
      '.dshpack',
      'backups',
      'gc-rename-sync-failure',
      'old',
      'action-0001',
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    syncFailure.path = dirname(path);
    syncFailure.remaining = 1;
    const adapter = createNodeTransactionAdapter();
    if (adapter.purgeGcQuarantineFile === undefined)
      throw new Error('GC quarantine purge adapter is required');
    const lock = await adapter.acquireArtifactLock(dshHome);
    const stats = await lstat(path, { bigint: true });
    const identity = `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;

    try {
      await expect(
        adapter.purgeGcQuarantineFile(lock, path, digest, identity),
      ).rejects.toBeInstanceOf(TransactionPhysicalProgressError);
    } finally {
      await lock.release();
    }
    await expect(readFile(path)).resolves.toEqual(bytes);
  });
});
