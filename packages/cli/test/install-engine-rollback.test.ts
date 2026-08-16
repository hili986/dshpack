import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { installPack } from '../src/install/engine.js';
import type { InstallRuntimeStage } from '../src/install/runtime-types.js';
import { enginePack, fakeRuntime } from './install-engine-fixture.js';

const roots: string[] = [];
async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-rollback-home-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('install stage rollback hooks', () => {
  it.each<[InstallRuntimeStage, number]>([
    ['init', 23],
    ['verify', 24],
    ['assets', 30],
    ['dump', 24],
    ['metadata', 24],
  ])('rolls back a newly-created profile after injected %s failure', async (stage, exitCode) => {
    const dshHome = await home();
    const originalSettings = '# exact original\nother:\n  keep: true\n';
    await writeFile(join(dshHome, 'settings.yaml'), originalSettings);
    const source = await enginePack({ assets: true });
    const report = await installPack(
      { source, dshHome, yes: true, interactive: false },
      fakeRuntime({ fault: stage }).runtime,
    );
    expect(report.exitCode).toBe(exitCode);
    expect(report.metadata.status).toBe('rolled-back');
    await expect(
      readFile(join(dshHome, 'profiles', 'engine-pack', 'package.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const backups = await readdir(join(dshHome, '.dshpack', 'backups'));
    expect(backups).toHaveLength(1);
    expect(report.metadata.backupDirectory).toContain(backups[0]);
    expect(await readFile(join(dshHome, 'settings.yaml'), 'utf8')).toBe(originalSettings);
    await expect(readFile(join(dshHome, 'skills', 'notes', 'SKILL.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      readFile(join(dshHome, '.agent-presets', 'custom', 'agent.cordis.yml')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(join(dshHome, '.dshpack', 'installed', 'engine-pack.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const journal = JSON.parse(await readFile(report.metadata.journalPath as string, 'utf8')) as {
      actions: { kind: string; artifact?: string; new?: { rollbackPath?: string } }[];
    };
    const profile = journal.actions.find(
      (item) => item.kind === 'create' && item.artifact === 'profile',
    );
    expect(profile?.new?.rollbackPath).toContain(join('.dshpack', 'backups'));
    expect(
      await readFile(join(profile?.new?.rollbackPath as string, 'package.json'), 'utf8'),
    ).toContain('dsh-profile-engine-pack');
  });

  it('restores the old profile byte-for-byte after --replace fails', async () => {
    const dshHome = await home();
    const oldProfile = join(dshHome, 'profiles', 'engine-pack');
    await mkdir(oldProfile, { recursive: true });
    await writeFile(join(oldProfile, 'user-sentinel'), 'old-profile-bytes');
    const source = await enginePack();
    const report = await installPack(
      { source, dshHome, replace: true, yes: true, interactive: false },
      fakeRuntime({ fault: 'assets' }).runtime,
    );
    expect(report).toMatchObject({ exitCode: 30, metadata: { status: 'rolled-back' } });
    expect(await readFile(join(oldProfile, 'user-sentinel'), 'utf8')).toBe('old-profile-bytes');
  });

  it('reports rollback-failed with exact manual recovery paths and no success claim', async () => {
    const dshHome = await home();
    const source = await enginePack({ assets: true });
    const report = await installPack(
      { source, dshHome, yes: true, interactive: false },
      fakeRuntime({ fault: 'assets', rollbackFailure: true }).runtime,
    );
    expect(report).toMatchObject({ exitCode: 25, metadata: { status: 'rollback-failed' } });
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'E_TRANSACTION_ROLLBACK_FAILED' }),
    );
    expect(report.metadata.manualRecovery?.[0]).toMatchObject({ operation: 'rename' });
    expect(report.metadata.manualRecovery?.[0]?.sourcePath).toBe(
      join(dshHome, 'profiles', 'engine-pack'),
    );
    expect(report.metadata.manualRecovery?.[0]?.destinationPath).toContain(
      join('.dshpack', 'backups'),
    );
    expect(report.metadata.status).not.toBe('installed');
  });
});
