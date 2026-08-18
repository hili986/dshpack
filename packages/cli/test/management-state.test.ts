import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  listGenerations,
  readCasBlock,
  readGeneration,
  readGenerationCurrent,
  readTrackedMetadata,
} from '../src/management/state.js';
import { casStoreShard, settingsContribution } from '../src/metadata/state-storage.js';
import { MAX_TRANSACTION_STATE_BYTES } from '../src/transaction-types.js';
import { GENERATED_BY } from '../src/version.js';

const roots: string[] = [];
const markerDigest = `sha256-${'A'.repeat(43)}`;

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-management-state-'));
  roots.push(root);
  return root;
}

function digest(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
}

function sha512Integrity(value: string): string {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

const sourceIntegrity = sha512Integrity('https source integrity');

function sha256PadBitAlias(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = value.at(-1);
  if (last === undefined) throw new Error('digest must have a final base64url character');
  const index = alphabet.indexOf(last);
  if (index < 0 || index % 4 !== 0) throw new Error('digest fixture must be canonical');
  return `${value.slice(0, -1)}${alphabet[index + 1]}`;
}

function sha512PadBitAlias(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const finalBase64Character = value.length - 3;
  const last = value.at(finalBase64Character);
  if (last === undefined) throw new Error('digest must have a final base64 character');
  const index = alphabet.indexOf(last);
  if (index < 0 || index % 16 !== 0) throw new Error('digest fixture must be canonical');
  return `${value.slice(0, finalBase64Character)}${alphabet[index + 1]}${value.slice(finalBase64Character + 1)}`;
}

function marker(profile: string, dshHome: string) {
  const installedAt = '2026-08-18T00:00:00.000Z';
  return {
    metadataVersion: 1,
    profile,
    pack: { name: profile, version: '1.2.3', manifestDigest: markerDigest },
    planDigest: markerDigest,
    installedAt,
    txid: 'install-1',
    source: { kind: 'directory', path: dshHome },
    defaults: { permissionPreset: 'workspace-write' },
    plugins: [],
    effectiveLock: {
      lockVersion: 0,
      manifestSha256: markerDigest,
      generatedBy: GENERATED_BY,
      generatedAt: installedAt,
      dsh: { exportedFrom: '0.1.0' },
      plugins: [],
      files: [],
    },
    sideEffects: ['profile/cordis.yml'],
    assets: [
      {
        id: 'notes',
        kind: 'skill',
        target: 'skills/notes',
        action: 'create',
        identity: '1:2:3',
        files: [{ path: 'SKILL.md', sha256: markerDigest, bytes: 1 }],
      },
    ],
    settingsContribution: settingsContribution({}),
    generation: 2,
    installedBy: GENERATED_BY,
  };
}

function generation(profile: string, dshHome: string, sha256: string): Record<string, unknown> {
  return {
    seq: 2,
    txid: 'install-1',
    createdAt: '2026-08-18T00:00:00.000Z',
    operation: 'install',
    pack: { name: profile, version: '1.2.3', manifestDigest: markerDigest },
    source: { kind: 'directory', path: resolve(dshHome) },
    entries: [{ target: 'skills/notes/SKILL.md', sha256 }],
    settingsContribution: settingsContribution({}),
    metadata: marker(profile, resolve(dshHome)),
    restorable: true,
  };
}

function unorderedCanonicalObject(): string {
  const body = 'key#1:bnumber#1:2key#1:anumber#1:1';
  return `object#${String(body.length)}:${body}`;
}

function deeplyNestedCanonicalArray(depth: number): string {
  let value = 'null#0:';
  for (let index = 0; index < depth; index += 1) {
    const body = `length#1:1key#1:0${value}`;
    value = `array#${String(body.length)}:${body}`;
  }
  return value;
}

async function writeGeneration(
  dshHome: string,
  profile: string,
  document: Record<string, unknown>,
): Promise<void> {
  await mkdir(join(dshHome, '.dshpack', 'generations', profile), { recursive: true });
  await writeFile(
    join(dshHome, '.dshpack', 'generations', profile, '0002.json'),
    `${JSON.stringify(document)}\n`,
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('management state current/list and CAS contracts', () => {
  it('reads a canonical current pointer and lists immutable generations in sequence order', async () => {
    const dshHome = await home();
    const profile = 'demo-pack';
    const sha256 = digest(Buffer.from('ordered generation'));
    const first = generation(profile, dshHome, sha256);
    first.seq = 1;
    first.metadata = { ...marker(profile, resolve(dshHome)), generation: 1 };
    const second = generation(profile, dshHome, sha256);
    await mkdir(join(dshHome, '.dshpack', 'generations', profile), { recursive: true });
    await writeFile(
      join(dshHome, '.dshpack', 'generations', profile, '0001.json'),
      `${JSON.stringify(first)}\n`,
    );
    await writeGeneration(dshHome, profile, second);
    await writeFile(join(dshHome, '.dshpack', 'generations', profile, 'current'), '2\n');

    await expect(readGenerationCurrent(dshHome, profile)).resolves.toBe(2);
    await expect(listGenerations(dshHome, profile)).resolves.toMatchObject([
      { seq: 1 },
      { seq: 2 },
    ]);
  });

  it('fails closed when listing otherwise-valid generations exceeds the aggregate state bound', async () => {
    const dshHome = await home();
    const profile = 'demo-pack';
    const sha256 = digest(Buffer.from('aggregate bound'));
    const padding = 'x'.repeat(Math.floor(MAX_TRANSACTION_STATE_BYTES / 2));
    for (const sequence of [1, 2]) {
      const document = generation(profile, dshHome, sha256);
      document.seq = sequence;
      document.source = { kind: 'directory', path: `${resolve(dshHome)}${padding}` };
      const metadata = marker(profile, resolve(dshHome));
      metadata.generation = sequence;
      document.metadata = metadata;
      await mkdir(join(dshHome, '.dshpack', 'generations', profile), { recursive: true });
      await writeFile(
        join(
          dshHome,
          '.dshpack',
          'generations',
          profile,
          `${String(sequence).padStart(4, '0')}.json`,
        ),
        `${JSON.stringify(document)}\n`,
      );
    }

    await expect(listGenerations(dshHome, profile)).rejects.toMatchObject({
      kind: 'contract',
      diagnostic: { code: 'E_MANAGEMENT_GENERATION' },
    });
  });

  it.each([
    ['missing', undefined],
    ['zero', '0\n'],
    ['noncanonical spelling', '02\n'],
  ] as const)('rejects a $name generation current pointer', async (_name, current) => {
    const dshHome = await home();
    const profile = 'demo-pack';
    await mkdir(join(dshHome, '.dshpack', 'generations', profile), { recursive: true });
    if (current !== undefined)
      await writeFile(join(dshHome, '.dshpack', 'generations', profile, 'current'), current);

    await expect(readGenerationCurrent(dshHome, profile)).rejects.toMatchObject({
      diagnostic: { code: 'E_MANAGEMENT_GENERATION' },
    });
  });

  it.each([
    ['a non-generation filename', 'notes.txt'],
    ['a noncanonical sequence spelling', '01.json'],
  ] as const)('rejects a generation list containing %s', async (_name, filename) => {
    const dshHome = await home();
    const profile = 'demo-pack';
    await mkdir(join(dshHome, '.dshpack', 'generations', profile), { recursive: true });
    await writeFile(join(dshHome, '.dshpack', 'generations', profile, filename), '{}\n');

    await expect(listGenerations(dshHome, profile)).rejects.toMatchObject({
      diagnostic: { code: 'E_MANAGEMENT_GENERATION' },
    });
  });

  it('rejects unsafe state reader inputs before resolving any managed paths', async () => {
    const dshHome = await home();

    await expect(readTrackedMetadata(dshHome, '../outside')).rejects.toMatchObject({
      diagnostic: { code: 'E_MANAGEMENT_PROFILE' },
    });
    await expect(readGeneration(dshHome, 'demo-pack', 0)).rejects.toMatchObject({
      diagnostic: { code: 'E_MANAGEMENT_GENERATION' },
    });
    await expect(readGenerationCurrent(dshHome, '..')).rejects.toMatchObject({
      diagnostic: { code: 'E_MANAGEMENT_PROFILE' },
    });
    await expect(listGenerations(dshHome, 'a/b')).rejects.toMatchObject({
      diagnostic: { code: 'E_MANAGEMENT_PROFILE' },
    });
    await expect(readCasBlock(dshHome, 'sha256-not-a-digest')).rejects.toMatchObject({
      diagnostic: { code: 'E_MANAGEMENT_CAS' },
    });
    await expect(
      readCasBlock(dshHome, sha256PadBitAlias(digest(Buffer.from('alias')))),
    ).rejects.toMatchObject({
      kind: 'contract',
      diagnostic: { code: 'E_MANAGEMENT_CAS' },
    });
  });

  it.each([
    ['a missing store root', async (_home: string, _digest: string) => {}],
    [
      'an invalid shard entry',
      async (dshHome: string) => {
        await mkdir(join(dshHome, '.dshpack', 'store', 'z'), { recursive: true });
      },
    ],
    [
      'a missing block in an existing shard',
      async (dshHome: string, sha256: string) => {
        await mkdir(join(dshHome, '.dshpack', 'store', casStoreShard(sha256)), { recursive: true });
      },
    ],
    [
      'a block whose bytes do not match its digest',
      async (dshHome: string, sha256: string) => {
        await mkdir(join(dshHome, '.dshpack', 'store', casStoreShard(sha256)), { recursive: true });
        await writeFile(join(dshHome, '.dshpack', 'store', casStoreShard(sha256), sha256), 'wrong');
      },
    ],
  ] as const)('fails closed on %s', async (_name, setup) => {
    const dshHome = await home();
    const sha256 = digest(Buffer.from('expected immutable bytes'));
    await setup(dshHome, sha256);

    await expect(readCasBlock(dshHome, sha256)).rejects.toMatchObject({
      diagnostic: { code: 'E_MANAGEMENT_CAS' },
    });
  });

  it.each(['uninstall', 'restore'] as const)(
    'accepts a %s generation whose effective metadata is absent',
    async (operation) => {
      const dshHome = await home();
      const sha256 = digest(Buffer.from(`${operation} generation`));
      const document = generation('demo-pack', dshHome, sha256);
      document.operation = operation;
      document.metadata = null;
      await writeGeneration(dshHome, 'demo-pack', document);

      await expect(readGeneration(dshHome, 'demo-pack', 2)).resolves.toMatchObject({
        operation,
        metadata: null,
      });
    },
  );

  it('rejects a numerically out-of-range current pointer after canonical text validation', async () => {
    const dshHome = await home();
    await mkdir(join(dshHome, '.dshpack', 'generations', 'demo-pack'), { recursive: true });
    await writeFile(
      join(dshHome, '.dshpack', 'generations', 'demo-pack', 'current'),
      '9007199254740992\n',
    );

    await expect(readGenerationCurrent(dshHome, 'demo-pack')).rejects.toMatchObject({
      diagnostic: { code: 'E_MANAGEMENT_GENERATION' },
    });
  });

  it('fails when listGenerations cannot read the profile generation directory', async () => {
    const dshHome = await home();

    await expect(listGenerations(dshHome, 'demo-pack')).rejects.toMatchObject({
      diagnostic: { code: 'E_MANAGEMENT_GENERATION' },
    });
  });

  it('rejects a CAS store that lacks the requested canonical shard', async () => {
    const dshHome = await home();
    const sha256 = digest(Buffer.from('requested shard missing'));
    const requested = casStoreShard(sha256);
    const unrelated = requested === 'aa' ? 'bb' : 'aa';
    await mkdir(join(dshHome, '.dshpack', 'store', unrelated), { recursive: true });

    await expect(readCasBlock(dshHome, sha256)).rejects.toMatchObject({
      diagnostic: { code: 'E_MANAGEMENT_CAS' },
    });
  });

  it('rejects an unsafe block entry before reading a requested CAS block', async () => {
    const dshHome = await home();
    const sha256 = digest(Buffer.from('unsafe block entry'));
    const shard = casStoreShard(sha256);
    await mkdir(join(dshHome, '.dshpack', 'store', shard), { recursive: true });
    await writeFile(join(dshHome, '.dshpack', 'store', shard, 'bad'), 'not a digest');

    await expect(readCasBlock(dshHome, sha256)).rejects.toMatchObject({
      diagnostic: { code: 'E_MANAGEMENT_CAS' },
    });
  });
});

describe('tracked management state', () => {
  it('securely reads a v1 marker, its generation, and its verified CAS block', async () => {
    const dshHome = await home();
    const profile = 'demo-pack';
    const bytes = Buffer.from('immutable asset bytes');
    const sha256 = digest(bytes);
    const document = generation(profile, dshHome, sha256);
    document.metadata = marker(profile, resolve(dshHome));
    await mkdir(join(dshHome, '.dshpack', 'installed'), { recursive: true });
    await mkdir(join(dshHome, '.dshpack', 'store', casStoreShard(sha256)), { recursive: true });
    await writeFile(
      join(dshHome, '.dshpack', 'installed', `${profile}.json`),
      `${JSON.stringify(marker(profile, resolve(dshHome)))}\n`,
    );
    await writeGeneration(dshHome, profile, document);
    await writeFile(join(dshHome, '.dshpack', 'store', casStoreShard(sha256), sha256), bytes);

    await expect(readTrackedMetadata(dshHome, profile)).resolves.toMatchObject({
      metadataVersion: 1,
      generation: 2,
    });
    await expect(readGeneration(dshHome, profile, 2)).resolves.toEqual(document);
    await expect(readCasBlock(dshHome, sha256)).resolves.toEqual(bytes);
  });

  it.each([
    { name: 'exactly at', extraBytes: 0, expected: 'accepts' },
    { name: 'one byte over', extraBytes: 1, expected: 'rejects' },
  ] as const)(
    'uses the shared 10MiB bound when a generation is $name it',
    async ({ extraBytes, expected }) => {
      const dshHome = await home();
      const profile = 'demo-pack';
      const document = generation(profile, dshHome, digest(Buffer.from('state bound')));
      const initial = `${JSON.stringify(document)}\n`;
      const padding = MAX_TRANSACTION_STATE_BYTES - Buffer.byteLength(initial, 'utf8') + extraBytes;
      document.source = { kind: 'directory', path: `${resolve(dshHome)}${'x'.repeat(padding)}` };
      await writeGeneration(dshHome, profile, document);

      if (expected === 'accepts') {
        await expect(readGeneration(dshHome, profile, 2)).resolves.toMatchObject({ seq: 2 });
      } else {
        await expect(readGeneration(dshHome, profile, 2)).rejects.toMatchObject({
          diagnostic: { code: 'E_MANAGEMENT_GENERATION' },
        });
      }
    },
  );

  it('fails closed when a persisted generation omits the D2 canonical settings value', async () => {
    const dshHome = await home();
    const profile = 'demo-pack';
    const sha256 = digest(Buffer.from('missing canonical setting'));
    const document = generation(profile, dshHome, sha256);
    document.settingsContribution = {
      namespace: 'agent-presets',
      keys: [{ key: 'completion.temperature', valueSha256: digest(Buffer.from('number#1:1')) }],
    };
    await writeGeneration(dshHome, profile, document);

    await expect(readGeneration(dshHome, profile, 2)).rejects.toMatchObject({
      kind: 'contract',
      diagnostic: { code: 'E_MANAGEMENT_GENERATION' },
    });
  });

  it('fails closed when a persisted generation has a valid but non-canonical settings encoding', async () => {
    const dshHome = await home();
    const profile = 'demo-pack';
    const sha256 = digest(Buffer.from('non-canonical generation setting'));
    const document = generation(profile, dshHome, sha256);
    const canonicalValue = unorderedCanonicalObject();
    document.settingsContribution = {
      namespace: 'agent-presets',
      keys: [
        {
          key: 'completion.temperature',
          canonicalValue,
          valueSha256: digest(Buffer.from(canonicalValue)),
        },
      ],
    };
    document.metadata = {
      ...marker(profile, resolve(dshHome)),
      settingsContribution: document.settingsContribution,
    };
    await writeGeneration(dshHome, profile, document);

    await expect(readGeneration(dshHome, profile, 2)).rejects.toMatchObject({
      kind: 'contract',
      diagnostic: { code: 'E_MANAGEMENT_GENERATION' },
    });
  });

  it.each([
    ['an oversized sparse array', 'array#20:length#10:4294967295'],
    ['an over-depth nested array', deeplyNestedCanonicalArray(33)],
  ] as const)(
    'fails closed when a persisted generation has %s',
    async (_reason, canonicalValue) => {
      const dshHome = await home();
      const profile = 'demo-pack';
      const sha256 = digest(Buffer.from('bounded canonical generation setting'));
      const document = generation(profile, dshHome, sha256);
      document.settingsContribution = {
        namespace: 'agent-presets',
        keys: [
          {
            key: 'completion.temperature',
            canonicalValue,
            valueSha256: digest(Buffer.from(canonicalValue)),
          },
        ],
      };
      document.metadata = {
        ...marker(profile, resolve(dshHome)),
        settingsContribution: document.settingsContribution,
      };
      await writeGeneration(dshHome, profile, document);

      await expect(readGeneration(dshHome, profile, 2)).rejects.toMatchObject({
        kind: 'contract',
        diagnostic: { code: 'E_MANAGEMENT_GENERATION' },
      });
    },
  );

  it.each([
    ['a canonical digest mismatch', 'number#1:1', markerDigest],
    ['a malformed canonical value with a matching digest', 'number#01:1', undefined],
    ['a valid but non-canonical object value', unorderedCanonicalObject(), undefined],
  ] as const)(
    'fails closed when a persisted marker has %s',
    async (_reason, canonicalValue, valueSha256) => {
      const dshHome = await home();
      const profile = 'demo-pack';
      const metadata = marker(profile, resolve(dshHome));
      metadata.settingsContribution = {
        namespace: 'agent-presets',
        keys: [
          {
            key: 'completion.temperature',
            canonicalValue,
            valueSha256: valueSha256 ?? digest(Buffer.from(canonicalValue)),
          },
        ],
      };
      await mkdir(join(dshHome, '.dshpack', 'installed'), { recursive: true });
      await writeFile(
        join(dshHome, '.dshpack', 'installed', `${profile}.json`),
        `${JSON.stringify(metadata)}\n`,
      );

      await expect(readTrackedMetadata(dshHome, profile)).rejects.toMatchObject({
        kind: 'contract',
        diagnostic: { code: 'E_MANAGEMENT_METADATA' },
      });
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects a physically uppercase CAS shard on a case-insensitive filesystem',
    async () => {
      const dshHome = await home();
      const bytes = Buffer.from('case-shard-3014');
      const sha256 = digest(bytes);
      const path = join(dshHome, '.dshpack', 'store', 'DB', sha256);
      expect(casStoreShard(sha256)).toBe('db');
      await mkdir(join(dshHome, '.dshpack', 'store', 'DB'), { recursive: true });
      await writeFile(path, bytes);

      await expect(readCasBlock(dshHome, sha256)).rejects.toMatchObject({
        kind: 'security',
        diagnostic: { code: 'E_MANAGEMENT_CAS' },
      });
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects a CAS shard whose physical spelling changes after the store scan',
    async () => {
      const dshHome = await home();
      const bytes = Buffer.from('case-shard-3014');
      const sha256 = digest(bytes);
      const shard = casStoreShard(sha256);
      const store = join(dshHome, '.dshpack', 'store');
      const canonical = join(store, shard);
      let renamed = false;
      expect(shard).toBe('db');
      await mkdir(canonical, { recursive: true });
      await writeFile(join(canonical, sha256), bytes);

      await expect(
        readCasBlock(dshHome, sha256, {
          safePathHooks: {
            afterDirectorySnapshot: async (binding) => {
              const path = binding.entries.at(-1)?.path;
              if (path !== store || renamed) return;
              const moved = join(store, 'db-before-case-change');
              await rename(canonical, moved);
              await rename(moved, join(store, 'DB'));
              renamed = true;
            },
          },
        }),
      ).rejects.toMatchObject({
        kind: expect.stringMatching(/^(?:security|changed)$/u),
        diagnostic: { code: 'E_MANAGEMENT_CAS' },
      });
      expect(renamed).toBe(true);
    },
  );

  it.each([
    ['a non-ISO timestamp', (document: Record<string, unknown>) => (document.createdAt = 'today')],
    [
      'an empty pack name',
      (document: Record<string, unknown>) =>
        (document.pack = { name: '', version: '1.2.3', manifestDigest: markerDigest }),
    ],
    [
      'a non-semver pack version',
      (document: Record<string, unknown>) =>
        (document.pack = { name: 'demo-pack', version: 'latest', manifestDigest: markerDigest }),
    ],
    [
      'an invalid pack digest',
      (document: Record<string, unknown>) =>
        (document.pack = { name: 'demo-pack', version: '1.2.3', manifestDigest: 'sha256-bad' }),
    ],
    [
      'an extra pack field',
      (document: Record<string, unknown>) =>
        (document.pack = {
          name: 'demo-pack',
          version: '1.2.3',
          manifestDigest: markerDigest,
          extra: true,
        }),
    ],
    [
      'an invalid source path',
      (document: Record<string, unknown>) =>
        (document.source = { kind: 'directory', path: 'relative' }),
    ],
    [
      'an extra source field',
      (document: Record<string, unknown>, dshHome: string) =>
        (document.source = { kind: 'directory', path: dshHome, extra: true }),
    ],
    [
      'an entry with an extra field',
      (document: Record<string, unknown>, _dshHome: string, sha256: string) =>
        (document.entries = [{ target: 'skills/notes/SKILL.md', sha256, extra: true }]),
    ],
    [
      'an unsafe entry path',
      (document: Record<string, unknown>, _dshHome: string, sha256: string) =>
        (document.entries = [{ target: '../outside', sha256 }]),
    ],
    [
      'case-colliding entries',
      (document: Record<string, unknown>, _dshHome: string, sha256: string) =>
        (document.entries = [
          { target: 'skills/notes/SKILL.md', sha256 },
          { target: 'skills/notes/skill.md', sha256 },
        ]),
    ],
    [
      'an invalid settings contribution',
      (document: Record<string, unknown>) =>
        (document.settingsContribution = { namespace: 'other', keys: [] }),
    ],
    [
      'metadata from a different generation',
      (document: Record<string, unknown>) => {
        (document.metadata as Record<string, unknown>).generation = 1;
      },
    ],
    ['an invalid operation', (document: Record<string, unknown>) => (document.operation = 'bad')],
  ] as const)('rejects a generation with %s', async (_reason, mutate) => {
    const dshHome = await home();
    const profile = 'demo-pack';
    const sha256 = digest(Buffer.from('generation parser contract'));
    const document = generation(profile, dshHome, sha256);
    mutate(document, dshHome, sha256);
    await writeGeneration(dshHome, profile, document);

    await expect(readGeneration(dshHome, profile, 2)).rejects.toMatchObject({
      kind: 'contract',
      diagnostic: { code: 'E_MANAGEMENT_GENERATION' },
    });
  });

  it.each([
    { kind: 'directory', path: resolve('packs', 'demo-pack') },
    { kind: 'archive', path: resolve('packs', 'demo-pack.tgz') },
    { kind: 'https', url: 'https://example.test/demo-pack.tgz', integrity: sourceIntegrity },
    {
      kind: 'github',
      owner: 'example-owner',
      repo: 'demo-pack',
      commit: 'a'.repeat(40),
      url: `https://codeload.github.com/example-owner/demo-pack/tar.gz/${'a'.repeat(40)}`,
    },
  ] as const)('accepts the persisted source provenance variant %s', async (source) => {
    const dshHome = await home();
    const sha256 = digest(Buffer.from('source provenance variant'));
    const document = generation('demo-pack', dshHome, sha256);
    document.source = source;
    await writeGeneration(dshHome, 'demo-pack', document);

    await expect(readGeneration(dshHome, 'demo-pack', 2)).resolves.toMatchObject({ source });
  });

  it('fails closed when persisted HTTPS source integrity has a SHA-512 pad-bit alias', async () => {
    const dshHome = await home();
    const profile = 'demo-pack';
    const sha256 = digest(Buffer.from('source integrity alias'));
    const document = generation(profile, dshHome, sha256);
    document.source = {
      kind: 'https',
      url: 'https://example.test/demo-pack.tgz',
      integrity: sha512PadBitAlias(sourceIntegrity),
    };
    await writeGeneration(dshHome, profile, document);

    await expect(readGeneration(dshHome, profile, 2)).rejects.toMatchObject({
      kind: 'contract',
      diagnostic: { code: 'E_MANAGEMENT_GENERATION' },
    });
  });
});
