import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { runCli } from '../src/cli.js';

const temporaryRoots: string[] = [];

const manifest = [
  'formatVersion: 0',
  'name: validate-no-write-pack',
  'version: 0.1.0',
  'description: validate no-write fixture',
  'author: dshpack-test',
  'license: MIT',
  'dsh:',
  '  tested: [0.1.0-rc.6]',
  'plugins: []',
  'mcp: []',
  'defaults:',
  '  permissionPreset: workspace-write',
  '',
].join('\n');

function sha512(value: string): string {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

function sha256(value: string): string {
  return `sha256-${createHash('sha256').update(value).digest('base64url')}`;
}

async function makeFixture(): Promise<{ dshHome: string; pack: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-validate-no-write-'));
  temporaryRoots.push(root);
  const dshHome = join(root, 'clean-dsh-home');
  const pack = join(root, 'pack');
  const patch = '[]\n';
  await Promise.all([mkdir(dshHome), mkdir(join(pack, 'patch'), { recursive: true })]);
  await writeFile(join(pack, 'pack.yml'), manifest, 'utf8');
  await writeFile(join(pack, 'patch', 'cordis.patch.yml'), patch, 'utf8');
  await writeFile(
    join(pack, 'pack.lock.yml'),
    stringify({
      lockVersion: 0,
      manifestSha256: sha256(manifest),
      generatedBy: 'dshpack@0.1.0',
      generatedAt: '2026-08-16T00:00:00Z',
      dsh: { exportedFrom: '0.1.0-rc.6' },
      plugins: [],
      files: [{ path: 'patch/cordis.patch.yml', sha512: sha512(patch) }],
    }),
    'utf8',
  );
  return { dshHome, pack };
}

afterEach(async () => {
  process.exitCode = undefined;
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('validate zero-write boundary', () => {
  it('leaves an explicit clean --dsh-home empty before and after validate --strict', async () => {
    const { dshHome, pack } = await makeFixture();
    const before = await readdir(dshHome);

    process.exitCode = undefined;
    await runCli(['node', 'dshpack', '--dsh-home', dshHome, 'validate', pack, '--strict']);

    const after = await readdir(dshHome);
    console.info(`VALIDATE_CLEAN_HOME before=${before.length} after=${after.length}`);
    expect(process.exitCode).toBe(0);
    expect(before).toEqual([]);
    expect(after).toEqual([]);
  });
});
