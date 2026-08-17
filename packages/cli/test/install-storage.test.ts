import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { installPack } from '../src/install/engine.js';
import type { InstallRuntime, InstallRuntimeStage } from '../src/install/runtime-types.js';
import {
  countMetadataAssetTargetReferences,
  type InstalledMetadataV1,
} from '../src/metadata/contracts.js';
import type { TransactionJournal } from '../src/transaction.js';
import { GENERATED_BY } from '../src/version.js';
import { enginePack, fakeRuntime, snapshot } from './install-engine-fixture.js';

const roots: string[] = [];

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-install-storage-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
}

function storePath(dshHome: string, digest: string): string {
  const token = digest.slice('sha256-'.length);
  return join(dshHome, '.dshpack', 'store', token.slice(0, 2), digest);
}

function generationPath(dshHome: string, profile: string, sequence: number): string {
  return join(
    dshHome,
    '.dshpack',
    'generations',
    profile,
    `${String(sequence).padStart(4, '0')}.json`,
  );
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function logicalSnapshot(root: string): Promise<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(await snapshot(root)).filter(
      ([path]) => !path.replaceAll('\\', '/').startsWith('.dshpack/backups/'),
    ),
  );
}

async function stateDirectorySnapshot(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const capture = async (path: string, relative: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    snapshot[`directory:${relative}`] = '';
    for (const entry of entries.sort((left, right) => left.localeCompare(right, 'en'))) {
      const child = join(path, entry);
      const childRelative = `${relative}/${entry}`;
      const stats = await lstat(child);
      if (stats.isDirectory()) await capture(child, childRelative);
      else snapshot[`file:${childRelative}`] = (await readFile(child)).toString('base64');
    }
  };
  for (const name of ['store', 'generations', 'installed']) {
    await capture(join(root, '.dshpack', name), name);
  }
  return snapshot;
}

interface Generation {
  seq: number;
  txid: string;
  createdAt: string;
  operation: 'install';
  pack: { name: string; version: string; manifestDigest: string };
  source: Record<string, unknown>;
  entries: Array<{ target: string; sha256: string }>;
  settingsContribution: InstalledMetadataV1['settingsContribution'];
  restorable: boolean;
}

function runtimeWithProfileBinary(bytes: Buffer): InstallRuntime {
  const fixture = fakeRuntime();
  const baseRunDsh = fixture.runtime.runDsh;
  return {
    ...fixture.runtime,
    async runDsh(args, options) {
      const result = await baseRunDsh(args, options);
      if (args.includes('--dump-config')) {
        const profile = args[args.indexOf('--profile') + 1];
        if (profile === undefined) throw new Error('fixture profile is required');
        const path = join(options.dshHome, 'profiles', profile, 'nested', 'raw.bin');
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, bytes);
      }
      return result;
    },
  };
}

function runtimeWithLargeLinkedDependency(): InstallRuntime {
  const fixture = fakeRuntime();
  const baseRunDsh = fixture.runtime.runDsh;
  return {
    ...fixture.runtime,
    async runDsh(args, options) {
      const result = await baseRunDsh(args, options);
      if (args.includes('--dump-config')) {
        const profile = args[args.indexOf('--profile') + 1];
        if (profile === undefined) throw new Error('fixture profile is required');
        const dependencies = join(options.dshHome, 'profiles', profile, 'node_modules');
        const linkedTarget = join(options.dshHome, 'runtime-dependency-target');
        await mkdir(dependencies, { recursive: true });
        await writeFile(join(dependencies, 'large.bin'), Buffer.alloc(10 * 1024 * 1024 + 1));
        await mkdir(linkedTarget, { recursive: true });
        await writeFile(join(linkedTarget, 'package.json'), '{"name":"runtime"}\n');
        await symlink(
          linkedTarget,
          join(dependencies, 'linked'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }
      return result;
    },
  };
}

describe('install CAS and generation persistence', () => {
  it('writes a v1 marker, raw CAS blocks, and a generation referencing profile/skill/preset bytes', async () => {
    const dshHome = await home();
    const profileBytes = Buffer.from([0, 1, 2, 255, 0, 128]);
    const source = await enginePack({ assets: true });
    const report = await installPack(
      { source, dshHome, yes: true, interactive: false },
      runtimeWithProfileBinary(profileBytes),
    );

    expect(report).toMatchObject({ exitCode: 0, metadata: { status: 'installed' } });
    const marker = await readJson<InstalledMetadataV1>(
      join(dshHome, '.dshpack', 'installed', 'engine-pack.json'),
    );
    expect(marker).toMatchObject({
      metadataVersion: 1,
      generation: 1,
      installedBy: GENERATED_BY,
      settingsContribution: {
        namespace: 'agent-presets',
        keys: [
          {
            key: 'custom',
            valueSha256: expect.stringMatching(/^sha256-[A-Za-z0-9_-]{43}$/u),
          },
        ],
      },
    });
    expect(marker.assets.map((asset) => asset.kind).sort()).toEqual(['preset', 'profile', 'skill']);
    expect(marker.assets.some((asset) => asset.target.includes('.dshpack'))).toBe(false);

    const profile = marker.assets.find((asset) => asset.kind === 'profile');
    if (profile === undefined) throw new Error('profile asset is required');
    expect(profile.files).toContainEqual({
      path: 'nested/raw.bin',
      sha256: sha256(profileBytes),
      bytes: profileBytes.byteLength,
    });

    const generation = await readJson<Generation>(generationPath(dshHome, 'engine-pack', 1));
    expect(generation).toMatchObject({
      seq: 1,
      operation: 'install',
      pack: marker.pack,
      source: marker.source,
      settingsContribution: marker.settingsContribution,
      restorable: true,
    });
    expect(generation.entries).toEqual(
      expect.arrayContaining([
        {
          target: 'profiles/engine-pack/nested/raw.bin',
          sha256: sha256(profileBytes),
        },
      ]),
    );
    expect(
      generation.entries.every((entry) => Object.keys(entry).sort().join(',') === 'sha256,target'),
    ).toBe(true);
    const expectedEntries = marker.assets
      .flatMap((asset) =>
        asset.files.map((file) => ({
          target: `${asset.target}/${file.path}`,
          sha256: file.sha256,
        })),
      )
      .sort((left, right) => left.target.localeCompare(right.target, 'en'));
    expect(generation.entries).toEqual(expectedEntries);
    for (const entry of generation.entries) {
      const stored = await readFile(storePath(dshHome, entry.sha256));
      const metadataFile = marker.assets
        .flatMap((asset) => asset.files.map((file) => ({ asset, file })))
        .find(({ asset, file }) => `${asset.target}/${file.path}` === entry.target)?.file;
      expect(metadataFile).toBeDefined();
      expect(sha256(stored)).toBe(entry.sha256);
      expect(stored.byteLength).toBe(metadataFile?.bytes);
    }
    expect(
      await readFile(join(dshHome, '.dshpack', 'generations', 'engine-pack', 'current'), 'utf8'),
    ).toBe('1\n');
    expect(await readFile(storePath(dshHome, sha256(profileBytes)))).toEqual(profileBytes);

    const sourceAsset = join(source, 'patch', 'cordis.patch.yml');
    const installedAsset = join(dshHome, 'profiles', 'engine-pack', 'cordis.patch.yml');
    const storedAsset = storePath(dshHome, sha256(Buffer.from('[]\n')));
    expect((await lstat(sourceAsset)).nlink).toBe(1);
    expect((await lstat(installedAsset)).nlink).toBe(1);
    expect((await lstat(storedAsset)).nlink).toBe(1);
    await rm(sourceAsset);
    expect(await readFile(storedAsset)).toEqual(Buffer.from('[]\n'));

    if (report.metadata.backupDirectory === undefined)
      throw new Error('transaction backup is required');
    const journal = await readJson<TransactionJournal>(
      join(report.metadata.backupDirectory, 'journal.json'),
    );
    for (const asset of marker.assets) {
      const path = join(dshHome, ...asset.target.split('/'));
      const stats = await lstat(path, { bigint: true });
      const identity = `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
      expect(asset.identity).toBe(identity);
      const action = journal.actions.find(
        (entry): entry is Extract<(typeof journal.actions)[number], { kind: 'create' }> =>
          entry.kind === 'create' && entry.artifact === asset.kind && entry.new.path === path,
      );
      expect(action?.new.identity).toBe(identity);
    }
  });

  it('excludes large linked runtime dependencies from the managed profile inventory', async () => {
    const dshHome = await home();
    const report = await installPack(
      { source: await enginePack({ assets: true }), dshHome, yes: true, interactive: false },
      runtimeWithLargeLinkedDependency(),
    );

    expect(report).toMatchObject({ exitCode: 0, metadata: { status: 'installed' } });
    const marker = await readJson<InstalledMetadataV1>(
      join(dshHome, '.dshpack', 'installed', 'engine-pack.json'),
    );
    const generation = await readJson<Generation>(generationPath(dshHome, 'engine-pack', 1));
    expect(marker.assets.find((asset) => asset.kind === 'profile')?.files).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expect.stringMatching(/^node_modules\//u) }),
      ]),
    );
    expect(generation.entries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: expect.stringMatching(/node_modules/u) }),
      ]),
    );
  });

  it('records a skipped shared asset for reference counting without snapshotting it into this generation', async () => {
    const dshHome = await home();
    const first = await installPack(
      {
        source: await enginePack({ assets: true, name: 'shared-owner-a' }),
        dshHome,
        yes: true,
        interactive: false,
      },
      fakeRuntime().runtime,
    );
    expect(first.exitCode).toBe(0);
    const sharedBytes = Buffer.from('shared user-owned skill bytes\n');
    await writeFile(join(dshHome, 'skills', 'notes', 'SKILL.md'), sharedBytes);

    const second = await installPack(
      {
        source: await enginePack({ assets: true, name: 'shared-owner-b' }),
        dshHome,
        yes: true,
        interactive: false,
      },
      fakeRuntime().runtime,
    );
    expect(second).toMatchObject({ exitCode: 0, metadata: { status: 'installed' } });
    const firstMarker = await readJson<InstalledMetadataV1>(
      join(dshHome, '.dshpack', 'installed', 'shared-owner-a.json'),
    );
    const secondMarker = await readJson<InstalledMetadataV1>(
      join(dshHome, '.dshpack', 'installed', 'shared-owner-b.json'),
    );
    const skipped = secondMarker.assets.find(
      (asset) => asset.kind === 'skill' && asset.target === 'skills/notes',
    );
    expect(skipped).toMatchObject({ action: 'skip' });
    expect(skipped?.files).toEqual([
      {
        path: 'SKILL.md',
        sha256: sha256(sharedBytes),
        bytes: sharedBytes.byteLength,
      },
    ]);
    expect(
      countMetadataAssetTargetReferences([firstMarker, secondMarker]).counts.get('skills/notes'),
    ).toBe(2);

    const generation = await readJson<Generation>(generationPath(dshHome, 'shared-owner-b', 1));
    expect(generation.entries.some((entry) => entry.target.startsWith('skills/notes/'))).toBe(
      false,
    );
    await expect(readFile(storePath(dshHome, sha256(sharedBytes)))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('deduplicates an already stored content block across profiles without a second copy', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    const expected = Buffer.from('[]\n');
    const digest = sha256(expected);

    await expect(
      installPack({ source, dshHome, yes: true, interactive: false }, fakeRuntime().runtime),
    ).resolves.toMatchObject({ exitCode: 0 });
    const first = await readFile(storePath(dshHome, digest));
    await expect(
      installPack(
        { source, dshHome, as: 'other-profile', yes: true, interactive: false },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(await readFile(storePath(dshHome, digest))).toEqual(first);
    const marker = await readJson<InstalledMetadataV1>(
      join(dshHome, '.dshpack', 'installed', 'other-profile.json'),
    );
    const profile = marker.assets.find((asset) => asset.kind === 'profile');
    expect(profile?.files).toContainEqual({
      path: 'cordis.patch.yml',
      sha256: digest,
      bytes: expected.byteLength,
    });
  });

  it('advances the current pointer to the next immutable generation on a replacement install', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    await expect(
      installPack({ source, dshHome, yes: true, interactive: false }, fakeRuntime().runtime),
    ).resolves.toMatchObject({ exitCode: 0 });
    const first = await readFile(generationPath(dshHome, 'engine-pack', 1), 'utf8');

    await expect(
      installPack(
        { source, dshHome, replace: true, yes: true, interactive: false },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(await readFile(generationPath(dshHome, 'engine-pack', 1), 'utf8')).toBe(first);
    expect(await readJson<Generation>(generationPath(dshHome, 'engine-pack', 2))).toMatchObject({
      seq: 2,
      operation: 'install',
    });
    expect(
      await readFile(join(dshHome, '.dshpack', 'generations', 'engine-pack', 'current'), 'utf8'),
    ).toBe('2\n');
  });

  it('fails closed without overwriting a pre-existing wrong CAS block', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    const expected = Buffer.from('---\nname: notes\ndescription: fixture notes\n---\n# Notes\n');
    const collision = storePath(dshHome, sha256(expected));
    await mkdir(join(collision, '..'), { recursive: true });
    const wrong = Buffer.from([255, 0, 17]);
    await writeFile(collision, wrong);

    const report = await installPack(
      { source, dshHome, yes: true, interactive: false },
      fakeRuntime().runtime,
    );

    expect(report).toMatchObject({ exitCode: 30, metadata: { status: 'rolled-back' } });
    expect(await readFile(collision)).toEqual(wrong);
    await expect(
      readFile(join(dshHome, '.dshpack', 'installed', 'engine-pack.json')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      readFile(join(dshHome, '.dshpack', 'generations', 'engine-pack', 'current')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each(['store', 'generation', 'current', 'metadata'] as const)(
    'removes every new state object after an injected %s write failure',
    async (stage) => {
      const dshHome = await home();
      const source = await enginePack({ assets: true });
      const before = await logicalSnapshot(dshHome);
      const report = await installPack(
        { source, dshHome, yes: true, interactive: false },
        fakeRuntime({ fault: stage as InstallRuntimeStage }).runtime,
      );

      expect(report).toMatchObject({ exitCode: 24, metadata: { status: 'rolled-back' } });
      expect(report.metadata.manualRecovery).toEqual([]);
      expect(await logicalSnapshot(dshHome)).toEqual(before);
      await expect(
        readFile(join(dshHome, '.dshpack', 'installed', 'engine-pack.json')),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(
        readFile(join(dshHome, '.dshpack', 'generations', 'engine-pack', 'current')),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it.each(['store', 'generation', 'current', 'metadata'] as const)(
    'removes every newly-created state directory after an injected %s failure',
    async (stage) => {
      const dshHome = await home();
      const source = await enginePack({ assets: true });
      const before = await stateDirectorySnapshot(dshHome);

      const report = await installPack(
        { source, dshHome, yes: true, interactive: false },
        fakeRuntime({ fault: stage as InstallRuntimeStage }).runtime,
      );

      expect(report).toMatchObject({ exitCode: 24, metadata: { status: 'rolled-back' } });
      expect(report.metadata.manualRecovery).toEqual([]);
      expect(await stateDirectorySnapshot(dshHome)).toEqual(before);
    },
  );
});
