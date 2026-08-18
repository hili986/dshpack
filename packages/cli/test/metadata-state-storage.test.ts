import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_CODES } from '../src/exit-codes.js';
import type { InstallPlan } from '../src/install/types.js';
import type { InstalledMetadataV1, MetadataAsset } from '../src/metadata/contracts.js';
import * as stateStorage from '../src/metadata/state-storage.js';
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
import { MAX_TRANSACTION_STATE_BYTES } from '../src/transaction-types.js';
import { GENERATED_BY } from '../src/version.js';

// `isAbsolute` is platform-aware, so the Windows-shaped literal these fixtures used to carry
// was absolute here and *relative* on POSIX. Once a generation embeds its marker (decision D1),
// `validSource` re-validates that path on every write, so the literal turned seven tests red on
// ubuntu while every one of them stayed green on Windows. Root the fixtures per platform.
const SAFE_ROOT = process.platform === 'win32' ? 'C:/safe' : '/safe';

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
    source: { kind: 'directory', path: `${SAFE_ROOT}/source` },
  } as unknown as InstallPlan;
}

function context(overrides: Partial<TransactionContext>): TransactionContext {
  return overrides as TransactionContext;
}

function metadata(
  profile: string,
  generation: number,
  contribution = settingsContribution({}),
): InstalledMetadataV1 {
  const installedAt = '2026-08-17T01:08:44.296Z';
  const manifestDigest = digest(Buffer.from('metadata manifest'));
  return {
    metadataVersion: 1,
    profile,
    pack: { name: profile, version: '1.0.0', manifestDigest },
    planDigest: digest(Buffer.from('metadata plan')),
    installedAt,
    txid: 'metadata-tx',
    source: { kind: 'directory', path: `${SAFE_ROOT}/source` },
    defaults: { permissionPreset: 'workspace-write' },
    plugins: [],
    effectiveLock: {
      lockVersion: 0,
      manifestSha256: manifestDigest,
      generatedBy: GENERATED_BY,
      generatedAt: installedAt,
      dsh: { exportedFrom: '0.1.0' },
      plugins: [],
      files: [],
    },
    sideEffects: ['profile/cordis.yml'],
    assets: [
      {
        id: profile,
        kind: 'profile',
        target: `profiles/${profile}`,
        action: 'create',
        identity: '1:2:3',
        files: [{ path: 'PROFILE.md', sha256: digest(Buffer.from('profile')), bytes: 7 }],
      },
    ],
    settingsContribution: contribution,
    generation,
    installedBy: GENERATED_BY,
  };
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

function deeplyObjectIs(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== 'object' ||
    left === null ||
    typeof right !== 'object' ||
    right === null ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  if (Array.isArray(left) && Array.isArray(right) && left.length !== right.length) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        deeplyObjectIs(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
}

function deeplyNestedCanonicalArray(depth: number): string {
  let value = 'null#0:';
  for (let index = 0; index < depth; index += 1) {
    const body = `length#1:1key#1:0${value}`;
    value = `array#${String(body.length)}:${body}`;
  }
  return value;
}

function canonicalObjectWithNumberProperties(count: number): string {
  const body = Array.from(
    { length: count },
    (_, index) => `key#${String(String(index).length)}:${String(index)}number#1:0`,
  ).join('');
  return `object#${String(body.length)}:${body}`;
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
          `${SAFE_ROOT}/home`,
          'demo-pack',
        ),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODES.CONTRACT,
        diagnostics: [{ code: 'E_GENERATION_CURRENT' }],
      });
    }
  });

  it('increments a canonical current pointer without changing its path', async () => {
    await expect(
      nextGeneration(
        context({ readGenerationCurrent: async () => '1\n' }),
        `${SAFE_ROOT}/home`,
        'demo-pack',
      ),
    ).resolves.toEqual({
      sequence: 2,
      currentPath: join(`${SAFE_ROOT}/home`, '.dshpack', 'generations', 'demo-pack', 'current'),
      previous: '1\n',
    });
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
        `${SAFE_ROOT}/home/.dshpack/generations/demo-pack/current`,
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
        metadata: metadata('demo-pack', 1),
      },
      [],
      { namespace: 'agent-presets', keys: [] },
    );
    await expect(
      writeGeneration(
        context({ writeStateFile: async () => false }),
        `${SAFE_ROOT}/home`,
        'demo-pack',
        document,
      ),
    ).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONTRACT,
      diagnostics: [{ code: 'E_GENERATION_EXISTS' }],
    });
  });

  it('rejects an oversized generation before asking the transaction to write it', async () => {
    const fixturePlan = plan();
    const document = generationDocument(
      1,
      'tx-oversized-generation',
      '2026-08-17T01:08:44.296Z',
      {
        operation: 'install',
        pack: {
          name: fixturePlan.pack.name,
          version: fixturePlan.pack.version,
          manifestDigest: fixturePlan.manifestDigest,
        },
        source: {
          kind: 'directory',
          path: `${SAFE_ROOT}/${'x'.repeat(MAX_TRANSACTION_STATE_BYTES)}`,
        },
        metadata: metadata('demo-pack', 1),
      },
      [],
      { namespace: 'agent-presets', keys: [] },
    );
    let writes = 0;

    await expect(
      writeGeneration(
        context({
          writeStateFile: async () => {
            writes += 1;
            return true;
          },
        }),
        `${SAFE_ROOT}/home`,
        'demo-pack',
        document,
      ),
    ).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONTRACT,
      diagnostics: [{ code: 'E_GENERATION_DOCUMENT_LIMIT' }],
    });
    expect(writes).toBe(0);
  });

  it('permits a generation whose serialized state is exactly the managed 10MiB limit', async () => {
    const fixturePlan = plan();
    const document = generationDocument(
      1,
      'tx-exact-generation',
      '2026-08-17T01:08:44.296Z',
      {
        operation: 'install',
        pack: {
          name: fixturePlan.pack.name,
          version: fixturePlan.pack.version,
          manifestDigest: fixturePlan.manifestDigest,
        },
        source: { kind: 'directory', path: SAFE_ROOT },
        metadata: metadata('demo-pack', 1),
      },
      [],
      { namespace: 'agent-presets', keys: [] },
    );
    // Calculate against the same source-path prefix used below.  Metadata v1
    // deliberately makes the generation envelope larger, so this boundary
    // fixture must derive its padding from the serialized document rather
    // than relying on the former fixed envelope size.
    const sourcePathPrefix = `${SAFE_ROOT}/`;
    document.source = { kind: 'directory', path: '' };
    const padding =
      MAX_TRANSACTION_STATE_BYTES -
      Buffer.byteLength(`${JSON.stringify(document)}\n`, 'utf8') -
      Buffer.byteLength(sourcePathPrefix, 'utf8');
    document.source = { kind: 'directory', path: `${sourcePathPrefix}${'x'.repeat(padding)}` };
    let written: Uint8Array | undefined;

    await expect(
      writeGeneration(
        context({
          writeStateFile: async (_kind, _path, bytes) => {
            written = bytes;
            return true;
          },
        }),
        `${SAFE_ROOT}/home`,
        'demo-pack',
        document,
      ),
    ).resolves.toBeUndefined();
    expect(written).toBeDefined();
    expect(Buffer.from(written ?? []).byteLength).toBe(MAX_TRANSACTION_STATE_BYTES);
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
          source: { kind: 'directory', path: `${SAFE_ROOT}/source` },
          metadata: operation === 'uninstall' ? null : metadata('demo-pack', 2),
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
        `${SAFE_ROOT}/home`,
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
        `${SAFE_ROOT}/home`,
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
      `${SAFE_ROOT}/home`,
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
      `${SAFE_ROOT}/home`,
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
    const mixedOrder = settingsContribution({ custom: { b: 1, a: 2, c: 3 } });
    const sortedOrder = settingsContribution({ custom: { a: 2, b: 1, c: 3 } });

    expect(first).toEqual(reordered);
    expect(first.keys[0]?.valueSha256).not.toBe(reorderedArray.keys[0]?.valueSha256);
    expect(mixedOrder).toEqual(sortedOrder);
  });

  it('round-trips D2 canonical settings values without losing Object.is scalar identity', () => {
    const codec = stateStorage as unknown as {
      encodeCanonicalSettingsValue(value: unknown): string;
      decodeCanonicalSettingsValue(value: string): unknown;
    };
    const value = {
      nan: Number.NaN,
      positiveInfinity: Number.POSITIVE_INFINITY,
      negativeInfinity: Number.NEGATIVE_INFINITY,
      negativeZero: -0,
      zero: 0,
      nullValue: null,
      undefinedValue: undefined,
      empty: '',
      delimiters: 'contains#/:串',
      nested: [
        { text: 'nested#/:value', values: [undefined, -0, Number.NaN] },
        ['array', { empty: '' }],
      ],
    };

    const encoded = codec.encodeCanonicalSettingsValue(value);
    expect(deeplyObjectIs(codec.decodeCanonicalSettingsValue(encoded), value)).toBe(true);
  });

  it('bounds D2 canonical settings depth, node count, and sparse array length', () => {
    const codec = stateStorage as unknown as {
      encodeCanonicalSettingsValue(value: unknown): string;
      decodeCanonicalSettingsValue(value: string): unknown;
    };
    const oversizedSparseArray = 'array#20:length#10:4294967295';
    let deeplyNested: unknown = null;
    for (let index = 0; index < 33; index += 1) deeplyNested = [deeplyNested];
    const manyNodes = Object.fromEntries(
      Array.from({ length: 4097 }, (_, index) => [`key-${String(index)}`, index]),
    );

    expect(() => codec.decodeCanonicalSettingsValue(oversizedSparseArray)).toThrow();
    expect(() => codec.encodeCanonicalSettingsValue(new Array(16_385))).toThrow();
    expect(() => codec.encodeCanonicalSettingsValue(deeplyNested)).toThrow();
    expect(() => codec.encodeCanonicalSettingsValue(manyNodes)).toThrow();
  });

  it('bounds D2 decoding before decoding nested values or allocating untrusted payloads', () => {
    const codec = stateStorage as unknown as {
      decodeCanonicalSettingsValue(value: string): unknown;
    };

    expect(() => codec.decodeCanonicalSettingsValue(deeplyNestedCanonicalArray(33))).toThrow();
    expect(() =>
      codec.decodeCanonicalSettingsValue(canonicalObjectWithNumberProperties(4097)),
    ).toThrow();
    expect(() =>
      codec.decodeCanonicalSettingsValue(`string#65524:${'x'.repeat(65_524)}`),
    ).toThrow();
  });

  it('accepts D2 values exactly at the safe decoding boundaries', () => {
    const codec = stateStorage as unknown as {
      decodeCanonicalSettingsValue(value: string): unknown;
    };
    const maximumBytes = 'x'.repeat(65_523);

    expect(codec.decodeCanonicalSettingsValue(deeplyNestedCanonicalArray(32))).not.toBeUndefined();
    expect(codec.decodeCanonicalSettingsValue('array#14:length#5:16384')).toMatchObject({
      length: 16_384,
    });
    expect(codec.decodeCanonicalSettingsValue(`string#65523:${maximumBytes}`)).toHaveLength(
      maximumBytes.length,
    );
  });

  it('counts D2 canonical limits in UTF-8 bytes for both encoding and decoding', () => {
    const codec = stateStorage as unknown as {
      encodeCanonicalSettingsValue(value: unknown): string;
      decodeCanonicalSettingsValue(value: string): unknown;
    };
    const multiByte = '串'.repeat(32_768);

    expect(() => codec.encodeCanonicalSettingsValue(multiByte)).toThrow();
    expect(() => codec.decodeCanonicalSettingsValue(`string#32768:${multiByte}`)).toThrow();
    expect(() => codec.encodeCanonicalSettingsValue({ value: 'x'.repeat(65_523) })).toThrow();
  });

  it('rejects malformed, non-canonical, trailing, and duplicate-key D2 settings encodings', () => {
    const codec = stateStorage as unknown as {
      decodeCanonicalSettingsValue(value: string): unknown;
    };
    const duplicateBody = 'key#1:anumber#1:1key#1:anumber#1:2';
    const duplicateObject = `object#${String(duplicateBody.length)}:${duplicateBody}`;
    const unorderedBody = 'key#1:bnumber#1:2key#1:anumber#1:1';
    const unorderedObject = `object#${String(unorderedBody.length)}:${unorderedBody}`;

    for (const encoded of [
      'wat#0:',
      'string#01:x',
      'string#2:x',
      'string#0:x',
      duplicateObject,
      unorderedObject,
    ])
      expect(() => codec.decodeCanonicalSettingsValue(encoded)).toThrow();
  });

  it('exercises every canonical scalar/container spelling and rejects unsafe array properties', () => {
    const codec = stateStorage as unknown as {
      encodeCanonicalSettingsValue(value: unknown): string;
      decodeCanonicalSettingsValue(value: string): unknown;
    };
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.present = 1;
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = false;

    for (const value of [
      null,
      undefined,
      true,
      false,
      'text',
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -0,
      17.5,
      [],
      {},
      nullPrototype,
      sparse,
    ]) {
      const encoded = codec.encodeCanonicalSettingsValue(value);
      expect(deeplyObjectIs(codec.decodeCanonicalSettingsValue(encoded), value)).toBe(true);
    }

    const symbolKey = { plain: true };
    Object.defineProperty(symbolKey, Symbol('hidden'), { value: 'not serializable' });
    const nonEnumerable = { plain: true };
    Object.defineProperty(nonEnumerable, 'hidden', { value: 'not serializable' });
    const decoratedArray: unknown[] = [];
    Object.defineProperty(decoratedArray, 'hidden', { value: 'not serializable' });
    expect(() => codec.encodeCanonicalSettingsValue(symbolKey)).toThrow(/symbol/u);
    expect(() => codec.encodeCanonicalSettingsValue(nonEnumerable)).toThrow(/non-enumerable/u);
    expect(() => codec.encodeCanonicalSettingsValue(decoratedArray)).toThrow(/non-enumerable/u);
    expect(() => codec.encodeCanonicalSettingsValue(() => undefined)).toThrow(/function/u);
  });

  it('rejects malformed canonical decoder tokens and array fields before accepting a value', () => {
    const codec = stateStorage as unknown as {
      decodeCanonicalSettingsValue(value: string): unknown;
    };
    const invalidArrayBodies = [
      'wrong#1:0',
      'length#2:01',
      'length#1:1length#1:0null#0:',
      'length#1:1key#1:1null#0:',
      'length#1:1key#1:0null#0:key#1:0null#0:',
    ];
    const wrapped = invalidArrayBodies.map((body) => `array#${String(body.length)}:${body}`);
    for (const encoded of [
      '',
      '#0:',
      'string0:x',
      'string#x:x',
      'string#9007199254740992:',
      'null#1:x',
      'undefined#1:x',
      'boolean#1:x',
      'bigint#1:+',
      'number#1:x',
      'number#8:Infinity',
      ...wrapped,
    ])
      expect(() => codec.decodeCanonicalSettingsValue(encoded)).toThrow();
  });

  it('requires the metadata state to match every generation operation and contribution shape', () => {
    const fixturePlan = plan();
    const contribution = settingsContribution({ present: 'value' });
    const input = {
      pack: {
        name: fixturePlan.pack.name,
        version: fixturePlan.pack.version,
        manifestDigest: fixturePlan.manifestDigest,
      },
      source: fixturePlan.source,
    };
    const make = (
      operation: 'install' | 'update' | 'uninstall' | 'restore',
      marker: InstalledMetadataV1 | null,
      settings = contribution,
    ) =>
      generationDocument(
        1,
        'tx-operation-state',
        '2026-08-17T01:08:44.296Z',
        {
          ...input,
          operation,
          metadata: marker,
        },
        [],
        settings,
      );

    expect(() => make('install', null)).toThrow(/effective marker state/u);
    expect(() => make('update', null)).toThrow(/effective marker state/u);
    expect(() => make('uninstall', metadata('demo-pack', 1, contribution))).toThrow(
      /effective marker state/u,
    );
    expect(() => make('restore', null)).not.toThrow();
    expect(() =>
      make('install', metadata('demo-pack', 1, contribution), {
        namespace: contribution.namespace,
        keys: [],
      }),
    ).toThrow(/matching settings contribution/u);
    expect(() =>
      make('install', metadata('demo-pack', 1, contribution), {
        namespace: contribution.namespace,
        keys: contribution.keys.map((entry) => ({ ...entry, canonicalValue: 'string#1:x' })),
      }),
    ).toThrow(/canonical persisted contribution|matching settings contribution/u);
    expect(() =>
      make('install', metadata('demo-pack', 1, contribution), {
        namespace: contribution.namespace,
        keys: contribution.keys.map((entry) => ({ ...entry, key: 'renamed' })),
      }),
    ).toThrow(/matching settings contribution/u);
  });

  it('refuses to create a generation from incomplete or mismatched v1 metadata', () => {
    const fixturePlan = plan();
    const contribution = settingsContribution({ custom: 'generation value' });
    const completeMetadata = metadata('demo-pack', 1, contribution);
    const input = {
      operation: 'install' as const,
      pack: {
        name: fixturePlan.pack.name,
        version: fixturePlan.pack.version,
        manifestDigest: fixturePlan.manifestDigest,
      },
      source: fixturePlan.source,
    };

    expect(() =>
      generationDocument(
        1,
        'tx-incomplete-metadata',
        '2026-08-17T01:08:44.296Z',
        { ...input, metadata: { ...completeMetadata, assets: [] } },
        [],
        contribution,
      ),
    ).toThrow(/complete v1 marker|matching settings contribution/u);
    expect(() =>
      generationDocument(
        1,
        'tx-mismatched-contribution',
        '2026-08-17T01:08:44.296Z',
        { ...input, metadata: completeMetadata },
        [],
        settingsContribution({ custom: 'generation differs' }),
      ),
    ).toThrow(/complete v1 marker|matching settings contribution/u);
  });

  it('refuses to create a generation when complete v1 metadata names another generation', () => {
    const fixturePlan = plan();
    const contribution = settingsContribution({ custom: 'same contribution' });

    expect(() =>
      generationDocument(
        2,
        'tx-mismatched-generation',
        '2026-08-17T01:08:44.296Z',
        {
          operation: 'install',
          pack: {
            name: fixturePlan.pack.name,
            version: fixturePlan.pack.version,
            manifestDigest: fixturePlan.manifestDigest,
          },
          source: fixturePlan.source,
          metadata: metadata('demo-pack', 1, contribution),
        },
        [],
        contribution,
      ),
    ).toThrow(/generation metadata|matching settings contribution/u);
  });

  it('records the reversible canonical value alongside every settings digest', () => {
    const contribution = settingsContribution({
      empty: '',
      nested: { value: [Number.NaN, -0, undefined, 'contains#/:串'] },
    });

    expect(contribution.keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'empty', canonicalValue: expect.any(String) }),
        expect.objectContaining({ key: 'nested', canonicalValue: expect.any(String) }),
      ]),
    );
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
