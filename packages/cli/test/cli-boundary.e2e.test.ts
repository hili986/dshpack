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
  it.each(['init', 'pack'] as const)(
    '%s emits one structured result for root and child JSON placement',
    (command) => {
      for (const args of [
        ['--json', command, ...(command === 'pack' ? ['missing-source'] : [])],
        [command, '--json', ...(command === 'pack' ? ['missing-source'] : [])],
      ]) {
        const result = spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8' });
        expect(result.status).toBe(command === 'init' ? 21 : 30);
        expect(result.stderr).toBe('');
        expect(result.stdout.trim().split('\n')).toHaveLength(1);
        const report = JSON.parse(result.stdout);
        expect(report).toEqual(expect.objectContaining({ diagnostics: expect.any(Array) }));
        expect(report.diagnostics[0].code).toBe(
          command === 'init' ? 'E_INIT_REQUIRED' : 'E_SOURCE_DIRECTORY',
        );
      }
    },
  );

  it.each([
    ['root', ['--json', 'install']],
    ['child', ['install', '--json']],
  ] as const)('keeps install usage to one %s JSON object', (_placement, args) => {
    const result = spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      diagnostics: [expect.objectContaining({ code: 'E_USAGE' })],
    });
  });

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

  it('runs its own copyable init command successfully, exactly as printed', async () => {
    // 0.2.0 shipped this broken and every unit test stayed green, because they all call the
    // command's action with an options object and never cross the argv parser. The program
    // registers `-V, --version`, Commander lets the program consume it wherever it appears,
    // and the hint told users to type `--version "0.1.0"` — so copying the tool's own advice
    // printed the tool version and exited 0 having created nothing.
    //
    // The assertion deliberately does not name any flag: it takes whatever the tool prints and
    // runs that. If the spelling changes again, this still checks the only thing that matters —
    // the command we hand the user works.
    const fixture = await boundaryFixture();
    const target = join(fixture.cwd, 'copyable');

    const refused = spawnSync(process.execPath, [binPath, '--json', 'init', target], {
      cwd: fixture.cwd,
      encoding: 'utf8',
      env: fixture.env,
    });
    expect(refused.status).toBe(21);
    const hint = JSON.parse(refused.stdout).diagnostics[0].hint as string;
    const printed = hint.slice(hint.indexOf('dshpack init'));

    // Split on spaces outside double quotes, then unquote — the hint JSON-quotes every value.
    // Drop only the `dshpack` argv[0]; everything after it, subcommand included, is run verbatim.
    const argv = (printed.match(/"[^"]*"|\S+/gu) ?? [])
      .slice(1)
      .map((token) => (token.startsWith('"') ? (JSON.parse(token) as string) : token));

    const copied = spawnSync(process.execPath, [binPath, ...argv], {
      cwd: fixture.cwd,
      encoding: 'utf8',
      env: fixture.env,
    });

    expect({ status: copied.status, stderr: copied.stderr }).toEqual({ status: 0, stderr: '' });
    await expect(access(join(target, 'pack.yml'))).resolves.toBeUndefined();
    await expect(access(join(target, 'pack.lock.yml'))).resolves.toBeUndefined();
  });
});
