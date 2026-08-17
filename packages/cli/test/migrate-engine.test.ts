import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SourceError } from '../src/adapters/source.js';
import { installPack } from '../src/install/engine.js';
import { captureInstallTargetState } from '../src/install/runtime-state.js';
import type { InstalledMetadataV0, InstalledMetadataV1 } from '../src/metadata/contracts.js';
import { casStoreShard } from '../src/metadata/state-storage.js';
import { migrateProfile } from '../src/migrate/engine.js';
import { TransactionFailure } from '../src/transaction.js';
import { enginePack, fakeRuntime, snapshot } from './install-engine-fixture.js';

const roots: string[] = [];

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-migrate-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function sha256(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
}

function storePath(dshHome: string, digest: string): string {
  return join(dshHome, '.dshpack', 'store', casStoreShard(digest), digest);
}

async function fileSnapshot(
  path: string,
): Promise<{ bytes: Buffer; identity: string; mtimeNs: string }> {
  const metadata = await lstat(path, { bigint: true });
  return {
    bytes: await readFile(path),
    identity: `${metadata.dev}:${metadata.ino}:${metadata.birthtimeNs}`,
    mtimeNs: metadata.mtimeNs.toString(),
  };
}

async function downgradeToV0(dshHome: string, profile: string): Promise<InstalledMetadataV0> {
  const path = join(dshHome, '.dshpack', 'installed', `${profile}.json`);
  const marker = await readJson<InstalledMetadataV1>(path);
  const {
    assets: _assets,
    generation: _generation,
    installedBy: _installedBy,
    settingsContribution: _settings,
    ...base
  } = marker;
  const legacy: InstalledMetadataV0 = { ...base, metadataVersion: 0 };
  await writeFile(path, `${JSON.stringify(legacy)}\n`);
  return legacy;
}

async function legacyInstall(
  dshHome: string,
  source: string,
  policy: {
    allowBuilds?: readonly string[];
    allowDangerFullAccess?: boolean;
    allowUnverified?: boolean;
    allowVersionMismatch?: boolean;
  } = {},
): Promise<InstalledMetadataV0> {
  const installed = await installPack(
    { source, dshHome, yes: true, interactive: false, ...policy },
    fakeRuntime().runtime,
  );
  expect(installed.exitCode).toBe(0);
  return downgradeToV0(dshHome, 'engine-pack');
}

async function removeV1State(dshHome: string): Promise<void> {
  await Promise.all([
    rm(join(dshHome, '.dshpack', 'store'), { recursive: true, force: true }),
    rm(join(dshHome, '.dshpack', 'generations'), { recursive: true, force: true }),
  ]);
}

async function logicalSnapshot(dshHome: string): Promise<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(await snapshot(dshHome)).filter(
      ([path]) => !path.replaceAll('\\', '/').startsWith('.dshpack/backups/'),
    ),
  );
}

describe('migrate v0 metadata', () => {
  it('replays declared build, dangerous, and version-mismatch history when the isolated audit finds no scripts', async () => {
    const dshHome = await home();
    const source = await enginePack({
      assets: true,
      permissionPreset: 'danger-full-access',
      plugin: { allowBuilds: true },
      tested: ['9.9.9'],
    });
    await legacyInstall(dshHome, source, {
      allowBuilds: ['example-bundle'],
      allowDangerFullAccess: true,
      allowVersionMismatch: true,
    });
    const fixture = fakeRuntime();
    let scratchCalls: readonly string[] = [];
    let scratchPolicies: readonly { command: string; policy: string | undefined }[] = [];
    fixture.runtime.createScratchRuntime = () => {
      const created = fakeRuntime();
      scratchCalls = created.calls;
      scratchPolicies = created.scriptPolicies;
      const scratch = created.runtime;
      scratch.auditInstalledBuildScripts = async () => ({
        approvedDirect: [],
        transitive: [],
        unapprovedDirectBuildKeys: [],
        unexpectedTransitiveBuildKeys: [],
      });
      scratch.authorizeBuild = async () => {
        throw new Error('static declaration must not authorize a script');
      };
      return scratch;
    };

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({ exitCode: 0, metadata: { status: 'migrated' } });
    expect(scratchCalls).not.toContain('authorize:example-bundle');
    expect(scratchPolicies).not.toContainEqual({
      command: 'pnpm',
      policy: 'allow-approved',
    });
  });

  it('rejects a legacy build declaration when isolated reconstruction discovers an actual script', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true, plugin: { allowBuilds: true } });
    await legacyInstall(dshHome, source, { allowBuilds: ['example-bundle'] });
    const before = await snapshot(dshHome);

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fakeRuntime().runtime,
    );

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_BASE_REBUILD' })],
      metadata: { status: 'not-started' },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('rejects an unverified legacy plugin before it creates scratch migration state', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true, plugin: { unverified: true } });
    const legacy = await legacyInstall(dshHome, source, { allowUnverified: true });
    const unverifiedLegacy = {
      ...legacy,
      plugins: legacy.plugins.map((plugin) => ({
        ...plugin,
        actualIntegrity: { kind: 'unverified', reason: 'legacy had no immutable fact' },
      })),
      effectiveLock: {
        ...legacy.effectiveLock,
        plugins: legacy.effectiveLock.plugins.map((plugin) => ({
          ...plugin,
          integrity: { kind: 'unverified', reason: 'legacy had no immutable fact' },
        })),
      },
    };
    await writeFile(
      join(dshHome, '.dshpack', 'installed', 'engine-pack.json'),
      `${JSON.stringify(unverifiedLegacy)}\n`,
    );
    const before = await snapshot(dshHome);

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fakeRuntime().runtime,
    );

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_UNVERIFIED_BASE' })],
      metadata: { status: 'not-started' },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('re-fetches the recorded source and atomically rebuilds v1 marker, CAS, and generation facts', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    const legacy = await legacyInstall(dshHome, source);

    const fixture = fakeRuntime();
    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: { status: 'migrated', profile: 'engine-pack' },
    });
    expect(fixture.calls).toContain(`materialize:${source}`);
    const marker = await readJson<InstalledMetadataV1>(
      join(dshHome, '.dshpack', 'installed', 'engine-pack.json'),
    );
    expect(marker).toMatchObject({
      metadataVersion: 1,
      source: legacy.source,
      pack: legacy.pack,
      generation: 2,
      settingsContribution: {
        namespace: 'agent-presets',
        keys: [expect.objectContaining({ key: 'custom' })],
      },
    });
    expect({
      profile: marker.profile,
      pack: marker.pack,
      planDigest: marker.planDigest,
      installedAt: marker.installedAt,
      txid: marker.txid,
      source: marker.source,
      defaults: marker.defaults,
      plugins: marker.plugins,
      effectiveLock: marker.effectiveLock,
    }).toEqual({
      profile: legacy.profile,
      pack: legacy.pack,
      planDigest: legacy.planDigest,
      installedAt: legacy.installedAt,
      txid: legacy.txid,
      source: legacy.source,
      defaults: legacy.defaults,
      plugins: legacy.plugins,
      effectiveLock: legacy.effectiveLock,
    });
    expect(marker.assets.map((asset) => asset.kind).sort()).toEqual(['preset', 'profile', 'skill']);

    const generation = await readJson<{
      seq: number;
      operation: string;
      entries: Array<{ target: string; sha256: string }>;
    }>(join(dshHome, '.dshpack', 'generations', 'engine-pack', '0002.json'));
    expect(generation).toMatchObject({ seq: 2, operation: 'install' });
    expect(generation.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'profiles/engine-pack/cordis.patch.yml' }),
      ]),
    );
    expect(generation.entries.some((entry) => entry.target.startsWith('skills/notes/'))).toBe(
      false,
    );
    expect(
      generation.entries.some((entry) => entry.target.startsWith('.agent-presets/custom/')),
    ).toBe(false);
    expect(marker.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'skill', action: 'skip' }),
        expect.objectContaining({ kind: 'preset', action: 'skip' }),
      ]),
    );
    for (const entry of generation.entries) {
      const bytes = await readFile(storePath(dshHome, entry.sha256));
      expect(sha256(bytes)).toBe(entry.sha256);
    }
    expect(
      await readFile(join(dshHome, '.dshpack', 'generations', 'engine-pack', 'current'), 'utf8'),
    ).toBe('2\n');
  });

  it('creates the first CAS-backed generation from a true v0-only state', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    await legacyInstall(dshHome, source);
    await removeV1State(dshHome);

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fakeRuntime().runtime,
    );

    expect(report).toMatchObject({ exitCode: 0, metadata: { status: 'migrated', generation: 1 } });
    const marker = await readJson<InstalledMetadataV1>(
      join(dshHome, '.dshpack', 'installed', 'engine-pack.json'),
    );
    expect(marker.generation).toBe(1);
    const generation = await readJson<{ entries: Array<{ sha256: string }> }>(
      join(dshHome, '.dshpack', 'generations', 'engine-pack', '0001.json'),
    );
    expect(generation.entries.length).toBeGreaterThan(0);
    for (const entry of generation.entries)
      await expect(readFile(storePath(dshHome, entry.sha256))).resolves.toBeInstanceOf(Buffer);
    await expect(
      readFile(join(dshHome, '.dshpack', 'generations', 'engine-pack', 'current'), 'utf8'),
    ).resolves.toBe('1\n');
  });

  it('records unknown legacy profile ownership as skip rather than guessing a destructive action', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    const legacy = await legacyInstall(dshHome, source);
    await removeV1State(dshHome);
    await rm(join(dshHome, '.dshpack', 'backups', legacy.txid, 'journal.json'));

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fakeRuntime().runtime,
    );

    expect(report).toMatchObject({ exitCode: 0, metadata: { status: 'migrated' } });
    const marker = await readJson<InstalledMetadataV1>(
      join(dshHome, '.dshpack', 'installed', 'engine-pack.json'),
    );
    expect(marker.assets).toContainEqual(
      expect.objectContaining({ kind: 'profile', action: 'skip' }),
    );
    const generation = await readJson<{ entries: Array<{ target: string }> }>(
      join(dshHome, '.dshpack', 'generations', 'engine-pack', '0001.json'),
    );
    expect(
      generation.entries.some((entry) => entry.target.startsWith('profiles/engine-pack/')),
    ).toBe(false);
  });

  it('rejects a DSH_HOME junction before it reads a marker or materializes source', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    await legacyInstall(dshHome, source);
    const aliasParent = await home();
    const alias = join(aliasParent, 'dsh-home-alias');
    await symlink(dshHome, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const fixture = fakeRuntime();
    fixture.runtime.materializeSource = async () => {
      throw new Error('unsafe root must not materialize source');
    };

    const report = await migrateProfile(
      { dshHome: alias, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_METADATA_READ' })],
      metadata: { status: 'not-started' },
    });
    expect(fixture.calls).toEqual([]);
  });

  it('ignores malformed legacy journal actions and accepts only an exact profile replace proof', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    const legacy = await legacyInstall(dshHome, source);
    await removeV1State(dshHome);
    await writeFile(
      join(dshHome, '.dshpack', 'backups', legacy.txid, 'journal.json'),
      `${JSON.stringify({
        actions: [
          null,
          { kind: 'create', artifact: 'skill', ownership: 'owned', old: { path: 'ignored' } },
          {
            kind: 'replace',
            artifact: 'profile',
            old: { path: join(dshHome, 'profiles', 'engine-pack') },
          },
        ],
      })}\n`,
    );

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fakeRuntime().runtime,
    );

    expect(report).toMatchObject({ exitCode: 0, metadata: { status: 'migrated' } });
    const marker = await readJson<InstalledMetadataV1>(
      join(dshHome, '.dshpack', 'installed', 'engine-pack.json'),
    );
    expect(marker.assets).toContainEqual(
      expect.objectContaining({ kind: 'profile', action: 'replace' }),
    );
  });

  it.each(['symlink', 'hardlink'] as const)(
    'migrates a profile with a runtime node_modules %s without treating it as a managed asset',
    async (kind) => {
      const dshHome = await home();
      const source = await enginePack({ assets: true });
      await legacyInstall(dshHome, source);
      const profile = join(dshHome, 'profiles', 'engine-pack');
      const outside = await home();
      if (kind === 'symlink') {
        await symlink(
          outside,
          join(profile, 'Node_Modules'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } else {
        await mkdir(join(profile, 'NODE_MODULES'), { recursive: true });
        const externalFile = join(outside, 'runtime-fact');
        await writeFile(externalFile, 'runtime-only');
        await link(externalFile, join(profile, 'NODE_MODULES', 'runtime-fact'));
      }
      const fixture = fakeRuntime();
      fixture.runtime.captureTargetState = captureInstallTargetState;

      const report = await migrateProfile(
        { dshHome, profile: 'engine-pack', dryRun: false },
        fixture.runtime,
      );

      expect(report).toMatchObject({ exitCode: 0, metadata: { status: 'migrated' } });
      const marker = await readJson<InstalledMetadataV1>(
        join(dshHome, '.dshpack', 'installed', 'engine-pack.json'),
      );
      const asset = marker.assets.find((candidate) => candidate.kind === 'profile');
      expect(asset?.files.some((file) => /node_modules/u.test(file.path))).toBe(false);
    },
  );

  it('treats v1 metadata as an idempotent no-op without reading source or taking a transaction lock', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    const installed = await installPack(
      { source, dshHome, yes: true, interactive: false },
      fakeRuntime().runtime,
    );
    expect(installed.exitCode).toBe(0);
    const before = await snapshot(dshHome);
    const fixture = fakeRuntime();

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: { status: 'already-current', generation: 1 },
    });
    expect(fixture.calls).toEqual([]);
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('rebuilds and validates source in dry-run mode while leaving all DSH state byte-identical', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    await legacyInstall(dshHome, source);
    const before = await snapshot(dshHome);
    const fixture = fakeRuntime();

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: true },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: { status: 'planned', profile: 'engine-pack' },
    });
    expect(fixture.calls).toContain(`materialize:${source}`);
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it.each([
    ['profile', 'profiles/engine-pack'],
    ['skill', 'skills/notes'],
    ['preset', '.agent-presets/custom'],
  ] as const)(
    'rejects a missing legacy %s equally in dry-run and apply mode',
    async (_kind, target) => {
      const dshHome = await home();
      const source = await enginePack({ assets: true });
      await legacyInstall(dshHome, source);
      await rm(join(dshHome, ...target.split('/')), { recursive: true, force: true });
      const before = await snapshot(dshHome);

      for (const dryRun of [true, false]) {
        const report = await migrateProfile(
          { dshHome, profile: 'engine-pack', dryRun },
          fakeRuntime().runtime,
        );
        expect(report).toMatchObject({
          exitCode: 30,
          diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_TARGET_MISSING' })],
          metadata: { status: 'not-started' },
        });
        expect(await snapshot(dshHome)).toEqual(before);
      }
    },
  );

  it('rejects an unsafe profile before source or state I/O', async () => {
    const dshHome = await home();
    const fixture = fakeRuntime();
    const before = await snapshot(dshHome);

    const report = await migrateProfile(
      { dshHome, profile: '../outside', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_PROFILE' })],
      metadata: { status: 'not-started' },
    });
    expect(fixture.calls).toEqual([]);
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('fails closed on malformed legacy JSON without materializing source or creating transaction state', async () => {
    const dshHome = await home();
    const marker = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
    await mkdir(join(marker, '..'), { recursive: true });
    await writeFile(marker, '{not json\n');
    const before = await snapshot(dshHome);
    const fixture = fakeRuntime();

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_METADATA_INVALID' })],
      metadata: { status: 'not-started' },
    });
    expect(fixture.calls).toEqual([]);
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('rejects an installed-marker junction before source I/O or transaction setup', async () => {
    const dshHome = await home();
    const outside = await home();
    const source = await enginePack({ assets: true });
    await legacyInstall(outside, source);
    const outsideMetadata = join(outside, '.dshpack');
    const alias = join(dshHome, '.dshpack');
    await symlink(outsideMetadata, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const outsideMarker = join(outside, '.dshpack', 'installed', 'engine-pack.json');
    const beforeMarker = await readFile(outsideMarker);
    const fixture = fakeRuntime();

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: true },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_METADATA_READ' })],
      metadata: { status: 'not-started' },
    });
    expect(fixture.calls).toEqual([]);
    expect(await readFile(outsideMarker)).toEqual(beforeMarker);
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
  });

  it('rejects a v0 marker whose declared profile does not match the requested profile', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    const legacy = await legacyInstall(dshHome, source);
    const marker = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
    await writeFile(marker, `${JSON.stringify({ ...legacy, profile: 'other-profile' })}\n`);
    const before = await snapshot(dshHome);
    const fixture = fakeRuntime();

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_METADATA_PROFILE' })],
      metadata: { status: 'not-started' },
    });
    expect(fixture.calls).toEqual([]);
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('classifies a syntactically valid but contract-invalid marker as invalid rather than a profile mismatch', async () => {
    const dshHome = await home();
    const marker = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
    await mkdir(join(marker, '..'), { recursive: true });
    await writeFile(marker, '{}\n');
    const before = await snapshot(dshHome);

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fakeRuntime().runtime,
    );

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_METADATA_INVALID' })],
      metadata: { status: 'not-started' },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('reports an absent installed marker as not-tracked without source or transaction writes', async () => {
    const dshHome = await home();
    const before = await snapshot(dshHome);
    const fixture = fakeRuntime();

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 10,
      diagnostics: [expect.objectContaining({ code: 'E_NOT_TRACKED' })],
      metadata: { status: 'not-started' },
    });
    expect(fixture.calls).toEqual([]);
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('rejects an oversized installed marker before source or transaction writes', async () => {
    const dshHome = await home();
    const marker = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
    await mkdir(join(marker, '..'), { recursive: true });
    await writeFile(marker, Buffer.alloc(1024 * 1024 + 1, 0x20));
    const before = await snapshot(dshHome);
    const fixture = fakeRuntime();

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_METADATA_LIMIT' })],
      metadata: { status: 'not-started' },
    });
    expect(fixture.calls).toEqual([]);
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('returns the source failure before any transaction setup when the recorded source cannot be re-materialized', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    await legacyInstall(dshHome, source);
    const before = await snapshot(dshHome);
    const fixture = fakeRuntime();
    fixture.runtime.materializeSource = async () => {
      throw new SourceError('E_MIGRATE_SOURCE_TEST', 20, 'source unavailable');
    };

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 20,
      diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_SOURCE_TEST' })],
      metadata: { status: 'not-started' },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('maps an unexpected source materialization failure without exposing it or writing state', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    await legacyInstall(dshHome, source);
    const before = await snapshot(dshHome);
    const fixture = fakeRuntime();
    fixture.runtime.materializeSource = async () => {
      throw new Error('private source detail');
    };

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 20,
      diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_SOURCE' })],
      metadata: { status: 'not-started' },
    });
    expect(JSON.stringify(report)).not.toContain('private source detail');
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it.each([
    [
      'source error',
      new SourceError('E_MIGRATE_READ_TEST', 20, 'source read unavailable'),
      20,
      'E_MIGRATE_READ_TEST',
    ],
    ['unexpected error', new Error('private read detail'), 20, 'E_MIGRATE_SOURCE_READ'],
  ] as const)(
    'maps a %s while reading the re-fetched source before state mutation',
    async (_label, failure, exitCode, code) => {
      const dshHome = await home();
      const source = await enginePack({ assets: true });
      await legacyInstall(dshHome, source);
      const before = await snapshot(dshHome);
      const fixture = fakeRuntime();
      fixture.runtime.readValidatedPack = async () => {
        throw failure;
      };

      const report = await migrateProfile(
        { dshHome, profile: 'engine-pack', dryRun: false },
        fixture.runtime,
      );

      expect(report).toMatchObject({
        exitCode,
        diagnostics: [expect.objectContaining({ code })],
        metadata: { status: 'not-started' },
      });
      expect(await snapshot(dshHome)).toEqual(before);
    },
  );

  it('returns a validated source report with no material before transaction setup', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    await legacyInstall(dshHome, source);
    const before = await snapshot(dshHome);
    const fixture = fakeRuntime();
    fixture.runtime.readValidatedPack = async () => ({
      diagnostics: [
        {
          code: 'E_MIGRATE_SOURCE_EMPTY',
          severity: 'error',
          message: 'validated source rejected',
          hint: 'test only',
          evidence: 'local',
        },
      ],
      exitCode: 30,
    });

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_SOURCE_EMPTY' })],
      metadata: { status: 'not-started' },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('fails closed if private source cleanup fails after validation', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    await legacyInstall(dshHome, source);
    const before = await snapshot(dshHome);
    const fixture = fakeRuntime();
    const materialize = fixture.runtime.materializeSource;
    fixture.runtime.materializeSource = async (reference) => {
      const materialized = await materialize(reference);
      return { ...materialized, cleanup: async () => Promise.reject(new Error('cleanup busy')) };
    };

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 25,
      diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_SOURCE_CLEANUP' })],
      metadata: {
        status: 'rollback-failed',
        manualRecovery: [expect.objectContaining({ operation: 'remove-private-source' })],
      },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('reports manual recovery when a failed scratch reconstruction cannot be removed', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    await legacyInstall(dshHome, source);
    const before = await snapshot(dshHome);
    const fixture = fakeRuntime();
    fixture.runtime.createScratchRuntime = () => {
      const scratch = fakeRuntime().runtime;
      scratch.probe = async () => {
        throw new Error('force isolated reconstruction failure');
      };
      return scratch;
    };
    let stranded: string | undefined;
    fixture.runtime.removeScratch = async (path) => {
      stranded = path;
      throw new Error('cleanup busy');
    };

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 25,
      diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_SCRATCH_CLEANUP' })],
      metadata: {
        status: 'rollback-failed',
        manualRecovery: [
          expect.objectContaining({
            operation: 'remove-private-scratch',
            sourcePath: expect.stringMatching(/^.+dshpack-migrate-scratch-/u),
          }),
        ],
      },
    });
    expect(stranded).toBe(report.metadata.manualRecovery?.[0]?.sourcePath);
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('does not invoke probe or plugin resolution through the live runtime', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    await legacyInstall(dshHome, source);
    const fixture = fakeRuntime();
    fixture.runtime.probe = async () => {
      throw new Error('live probe must not run');
    };
    fixture.runtime.resolvePlugins = async () => {
      throw new Error('live plugin resolution must not run');
    };

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: { status: 'migrated' },
    });
    expect(fixture.calls).not.toContain('resolve:lock');
    expect(fixture.calls).not.toContain('resolve:manifest');
  });

  it('rejects an unsafe target capture before it writes migration state', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    await legacyInstall(dshHome, source);
    const before = await snapshot(dshHome);
    const fixture = fakeRuntime();
    fixture.runtime.captureTargetState = async () => {
      throw new Error('unsafe target');
    };

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_TARGET_STATE' })],
      metadata: { status: 'not-started' },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('rejects a re-fetched source that no longer matches the v0 immutable base', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    await legacyInstall(dshHome, source);
    await writeFile(
      join(source, 'skills', 'notes.md'),
      '---\nname: notes\ndescription: changed fixture notes\n---\n# Notes\n',
    );
    const before = await snapshot(dshHome);

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fakeRuntime().runtime,
    );

    expect(report).toMatchObject({
      exitCode: 20,
      diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_SOURCE_CHANGED' })],
      metadata: { status: 'not-started' },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it('keeps every live target untouched and records only the re-fetched source base', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    await legacyInstall(dshHome, source);
    const targets = {
      profile: join(dshHome, 'profiles', 'engine-pack', 'cordis.yml'),
      skill: join(dshHome, 'skills', 'notes', 'SKILL.md'),
      preset: join(dshHome, '.agent-presets', 'custom', 'agent.cordis.yml'),
      settings: join(dshHome, 'settings.yaml'),
    };
    await writeFile(targets.profile, '[]\n# user profile change\n');
    await writeFile(targets.skill, '# user skill change\n');
    await writeFile(targets.preset, '[]\n# user preset change\n');
    await writeFile(targets.settings, 'agent-presets:\n  custom:\n    model: user-change\n');
    const beforeTargets = {
      profile: await fileSnapshot(targets.profile),
      skill: await fileSnapshot(targets.skill),
      preset: await fileSnapshot(targets.preset),
      settings: await fileSnapshot(targets.settings),
    };

    const fixture = fakeRuntime();
    fixture.runtime.writeMaterialAsset = async () => {
      throw new Error('live asset write must never run during migrate');
    };
    fixture.runtime.authorizeBuild = async () => {
      throw new Error('live build authorization must never run during migrate');
    };
    fixture.runtime.runDsh = async () => {
      throw new Error('live dsh must never run during migrate');
    };
    fixture.runtime.runPnpm = async () => {
      throw new Error('live pnpm must never run during migrate');
    };
    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({ exitCode: 0, metadata: { status: 'migrated', generation: 2 } });
    expect(await fileSnapshot(targets.profile)).toEqual(beforeTargets.profile);
    expect(await fileSnapshot(targets.skill)).toEqual(beforeTargets.skill);
    expect(await fileSnapshot(targets.preset)).toEqual(beforeTargets.preset);
    expect(await fileSnapshot(targets.settings)).toEqual(beforeTargets.settings);
    const marker = await readJson<InstalledMetadataV1>(
      join(dshHome, '.dshpack', 'installed', 'engine-pack.json'),
    );
    const profile = marker.assets.find((asset) => asset.kind === 'profile');
    expect(profile?.files).toContainEqual({
      path: 'cordis.yml',
      sha256: sha256(Buffer.from('[]\n')),
      bytes: Buffer.byteLength('[]\n'),
    });
    expect(profile?.files).not.toContainEqual({
      path: 'cordis.yml',
      sha256: sha256(beforeTargets.profile.bytes),
      bytes: beforeTargets.profile.bytes.byteLength,
    });
    await expect(
      readFile(storePath(dshHome, sha256(beforeTargets.profile.bytes))),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const skill = marker.assets.find((asset) => asset.kind === 'skill');
    const preset = marker.assets.find((asset) => asset.kind === 'preset');
    expect(skill?.files).toContainEqual({
      path: 'SKILL.md',
      sha256: sha256(Buffer.from('---\nname: notes\ndescription: fixture notes\n---\n# Notes\n')),
      bytes: Buffer.byteLength('---\nname: notes\ndescription: fixture notes\n---\n# Notes\n'),
    });
    expect(preset?.files).toContainEqual({
      path: 'agent.cordis.yml',
      sha256: sha256(Buffer.from('[]\n')),
      bytes: Buffer.byteLength('[]\n'),
    });
  });

  it('captures a migration without a settings contribution', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: false });
    await legacyInstall(dshHome, source);
    await removeV1State(dshHome);

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fakeRuntime().runtime,
    );

    expect(report).toMatchObject({ exitCode: 0, metadata: { status: 'migrated' } });
    const marker = await readJson<InstalledMetadataV1>(
      join(dshHome, '.dshpack', 'installed', 'engine-pack.json'),
    );
    expect(marker.settingsContribution).toEqual({ namespace: 'agent-presets', keys: [] });
  });

  it('never verifies plugins through the live profile while reconstructing the source base', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true, plugin: {} });
    await legacyInstall(dshHome, source);
    const before = await snapshot(dshHome);
    const fixture = fakeRuntime();
    fixture.runtime.verifyInstalledPlugin = async () => {
      throw new Error('plugin verification detail');
    };

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: { status: 'migrated' },
    });
    expect(fixture.calls).not.toContain('verify-plugin:example-bundle');
    expect(await readFile(join(dshHome, 'profiles', 'engine-pack', 'cordis.yml'))).toEqual(
      await readFile(join(dshHome, 'profiles', 'engine-pack', 'cordis.yml')),
    );
    expect(before).not.toEqual({});
  });

  it.each(['packageJsonSha512', 'bundlePatch'] as const)(
    'rejects a scratch plugin fact mismatch in %s before live state changes',
    async (field) => {
      const dshHome = await home();
      const source = await enginePack({ assets: true, plugin: {} });
      const legacy = await legacyInstall(dshHome, source);
      const original = legacy.plugins[0];
      if (original === undefined) throw new Error('fixture must contain one plugin');
      const value =
        field === 'packageJsonSha512'
          ? `${original.packageJsonSha512.slice(0, 7)}${original.packageJsonSha512[7] === 'A' ? 'B' : 'A'}${original.packageJsonSha512.slice(8)}`
          : 'lib/changed.yml';
      const before = await snapshot(dshHome);
      const fixture = fakeRuntime();
      fixture.runtime.createScratchRuntime = () => {
        const scratch = fakeRuntime().runtime;
        const compare = scratch.transactionAdapter.compareAndSwapManagedDocument;
        scratch.transactionAdapter = {
          ...scratch.transactionAdapter,
          async compareAndSwapManagedDocument(path, expected, replacement) {
            if (!path.endsWith('engine-pack.json') || compare === undefined)
              return compare?.(path, expected, replacement) ?? false;
            const marker = JSON.parse(replacement) as InstalledMetadataV1;
            return compare(
              path,
              expected,
              `${JSON.stringify({
                ...marker,
                plugins: marker.plugins.map((plugin) => ({ ...plugin, [field]: value })),
                effectiveLock: {
                  ...marker.effectiveLock,
                  plugins: marker.effectiveLock.plugins.map((plugin) => ({
                    ...plugin,
                    [field]: value,
                  })),
                },
              })}\n`,
            );
          },
        };
        return scratch;
      };

      const report = await migrateProfile(
        { dshHome, profile: 'engine-pack', dryRun: false },
        fixture.runtime,
      );

      expect(report).toMatchObject({
        exitCode: 20,
        diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_BASE_CHANGED' })],
        metadata: { status: 'not-started' },
      });
      expect(await snapshot(dshHome)).toEqual(before);
    },
  );

  it.each([
    ['invalid scratch marker', 'E_MIGRATE_BASE_REBUILD', 30],
    ['scratch asset fingerprint mismatch', 'E_MIGRATE_BASE_CAPTURE', 30],
  ] as const)('rejects %s before live state changes', async (scenario, code, exitCode) => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    await legacyInstall(dshHome, source);
    const before = await logicalSnapshot(dshHome);
    const fixture = fakeRuntime();
    fixture.runtime.createScratchRuntime = () => {
      const scratch = fakeRuntime().runtime;
      const compare = scratch.transactionAdapter.compareAndSwapManagedDocument;
      scratch.transactionAdapter = {
        ...scratch.transactionAdapter,
        async compareAndSwapManagedDocument(path, expected, replacement) {
          if (!path.endsWith('engine-pack.json') || compare === undefined)
            return compare?.(path, expected, replacement) ?? false;
          const marker = JSON.parse(replacement) as InstalledMetadataV1;
          const altered =
            scenario === 'invalid scratch marker'
              ? { ...marker, generation: 0 }
              : {
                  ...marker,
                  assets: marker.assets.map((asset, index) =>
                    index === 0
                      ? {
                          ...asset,
                          files: asset.files.map((file) => ({ ...file, bytes: file.bytes + 1 })),
                        }
                      : asset,
                  ),
                };
          return compare(path, expected, `${JSON.stringify(altered)}\n`);
        },
      };
      return scratch;
    };

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode,
      diagnostics: [expect.objectContaining({ code })],
      metadata: { status: scenario === 'invalid scratch marker' ? 'not-started' : 'rolled-back' },
    });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('rejects a legacy source whose declared settings payload disappears before transaction setup', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    await legacyInstall(dshHome, source);
    const before = await snapshot(dshHome);
    const fixture = fakeRuntime();
    const read = fixture.runtime.readValidatedPack;
    fixture.runtime.readValidatedPack = async (directory, options) => {
      const result = await read(directory, options);
      if (result.material === undefined) return result;
      return {
        ...result,
        material: {
          ...result.material,
          files: result.material.files.filter((file) => file.path !== 'settings/agent-presets.yml'),
        },
      };
    };

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_SOURCE_PAYLOAD' })],
      metadata: { status: 'not-started' },
    });
    expect(await snapshot(dshHome)).toEqual(before);
  });

  it.each([true, false])(
    'rejects invalid live settings during %s preflight without transaction state',
    async (dryRun) => {
      const dshHome = await home();
      const source = await enginePack({ assets: true });
      await legacyInstall(dshHome, source);
      const before = await snapshot(dshHome);
      const fixture = fakeRuntime();
      const capture = fixture.runtime.captureTargetState;
      fixture.runtime.captureTargetState = async (request) => ({
        ...(await capture(request)),
        settingsDocument: 'agent-presets: [\n',
      });

      const report = await migrateProfile(
        { dshHome, profile: 'engine-pack', dryRun },
        fixture.runtime,
      );

      expect(report).toMatchObject({
        exitCode: 30,
        metadata: { status: 'not-started' },
      });
      expect(await snapshot(dshHome)).toEqual(before);
    },
  );

  it.each([
    [
      'typed',
      new TransactionFailure(30, [
        {
          code: 'E_LOCKED_READER',
          severity: 'error',
          message: 'typed',
          hint: 'test',
          evidence: 'local',
        },
      ]),
      30,
      'E_LOCKED_READER',
    ],
    [
      'unexpected',
      new Error('private locked reader detail'),
      31,
      'E_TRANSACTION_STATE_READ_SECURITY',
    ],
  ] as const)(
    'rolls back cleanly when the %s installed-marker reread fails under the transaction lock',
    async (_label, failure, exitCode, code) => {
      const dshHome = await home();
      const source = await enginePack({ assets: true });
      await legacyInstall(dshHome, source);
      const before = await logicalSnapshot(dshHome);
      const fixture = fakeRuntime();
      const read = fixture.runtime.transactionAdapter.readManagedDocument;
      let reads = 0;
      fixture.runtime.transactionAdapter = {
        ...fixture.runtime.transactionAdapter,
        async readManagedDocument(path) {
          reads += 1;
          if (reads === 2) throw failure;
          return read?.(path);
        },
      };

      const report = await migrateProfile(
        { dshHome, profile: 'engine-pack', dryRun: false },
        fixture.runtime,
      );

      expect(report).toMatchObject({
        exitCode,
        diagnostics: [expect.objectContaining({ code })],
        metadata: { status: 'rolled-back', manualRecovery: [] },
      });
      expect(JSON.stringify(report)).not.toContain('private locked reader detail');
      expect(await logicalSnapshot(dshHome)).toEqual(before);
    },
  );

  it('rolls back when the installed marker changes between preflight and the lock-owned reread', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    await legacyInstall(dshHome, source);
    const markerPath = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
    const initial = await readFile(markerPath, 'utf8');
    const before = await logicalSnapshot(dshHome);
    const fixture = fakeRuntime();
    const acquire = fixture.runtime.transactionAdapter.acquireArtifactLock;
    fixture.runtime.transactionAdapter = {
      ...fixture.runtime.transactionAdapter,
      async acquireArtifactLock(path) {
        const acquired = await acquire(path);
        await writeFile(markerPath, `${initial.trimEnd()}\n\n`);
        return acquired;
      },
    };

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_METADATA_CHANGED' })],
      metadata: { status: 'rolled-back', manualRecovery: [] },
    });
    expect(await logicalSnapshot(dshHome)).toEqual({
      ...before,
      [join('.dshpack', 'installed', 'engine-pack.json')]: Buffer.from(
        `${initial.trimEnd()}\n\n`,
      ).toString('base64'),
    });
  });

  it('does not overwrite a marker changed after current advances', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    await legacyInstall(dshHome, source);
    const markerPath = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
    const initial = await readFile(markerPath, 'utf8');
    const before = await logicalSnapshot(dshHome);
    const fixture = fakeRuntime();
    const advance = fixture.runtime.transactionAdapter.compareAndSwapGenerationCurrent;
    let changed = false;
    fixture.runtime.transactionAdapter = {
      ...fixture.runtime.transactionAdapter,
      async compareAndSwapGenerationCurrent(path, expected, replacement) {
        const wrote = await advance?.(path, expected, replacement);
        if (wrote && !changed) {
          changed = true;
          await writeFile(markerPath, `${initial.trimEnd()}\n\n`);
        }
        return wrote ?? false;
      },
    };

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_TRANSACTION_MANAGED_DOCUMENT_CHANGED' })],
      metadata: { status: 'rolled-back', manualRecovery: [] },
    });
    expect(await logicalSnapshot(dshHome)).toEqual({
      ...before,
      [join('.dshpack', 'installed', 'engine-pack.json')]: Buffer.from(
        `${initial.trimEnd()}\n\n`,
      ).toString('base64'),
    });
  });

  it('rolls back with a security report when lock-owned target capture fails', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    await legacyInstall(dshHome, source);
    const before = await logicalSnapshot(dshHome);
    const fixture = fakeRuntime();
    const capture = fixture.runtime.captureTargetState;
    let captures = 0;
    fixture.runtime.captureTargetState = async (request) => {
      captures += 1;
      if (captures === 2) throw new Error('private lock capture detail');
      return capture(request);
    };

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_TARGET_STATE' })],
      metadata: { status: 'rolled-back', manualRecovery: [] },
    });
    expect(JSON.stringify(report)).not.toContain('private lock capture detail');
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('fails closed if the transaction adapter loses managed-marker reads after preflight', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    await legacyInstall(dshHome, source);
    const before = await logicalSnapshot(dshHome);
    const fixture = fakeRuntime();
    const txid = fixture.runtime.txid;
    fixture.runtime.txid = () => {
      const { readManagedDocument: _readManagedDocument, ...withoutReader } =
        fixture.runtime.transactionAdapter;
      fixture.runtime.transactionAdapter = withoutReader;
      return txid();
    };

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 70,
      diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_STATE_ADAPTER' })],
      metadata: { status: 'rolled-back', manualRecovery: [] },
    });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it.each(['store', 'generation', 'current', 'metadata'] as const)(
    'rolls back every migration state mutation after an injected %s failure',
    async (stage) => {
      const stages = ['store', 'generation', 'current', 'metadata'] as const;
      const dshHome = await home();
      const source = await enginePack({ assets: true });
      await legacyInstall(dshHome, source);
      await removeV1State(dshHome);
      const before = await logicalSnapshot(dshHome);
      const fixture = fakeRuntime({ fault: stage });
      const fault = fixture.runtime.fault;
      const seenStages: string[] = [];
      fixture.runtime.fault = async (actual) => {
        seenStages.push(actual);
        await fault(actual);
      };

      const report = await migrateProfile(
        { dshHome, profile: 'engine-pack', dryRun: false },
        fixture.runtime,
      );

      expect(report).toMatchObject({ exitCode: 24, metadata: { status: 'rolled-back' } });
      expect(report.metadata.manualRecovery).toEqual([]);
      expect(seenStages).toEqual(stages.slice(0, stages.indexOf(stage) + 1));
      expect(await logicalSnapshot(dshHome)).toEqual(before);
    },
  );

  it('reports exit 25 with a concrete recovery action when migration rollback cannot restore state', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    await legacyInstall(dshHome, source);
    await removeV1State(dshHome);
    const fixture = fakeRuntime({ fault: 'generation' });
    const move = fixture.runtime.transactionAdapter.moveArtifactPath;
    fixture.runtime.transactionAdapter = {
      ...fixture.runtime.transactionAdapter,
      async moveArtifactPath(...args) {
        if (args[1] === 'store-block' && args[3].split(/[\\/]/u).includes('new'))
          throw new Error('rollback storage move failed');
        return move(...args);
      },
    };

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 25,
      metadata: {
        status: 'rollback-failed',
      },
    });
    expect(report.metadata.manualRecovery).toEqual(
      expect.arrayContaining([expect.objectContaining({ operation: 'rename' })]),
    );
    expect(report.metadata.manualRecovery).not.toEqual([]);
  });

  it('rolls back when the target changes after migration preflight and before lock-owned capture', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    await legacyInstall(dshHome, source);
    const fixture = fakeRuntime();
    const capture = fixture.runtime.captureTargetState;
    let reads = 0;
    fixture.runtime.captureTargetState = async (request) => {
      reads += 1;
      if (reads === 2)
        await writeFile(
          join(dshHome, 'profiles', 'engine-pack', 'migration-race.txt'),
          'changed\n',
        );
      return capture(request);
    };
    const before = await logicalSnapshot(dshHome);

    const report = await migrateProfile(
      { dshHome, profile: 'engine-pack', dryRun: false },
      fixture.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_MIGRATE_TARGET_CHANGED' })],
      metadata: { status: 'rolled-back', manualRecovery: [] },
    });
    expect(await logicalSnapshot(dshHome)).toEqual({
      ...before,
      [join('profiles', 'engine-pack', 'migration-race.txt')]:
        Buffer.from('changed\n').toString('base64'),
    });
  });
});
