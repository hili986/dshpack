import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';

import { writeReport } from '../src/commands/shared.js';
import { EXIT_CODES } from '../src/exit-codes.js';
import { installPack } from '../src/install/engine.js';
import { readMarker, restoreProfile } from '../src/restore/engine.js';
import { uninstallProfile } from '../src/uninstall/engine.js';
import { updateProfile } from '../src/update/engine.js';
import { removeFixtureDirectory } from './fixture-cleanup.js';
import { enginePack, fakeRuntime, snapshot } from './install-engine-fixture.js';

// The subject of this file is update semantics; the `uninstallProfile` calls below are probes
// that ask "what does uninstall do with the ownership this update recorded?". Uninstall ends by
// running doctor to verify the state it left, and doctor resolves `dsh --version` — falling back
// to `npx --yes @deepseek-ai/dsh` when `dsh` is absent from PATH. That makes an update unit test
// download a package over the network, which is why the three probes below consumed whatever
// per-test ceiling CI offered (20s at a 20s limit, 60s at a 60s limit) on a runner with no `dsh`.
// `uninstall-engine.test.ts` already stubs doctor the same way for the same reason.
//
// This hides no defect: the underlying hang — `timeout` cannot be enforced when the killed child
// leaves a grandchild holding the stdio pipes, because `killDescendants: false` forbids tree
// kills — is tracked as its own fix with its own regression test. It does not belong to update.
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

const homes = new Set<string>();

async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dshpack-update-engine-'));
  homes.add(directory);
  return directory;
}

afterEach(async () => {
  // Drain before removing: a cleanup that still throws must not leave the set populated,
  // or every later test re-attempts the whole backlog and the cost grows quadratically.
  const pending = [...homes];
  homes.clear();
  await Promise.all(pending.map((directory) => removeFixtureDirectory(directory)));
});

function sha512(value: string): string {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

async function replaceTargetFile(target: string, path: string, contents: string): Promise<void> {
  await writeFile(join(target, ...path.split('/')), contents);
  const lockPath = join(target, 'pack.lock.yml');
  const lock = parse(await readFile(lockPath, 'utf8')) as {
    files: Array<{ path: string; sha512: string }>;
  };
  const entry = lock.files.find((file) => file.path === path);
  if (entry === undefined) throw new Error(`fixture lock lacks ${path}`);
  entry.sha512 = sha512(contents);
  await writeFile(lockPath, stringify(lock, { lineWidth: 0 }));
}

async function addTargetFile(target: string, path: string, contents: string): Promise<void> {
  await writeFile(join(target, ...path.split('/')), contents);
  const lockPath = join(target, 'pack.lock.yml');
  const lock = parse(await readFile(lockPath, 'utf8')) as {
    files: Array<{ path: string; sha512: string }>;
  };
  lock.files.push({ path, sha512: sha512(contents) });
  await writeFile(lockPath, stringify(lock, { lineWidth: 0 }));
}

async function removeTargetFiles(target: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) await rm(join(target, ...path.split('/')), { recursive: true });
  const lockPath = join(target, 'pack.lock.yml');
  const lock = parse(await readFile(lockPath, 'utf8')) as {
    files: Array<{ path: string; sha512: string }>;
  };
  lock.files = lock.files.filter((file) => !paths.some((path) => file.path.startsWith(path)));
  await writeFile(lockPath, stringify(lock, { lineWidth: 0 }));
}

async function removeTargetSettings(target: string): Promise<void> {
  const manifestPath = join(target, 'pack.yml');
  const manifest = parse(await readFile(manifestPath, 'utf8')) as {
    defaults: Record<string, unknown>;
    settings?: unknown;
  };
  delete manifest.settings;
  delete manifest.defaults.agentPreset;
  const manifestText = stringify(manifest, { lineWidth: 0 });
  await writeFile(manifestPath, manifestText);
  await removeTargetFiles(target, ['settings/agent-presets.yml']);
  const lockPath = join(target, 'pack.lock.yml');
  const lock = parse(await readFile(lockPath, 'utf8')) as {
    manifestSha256: string;
  };
  lock.manifestSha256 = `sha256-${createHash('sha256').update(manifestText).digest('base64url')}`;
  await writeFile(lockPath, stringify(lock, { lineWidth: 0 }));
}

async function bumpTargetVersion(target: string): Promise<void> {
  const manifestPath = join(target, 'pack.yml');
  const manifest = parse(await readFile(manifestPath, 'utf8')) as { version: string };
  manifest.version = '1.0.1';
  const manifestText = stringify(manifest, { lineWidth: 0 });
  await writeFile(manifestPath, manifestText);
  const lockPath = join(target, 'pack.lock.yml');
  const lock = parse(await readFile(lockPath, 'utf8')) as { manifestSha256: string };
  lock.manifestSha256 = `sha256-${createHash('sha256').update(manifestText).digest('base64url')}`;
  await writeFile(lockPath, stringify(lock, { lineWidth: 0 }));
}

function updateInput(dshHome: string, profile: string, target: string, extra = {}) {
  return { dshHome, profile, to: target, interactive: false, yes: true, ...extra };
}

async function installedAssets() {
  const dshHome = await home();
  const source = await enginePack({ assets: true });
  const fixture = fakeRuntime();
  const installed = await installPack(
    { source, dshHome, interactive: false, frozen: true, yes: true },
    fixture.runtime,
  );
  expect(installed.exitCode).toBe(EXIT_CODES.SUCCESS);
  return { dshHome, fixture, profile: 'engine-pack' };
}

async function installedProfileOnly() {
  const dshHome = await home();
  const source = await enginePack();
  const fixture = fakeRuntime();
  const installed = await installPack(
    { source, dshHome, interactive: false, frozen: true, yes: true },
    fixture.runtime,
  );
  expect(installed.exitCode).toBe(EXIT_CODES.SUCCESS);
  return { dshHome, fixture, profile: 'engine-pack' };
}

async function installedAssetsWithPlugin() {
  const dshHome = await home();
  const source = await enginePack({ assets: true, plugin: { allowBuilds: false } });
  const fixture = fakeRuntime();
  const installed = await installPack(
    { source, dshHome, interactive: false, frozen: true, yes: true },
    fixture.runtime,
  );
  expect(installed.exitCode).toBe(EXIT_CODES.SUCCESS);
  return { dshHome, fixture, profile: 'engine-pack' };
}

describe('update apply merge', () => {
  it('creates an upstream-added skill from an absent managed base', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    await addTargetFile(
      target,
      'skills/research.md',
      '---\nname: research\ndescription: target\n---\n# Research\n',
    );

    const result = await updateProfile(
      updateInput(current.dshHome, current.profile, target),
      current.fixture.runtime,
    );

    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(result.metadata.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'skills/research', action: 'create' }),
      ]),
    );
    expect(
      await readFile(join(current.dshHome, 'skills', 'research', 'SKILL.md'), 'utf8'),
    ).toContain('# Research');
  });

  it('keeps a baseline-less deferred new asset valid across repeated partial updates', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    await addTargetFile(
      target,
      'skills/research.md',
      '---\nname: research\ndescription: target\n---\n# Research\n',
    );
    const input = updateInput(current.dshHome, current.profile, target, {
      only: ['setting:custom'],
    });

    const first = await updateProfile(input, current.fixture.runtime);
    expect(first.exitCode).toBe(EXIT_CODES.SUCCESS);
    const firstMarker = await readMarker(current.dshHome, current.profile);
    const firstResearch = firstMarker.marker?.metadata.deferredAssets?.find(
      (asset) => asset.target === 'skills/research',
    );
    expect(firstResearch).toMatchObject({ target: 'skills/research', reason: 'only' });
    expect(firstResearch === undefined ? false : Object.hasOwn(firstResearch, 'baseline')).toBe(
      false,
    );

    const second = await updateProfile(input, current.fixture.runtime);
    expect(second).toMatchObject({ exitCode: EXIT_CODES.SUCCESS });
    const secondMarker = await readMarker(current.dshHome, current.profile);
    expect(secondMarker.marker).toBeDefined();
    const secondResearch = secondMarker.marker?.metadata.deferredAssets?.find(
      (asset) => asset.target === 'skills/research',
    );
    expect(secondResearch).toMatchObject({ target: 'skills/research', reason: 'only' });
    expect(secondResearch === undefined ? false : Object.hasOwn(secondResearch, 'baseline')).toBe(
      false,
    );
  });

  it('preserves __proto__ settings across target create, update, and delete', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    const settingsPath = join(current.dshHome, 'settings.yaml');
    await replaceTargetFile(
      target,
      'settings/agent-presets.yml',
      "custom:\n  model: fixture\n'__proto__':\n  model: create\n",
    );

    const created = await updateProfile(
      updateInput(current.dshHome, current.profile, target),
      current.fixture.runtime,
    );
    expect(created.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(settingsPath, 'utf8')).toMatch(/['"]?__proto__['"]?:/u);
    expect(
      (await readMarker(current.dshHome, current.profile)).marker?.metadata.settingsContribution
        .keys,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: '__proto__',
          canonicalValue: expect.stringContaining('create'),
        }),
      ]),
    );

    await replaceTargetFile(
      target,
      'settings/agent-presets.yml',
      "custom:\n  model: fixture\n'__proto__':\n  model: update\n",
    );
    const updated = await updateProfile(
      updateInput(current.dshHome, current.profile, target),
      current.fixture.runtime,
    );
    expect(updated.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(settingsPath, 'utf8')).toContain('model: update');

    await replaceTargetFile(target, 'settings/agent-presets.yml', 'custom:\n  model: fixture\n');
    const removed = await updateProfile(
      updateInput(current.dshHome, current.profile, target),
      current.fixture.runtime,
    );
    expect(removed.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(settingsPath, 'utf8')).not.toMatch(/['"]?__proto__['"]?:/u);
    expect(
      (await readMarker(current.dshHome, current.profile)).marker?.metadata.settingsContribution
        .keys,
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ key: '__proto__' })]));
  });

  it('does not replay a token-like local update source after a transitive build rejection', async () => {
    const current = await installedAssets();
    const token = 'source-token-must-not-leak';
    const sourceRoot = await mkdtemp(join(tmpdir(), `dshpack-update-${token}-`));
    homes.add(sourceRoot);
    const target = join(sourceRoot, 'target');
    await rename(await enginePack({ assets: true, name: current.profile }), target);
    await bumpTargetVersion(target);
    const runtime = fakeRuntime({ transitive: ['transitive-build'] });

    const result = await updateProfile(
      updateInput(current.dshHome, current.profile, target),
      runtime.runtime,
    );

    expect(result.exitCode).toBe(EXIT_CODES.USER_DECLINED);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_BUILD_TRANSITIVE' })]),
    );
    const human: string[] = [];
    const json: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      human.push(String(chunk));
      return true;
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      json.push(String(chunk));
      return true;
    });
    try {
      writeReport(result, false);
      writeReport(result, true);
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
      process.exitCode = undefined;
    }
    expect(JSON.stringify(result)).not.toContain(token);
    expect(human.join('')).not.toContain(token);
    expect(json.join('')).not.toContain(token);
  });

  it('writes target skill and setting bytes when base still matches current', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    await replaceTargetFile(
      target,
      'skills/notes.md',
      '---\nname: notes\ndescription: target\n---\n# Target notes\n',
    );
    await replaceTargetFile(target, 'settings/agent-presets.yml', 'custom:\n  model: target\n');

    const result = await updateProfile(
      {
        dshHome: current.dshHome,
        profile: current.profile,
        to: target,
        interactive: false,
        yes: true,
      },
      current.fixture.runtime,
    );

    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(join(current.dshHome, 'skills', 'notes', 'SKILL.md'), 'utf8')).toContain(
      '# Target notes',
    );
    expect(await readFile(join(current.dshHome, 'settings.yaml'), 'utf8')).toContain(
      'model: target',
    );
    const marker = await readMarker(current.dshHome, current.profile);
    expect(marker.marker?.metadata.settingsContribution.keys).toEqual([
      expect.objectContaining({ key: 'custom', canonicalValue: expect.stringContaining('target') }),
    ]);
    const generation = parse(
      await readFile(
        join(current.dshHome, '.dshpack', 'generations', current.profile, '0002.json'),
        'utf8',
      ),
    ) as { operation: string; metadata: unknown };
    expect(generation.operation).toBe('update');
    expect(generation.metadata).toEqual(marker.marker?.metadata);
  });

  it('dry-run returns the exact asset and settings conflicts without writing', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    await replaceTargetFile(
      target,
      'skills/notes.md',
      '---\nname: notes\ndescription: target\n---\n# Target notes\n',
    );
    await replaceTargetFile(target, 'settings/agent-presets.yml', 'custom:\n  model: target\n');
    await writeFile(join(current.dshHome, 'skills', 'notes', 'SKILL.md'), '# User notes\n');
    await writeFile(
      join(current.dshHome, 'settings.yaml'),
      'agent-presets:\n  custom:\n    model: user\n',
    );
    const before = await snapshot(current.dshHome);
    const callsBefore = current.fixture.calls.length;

    const result = await updateProfile(
      updateInput(current.dshHome, current.profile, target, { dryRun: true }),
      current.fixture.runtime,
    );

    expect(result.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(result.metadata.status).toBe('preflight');
    expect(result.metadata.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'skills/notes', action: 'conflict' }),
      ]),
    );
    expect(result.metadata.settings).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'custom', action: 'conflict' })]),
    );
    expect(result.diagnostics.filter((item) => item.code === 'E_UPDATE_CONFLICT')).toHaveLength(2);
    expect(await snapshot(current.dshHome)).toEqual(before);
    expect(
      current.fixture.calls.slice(callsBefore).filter((call) => call.startsWith('stage:')),
    ).toEqual([]);
  });

  it('dry-run reports an unsafe current settings document without writing', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    const settingsPath = join(current.dshHome, 'settings.yaml');
    await writeFile(settingsPath, '- not-a-mapping\n');
    const before = await snapshot(current.dshHome);
    const callsBefore = current.fixture.calls.length;

    const result = await updateProfile(
      updateInput(current.dshHome, current.profile, target, { dryRun: true }),
      current.fixture.runtime,
    );

    expect(result.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_SETTINGS_ROOT' })]),
    );
    expect(await snapshot(current.dshHome)).toEqual(before);
    expect(
      current.fixture.calls.slice(callsBefore).filter((call) => call.startsWith('stage:')),
    ).toEqual([]);
  });

  it('aggregates asset and setting conflicts without writing by default, then --theirs writes both', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    await replaceTargetFile(
      target,
      'skills/notes.md',
      '---\nname: notes\ndescription: target\n---\n# Target notes\n',
    );
    await replaceTargetFile(target, 'settings/agent-presets.yml', 'custom:\n  model: target\n');
    const skillPath = join(current.dshHome, 'skills', 'notes', 'SKILL.md');
    const settingsPath = join(current.dshHome, 'settings.yaml');
    await writeFile(skillPath, '# user notes\n');
    await writeFile(settingsPath, 'agent-presets:\n  custom:\n    model: user\n');

    const conflicted = await updateProfile(
      {
        dshHome: current.dshHome,
        profile: current.profile,
        to: target,
        interactive: false,
        yes: true,
      },
      current.fixture.runtime,
    );
    expect(conflicted.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(conflicted.diagnostics.filter((item) => item.code === 'E_UPDATE_CONFLICT')).toHaveLength(
      2,
    );
    expect(await readFile(skillPath, 'utf8')).toBe('# user notes\n');
    expect(await readFile(settingsPath, 'utf8')).toContain('model: user');

    const theirs = await updateProfile(
      {
        dshHome: current.dshHome,
        profile: current.profile,
        to: target,
        theirs: true,
        interactive: false,
        yes: true,
      },
      current.fixture.runtime,
    );
    expect(theirs.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(skillPath, 'utf8')).toContain('# Target notes');
    expect(await readFile(settingsPath, 'utf8')).toContain('model: target');
  });

  it('uses --ours to retain every conflicting target while carrying target settings intent forward', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    await replaceTargetFile(
      target,
      'skills/notes.md',
      '---\nname: notes\ndescription: target\n---\n# Target notes\n',
    );
    await replaceTargetFile(target, 'settings/agent-presets.yml', 'custom:\n  model: target\n');
    const skillPath = join(current.dshHome, 'skills', 'notes', 'SKILL.md');
    const settingsPath = join(current.dshHome, 'settings.yaml');
    await writeFile(skillPath, '# user notes\n');
    await writeFile(settingsPath, 'agent-presets:\n  custom:\n    model: user\n');

    const result = await updateProfile(
      updateInput(current.dshHome, current.profile, target, { ours: true }),
      current.fixture.runtime,
    );
    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(skillPath, 'utf8')).toBe('# user notes\n');
    expect(await readFile(settingsPath, 'utf8')).toContain('model: user');
    const marker = await readMarker(current.dshHome, current.profile);
    expect(marker.marker?.metadata.settingsContribution.keys).toEqual([
      expect.objectContaining({ key: 'custom', canonicalValue: expect.stringContaining('target') }),
    ]);
    expect(marker.marker?.metadata.assets).toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'skills/notes', action: 'skip' })]),
    );
  });

  it('retains a user-deleted target asset, removes an untouched upstream-deleted asset, and honors --only', async () => {
    const retained = await installedAssets();
    const changedTarget = await enginePack({ assets: true, name: retained.profile });
    await replaceTargetFile(
      changedTarget,
      'skills/notes.md',
      '---\nname: notes\ndescription: target\n---\n# Target notes\n',
    );
    await rm(join(retained.dshHome, 'skills', 'notes'), { recursive: true });
    const retainedResult = await updateProfile(
      updateInput(retained.dshHome, retained.profile, changedTarget),
      retained.fixture.runtime,
    );
    expect(retainedResult.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readMarker(retained.dshHome, retained.profile)).toMatchObject({
      marker: {
        metadata: {
          assets: expect.not.arrayContaining([expect.objectContaining({ target: 'skills/notes' })]),
        },
      },
    });

    const removed = await installedAssets();
    const removedTarget = await enginePack({ assets: true, name: removed.profile });
    await removeTargetFiles(removedTarget, ['skills/notes.md']);
    const removedResult = await updateProfile(
      updateInput(removed.dshHome, removed.profile, removedTarget),
      removed.fixture.runtime,
    );
    expect(removedResult.exitCode).toBe(EXIT_CODES.SUCCESS);
    await expect(
      readFile(join(removed.dshHome, 'skills', 'notes', 'SKILL.md'), 'utf8'),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const only = await installedAssets();
    const onlyTarget = await enginePack({ assets: true, name: only.profile });
    await replaceTargetFile(
      onlyTarget,
      'skills/notes.md',
      '---\nname: notes\ndescription: target\n---\n# Target notes\n',
    );
    await replaceTargetFile(onlyTarget, 'settings/agent-presets.yml', 'custom:\n  model: target\n');
    const onlyResult = await updateProfile(
      updateInput(only.dshHome, only.profile, onlyTarget, { only: ['setting:custom'] }),
      only.fixture.runtime,
    );
    expect(onlyResult.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(join(only.dshHome, 'skills', 'notes', 'SKILL.md'), 'utf8')).toContain(
      '# Notes',
    );
    expect(await readFile(join(only.dshHome, 'settings.yaml'), 'utf8')).toContain('model: target');
  });

  it('keeps a user-deleted asset absent across consecutive updates that still contain it', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    await replaceTargetFile(
      target,
      'skills/notes.md',
      '---\nname: notes\ndescription: target\n---\n# Target notes\n',
    );
    const skillDirectory = join(current.dshHome, 'skills', 'notes');
    await rm(skillDirectory, { recursive: true });

    const first = await updateProfile(
      updateInput(current.dshHome, current.profile, target),
      current.fixture.runtime,
    );
    expect(first.exitCode).toBe(EXIT_CODES.SUCCESS);
    const firstMarker = await readMarker(current.dshHome, current.profile);
    expect(firstMarker.marker?.metadata.assets).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'skills/notes' })]),
    );

    const second = await updateProfile(
      updateInput(current.dshHome, current.profile, target),
      current.fixture.runtime,
    );
    expect(second.exitCode).toBe(EXIT_CODES.SUCCESS);
    await expect(readFile(join(skillDirectory, 'SKILL.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not make a deferred deleted asset restore-owned', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    await replaceTargetFile(
      target,
      'skills/notes.md',
      '---\nname: notes\ndescription: target\n---\n# Target notes\n',
    );
    const skillDirectory = join(current.dshHome, 'skills', 'notes');
    await rm(skillDirectory, { recursive: true });
    const updated = await updateProfile(
      updateInput(current.dshHome, current.profile, target),
      current.fixture.runtime,
    );
    expect(updated.exitCode).toBe(EXIT_CODES.SUCCESS);
    if (updated.metadata.generation === undefined)
      throw new Error('update did not allocate a generation');

    const restored = await restoreProfile(
      {
        dshHome: current.dshHome,
        profile: current.profile,
        to: updated.metadata.generation,
        yes: true,
      },
      {
        createTxid: () => 'restore-deferred-asset',
        runDoctor: async () => ({
          diagnostics: [],
          exitCode: EXIT_CODES.SUCCESS,
          metadata: { sideEffects: [] },
        }),
      },
    );
    expect(restored.exitCode).toBe(EXIT_CODES.SUCCESS);
    await expect(readFile(join(skillDirectory, 'SKILL.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps a user-deleted profile absent through consecutive profile-only updates', async () => {
    const current = await installedProfileOnly();
    const target = await enginePack({ name: current.profile });
    await bumpTargetVersion(target);
    const profileDirectory = join(current.dshHome, 'profiles', current.profile);
    await rm(profileDirectory, { recursive: true });

    const first = await updateProfile(
      updateInput(current.dshHome, current.profile, target),
      current.fixture.runtime,
    );
    expect(first.exitCode).toBe(EXIT_CODES.SUCCESS);
    const second = await updateProfile(
      updateInput(current.dshHome, current.profile, target),
      current.fixture.runtime,
    );
    expect(second.exitCode).toBe(EXIT_CODES.SUCCESS);
    await expect(readFile(join(profileDirectory, 'package.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const marker = await readMarker(current.dshHome, current.profile);
    expect(marker.marker?.metadata.assets).toEqual([]);
  });

  it('does not lose a concurrent settings edit between exact snapshot and transaction CAS', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    await replaceTargetFile(target, 'settings/agent-presets.yml', 'custom:\n  model: target\n');
    const settingsPath = join(current.dshHome, 'settings.yaml');
    const concurrent = 'agent-presets:\n  custom:\n    model: concurrent\n';
    const runtime = fakeRuntime();
    const read = runtime.runtime.readTextIfExists.bind(runtime.runtime);
    let reads = 0;
    runtime.runtime.readTextIfExists = async (path) => {
      if (path === settingsPath && reads++ === 1) await writeFile(path, concurrent);
      return read(path);
    };

    const result = await updateProfile(
      updateInput(current.dshHome, current.profile, target),
      runtime.runtime,
    );
    expect(result.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_UPDATE_CONFLICT' })]),
    );
    expect(await readFile(settingsPath, 'utf8')).toBe(concurrent);
  });

  it('rejects empty or unknown --only selectors without creating a generation', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    const before = await snapshot(current.dshHome);

    for (const only of [[], ['skill:typo']] as const) {
      const result = await updateProfile(
        updateInput(current.dshHome, current.profile, target, { only }),
        current.fixture.runtime,
      );
      expect(result.exitCode).toBe(EXIT_CODES.CONTRACT);
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'E_UPDATE_ONLY' })]),
      );
      expect(await snapshot(current.dshHome)).toEqual(before);
    }
  });

  it('keeps an --ours retained user modification through the next target update', async () => {
    const current = await installedAssets();
    const firstTarget = await enginePack({ assets: true, name: current.profile });
    await replaceTargetFile(
      firstTarget,
      'skills/notes.md',
      '---\nname: notes\ndescription: first target\n---\n# First target\n',
    );
    const skillPath = join(current.dshHome, 'skills', 'notes', 'SKILL.md');
    await writeFile(skillPath, '# User notes\n');
    const first = await updateProfile(
      updateInput(current.dshHome, current.profile, firstTarget, { ours: true }),
      current.fixture.runtime,
    );
    expect(first.exitCode).toBe(EXIT_CODES.SUCCESS);

    const secondTarget = await enginePack({ assets: true, name: current.profile });
    await replaceTargetFile(
      secondTarget,
      'skills/notes.md',
      '---\nname: notes\ndescription: second target\n---\n# Second target\n',
    );
    const second = await updateProfile(
      updateInput(current.dshHome, current.profile, secondTarget, { ours: true }),
      current.fixture.runtime,
    );
    expect(second.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(skillPath, 'utf8')).toBe('# User notes\n');
  });

  it('converges a deferred user modification once its bytes match the target again', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    const targetNotes = '---\nname: notes\ndescription: target\n---\n# Target notes\n';
    await replaceTargetFile(target, 'skills/notes.md', targetNotes);
    const skillPath = join(current.dshHome, 'skills', 'notes', 'SKILL.md');
    await writeFile(skillPath, '# User notes\n');
    const deferred = await updateProfile(
      updateInput(current.dshHome, current.profile, target, { ours: true }),
      current.fixture.runtime,
    );
    expect(deferred.exitCode).toBe(EXIT_CODES.SUCCESS);
    await writeFile(skillPath, targetNotes);

    const converged = await updateProfile(
      updateInput(current.dshHome, current.profile, target),
      current.fixture.runtime,
    );
    expect(converged.exitCode).toBe(EXIT_CODES.SUCCESS);
    const marker = await readMarker(current.dshHome, current.profile);
    expect(marker.marker?.metadata.deferredAssets).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'skills/notes' })]),
    );
    expect(marker.marker?.metadata.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: 'skills/notes',
          action: expect.not.stringMatching('skip'),
        }),
      ]),
    );
  });

  it('records a partial update as mixed state and can later update its deferred asset', async () => {
    const current = await installedAssets();
    const partialTarget = await enginePack({ assets: true, name: current.profile });
    await replaceTargetFile(
      partialTarget,
      'skills/notes.md',
      '---\nname: notes\ndescription: partial target\n---\n# Partial target\n',
    );
    await replaceTargetFile(
      partialTarget,
      'settings/agent-presets.yml',
      'custom:\n  model: partial\n',
    );
    const partial = await updateProfile(
      updateInput(current.dshHome, current.profile, partialTarget, { only: ['setting:custom'] }),
      current.fixture.runtime,
    );
    expect(partial.exitCode).toBe(EXIT_CODES.SUCCESS);
    const marker = await readMarker(current.dshHome, current.profile);
    expect(
      (marker.marker?.metadata as { deferredAssets?: unknown } | undefined)?.deferredAssets,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'only',
          baseline: expect.objectContaining({ target: 'skills/notes' }),
        }),
      ]),
    );
    expect(await readFile(join(current.dshHome, 'skills', 'notes', 'SKILL.md'), 'utf8')).toContain(
      '# Notes',
    );

    const nextTarget = await enginePack({ assets: true, name: current.profile });
    await replaceTargetFile(
      nextTarget,
      'skills/notes.md',
      '---\nname: notes\ndescription: next target\n---\n# Next target\n',
    );
    const next = await updateProfile(
      updateInput(current.dshHome, current.profile, nextTarget),
      current.fixture.runtime,
    );
    expect(next.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(join(current.dshHome, 'skills', 'notes', 'SKILL.md'), 'utf8')).toContain(
      '# Next target',
    );
  });

  it('does not make a user-edited unselected skill uninstall-owned after a settings-only update', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    await replaceTargetFile(target, 'settings/agent-presets.yml', 'custom:\n  model: target\n');
    const skillPath = join(current.dshHome, 'skills', 'notes', 'SKILL.md');
    await writeFile(skillPath, '# User-owned notes\n');
    const updated = await updateProfile(
      updateInput(current.dshHome, current.profile, target, { only: ['setting:custom'] }),
      current.fixture.runtime,
    );
    expect(updated.exitCode).toBe(EXIT_CODES.SUCCESS);

    const uninstalled = await uninstallProfile({
      dshHome: current.dshHome,
      profile: current.profile,
      yes: true,
    });
    expect(uninstalled.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(skillPath, 'utf8')).toBe('# User-owned notes\n');
  });

  it('keeps an intact unselected skill uninstall-owned after a settings-only update', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    await replaceTargetFile(target, 'settings/agent-presets.yml', 'custom:\n  model: target\n');
    await replaceTargetFile(
      target,
      'skills/notes.md',
      '---\nname: notes\ndescription: deferred target\n---\n# Deferred target notes\n',
    );
    const skillPath = join(current.dshHome, 'skills', 'notes', 'SKILL.md');

    const updated = await updateProfile(
      updateInput(current.dshHome, current.profile, target, { only: ['setting:custom'] }),
      current.fixture.runtime,
    );
    expect(updated.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(skillPath, 'utf8')).toContain('# Notes');

    const uninstalled = await uninstallProfile({
      dshHome: current.dshHome,
      profile: current.profile,
      yes: true,
    });
    expect(uninstalled.exitCode).toBe(EXIT_CODES.SUCCESS);
    await expect(readFile(skillPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a new authorization delta introduced by a marker swap after confirmation', async () => {
    const current = await installedAssetsWithPlugin();
    const target = await enginePack({
      assets: true,
      name: current.profile,
      plugin: { allowBuilds: false },
    });
    const marker = await readMarker(current.dshHome, current.profile);
    if (marker.marker === undefined) throw new Error('fixture lacks an installed marker');
    const markerPath = join(current.dshHome, '.dshpack', 'installed', `${current.profile}.json`);
    const skillPath = join(current.dshHome, 'skills', 'notes', 'SKILL.md');
    const beforeSkill = await readFile(skillPath, 'utf8');
    const currentPath = join(
      current.dshHome,
      '.dshpack',
      'generations',
      current.profile,
      'current',
    );
    const beforeGeneration = await readFile(currentPath, 'utf8');
    const callsBefore = current.fixture.calls.length;
    const originalTxid = current.fixture.runtime.txid;
    current.fixture.runtime.txid = () => {
      writeFileSync(
        markerPath,
        `${JSON.stringify({
          ...marker.marker?.metadata,
          plugins: [],
          effectiveLock: { ...marker.marker?.metadata.effectiveLock, plugins: [] },
        })}\n`,
      );
      return originalTxid();
    };

    const result = await updateProfile(
      updateInput(current.dshHome, current.profile, target),
      current.fixture.runtime,
    );

    expect(result.exitCode).toBe(EXIT_CODES.USER_DECLINED);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_UPDATE_AUTHORIZATION_RACE' })]),
    );
    expect(await readFile(skillPath, 'utf8')).toBe(beforeSkill);
    expect(await readFile(currentPath, 'utf8')).toBe(beforeGeneration);
    expect(current.fixture.calls.slice(callsBefore)).not.toContain(
      `dsh:plugin --profile ${current.profile} list --depth=0`,
    );
  });

  it('permits a marker-race authorization delta only when its matching explicit flag is present', async () => {
    const current = await installedAssets();
    const target = await enginePack({
      assets: true,
      name: current.profile,
      permissionPreset: 'danger-full-access',
    });
    const marker = await readMarker(current.dshHome, current.profile);
    if (marker.marker === undefined) throw new Error('fixture lacks an installed marker');
    const markerPath = join(current.dshHome, '.dshpack', 'installed', `${current.profile}.json`);
    const preflightMarker = {
      ...marker.marker.metadata,
      defaults: { ...marker.marker.metadata.defaults, permissionPreset: 'danger-full-access' },
    };
    await writeFile(markerPath, `${JSON.stringify(preflightMarker)}\n`);
    const originalTxid = current.fixture.runtime.txid;
    current.fixture.runtime.txid = () => {
      writeFileSync(
        markerPath,
        `${JSON.stringify({
          ...preflightMarker,
          defaults: { ...preflightMarker.defaults, permissionPreset: 'workspace-write' },
        })}\n`,
      );
      return originalTxid();
    };

    const result = await updateProfile(
      updateInput(current.dshHome, current.profile, target, { allowDangerFullAccess: true }),
      current.fixture.runtime,
    );

    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_UPDATE_AUTHORIZATION_RACE' })]),
    );
  });

  it('preserves security classification when an observed asset is no longer a directory', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    await replaceTargetFile(
      target,
      'skills/notes.md',
      '---\nname: notes\ndescription: target\n---\n# Target notes\n',
    );
    const skillDirectory = join(current.dshHome, 'skills', 'notes');
    await rm(skillDirectory, { recursive: true });
    await writeFile(skillDirectory, 'not a managed directory\n');

    const result = await updateProfile(
      updateInput(current.dshHome, current.profile, target),
      current.fixture.runtime,
    );
    expect(result.exitCode).toBe(EXIT_CODES.SECURITY);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_UPDATE_ASSET_STATE' })]),
    );
  });

  it('retains a target-deleted setting changed by the user while preserving comments and other namespaces', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    await removeTargetSettings(target);
    const settingsPath = join(current.dshHome, 'settings.yaml');
    const userSettings =
      '# top comment\nother:\n  keep: true\nagent-presets:\n  # user comment\n  custom:\n    model: user\n';
    await writeFile(settingsPath, userSettings);

    const result = await updateProfile(
      updateInput(current.dshHome, current.profile, target),
      current.fixture.runtime,
    );
    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(settingsPath, 'utf8')).toBe(userSettings);
    const marker = await readMarker(current.dshHome, current.profile);
    expect(marker.marker?.metadata.settingsContribution.keys).toEqual([]);
  });

  it('removes an untouched target-deleted setting while limiting updates to --only keys', async () => {
    const deleted = await installedAssets();
    const deletedTarget = await enginePack({ assets: true, name: deleted.profile });
    await removeTargetSettings(deletedTarget);
    const settingsPath = join(deleted.dshHome, 'settings.yaml');

    const removed = await updateProfile(
      updateInput(deleted.dshHome, deleted.profile, deletedTarget),
      deleted.fixture.runtime,
    );
    expect(removed.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(settingsPath, 'utf8')).not.toContain('custom:');

    const scoped = await installedAssets();
    const scopedTarget = await enginePack({ assets: true, name: scoped.profile });
    await replaceTargetFile(
      scopedTarget,
      'settings/agent-presets.yml',
      'custom:\n  model: target\nextra:\n  enabled: true\n',
    );
    const scopedResult = await updateProfile(
      updateInput(scoped.dshHome, scoped.profile, scopedTarget, { only: ['settings:custom'] }),
      scoped.fixture.runtime,
    );
    expect(scopedResult.exitCode).toBe(EXIT_CODES.SUCCESS);
    const scopedSettings = await readFile(join(scoped.dshHome, 'settings.yaml'), 'utf8');
    expect(scopedSettings).toContain('model: target');
    expect(scopedSettings).not.toContain('extra:');
    expect(
      (await readMarker(scoped.dshHome, scoped.profile)).marker?.metadata.settingsContribution.keys,
    ).toEqual([
      expect.objectContaining({ key: 'custom', canonicalValue: expect.stringContaining('target') }),
    ]);
  });

  it('uses --theirs to delete an upstream-removed setting despite a user edit', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    await removeTargetSettings(target);
    const settingsPath = join(current.dshHome, 'settings.yaml');
    await writeFile(settingsPath, 'agent-presets:\n  custom:\n    model: user\n');

    const result = await updateProfile(
      updateInput(current.dshHome, current.profile, target, { theirs: true }),
      current.fixture.runtime,
    );
    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(settingsPath, 'utf8')).not.toContain('custom:');
    expect(
      (await readMarker(current.dshHome, current.profile)).marker?.metadata.settingsContribution
        .keys,
    ).toEqual([]);
  });

  it('returns a safe state diagnostic before transaction when a live settings read fails', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    const runtime = fakeRuntime();
    runtime.runtime.readTextIfExists = async () =>
      Promise.reject(new Error('fixture settings read'));

    const result = await updateProfile(
      updateInput(current.dshHome, current.profile, target),
      runtime.runtime,
    );
    expect(result.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_UPDATE_STATE' })]),
    );
    expect(runtime.calls.filter((call) => call.startsWith('stage:'))).toEqual([]);
  });

  it('fails before mutation for malformed target settings and a non-map live agent-presets namespace', async () => {
    const malformed = await installedAssets();
    const malformedTarget = await enginePack({ assets: true, name: malformed.profile });
    await replaceTargetFile(
      malformedTarget,
      'settings/agent-presets.yml',
      'custom: [unterminated\n',
    );
    const malformedResult = await updateProfile(
      updateInput(malformed.dshHome, malformed.profile, malformedTarget),
      malformed.fixture.runtime,
    );
    expect(malformedResult.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(malformedResult.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_UPDATE_SETTINGS_TARGET' })]),
    );

    const namespace = await installedAssets();
    const namespaceTarget = await enginePack({ assets: true, name: namespace.profile });
    await replaceTargetFile(
      namespaceTarget,
      'settings/agent-presets.yml',
      'custom:\n  model: target\n',
    );
    const settingsPath = join(namespace.dshHome, 'settings.yaml');
    const before = 'other:\n  keep: true\nagent-presets: not-a-map\n';
    await writeFile(settingsPath, before);
    const namespaceResult = await updateProfile(
      updateInput(namespace.dshHome, namespace.profile, namespaceTarget),
      namespace.fixture.runtime,
    );
    expect(namespaceResult.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(namespaceResult.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_UPDATE_SETTINGS_NAMESPACE' })]),
    );
    expect(await readFile(settingsPath, 'utf8')).toBe(before);
  });

  it.each([
    ['invalid YAML', 'agent-presets: [unterminated\n', 'E_SETTINGS_INVALID_YAML'],
    ['non-map root', '- not-a-settings-map\n', 'E_SETTINGS_ROOT'],
  ] as const)(
    'fails without mutation when current settings have %s',
    async (_label, document, code) => {
      const current = await installedAssets();
      const target = await enginePack({ assets: true, name: current.profile });
      const settingsPath = join(current.dshHome, 'settings.yaml');
      await writeFile(settingsPath, document);

      const result = await updateProfile(
        updateInput(current.dshHome, current.profile, target),
        current.fixture.runtime,
      );

      expect(result.exitCode).toBe(EXIT_CODES.CONTRACT);
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code })]),
      );
      expect(await readFile(settingsPath, 'utf8')).toBe(document);
    },
  );

  it('updates the profile when only its validated patch input changes', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    await replaceTargetFile(target, 'patch/cordis.patch.yml', '- {}\n');
    const patchPath = join(current.dshHome, 'profiles', current.profile, 'cordis.patch.yml');
    expect(await readFile(patchPath, 'utf8')).toBe('[]\n');

    const result = await updateProfile(
      updateInput(current.dshHome, current.profile, target),
      current.fixture.runtime,
    );

    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(result.metadata.assets).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'profile', action: 'update' })]),
    );
    expect(await readFile(patchPath, 'utf8')).toBe('- {}\n');
  });

  it('reports a modified profile A|B|C conflict unless --ours or --theirs resolves it', async () => {
    const conflicted = await installedAssets();
    const conflictTarget = await enginePack({ assets: true, name: conflicted.profile });
    await bumpTargetVersion(conflictTarget);
    const conflictPackage = join(
      conflicted.dshHome,
      'profiles',
      conflicted.profile,
      'package.json',
    );
    await writeFile(conflictPackage, '{"user":true}\n');
    const defaultResult = await updateProfile(
      updateInput(conflicted.dshHome, conflicted.profile, conflictTarget),
      conflicted.fixture.runtime,
    );
    expect(defaultResult.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(defaultResult.metadata.assets).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'profile', action: 'conflict' })]),
    );
    expect(await readFile(conflictPackage, 'utf8')).toBe('{"user":true}\n');

    const ours = await installedAssets();
    const oursTarget = await enginePack({ assets: true, name: ours.profile });
    await bumpTargetVersion(oursTarget);
    const oursPackage = join(ours.dshHome, 'profiles', ours.profile, 'package.json');
    await writeFile(oursPackage, '{"user":true}\n');
    const oursResult = await updateProfile(
      updateInput(ours.dshHome, ours.profile, oursTarget, { ours: true }),
      ours.fixture.runtime,
    );
    expect(oursResult.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(oursPackage, 'utf8')).toBe('{"user":true}\n');

    const theirs = await installedAssets();
    const theirsTarget = await enginePack({ assets: true, name: theirs.profile });
    await bumpTargetVersion(theirsTarget);
    const theirsPackage = join(theirs.dshHome, 'profiles', theirs.profile, 'package.json');
    await writeFile(theirsPackage, '{"user":true}\n');
    const theirsResult = await updateProfile(
      updateInput(theirs.dshHome, theirs.profile, theirsTarget, { theirs: true }),
      theirs.fixture.runtime,
    );
    expect(theirsResult.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(theirsPackage, 'utf8')).not.toBe('{"user":true}\n');
  });

  it('keeps a user-deleted profile absent while a modified profile conflicts unless --theirs is selected', async () => {
    const deleted = await installedAssets();
    const unchangedTarget = await enginePack({ assets: true, name: deleted.profile });
    await rm(join(deleted.dshHome, 'profiles', deleted.profile), { recursive: true });
    const deletedResult = await updateProfile(
      updateInput(deleted.dshHome, deleted.profile, unchangedTarget),
      deleted.fixture.runtime,
    );
    expect(deletedResult.exitCode).toBe(EXIT_CODES.SUCCESS);
    await expect(
      readFile(join(deleted.dshHome, 'profiles', deleted.profile, 'package.json'), 'utf8'),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      (await readMarker(deleted.dshHome, deleted.profile)).marker?.metadata.assets,
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'profile' })]));

    const modified = await installedAssets();
    const changedTarget = await enginePack({ assets: true, name: modified.profile });
    await bumpTargetVersion(changedTarget);
    const profilePackage = join(modified.dshHome, 'profiles', modified.profile, 'package.json');
    await writeFile(profilePackage, '{"user":true}\n');
    const callsBefore = modified.fixture.calls.length;
    const modifiedResult = await updateProfile(
      updateInput(modified.dshHome, modified.profile, changedTarget),
      modified.fixture.runtime,
    );
    expect(modifiedResult.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(modifiedResult.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'E_UPDATE_CONFLICT',
          message: expect.stringContaining('profile'),
        }),
      ]),
    );
    expect(await readFile(profilePackage, 'utf8')).toBe('{"user":true}\n');
    expect(modified.fixture.calls.slice(callsBefore)).not.toContain(
      `dsh:plugin --profile ${modified.profile} list --depth=0`,
    );

    const forced = await installedAssets();
    const forcedTarget = await enginePack({ assets: true, name: forced.profile });
    await bumpTargetVersion(forcedTarget);
    const forcedPackage = join(forced.dshHome, 'profiles', forced.profile, 'package.json');
    await writeFile(forcedPackage, '{"user":true}\n');
    const forcedResult = await updateProfile(
      updateInput(forced.dshHome, forced.profile, forcedTarget, {
        theirs: true,
        allowBuilds: [],
        allowUnverified: false,
        allowVersionMismatch: false,
        allowDangerFullAccess: false,
      }),
      forced.fixture.runtime,
    );
    expect(forcedResult.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(forcedPackage, 'utf8')).not.toBe('{"user":true}\n');
  });

  it('uses --theirs to recreate a user-deleted asset and reports only preexisting doctor findings as warnings', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    await replaceTargetFile(
      target,
      'skills/notes.md',
      '---\nname: notes\ndescription: target\n---\n# Target notes\n',
    );
    const skillPath = join(current.dshHome, 'skills', 'notes', 'SKILL.md');
    await rm(join(current.dshHome, 'skills', 'notes'), { recursive: true });
    const runtime = fakeRuntime();
    runtime.runtime.runDoctor = async () => ({
      diagnostics: [
        {
          code: 'W_OUTSIDE',
          severity: 'warning',
          message: 'outside update scope',
          hint: 'fixture',
          path: join(current.dshHome, 'other', 'outside'),
          evidence: 'local',
        },
      ],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { sideEffects: [] },
    });

    const result = await updateProfile(
      updateInput(current.dshHome, current.profile, target, { theirs: true }),
      runtime.runtime,
    );
    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(skillPath, 'utf8')).toContain('# Target notes');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'W_UPDATE_DOCTOR_PREEXISTING' })]),
    );
  });

  it('uses --theirs for both a changed user asset and an upstream asset deletion', async () => {
    const changed = await installedAssets();
    const changedTarget = await enginePack({ assets: true, name: changed.profile });
    await replaceTargetFile(
      changedTarget,
      'skills/notes.md',
      '---\nname: notes\ndescription: target\n---\n# Target notes\n',
    );
    const changedSkill = join(changed.dshHome, 'skills', 'notes', 'SKILL.md');
    await writeFile(changedSkill, '# User notes\n');
    const changedResult = await updateProfile(
      updateInput(changed.dshHome, changed.profile, changedTarget, { theirs: true }),
      changed.fixture.runtime,
    );
    expect(changedResult.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(changedSkill, 'utf8')).toContain('# Target notes');

    const deleted = await installedAssets();
    const deletedTarget = await enginePack({ assets: true, name: deleted.profile });
    await removeTargetFiles(deletedTarget, ['skills/notes.md']);
    const deletedSkill = join(deleted.dshHome, 'skills', 'notes', 'SKILL.md');
    await writeFile(deletedSkill, '# User notes\n');
    const deletedResult = await updateProfile(
      updateInput(deleted.dshHome, deleted.profile, deletedTarget, { theirs: true }),
      deleted.fixture.runtime,
    );
    expect(deletedResult.exitCode).toBe(EXIT_CODES.SUCCESS);
    await expect(readFile(deletedSkill, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses --theirs to rebuild a deleted profile and rejects an anchored settings namespace transactionally', async () => {
    const deleted = await installedAssets();
    const target = await enginePack({ assets: true, name: deleted.profile });
    await bumpTargetVersion(target);
    await rm(join(deleted.dshHome, 'profiles', deleted.profile), { recursive: true });
    const rebuilt = await updateProfile(
      updateInput(deleted.dshHome, deleted.profile, target, { theirs: true }),
      deleted.fixture.runtime,
    );
    expect(rebuilt.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(
      await readFile(join(deleted.dshHome, 'profiles', deleted.profile, 'package.json'), 'utf8'),
    ).toContain('dsh-profile-engine-pack');

    const anchored = await installedAssets();
    const anchoredTarget = await enginePack({ assets: true, name: anchored.profile });
    await replaceTargetFile(
      anchoredTarget,
      'settings/agent-presets.yml',
      'custom:\n  model: target\n',
    );
    const settingsPath = join(anchored.dshHome, 'settings.yaml');
    const before = 'agent-presets: &presets\n  custom:\n    model: fixture\n';
    await writeFile(settingsPath, before);
    const failed = await updateProfile(
      updateInput(anchored.dshHome, anchored.profile, anchoredTarget),
      anchored.fixture.runtime,
    );
    expect(failed.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(failed.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_SETTINGS_ALIAS' })]),
    );
    expect(await readFile(settingsPath, 'utf8')).toBe(before);
  });

  it('rolls back instead of capturing an externally changed continuing asset as owned', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    await replaceTargetFile(target, 'settings/agent-presets.yml', 'custom:\n  model: target\n');
    const skillPath = join(current.dshHome, 'skills', 'notes', 'SKILL.md');
    const settingsPath = join(current.dshHome, 'settings.yaml');
    const markerBefore = await readFile(
      join(current.dshHome, '.dshpack', 'installed', `${current.profile}.json`),
      'utf8',
    );
    const runtime = fakeRuntime();
    const originalFault = runtime.runtime.fault;
    runtime.runtime.fault = async (stage) => {
      if (stage === 'assets') await writeFile(skillPath, '# External race notes\n');
      await originalFault(stage);
    };

    const result = await updateProfile(
      updateInput(current.dshHome, current.profile, target),
      runtime.runtime,
    );

    expect(result.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_UPDATE_ASSET_CHANGED' })]),
    );
    expect(await readFile(skillPath, 'utf8')).toBe('# External race notes\n');
    expect(await readFile(settingsPath, 'utf8')).toContain('model: fixture');
    expect(
      await readFile(
        join(current.dshHome, '.dshpack', 'installed', `${current.profile}.json`),
        'utf8',
      ),
    ).toBe(markerBefore);

    const uninstalled = await uninstallProfile({
      dshHome: current.dshHome,
      profile: current.profile,
      yes: true,
    });
    expect(uninstalled.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(skillPath, 'utf8')).toBe('# External race notes\n');
  });

  it('rolls back instead of promoting bytes changed after an asset write', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    await replaceTargetFile(
      target,
      'skills/notes.md',
      '---\nname: notes\ndescription: target\n---\n# Target notes\n',
    );
    const skillPath = join(current.dshHome, 'skills', 'notes', 'SKILL.md');
    const original = await readFile(skillPath, 'utf8');
    const markerPath = join(current.dshHome, '.dshpack', 'installed', `${current.profile}.json`);
    const markerBefore = await readFile(markerPath, 'utf8');
    const runtime = fakeRuntime();
    const originalFault = runtime.runtime.fault;
    runtime.runtime.fault = async (stage) => {
      if (stage === 'assets') await writeFile(skillPath, '# External write after target\n');
      await originalFault(stage);
    };

    const result = await updateProfile(
      updateInput(current.dshHome, current.profile, target),
      runtime.runtime,
    );

    expect(result.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_UPDATE_TARGET' })]),
    );
    expect(await readFile(skillPath, 'utf8')).toBe(original);
    expect(await readFile(markerPath, 'utf8')).toBe(markerBefore);
  });

  it('rolls back when strict doctor reports an attributable error', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    await replaceTargetFile(
      target,
      'skills/notes.md',
      '---\nname: notes\ndescription: target\n---\n# Target notes\n',
    );
    const before = await readFile(join(current.dshHome, 'skills', 'notes', 'SKILL.md'), 'utf8');
    const runtime = fakeRuntime();
    runtime.runtime.runDoctor = async () => ({
      diagnostics: [
        {
          code: 'E_OWNED',
          severity: 'error',
          message: 'owned update failure',
          hint: 'fixture',
          path: join(current.dshHome, 'skills', 'notes', 'SKILL.md'),
          evidence: 'local',
        },
      ],
      exitCode: EXIT_CODES.POST_INSTALL_VERIFY_FAILURE,
      metadata: { sideEffects: [] },
    });

    const result = await updateProfile(
      updateInput(current.dshHome, current.profile, target),
      runtime.runtime,
    );
    expect(result.exitCode).toBe(EXIT_CODES.POST_INSTALL_VERIFY_FAILURE);
    expect(await readFile(join(current.dshHome, 'skills', 'notes', 'SKILL.md'), 'utf8')).toBe(
      before,
    );
  });

  it('rolls back when strict doctor fails without diagnostics', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    await replaceTargetFile(
      target,
      'skills/notes.md',
      '---\nname: notes\ndescription: target\n---\n# Target notes\n',
    );
    const before = await readFile(join(current.dshHome, 'skills', 'notes', 'SKILL.md'), 'utf8');
    const runtime = fakeRuntime();
    runtime.runtime.runDoctor = async () => ({
      diagnostics: [],
      exitCode: EXIT_CODES.POST_INSTALL_VERIFY_FAILURE,
      metadata: { sideEffects: [] },
    });

    const result = await updateProfile(
      updateInput(current.dshHome, current.profile, target, {
        allowBuilds: [],
        allowUnverified: false,
        allowVersionMismatch: false,
        allowDangerFullAccess: false,
      }),
      runtime.runtime,
    );
    expect(result.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(await readFile(join(current.dshHome, 'skills', 'notes', 'SKILL.md'), 'utf8')).toBe(
      before,
    );
  });

  it('keeps an A|B|A setting unchanged on disk while retaining its target canonical contribution', async () => {
    const current = await installedAssets();
    const target = await enginePack({ assets: true, name: current.profile });
    const settingsPath = join(current.dshHome, 'settings.yaml');
    await writeFile(settingsPath, 'agent-presets:\n  custom:\n    model: user\n');

    const result = await updateProfile(
      updateInput(current.dshHome, current.profile, target),
      current.fixture.runtime,
    );
    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(settingsPath, 'utf8')).toContain('model: user');
    expect(
      (await readMarker(current.dshHome, current.profile)).marker?.metadata.settingsContribution
        .keys,
    ).toEqual([
      expect.objectContaining({
        key: 'custom',
        canonicalValue: expect.stringContaining('fixture'),
      }),
    ]);
  });

  it.each(['settings', 'metadata'] as const)(
    'rolls back asset, settings, marker, and generation bytes when %s faults',
    async (stage) => {
      const current = await installedAssets();
      const target = await enginePack({ assets: true, name: current.profile });
      await replaceTargetFile(
        target,
        'skills/notes.md',
        '---\nname: notes\ndescription: target\n---\n# Target notes\n',
      );
      await replaceTargetFile(target, 'settings/agent-presets.yml', 'custom:\n  model: target\n');
      const before = await snapshot(current.dshHome);
      const faulting = fakeRuntime({ fault: stage });

      const result = await updateProfile(
        updateInput(current.dshHome, current.profile, target),
        faulting.runtime,
      );

      expect(result.exitCode).not.toBe(EXIT_CODES.SUCCESS);
      const after = await snapshot(current.dshHome);
      const managedBefore = Object.fromEntries(
        Object.entries(before).filter(
          ([path]) => !path.replaceAll('\\', '/').startsWith('.dshpack/backups/'),
        ),
      );
      const managedAfter = Object.fromEntries(
        Object.entries(after).filter(
          ([path]) => !path.replaceAll('\\', '/').startsWith('.dshpack/backups/'),
        ),
      );
      expect(managedAfter).toEqual(managedBefore);
    },
  );
});
