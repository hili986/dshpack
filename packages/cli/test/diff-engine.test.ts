import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import { diffProfile } from '../src/diff/engine.js';
import { installPack } from '../src/install/engine.js';
import { removeFixtureDirectory } from './fixture-cleanup.js';
import { enginePack, fakeRuntime } from './install-engine-fixture.js';

const homes = new Set<string>();

async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dshpack-diff-engine-'));
  homes.add(directory);
  return directory;
}

async function treeFingerprint(root: string): Promise<readonly string[]> {
  const entries: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      const bytes = await readFile(path);
      entries.push(
        `${relative(root, path).replaceAll('\\', '/')}:${bytes.byteLength}:${createHash('sha256').update(bytes).digest('hex')}`,
      );
    }
  };
  await visit(root);
  return entries.sort();
}

function sha512(value: string): string {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

async function replaceLockedFile(root: string, path: string, contents: string): Promise<void> {
  await writeFile(join(root, ...path.split('/')), contents);
  const lockPath = join(root, 'pack.lock.yml');
  const lock = parse(await readFile(lockPath, 'utf8')) as {
    files: Array<{ path: string; sha512: string }>;
  };
  const entry = lock.files.find((file) => file.path === path);
  if (entry === undefined) throw new Error(`missing locked fixture file: ${path}`);
  entry.sha512 = sha512(contents);
  await writeFile(lockPath, stringify(lock, { lineWidth: 0 }));
}

afterEach(async () => {
  // Same contract as the update fixtures: drain first so a failed removal cannot compound,
  // and go through the bounded retry so a transient Windows lock is not a test failure.
  const pending = [...homes];
  homes.clear();
  await Promise.all(pending.map((directory) => removeFixtureDirectory(directory)));
});

describe('diff profile', () => {
  it('reports a three-way asset conflict when both the disk and target changed', async () => {
    const dshHome = await home();
    const installed = fakeRuntime();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        installed.runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await writeFile(join(dshHome, 'skills', 'notes', 'SKILL.md'), '# user version\n');
    const target = await enginePack({ assets: true });
    await replaceLockedFile(
      target,
      'skills/notes.md',
      '---\nname: notes\ndescription: upstream\n---\n# upstream version\n',
    );

    const result = await diffProfile(
      { dshHome, profile: 'engine-pack', to: target },
      fakeRuntime().runtime,
    );

    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.metadata.localDrift).toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'skills/notes' })]),
    );
    expect(result.metadata.upstreamDelta).toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'skills/notes' })]),
    );
    expect(result.metadata.localDrift).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'skills/notes', mergeAction: 'conflict' }),
      ]),
    );
  });

  it('does not change any DSH_HOME bytes without --effective', async () => {
    const dshHome = await home();
    const runtime = fakeRuntime();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        runtime.runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const before = await treeFingerprint(dshHome);

    const readOnlyRuntime = fakeRuntime();
    const result = await diffProfile({ dshHome, profile: 'engine-pack' }, readOnlyRuntime.runtime);

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.metadata.localDrift).toEqual([]);
    expect(readOnlyRuntime.calls).not.toContainEqual(expect.stringMatching(/^dsh:/u));
    expect(await treeFingerprint(dshHome)).toEqual(before);
  });

  it('declares --effective and lets dsh write only profile/cordis.yml', async () => {
    const dshHome = await home();
    const runtime = fakeRuntime();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        runtime.runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const before = await treeFingerprint(dshHome);

    const result = await diffProfile(
      { dshHome, profile: 'engine-pack', effective: true },
      runtime.runtime,
    );

    const after = await treeFingerprint(dshHome);
    expect(result).toMatchObject({
      exitCode: 0,
      metadata: { sideEffects: [{ owner: 'dsh', path: 'profile/cordis.yml' }] },
    });
    expect(after.filter((entry) => !entry.startsWith('profiles/engine-pack/cordis.yml:'))).toEqual(
      before.filter((entry) => !entry.startsWith('profiles/engine-pack/cordis.yml:')),
    );
    expect(after).toEqual(
      expect.arrayContaining([expect.stringMatching(/^profiles\/engine-pack\/cordis\.yml:/u)]),
    );
  });

  it('never echoes source credentials when materialization fails', async () => {
    const dshHome = await home();
    const installed = fakeRuntime();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        installed.runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const token = 'diff-source-token-must-not-leak';
    const runtime = fakeRuntime();
    runtime.runtime.materializeSource = async () => {
      throw new Error(token);
    };

    const result = await diffProfile(
      { dshHome, profile: 'engine-pack', to: `https://user:${token}@example.invalid/pack.tgz` },
      runtime.runtime,
    );

    expect(result.exitCode).not.toBe(0);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('reports an untracked profile as a command failure without writing', async () => {
    const dshHome = await home();
    const before = await treeFingerprint(dshHome);

    const result = await diffProfile({ dshHome, profile: 'missing' }, fakeRuntime().runtime);

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_DIFF_MARKER_UNTRACKED' })],
    });
    expect(await treeFingerprint(dshHome)).toEqual(before);
  });

  it('checks the installed source only when requested by status-like update checking', async () => {
    const dshHome = await home();
    const installed = fakeRuntime();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        installed.runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const runtime = fakeRuntime();

    const result = await diffProfile(
      { dshHome, profile: 'engine-pack', checkUpdates: true },
      runtime.runtime,
    );

    expect(result).toMatchObject({ exitCode: 0, metadata: { upstreamDelta: [] } });
    expect(runtime.calls).toContainEqual(expect.stringMatching(/^materialize:/u));
  });

  it('reports deleted local assets and changed settings without echoing their values', async () => {
    const dshHome = await home();
    const installed = fakeRuntime();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        installed.runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await rm(join(dshHome, 'skills', 'notes'), { recursive: true });
    await writeFile(
      join(dshHome, 'settings.yaml'),
      'agent-presets:\n  custom:\n    model: secret-local-value\n',
    );

    const result = await diffProfile({ dshHome, profile: 'engine-pack' }, fakeRuntime().runtime);

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.metadata.localDrift).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'skill', target: 'skills/notes', current: 'absent' }),
        expect.objectContaining({ kind: 'setting', id: 'custom' }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('secret-local-value');
  });

  it('reports an effective mismatch and maps a dsh failure to an environment error', async () => {
    const dshHome = await home();
    const installed = fakeRuntime();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        installed.runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const mismatching = fakeRuntime();
    mismatching.runtime.runDsh = async () => {
      await writeFile(join(dshHome, 'profiles', 'engine-pack', 'cordis.yml'), 'different: true\n');
      return { stdout: '', stderr: '' };
    };
    const mismatch = await diffProfile(
      { dshHome, profile: 'engine-pack', effective: true },
      mismatching.runtime,
    );
    expect(mismatch.metadata.effectiveMismatch).toHaveLength(1);
    const unavailable = fakeRuntime();
    unavailable.runtime.runDsh = async () => {
      throw new Error('dsh unavailable');
    };

    const failed = await diffProfile(
      { dshHome, profile: 'engine-pack', effective: true },
      unavailable.runtime,
    );

    expect(failed).toMatchObject({
      exitCode: 10,
      diagnostics: [expect.objectContaining({ code: 'E_DIFF_EFFECTIVE' })],
    });
  });

  it('maps an unexpected read failure to a generic safe diagnostic', async () => {
    const dshHome = await home();
    const installed = fakeRuntime();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        installed.runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const runtime = fakeRuntime();
    runtime.runtime.readTextIfExists = async () => {
      throw new Error('unexpected read failure');
    };

    const result = await diffProfile({ dshHome, profile: 'engine-pack' }, runtime.runtime);

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_DIFF' })],
    });
  });
});
