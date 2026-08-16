import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  dshOptions,
  markdownFiles,
  profileSecretDiagnostics,
  readProfile,
  text,
  versionAtLeast,
} from '../src/doctor/support.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-doctor-support-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('doctor support', () => {
  it('accepts the exact minimum semantic version', () => {
    expect(versionAtLeast('10.0.0', [10, 0, 0])).toBe(true);
    expect(versionAtLeast('22.19.0', [22, 19, 0])).toBe(true);
    expect(versionAtLeast('10.0.1', [10, 0, 0])).toBe(true);
    expect(versionAtLeast('9.99.99', [10, 0, 0])).toBe(false);
    expect(versionAtLeast('not-a-version', [10, 0, 0])).toBe(false);
  });

  it('reads optional files, propagates unreadable paths, and only forwards explicitly supplied env', async () => {
    const root = await temporaryRoot();
    const file = join(root, 'value.txt');
    await writeFile(file, 'value', 'utf8');

    await expect(text(file)).resolves.toBe('value');
    await expect(text(join(root, 'missing.txt'))).resolves.toBeUndefined();
    await expect(text(root)).rejects.toMatchObject({ code: expect.any(String) });
    expect(dshOptions({ dshHome: root })).toEqual({});
    expect(dshOptions({ dshHome: root, env: { PATH: 'shim' } })).toEqual({
      env: { PATH: 'shim' },
    });
  });

  it('validates every profile manifest contract branch before returning facts', async () => {
    const root = await temporaryRoot();
    const profile = join(root, 'profiles', 'demo');
    await mkdir(profile, { recursive: true });

    await expect(readProfile(root, 'demo')).resolves.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'DSH004' })],
    });
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n', 'utf8');
    await writeFile(join(profile, 'package.json'), '{', 'utf8');
    await expect(readProfile(root, 'demo')).resolves.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'DSH004' })],
    });

    await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: [] }), 'utf8');
    await expect(readProfile(root, 'demo')).resolves.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'DSH004' })],
    });

    await writeFile(
      join(profile, 'package.json'),
      JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: ['duplicate', 'duplicate'] } } }),
      'utf8',
    );
    await expect(readProfile(root, 'demo')).resolves.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'DSH004' })],
    });

    await writeFile(
      join(profile, 'package.json'),
      JSON.stringify({
        dependencies: { bundle: '1.0.0' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'bundle'] } },
      }),
      'utf8',
    );
    await expect(readProfile(root, 'demo')).resolves.toMatchObject({
      facts: {
        root: profile,
        patch: '[]\n',
        bundles: ['@deepseek-ai/dsh-base', 'bundle'],
        dependencies: { bundle: '1.0.0' },
      },
      diagnostics: [],
    });
  });

  it('discovers skill markdown recursively and fails closed for unreadable roots', async () => {
    const root = await temporaryRoot();
    const skills = join(root, 'skills');
    await mkdir(join(skills, 'nested'), { recursive: true });
    await writeFile(join(skills, 'first.md'), '# first\n', 'utf8');
    await writeFile(join(skills, 'nested', 'SKILL.md'), '# nested\n', 'utf8');
    await writeFile(join(skills, 'ignored.txt'), 'ignored\n', 'utf8');

    await expect(markdownFiles(join(root, 'missing'))).resolves.toEqual([]);
    await expect(markdownFiles(skills)).resolves.toEqual(
      expect.arrayContaining([join(skills, 'first.md'), join(skills, 'nested', 'SKILL.md')]),
    );
    await expect(markdownFiles(join(skills, 'first.md'))).rejects.toMatchObject({
      code: expect.any(String),
    });
  });

  it('scans profile source files but excludes dependency payload and lock noise', async () => {
    const root = await temporaryRoot();
    await expect(profileSecretDiagnostics(join(root, 'missing'))).resolves.toEqual([]);
    await mkdir(join(root, 'node_modules', '.credentials.yaml'), { recursive: true });
    await writeFile(join(root, 'pnpm-lock.yaml'), 'sk-TESTONLY-01234567890123456789\n', 'utf8');
    await writeFile(join(root, '.credentials.yaml'), 'token: sk-TESTONLY-01234567890123456789\n', 'utf8');

    await expect(profileSecretDiagnostics(root)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_SECRET_FILENAME' })]),
    );
    await expect(profileSecretDiagnostics(join(root, '.credentials.yaml'))).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'DSH014' })]),
    );
  });
});
