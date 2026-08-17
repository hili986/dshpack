import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_CODES } from '../src/exit-codes.js';
import type { InstallPlan } from '../src/install/types.js';
import type { MetadataAsset } from '../src/metadata/contracts.js';
import {
  advanceCurrent,
  assertPositiveSafeSequence,
  type CapturedInstallAsset,
  captureInstalledAssets,
  generationDocument,
  generationFilename,
  isExactCasStoreShardLeaf,
  isManagedProfileInventoryPath,
  nextGeneration,
  settingsContribution,
  storeCapturedAssets,
  writeGeneration,
} from '../src/metadata/state-storage.js';
import type { TransactionContext } from '../src/transaction.js';

const roots: string[] = [];

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-state-storage-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
}

function plan(profile = 'demo-pack'): InstallPlan {
  return {
    targetProfile: profile,
    replaceExistingProfile: false,
    skills: [],
    presets: [],
    pack: { name: profile, version: '1.0.0' },
    manifestDigest: digest(Buffer.from('manifest')),
    source: { kind: 'directory', path: 'C:/safe/source' },
  } as unknown as InstallPlan;
}

function context(overrides: Partial<TransactionContext>): TransactionContext {
  return overrides as TransactionContext;
}

function asset(blocks: CapturedInstallAsset['blocks']): CapturedInstallAsset {
  const metadata: MetadataAsset = {
    id: 'demo-pack',
    kind: 'profile',
    target: 'profiles/demo-pack',
    action: 'create',
    identity: '1:2:3',
    files: blocks.map((block) => ({
      path: block.target.split('/').at(-1) as string,
      sha256: block.sha256,
      bytes: block.bytes.byteLength,
    })),
  };
  return { asset: metadata, blocks };
}

describe('metadata state storage boundaries', () => {
  it('does not case-fold a resolved CAS shard leaf', () => {
    expect(isExactCasStoreShardLeaf('db', 'db')).toBe(true);
    expect(isExactCasStoreShardLeaf('DB', 'db')).toBe(false);
  });

  it('rejects malformed and overflowing current pointers before allocating a generation', async () => {
    for (const pointer of ['1', '9007199254740991\n']) {
      await expect(
        nextGeneration(
          context({ readGenerationCurrent: async () => pointer }),
          'C:/safe/home',
          'demo-pack',
        ),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODES.CONTRACT,
        diagnostics: [{ code: 'E_GENERATION_CURRENT' }],
      });
    }
  });

  it('requires an explicit operation and a safe positive sequence before any generation mutation', async () => {
    const fixturePlan = plan();
    expect(generationFilename(Number.MAX_SAFE_INTEGER)).toBe(`${Number.MAX_SAFE_INTEGER}.json`);
    for (const sequence of [0, -1, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(() => assertPositiveSafeSequence(sequence)).toThrow(
        /E_GENERATION_SEQUENCE|safe positive/u,
      );
    }
    expect(() =>
      generationDocument(
        1,
        'tx-missing-operation',
        '2026-08-17T01:08:44.296Z',
        {
          pack: {
            name: fixturePlan.pack.name,
            version: fixturePlan.pack.version,
            manifestDigest: fixturePlan.manifestDigest,
          },
          source: fixturePlan.source,
        } as unknown as Parameters<typeof generationDocument>[3],
        [],
        { namespace: 'agent-presets', keys: [] },
      ),
    ).toThrow(/E_GENERATION_OPERATION|generation operation/u);
    let writes = 0;
    await expect(
      advanceCurrent(
        context({
          writeGenerationCurrent: async () => {
            writes += 1;
          },
        }),
        'C:/safe/home/.dshpack/generations/demo-pack/current',
        undefined,
        0,
      ),
    ).rejects.toMatchObject({ diagnostics: [{ code: 'E_GENERATION_SEQUENCE' }] });
    expect(writes).toBe(0);
  });

  it('refuses to overwrite an immutable generation manifest', async () => {
    const fixturePlan = plan();
    const document = generationDocument(
      1,
      'tx-1',
      '2026-08-17T01:08:44.296Z',
      {
        operation: 'install',
        pack: {
          name: fixturePlan.pack.name,
          version: fixturePlan.pack.version,
          manifestDigest: fixturePlan.manifestDigest,
        },
        source: fixturePlan.source,
      },
      [],
      { namespace: 'agent-presets', keys: [] },
    );
    await expect(
      writeGeneration(
        context({ writeStateFile: async () => false }),
        'C:/safe/home',
        'demo-pack',
        document,
      ),
    ).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONTRACT,
      diagnostics: [{ code: 'E_GENERATION_EXISTS' }],
    });
  });

  it.each(['update', 'uninstall', 'restore'] as const)(
    'serializes a reusable %s generation operation without an install plan',
    (operation) => {
      const document = generationDocument(
        2,
        'tx-operation',
        '2026-08-17T01:08:44.296Z',
        {
          operation,
          pack: {
            name: 'demo-pack',
            version: '1.0.0',
            manifestDigest: digest(Buffer.from('pack')),
          },
          source: { kind: 'directory', path: 'C:/safe/source' },
        },
        [],
        { namespace: 'agent-presets', keys: [] },
      );

      expect(JSON.parse(JSON.stringify(document))).toMatchObject({ seq: 2, operation });
    },
  );

  it('rejects a declared digest mismatch before any CAS write and rejects a corrupt stored block', async () => {
    let writes = 0;
    await expect(
      storeCapturedAssets(
        context({
          readStateBytes: async () => undefined,
          writeStateFile: async () => {
            writes += 1;
            return true;
          },
        }),
        'C:/safe/home',
        [
          asset([
            {
              target: 'profiles/demo-pack/a',
              sha256: digest(Buffer.from('different')),
              bytes: Buffer.from('declared'),
            },
          ]),
        ],
      ),
    ).rejects.toMatchObject({ diagnostics: [{ code: 'E_STORE_DIGEST_MISMATCH' }] });
    expect(writes).toBe(0);

    const expected = Buffer.from('expected');
    await expect(
      storeCapturedAssets(
        context({ readStateBytes: async () => Buffer.from('corrupt') }),
        'C:/safe/home',
        [asset([{ target: 'profiles/demo-pack/a', sha256: digest(expected), bytes: expected }])],
      ),
    ).rejects.toMatchObject({ diagnostics: [{ code: 'E_STORE_DIGEST_COLLISION' }] });
  });

  it('rechecks a losing exclusive CAS race and accepts only the matching bytes', async () => {
    const expected = Buffer.from([0, 255, 5]);
    let reads = 0;
    const writes: string[] = [];
    await storeCapturedAssets(
      context({
        readStateBytes: async () => (reads++ === 0 ? undefined : expected),
        writeStateFile: async (_kind, path) => {
          writes.push(path);
          return false;
        },
      }),
      'C:/safe/home',
      [
        asset([
          { target: 'profiles/demo-pack/raw.bin', sha256: digest(expected), bytes: expected },
        ]),
      ],
    );
    expect(reads).toBe(2);
    expect(writes).toHaveLength(1);
  });

  it('does not write or replace an already verified CAS block during deduplication', async () => {
    const bytes = Buffer.from([0, 255, 5]);
    let writes = 0;
    await storeCapturedAssets(
      context({
        readStateBytes: async () => bytes,
        writeStateFile: async () => {
          writes += 1;
          return true;
        },
      }),
      'C:/safe/home',
      [asset([{ target: 'profiles/demo-pack/raw.bin', sha256: digest(bytes), bytes }])],
    );
    expect(writes).toBe(0);
  });

  it.each(['file-root', 'oversized-file'] as const)(
    'maps a %s capture failure to a typed install failure before storage writes',
    async (scenario) => {
      const dshHome = await home();
      const root = join(dshHome, 'profiles', 'demo-pack');
      if (scenario === 'file-root') {
        await mkdir(join(root, '..'), { recursive: true });
        await writeFile(root, 'not a directory');
      } else {
        await mkdir(root, { recursive: true });
        await writeFile(join(root, 'large.bin'), Buffer.alloc(1024 * 1024 + 1));
      }
      await expect(
        captureInstalledAssets(context({ artifactIdentity: async () => '1:2:3' }), dshHome, plan()),
      ).rejects.toMatchObject({ exitCode: scenario === 'file-root' ? 31 : 30 });
    },
  );

  it('rejects a changed directory identity and an empty asset without creating state', async () => {
    const changedHome = await home();
    const changed = join(changedHome, 'profiles', 'demo-pack');
    await mkdir(changed, { recursive: true });
    await writeFile(join(changed, 'file.txt'), 'contents');
    let identities = 0;
    await expect(
      captureInstalledAssets(
        context({ artifactIdentity: async () => (identities++ === 0 ? '1:2:3' : '1:2:4') }),
        changedHome,
        plan(),
      ),
    ).rejects.toMatchObject({ diagnostics: [{ code: 'E_INSTALL_ASSET_CHANGED' }] });

    const emptyHome = await home();
    await mkdir(join(emptyHome, 'profiles', 'demo-pack'), { recursive: true });
    await expect(
      captureInstalledAssets(context({ artifactIdentity: async () => '1:2:3' }), emptyHome, plan()),
    ).rejects.toMatchObject({ diagnostics: [{ code: 'E_INSTALL_ASSET_EMPTY' }] });
  });

  it('rejects a same-identity directory whose file set changes during capture confirmation', async () => {
    const dshHome = await home();
    const target = join(dshHome, 'profiles', 'demo-pack');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'first.txt'), 'first');
    let identityCalls = 0;
    await expect(
      captureInstalledAssets(
        context({
          artifactIdentity: async () => {
            identityCalls += 1;
            if (identityCalls === 2) await writeFile(join(target, 'late.txt'), 'late');
            return '1:2:3';
          },
        }),
        dshHome,
        plan(),
      ),
    ).rejects.toMatchObject({ diagnostics: [{ code: 'E_INSTALL_ASSET_CHANGED' }] });
  });

  it('hashes object keys canonically while preserving arrays as ordered values', () => {
    const first = settingsContribution({ custom: { z: 1, a: ['second', 'first'] } });
    const reordered = settingsContribution({ custom: { a: ['second', 'first'], z: 1 } });
    const reorderedArray = settingsContribution({ custom: { a: ['first', 'second'], z: 1 } });

    expect(first).toEqual(reordered);
    expect(first.keys[0]?.valueSha256).not.toBe(reorderedArray.keys[0]?.valueSha256);
  });

  it.each(['node_modules/a.js', 'Node_Modules/nested/a.js', 'NODE_MODULES/linked'])(
    'excludes portable node_modules inventory path %s regardless of case',
    (path) => {
      expect(isManagedProfileInventoryPath(path)).toBe(false);
    },
  );

  it('distinguishes YAML null and non-finite number scalars in settings hashes', () => {
    const contribution = settingsContribution({
      nullValue: null,
      notANumber: Number.NaN,
      positiveInfinity: Number.POSITIVE_INFINITY,
      negativeInfinity: Number.NEGATIVE_INFINITY,
      zero: 0,
      negativeZero: -0,
      undefinedValue: undefined,
      largeInteger: 9007199254740993n,
    });
    const values = contribution.keys.map(({ valueSha256 }) => valueSha256);

    expect(new Set(values).size).toBe(values.length);
  });

  it('rejects cyclic and non-plain settings values instead of collapsing their identity', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => settingsContribution({ cyclic })).toThrow(/cycle/u);
    expect(() => settingsContribution({ date: new Date(0) })).toThrow(/plain object/u);
  });
});
