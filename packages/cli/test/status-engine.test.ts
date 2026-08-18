import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { installPack } from '../src/install/engine.js';
import { statusProfiles } from '../src/status/engine.js';
import { enginePack, fakeRuntime } from './install-engine-fixture.js';

const homes = new Set<string>();

async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dshpack-status-engine-'));
  homes.add(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all([...homes].map((directory) => rm(directory, { recursive: true })));
  homes.clear();
});

describe('status profiles', () => {
  it('does not materialize an upstream source unless --check-updates was requested', async () => {
    const dshHome = await home();
    const installed = fakeRuntime();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        installed.runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const runtime = fakeRuntime();

    const result = await statusProfiles({ dshHome }, runtime.runtime);

    expect(result).toMatchObject({ exitCode: 0 });
    expect(runtime.calls).not.toContainEqual(expect.stringMatching(/^materialize:/u));
    expect(result.metadata.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profile: 'engine-pack',
          status: 'tracked',
          pack: { name: 'engine-pack', version: '1.0.0' },
          generation: 1,
          sharedAssets: 0,
          update: 'not-checked',
        }),
      ]),
    );
  });

  it('presents untracked, reserved, and broken profiles without crashing', async () => {
    const dshHome = await home();
    await Promise.all([
      mkdir(join(dshHome, 'profiles', 'loose'), { recursive: true }),
      mkdir(join(dshHome, 'profiles', 'web'), { recursive: true }),
      mkdir(join(dshHome, 'profiles', 'damaged'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(dshHome, 'profiles', 'loose', 'package.json'),
        '{"name":"dsh-profile-loose","private":true,"dependencies":{},"dsh":{"profile":{"bundles":[]}}}\n',
      ),
      writeFile(
        join(dshHome, 'profiles', 'web', 'package.json'),
        '{"name":"dsh-profile-web","private":true,"dependencies":{},"dsh":{"profile":{"bundles":[]}}}\n',
      ),
      writeFile(join(dshHome, 'profiles', 'damaged', 'package.json'), '{bad json\n'),
    ]);
    await Promise.all(
      ['loose', 'web'].flatMap((profile) => [
        writeFile(join(dshHome, 'profiles', profile, 'cordis.patch.yml'), '[]\n'),
        writeFile(
          join(dshHome, 'profiles', profile, 'pnpm-workspace.yaml'),
          'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n',
        ),
      ]),
    );

    const result = await statusProfiles({ dshHome }, fakeRuntime().runtime);

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.metadata.profiles).toEqual(
      expect.arrayContaining([
        { profile: 'loose', status: 'untracked' },
        expect.objectContaining({ profile: 'web', status: 'reserved' }),
        expect.objectContaining({ profile: 'damaged', status: 'broken' }),
      ]),
    );
  });

  it('materializes the installed source only with --check-updates', async () => {
    const dshHome = await home();
    const installed = fakeRuntime();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        installed.runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const runtime = fakeRuntime();

    const result = await statusProfiles({ dshHome, checkUpdates: true }, runtime.runtime);

    expect(result).toMatchObject({
      exitCode: 0,
      metadata: {
        checkUpdates: true,
        profiles: [expect.objectContaining({ status: 'tracked', update: 'none' })],
      },
    });
    expect(runtime.calls).toContainEqual(expect.stringMatching(/^materialize:/u));
  });

  it('counts current managed assets shared by two tracked profiles', async () => {
    const dshHome = await home();
    const runtime = fakeRuntime();
    await expect(
      installPack(
        {
          source: await enginePack({ assets: true, name: 'alpha' }),
          dshHome,
          interactive: false,
          yes: true,
        },
        runtime.runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      installPack(
        {
          source: await enginePack({ assets: true, name: 'beta' }),
          dshHome,
          interactive: false,
          yes: true,
        },
        runtime.runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    const result = await statusProfiles({ dshHome }, fakeRuntime().runtime);

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.metadata.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ profile: 'alpha', status: 'tracked', sharedAssets: 2 }),
        expect.objectContaining({ profile: 'beta', status: 'tracked', sharedAssets: 2 }),
      ]),
    );
  });

  it('returns the list failure and marks a tracked read failure without crashing', async () => {
    await expect(
      statusProfiles({ dshHome: 'relative' }, fakeRuntime().runtime),
    ).resolves.toMatchObject({
      exitCode: 31,
      metadata: { profiles: [] },
    });
    const dshHome = await home();
    const installed = fakeRuntime();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        installed.runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const failing = fakeRuntime();
    failing.runtime.readTextIfExists = async () => {
      throw new Error('state read failed');
    };

    const result = await statusProfiles({ dshHome }, failing.runtime);

    expect(result).toMatchObject({
      exitCode: 30,
      metadata: {
        profiles: [expect.objectContaining({ status: 'tracked', update: 'not-checked' })],
      },
    });
  });
});
