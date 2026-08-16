import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const binPath =
  process.env.DSHPACK_E2E_BIN === undefined
    ? fileURLToPath(new URL('../dist/bin.js', import.meta.url))
    : resolve(process.env.DSHPACK_E2E_BIN);
const shimDirectory = fileURLToPath(new URL('./e2e/shims/', import.meta.url));
const roots: string[] = [];

async function boundaryFixture(): Promise<{
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), 'dshpack-cli-boundary-'));
  roots.push(cwd);
  const profile = join(cwd, 'profiles', 'demo');
  const log = join(cwd, 'dsh-argv.jsonl');
  await mkdir(profile, { recursive: true });
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-demo',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    }),
  );
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
  await writeFile(join(profile, 'pnpm-workspace.yaml'), "packages: ['.']\n");
  return {
    cwd,
    log,
    env: {
      ...process.env,
      DSH_HOME: '',
      PATH: [shimDirectory, dirname(process.execPath)].join(delimiter),
      DSHPACK_NODE_EXE: process.execPath,
      DSHPACK_SHIM_ARGV_LOG: log,
      DSHPACK_SHIM_STDOUT: '0.1.0-rc.6\n',
    },
  };
}

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('built CLI boundary', () => {
  it.each(['install', 'init', 'pack'] as const)(
    '%s emits a structured placeholder for root and child JSON placement',
    (command) => {
      for (const args of [
        ['--json', command],
        [command, '--json'],
      ]) {
        const result = spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8' });
        expect(result.status).toBe(70);
        expect(result.stderr).toBe('');
        expect(result.stdout.trim().split('\n')).toHaveLength(1);
        expect(JSON.parse(result.stdout)).toEqual({
          diagnostics: [expect.objectContaining({ code: 'E_NOT_IMPLEMENTED' })],
        });
      }
    },
  );

  it.each([
    ['root', ['--json', 'export']],
    ['child', ['export', '--json']],
  ] as const)('keeps handler-local export usage to one %s JSON object', (_placement, prefix) => {
    const result = spawnSync(
      process.execPath,
      [
        binPath,
        ...prefix,
        '--profile',
        'demo',
        '--output',
        'unused-output',
        '--include-settings',
        'other',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      diagnostics: [expect.objectContaining({ code: 'E_EXPORT_SETTINGS' })],
    });
  });

  it.each([
    ['root', ['--json', 'switch']],
    ['child', ['switch', '--json']],
  ] as const)('keeps Commander usage to one %s JSON object', (_placement, args) => {
    const result = spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      diagnostics: [expect.objectContaining({ code: 'E_USAGE' })],
    });
  });

  it('rejects empty or relative DSH_HOME before doctor/export I/O or subprocesses', async () => {
    const fixture = await boundaryFixture();
    const output = join(fixture.cwd, 'export-output');
    for (const [home, exitCode, code] of [
      ['', 10, 'E_DSH_HOME_REQUIRED'],
      ['relative-home', 31, 'E_PATH_DSH_HOME'],
    ] as const) {
      for (const args of [
        ['--json', 'doctor', '--profile', 'demo', '--yes'],
        ['doctor', '--json', '--profile', 'demo', '--yes'],
        ['--json', 'export', '--profile', 'demo', '--output', output],
        ['export', '--json', '--profile', 'demo', '--output', output],
      ]) {
        const result = spawnSync(process.execPath, [binPath, ...args], {
          cwd: fixture.cwd,
          encoding: 'utf8',
          env: { ...fixture.env, DSH_HOME: home },
        });
        expect(result.status).toBe(exitCode);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toEqual({
          diagnostics: [expect.objectContaining({ code })],
        });
      }
    }
    await expect(access(fixture.log)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);

  it('redacts an unknown exception as JSON exit 70 without a stack', async () => {
    const fixture = await boundaryFixture();
    const home = join(fixture.cwd, 'bad-home');
    await mkdir(join(home, 'settings.yaml'), { recursive: true });
    const result = spawnSync(process.execPath, [binPath, '--dsh-home', home, '--json', 'doctor'], {
      cwd: fixture.cwd,
      encoding: 'utf8',
      env: fixture.env,
    });

    expect(result.status).toBe(70);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain(home);
    expect(result.stdout).not.toContain('EISDIR');
    expect(result.stdout).not.toContain('at async');
    expect(JSON.parse(result.stdout)).toEqual({
      diagnostics: [expect.objectContaining({ code: 'E_INTERNAL' })],
    });
  });
});
