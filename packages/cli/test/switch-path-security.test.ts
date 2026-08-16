import { rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { type SwitchRuntime, switchProfile } from '../src/switch/engine.js';
import {
  securityHome,
  securityProfile,
  securityTrackedHome,
} from './list-switch-security-fixture.js';

const roots: string[] = [];

async function fixture(): Promise<string> {
  const home = await securityTrackedHome('switch-path');
  roots.push(home);
  return home;
}

function runtime(overrides: Partial<SwitchRuntime> = {}): SwitchRuntime {
  return {
    confirm: vi.fn(async () => false),
    isTTY: true,
    showDiff: vi.fn(),
    spawnDsh: vi.fn(async () => 0),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('switch path security', () => {
  it.each(['profile', 'profiles'] as const)(
    'maps a %s junction to security exit 31',
    async (kind) => {
      const home = await fixture();
      const source = join(
        home,
        kind === 'profile' ? 'profiles' : '',
        kind === 'profile' ? 'demo' : 'profiles',
      );
      const target = `${source}-target`;
      await rename(source, target);
      await symlink(target, source, 'junction');
      const deps = runtime();

      await expect(
        switchProfile({ dshHome: home, profile: 'demo', run: true }, deps),
      ).resolves.toMatchObject({ exitCode: 31 });
      expect(deps.spawnDsh).not.toHaveBeenCalled();
    },
  );

  it('rejects a DSH_HOME junction and a relative DSH_HOME', async () => {
    const target = await fixture();
    const base = await securityHome('switch-home-link');
    roots.push(base);
    const linked = join(base, 'linked-home');
    await symlink(target, linked, 'junction');
    await expect(
      switchProfile({ dshHome: linked, profile: 'demo' }, runtime()),
    ).resolves.toMatchObject({
      exitCode: 31,
    });
    await expect(
      switchProfile({ dshHome: 'relative-home', profile: 'demo' }, runtime()),
    ).resolves.toMatchObject({ exitCode: 31 });
  });

  it('revalidates the profile directory identity immediately before spawn', async () => {
    const home = await fixture();
    const profile = join(home, 'profiles', 'demo');
    const backup = `${profile}-before-swap`;
    const deps = runtime({
      confirm: vi.fn(async () => {
        await rename(profile, backup);
        await securityProfile(home);
        return true;
      }),
    });
    const result = await switchProfile(
      { dshHome: home, profile: 'demo', setDefaultPreset: true, run: true },
      deps,
    );
    expect(result.exitCode).toBe(31);
    expect(deps.spawnDsh).not.toHaveBeenCalled();
  });

  it('rejects a junction in the installed default preset path', async () => {
    const home = await fixture();
    const presets = join(home, '.agent-presets');
    const target = `${presets}-target`;
    await rename(presets, target);
    await symlink(target, presets, 'junction');
    await expect(
      switchProfile(
        { dshHome: home, profile: 'demo', setDefaultPreset: true, yes: true },
        runtime(),
      ),
    ).resolves.toMatchObject({ exitCode: 31 });
  });
});
