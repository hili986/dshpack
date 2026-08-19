import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { inspectMetadata } from '../src/list/contracts.js';
import {
  assessThreeWayEligibility,
  classifyAssetDrift,
  countMetadataAssetTargetReferences,
  countTargetReferences,
  type InstalledMetadataV0,
  type InstalledMetadataV1,
  isCanonicalSha256Sri,
  isCanonicalSha512Sri,
  type MetadataAsset,
  parseInstalledMetadata,
} from '../src/metadata/contracts.js';
import { settingsContribution } from '../src/metadata/state-storage.js';
import { GENERATED_BY } from '../src/version.js';

function sri(algorithm: 'sha256' | 'sha512', value: string): string {
  return `${algorithm}-${createHash(algorithm).update(value).digest('base64url')}`;
}

const SHA256_A = sri('sha256', 'metadata fixture A');
const SHA256_B = sri('sha256', 'metadata fixture B');
const SHA512 = `sha512-${createHash('sha512').update('metadata fixture SHA-512').digest('base64')}`;

function v0(profile = 'demo-pack'): InstalledMetadataV0 {
  return {
    metadataVersion: 0,
    profile,
    pack: { name: profile, version: '1.2.3', manifestDigest: SHA256_A },
    planDigest: SHA256_B,
    installedAt: '2026-08-17T01:08:44.296Z',
    txid: 'tx-1',
    source: { kind: 'directory', path: resolve('packs', 'demo-pack') },
    defaults: { agentPreset: 'demo-preset', permissionPreset: 'workspace-write' },
    plugins: [],
    effectiveLock: {
      lockVersion: 0,
      manifestSha256: SHA256_A,
      generatedBy: GENERATED_BY,
      generatedAt: '2026-08-17T01:08:44.296Z',
      dsh: { exportedFrom: '0.1.0-rc.6' },
      plugins: [],
      files: [],
    },
    sideEffects: ['profile/cordis.yml'],
  };
}

function v1(profile = 'demo-pack'): InstalledMetadataV1 {
  return {
    ...v0(profile),
    metadataVersion: 1,
    assets: [
      {
        id: 'paper-outline',
        kind: 'skill',
        target: 'skills/paper-outline',
        action: 'create',
        identity: '1:2:3',
        files: [{ path: 'SKILL.md', sha256: SHA256_A, bytes: 4096 }],
      },
    ],
    settingsContribution: settingsContribution({ custom: 'installed value' }),
    generation: 3,
    installedBy: GENERATED_BY,
  };
}

function withPlugin(
  resolved: { version: string } | { commit: string } | { url: string },
  integrity:
    | { kind: 'npm-sri'; value: string }
    | { kind: 'git-commit'; value: string }
    | { kind: 'sha512'; value: string }
    | { kind: 'unverified'; reason: string },
): InstalledMetadataV0 {
  const metadata = v0();
  const plugin = {
    name: 'plugin-name',
    packageJsonSha512: SHA512,
    bundlePatch: 'patch/plugin.yml',
    actualResolved: resolved,
    actualIntegrity: integrity,
  };
  return {
    ...metadata,
    plugins: [plugin],
    effectiveLock: {
      ...metadata.effectiveLock,
      plugins: [
        {
          name: plugin.name,
          resolved: plugin.actualResolved,
          integrity: plugin.actualIntegrity,
          packageJsonSha512: plugin.packageJsonSha512,
          bundlePatch: plugin.bundlePatch,
        },
      ],
    },
  };
}

function firstAsset(metadata: InstalledMetadataV1): MetadataAsset {
  const asset = metadata.assets.at(0);
  if (asset === undefined) throw new Error('metadata fixture needs one asset');
  return asset;
}

function firstAssetFile(asset: MetadataAsset): MetadataAsset['files'][number] {
  const file = asset.files.at(0);
  if (file === undefined) throw new Error('asset fixture needs one file');
  return file;
}

function settingEntry(key: string, value: unknown) {
  const entry = settingsContribution({ [key]: value }).keys[0];
  if (entry === undefined) throw new Error('settings fixture needs one contribution entry');
  return entry;
}

function sha256PadBitAlias(digest: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = digest.at(-1);
  if (last === undefined) throw new Error('SHA-256 fixture is empty');
  const index = alphabet.indexOf(last);
  if (index < 0 || index % 4 !== 0) throw new Error('SHA-256 fixture is not canonical');
  return `${digest.slice(0, -1)}${alphabet[index + 1]}`;
}

function sha512PadBitAlias(digest: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lastBase64Character = digest.length - 3;
  const character = digest[lastBase64Character];
  if (character === undefined) throw new Error('SHA-512 fixture is empty');
  const index = alphabet.indexOf(character);
  if (index < 0 || index % 16 !== 0) throw new Error('SHA-512 fixture is not canonical');
  return `${digest.slice(0, lastBase64Character)}${alphabet[index + 1]}==`;
}

describe('installed metadata v1 contract', () => {
  it('reads installed v0 and v1 marker files with their explicit management modes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack-metadata-contract-'));
    try {
      const installed = join(root, '.dshpack', 'installed');
      await mkdir(installed, { recursive: true });
      await writeFile(join(installed, 'legacy-pack.json'), JSON.stringify(v0('legacy-pack')));
      await writeFile(join(installed, 'current-pack.json'), JSON.stringify(v1('current-pack')));

      await expect(inspectMetadata(root, 'legacy-pack')).resolves.toMatchObject({
        status: 'valid',
        mode: 'legacy',
      });
      await expect(inspectMetadata(root, 'current-pack')).resolves.toMatchObject({
        status: 'valid',
        mode: 'full',
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('rejects an unsafe metadata profile before it can read an escaped marker path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack-metadata-contract-'));
    let fileReads = 0;
    try {
      await mkdir(join(root, '.dshpack', 'installed'), { recursive: true });
      await writeFile(join(root, 'outside.json'), JSON.stringify(v0('outside')));

      await expect(
        inspectMetadata(root, '..\\..\\outside', {
          afterFileLstat: async () => {
            fileReads += 1;
          },
        }),
      ).resolves.toMatchObject({ status: 'broken', failureKind: 'contract' });
      expect(fileReads).toBe(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('gives direct and list reads one v0 contract result, including the standard preset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack-metadata-contract-'));
    const metadata: InstalledMetadataV0 = {
      ...v0('standard-pack'),
      defaults: { agentPreset: 'standard', permissionPreset: 'workspace-write' },
    };
    try {
      const installed = join(root, '.dshpack', 'installed');
      await mkdir(installed, { recursive: true });
      await writeFile(join(installed, 'standard-pack.json'), JSON.stringify(metadata));

      expect(parseInstalledMetadata(metadata, metadata.profile)).toEqual({ ok: false });
      await expect(inspectMetadata(root, metadata.profile)).resolves.toMatchObject({
        status: 'broken',
        failureKind: 'contract',
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('reads valid v0 metadata in explicit legacy mode', () => {
    const metadata = v0();

    expect(parseInstalledMetadata(metadata, metadata.profile)).toEqual({
      ok: true,
      metadata,
      mode: 'legacy',
    });
  });

  it('reads a fully specified v1 record in full mode', () => {
    const metadata = v1();

    expect(parseInstalledMetadata(metadata, metadata.profile)).toEqual({
      ok: true,
      metadata,
      mode: 'full',
    });
  });

  it('rejects SHA-256 SRI pad-bit aliases in persisted settings contributions', () => {
    const metadata = v1();
    const entry = settingEntry('alias-check', 'value');
    const alias = sha256PadBitAlias(entry.valueSha256);
    metadata.settingsContribution = {
      namespace: 'agent-presets',
      keys: [{ ...entry, valueSha256: alias }],
    };

    expect(isCanonicalSha256Sri(entry.valueSha256)).toBe(true);
    expect(isCanonicalSha256Sri(alias)).toBe(false);
    expect(parseInstalledMetadata(metadata, metadata.profile)).toEqual({ ok: false });
  });

  it.each([
    [
      'pack manifestDigest',
      (metadata: InstalledMetadataV1, alias: string) => {
        metadata.pack = { ...metadata.pack, manifestDigest: alias };
      },
    ],
    [
      'planDigest',
      (metadata: InstalledMetadataV1, alias: string) => {
        metadata.planDigest = alias;
      },
    ],
    [
      'asset file sha256',
      (metadata: InstalledMetadataV1, alias: string) => {
        const asset = firstAsset(metadata);
        metadata.assets = [{ ...asset, files: [{ ...firstAssetFile(asset), sha256: alias }] }];
      },
    ],
  ])('rejects a SHA-256 pad-bit alias in persisted $name', (_name, mutate) => {
    const metadata = v1();
    const alias = sha256PadBitAlias(SHA256_A);
    mutate(metadata, alias);

    expect(isCanonicalSha256Sri(SHA256_A)).toBe(true);
    expect(isCanonicalSha256Sri(alias)).toBe(false);
    expect(parseInstalledMetadata(metadata, metadata.profile)).toEqual({ ok: false });
  });

  it.each([
    [
      'HTTPS source integrity',
      (metadata: InstalledMetadataV1, alias: string) => {
        metadata.source = {
          kind: 'https',
          url: 'https://example.test/demo-pack.tgz',
          integrity: alias,
        };
      },
    ],
    [
      'plugin packageJsonSha512',
      (metadata: InstalledMetadataV1, alias: string) => {
        const plugin = withPlugin({ version: '1.2.3' }, { kind: 'npm-sri', value: SHA512 });
        metadata.plugins = plugin.plugins.map((entry) => ({ ...entry, packageJsonSha512: alias }));
        metadata.effectiveLock = plugin.effectiveLock;
      },
    ],
    [
      'plugin npm-sri integrity',
      (metadata: InstalledMetadataV1, alias: string) => {
        const plugin = withPlugin({ version: '1.2.3' }, { kind: 'npm-sri', value: SHA512 });
        metadata.plugins = plugin.plugins.map((entry) => ({
          ...entry,
          actualIntegrity: { kind: 'npm-sri', value: alias },
        }));
        metadata.effectiveLock = plugin.effectiveLock;
      },
    ],
    [
      'plugin sha512 integrity',
      (metadata: InstalledMetadataV1, alias: string) => {
        const plugin = withPlugin(
          { url: 'https://example.test/plugin.tgz' },
          { kind: 'sha512', value: SHA512 },
        );
        metadata.plugins = plugin.plugins.map((entry) => ({
          ...entry,
          actualIntegrity: { kind: 'sha512', value: alias },
        }));
        metadata.effectiveLock = plugin.effectiveLock;
      },
    ],
  ])('rejects a SHA-512 pad-bit alias in persisted $name', (_name, mutate) => {
    const metadata = v1();
    const alias = sha512PadBitAlias(SHA512);
    mutate(metadata, alias);

    expect(isCanonicalSha512Sri(SHA512)).toBe(true);
    expect(isCanonicalSha512Sri(alias)).toBe(false);
    expect(parseInstalledMetadata(metadata, metadata.profile)).toEqual({ ok: false });
  });

  it('rejects persisted settings contributions whose keys are not canonical-key ordered', () => {
    const metadata = v1();
    const first = settingEntry('a-key', 1);
    const second = settingEntry('b-key', 2);
    metadata.settingsContribution = {
      namespace: 'agent-presets',
      keys: [second, first],
    };

    expect(parseInstalledMetadata(metadata, metadata.profile)).toEqual({ ok: false });
  });

  it('rejects non-records, unsupported versions, and marker/profile mismatches', () => {
    const metadata = v1();

    for (const value of [null, [], { metadataVersion: 2 }, { ...metadata, metadataVersion: 99 }])
      expect(parseInstalledMetadata(value, metadata.profile)).toEqual({ ok: false });
    expect(parseInstalledMetadata(metadata, 'other-pack')).toEqual({
      ok: false,
      reason: 'profile-mismatch',
    });
  });

  it('accepts every supported source provenance and plugin resolution/integrity pairing', () => {
    for (const source of [
      { kind: 'directory', path: resolve('packs', 'demo-pack') },
      { kind: 'archive', path: resolve('packs', 'demo-pack.tgz') },
      { kind: 'file', path: resolve('packs', 'demo-pack.tgz'), integrity: SHA512 },
      { kind: 'https', url: 'https://example.test/demo-pack.tgz', integrity: SHA512 },
      {
        kind: 'github',
        owner: 'owner',
        repo: 'repo',
        commit: 'a'.repeat(40),
        url: `https://codeload.github.com/owner/repo/tar.gz/${'a'.repeat(40)}`,
      },
    ]) {
      const metadata = { ...v0(), source };
      expect(parseInstalledMetadata(metadata, metadata.profile)).toMatchObject({ ok: true });
    }
    for (const [resolved, integrity] of [
      [{ version: '1.2.3' }, { kind: 'npm-sri', value: SHA512 }],
      [{ commit: 'a'.repeat(40) }, { kind: 'git-commit', value: 'a'.repeat(40) }],
      [{ url: 'https://example.test/plugin.tgz' }, { kind: 'sha512', value: SHA512 }],
      [{ url: 'https://example.test/plugin.tgz' }, { kind: 'unverified', reason: 'explicit test' }],
    ] as const) {
      const metadata = withPlugin(resolved, integrity);
      expect(parseInstalledMetadata(metadata, metadata.profile)).toMatchObject({ ok: true });
    }
  });

  it('accepts each kind-specific asset root and an empty settings contribution', () => {
    const metadata = v1();
    const asset = firstAsset(metadata);
    metadata.assets = [
      asset,
      { ...asset, id: 'demo-preset', kind: 'preset', target: '.agent-presets/demo-preset' },
      { ...asset, id: 'demo-pack', kind: 'profile', target: 'profiles/demo-pack' },
      {
        ...asset,
        id: 'managed-record',
        kind: 'managed-document',
        target: '.dshpack/managed/managed-record.json',
      },
    ];
    metadata.settingsContribution = { namespace: 'agent-presets', keys: [] };

    expect(parseInstalledMetadata(metadata, metadata.profile)).toMatchObject({
      ok: true,
      mode: 'full',
    });
  });

  it('accepts the core kebab-case asset ids that start with a digit', () => {
    const metadata = v1();
    const asset = firstAsset(metadata);
    const valid: InstalledMetadataV1[] = [
      { ...metadata, assets: [{ ...asset, id: '3d-tools', target: 'skills/3d-tools' }] },
      {
        ...metadata,
        assets: [
          {
            ...asset,
            id: '3d-preset',
            kind: 'preset',
            target: '.agent-presets/3d-preset',
          },
        ],
      },
    ];

    for (const value of valid)
      expect(parseInstalledMetadata(value, value.profile)).toMatchObject({
        ok: true,
        mode: 'full',
      });
    expect(
      parseInstalledMetadata(
        { ...metadata, assets: [{ ...asset, id: '3D-tools', target: 'skills/3d-tools' }] },
        metadata.profile,
      ),
    ).toEqual({ ok: false });
  });

  it('strictly rejects malformed v1-only fields and unknown properties', () => {
    const metadata = v1();
    const asset = firstAsset(metadata);
    const invalid: unknown[] = [
      { ...metadata, assets: [] },
      { ...metadata, assets: [{ ...asset, id: 'bad/id' }] },
      { ...metadata, assets: [{ ...asset, id: 'con', target: 'skills/con' }] },
      { ...metadata, assets: [{ ...asset, kind: 'skill', target: 'presets/wrong' }] },
      { ...metadata, assets: [{ ...asset, target: 'skills/../escape' }] },
      { ...metadata, assets: [{ ...asset, action: 'delete' }] },
      { ...metadata, assets: [{ ...asset, identity: '1:2' }] },
      { ...metadata, assets: [{ ...asset, files: [] }] },
      {
        ...metadata,
        assets: [{ ...asset, files: [{ ...asset.files[0], path: '../SKILL.md' }] }],
      },
      {
        ...metadata,
        assets: [{ ...asset, files: [{ ...asset.files[0], sha256: 'sha256-short' }] }],
      },
      {
        ...metadata,
        assets: [{ ...asset, files: [{ ...asset.files[0], bytes: -1 }] }],
      },
      { ...metadata, settingsContribution: { namespace: 'other', keys: [] } },
      { ...metadata, settingsContribution: { namespace: 'agent-presets', keys: [{}] } },
      { ...metadata, generation: 0 },
      { ...metadata, generation: 1.5 },
      { ...metadata, installedBy: 'another-tool@1.2.3' },
      { ...metadata, installedBy: 'dshpack@not-a-semver' },
      { ...metadata, unexpected: true },
    ];

    for (const value of invalid)
      expect(parseInstalledMetadata(value, metadata.profile)).toEqual({ ok: false });
  });

  it('rejects v1 duplicate ownership claims and unsafe settings keys', () => {
    const metadata = v1();
    const asset = firstAsset(metadata);
    const file = firstAssetFile(asset);
    const invalid: unknown[] = [
      { ...metadata, assets: [asset, { ...asset, id: 'another-id' }] },
      { ...metadata, assets: [asset, { ...asset, target: 'skills/another' }] },
      { ...metadata, assets: [{ ...asset, files: [file, { ...file, sha256: SHA256_B }] }] },
      {
        ...metadata,
        settingsContribution: {
          namespace: 'agent-presets',
          keys: [settingEntry('duplicate', 'first'), settingEntry('duplicate', 'second')],
        },
      },
      {
        ...metadata,
        assets: [asset, { ...asset, id: 'case-alias', target: 'skills/PAPER-outline' }],
      },
      {
        ...metadata,
        settingsContribution: {
          namespace: 'agent-presets',
          keys: [
            {
              ...settingEntry('bad-hash', 'value'),
              valueSha256: 'sha256-short',
            },
          ],
        },
      },
      {
        ...metadata,
        settingsContribution: {
          namespace: 'agent-presets',
          keys: [{ ...settingEntry('custom', 'value'), key: 1 }],
        },
      },
    ];

    for (const value of invalid)
      expect(parseInstalledMetadata(value, metadata.profile)).toEqual({ ok: false });
  });

  it('preserves every M0-accepted agent-presets leaf key and rejects only exact duplicates', () => {
    const metadata = v1();
    const contribution = settingsContribution({
      'bad/key': 'slash',
      snake_case: 'underscore',
      Upper: 'upper-case',
      upper: 'lower-case',
    });

    expect(
      parseInstalledMetadata({ ...metadata, settingsContribution: contribution }, metadata.profile),
    ).toMatchObject({ ok: true, mode: 'full' });
    expect(
      parseInstalledMetadata(
        {
          ...metadata,
          settingsContribution: {
            ...contribution,
            keys: [...contribution.keys, contribution.keys[0]],
          },
        },
        metadata.profile,
      ),
    ).toEqual({ ok: false });
  });

  it('rejects Windows-reserved, ADS, trailing-dot, and NFC-alias asset file paths', () => {
    const metadata = v1();
    const asset = firstAsset(metadata);
    const file = firstAssetFile(asset);
    const invalid: InstalledMetadataV1[] = [
      { ...metadata, assets: [{ ...asset, files: [{ ...file, path: 'CON' }] }] },
      {
        ...metadata,
        assets: [{ ...asset, files: [{ ...file, path: 'note.txt:secret' }] }],
      },
      { ...metadata, assets: [{ ...asset, files: [{ ...file, path: 'trailing.' }] }] },
      {
        ...metadata,
        assets: [
          {
            ...asset,
            files: [
              { ...file, path: 'caf\u00e9.md' },
              { ...file, path: 'cafe\u0301.md' },
            ],
          },
        ],
      },
    ];

    for (const value of invalid)
      expect(parseInstalledMetadata(value, metadata.profile)).toEqual({ ok: false });
  });

  it('rejects a Windows-reserved asset target segment', () => {
    const metadata = v1();
    const asset = firstAsset(metadata);

    expect(
      parseInstalledMetadata(
        { ...metadata, assets: [{ ...asset, id: 'con', target: 'skills/con' }] },
        metadata.profile,
      ),
    ).toEqual({ ok: false });
  });

  it('retains strict v0 baseline validation when parsing v1 metadata', () => {
    const metadata = v1();
    const invalid: unknown[] = [
      { ...metadata, planDigest: SHA512 },
      { ...metadata, pack: { ...metadata.pack, version: 'latest' } },
      { ...metadata, source: { kind: 'directory', path: 'relative-pack' } },
      { ...metadata, effectiveLock: { ...metadata.effectiveLock, manifestSha256: SHA256_B } },
      {
        ...metadata,
        effectiveLock: {
          ...metadata.effectiveLock,
          files: [{ path: 'CON', sha512: SHA512 }],
        },
      },
    ];

    for (const value of invalid)
      expect(parseInstalledMetadata(value, metadata.profile)).toEqual({ ok: false });
  });

  it('binds profile assets to this metadata profile and forbids self-marker assets', () => {
    const metadata = v1();
    const asset = firstAsset(metadata);
    const invalid: InstalledMetadataV1[] = [
      { ...metadata, assets: [{ ...asset, target: 'skills/another-skill' }] },
      {
        ...metadata,
        assets: [{ ...asset, kind: 'preset', target: '.agent-presets/another-preset' }],
      },
      {
        ...metadata,
        assets: [{ ...asset, id: 'victim-pack', kind: 'profile', target: 'profiles/victim-pack' }],
      },
      {
        ...metadata,
        assets: [{ ...asset, id: 'demo-pack', kind: 'profile', target: 'profiles/victim-pack' }],
      },
      {
        ...metadata,
        assets: [
          {
            ...asset,
            id: 'demo-pack',
            kind: 'managed-document',
            target: '.dshpack/installed/demo-pack.json',
          },
        ],
      },
      {
        ...metadata,
        assets: [
          {
            ...asset,
            id: 'demo-pack',
            kind: 'managed-document',
            target: '.dshpack/installed/victim-pack.json',
          },
        ],
      },
    ];

    for (const value of invalid)
      expect(parseInstalledMetadata(value, metadata.profile)).toEqual({ ok: false });
  });
});

describe('metadata management predicates', () => {
  it('rejects three-way operations only for legacy metadata and includes the profile migration hint', () => {
    expect(assessThreeWayEligibility(v1())).toEqual({ eligible: true });
    expect(assessThreeWayEligibility(v0('legacy-pack'))).toEqual({
      eligible: false,
      hint: 'dshpack migrate legacy-pack',
      reason: 'legacy-metadata',
    });
  });

  it('classifies an asset with matching identity and recursive file facts as intact', () => {
    const asset = firstAsset(v1());

    expect(classifyAssetDrift(asset, { identity: asset.identity, files: asset.files })).toBe(
      'intact',
    );
  });

  it('treats a case-only asset file spelling change as intact', () => {
    const asset = firstAsset(v1());
    const file = firstAssetFile(asset);

    expect(
      classifyAssetDrift(asset, {
        identity: asset.identity,
        files: [{ ...file, path: 'skill.md' }],
      }),
    ).toBe('intact');
  });

  it('conservatively classifies case-colliding asset file inputs as modified', () => {
    const asset = firstAsset(v1());
    const file = firstAssetFile(asset);
    const colliding = { ...asset, files: [file, { ...file, path: 'skill.md' }] };

    expect(
      classifyAssetDrift(colliding, {
        identity: colliding.identity,
        files: colliding.files,
      }),
    ).toBe('modified');
  });

  it('classifies replacement, content, byte-count, and file-set changes as modified', () => {
    const asset = firstAsset(v1());
    const file = firstAssetFile(asset);

    for (const current of [
      { identity: '9:8:7', files: asset.files },
      { identity: asset.identity, files: [{ ...file, sha256: SHA256_B }] },
      { identity: asset.identity, files: [{ ...file, bytes: file.bytes + 1 }] },
      {
        identity: asset.identity,
        files: [...asset.files, { path: 'notes.md', sha256: SHA256_B, bytes: 1 }],
      },
    ])
      expect(classifyAssetDrift(asset, current)).toBe('modified');
  });

  it('gives missing priority when an asset or any tracked file disappeared', () => {
    const asset = firstAsset(v1());

    expect(classifyAssetDrift(asset, undefined)).toBe('missing');
    expect(classifyAssetDrift(asset, { identity: '9:8:7', files: [] })).toBe('missing');
  });

  it('counts portable target ownership from independently valid v1 metadata', () => {
    const first = v1('first-pack');
    const secondWithSharedTarget = v1('second-pack');

    expect(parseInstalledMetadata(first, first.profile)).toMatchObject({ ok: true, mode: 'full' });
    expect(
      parseInstalledMetadata(secondWithSharedTarget, secondWithSharedTarget.profile),
    ).toMatchObject({
      ok: true,
      mode: 'full',
    });

    expect(countMetadataAssetTargetReferences([v0(), first, secondWithSharedTarget])).toEqual({
      counts: new Map([['skills/paper-outline', 2]]),
      legacyProfiles: ['demo-pack'],
    });
    expect(
      countTargetReferences([
        [{ target: 'skills/paper-outline' }],
        [{ target: 'skills/paper-outline' }, { target: 'profiles/second-pack' }],
      ]),
    ).toEqual(
      new Map([
        ['skills/paper-outline', 2],
        ['profiles/second-pack', 1],
      ]),
    );
    expect(
      countTargetReferences([[{ target: 'skills/shared' }], [{ target: 'skills/SHARED' }]]),
    ).toEqual(new Map([['skills/shared', 2]]));
  });

  it('does not treat a skipped asset observation as an ownership reference', () => {
    const owner = v1('owner-pack');
    const skipped = v1('observer-pack');
    const skippedAsset = firstAsset(skipped);
    skipped.assets = [{ ...skippedAsset, action: 'skip' }];

    expect(countMetadataAssetTargetReferences([owner, skipped])).toEqual({
      counts: new Map([['skills/paper-outline', 1]]),
      legacyProfiles: [],
    });
  });
});
