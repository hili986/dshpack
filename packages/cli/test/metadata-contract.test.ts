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
  type MetadataAsset,
  parseInstalledMetadata,
} from '../src/metadata/contracts.js';
import { GENERATED_BY } from '../src/version.js';

const SHA256_A = `sha256-${'a'.repeat(43)}`;
const SHA256_B = `sha256-${'b'.repeat(43)}`;
const SHA512 = `sha512-${'a'.repeat(86)}==`;

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
    settingsContribution: {
      namespace: 'agent-presets',
      keys: [{ key: 'custom', valueSha256: SHA256_B }],
    },
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
          keys: [
            { key: 'duplicate', valueSha256: SHA256_A },
            { key: 'duplicate', valueSha256: SHA256_B },
          ],
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
          keys: [{ key: 'bad-hash', valueSha256: 'sha256-short' }],
        },
      },
      {
        ...metadata,
        settingsContribution: {
          namespace: 'agent-presets',
          keys: [{ key: 1, valueSha256: SHA256_A }],
        },
      },
    ];

    for (const value of invalid)
      expect(parseInstalledMetadata(value, metadata.profile)).toEqual({ ok: false });
  });

  it('preserves every M0-accepted agent-presets leaf key and rejects only exact duplicates', () => {
    const metadata = v1();
    const contribution = {
      namespace: 'agent-presets' as const,
      keys: [
        { key: 'bad/key', valueSha256: SHA256_A },
        { key: 'snake_case', valueSha256: SHA256_B },
        { key: 'Upper', valueSha256: SHA256_A },
        { key: 'upper', valueSha256: SHA256_B },
      ],
    };

    expect(
      parseInstalledMetadata({ ...metadata, settingsContribution: contribution }, metadata.profile),
    ).toMatchObject({ ok: true, mode: 'full' });
    expect(
      parseInstalledMetadata(
        {
          ...metadata,
          settingsContribution: {
            ...contribution,
            keys: [...contribution.keys, { key: 'bad/key', valueSha256: SHA256_B }],
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
});
