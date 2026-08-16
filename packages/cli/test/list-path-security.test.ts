import { readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { inspectMetadata, inspectProfile } from '../src/list/contracts.js';
import { listProfiles } from '../src/list/engine.js';
import { securityHome, securityTrackedHome } from './list-switch-security-fixture.js';

const roots: string[] = [];

async function fixture(): Promise<string> {
  const home = await securityTrackedHome('list-path');
  roots.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('profile path confinement', () => {
  it('rejects a weak workspace mapping without the exact official-init baseline', async () => {
    const home = await fixture();
    await writeFile(join(home, 'profiles', 'demo', 'pnpm-workspace.yaml'), '{}\n');
    await expect(inspectProfile(home, 'demo')).resolves.toMatchObject({
      status: 'broken',
      failureKind: 'contract',
    });
  });

  it.each(['profile', 'profiles'] as const)(
    'marks a %s junction as security-broken',
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

      await expect(inspectProfile(home, 'demo')).resolves.toMatchObject({
        status: 'broken',
        failureKind: 'security',
      });
      const listed = await listProfiles({ dshHome: home });
      expect(listed.exitCode).toBe(0);
      expect(listed.metadata.profiles).toContainEqual(
        expect.objectContaining({ profile: 'demo', status: 'broken' }),
      );
    },
  );

  it('rejects a relative DSH_HOME instead of resolving it against cwd', async () => {
    await expect(listProfiles({ dshHome: 'relative-home' })).resolves.toMatchObject({
      exitCode: 31,
    });
  });

  it('rejects and redacts control characters in an absolute DSH_HOME', async () => {
    const base = await securityHome('list-control-home');
    roots.push(base);
    const report = await listProfiles({ dshHome: `${join(base, 'missing')}\u0001secret` });
    expect(report.exitCode).toBe(31);
    expect(JSON.stringify(report.diagnostics)).not.toContain('secret');
  });
});

describe('atomic metadata reads', () => {
  it('detects pathname replacement after the handle snapshot', async () => {
    const home = await fixture();
    const marker = join(home, '.dshpack', 'installed', 'demo.json');
    let swapped = false;
    const result = await inspectMetadata(home, 'demo', {
      afterFileSnapshot: async (path: string) => {
        if (path !== marker || swapped) return;
        swapped = true;
        await rename(path, `${path}.old`);
        await writeFile(path, await readFile(`${path}.old`));
      },
    });
    expect(swapped).toBe(true);
    expect(result).toMatchObject({ status: 'broken', failureKind: 'security' });
  });

  it('marks an installed metadata ancestor junction as security-broken', async () => {
    const home = await fixture();
    const installed = join(home, '.dshpack', 'installed');
    const target = `${installed}-target`;
    await rename(installed, target);
    await symlink(target, installed, 'junction');
    await expect(inspectMetadata(home, 'demo')).resolves.toMatchObject({
      status: 'broken',
      failureKind: 'security',
    });
  });

  it('does not treat a marker under a file-shaped root as merely missing', async () => {
    const base = await securityHome('list-root-file');
    roots.push(base);
    const home = join(base, 'home');
    await writeFile(home, 'not a directory');
    await expect(inspectMetadata(home, 'demo')).resolves.toMatchObject({
      status: 'broken',
      failureKind: 'security',
    });
  });
});
