import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT_CODES } from '../src/exit-codes.js';
import { runGc } from '../src/gc/engine.js';
import { installPack } from '../src/install/engine.js';
import { bindSecureRoot } from '../src/list/safe-fs.js';
import {
  countMetadataAssetTargetReferences,
  type InstalledMetadataV1,
} from '../src/metadata/contracts.js';
import { casStoreShard, settingsContribution } from '../src/metadata/state-storage.js';
import {
  createNodeTransactionAdapter,
  type TransactionAdapter,
  TransactionFailure,
} from '../src/transaction.js';
import { MAX_TRANSACTION_STATE_BYTES } from '../src/transaction-types.js';
import {
  prepareInverseSettings,
  resolveUninstallDeleteSource,
  uninstallProfile,
} from '../src/uninstall/engine.js';
import { enginePack, fakeRuntime } from './install-engine-fixture.js';

vi.mock('../src/doctor/engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/doctor/engine.js')>();
  return {
    ...actual,
    runDoctor: async () => ({
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { sideEffects: [] },
    }),
  };
});

const roots: string[] = [];

const userMutatedAssets = [
  {
    label: 'skill',
    target: 'skills/notes',
    userFile: 'USER_NOTES.md',
    userBytes: 'user-owned modified skill\n',
  },
  {
    label: 'profile',
    target: 'profiles/engine-pack',
    userFile: 'USER_PROFILE.md',
    userBytes: 'user-owned modified profile\n',
  },
  {
    label: 'preset',
    target: '.agent-presets/custom',
    userFile: 'USER_PRESET.md',
    userBytes: 'user-owned modified preset\n',
  },
] as const;

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-uninstall-'));
  roots.push(root);
  return root;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function logicalSnapshot(root: string, relative = ''): Promise<Record<string, string>> {
  const entries = await readdir(join(root, relative));
  const snapshot: Record<string, string> = {};
  for (const name of entries.sort((left, right) => left.localeCompare(right, 'en'))) {
    const childRelative = relative === '' ? name : `${relative}/${name}`;
    if (childRelative.startsWith('.dshpack/backups/')) continue;
    const child = join(root, childRelative);
    if ((await lstat(child)).isDirectory())
      Object.assign(snapshot, await logicalSnapshot(root, childRelative));
    else snapshot[childRelative] = (await readFile(child)).toString('base64');
  }
  return snapshot;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('uninstall engine', () => {
  it('keeps a drifted settings contribution by default and removes it only with force', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: EXIT_CODES.SUCCESS });
    const marker = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'), 'utf8'),
    ) as InstalledMetadataV1;
    const binding = await bindSecureRoot(dshHome);
    if (!binding.ok) throw new Error('test home did not bind');
    await writeFile(
      join(dshHome, 'settings.yaml'),
      'agent-presets:\n  custom: {model: user-drift}\n  retained: {model: keep}\n',
      'utf8',
    );

    await expect(
      prepareInverseSettings(dshHome, binding.value, marker, false),
    ).resolves.toMatchObject({
      replacement: undefined,
      removed: [],
      retained: ['custom'],
    });
    await expect(
      prepareInverseSettings(dshHome, binding.value, marker, false, true),
    ).resolves.toEqual({
      expected: 'agent-presets:\n  custom: {model: user-drift}\n  retained: {model: keep}\n',
      replacement: 'agent-presets:\n  retained: {model: keep}\n',
      removed: ['custom'],
      retained: [],
    });

    await expect(
      uninstallProfile({ dshHome, profile: 'engine-pack', force: true, yes: true }),
    ).resolves.toMatchObject({
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { settingsRemoved: ['custom'], settingsRetained: [] },
    });
    await expect(readFile(join(dshHome, 'settings.yaml'), 'utf8')).resolves.toBe(
      'agent-presets:\n  retained: {model: keep}\n',
    );
  });

  it('fails closed before a delete when a corrupted locked plan loses its v1 asset source', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: EXIT_CODES.SUCCESS });
    const marker = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'), 'utf8'),
    ) as InstalledMetadataV1;
    const target = 'skills/notes';
    const corruptPlans = [
      {
        name: 'downgraded metadata version',
        metadata: { ...marker, metadataVersion: 0 } as unknown,
        code: 'E_UNINSTALL_PLAN_METADATA',
      },
      {
        name: 'missing source',
        metadata: { ...marker, assets: marker.assets.filter((asset) => asset.target !== target) },
        code: 'E_UNINSTALL_PLAN_ASSET',
      },
      {
        name: 'non-directory source kind',
        metadata: {
          ...marker,
          assets: marker.assets.map((asset) =>
            asset.target === target ? { ...asset, kind: 'managed-document' as const } : asset,
          ),
        },
        code: 'E_UNINSTALL_PLAN_KIND',
      },
    ] as const;

    for (const corrupt of corruptPlans) {
      try {
        resolveUninstallDeleteSource(corrupt.metadata as unknown as InstalledMetadataV1, target);
        throw new Error(`${corrupt.name} unexpectedly resolved a delete source`);
      } catch (error) {
        expect(error).toMatchObject({ code: corrupt.code, exitCode: EXIT_CODES.CONTRACT });
      }
    }
    await expect(readFile(join(dshHome, 'skills', 'notes', 'SKILL.md'), 'utf8')).resolves.toContain(
      'notes',
    );
  });

  it('conservatively retains every settings contribution shape it cannot prove byte-safe to remove', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const marker = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'), 'utf8'),
    ) as InstalledMetadataV1;
    const binding = await bindSecureRoot(dshHome);
    if (!binding.ok) throw new Error('test home did not bind');
    const settingsPath = join(dshHome, 'settings.yaml');

    await expect(prepareInverseSettings(dshHome, binding.value, marker, true)).resolves.toEqual({
      expected: undefined,
      replacement: undefined,
      removed: [],
      retained: [],
    });
    await rm(settingsPath);
    await expect(
      prepareInverseSettings(dshHome, binding.value, marker, false),
    ).resolves.toMatchObject({
      retained: ['custom'],
    });
    await writeFile(settingsPath, 'agent-presets: scalar\n');
    await expect(
      prepareInverseSettings(dshHome, binding.value, marker, false),
    ).resolves.toMatchObject({
      expected: 'agent-presets: scalar\n',
      replacement: undefined,
      retained: ['custom'],
    });
    await writeFile(settingsPath, 'agent-presets:\n  absent: {model: keep}\n');
    await expect(
      prepareInverseSettings(dshHome, binding.value, marker, false),
    ).resolves.toMatchObject({
      retained: ['custom'],
    });
    await writeFile(settingsPath, 'agent-presets:\n  custom: {model: user}\n');
    await expect(
      prepareInverseSettings(dshHome, binding.value, marker, false),
    ).resolves.toMatchObject({
      retained: ['custom'],
    });
    await writeFile(settingsPath, 'agent-presets:\n  custom: {model: fixture} # user comment\n');
    await expect(
      prepareInverseSettings(dshHome, binding.value, marker, false),
    ).resolves.toMatchObject({
      retained: ['custom'],
      removed: [],
    });
    for (const source of [
      'agent-presets: &user-owned\n  custom: {model: fixture}\n',
      'agent-presets: !user-owned\n  custom: {model: fixture}\n',
    ]) {
      await writeFile(settingsPath, source);
      await expect(
        prepareInverseSettings(dshHome, binding.value, marker, false),
      ).resolves.toMatchObject({
        expected: source,
        replacement: undefined,
        retained: ['custom'],
        removed: [],
      });
    }
  });

  it('removes intact tracked assets and records an empty uninstall generation', async () => {
    const dshHome = await home();
    const installed = await installPack(
      { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
      fakeRuntime().runtime,
    );
    expect(installed.exitCode).toBe(0);
    const markerPath = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as InstalledMetadataV1;

    const report = await uninstallProfile({
      dshHome,
      profile: 'engine-pack',
      interactive: false,
      yes: true,
    });

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: {
        profile: 'engine-pack',
        dryRun: false,
        activation: 'profile-removed',
        removedMarker: true,
      },
    });
    expect(await exists(markerPath)).toBe(false);
    for (const asset of marker.assets)
      expect(await exists(join(dshHome, ...asset.target.split('/')))).toBe(false);
    expect(
      JSON.parse(
        await readFile(
          join(dshHome, '.dshpack', 'generations', 'engine-pack', '0002.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ operation: 'uninstall', entries: [], metadata: null });
    expect(
      await readFile(join(dshHome, '.dshpack', 'generations', 'engine-pack', 'current'), 'utf8'),
    ).toBe('2\n');
  });

  it.each(userMutatedAssets)(
    'mutation guard: retains a user-modified $label asset with --yes unless force is explicit',
    async ({ target: assetTarget, userFile, userBytes }) => {
      const dshHome = await home();
      await expect(
        installPack(
          { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
          fakeRuntime().runtime,
        ),
      ).resolves.toMatchObject({ exitCode: 0 });
      const assetRoot = join(dshHome, ...assetTarget.split('/'));
      const userPath = join(assetRoot, userFile);
      await writeFile(userPath, userBytes);

      const report = await uninstallProfile({
        dshHome,
        profile: 'engine-pack',
        interactive: false,
        yes: true,
      });

      expect(report.exitCode).toBe(0);
      expect(report.metadata.assets).toContainEqual({
        target: assetTarget,
        drift: 'modified',
        action: 'retain',
        reason: 'modified',
      });
      expect(await readFile(userPath, 'utf8')).toBe(userBytes);
    },
  );

  it('rechecks assets after acquiring the transaction lock before removing them', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const target = join(dshHome, 'skills', 'notes', 'SKILL.md');
    const base = createNodeTransactionAdapter();
    let changedAfterPreflight = false;
    const adapter: TransactionAdapter = {
      ...base,
      async acquireArtifactLock(homePath) {
        const lock = await base.acquireArtifactLock(homePath);
        await writeFile(target, 'user-owned change after uninstall preflight\n');
        changedAfterPreflight = true;
        return lock;
      },
    };

    const report = await uninstallProfile(
      { dshHome, profile: 'engine-pack', interactive: false, yes: true },
      { createAdapter: () => adapter },
    );

    expect(changedAfterPreflight).toBe(true);
    expect(report).toMatchObject({
      exitCode: 0,
      metadata: {
        assets: expect.arrayContaining([
          expect.objectContaining({
            target: 'skills/notes',
            drift: 'modified',
            action: 'retain',
            reason: 'modified',
          }),
        ]),
      },
    });
    expect(await readFile(target, 'utf8')).toBe('user-owned change after uninstall preflight\n');
  });

  it('refuses an asset replaced after the locked scan before its transactional move', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const skillRoot = join(dshHome, 'skills', 'notes');
    const markerPath = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
    const base = createNodeTransactionAdapter();
    let replaced = false;
    const adapter: TransactionAdapter = {
      ...base,
      async pathIdentity(path) {
        if (path === skillRoot && !replaced) {
          replaced = true;
          await rm(skillRoot, { force: true, recursive: true });
          await mkdir(skillRoot, { recursive: true });
          await writeFile(join(skillRoot, 'SKILL.md'), 'user replacement after locked scan\n');
        }
        return base.pathIdentity(path);
      },
    };

    const report = await uninstallProfile(
      { dshHome, profile: 'engine-pack', interactive: false, yes: true },
      { createAdapter: () => adapter },
    );

    expect(replaced).toBe(true);
    expect(report).toMatchObject({
      exitCode: EXIT_CODES.CONTRACT,
      diagnostics: [expect.objectContaining({ code: 'E_TRANSACTION_REPLACE_CHANGED' })],
      metadata: { removedMarker: false },
    });
    expect(await readFile(join(skillRoot, 'SKILL.md'), 'utf8')).toBe(
      'user replacement after locked scan\n',
    );
    expect(await exists(markerPath)).toBe(true);
  });

  it.each(userMutatedAssets)(
    'force deletes and lists a user-modified $label asset',
    async ({ target: assetTarget, userFile, userBytes }) => {
      const dshHome = await home();
      await expect(
        installPack(
          { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
          fakeRuntime().runtime,
        ),
      ).resolves.toMatchObject({ exitCode: 0 });
      const assetRoot = join(dshHome, ...assetTarget.split('/'));
      await writeFile(join(assetRoot, userFile), userBytes);

      const report = await uninstallProfile({
        dshHome,
        profile: 'engine-pack',
        force: true,
        interactive: false,
        yes: true,
      });

      expect(report.exitCode).toBe(0);
      expect(report.metadata.assets).toContainEqual({
        target: assetTarget,
        drift: 'modified',
        action: 'delete',
        reason: 'force-modified',
      });
      expect(report.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'W_UNINSTALL_ASSET_FORCE_REMOVED' }),
      );
      expect(await exists(assetRoot)).toBe(false);
    },
  );

  it('does not let --force bypass the separate --yes confirmation', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const target = join(dshHome, 'skills', 'notes', 'SKILL.md');
    await writeFile(target, 'user-owned modified skill\n');
    const before = await logicalSnapshot(dshHome);

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', force: true });

    expect(report).toMatchObject({
      exitCode: 21,
      diagnostics: [expect.objectContaining({ code: 'E_UNINSTALL_CONFIRM_REQUIRED' })],
    });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('rechecks peer references after acquiring the transaction lock', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        {
          source: await enginePack({ assets: true, name: 'owner-a' }),
          dshHome,
          interactive: false,
          yes: true,
        },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const owner = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'installed', 'owner-a.json'), 'utf8'),
    ) as InstalledMetadataV1;
    const base = createNodeTransactionAdapter();
    const adapter: TransactionAdapter = {
      ...base,
      async acquireArtifactLock(homePath) {
        const lock = await base.acquireArtifactLock(homePath);
        const peerAssets = owner.assets.map((asset) =>
          asset.kind === 'profile' ? { ...asset, id: 'peer-b', target: 'profiles/peer-b' } : asset,
        );
        await writeFile(
          join(dshHome, '.dshpack', 'installed', 'peer-b.json'),
          `${JSON.stringify({ ...owner, profile: 'peer-b', assets: peerAssets })}\n`,
        );
        return lock;
      },
    };

    const report = await uninstallProfile(
      { dshHome, profile: 'owner-a', yes: true },
      { createAdapter: () => adapter },
    );

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: {
        assets: expect.arrayContaining([
          expect.objectContaining({
            target: 'skills/notes',
            action: 'retain',
            reason: 'shared-target',
          }),
        ]),
      },
    });
    expect(await exists(join(dshHome, 'skills', 'notes'))).toBe(true);
  });

  it('mutation guard: a skip claim does not make an owner asset permanently shared', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        {
          source: await enginePack({ assets: true, name: 'owner-a' }),
          dshHome,
          interactive: false,
          yes: true,
        },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      installPack(
        {
          source: await enginePack({ assets: true, name: 'observer-b' }),
          dshHome,
          interactive: false,
          yes: true,
        },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const observer = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'installed', 'observer-b.json'), 'utf8'),
    ) as InstalledMetadataV1;
    expect(observer.assets.find((asset) => asset.target === 'skills/notes')?.action).toBe('skip');

    const report = await uninstallProfile({
      dshHome,
      profile: 'owner-a',
      interactive: false,
      yes: true,
    });

    expect(report.exitCode).toBe(0);
    expect(report.metadata.assets).toContainEqual({
      target: 'skills/notes',
      drift: 'intact',
      action: 'delete',
      reason: 'intact',
    });
    expect(await exists(join(dshHome, 'skills', 'notes'))).toBe(false);
  });

  it('retains and reports a target claimed by another non-skip installed marker', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        {
          source: await enginePack({ assets: true, name: 'owner-a' }),
          dshHome,
          interactive: false,
          yes: true,
        },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      installPack(
        {
          source: await enginePack({ assets: true, name: 'owner-b' }),
          dshHome,
          interactive: false,
          yes: true,
        },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const secondPath = join(dshHome, '.dshpack', 'installed', 'owner-b.json');
    const second = JSON.parse(await readFile(secondPath, 'utf8')) as InstalledMetadataV1;
    const assets = second.assets.map((asset) =>
      asset.target === 'skills/notes' ? { ...asset, action: 'create' as const } : asset,
    );
    await writeFile(secondPath, `${JSON.stringify({ ...second, assets })}\n`);
    const rewritten = JSON.parse(await readFile(secondPath, 'utf8')) as InstalledMetadataV1;
    expect(rewritten.assets.find((asset) => asset.target === 'skills/notes')?.action).toBe(
      'create',
    );
    expect(countMetadataAssetTargetReferences([rewritten]).counts.get('skills/notes')).toBe(1);

    const report = await uninstallProfile({ dshHome, profile: 'owner-a', yes: true });

    expect(report.exitCode).toBe(0);
    expect(report.metadata.assets).toContainEqual({
      target: 'skills/notes',
      drift: 'intact',
      action: 'retain',
      reason: 'shared-target',
    });
    expect(await exists(join(dshHome, 'skills', 'notes'))).toBe(true);
  });

  it('preserves the original non-owned settings bytes and comments through inverse merge', async () => {
    const dshHome = await home();
    const initialSettings = [
      '# untouched root comment',
      'outside:',
      '  value: "keep me" # untouched trailing comment',
      'agent-presets:',
      '',
    ].join('\n');
    const settingsPath = join(dshHome, 'settings.yaml');
    await writeFile(settingsPath, initialSettings, 'utf8');
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const afterInstall = await readFile(settingsPath, 'utf8');
    const nonOwnedPreset = '  existing:\n    model: keep # untouched preset comment\n';
    const expected = `${afterInstall.replace(/ {2}custom:[\s\S]*$/u, '')}${nonOwnedPreset}`;
    await writeFile(settingsPath, `${afterInstall}${nonOwnedPreset}`, 'utf8');

    const report = await uninstallProfile({
      dshHome,
      profile: 'engine-pack',
      interactive: false,
      yes: true,
    });

    expect(report).toMatchObject({ exitCode: 0, metadata: { settingsRemoved: ['custom'] } });
    expect(await readFile(settingsPath, 'utf8')).toBe(expected);
  });

  it('removes only the owned settings span without normalizing CRLF or flow-style user YAML', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const settingsPath = join(dshHome, 'settings.yaml');
    const installed = await readFile(settingsPath, 'utf8');
    const customOffset = installed.indexOf('  custom:');
    expect(customOffset).toBeGreaterThanOrEqual(0);
    const ownedCustom = installed.slice(customOffset).replaceAll('\n', '\r\n');
    const expected = [
      '# untouched root comment',
      'outside: {a: 1, b: 2} # untouched flow-style tail',
      'agent-presets:',
      '  existing: {model: keep, mode: strict} # untouched preset tail',
      '',
    ].join('\r\n');
    await writeFile(settingsPath, `${expected.slice(0, -2)}\r\n${ownedCustom}`, 'utf8');

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(report).toMatchObject({ exitCode: 0, metadata: { settingsRemoved: ['custom'] } });
    expect(await readFile(settingsPath, 'utf8')).toBe(expected);
  });

  it.each([
    {
      name: 'an inline comment inside the recorded value',
      mutate: (text: string) => text.replace('model: fixture', 'model: fixture # user annotation'),
    },
    {
      name: 'a block comment inside the recorded value',
      mutate: (text: string) => text.replace('  custom:\n', '  custom:\n    # user annotation\n'),
    },
  ])('retains an owned key when a user adds $name', async ({ mutate }) => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const settingsPath = join(dshHome, 'settings.yaml');
    const withUserComment = mutate(await readFile(settingsPath, 'utf8'));
    await writeFile(settingsPath, withUserComment, 'utf8');

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(report).toMatchObject({
      exitCode: 0,
      diagnostics: [expect.objectContaining({ code: 'W_UNINSTALL_SETTINGS_RETAINED' })],
      metadata: { settingsRemoved: [], settingsRetained: ['custom'] },
    });
    expect(await readFile(settingsPath, 'utf8')).toBe(withUserComment);
  });

  it('retains an owned settings pair when a retained key aliases its anchor', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const settingsPath = join(dshHome, 'settings.yaml');
    const anchoredSettings = [
      'agent-presets:',
      '  custom: &shared {model: fixture}',
      '  user: *shared',
      'outside: {enabled: true}',
      '',
    ].join('\n');
    await writeFile(settingsPath, anchoredSettings, 'utf8');

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(report).toMatchObject({
      exitCode: 0,
      diagnostics: [expect.objectContaining({ code: 'W_UNINSTALL_SETTINGS_RETAINED' })],
      metadata: { settingsRemoved: [], settingsRetained: ['custom'] },
    });
    expect(await readFile(settingsPath, 'utf8')).toBe(anchoredSettings);
  });

  it('retains an owned settings subtree containing an anchor used by another key', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const settingsPath = join(dshHome, 'settings.yaml');
    const markerPath = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as InstalledMetadataV1;
    const anchoredSettings = [
      'agent-presets:',
      '  custom: {model: {label: &shared fixture}}',
      '  user: *shared',
      '',
    ].join('\n');
    await writeFile(settingsPath, anchoredSettings, 'utf8');
    await writeFile(
      markerPath,
      `${JSON.stringify({
        ...marker,
        settingsContribution: settingsContribution({ custom: { model: { label: 'fixture' } } }),
      })}\n`,
      'utf8',
    );

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: { settingsRemoved: [], settingsRetained: ['custom'] },
    });
    expect(await readFile(settingsPath, 'utf8')).toBe(anchoredSettings);
  });

  it.each([
    { name: 'a root mapping anchor', property: '&presets' },
    { name: 'a root mapping tag', property: '!!map' },
  ])('retains the final owned key when $name would be detached', async ({ property }) => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const settingsPath = join(dshHome, 'settings.yaml');
    const markerPath = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as InstalledMetadataV1;
    const propertySettings = `agent-presets: ${property}\n  custom: true\n`;
    await writeFile(settingsPath, propertySettings, 'utf8');
    await writeFile(
      markerPath,
      `${JSON.stringify({ ...marker, settingsContribution: settingsContribution({ custom: true }) })}\n`,
      'utf8',
    );

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(report).toMatchObject({
      exitCode: 0,
      diagnostics: [expect.objectContaining({ code: 'W_UNINSTALL_SETTINGS_RETAINED' })],
      metadata: { settingsRemoved: [], settingsRetained: ['custom'] },
    });
    expect(await readFile(settingsPath, 'utf8')).toBe(propertySettings);
  });

  it('escapes terminal controls in retained settings diagnostics without changing JSON metadata', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const settingsPath = join(dshHome, 'settings.yaml');
    const markerPath = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as InstalledMetadataV1;
    const controlKey = '\u001b[2J';
    await writeFile(settingsPath, 'agent-presets:\n  "\\e[2J": false\n', 'utf8');
    await writeFile(
      markerPath,
      `${JSON.stringify({
        ...marker,
        settingsContribution: settingsContribution({ [controlKey]: true }),
      })}\n`,
      'utf8',
    );

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(report.metadata.settingsRetained).toEqual([controlKey]);
    const warning = report.diagnostics.find(({ code }) => code === 'W_UNINSTALL_SETTINGS_RETAINED');
    expect(warning?.message).toContain('agent-presets.\\u001b[2J');
    expect(warning?.message).not.toContain(controlKey);
  });

  it('does not echo control characters from an invalid untracked profile into its hint', async () => {
    const profile = 'bad\u001b[2J\nprofile';

    const report = await uninstallProfile({ dshHome: await home(), profile, dryRun: true });

    expect(report).toMatchObject({
      exitCode: EXIT_CODES.ENVIRONMENT,
      diagnostics: [expect.objectContaining({ code: 'E_NOT_TRACKED' })],
    });
    const hint = report.diagnostics[0]?.hint ?? '';
    expect(hint).toContain('bad\\u001b[2J\\nprofile');
    expect(hint).not.toContain(profile);
  });

  it.each([
    {
      name: 'a quoted hash inside the semantically identical recorded value',
      document: 'agent-presets:\n  custom: {model: "fixture#literal"}\n',
      contribution: { custom: { model: 'fixture#literal' } },
    },
    {
      name: 'a block-scalar hash inside the semantically identical recorded value',
      document: 'agent-presets:\n  custom:\n    model: |-\n      fixture#literal\n',
      contribution: { custom: { model: 'fixture#literal' } },
    },
  ])('removes an owned key with $name', async ({ document, contribution }) => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const settingsPath = join(dshHome, 'settings.yaml');
    const markerPath = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as InstalledMetadataV1;
    await writeFile(settingsPath, document, 'utf8');
    await writeFile(
      markerPath,
      `${JSON.stringify({ ...marker, settingsContribution: settingsContribution(contribution) })}\n`,
      'utf8',
    );

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: { settingsRemoved: ['custom'], settingsRetained: [] },
    });
    expect(await readFile(settingsPath, 'utf8')).toBe('agent-presets: {}\n');
  });

  it('empties a quoted agent-presets root mapping without changing its spelling, comment, or CRLF', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const settingsPath = join(dshHome, 'settings.yaml');
    const before = [
      '# untouched root comment',
      "'agent-presets' : # root mapping comment",
      '  custom: {model: fixture}',
      'outside: {enabled: true} # untouched outside comment',
      '',
    ].join('\r\n');
    const expected = [
      '# untouched root comment',
      "'agent-presets' : {} # root mapping comment",
      'outside: {enabled: true} # untouched outside comment',
      '',
    ].join('\r\n');
    await writeFile(settingsPath, before, 'utf8');

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: { settingsRemoved: ['custom'], settingsRetained: [] },
    });
    expect(await readFile(settingsPath, 'utf8')).toBe(expected);
  });

  it('empties an explicit-key agent-presets root mapping without changing its key or comments', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const settingsPath = join(dshHome, 'settings.yaml');
    const before = [
      '# untouched root comment',
      "? 'agent-presets' # explicit key comment",
      ': # explicit value comment',
      '  custom: {model: fixture}',
      'outside: {enabled: true} # untouched outside comment',
      '',
    ].join('\r\n');
    const expected = [
      '# untouched root comment',
      "? 'agent-presets' # explicit key comment",
      ': {} # explicit value comment',
      'outside: {enabled: true} # untouched outside comment',
      '',
    ].join('\r\n');
    await writeFile(settingsPath, before, 'utf8');

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: { settingsRemoved: ['custom'], settingsRetained: [] },
    });
    expect(await readFile(settingsPath, 'utf8')).toBe(expected);
  });

  it('removes one safe owned flow-map pair while preserving non-owned flow bytes and comments', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const settingsPath = join(dshHome, 'settings.yaml');
    const before = [
      '# top comment',
      'agent-presets: { # map comment',
      '  # existing stays',
      '  existing: {model: keep},',
      '  custom: {model: fixture}',
      '} # trailing comment',
      'outside: {enabled: true} # outside comment',
      '',
    ].join('\r\n');
    const expected = [
      '# top comment',
      'agent-presets: { # map comment',
      '  # existing stays',
      '  existing: {model: keep}',
      '} # trailing comment',
      'outside: {enabled: true} # outside comment',
      '',
    ].join('\r\n');
    await writeFile(settingsPath, before, 'utf8');

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: { settingsRemoved: ['custom'], settingsRetained: [] },
    });
    expect(await readFile(settingsPath, 'utf8')).toBe(expected);
  });

  it('removes a safe flow-map pair when an adjacent retained value contains a literal hash', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const settingsPath = join(dshHome, 'settings.yaml');
    const before = 'agent-presets: {existing: {note: "literal#hash"}, custom: {model: fixture}}\n';
    const expected = 'agent-presets: {existing: {note: "literal#hash"}}\n';
    await writeFile(settingsPath, before, 'utf8');

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: { settingsRemoved: ['custom'], settingsRetained: [] },
    });
    expect(await readFile(settingsPath, 'utf8')).toBe(expected);
  });

  it.each([
    {
      name: 'the first flow-map pair',
      before: 'agent-presets: {custom: {model: fixture},existing: {model: keep}} # tail\n',
      expected: 'agent-presets: {existing: {model: keep}} # tail\n',
    },
    {
      name: 'the only flow-map pair',
      before: 'agent-presets: {custom: {model: fixture}} # tail\n',
      expected: 'agent-presets: {} # tail\n',
    },
  ])('removes $name without reformatting the retained flow map', async ({ before, expected }) => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const settingsPath = join(dshHome, 'settings.yaml');
    await writeFile(settingsPath, before, 'utf8');

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: { settingsRemoved: ['custom'], settingsRetained: [] },
    });
    expect(await readFile(settingsPath, 'utf8')).toBe(expected);
  });

  it('retains a flow-map key when deletion would consume a non-owned separator comment', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const settingsPath = join(dshHome, 'settings.yaml');
    const withSeparatorComment = [
      'agent-presets: {existing: {model: keep}, # existing comment',
      '  custom: {model: fixture}} # tail',
      '',
    ].join('\n');
    await writeFile(settingsPath, withSeparatorComment, 'utf8');

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(report).toMatchObject({
      exitCode: 0,
      diagnostics: [expect.objectContaining({ code: 'W_UNINSTALL_SETTINGS_RETAINED' })],
      metadata: { settingsRemoved: [], settingsRetained: ['custom'] },
    });
    expect(await readFile(settingsPath, 'utf8')).toBe(withSeparatorComment);
  });

  it('dry-run is write-free and confirmation is required only for the later mutation', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const markerPath = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
    const marker = await readFile(markerPath, 'utf8');
    const beforeBackups = await readdir(join(dshHome, '.dshpack', 'backups'));

    const dryRun = await uninstallProfile({ dshHome, profile: 'engine-pack', dryRun: true });
    expect(dryRun).toMatchObject({ exitCode: 0, metadata: { dryRun: true, removedMarker: false } });
    expect(await readFile(markerPath, 'utf8')).toBe(marker);
    expect(await readdir(join(dshHome, '.dshpack', 'backups'))).toEqual(beforeBackups);

    const declined = await uninstallProfile({
      dshHome,
      profile: 'engine-pack',
      interactive: false,
    });
    expect(declined).toMatchObject({
      exitCode: 21,
      diagnostics: [expect.objectContaining({ code: 'E_UNINSTALL_CONFIRM_REQUIRED' })],
    });
    expect(await readFile(markerPath, 'utf8')).toBe(marker);
  });

  it('keep-assets removes only the profile and marker while preserving skills, presets, and settings', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const settingsPath = join(dshHome, 'settings.yaml');
    const settings = await readFile(settingsPath, 'utf8');
    const marker = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'), 'utf8'),
    ) as InstalledMetadataV1;

    const report = await uninstallProfile({
      dshHome,
      profile: 'engine-pack',
      keepAssets: true,
      yes: true,
    });

    expect(report).toMatchObject({ exitCode: 0, metadata: { keepAssets: true } });
    expect(await exists(join(dshHome, 'profiles', 'engine-pack'))).toBe(false);
    for (const asset of marker.assets.filter((asset) => asset.kind !== 'profile'))
      expect(await exists(join(dshHome, ...asset.target.split('/')))).toBe(true);
    expect(await readFile(settingsPath, 'utf8')).toBe(settings);
  });

  it('returns E_NOT_TRACKED with exit 10 without creating state for an absent marker', async () => {
    const dshHome = await home();
    const before = await readdir(dshHome);

    const report = await uninstallProfile({ dshHome, profile: 'missing-pack', dryRun: true });

    expect(report).toMatchObject({
      exitCode: 10,
      diagnostics: [expect.objectContaining({ code: 'E_NOT_TRACKED' })],
    });
    expect(await readdir(dshHome)).toEqual(before);
  });

  it('returns E_NOT_TRACKED before inspecting an unrelated malformed installed entry', async () => {
    const dshHome = await home();
    await mkdir(join(dshHome, '.dshpack', 'installed'), { recursive: true });
    await writeFile(join(dshHome, '.dshpack', 'installed', 'broken.json'), '{not json\n');

    const report = await uninstallProfile({ dshHome, profile: 'missing-pack', dryRun: true });

    expect(report).toMatchObject({
      exitCode: 10,
      diagnostics: [expect.objectContaining({ code: 'E_NOT_TRACKED' })],
    });
  });

  it('rejects a malformed target marker before scanning any peer markers', async () => {
    const dshHome = await home();
    await mkdir(join(dshHome, '.dshpack', 'installed'), { recursive: true });
    const target = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
    await writeFile(target, '{}\n', 'utf8');

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', dryRun: true });

    expect(report).toMatchObject({
      exitCode: EXIT_CODES.CONTRACT,
      diagnostics: [expect.objectContaining({ code: 'E_UNINSTALL_METADATA', path: target })],
    });
  });

  it('classifies a missing absolute DSH_HOME as untracked without creating it', async () => {
    const parent = await home();
    const dshHome = join(parent, 'missing-home');

    const report = await uninstallProfile({ dshHome, profile: 'missing-pack', dryRun: true });

    expect(report).toMatchObject({
      exitCode: 10,
      diagnostics: [expect.objectContaining({ code: 'E_NOT_TRACKED' })],
    });
    expect(await exists(dshHome)).toBe(false);
  });

  it('rejects a non-directory DSH_HOME before reading managed state', async () => {
    const parent = await home();
    const dshHome = join(parent, 'not-a-home');
    await writeFile(dshHome, 'not a directory\n');

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', dryRun: true });

    expect(report).toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_UNINSTALL_HOME' })],
    });
  });

  it('rejects an installed metadata root that is not a directory', async () => {
    const dshHome = await home();
    await mkdir(join(dshHome, '.dshpack'), { recursive: true });
    await writeFile(join(dshHome, '.dshpack', 'installed'), 'not a directory\n');

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', dryRun: true });

    expect(report).toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_UNINSTALL_METADATA' })],
    });
  });

  it('rejects a relative DSH_HOME without touching the filesystem', async () => {
    const report = await uninstallProfile({
      dshHome: 'relative-dsh-home',
      profile: 'engine-pack',
      dryRun: true,
    });

    expect(report).toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_PATH_DSH_HOME' })],
    });
  });

  it.each([
    {
      name: 'a non-marker regular file',
      file: 'notes.txt',
      contents: 'not metadata\n',
      exitCode: 30,
    },
    { name: 'an unsafe profile filename', file: 'Bad.json', contents: '{}\n', exitCode: 30 },
    { name: 'invalid JSON', file: 'broken.json', contents: '{not json\n', exitCode: 30 },
    { name: 'invalid metadata JSON shape', file: 'broken.json', contents: '{}\n', exitCode: 30 },
  ])(
    'fails closed on installed metadata containing $name',
    async ({ file, contents, exitCode }) => {
      const dshHome = await home();
      await expect(
        installPack(
          {
            source: await enginePack(),
            dshHome,
            interactive: false,
            yes: true,
          },
          fakeRuntime().runtime,
        ),
      ).resolves.toMatchObject({ exitCode: 0 });
      await mkdir(join(dshHome, '.dshpack', 'installed'), { recursive: true });
      await writeFile(join(dshHome, '.dshpack', 'installed', file), contents);

      const report = await uninstallProfile({ dshHome, profile: 'engine-pack', dryRun: true });

      expect(report).toMatchObject({
        exitCode,
        diagnostics: [expect.objectContaining({ code: 'E_UNINSTALL_METADATA' })],
      });
    },
  );

  it.each(userMutatedAssets)(
    'reports a missing recorded $label asset without attempting to recreate or delete it',
    async ({ target: assetTarget }) => {
      const dshHome = await home();
      await expect(
        installPack(
          { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
          fakeRuntime().runtime,
        ),
      ).resolves.toMatchObject({ exitCode: 0 });
      const assetRoot = join(dshHome, ...assetTarget.split('/'));
      await rm(assetRoot, { force: true, recursive: true });

      const report = await uninstallProfile({ dshHome, profile: 'engine-pack', dryRun: true });

      expect(report).toMatchObject({
        exitCode: 0,
        metadata: {
          assets: expect.arrayContaining([
            expect.objectContaining({
              target: assetTarget,
              drift: 'missing',
              action: 'missing',
              reason: 'missing',
            }),
          ]),
        },
      });
      expect(await exists(assetRoot)).toBe(false);
    },
  );

  it.each([
    { name: 'a missing settings file', contents: undefined },
    { name: 'a settings document without agent-presets', contents: 'outside: true\n' },
  ])('retains recorded settings keys for $name', async ({ contents }) => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const settingsPath = join(dshHome, 'settings.yaml');
    if (contents === undefined) await rm(settingsPath, { force: true });
    else await writeFile(settingsPath, contents);

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', dryRun: true });

    expect(report).toMatchObject({ exitCode: 0, metadata: { settingsRetained: ['custom'] } });
  });

  it('rejects invalid settings YAML before deleting the marker', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await writeFile(join(dshHome, 'settings.yaml'), 'agent-presets: [\n');

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', dryRun: true });

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_UNINSTALL_SETTINGS' })],
    });
    expect(await exists(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'))).toBe(true);
  });

  it.each([
    { name: 'missing recorded key', contents: 'agent-presets: {}\n' },
    { name: 'user-modified recorded key', contents: 'agent-presets:\n  custom: changed\n' },
  ])('retains settings when it finds a $name', async ({ contents }) => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await writeFile(join(dshHome, 'settings.yaml'), contents);

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', dryRun: true });

    expect(report).toMatchObject({ exitCode: 0, metadata: { settingsRetained: ['custom'] } });
  });

  it('fails closed when an installed metadata directory entry is not a regular file', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        {
          source: await enginePack({ name: 'demo-pack' }),
          dshHome,
          interactive: false,
          yes: true,
        },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await mkdir(join(dshHome, '.dshpack', 'installed', 'directory.json'), { recursive: true });

    const report = await uninstallProfile({ dshHome, profile: 'demo-pack', dryRun: true });

    expect(report).toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_UNINSTALL_METADATA' })],
    });
  });

  it('rejects a settings path replaced with a directory before any uninstall mutation', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await rm(join(dshHome, 'settings.yaml'));
    await mkdir(join(dshHome, 'settings.yaml'));

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', dryRun: true });

    expect(report).toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_UNINSTALL_SETTINGS' })],
    });
  });

  it('rejects a settings document that exceeds the secure read limit before mutation', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const markerPath = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
    const marker = await readFile(markerPath, 'utf8');
    await writeFile(join(dshHome, 'settings.yaml'), Buffer.alloc(1024 * 1024 + 1, 'x'));

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', dryRun: true });

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_UNINSTALL_SETTINGS' })],
    });
    expect(await readFile(markerPath, 'utf8')).toBe(marker);
  });

  it('rejects an asset root that was replaced by a plain file', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const target = join(dshHome, 'skills', 'notes');
    await rm(target, { force: true, recursive: true });
    await writeFile(target, 'not a directory\n');

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', dryRun: true });

    expect(report).toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_UNINSTALL_ASSET_PATH' })],
    });
  });

  it('rejects an oversized file introduced inside a tracked asset', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await writeFile(
      join(dshHome, 'skills', 'notes', 'oversized.txt'),
      Buffer.alloc(1024 * 1024 + 1, 'x'),
    );

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', dryRun: true });

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_UNINSTALL_ASSET_PATH' })],
    });
  });

  it('fails closed when a tracked asset contains a linked child directory', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const outside = await home();
    const linkedChild = join(dshHome, 'skills', 'notes', 'linked-child');
    await symlink(outside, linkedChild, process.platform === 'win32' ? 'junction' : 'dir');

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', dryRun: true });

    expect(report).toMatchObject({
      exitCode: EXIT_CODES.SECURITY,
      diagnostics: [
        expect.objectContaining({
          code: 'E_UNINSTALL_ASSET_PATH',
          path: join(dshHome, 'skills', 'notes'),
        }),
      ],
    });
  });

  it('retains a contract-valid managed document asset rather than treating it as a deletable directory', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const markerPath = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as InstalledMetadataV1;
    const skill = marker.assets.find((asset) => asset.kind === 'skill');
    expect(skill).toBeDefined();
    if (skill === undefined) throw new Error('fixture has no skill asset');
    const target = join(dshHome, '.dshpack', 'managed', 'external.json');
    for (const file of skill.files) {
      const destination = join(target, ...file.path.split('/'));
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(
        join(dshHome, ...skill.target.split('/'), ...file.path.split('/')),
        destination,
      );
    }
    const state = await lstat(target, { bigint: true });
    const managed = {
      ...skill,
      id: 'external',
      kind: 'managed-document' as const,
      target: '.dshpack/managed/external.json',
      identity: `${state.dev}:${state.ino}:${state.birthtimeNs}`,
    };
    await writeFile(
      markerPath,
      `${JSON.stringify({ ...marker, assets: [...marker.assets, managed] })}\n`,
    );

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', dryRun: true });

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: {
        assets: expect.arrayContaining([
          expect.objectContaining({
            target: '.dshpack/managed/external.json',
            action: 'retain',
            reason: 'unsupported-asset',
          }),
        ]),
      },
    });
  });

  it('preserves a target reported as skip by the profile being uninstalled', async () => {
    const dshHome = await home();
    for (const name of ['owner-a', 'observer-b']) {
      await expect(
        installPack(
          {
            source: await enginePack({ assets: true, name }),
            dshHome,
            interactive: false,
            yes: true,
          },
          fakeRuntime().runtime,
        ),
      ).resolves.toMatchObject({ exitCode: 0 });
    }

    const report = await uninstallProfile({ dshHome, profile: 'observer-b', dryRun: true });

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: {
        assets: expect.arrayContaining([
          expect.objectContaining({
            target: 'skills/notes',
            action: 'retain',
            reason: 'skip-user-owned',
          }),
        ]),
      },
    });
    expect(await exists(join(dshHome, 'skills', 'notes'))).toBe(true);
  });

  it('retains all assets conservatively when another installed marker is legacy', async () => {
    const dshHome = await home();
    for (const options of [{ assets: true, name: 'owner-a' }, { name: 'legacy-b' }]) {
      await expect(
        installPack(
          { source: await enginePack(options), dshHome, interactive: false, yes: true },
          fakeRuntime().runtime,
        ),
      ).resolves.toMatchObject({ exitCode: 0 });
    }
    const legacyPath = join(dshHome, '.dshpack', 'installed', 'legacy-b.json');
    const legacy = JSON.parse(await readFile(legacyPath, 'utf8')) as Record<string, unknown>;
    delete legacy.assets;
    delete legacy.settingsContribution;
    delete legacy.generation;
    delete legacy.installedBy;
    legacy.metadataVersion = 0;
    await writeFile(legacyPath, `${JSON.stringify(legacy)}\n`);

    const report = await uninstallProfile({ dshHome, profile: 'owner-a', dryRun: true });

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: {
        legacyProfiles: ['legacy-b'],
        assets: expect.arrayContaining([
          expect.objectContaining({
            target: 'skills/notes',
            action: 'retain',
            reason: 'legacy-profile-reference',
          }),
        ]),
      },
    });
  });

  it('does not report profile removal when a legacy peer retains the profile asset', async () => {
    const dshHome = await home();
    for (const options of [{ assets: true, name: 'owner-a' }, { name: 'legacy-b' }]) {
      await expect(
        installPack(
          { source: await enginePack(options), dshHome, interactive: false, yes: true },
          fakeRuntime().runtime,
        ),
      ).resolves.toMatchObject({ exitCode: 0 });
    }
    const legacyPath = join(dshHome, '.dshpack', 'installed', 'legacy-b.json');
    const legacy = JSON.parse(await readFile(legacyPath, 'utf8')) as Record<string, unknown>;
    delete legacy.assets;
    delete legacy.settingsContribution;
    delete legacy.generation;
    delete legacy.installedBy;
    legacy.metadataVersion = 0;
    await writeFile(legacyPath, `${JSON.stringify(legacy)}\n`);

    const report = await uninstallProfile({ dshHome, profile: 'owner-a', yes: true });

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: { activation: 'unchanged' },
    });
    expect(await exists(join(dshHome, 'profiles', 'owner-a'))).toBe(true);
  });

  it('does not report profile removal when the tracked profile asset is modified', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const profilePackage = join(dshHome, 'profiles', 'engine-pack', 'package.json');
    await writeFile(profilePackage, '{"name":"user-owned-change"}\n');

    const report = await uninstallProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: {
        activation: 'unchanged',
        assets: expect.arrayContaining([
          expect.objectContaining({
            target: 'profiles/engine-pack',
            action: 'retain',
            reason: 'modified',
          }),
        ]),
      },
    });
    expect(await exists(join(dshHome, 'profiles', 'engine-pack'))).toBe(true);
  });

  it('purges a complete generation whose serialized bytes are exactly the managed 10MiB limit', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const path = join(dshHome, '.dshpack', 'generations', 'engine-pack', '0001.json');
    const document = JSON.parse(await readFile(path, 'utf8')) as {
      source: { kind: string; path: string };
    };
    const sourcePath = document.source.path;
    document.source.path = '';
    const padding =
      MAX_TRANSACTION_STATE_BYTES -
      Buffer.byteLength(`${JSON.stringify(document)}\n`, 'utf8') -
      (Buffer.byteLength(JSON.stringify(sourcePath), 'utf8') - 2);
    expect(padding).toBeGreaterThanOrEqual(0);
    document.source.path = `${sourcePath}${'x'.repeat(padding)}`;
    const serialized = `${JSON.stringify(document)}\n`;
    expect(Buffer.byteLength(serialized, 'utf8')).toBe(MAX_TRANSACTION_STATE_BYTES);
    await writeFile(path, serialized);

    const report = await uninstallProfile({
      dshHome,
      profile: 'engine-pack',
      purgeGenerations: true,
      yes: true,
    });

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: { deletedGenerations: ['.dshpack/generations/engine-pack/0001.json'] },
    });
    expect(await exists(path)).toBe(false);
  });

  it('fails closed without purge writes when a complete generation exceeds the managed 10MiB limit', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const path = join(dshHome, '.dshpack', 'generations', 'engine-pack', '0001.json');
    const document = JSON.parse(await readFile(path, 'utf8')) as {
      source: { kind: string; path: string };
    };
    const sourcePath = document.source.path;
    document.source.path = '';
    const padding =
      MAX_TRANSACTION_STATE_BYTES -
      Buffer.byteLength(`${JSON.stringify(document)}\n`, 'utf8') -
      (Buffer.byteLength(JSON.stringify(sourcePath), 'utf8') - 2) +
      1;
    expect(padding).toBeGreaterThanOrEqual(0);
    document.source.path = `${sourcePath}${'x'.repeat(padding)}`;
    const serialized = `${JSON.stringify(document)}\n`;
    expect(Buffer.byteLength(serialized, 'utf8')).toBe(MAX_TRANSACTION_STATE_BYTES + 1);
    await writeFile(path, serialized);
    const before = await logicalSnapshot(dshHome);

    const report = await uninstallProfile({
      dshHome,
      profile: 'engine-pack',
      purgeGenerations: true,
      yes: true,
    });

    expect(report).toMatchObject({
      exitCode: EXIT_CODES.CONTRACT,
      diagnostics: [expect.objectContaining({ code: 'E_UNINSTALL_GENERATION', path })],
    });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('purge-generations removes the current pointer, every profile generation, and only its unreferenced CAS blocks', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const generation = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'generations', 'engine-pack', '0001.json'), 'utf8'),
    ) as { entries: Array<{ sha256: string }> };

    const report = await uninstallProfile({
      dshHome,
      profile: 'engine-pack',
      interactive: false,
      purgeGenerations: true,
      yes: true,
    });

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: {
        purgeGenerations: true,
        removedMarker: true,
        deletedGenerations: ['.dshpack/generations/engine-pack/0001.json'],
      },
    });
    expect(report.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'W_UNINSTALL_PURGE_PENDING' }),
    );
    expect(await exists(join(dshHome, '.dshpack', 'generations', 'engine-pack', 'current'))).toBe(
      false,
    );
    expect(await exists(join(dshHome, '.dshpack', 'generations', 'engine-pack', '0001.json'))).toBe(
      false,
    );
    for (const entry of generation.entries)
      expect(
        await exists(join(dshHome, '.dshpack', 'store', casStoreShard(entry.sha256), entry.sha256)),
      ).toBe(false);
    expect(report.metadata.backupDirectory).toBeDefined();
    const backupDirectory = report.metadata.backupDirectory ?? dshHome;
    const journal = JSON.parse(await readFile(join(backupDirectory, 'journal.json'), 'utf8')) as {
      actions: Array<{ artifact?: string; id: string; kind: string }>;
    };
    const purgedStateActions = journal.actions.filter(
      (action) =>
        action.kind === 'replace' &&
        (action.artifact === 'generation' ||
          action.artifact === 'generation-current' ||
          action.artifact === 'store-block'),
    );
    expect(purgedStateActions.length).toBeGreaterThan(0);
    // A successful purge performs a second, verified quarantine collection of only these
    // immutable state payloads; journal.json remains as the durable audit record.
    for (const action of purgedStateActions)
      expect(await exists(join(backupDirectory, 'old', action.id))).toBe(false);
  });

  it('keeps a verified purge quarantine pending on post-commit failure and lets GC retry it', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const base = createNodeTransactionAdapter();
    const report = await uninstallProfile(
      { dshHome, profile: 'engine-pack', purgeGenerations: true, yes: true },
      {
        createAdapter: () => ({ ...base, purgeGcQuarantineFile: async () => false }),
        createTxid: () => 'uninstall-purge-pending',
      },
    );

    expect(report).toMatchObject({
      exitCode: 0,
      diagnostics: [expect.objectContaining({ code: 'W_UNINSTALL_PURGE_PENDING' })],
      metadata: { pendingPurge: true },
    });
    const backupDirectory = report.metadata.backupDirectory;
    expect(backupDirectory).toBeDefined();
    const journal = JSON.parse(
      await readFile(join(backupDirectory ?? dshHome, 'journal.json'), 'utf8'),
    ) as {
      actions: Array<{ artifact?: string; id: string; kind: string }>;
    };
    const pendingStateAction = journal.actions.find(
      (action) =>
        action.kind === 'replace' &&
        (action.artifact === 'generation' || action.artifact === 'store-block'),
    );
    expect(pendingStateAction).toBeDefined();
    expect(
      await exists(join(backupDirectory ?? dshHome, 'old', pendingStateAction?.id ?? '')),
    ).toBe(true);

    const retried = await runGc({ dshHome, dryRun: false });

    expect(retried.exitCode).toBe(0);
    expect(
      await exists(join(backupDirectory ?? dshHome, 'old', pendingStateAction?.id ?? '')),
    ).toBe(false);
  });

  it('reports manual recovery when post-commit purge cannot release its artifact lock', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const base = createNodeTransactionAdapter();
    let acquisitions = 0;
    const adapter: TransactionAdapter = {
      ...base,
      async acquireArtifactLock(homePath) {
        const lock = await base.acquireArtifactLock(homePath);
        acquisitions += 1;
        if (acquisitions !== 2) return lock;
        const release = lock.release.bind(lock);
        lock.release = async () => {
          await release();
          throw new Error('injected purge lock release failure');
        };
        return lock;
      },
    };

    const report = await uninstallProfile(
      { dshHome, profile: 'engine-pack', purgeGenerations: true, yes: true },
      { createAdapter: () => adapter, createTxid: () => 'uninstall-purge-release-failure' },
    );

    expect(report).toMatchObject({
      exitCode: EXIT_CODES.MANUAL_RECOVERY_REQUIRED,
      diagnostics: [expect.objectContaining({ code: 'E_GC_QUARANTINE_LOCK_RELEASE' })],
      metadata: {
        removedMarker: true,
        activation: 'profile-removed',
        pendingPurge: false,
        manualRecovery: [expect.objectContaining({ actionId: 'artifact-lock' })],
      },
    });
    expect(await exists(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'))).toBe(false);
  });

  it('keeps activation unchanged when post-commit purge recovery retained a modified profile', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await writeFile(join(dshHome, 'profiles', 'engine-pack', 'USER_PROFILE.md'), 'keep profile\n');
    const base = createNodeTransactionAdapter();
    let acquisitions = 0;
    const adapter: TransactionAdapter = {
      ...base,
      async acquireArtifactLock(homePath) {
        const lock = await base.acquireArtifactLock(homePath);
        acquisitions += 1;
        if (acquisitions !== 2) return lock;
        const release = lock.release.bind(lock);
        lock.release = async () => {
          await release();
          throw new Error('injected retained-profile purge lock release failure');
        };
        return lock;
      },
    };

    const report = await uninstallProfile(
      { dshHome, profile: 'engine-pack', purgeGenerations: true, yes: true },
      { createAdapter: () => adapter, createTxid: () => 'uninstall-purge-retained-profile' },
    );

    expect(report).toMatchObject({
      exitCode: EXIT_CODES.MANUAL_RECOVERY_REQUIRED,
      metadata: { removedMarker: true, activation: 'unchanged' },
    });
    expect(await exists(join(dshHome, 'profiles', 'engine-pack'))).toBe(true);
  });

  it('exposes the purge deletion plan during dry-run without writing it', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const before = await logicalSnapshot(dshHome);

    const report = await uninstallProfile({
      dshHome,
      profile: 'engine-pack',
      purgeGenerations: true,
      dryRun: true,
    });

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: {
        deletedGenerations: ['.dshpack/generations/engine-pack/0001.json'],
      },
    });
    expect(report.metadata.deletedBlocks.length).toBeGreaterThan(0);
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('purge-generations retains CAS blocks still referenced by another profile history', async () => {
    const dshHome = await home();
    for (const name of ['owner-a', 'owner-b']) {
      await expect(
        installPack(
          {
            source: await enginePack({ assets: true, name }),
            dshHome,
            interactive: false,
            yes: true,
          },
          fakeRuntime().runtime,
        ),
      ).resolves.toMatchObject({ exitCode: 0 });
    }
    const readEntries = async (profile: string) =>
      (
        JSON.parse(
          await readFile(join(dshHome, '.dshpack', 'generations', profile, '0001.json'), 'utf8'),
        ) as { entries: Array<{ sha256: string }> }
      ).entries.map((entry) => entry.sha256);
    const first = new Set(await readEntries('owner-a'));
    const shared = (await readEntries('owner-b')).find((digest) => first.has(digest));
    expect(shared).toBeDefined();

    const report = await uninstallProfile({
      dshHome,
      profile: 'owner-a',
      purgeGenerations: true,
      yes: true,
    });

    expect(report.exitCode).toBe(0);
    expect(report.metadata.deletedBlocks).not.toContain(shared);
    expect(
      await exists(join(dshHome, '.dshpack', 'store', casStoreShard(shared ?? ''), shared ?? '')),
    ).toBe(true);
  });

  it('reports a corrupt referenced CAS block through the managed-state contract', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const generation = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'generations', 'engine-pack', '0001.json'), 'utf8'),
    ) as { entries: Array<{ sha256: string }> };
    const digest = generation.entries[0]?.sha256;
    if (digest === undefined) throw new Error('fixture did not create a CAS entry');
    const block = join(dshHome, '.dshpack', 'store', casStoreShard(digest), digest);
    await writeFile(block, 'corrupt immutable bytes\n');

    const report = await uninstallProfile({
      dshHome,
      profile: 'engine-pack',
      purgeGenerations: true,
      dryRun: true,
    });

    expect(report).toMatchObject({
      exitCode: EXIT_CODES.CONTRACT,
      diagnostics: [expect.objectContaining({ code: 'E_MANAGEMENT_CAS', path: block })],
    });
  });

  it('fails closed when referenced CAS storage contains an unsafe sibling entry', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const generation = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'generations', 'engine-pack', '0001.json'), 'utf8'),
    ) as { entries: Array<{ sha256: string }> };
    const digest = generation.entries[0]?.sha256;
    if (digest === undefined) throw new Error('fixture did not create a CAS entry');
    const shard = join(dshHome, '.dshpack', 'store', casStoreShard(digest));
    const unsafeEntry = join(shard, 'not-a-cas-block');
    await writeFile(unsafeEntry, 'unsafe sibling\n');

    const report = await uninstallProfile({
      dshHome,
      profile: 'engine-pack',
      purgeGenerations: true,
      dryRun: true,
    });

    expect(report).toMatchObject({
      exitCode: EXIT_CODES.SECURITY,
      diagnostics: [expect.objectContaining({ code: 'E_MANAGEMENT_CAS', path: shard })],
    });
  });

  it.each([
    { name: 'a non-generation filename', filename: 'unexpected.txt' },
    { name: 'generation zero', filename: '0000.json' },
    { name: 'a non-canonical generation sequence', filename: '01.json' },
  ])('refuses purge when history contains $name', async ({ filename }) => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await writeFile(join(dshHome, '.dshpack', 'generations', 'engine-pack', filename), '{}\n');

    const report = await uninstallProfile({
      dshHome,
      profile: 'engine-pack',
      purgeGenerations: true,
      dryRun: true,
    });

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_UNINSTALL_GENERATION' })],
    });
  });

  it('maps a malformed valid-name generation to a contract report without starting purge writes', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const path = join(dshHome, '.dshpack', 'generations', 'engine-pack', '0001.json');
    await writeFile(path, '{}\n');
    const before = await logicalSnapshot(dshHome);

    const report = await uninstallProfile({
      dshHome,
      profile: 'engine-pack',
      purgeGenerations: true,
      yes: true,
    });

    expect(report).toMatchObject({
      exitCode: EXIT_CODES.CONTRACT,
      diagnostics: [expect.objectContaining({ code: 'E_MANAGEMENT_GENERATION', path })],
    });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('refuses purge when generation state contains an unsafe profile directory', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await mkdir(join(dshHome, '.dshpack', 'generations', 'Unsafe-Profile'));

    const report = await uninstallProfile({
      dshHome,
      profile: 'engine-pack',
      purgeGenerations: true,
      dryRun: true,
    });

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_UNINSTALL_GENERATION' })],
    });
  });

  it('refuses purge when a generation entry is not a regular file', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await mkdir(join(dshHome, '.dshpack', 'generations', 'engine-pack', '0002.json'));

    const report = await uninstallProfile({
      dshHome,
      profile: 'engine-pack',
      purgeGenerations: true,
      dryRun: true,
    });

    expect(report).toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_UNINSTALL_GENERATION' })],
    });
  });

  it.each([
    { name: 'is absent', current: undefined },
    { name: 'is not a positive sequence', current: '0\n' },
    { name: 'does not name an existing generation', current: '999\n' },
  ])('refuses purge when the generation current pointer $name', async ({ current }) => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const path = join(dshHome, '.dshpack', 'generations', 'engine-pack', 'current');
    if (current === undefined) await rm(path, { force: true });
    else await writeFile(path, current);

    const report = await uninstallProfile({
      dshHome,
      profile: 'engine-pack',
      purgeGenerations: true,
      dryRun: true,
    });

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_UNINSTALL_GENERATION' })],
    });
  });

  it('rejects a custom purge transaction id outside the dedicated namespace before mutation', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const before = await logicalSnapshot(dshHome);

    const report = await uninstallProfile(
      { dshHome, profile: 'engine-pack', purgeGenerations: true, yes: true },
      { createTxid: () => 'uninstall-incorrect-purge-namespace' },
    );

    expect(report).toMatchObject({
      exitCode: EXIT_CODES.CONTRACT,
      diagnostics: [expect.objectContaining({ code: 'E_UNINSTALL_PURGE_TXID' })],
    });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('requires force for legacy metadata and otherwise gives the exact migration hint', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const markerPath = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
    const v1 = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
    delete v1.assets;
    delete v1.settingsContribution;
    delete v1.generation;
    delete v1.installedBy;
    v1.metadataVersion = 0;
    await writeFile(markerPath, `${JSON.stringify(v1)}\n`);

    const blocked = await uninstallProfile({ dshHome, profile: 'engine-pack', yes: true });
    expect(blocked).toMatchObject({
      exitCode: 30,
      diagnostics: [
        expect.objectContaining({
          code: 'E_UNINSTALL_LEGACY',
          hint: 'Run dshpack migrate engine-pack, or use --force to remove only the profile and marker.',
        }),
      ],
    });
    expect(await exists(markerPath)).toBe(true);

    const forced = await uninstallProfile(
      {
        dshHome,
        profile: 'engine-pack',
        force: true,
        yes: true,
      },
      {
        async runDoctor() {
          return {
            diagnostics: [
              {
                code: 'DSH998',
                severity: 'error' as const,
                message: 'unrelated legacy peer problem',
                hint: 'test only',
                evidence: 'local' as const,
                path: join(dshHome, 'skills', 'unrelated', 'SKILL.md'),
              },
            ],
            exitCode: EXIT_CODES.CONTRACT,
            metadata: { sideEffects: [] },
          };
        },
      },
    );
    expect(forced.exitCode).toBe(0);
    expect(forced.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'W_UNINSTALL_DOCTOR_PREEXISTING' }),
    );
    expect(await exists(markerPath)).toBe(false);
    expect(await exists(join(dshHome, 'profiles', 'engine-pack'))).toBe(false);
  });

  it('completes forced legacy marker cleanup when the user already removed its profile directory', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const markerPath = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
    const v1 = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
    delete v1.assets;
    delete v1.settingsContribution;
    delete v1.generation;
    delete v1.installedBy;
    v1.metadataVersion = 0;
    await writeFile(markerPath, `${JSON.stringify(v1)}\n`);
    await rm(join(dshHome, 'profiles', 'engine-pack'), { force: true, recursive: true });

    const report = await uninstallProfile({
      dshHome,
      profile: 'engine-pack',
      force: true,
      yes: true,
    });

    expect(report).toMatchObject({ exitCode: 0, metadata: { activation: 'unchanged' } });
    expect(await exists(markerPath)).toBe(false);
  });

  it.each([
    { force: false, purgeGenerations: false, expectedExit: 30, expectedCode: 'E_UNINSTALL_LEGACY' },
    { force: true, purgeGenerations: false, expectedExit: 0, expectedCode: undefined },
    { force: true, purgeGenerations: true, expectedExit: 0, expectedCode: undefined },
  ])(
    'reads a v0 target before an unrelated malformed peer when force is $force and purge is $purgeGenerations',
    async ({ force, purgeGenerations, expectedExit, expectedCode }) => {
      const dshHome = await home();
      await expect(
        installPack(
          { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
          fakeRuntime().runtime,
        ),
      ).resolves.toMatchObject({ exitCode: 0 });
      const markerPath = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
      delete marker.assets;
      delete marker.settingsContribution;
      delete marker.generation;
      delete marker.installedBy;
      marker.metadataVersion = 0;
      await writeFile(markerPath, `${JSON.stringify(marker)}\n`);
      await writeFile(join(dshHome, '.dshpack', 'installed', 'broken-peer.json'), '{not json\n');

      const report = await uninstallProfile({
        dshHome,
        profile: 'engine-pack',
        force,
        purgeGenerations,
        dryRun: true,
      });

      expect(report.exitCode).toBe(expectedExit);
      if (expectedCode !== undefined)
        expect(report.diagnostics).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: expectedCode })]),
        );
      else expect(report.diagnostics).not.toEqual(expect.arrayContaining([expect.anything()]));
    },
  );

  it('reports an unexpected transaction-adapter construction error without deleting the marker', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const markerPath = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
    const marker = await readFile(markerPath, 'utf8');

    const report = await uninstallProfile(
      { dshHome, profile: 'engine-pack', yes: true },
      {
        createAdapter: () => {
          throw new Error('adapter construction failed');
        },
      },
    );

    expect(report).toMatchObject({
      exitCode: 70,
      diagnostics: [expect.objectContaining({ code: 'E_UNINSTALL_INTERNAL' })],
    });
    expect(await readFile(markerPath, 'utf8')).toBe(marker);
  });

  it('reports committed uninstall facts when its transaction lock release requires recovery', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const base = createNodeTransactionAdapter();
    const adapter: TransactionAdapter = {
      ...base,
      async acquireArtifactLock(homePath) {
        const lock = await base.acquireArtifactLock(homePath);
        const release = lock.release.bind(lock);
        lock.release = async () => {
          await release();
          throw new Error('injected committed uninstall lock release failure');
        };
        return lock;
      },
    };

    const report = await uninstallProfile(
      { dshHome, profile: 'engine-pack', yes: true },
      { createAdapter: () => adapter },
    );

    expect(report).toMatchObject({
      exitCode: EXIT_CODES.MANUAL_RECOVERY_REQUIRED,
      diagnostics: [
        expect.objectContaining({ code: 'E_TRANSACTION_ARTIFACT_LOCK_RELEASE_FAILED' }),
      ],
      metadata: {
        removedMarker: true,
        activation: 'profile-removed',
        generation: 2,
        manualRecovery: [expect.objectContaining({ actionId: 'artifact-lock' })],
      },
    });
    expect(await exists(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'))).toBe(false);
  });

  it('keeps activation unchanged when a committed lock-release failure retained a modified profile', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await writeFile(join(dshHome, 'profiles', 'engine-pack', 'USER_PROFILE.md'), 'keep profile\n');
    const base = createNodeTransactionAdapter();
    const adapter: TransactionAdapter = {
      ...base,
      async acquireArtifactLock(homePath) {
        const lock = await base.acquireArtifactLock(homePath);
        const release = lock.release.bind(lock);
        lock.release = async () => {
          await release();
          throw new Error('injected retained-profile lock release failure');
        };
        return lock;
      },
    };

    const report = await uninstallProfile(
      { dshHome, profile: 'engine-pack', yes: true },
      { createAdapter: () => adapter },
    );

    expect(report).toMatchObject({
      exitCode: EXIT_CODES.MANUAL_RECOVERY_REQUIRED,
      metadata: { removedMarker: true, activation: 'unchanged' },
    });
    expect(await exists(join(dshHome, 'profiles', 'engine-pack'))).toBe(true);
  });

  it('marks purge quarantine pending when the committed uninstall transaction cannot release its lock', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const base = createNodeTransactionAdapter();
    const adapter: TransactionAdapter = {
      ...base,
      async acquireArtifactLock(homePath) {
        const lock = await base.acquireArtifactLock(homePath);
        const release = lock.release.bind(lock);
        lock.release = async () => {
          await release();
          throw new Error('injected committed purge transaction lock release failure');
        };
        return lock;
      },
    };

    const report = await uninstallProfile(
      { dshHome, profile: 'engine-pack', purgeGenerations: true, yes: true },
      { createAdapter: () => adapter, createTxid: () => 'uninstall-purge-commit-release' },
    );

    expect(report).toMatchObject({
      exitCode: EXIT_CODES.MANUAL_RECOVERY_REQUIRED,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'E_TRANSACTION_ARTIFACT_LOCK_RELEASE_FAILED' }),
        expect.objectContaining({ code: 'W_UNINSTALL_PURGE_PENDING' }),
      ]),
      metadata: {
        removedMarker: true,
        activation: 'profile-removed',
        pendingPurge: true,
        manualRecovery: [expect.objectContaining({ actionId: 'artifact-lock' })],
      },
    });
    expect(await exists(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'))).toBe(false);
  });

  it('rolls back the complete logical snapshot when strict doctor finds an uninstall-owned error', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const before = await logicalSnapshot(dshHome);
    const dependencies = {
      async runDoctor() {
        return {
          diagnostics: [
            {
              code: 'DSH999',
              severity: 'error' as const,
              message: 'the removed skill is invalid',
              hint: 'test only',
              evidence: 'local' as const,
              path: join(dshHome, 'skills', 'notes', 'SKILL.md'),
            },
          ],
          exitCode: EXIT_CODES.CONTRACT,
          metadata: { sideEffects: [] },
        };
      },
    } as Parameters<typeof uninstallProfile>[1] & {
      runDoctor: () => Promise<unknown>;
    };

    const report = await uninstallProfile(
      { dshHome, profile: 'engine-pack', yes: true },
      dependencies,
    );

    expect(report).toMatchObject({ exitCode: 24, metadata: { removedMarker: false } });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('rolls back when strict doctor throws before producing a report', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const before = await logicalSnapshot(dshHome);

    const report = await uninstallProfile(
      { dshHome, profile: 'engine-pack', yes: true },
      {
        async runDoctor() {
          throw new Error('doctor process unavailable');
        },
      },
    );

    expect(report).toMatchObject({
      exitCode: EXIT_CODES.POST_INSTALL_VERIFY_FAILURE,
      diagnostics: [expect.objectContaining({ code: 'E_UNINSTALL_DOCTOR' })],
      metadata: { removedMarker: false },
    });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('rolls back when strict doctor fails closed without diagnostics', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const before = await logicalSnapshot(dshHome);

    const report = await uninstallProfile(
      { dshHome, profile: 'engine-pack', yes: true },
      {
        async runDoctor() {
          return {
            diagnostics: [],
            exitCode: EXIT_CODES.CONTRACT,
            metadata: { sideEffects: [] },
          };
        },
      },
    );

    expect(report).toMatchObject({
      exitCode: EXIT_CODES.POST_INSTALL_VERIFY_FAILURE,
      diagnostics: [expect.objectContaining({ code: 'E_UNINSTALL_DOCTOR' })],
      metadata: { removedMarker: false },
    });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('warns but commits when strict doctor only finds a preexisting unrelated problem', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const dependencies = {
      async runDoctor() {
        return {
          diagnostics: [
            {
              code: 'DSH998',
              severity: 'error' as const,
              message: 'another profile is invalid',
              hint: 'test only',
              evidence: 'local' as const,
              path: join(dshHome, 'skills', 'unrelated', 'SKILL.md'),
            },
          ],
          exitCode: EXIT_CODES.CONTRACT,
          metadata: { sideEffects: [] },
        };
      },
    } as Parameters<typeof uninstallProfile>[1] & {
      runDoctor: () => Promise<unknown>;
    };

    const report = await uninstallProfile(
      { dshHome, profile: 'engine-pack', yes: true },
      dependencies,
    );

    expect(report.exitCode).toBe(0);
    expect(report.metadata.removedMarker).toBe(true);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'W_UNINSTALL_DOCTOR_PREEXISTING' }),
    );
  });

  it('restores the complete logical snapshot when purge fails after state moves', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const before = await logicalSnapshot(dshHome);
    const base = createNodeTransactionAdapter();
    const adapter: TransactionAdapter = {
      ...base,
      async moveArtifactPath(...args: Parameters<typeof base.moveArtifactPath>) {
        if (args[1] === 'managed-document') {
          throw new TransactionFailure(EXIT_CODES.POST_INSTALL_VERIFY_FAILURE, [
            {
              code: 'E_UNINSTALL_FAULT',
              severity: 'error',
              message: 'injected marker deletion failure',
              hint: 'test only',
              evidence: 'local',
            },
          ]);
        }
        return base.moveArtifactPath(...args);
      },
    };

    const report = await uninstallProfile(
      { dshHome, profile: 'engine-pack', purgeGenerations: true, yes: true },
      { createAdapter: () => adapter },
    );

    expect(report).toMatchObject({ exitCode: 24, metadata: { removedMarker: false } });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });
});
