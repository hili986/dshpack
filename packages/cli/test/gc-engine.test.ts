import { createHash } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runGc } from '../src/gc/engine.js';
import { bindSecureRoot } from '../src/list/safe-fs.js';
import { casStoreShard, isCanonicalCasStoreShard } from '../src/metadata/state-storage.js';
import {
  createNodeTransactionAdapter,
  MAX_TRANSACTION_STATE_BYTES,
  runTransaction,
  TransactionPhysicalProgressError,
  TransactionStateReadLimitError,
  TransactionStateReadSecurityError,
} from '../src/transaction.js';

const roots: string[] = [];

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-gc-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
}

function generationName(sequence: number): string {
  return `${String(sequence).padStart(4, '0')}.json`;
}

async function writeBlock(dshHome: string, bytes: Uint8Array): Promise<string> {
  const digest = sha256(bytes);
  const path = join(dshHome, '.dshpack', 'store', casStoreShard(digest), digest);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return digest;
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

async function sparseFingerprint(path: string): Promise<{
  identity: string;
  size: bigint;
  first: number;
  last: number;
}> {
  const details = await lstat(path, { bigint: true });
  const handle = await open(path, 'r');
  try {
    const first = Buffer.alloc(1);
    const last = Buffer.alloc(1);
    await handle.read(first, 0, 1, 0);
    await handle.read(last, 0, 1, Number(details.size - 1n));
    return {
      identity: `${details.dev}:${details.ino}:${details.birthtimeNs}`,
      size: details.size,
      first: first[0] as number,
      last: last[0] as number,
    };
  } finally {
    await handle.close();
  }
}

async function fingerprint(
  path: string,
): Promise<{ identity: string; digest: string; size: bigint }> {
  const details = await lstat(path, { bigint: true });
  return {
    identity: `${details.dev}:${details.ino}:${details.birthtimeNs}`,
    digest: sha256(await readFile(path)),
    size: details.size,
  };
}

function generationDocument(
  profile: string,
  sequence: number,
  digests: readonly string[],
): Record<string, unknown> {
  return {
    seq: sequence,
    txid: `fixture-${String(sequence)}`,
    createdAt: '2026-08-17T00:00:00.000Z',
    operation: 'install',
    pack: {
      name: 'fixture-pack',
      version: '1.0.0',
      manifestDigest: sha256(Buffer.from('fixture manifest')),
    },
    source: { kind: 'fixture' },
    entries: digests.map((digest, index) => ({
      target: `profiles/${profile}/entry-${String(index)}`,
      sha256: digest,
    })),
    settingsContribution: { namespace: 'agent-presets', keys: [] },
    restorable: true,
  };
}

function generationPath(dshHome: string, profile: string, sequence: number): string {
  return join(dshHome, '.dshpack', 'generations', profile, generationName(sequence));
}

async function writeGeneration(
  dshHome: string,
  profile: string,
  sequence: number,
  digests: readonly string[],
): Promise<string> {
  const path = generationPath(dshHome, profile, sequence);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(generationDocument(profile, sequence, digests))}\n`);
  return path;
}

async function snapshot(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const visit = async (path: string, relative: string): Promise<void> => {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name);
      const key = relative === '' ? name : `${relative}/${name}`;
      const stats = await lstat(child);
      if (stats.isDirectory()) await visit(child, key);
      else files.set(key, await readFile(child));
    }
  };
  await visit(root, '');
  return files;
}

async function snapshotManagedState(root: string): Promise<Map<string, Buffer>> {
  const files = await snapshot(root);
  return new Map(
    [...files].filter(
      ([path]) => path.startsWith('.dshpack/generations/') || path.startsWith('.dshpack/store/'),
    ),
  );
}

async function treeBytes(path: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(path)) {
    const child = join(path, name);
    const stats = await lstat(child);
    if (stats.isDirectory()) total += await treeBytes(child);
    else total += Number(stats.size);
  }
  return total;
}

async function writeGcQuarantine(
  dshHome: string,
  txid: string,
  mutate: (journal: Record<string, unknown>, action: Record<string, unknown>) => void,
): Promise<void> {
  const payload = Buffer.from('manually constructed GC quarantine payload');
  const digest = sha256(payload);
  const oldPath = join(dshHome, '.dshpack', 'store', casStoreShard(digest), digest);
  const preservedAt = join(dshHome, '.dshpack', 'backups', txid, 'old', 'action-0001');
  const action: Record<string, unknown> = {
    id: 'action-0001',
    kind: 'replace',
    artifact: 'store-block',
    phase: 'applied',
    old: { path: oldPath, exists: true, identity: '1:2:3', contentSha256: digest },
    new: { path: oldPath, exists: false, preservedAt },
  };
  const journal: Record<string, unknown> = {
    version: 0,
    txid,
    purpose: 'gc',
    dshHome,
    backupDirectory: join(dshHome, '.dshpack', 'backups', txid),
    state: 'committed',
    actions: [action],
  };
  mutate(journal, action);
  await mkdir(dirname(preservedAt), { recursive: true });
  await writeFile(
    join(dshHome, '.dshpack', 'backups', txid, 'journal.json'),
    JSON.stringify(journal),
  );
  await writeFile(preservedAt, payload);
}

async function leaveVerifiedGcQuarantine(dshHome: string) {
  const obsolete = await writeBlock(dshHome, Buffer.from('verified GC quarantine source'));
  const retained = await writeBlock(dshHome, Buffer.from('verified GC quarantine retained'));
  await writeGeneration(dshHome, 'alpha', 1, [obsolete]);
  await writeGeneration(dshHome, 'alpha', 2, [retained]);
  await writeFile(join(dshHome, '.dshpack', 'generations', 'alpha', 'current'), '2\n');
  const base = createNodeTransactionAdapter();
  const first = await runGc(
    { dshHome, keep: 1, dryRun: false },
    { createAdapter: () => ({ ...base, purgeGcQuarantineFile: async () => false }) },
  );
  if (first.exitCode !== 0 || !first.metadata.pendingPurge)
    throw new Error('fixture did not leave a committed GC quarantine');
  return base;
}

describe('generation garbage collection', () => {
  it.each([
    [
      'an unparseable quarantine action id',
      (_journal: Record<string, unknown>, action: Record<string, unknown>) => {
        action.id = 'not-an-action';
      },
    ],
    [
      'a noncanonical quarantine action id',
      (_journal: Record<string, unknown>, action: Record<string, unknown>) => {
        action.id = 'action-00001';
      },
    ],
    [
      'a non-string old artifact path',
      (_journal: Record<string, unknown>, action: Record<string, unknown>) => {
        action.old = { ...(action.old as Record<string, unknown>), path: 17 };
      },
    ],
    [
      'duplicate canonical quarantine action ids',
      (journal: Record<string, unknown>, action: Record<string, unknown>) => {
        journal.actions = [action, { ...action }];
      },
    ],
    [
      'an escaped old artifact path',
      (_journal: Record<string, unknown>, action: Record<string, unknown>) => {
        action.old = { ...(action.old as Record<string, unknown>), path: join('C:', 'outside') };
      },
    ],
    [
      'a quarantine payload destination outside its action slot',
      (_journal: Record<string, unknown>, action: Record<string, unknown>) => {
        action.new = {
          ...(action.new as Record<string, unknown>),
          preservedAt: join('C:', 'outside'),
        };
      },
    ],
  ] as const)('rejects %s before a GC quarantine can be purged', async (_label, mutate) => {
    const dshHome = await home();
    const txid = 'gc-invalid-quarantine';
    await writeGcQuarantine(dshHome, txid, mutate);
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_QUARANTINE_JOURNAL' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it.each([
    [
      'an old path with a valid CAS basename outside the journal DSH_HOME store',
      (_journal: Record<string, unknown>, action: Record<string, unknown>, dshHome: string) => {
        const old = action.old as Record<string, unknown>;
        action.old = {
          ...old,
          path: join(
            dshHome,
            'unowned',
            casStoreShard(String(old.contentSha256)),
            String(old.contentSha256),
          ),
        };
      },
    ],
    [
      'a preserved path with a canonical action basename outside the journal backup old directory',
      (journal: Record<string, unknown>, action: Record<string, unknown>) => {
        const txid = String(journal.txid);
        action.new = {
          ...(action.new as Record<string, unknown>),
          preservedAt: join(
            String(journal.backupDirectory),
            '..',
            'other',
            'old',
            txid,
            'action-0001',
          ),
        };
      },
    ],
    [
      'an old path that reaches the journal store only after lexical dot normalization',
      (_journal: Record<string, unknown>, action: Record<string, unknown>, dshHome: string) => {
        const old = action.old as Record<string, unknown>;
        action.old = {
          ...old,
          path: `${join(dshHome, '.dshpack', 'store')}${sep}.${sep}${casStoreShard(
            String(old.contentSha256),
          )}${sep}${String(old.contentSha256)}`,
        };
      },
    ],
  ] as const)('rejects %s before a GC quarantine can be purged', async (_label, mutate) => {
    const dshHome = await home();
    const txid = 'gc-escaped-valid-quarantine';
    await writeGcQuarantine(dshHome, txid, (journal, action) => mutate(journal, action, dshHome));
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_QUARANTINE_JOURNAL' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it.each(['active', 'rolling-back', 'rollback-failed'] as const)(
    'requires manual recovery for a %s GC quarantine journal',
    async (state) => {
      const dshHome = await home();
      await writeGcQuarantine(dshHome, `gc-${state}-journal`, (journal) => {
        journal.state = state;
      });
      const before = await snapshot(dshHome);

      const result = await runGc({ dshHome, dryRun: false });

      expect(result.exitCode).toBe(25);
      expect(result.metadata.manualRecovery).not.toEqual([]);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'E_GC_QUARANTINE_RECOVERY' }),
      );
      expect(await snapshot(dshHome)).toEqual(before);
    },
  );

  it('rejects an unsafe GC-prefixed quarantine entry before state mutation', async () => {
    const dshHome = await home();
    const path = join(dshHome, '.dshpack', 'backups', 'gc-unsafe-entry');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'not a transaction directory');
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_GC_QUARANTINE_LAYOUT' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('accepts a canonical generation action shape before rejecting its changed quarantine bytes', async () => {
    const dshHome = await home();
    const txid = 'gc-generation-quarantine';
    await writeGcQuarantine(dshHome, txid, (_journal, action) => {
      action.artifact = 'generation';
      action.old = {
        ...(action.old as Record<string, unknown>),
        path: join(dshHome, '.dshpack', 'generations', 'alpha', '0001.json'),
      };
    });
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_QUARANTINE_CHANGED' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('treats an already-purged committed GC payload as a safe no-op', async () => {
    const dshHome = await home();
    const txid = 'gc-already-purged';
    await writeGcQuarantine(dshHome, txid, () => undefined);
    await rm(join(dshHome, '.dshpack', 'backups', txid, 'old', 'action-0001'));
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 0,
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('accepts a retained generation with a fully typed settings contribution entry', async () => {
    const dshHome = await home();
    const path = await writeGeneration(dshHome, 'alpha', 1, []);
    const document = generationDocument('alpha', 1, []);
    document.settingsContribution = {
      namespace: 'agent-presets',
      keys: [
        {
          key: 'completion.temperature',
          valueSha256: sha256(Buffer.from('canonical-setting-value')),
        },
      ],
    };
    await writeFile(path, `${JSON.stringify(document)}\n`);
    await writeFile(join(dirname(path), 'current'), '1\n');
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 0,
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('refuses a hardlinked committed GC quarantine payload before planning mutation', async () => {
    const dshHome = await home();
    const txid = 'gc-hardlinked-payload';
    await writeGcQuarantine(dshHome, txid, () => undefined);
    const payload = join(dshHome, '.dshpack', 'backups', txid, 'old', 'action-0001');
    await link(payload, join(dshHome, 'external-hardlink'));
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_GC_STATE_SECURITY' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it.each([
    [
      'a missing quarantine journal',
      async (dshHome: string, txid: string) => {
        await mkdir(join(dshHome, '.dshpack', 'backups', txid), { recursive: true });
      },
      'E_GC_STATE_MISSING',
    ],
    [
      'an oversized quarantine journal',
      async (dshHome: string, txid: string) => {
        await createSparseFile(
          join(dshHome, '.dshpack', 'backups', txid, 'journal.json'),
          10 * 1024 * 1024 + 1,
        );
      },
      'E_GC_STATE_READ_LIMIT',
    ],
  ] as const)('maps %s before planning mutation', async (_label, setup, code) => {
    const dshHome = await home();
    const txid = 'gc-missing-or-oversized';
    await setup(dshHome, txid);
    const journal = join(dshHome, '.dshpack', 'backups', txid, 'journal.json');
    const before =
      code === 'E_GC_STATE_READ_LIMIT' ? await sparseFingerprint(journal) : await snapshot(dshHome);

    const result = await runGc({ dshHome, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    if (code === 'E_GC_STATE_READ_LIMIT') {
      expect(await sparseFingerprint(journal)).toEqual(before);
    } else {
      expect(await snapshot(dshHome)).toEqual(before);
    }
  });

  it('ignores a non-GC transaction backup during a no-op collection', async () => {
    const dshHome = await home();
    const path = join(dshHome, '.dshpack', 'backups', 'install-prior-transaction');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'journal.json'), 'unrelated transaction journal');
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 0,
      metadata: { deletedGenerations: [], deletedBlocks: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('purges committed obsolete bytes instead of leaving them in the GC quarantine', async () => {
    const dshHome = await home();
    const obsoleteBytes = Buffer.from(
      Array.from({ length: 128 * 1024 }, (_value, index) => String.fromCharCode(index % 251)).join(
        '',
      ),
      'latin1',
    );
    const obsolete = await writeBlock(dshHome, obsoleteBytes);
    const retained = await writeBlock(dshHome, Buffer.from('retained generation'));
    await writeGeneration(dshHome, 'alpha', 1, [obsolete]);
    await writeGeneration(dshHome, 'alpha', 2, [retained]);
    await writeFile(join(dshHome, '.dshpack', 'generations', 'alpha', 'current'), '2\n');
    const beforeBytes = await treeBytes(join(dshHome, '.dshpack'));

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({ exitCode: 0, metadata: { deletedBlocks: [obsolete] } });
    const after = await snapshot(join(dshHome, '.dshpack'));
    expect([...after.values()].some((bytes) => bytes.equals(obsoleteBytes))).toBe(false);
    expect(await treeBytes(join(dshHome, '.dshpack'))).toBeLessThan(beforeBytes);
  });

  it('reports a pending purge without claiming physical reclamation after a committed collection', async () => {
    const dshHome = await home();
    const obsoleteBytes = Buffer.from('obsolete bytes requiring verified post-commit purge');
    const obsolete = await writeBlock(dshHome, obsoleteBytes);
    const retained = await writeBlock(dshHome, Buffer.from('retained generation'));
    await writeGeneration(dshHome, 'alpha', 1, [obsolete]);
    await writeGeneration(dshHome, 'alpha', 2, [retained]);
    await writeFile(join(dshHome, '.dshpack', 'generations', 'alpha', 'current'), '2\n');
    const base = createNodeTransactionAdapter();
    const refusingPurge = {
      ...base,
      async purgeGcQuarantineFile() {
        return false;
      },
    };

    const failed = await runGc(
      { dshHome, keep: 1, dryRun: false },
      { createAdapter: () => refusingPurge },
    );

    expect(failed).toMatchObject({
      exitCode: 0,
      diagnostics: [
        expect.objectContaining({ code: 'E_GC_QUARANTINE_CHANGED', severity: 'warning' }),
      ],
      metadata: {
        deletedGenerations: [join('.dshpack', 'generations', 'alpha', '0001.json')],
        deletedBlocks: [obsolete],
        pendingPurge: true,
        manualRecovery: [],
      },
    });
    expect([...(await snapshot(join(dshHome, '.dshpack'))).values()]).toContainEqual(obsoleteBytes);

    const retried = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(retried).toMatchObject({
      exitCode: 0,
      metadata: { deletedGenerations: [], deletedBlocks: [], pendingPurge: false },
    });
    expect([...(await snapshot(join(dshHome, '.dshpack'))).values()]).not.toContainEqual(
      obsoleteBytes,
    );
  });

  it('reports pending purge success when a no-plan retry removes one payload then stalls', async () => {
    const dshHome = await home();
    const base = await leaveVerifiedGcQuarantine(dshHome);
    let purges = 0;

    const result = await runGc(
      { dshHome, keep: 1, dryRun: false },
      {
        createAdapter: () => ({
          ...base,
          async purgeGcQuarantineFile(lock, path, digest, identity) {
            purges += 1;
            if (purges === 2) return false;
            return base.purgeGcQuarantineFile?.(lock, path, digest, identity) ?? false;
          },
        }),
      },
    );

    expect(purges).toBe(2);
    expect(result).toMatchObject({
      exitCode: 0,
      diagnostics: [
        expect.objectContaining({ code: 'E_GC_QUARANTINE_CHANGED', severity: 'warning' }),
      ],
      metadata: {
        deletedGenerations: [],
        deletedBlocks: [],
        pendingPurge: true,
        manualRecovery: [],
      },
    });
  });

  it('reports pending purge success when an adapter confirms unlink but parent fsync then fails', async () => {
    const dshHome = await home();
    const base = await leaveVerifiedGcQuarantine(dshHome);
    const postUnlinkFailure = new TransactionPhysicalProgressError(
      'parent fsync failed after unlink',
    );

    const result = await runGc(
      { dshHome, keep: 1, dryRun: false },
      {
        createAdapter: () => ({
          ...base,
          async purgeGcQuarantineFile() {
            throw postUnlinkFailure;
          },
        }),
      },
    );

    expect(result).toMatchObject({
      exitCode: 0,
      diagnostics: [
        expect.objectContaining({ code: 'E_GC_QUARANTINE_PURGE', severity: 'warning' }),
      ],
      metadata: {
        deletedGenerations: [],
        deletedBlocks: [],
        pendingPurge: true,
        manualRecovery: [],
      },
    });
  });

  it('recovers an interrupted post-rename GC purge from its verified .purging action slot', async () => {
    const dshHome = await home();
    await leaveVerifiedGcQuarantine(dshHome);
    const backups = join(dshHome, '.dshpack', 'backups');
    const txid = (await readdir(backups)).find((name) => name.startsWith('gc-'));
    if (txid === undefined) throw new Error('fixture GC quarantine is missing');
    const original = join(backups, txid, 'old', 'action-0001');
    const residual = `${original}.purging-123e4567-e89b-12d3-a456-426614174000`;
    await rename(original, residual);

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 0,
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    await expect(readFile(residual)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a non-GC transaction id before a collection can create unscanned quarantine state', async () => {
    const dshHome = await home();
    const obsolete = await writeBlock(dshHome, Buffer.from('non-GC txid obsolete'));
    const retained = await writeBlock(dshHome, Buffer.from('non-GC txid retained'));
    await writeGeneration(dshHome, 'alpha', 1, [obsolete]);
    await writeGeneration(dshHome, 'alpha', 2, [retained]);
    await writeFile(join(dshHome, '.dshpack', 'generations', 'alpha', 'current'), '2\n');
    const before = await snapshot(dshHome);

    const result = await runGc(
      { dshHome, keep: 1, dryRun: false },
      { createTxid: () => 'install-not-a-gc-transaction' },
    );

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_TXID' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('refuses a gc-prefixed generic transaction journal without explicit GC purpose', async () => {
    const dshHome = await home();
    const obsolete = await writeBlock(dshHome, Buffer.from('generic GC-prefix obsolete'));
    const retained = await writeBlock(dshHome, Buffer.from('generic GC-prefix retained'));
    await writeGeneration(dshHome, 'alpha', 1, [obsolete]);
    const current = await writeGeneration(dshHome, 'alpha', 2, [retained]);
    await writeFile(join(dirname(current), 'current'), '2\n');
    const generic = await runTransaction(
      { adapter: createNodeTransactionAdapter(), dshHome, txid: 'gc-generic-without-purpose' },
      async () => undefined,
    );
    expect(generic).toMatchObject({ ok: true, status: 'committed' });
    const before = await snapshotManagedState(dshHome);

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_QUARANTINE_JOURNAL' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshotManagedState(dshHome)).toEqual(before);
  });

  it('rejects an invalid journal batch limit before creating transaction state', async () => {
    const dshHome = await home();
    const obsolete = await writeBlock(dshHome, Buffer.from('invalid journal batch limit obsolete'));
    const retained = await writeBlock(dshHome, Buffer.from('invalid journal batch limit retained'));
    await writeGeneration(dshHome, 'alpha', 1, [obsolete]);
    const current = await writeGeneration(dshHome, 'alpha', 2, [retained]);
    await writeFile(join(dirname(current), 'current'), '2\n');
    const before = await snapshot(dshHome);

    const result = await runGc(
      { dshHome, keep: 1, dryRun: false },
      { maxJournalBytes: 0, createTxid: () => 'gc-invalid-journal-limit' },
    );

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_JOURNAL_LIMIT' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('rejects a journal batch limit above the bounded journal reader before any state write', async () => {
    const dshHome = await home();
    const obsolete = await writeBlock(dshHome, Buffer.from('oversized journal cap obsolete'));
    const retained = await writeBlock(dshHome, Buffer.from('oversized journal cap retained'));
    await writeGeneration(dshHome, 'alpha', 1, [obsolete]);
    const current = await writeGeneration(dshHome, 'alpha', 2, [retained]);
    await writeFile(join(dirname(current), 'current'), '2\n');
    const before = await snapshot(dshHome);

    const result = await runGc(
      { dshHome, keep: 1, dryRun: false },
      { maxJournalBytes: MAX_TRANSACTION_STATE_BYTES + 1 },
    );

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_JOURNAL_LIMIT' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('refuses a single GC action that cannot fit in the bounded journal', async () => {
    const dshHome = await home();
    const obsolete = await writeBlock(dshHome, Buffer.from('too-small journal obsolete'));
    const retained = await writeBlock(dshHome, Buffer.from('too-small journal retained'));
    await writeGeneration(dshHome, 'alpha', 1, [obsolete]);
    const current = await writeGeneration(dshHome, 'alpha', 2, [retained]);
    await writeFile(join(dirname(current), 'current'), '2\n');
    const before = await snapshot(dshHome);

    const result = await runGc(
      { dshHome, keep: 1, dryRun: false },
      { maxJournalBytes: 1, createTxid: () => 'gc-journal-limit-one-action' },
    );

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_JOURNAL_LIMIT' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('rejects a journal budget that fits active state but not every recoverable terminal state', async () => {
    const dshHome = await home();
    const obsolete = await writeBlock(dshHome, Buffer.from('terminal-size obsolete'));
    const retained = await writeBlock(dshHome, Buffer.from('terminal-size retained'));
    await writeGeneration(dshHome, 'alpha', 1, [obsolete]);
    const current = await writeGeneration(dshHome, 'alpha', 2, [retained]);
    await writeFile(join(dirname(current), 'current'), '2\n');
    const before = await snapshot(dshHome);

    const result = await runGc(
      { dshHome, keep: 1, dryRun: false },
      { maxJournalBytes: 1_075, createTxid: () => 'gc-terminal-size-boundary' },
    );

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_JOURNAL_LIMIT' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('refuses a committed GC journal whose declared root does not canonically bind to this home', async () => {
    const dshHome = await home();
    const other = await home();
    await writeGcQuarantine(dshHome, 'gc-wrong-journal-root', (journal, action) => {
      journal.dshHome = other;
      journal.backupDirectory = join(other, '.dshpack', 'backups', 'gc-wrong-journal-root');
      const digest = String((action.old as Record<string, unknown>).contentSha256);
      action.old = {
        ...(action.old as Record<string, unknown>),
        path: join(other, '.dshpack', 'store', casStoreShard(digest), digest),
      };
      action.new = {
        ...(action.new as Record<string, unknown>),
        preservedAt: join(
          other,
          '.dshpack',
          'backups',
          'gc-wrong-journal-root',
          'old',
          'action-0001',
        ),
      };
    });
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_GC_QUARANTINE_SCOPE' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it.each([
    ['/alias/long-dsh-home', '/alias/short-dsh-home'],
    ['/alias/short-dsh-home', '/alias/long-dsh-home'],
  ])(
    'accepts bidirectional long/short journal root aliases through canonical bindings: %s -> %s',
    async (homeAlias, backupAlias) => {
      const dshHome = await home();
      const txid = `gc-alias-${homeAlias.includes('long') ? 'long' : 'short'}`;
      await writeGcQuarantine(dshHome, txid, (journal, action) => {
        const digest = String((action.old as Record<string, unknown>).contentSha256);
        journal.dshHome = homeAlias;
        journal.backupDirectory = join(backupAlias, '.dshpack', 'backups', txid);
        action.old = {
          ...(action.old as Record<string, unknown>),
          path: join(homeAlias, '.dshpack', 'store', casStoreShard(digest), digest),
        };
        action.new = {
          ...(action.new as Record<string, unknown>),
          preservedAt: join(backupAlias, '.dshpack', 'backups', txid, 'old', 'action-0001'),
        };
      });
      const homeBinding = await bindSecureRoot(dshHome);
      const backupBinding = await bindSecureRoot(join(dshHome, '.dshpack', 'backups', txid));
      if (!homeBinding.ok || !backupBinding.ok) throw new Error('alias fixture root failed');
      const aliases = new Map([
        [homeAlias, homeBinding.value],
        [join(backupAlias, '.dshpack', 'backups', txid), backupBinding.value],
      ]);
      const bindRoot: typeof bindSecureRoot = async (path, hooks) => {
        const bound = aliases.get(path);
        return bound === undefined
          ? bindSecureRoot(path, hooks)
          : { ok: true, value: { ...bound, rootPath: path } };
      };

      const result = await runGc({ dshHome, keep: 1, dryRun: false }, { bindRoot });

      // The constructed payload has a deliberately stale identity.  Reaching this contract
      // failure proves that canonical alias binding passed; a lexical root comparison rejects
      // the fixture earlier with E_GC_QUARANTINE_SCOPE.
      expect(result).toMatchObject({
        exitCode: 30,
        diagnostics: [expect.objectContaining({ code: 'E_GC_QUARANTINE_CHANGED' })],
        metadata: { manualRecovery: [] },
      });
    },
  );

  it('rejects a journal alias whose injected canonical root is different', async () => {
    const dshHome = await home();
    const txid = 'gc-alias-mismatch';
    const homeAlias = '/alias/not-this-home';
    await writeGcQuarantine(dshHome, txid, (journal, action) => {
      const digest = String((action.old as Record<string, unknown>).contentSha256);
      journal.dshHome = homeAlias;
      action.old = {
        ...(action.old as Record<string, unknown>),
        path: join(homeAlias, '.dshpack', 'store', casStoreShard(digest), digest),
      };
    });
    const homeBinding = await bindSecureRoot(dshHome);
    if (!homeBinding.ok) throw new Error('alias mismatch fixture root failed');
    const bindRoot: typeof bindSecureRoot = async (path, hooks) =>
      path === homeAlias
        ? {
            ok: true,
            value: { ...homeBinding.value, rootPath: path, rootCanonical: '/canonical/other-home' },
          }
        : bindSecureRoot(path, hooks);

    const result = await runGc({ dshHome, keep: 1, dryRun: false }, { bindRoot });

    expect(result).toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_GC_QUARANTINE_SCOPE' })],
      metadata: { manualRecovery: [] },
    });
  });

  it('rejects invalid UTF-8 in a committed GC journal before any active collection', async () => {
    const dshHome = await home();
    const txid = 'gc-invalid-utf8-journal';
    const journal = join(dshHome, '.dshpack', 'backups', txid, 'journal.json');
    await mkdir(dirname(journal), { recursive: true });
    await writeFile(journal, Buffer.from([0xff, 0xfe]));
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_QUARANTINE_JOURNAL' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('rejects an orphaned payload under a journal marked cleanly rolled back', async () => {
    const dshHome = await home();
    await writeGcQuarantine(dshHome, 'gc-rolled-back-with-payload', (journal) => {
      journal.state = 'rolled-back';
    });
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_QUARANTINE_JOURNAL' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('handles a current generation without a store directory as an empty, no-op CAS set', async () => {
    const dshHome = await home();
    const generation = await writeGeneration(dshHome, 'alpha', 1, []);
    await writeFile(join(dirname(generation), 'current'), '1\n');

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 0,
      diagnostics: [],
      metadata: { deletedGenerations: [], deletedBlocks: [], pendingPurge: false },
    });
  });

  it('reports manual recovery when verified quarantine removal loses its artifact lock on release', async () => {
    const dshHome = await home();
    const base = await leaveVerifiedGcQuarantine(dshHome);

    const result = await runGc(
      { dshHome, keep: 1, dryRun: false },
      {
        createAdapter: () => ({
          ...base,
          async acquireArtifactLock(path) {
            const lock = await base.acquireArtifactLock(path);
            return {
              ...lock,
              async release() {
                await lock.release();
                throw new Error('injected GC artifact lock release failure');
              },
            };
          },
        }),
      },
    );

    expect(result).toMatchObject({
      exitCode: 25,
      diagnostics: [expect.objectContaining({ code: 'E_GC_QUARANTINE_LOCK_RELEASE' })],
    });
    expect(result.metadata.manualRecovery).not.toEqual([]);
  });

  it('ignores a cleanly rolled-back GC transaction before collecting a later valid plan', async () => {
    const dshHome = await home();
    const obsolete = await writeBlock(dshHome, Buffer.from('clean rollback obsolete'));
    const retained = await writeBlock(dshHome, Buffer.from('clean rollback retained'));
    await writeGeneration(dshHome, 'alpha', 1, [obsolete]);
    await writeGeneration(dshHome, 'alpha', 2, [retained]);
    await writeFile(join(dshHome, '.dshpack', 'generations', 'alpha', 'current'), '2\n');
    const base = createNodeTransactionAdapter();

    const failed = await runGc(
      { dshHome, keep: 1, dryRun: false },
      {
        createAdapter: () => ({
          ...base,
          async moveArtifactPath() {
            return false;
          },
        }),
        createTxid: () => 'gc-clean-rollback',
      },
    );
    expect(failed).toMatchObject({ exitCode: 30, metadata: { manualRecovery: [] } });

    const retried = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(retried).toMatchObject({
      exitCode: 0,
      metadata: {
        deletedGenerations: [join('.dshpack', 'generations', 'alpha', '0001.json')],
        deletedBlocks: [obsolete],
        manualRecovery: [],
      },
    });
  });

  it('fails closed when a transaction adapter cannot purge a verified GC quarantine', async () => {
    const dshHome = await home();
    const base = await leaveVerifiedGcQuarantine(dshHome);
    const { purgeGcQuarantineFile: _unsupportedPurge, ...withoutPurge } = base;
    const before = await snapshot(dshHome);

    const result = await runGc(
      { dshHome, keep: 1, dryRun: false },
      { createAdapter: () => withoutPurge },
    );

    expect(result).toMatchObject({
      exitCode: 70,
      diagnostics: [expect.objectContaining({ code: 'E_GC_QUARANTINE_PURGE' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it.each([
    [
      'a bounded-read limit error',
      new TransactionStateReadLimitError('quarantine-payload', 129),
      30,
      'E_GC_STATE_READ_LIMIT',
    ],
    [
      'a bounded-read security error',
      new TransactionStateReadSecurityError('quarantine-payload', 'changed'),
      31,
      'E_GC_STATE_SECURITY',
    ],
  ] as const)(
    'preserves %s from a verified quarantine purge',
    async (_label, error, exitCode, code) => {
      const dshHome = await home();
      const base = await leaveVerifiedGcQuarantine(dshHome);
      const before = await snapshot(dshHome);

      const result = await runGc(
        { dshHome, keep: 1, dryRun: false },
        {
          createAdapter: () => ({
            ...base,
            async purgeGcQuarantineFile() {
              throw error;
            },
          }),
        },
      );

      expect(result).toMatchObject({
        exitCode,
        diagnostics: [expect.objectContaining({ code })],
        metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
      });
      expect(await snapshot(dshHome)).toEqual(before);
    },
  );

  it('refuses a changed committed GC quarantine before planning another collection', async () => {
    const dshHome = await home();
    const obsolete = await writeBlock(dshHome, Buffer.from('quarantine source bytes'));
    const retained = await writeBlock(dshHome, Buffer.from('retained generation'));
    await writeGeneration(dshHome, 'alpha', 1, [obsolete]);
    await writeGeneration(dshHome, 'alpha', 2, [retained]);
    await writeFile(join(dshHome, '.dshpack', 'generations', 'alpha', 'current'), '2\n');
    const base = createNodeTransactionAdapter();
    const first = await runGc(
      { dshHome, keep: 1, dryRun: false },
      { createAdapter: () => ({ ...base, purgeGcQuarantineFile: async () => false }) },
    );
    expect(first).toMatchObject({ exitCode: 0, metadata: { pendingPurge: true } });
    const backups = join(dshHome, '.dshpack', 'backups');
    const txid = (await readdir(backups)).find((name) => name.startsWith('gc-'));
    if (txid === undefined) throw new Error('fixture GC quarantine was not created');
    const old = join(backups, txid, 'old');
    const payload = (await readdir(old))[0];
    if (payload === undefined) throw new Error('fixture GC quarantine payload is missing');
    await writeFile(join(old, payload), 'tampered quarantine payload');
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_QUARANTINE_CHANGED' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('refuses an equal-byte GC quarantine payload whose identity was replaced', async () => {
    const dshHome = await home();
    const obsolete = await writeBlock(dshHome, Buffer.from('identity-protected quarantine source'));
    const retained = await writeBlock(dshHome, Buffer.from('retained generation'));
    await writeGeneration(dshHome, 'alpha', 1, [obsolete]);
    await writeGeneration(dshHome, 'alpha', 2, [retained]);
    await writeFile(join(dshHome, '.dshpack', 'generations', 'alpha', 'current'), '2\n');
    const base = createNodeTransactionAdapter();
    const first = await runGc(
      { dshHome, keep: 1, dryRun: false },
      { createAdapter: () => ({ ...base, purgeGcQuarantineFile: async () => false }) },
    );
    expect(first).toMatchObject({ exitCode: 0, metadata: { pendingPurge: true } });
    const backups = join(dshHome, '.dshpack', 'backups');
    const txid = (await readdir(backups)).find((name) => name.startsWith('gc-'));
    if (txid === undefined) throw new Error('fixture GC quarantine was not created');
    const old = join(backups, txid, 'old');
    const payload = (await readdir(old))[0];
    if (payload === undefined) throw new Error('fixture GC quarantine payload is missing');
    const path = join(old, payload);
    const original = await readFile(path);
    const originalIdentity = (await fingerprint(path)).identity;
    await rename(path, join(dshHome, 'external-equal-byte-payload'));
    await writeFile(path, original);
    expect((await fingerprint(path)).identity).not.toBe(originalIdentity);
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_QUARANTINE_CHANGED' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('does not create a transaction journal for repeated successful no-op GC runs', async () => {
    const dshHome = await home();
    const before = await snapshot(dshHome);

    const first = await runGc({ dshHome, dryRun: false });
    const afterFirst = await snapshot(dshHome);
    const second = await runGc({ dshHome, dryRun: false });

    expect(first).toMatchObject({
      exitCode: 0,
      metadata: { deletedGenerations: [], deletedBlocks: [] },
    });
    expect(second).toMatchObject({
      exitCode: 0,
      metadata: { deletedGenerations: [], deletedBlocks: [] },
    });
    expect(afterFirst).toEqual(before);
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('keeps the newest requested generations and every current target, then prunes only unreferenced CAS blocks', async () => {
    const dshHome = await home();
    const old = await writeBlock(dshHome, Buffer.from('old generation'));
    const shared = await writeBlock(dshHome, Buffer.from('shared generation'));
    const newest = await writeBlock(dshHome, Buffer.from('newest generation'));
    const orphan = await writeBlock(dshHome, Buffer.from('orphan'));
    const oldGeneration = await writeGeneration(dshHome, 'alpha', 1, [old]);
    await writeGeneration(dshHome, 'alpha', 2, [shared]);
    await writeGeneration(dshHome, 'alpha', 3, [newest]);
    await writeFile(join(dshHome, '.dshpack', 'generations', 'alpha', 'current'), '2\n');
    await writeGeneration(dshHome, 'beta', 1, [shared]);
    await writeFile(join(dshHome, '.dshpack', 'generations', 'beta', 'current'), '1\n');

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 0,
      diagnostics: [],
      metadata: {
        dryRun: false,
        keep: 1,
        deletedGenerations: [join('.dshpack', 'generations', 'alpha', '0001.json')],
        deletedBlocks: expect.arrayContaining([old, orphan]),
      },
    });
    await expect(lstat(oldGeneration)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(join(dshHome, '.dshpack', 'generations', 'alpha', '0002.json')),
    ).resolves.toBeDefined();
    await expect(
      readFile(join(dshHome, '.dshpack', 'generations', 'alpha', '0003.json')),
    ).resolves.toBeDefined();
    expect(
      await readFile(join(dshHome, '.dshpack', 'generations', 'alpha', 'current'), 'utf8'),
    ).toBe('2\n');
    await expect(
      readFile(join(dshHome, '.dshpack', 'store', casStoreShard(old), old)),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      readFile(join(dshHome, '.dshpack', 'store', casStoreShard(orphan), orphan)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(join(dshHome, '.dshpack', 'store', casStoreShard(shared), shared)),
    ).resolves.toBeDefined();
    await expect(
      readFile(join(dshHome, '.dshpack', 'store', casStoreShard(newest), newest)),
    ).resolves.toBeDefined();
  });

  it('handles dB and DB CAS digests in the same lowercase portable shard without a layout collision', async () => {
    const dshHome = await home();
    const lower = Buffer.from('case-shard-1235');
    const upper = Buffer.from('case-shard-3014');
    const lowerDigest = sha256(lower);
    const upperDigest = sha256(upper);
    expect(lowerDigest.slice(7, 9)).toBe('DB');
    expect(upperDigest.slice(7, 9)).toBe('dB');
    expect(casStoreShard(lowerDigest)).toBe('db');
    expect(casStoreShard(upperDigest)).toBe('db');
    const shard = 'db';
    const lowerPath = join(dshHome, '.dshpack', 'store', shard, lowerDigest);
    const upperPath = join(dshHome, '.dshpack', 'store', shard, upperDigest);
    await mkdir(dirname(lowerPath), { recursive: true });
    await writeFile(lowerPath, lower);
    await writeFile(upperPath, upper);
    await writeGeneration(dshHome, 'alpha', 1, [lowerDigest]);
    const retained = await writeGeneration(dshHome, 'alpha', 2, [upperDigest]);
    await writeFile(join(dirname(retained), 'current'), '2\n');

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 0,
      metadata: { deletedBlocks: [lowerDigest], manualRecovery: [] },
    });
    await expect(readFile(lowerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(upperPath)).resolves.toEqual(upper);
  });

  it('rejects an uppercase-only CAS shard before treating a restorable generation as available', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('case-shard-3014');
    const digest = sha256(bytes);
    expect(digest.slice(7, 9)).toBe('dB');
    const path = join(dshHome, '.dshpack', 'store', 'DB', digest);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const generation = await writeGeneration(dshHome, 'alpha', 1, [digest]);
    await writeFile(join(dirname(generation), 'current'), '1\n');
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_GC_STORE_LAYOUT' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('rejects DB and db shard spellings instead of accepting a Windows collision', () => {
    const canonical = Buffer.from('case-shard-1235');
    const noncanonical = Buffer.from('case-shard-3014');
    const canonicalDigest = sha256(canonical);
    const noncanonicalDigest = sha256(noncanonical);
    expect(casStoreShard(canonicalDigest)).toBe('db');
    expect(casStoreShard(noncanonicalDigest)).toBe('db');
    expect(isCanonicalCasStoreShard('db', canonicalDigest)).toBe(true);
    expect(isCanonicalCasStoreShard('db', noncanonicalDigest)).toBe(true);
    expect(isCanonicalCasStoreShard('DB', canonicalDigest)).toBe(false);
    expect(isCanonicalCasStoreShard('DB', noncanonicalDigest)).toBe(false);
  });

  it('makes no write in dry-run mode', async () => {
    const dshHome = await home();
    const old = await writeBlock(dshHome, Buffer.from('old generation'));
    await writeGeneration(dshHome, 'alpha', 1, [old]);
    await writeGeneration(dshHome, 'alpha', 2, []);
    await writeFile(join(dshHome, '.dshpack', 'generations', 'alpha', 'current'), '2\n');
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, keep: 1, dryRun: true });

    expect(result).toMatchObject({
      exitCode: 0,
      diagnostics: [],
      metadata: {
        dryRun: true,
        deletedGenerations: [join('.dshpack', 'generations', 'alpha', '0001.json')],
        deletedBlocks: [old],
      },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('never deletes the generation named by current even when keep is zero', async () => {
    const dshHome = await home();
    const currentBlock = await writeBlock(dshHome, Buffer.from('current generation'));
    const disposableBlock = await writeBlock(dshHome, Buffer.from('disposable generation'));
    const currentGeneration = await writeGeneration(dshHome, 'alpha', 1, [currentBlock]);
    const disposableGeneration = await writeGeneration(dshHome, 'alpha', 2, [disposableBlock]);
    await writeFile(join(dshHome, '.dshpack', 'generations', 'alpha', 'current'), '1\n');

    const result = await runGc({ dshHome, keep: 0, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 0,
      metadata: {
        keep: 0,
        deletedGenerations: [join('.dshpack', 'generations', 'alpha', '0002.json')],
        deletedBlocks: [disposableBlock],
      },
    });
    await expect(readFile(currentGeneration)).resolves.toBeDefined();
    await expect(lstat(disposableGeneration)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(join(dshHome, '.dshpack', 'store', casStoreShard(currentBlock), currentBlock)),
    ).resolves.toBeDefined();
  });

  it('batches generations before CAS blocks and converges without an unreadable journal', async () => {
    const dshHome = await home();
    const first = await writeBlock(dshHome, Buffer.from('batch-first'));
    const second = await writeBlock(dshHome, Buffer.from('batch-second'));
    const retained = await writeBlock(dshHome, Buffer.from('batch-retained'));
    const firstGeneration = await writeGeneration(dshHome, 'alpha', 1, [first]);
    const secondGeneration = await writeGeneration(dshHome, 'alpha', 2, [second]);
    const currentGeneration = await writeGeneration(dshHome, 'alpha', 3, [retained]);
    await writeFile(join(dirname(currentGeneration), 'current'), '3\n');
    const firstBlock = join(dshHome, '.dshpack', 'store', casStoreShard(first), first);
    const secondBlock = join(dshHome, '.dshpack', 'store', casStoreShard(second), second);
    const dependencies = { maxJournalBytes: 1_500, createTxid: () => 'gc-batched-fixture' };

    const firstRun = await runGc({ dshHome, keep: 1, dryRun: false }, dependencies);
    expect(firstRun).toMatchObject({
      exitCode: 0,
      metadata: { deletedGenerations: [join('.dshpack', 'generations', 'alpha', '0001.json')] },
    });
    const committedJournal = await readFile(
      join(dshHome, '.dshpack', 'backups', 'gc-batched-fixture', 'journal.json'),
    );
    expect(committedJournal.byteLength).toBeLessThanOrEqual(1_500);
    await expect(readFile(firstGeneration)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(secondGeneration)).resolves.toBeDefined();
    // The still-existing second obsolete generation means its distinct block and every other
    // candidate remains live until a later rescan.
    await expect(readFile(firstBlock)).resolves.toBeDefined();
    await expect(readFile(secondBlock)).resolves.toBeDefined();

    const secondRun = await runGc(
      { dshHome, keep: 1, dryRun: false },
      { ...dependencies, createTxid: () => 'gc-batched-fixture-2' },
    );
    expect(secondRun).toMatchObject({
      exitCode: 0,
      metadata: { deletedGenerations: [join('.dshpack', 'generations', 'alpha', '0002.json')] },
    });
    await expect(readFile(secondGeneration)).rejects.toMatchObject({ code: 'ENOENT' });

    for (let index = 0; index < 4; index += 1) {
      const result = await runGc(
        { dshHome, keep: 1, dryRun: false },
        { ...dependencies, createTxid: () => `gc-batched-fixture-block-${String(index)}` },
      );
      expect(result.exitCode).toBe(0);
    }
    await expect(readFile(firstBlock)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(secondBlock)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(currentGeneration)).resolves.toBeDefined();
  });

  it('rejects a collection plan that changes while the transaction lease is held', async () => {
    const dshHome = await home();
    const old = await writeBlock(dshHome, Buffer.from('old generation'));
    const current = await writeBlock(dshHome, Buffer.from('current generation'));
    const oldGeneration = await writeGeneration(dshHome, 'alpha', 1, [old]);
    await writeGeneration(dshHome, 'alpha', 2, [current]);
    const currentPath = join(dshHome, '.dshpack', 'generations', 'alpha', 'current');
    await writeFile(currentPath, '2\n');

    const result = await runGc(
      { dshHome, keep: 1, dryRun: false },
      {
        onBeforeLockedScan: async () => {
          await writeFile(currentPath, '1\n');
        },
      },
    );

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_STATE_CHANGED' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    await expect(readFile(oldGeneration)).resolves.toBeDefined();
    expect(await readFile(currentPath, 'utf8')).toBe('1\n');
  });

  it('rejects a malformed obsolete generation before deleting any generation or CAS block', async () => {
    const dshHome = await home();
    const old = await writeBlock(dshHome, Buffer.from('old generation'));
    const current = await writeBlock(dshHome, Buffer.from('current generation'));
    const oldGeneration = await writeGeneration(dshHome, 'alpha', 1, [old]);
    await writeGeneration(dshHome, 'alpha', 2, [current]);
    await writeFile(oldGeneration, '{"seq":1}\n');
    await writeFile(join(dshHome, '.dshpack', 'generations', 'alpha', 'current'), '2\n');
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_GENERATION_DOCUMENT' })],
      metadata: { deletedGenerations: [], deletedBlocks: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('rejects a corrupt CAS block before applying an otherwise valid collection plan', async () => {
    const dshHome = await home();
    const live = await writeBlock(dshHome, Buffer.from('live generation'));
    const orphan = await writeBlock(dshHome, Buffer.from('orphan generation'));
    await writeGeneration(dshHome, 'alpha', 1, [live]);
    await writeFile(join(dshHome, '.dshpack', 'generations', 'alpha', 'current'), '1\n');
    await writeFile(join(dshHome, '.dshpack', 'store', casStoreShard(orphan), orphan), 'corrupt');
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_STORE_DIGEST' })],
      metadata: { deletedGenerations: [], deletedBlocks: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('rejects a hardlinked CAS block before applying a collection plan', async () => {
    const dshHome = await home();
    const block = await writeBlock(dshHome, Buffer.from('hardlinked block'));
    await writeGeneration(dshHome, 'alpha', 1, [block]);
    await writeFile(join(dshHome, '.dshpack', 'generations', 'alpha', 'current'), '1\n');
    const path = join(dshHome, '.dshpack', 'store', casStoreShard(block), block);
    const source = join(dshHome, 'external-hardlink-source');
    await writeFile(source, 'hardlinked block');
    await rm(path);
    await link(source, path);
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_GC_STATE_SECURITY' })],
      metadata: { deletedGenerations: [], deletedBlocks: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an unsafe keep value without writing state: %j',
    async (keep) => {
      const dshHome = await home();
      const before = await snapshot(dshHome);

      const result = await runGc({ dshHome, keep, dryRun: false });

      expect(result).toMatchObject({
        exitCode: 30,
        diagnostics: [expect.objectContaining({ code: 'E_GC_KEEP' })],
        metadata: { deletedGenerations: [], deletedBlocks: [] },
      });
      expect(await snapshot(dshHome)).toEqual(before);
    },
  );

  it('uses the default keep value and accepts an empty state root in dry-run mode', async () => {
    const dshHome = await home();

    const result = await runGc({ dshHome, dryRun: true });

    expect(result).toMatchObject({
      exitCode: 0,
      metadata: {
        dryRun: true,
        keep: 10,
        deletedGenerations: [],
        deletedBlocks: [],
        manualRecovery: [],
      },
    });
  });

  it.each([
    ['non-UTF-8 bytes', () => Buffer.from([0xff])],
    ['invalid JSON', () => '{not json}\n'],
    ['mismatched sequence', (document: Record<string, unknown>) => ({ ...document, seq: 2 })],
    [
      'invalid operation',
      (document: Record<string, unknown>) => ({ ...document, operation: 'collect' }),
    ],
    [
      'invalid pack digest',
      (document: Record<string, unknown>) => ({
        ...document,
        pack: { ...(document.pack as Record<string, unknown>), manifestDigest: 'sha256-invalid' },
      }),
    ],
    [
      'invalid settings key',
      (document: Record<string, unknown>) => ({
        ...document,
        settingsContribution: {
          namespace: 'agent-presets',
          keys: [{ key: 7, valueSha256: sha256(Buffer.from('value')) }],
        },
      }),
    ],
    [
      'a non-agent-presets settings namespace',
      (document: Record<string, unknown>) => ({
        ...document,
        settingsContribution: {
          namespace: 'other-settings',
          keys: [],
        },
      }),
    ],
    [
      'entries is not an array',
      (document: Record<string, unknown>) => ({
        ...document,
        entries: {},
      }),
    ],
    [
      'unsafe entry target',
      (document: Record<string, unknown>) => ({
        ...document,
        entries: [{ target: '../outside', sha256: sha256(Buffer.from('entry')) }],
      }),
    ],
    [
      'a Windows device entry target',
      (document: Record<string, unknown>) => ({
        ...document,
        entries: [{ target: 'profiles/alpha/CON', sha256: sha256(Buffer.from('entry')) }],
      }),
    ],
    [
      'case-colliding entry targets',
      (document: Record<string, unknown>) => ({
        ...document,
        entries: [
          { target: 'profiles/alpha/File', sha256: sha256(Buffer.from('entry')) },
          { target: 'profiles/alpha/file', sha256: sha256(Buffer.from('entry')) },
        ],
      }),
    ],
    [
      'duplicate entry target',
      (document: Record<string, unknown>) => {
        const entry = { target: 'profiles/alpha/entry', sha256: sha256(Buffer.from('entry')) };
        return { ...document, entries: [entry, entry] };
      },
    ],
  ] as const)(
    'rejects a generation document with %s before making a collection plan',
    async (_label, mutate) => {
      const dshHome = await home();
      const path = await writeGeneration(dshHome, 'alpha', 1, []);
      const document = generationDocument('alpha', 1, []);
      const value = mutate(document);
      await writeFile(
        path,
        Buffer.isBuffer(value)
          ? value
          : typeof value === 'string'
            ? value
            : `${JSON.stringify(value)}\n`,
      );
      await writeFile(join(dirname(path), 'current'), '1\n');
      const before = await snapshot(dshHome);

      const result = await runGc({ dshHome, keep: 1, dryRun: false });

      expect(result).toMatchObject({
        exitCode: 30,
        diagnostics: [expect.objectContaining({ code: 'E_GC_GENERATION_DOCUMENT' })],
        metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
      });
      expect(await snapshot(dshHome)).toEqual(before);
    },
  );

  it.each([
    [
      'an empty generation profile without a current pointer',
      async (dshHome: string) => {
        await mkdir(join(dshHome, '.dshpack', 'generations', 'alpha'), { recursive: true });
      },
      0,
      undefined,
    ],
    [
      'current in a profile with no generation documents',
      async (dshHome: string) => {
        const directory = join(dshHome, '.dshpack', 'generations', 'alpha');
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'current'), '1\n');
      },
      30,
      'E_GC_CURRENT',
    ],
    [
      'missing current',
      async (dshHome: string) => writeGeneration(dshHome, 'alpha', 1, []),
      30,
      'E_GC_CURRENT',
    ],
    [
      'current that names no generation',
      async (dshHome: string) => {
        const path = await writeGeneration(dshHome, 'alpha', 1, []);
        await writeFile(join(dirname(path), 'current'), '2\n');
      },
      30,
      'E_GC_CURRENT',
    ],
    [
      'invalid current syntax',
      async (dshHome: string) => {
        const path = await writeGeneration(dshHome, 'alpha', 1, []);
        await writeFile(join(dirname(path), 'current'), 'zero\n');
      },
      30,
      'E_GC_CURRENT',
    ],
    [
      'out-of-range current',
      async (dshHome: string) => {
        const path = await writeGeneration(dshHome, 'alpha', 1, []);
        await writeFile(join(dirname(path), 'current'), '9007199254740992\n');
      },
      30,
      'E_GC_CURRENT',
    ],
  ] as const)('handles %s without modifying state', async (_label, setup, exitCode, code) => {
    const dshHome = await home();
    await setup(dshHome);
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode,
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    if (code !== undefined)
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
    else expect(result.diagnostics).toEqual([]);
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it.each([
    [
      'a non-directory generation profile entry',
      async (dshHome: string) => {
        const path = join(dshHome, '.dshpack', 'generations', 'not-a-profile');
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, 'unsafe');
      },
      'E_GC_GENERATION_LAYOUT',
    ],
    [
      'a reserved generation profile',
      async (dshHome: string) => {
        await mkdir(join(dshHome, '.dshpack', 'generations', 'web'), { recursive: true });
      },
      'E_GC_PROFILE',
    ],
    [
      'a noncanonical generation filename',
      async (dshHome: string) => {
        const path = join(dshHome, '.dshpack', 'generations', 'alpha', '1.json');
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, '{}');
      },
      'E_GC_GENERATION_LAYOUT',
    ],
    [
      'a non-directory store prefix',
      async (dshHome: string) => {
        const path = join(dshHome, '.dshpack', 'store', 'bad');
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, 'unsafe');
      },
      'E_GC_STORE_LAYOUT',
    ],
    [
      'a block with an invalid digest name',
      async (dshHome: string) => {
        const path = join(dshHome, '.dshpack', 'store', 'ab', 'not-a-digest');
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, 'unsafe');
      },
      'E_GC_STORE_LAYOUT',
    ],
  ] as const)('rejects %s before mutations', async (_label, setup, code) => {
    const dshHome = await home();
    await setup(dshHome);
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('rejects a retained generation that references a missing CAS block', async () => {
    const dshHome = await home();
    const missing = sha256(Buffer.from('missing block'));
    const path = await writeGeneration(dshHome, 'alpha', 1, [missing]);
    await writeFile(join(dirname(path), 'current'), '1\n');
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_STORE_MISSING' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it.each([
    ['a non-generation filename', 'not-a-generation'],
    ['a zero generation filename', '0000.json'],
  ] as const)('rejects %s without applying a plan', async (_label, name) => {
    const dshHome = await home();
    const path = join(dshHome, '.dshpack', 'generations', 'alpha', name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{}');
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_GC_GENERATION_LAYOUT' })],
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it.each([
    ['an empty entry target', ''],
    ['an absolute entry target', '/outside'],
    ['a backslash entry target', 'profiles\\alpha\\entry'],
  ] as const)('rejects %s in a generation document', async (_label, target) => {
    const dshHome = await home();
    const path = await writeGeneration(dshHome, 'alpha', 1, []);
    await writeFile(
      path,
      `${JSON.stringify({
        ...generationDocument('alpha', 1, []),
        entries: [{ target, sha256: sha256(Buffer.from('entry')) }],
      })}\n`,
    );
    await writeFile(join(dirname(path), 'current'), '1\n');

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_GENERATION_DOCUMENT' })],
    });
  });

  it('rejects a non-record generation entry before a collection plan is made', async () => {
    const dshHome = await home();
    const path = await writeGeneration(dshHome, 'alpha', 1, []);
    await writeFile(
      path,
      `${JSON.stringify({ ...generationDocument('alpha', 1, []), entries: [null] })}\n`,
    );
    await writeFile(join(dirname(path), 'current'), '1\n');
    const before = await snapshot(dshHome);

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_GENERATION_DOCUMENT' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it.each([
    ['a non-file current pointer', async (path: string) => mkdir(path), 'E_GC_CURRENT'],
    [
      'a hardlinked current pointer',
      async (path: string) => {
        const source = `${path}.source`;
        await writeFile(source, '1\n');
        await link(source, path);
      },
      'E_GC_STATE_SECURITY',
    ],
  ] as const)('rejects %s as unsafe', async (_label, writeCurrent, code) => {
    const dshHome = await home();
    const generation = await writeGeneration(dshHome, 'alpha', 1, []);
    await writeCurrent(join(dirname(generation), 'current'));

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code })],
    });
  });

  it('rejects an unsafe DSH_HOME and malformed root input before making a plan', async () => {
    const dshHome = await home();
    const notDirectory = join(dshHome, 'not-a-directory');
    await writeFile(notDirectory, 'file');

    const unsafe = await runGc({ dshHome: notDirectory, keep: 1, dryRun: false });
    const malformed = await runGc({ dshHome: 'relative-path', dryRun: true });

    expect(unsafe).toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_GC_DSH_HOME' })],
    });
    expect(malformed).toMatchObject({ exitCode: 31, metadata: { keep: 10 } });
  });

  it('rolls back GC deletions if a later state deletion fails under the transaction lease', async () => {
    const dshHome = await home();
    const obsolete = await writeBlock(dshHome, Buffer.from('obsolete generation'));
    const retained = await writeBlock(dshHome, Buffer.from('retained generation'));
    const obsoleteGeneration = await writeGeneration(dshHome, 'alpha', 1, [obsolete]);
    await writeGeneration(dshHome, 'alpha', 2, [retained]);
    await writeFile(join(dshHome, '.dshpack', 'generations', 'alpha', 'current'), '2\n');
    const before = await snapshotManagedState(dshHome);
    const base = createNodeTransactionAdapter();
    let deletions = 0;

    const result = await runGc(
      { dshHome, keep: 1, dryRun: false },
      {
        createAdapter: () => ({
          ...base,
          async moveArtifactPath(lock, kind, from, to, direction, expectedIdentity, condition) {
            if (direction === 'to-backup' && ++deletions === 2) return false;
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
        }),
      },
    );

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_TRANSACTION_STATE_CHANGED' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await snapshotManagedState(dshHome)).toEqual(before);
    await expect(readFile(obsoleteGeneration)).resolves.toBeDefined();
  });

  it('rejects a generation directory entry-set change during the locked scan before deletion', async () => {
    const dshHome = await home();
    const obsolete = await writeBlock(dshHome, Buffer.from('entry-set obsolete'));
    const retained = await writeBlock(dshHome, Buffer.from('entry-set retained'));
    await writeGeneration(dshHome, 'alpha', 1, [obsolete]);
    const current = await writeGeneration(dshHome, 'alpha', 2, [retained]);
    const profileDirectory = dirname(current);
    await writeFile(join(profileDirectory, 'current'), '2\n');
    const before = await snapshotManagedState(dshHome);
    let locked = false;
    let injected = false;

    const result = await runGc(
      { dshHome, keep: 1, dryRun: false },
      {
        onBeforeLockedScan: async () => {
          locked = true;
        },
        safePathHooks: {
          afterDirectorySnapshot: async (binding) => {
            const path = binding.entries.at(-1)?.path;
            if (!locked || injected || path !== profileDirectory) return;
            injected = true;
            await writeFile(join(profileDirectory, '0003.json'), '{"malformed":true}\n');
          },
        },
      },
    );

    expect(injected).toBe(true);
    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_STATE_CHANGED' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    const after = await snapshotManagedState(dshHome);
    for (const [path, bytes] of before) expect(after.get(path)).toEqual(bytes);
    expect([...after.keys()].some((path) => path.startsWith('.dshpack/backups/'))).toBe(false);
  });

  it('rejects an in-place current-pointer change after its file snapshot before deleting the new current', async () => {
    const dshHome = await home();
    const first = await writeGeneration(dshHome, 'alpha', 1, []);
    const second = await writeGeneration(dshHome, 'alpha', 2, []);
    const block = await writeBlock(dshHome, Buffer.from('current snapshot mutation ordering'));
    const current = join(dirname(second), 'current');
    const storePrefix = dirname(join(dshHome, '.dshpack', 'store', casStoreShard(block), block));
    await writeFile(current, '2\n');
    const before = await snapshotManagedState(dshHome);
    let locked = false;
    let injected = false;

    const result = await runGc(
      { dshHome, keep: 0, dryRun: false },
      {
        onBeforeLockedScan: async () => {
          locked = true;
        },
        safePathHooks: {
          afterDirectorySnapshot: async (binding) => {
            const path = binding.entries.at(-1)?.path;
            if (locked && !injected && path === storePrefix) {
              injected = true;
              await writeFile(current, '1\n');
            }
          },
        },
      },
    );

    expect(injected).toBe(true);
    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_STATE_CHANGED' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    const after = await snapshotManagedState(dshHome);
    expect(after.get('.dshpack/generations/alpha/current')).toEqual(Buffer.from('1\n'));
    expect(after.get('.dshpack/generations/alpha/0001.json')).toEqual(
      before.get('.dshpack/generations/alpha/0001.json'),
    );
    expect(after.get('.dshpack/generations/alpha/0002.json')).toEqual(
      before.get('.dshpack/generations/alpha/0002.json'),
    );
    await expect(readFile(first)).resolves.toBeDefined();
    await expect(readFile(second)).resolves.toBeDefined();
  });

  it('returns exit 25 exactly when a GC rollback requires manual recovery', async () => {
    const dshHome = await home();
    const obsolete = await writeBlock(dshHome, Buffer.from('obsolete generation'));
    const retained = await writeBlock(dshHome, Buffer.from('retained generation'));
    const obsoleteGeneration = await writeGeneration(dshHome, 'alpha', 1, [obsolete]);
    await writeGeneration(dshHome, 'alpha', 2, [retained]);
    await writeFile(join(dshHome, '.dshpack', 'generations', 'alpha', 'current'), '2\n');
    const base = createNodeTransactionAdapter();
    let forwardMoves = 0;

    const result = await runGc(
      { dshHome, keep: 1, dryRun: false },
      {
        createAdapter: () => ({
          ...base,
          async moveArtifactPath(lock, kind, from, to, direction, expectedIdentity, condition) {
            if (direction === 'from-backup') return false;
            if (direction === 'to-backup' && ++forwardMoves === 2) return false;
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
        }),
      },
    );

    expect(result.exitCode).toBe(25);
    expect(result.metadata.manualRecovery).not.toEqual([]);
    await expect(readFile(obsoleteGeneration)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['generation document', 10 * 1024 * 1024 + 1],
    ['CAS block', 10 * 1024 * 1024 + 1],
  ] as const)('maps an oversized %s to a contract failure without writes', async (kind, bytes) => {
    const dshHome = await home();
    const retained = await writeBlock(dshHome, Buffer.from('retained'));
    const generation = await writeGeneration(dshHome, 'alpha', 1, [retained]);
    const current = join(dirname(generation), 'current');
    await writeFile(current, '1\n');
    const oversized =
      kind === 'generation document'
        ? generation
        : join(dshHome, '.dshpack', 'store', casStoreShard(retained), retained);
    await createSparseFile(oversized, bytes);
    const before = await fingerprint(oversized);

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_STATE_READ_LIMIT' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await fingerprint(oversized)).toEqual(before);
  });

  it('maps an oversized current pointer to a contract failure without writes', async () => {
    const dshHome = await home();
    const generation = await writeGeneration(dshHome, 'alpha', 1, []);
    const current = join(dirname(generation), 'current');
    await writeFile(current, Buffer.alloc(129, '1'));
    const before = await fingerprint(current);

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_GC_STATE_READ_LIMIT' })],
      metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
    });
    expect(await fingerprint(current)).toEqual(before);
  });

  it('permits a degraded non-restorable retained generation to reference an absent block', async () => {
    const dshHome = await home();
    const missing = sha256(Buffer.from('missing degraded block'));
    const generation = await writeGeneration(dshHome, 'alpha', 1, [missing]);
    await writeFile(
      generation,
      `${JSON.stringify({ ...generationDocument('alpha', 1, [missing]), restorable: false })}\n`,
    );
    await writeFile(join(dirname(generation), 'current'), '1\n');

    const result = await runGc({ dshHome, keep: 1, dryRun: false });

    expect(result).toMatchObject({
      exitCode: 0,
      diagnostics: [],
      metadata: { deletedGenerations: [], deletedBlocks: [] },
    });
  });

  it.each([
    [
      'a malformed generation document',
      async (generation: string) => writeFile(generation, '{malformed'),
      30,
      'E_GC_GENERATION_DOCUMENT',
    ],
    [
      'a hardlinked CAS block',
      async (block: string) => {
        const source = `${block}.source`;
        await writeFile(source, 'retained');
        await rm(block);
        await link(source, block);
      },
      31,
      'E_GC_STATE_SECURITY',
    ],
  ] as const)(
    'preserves a typed failure when locked revalidation finds %s',
    async (_label, mutate, exitCode, code) => {
      const dshHome = await home();
      const obsolete = await writeBlock(dshHome, Buffer.from('obsolete'));
      const retained = await writeBlock(dshHome, Buffer.from('retained'));
      const block = join(dshHome, '.dshpack', 'store', casStoreShard(retained), retained);
      await writeGeneration(dshHome, 'alpha', 1, [obsolete]);
      const generation = await writeGeneration(dshHome, 'alpha', 2, [retained]);
      await writeFile(join(dirname(generation), 'current'), '2\n');
      const before = await snapshotManagedState(dshHome);

      const result = await runGc(
        { dshHome, keep: 1, dryRun: false },
        {
          onBeforeLockedScan: async () =>
            mutate(_label === 'a malformed generation document' ? generation : block),
        },
      );

      expect(result).toMatchObject({
        exitCode,
        diagnostics: [expect.objectContaining({ code })],
        metadata: { deletedGenerations: [], deletedBlocks: [], manualRecovery: [] },
      });
      expect(result.metadata.manualRecovery).toEqual([]);
      const after = await snapshotManagedState(dshHome);
      expect(after.get(join('.dshpack', 'generations', 'alpha', 'current'))).toEqual(
        before.get(join('.dshpack', 'generations', 'alpha', 'current')),
      );
    },
  );
});
