import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { captureInstallTargetState } from '../src/install/runtime-state.js';

const roots: string[] = [];

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-install-state-security-'));
  roots.push(root);
  return root;
}

function request(dshHome: string, skills: readonly string[] = []) {
  return { dshHome, profile: 'demo', skills, presets: [] };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('install target state security', () => {
  it('captures an empty target without an external default or settings document', async () => {
    const result = await captureInstallTargetState(request(await temporary()));
    expect(result.state.externalDefaultPreset).toBeUndefined();
    expect(result.settingsDocument).toBeUndefined();
  });

  it('hashes a nested managed directory without following links', async () => {
    const home = await temporary();
    await mkdir(join(home, 'profiles', 'demo', 'nested'), { recursive: true });
    await writeFile(join(home, 'profiles', 'demo', 'nested', 'fact'), 'bound bytes');
    const result = await captureInstallTargetState(request(home));
    expect(result.state.profile.state).toBe('present');
  });

  it('requires an absolute ordinary DSH_HOME with no link ancestor', async () => {
    await expect(captureInstallTargetState(request('relative-home'))).rejects.toMatchObject({
      code: 'E_TARGET_PATH',
    });
    const parent = await temporary();
    const file = join(parent, 'not-a-directory');
    await writeFile(file, 'x');
    await expect(captureInstallTargetState(request(file))).rejects.toMatchObject({
      code: 'E_TARGET_PATH',
    });
    const actual = await temporary();
    const linked = join(parent, 'linked-home');
    await symlink(actual, linked, 'junction');
    await expect(captureInstallTargetState(request(linked))).rejects.toMatchObject({
      code: 'E_TARGET_PATH',
    });
  });

  it.each(['skills//x', 'skills/./x', 'skills/../x', 'skills\\x', 'skills/\u0001x'])(
    'rejects unsafe managed relative path %j',
    async (path) => {
      await expect(
        captureInstallTargetState(request(await temporary(), [path])),
      ).rejects.toMatchObject({
        code: 'E_TARGET_PATH',
      });
    },
  );

  it('rejects a non-directory ancestor and a file in a directory-only target', async () => {
    const ancestorHome = await temporary();
    await writeFile(join(ancestorHome, 'profiles'), 'not a directory');
    await expect(captureInstallTargetState(request(ancestorHome))).rejects.toMatchObject({
      code: 'E_TARGET_PATH',
    });

    const targetHome = await temporary();
    await mkdir(join(targetHome, 'profiles'));
    await writeFile(join(targetHome, 'profiles', 'demo'), 'not a directory');
    await expect(captureInstallTargetState(request(targetHome))).rejects.toMatchObject({
      code: 'E_TARGET_PATH',
    });
  });

  it('rejects linked, hardlinked, and oversized managed file content', async () => {
    const linkedHome = await temporary();
    const external = await temporary();
    await mkdir(join(linkedHome, 'profiles', 'demo'), { recursive: true });
    await writeFile(join(external, 'outside'), 'outside');
    await symlink(external, join(linkedHome, 'profiles', 'demo', 'linked'), 'junction');
    await expect(captureInstallTargetState(request(linkedHome))).rejects.toMatchObject({
      code: 'E_TARGET_PATH',
    });

    const hardlinkHome = await temporary();
    await writeFile(join(hardlinkHome, 'settings.yaml'), 'agent-presets: {}\n');
    await link(join(hardlinkHome, 'settings.yaml'), join(hardlinkHome, 'settings-copy.yaml'));
    await expect(captureInstallTargetState(request(hardlinkHome))).rejects.toMatchObject({
      code: 'E_TARGET_PATH',
    });

    const largeHome = await temporary();
    await writeFile(join(largeHome, 'settings.yaml'), Buffer.alloc(1024 * 1024 + 1));
    await expect(captureInstallTargetState(request(largeHome))).rejects.toMatchObject({
      code: 'E_TARGET_PATH',
    });
  });

  it('rejects settings.yaml when it is a directory', async () => {
    const home = await temporary();
    await mkdir(join(home, 'settings.yaml'));
    await expect(captureInstallTargetState(request(home))).rejects.toMatchObject({
      code: 'E_TARGET_PATH',
      path: resolve(home, 'settings.yaml'),
    });
  });
});
