import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runDoctor } from '../src/doctor/engine.js';

const temporaryRoots: string[] = [];

async function makeDshHome(patch = '[]\n', bundlePatch = './cordis.patch.yml'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-doctor-'));
  temporaryRoots.push(root);
  const profile = join(root, 'profiles', 'demo');
  const bundle = join(profile, 'node_modules', 'demo-bundle');
  await mkdir(bundle, { recursive: true });
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-demo',
      private: true,
      dependencies: { 'demo-bundle': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'demo-bundle'] } },
    }),
    'utf8',
  );
  await writeFile(join(profile, 'cordis.patch.yml'), patch, 'utf8');
  await writeFile(
    join(bundle, 'package.json'),
    JSON.stringify({ name: 'demo-bundle', dsh: { bundle: { patch: bundlePatch } } }),
    'utf8',
  );
  const shim = join(root, 'shim');
  await mkdir(shim);
  await writeFile(
    join(shim, 'doctor-shim.mjs'),
    `const argv = process.argv.slice(2);\nprocess.stdout.write(argv.includes('--version') ? '0.1.0-rc.6\\n' : '[]\\n');\nprocess.exitCode = Number(process.env.DOCTOR_SHIM_EXIT ?? 0);\n`,
    'utf8',
  );
  if (process.platform === 'win32') {
    await writeFile(
      join(shim, 'dsh.cmd'),
      `@echo off\n"%DSHPACK_NODE_EXE%" "%~dp0doctor-shim.mjs" %*\n`,
      'utf8',
    );
  } else {
    await writeFile(
      join(shim, 'dsh'),
      `#!/usr/bin/env node\nawait import('./doctor-shim.mjs');\n`,
      'utf8',
    );
    await chmod(join(shim, 'dsh'), 0o755);
  }
  return root;
}

function doctorEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    DSHPACK_NODE_EXE: process.execPath,
    PATH: [join(home, 'shim'), process.env.PATH ?? dirname(process.execPath)].join(delimiter),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('doctor', () => {
  it('covers no-profile, absent-profile, deferred fix, and DSH010 repair branches', async () => {
    const home = await makeDshHome('');
    const env = doctorEnvironment(home);
    await expect(runDoctor({ dshHome: home, env })).resolves.toMatchObject({
      metadata: { sideEffects: ['profile/cordis.yml'] },
    });
    await expect(runDoctor({ dshHome: home, profile: 'absent', env })).resolves.toMatchObject({
      metadata: { profile: 'absent' },
    });
    await mkdir(join(home, '.dshpack', 'installed'), { recursive: true });
    await writeFile(join(home, '.dshpack', 'installed', 'demo.json'), '{}', 'utf8');
    const deferred = await runDoctor({ dshHome: home, profile: 'demo', fix: true, env });
    expect(deferred.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'DSH008', severity: 'warning' }),
    );
    const skill = join(home, 'skills', 'repair-me', 'SKILL.md');
    await mkdir(join(skill, '..'), { recursive: true });
    await writeFile(skill, '---\ndescription: repair\n---\nbody\n', 'utf8');
    await runDoctor({ dshHome: home, profile: 'demo', fix: true, yes: true, env });
    expect(await readFile(skill, 'utf8')).toContain('name: repair-me');
    await writeFile(join(home, 'settings.yaml'), 'agent-presets:\n  token: synthetic\n', 'utf8');
    await expect(
      runDoctor({ dshHome: home, profile: 'demo', yes: true, env }),
    ).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'DSH018' })]),
    });
    await expect(runDoctor({ dshHome: home, env, nodeVersion: '25.0.0' })).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'DSH001' })]),
    });
  }, 20_000);

  it('discloses dump side effects and declines an untracked profile without --yes', async () => {
    const home = await makeDshHome();
    const report = await runDoctor({
      dshHome: home,
      profile: 'demo',
      env: doctorEnvironment(home),
    });

    expect(report.exitCode).toBe(21);
    expect(report.metadata.sideEffects).toEqual(['profile/cordis.yml']);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'DSH009' }));
  });

  it('mutant: empty patch is RED, --fix writes [], then a fresh doctor run is GREEN for DSH008', async () => {
    const home = await makeDshHome('');
    const input = { dshHome: home, profile: 'demo', yes: true, env: doctorEnvironment(home) };
    const red = await runDoctor(input);
    console.info(`DOCTOR_DSH008_RED ${JSON.stringify(red.diagnostics.map(({ code }) => code))}`);
    expect(red.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'DSH008', severity: 'error' }),
    );

    await runDoctor({ ...input, fix: true });
    const green = await runDoctor(input);
    console.info(
      `DOCTOR_DSH008_GREEN ${JSON.stringify(green.diagnostics.map(({ code }) => code))}`,
    );
    expect(
      green.diagnostics.some(({ code, severity }) => code === 'DSH008' && severity === 'error'),
    ).toBe(false);
  });

  it('mutant: missing bundle patch is RED, restoring the declaration turns DSH005/006 GREEN', async () => {
    const home = await makeDshHome('[]\n', undefined as never);
    const bundle = join(home, 'profiles', 'demo', 'node_modules', 'demo-bundle', 'package.json');
    await writeFile(bundle, JSON.stringify({ name: 'demo-bundle' }), 'utf8');
    const input = { dshHome: home, profile: 'demo', yes: true, env: doctorEnvironment(home) };
    const red = await runDoctor(input);
    console.info(`DOCTOR_DSH005_RED ${JSON.stringify(red.diagnostics.map(({ code }) => code))}`);
    expect(red.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'DSH005', severity: 'error' }),
    );

    await writeFile(
      bundle,
      JSON.stringify({ name: 'demo-bundle', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      'utf8',
    );
    const green = await runDoctor(input);
    console.info(
      `DOCTOR_DSH005_GREEN ${JSON.stringify(green.diagnostics.map(({ code }) => code))}`,
    );
    expect(
      green.diagnostics.some(
        ({ code, severity }) => (code === 'DSH005' || code === 'DSH006') && severity === 'error',
      ),
    ).toBe(false);
  });
});
