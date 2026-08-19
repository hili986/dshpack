import { isAbsolute } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runners = vi.hoisted(() => ({
  doctor: vi.fn(),
  exportProfile: vi.fn(),
}));

vi.mock('../src/doctor/engine.js', () => ({ runDoctor: runners.doctor }));
vi.mock('../src/export/engine.js', () => ({ exportProfile: runners.exportProfile }));

import { COMMAND_NAMES, createProgram, runCli } from '../src/cli.js';
import { diagnostic, exitCodeFor, resolveDshHomeValue } from '../src/commands/shared.js';
import { DSHPACK_VERSION } from '../src/version.js';

interface CapturedRun {
  exitCode: number | undefined;
  stderr: string;
  stdout: string;
}

const originalDshHome = process.env.DSH_HOME;
const unsafePathControls = [
  ...Array.from({ length: 0x20 }, (_, code) => String.fromCodePoint(code)),
  ...Array.from({ length: 0x21 }, (_, offset) => String.fromCodePoint(0x7f + offset)),
];

async function capture(args: readonly string[]): Promise<CapturedRun> {
  let stdout = '';
  let stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  process.exitCode = undefined;
  await runCli(['node', 'dshpack', ...args]);
  return { exitCode: process.exitCode, stderr, stdout };
}

afterEach(() => {
  runners.doctor.mockReset();
  runners.exportProfile.mockReset();
  vi.restoreAllMocks();
  process.exitCode = undefined;
  if (originalDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalDshHome;
});

describe('global DSH_HOME boundary', () => {
  it.each([
    [undefined, 10, 'E_DSH_HOME_REQUIRED'],
    ['', 10, 'E_DSH_HOME_REQUIRED'],
    ['relative/dsh-home', 31, 'E_PATH_DSH_HOME'],
  ] as const)('rejects doctor DSH_HOME %j before the engine', async (home, exitCode, code) => {
    if (home === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = home;

    const result = await capture(['--json', 'doctor']);

    expect(result).toMatchObject({ exitCode, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      diagnostics: [expect.objectContaining({ code })],
    });
    expect(runners.doctor).not.toHaveBeenCalled();
  });

  it.each([
    ['', 10, 'E_DSH_HOME_REQUIRED'],
    ['relative/dsh-home', 31, 'E_PATH_DSH_HOME'],
  ] as const)('rejects export DSH_HOME %j before the engine', async (home, exitCode, code) => {
    process.env.DSH_HOME = home;

    const result = await capture([
      'export',
      '--json',
      '--profile',
      'demo',
      '--output',
      'unused-output',
    ]);

    expect(result).toMatchObject({ exitCode, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      diagnostics: [expect.objectContaining({ code })],
    });
    expect(runners.exportProfile).not.toHaveBeenCalled();
  });

  it('forwards a normalized absolute DSH_HOME', async () => {
    const home = process.cwd();
    expect(isAbsolute(home)).toBe(true);
    runners.doctor.mockResolvedValue({
      diagnostics: [],
      exitCode: 0,
      metadata: { sideEffects: ['profile/cordis.yml'] },
    });

    const result = await capture(['--dsh-home', home, '--json', 'doctor']);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(runners.doctor).toHaveBeenCalledWith(expect.objectContaining({ dshHome: home }));
  });

  it('rejects a relative root override even when the environment is absolute', async () => {
    process.env.DSH_HOME = process.cwd();

    const result = await capture(['--dsh-home', 'relative/home', 'doctor', '--json']);

    expect(result).toMatchObject({ exitCode: 31, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'E_PATH_DSH_HOME' })],
    });
    expect(runners.doctor).not.toHaveBeenCalled();
  });

  it.each(unsafePathControls)(
    'rejects an absolute DSH_HOME containing control %j as a redacted security error',
    async (control) => {
      const unsafeHome = `${process.cwd()}${control}private`;
      process.env.DSH_HOME = process.cwd();

      const result = await capture(['--dsh-home', unsafeHome, 'doctor', '--json']);

      expect(result).toMatchObject({ exitCode: 31, stderr: '' });
      expect(result.stdout).not.toContain(unsafeHome);
      expect(JSON.parse(result.stdout)).toMatchObject({
        diagnostics: [expect.objectContaining({ code: 'E_PATH_DSH_HOME' })],
      });
      expect(runners.doctor).not.toHaveBeenCalled();
    },
  );
});

describe('implemented command registration', () => {
  it('registers migrate as an implemented command instead of the generic placeholder', () => {
    expect(COMMAND_NAMES).toContain('migrate');
    expect(createProgram().commands.some((command) => command.name() === 'migrate')).toBe(true);
    expect(COMMAND_NAMES).toContain('uninstall');
    expect(createProgram().commands.some((command) => command.name() === 'uninstall')).toBe(true);
  });
});

describe('top-level error boundary', () => {
  it.each([
    { args: ['--json', 'doctor'], json: true },
    { args: ['doctor', '--json'], json: true },
    { args: ['doctor'], json: false },
  ])('maps an unknown exception to a redacted exit 70 report: $args', async ({ args, json }) => {
    process.env.DSH_HOME = process.cwd();
    runners.doctor.mockRejectedValue(
      new Error('sensitive failure at C:/Users/example/private/settings.yaml'),
    );

    const result = await capture(args);

    expect(result.exitCode).toBe(70);
    expect(`${result.stdout}${result.stderr}`).not.toContain('sensitive failure');
    expect(`${result.stdout}${result.stderr}`).not.toContain('C:/Users/example');
    expect(`${result.stdout}${result.stderr}`).not.toContain('at async');
    if (json) {
      expect(result.stderr).toBe('');
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toEqual({
        diagnostics: [expect.objectContaining({ code: 'E_INTERNAL', severity: 'error' })],
      });
    } else {
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('E_INTERNAL');
    }
  });
});

describe('JSON mode closure', () => {
  it.each([
    ['root', ['--json', 'export']],
    ['child', ['export', '--json']],
  ] as const)(
    'serializes handler-local export usage in %s JSON mode',
    async (_placement, prefix) => {
      process.env.DSH_HOME = process.cwd();
      const result = await capture([
        ...prefix,
        '--profile',
        'demo',
        '--output',
        'unused-output',
        '--include-settings',
        'other',
      ]);

      expect(result).toMatchObject({ exitCode: 2, stderr: '' });
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toEqual({
        diagnostics: [expect.objectContaining({ code: 'E_EXPORT_SETTINGS', severity: 'error' })],
      });
      expect(runners.exportProfile).not.toHaveBeenCalled();
    },
  );

  it.each(['init', 'pack'] as const)(
    'serializes the implemented %s command for root and child JSON placement',
    async (command) => {
      for (const args of [
        ['--json', command, ...(command === 'pack' ? ['missing-source'] : [])],
        [command, '--json', ...(command === 'pack' ? ['missing-source'] : [])],
      ]) {
        const result = await capture(args);
        expect(result).toMatchObject({ exitCode: expect.any(Number), stderr: '' });
        expect(result.stdout.trim().split('\n')).toHaveLength(1);
        expect(JSON.parse(result.stdout)).toEqual(
          expect.objectContaining({ diagnostics: expect.any(Array) }),
        );
        vi.restoreAllMocks();
      }
    },
  );

  it.each(['init', 'pack'] as const)('reports the %s result outside JSON mode', async (command) => {
    const result = await capture([command, ...(command === 'pack' ? ['missing-source'] : [])]);

    expect(result).toMatchObject({ exitCode: expect.any(Number), stdout: '' });
    expect(result.stderr).not.toBe('');
  });

  it.each([
    ['root', ['--json', 'install']],
    ['child', ['install', '--json']],
  ] as const)('serializes install usage as one %s JSON object', async (_placement, args) => {
    const result = await capture(args);

    expect(result).toMatchObject({ exitCode: 2, stderr: '' });
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      diagnostics: [expect.objectContaining({ code: 'E_USAGE', severity: 'error' })],
    });
  });

  it.each([
    ['root', ['--json', '--help']],
    ['child', ['list', '--json', '--help']],
  ] as const)('serializes %s help as one JSON object', async (_placement, args) => {
    const result = await capture(args);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ diagnostics: [], help: expect.any(String) });
  });

  it.each([['-V'], ['--version']] as const)('answers %s with the package version', async (flag) => {
    const result = await capture([flag]);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout.trim()).toBe(DSHPACK_VERSION);
  });

  it('reports the version under its own key, not as help text', async () => {
    const result = await capture(['--version', '--json']);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({ diagnostics: [], version: DSHPACK_VERSION });
    expect(report).not.toHaveProperty('help');
  });

  // Commander recognises program options after a subcommand too, so before 0.2.1 every one of
  // these printed dshpack's version and exited 0 having done nothing. Exit 0 is the whole problem:
  // a misspelling that errors is survivable, one that reports success is not.
  it.each([
    ['init', ['init', 'starter', '--version', '9.9.9'], '--pack-version'],
    ['init via -V', ['init', 'starter', '-V'], '--pack-version'],
    ['list', ['list', '--version'], '放在子命令之前'],
  ] as const)('refuses a version flag placed after %s', async (_case, args, expectedHint) => {
    const result = await capture(args);

    expect(result).toMatchObject({ exitCode: 2, stdout: '' });
    expect(result.stderr).toContain('E_USAGE');
    expect(result.stderr).toContain('放在子命令之后不会生效');
    expect(result.stderr).toContain(expectedHint);
    expect(result.stderr).not.toContain(DSHPACK_VERSION);
  });

  it('keeps the refusal to one JSON object on stdout', async () => {
    const result = await capture(['--json', 'init', 'starter', '--version', '9.9.9']);

    expect(result).toMatchObject({ exitCode: 2, stderr: '' });
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      diagnostics: [expect.objectContaining({ code: 'E_USAGE', hint: expect.any(String) })],
    });
  });

  it('leaves a version flag after `--` to the parser, since it is an operand there', async () => {
    // The guard scans argv itself, so it has to honour the terminator the way Commander does —
    // otherwise `install <src> -- --version` would be refused for a flag that is just data.
    const result = await capture(['init', 'starter', '--', '--version']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).not.toContain('放在子命令之后不会生效');
    expect(result.stderr).toContain('too many arguments');
  });
});

describe('stable exit classification', () => {
  it('classifies shared empty, relative, control, and absolute DSH_HOME values without echoing input', () => {
    expect(resolveDshHomeValue('')).toMatchObject({
      ok: false,
      report: {
        exitCode: 10,
        diagnostics: [expect.objectContaining({ code: 'E_DSH_HOME_REQUIRED' })],
      },
    });
    expect(resolveDshHomeValue('relative')).toMatchObject({
      ok: false,
      report: { exitCode: 31, diagnostics: [expect.objectContaining({ code: 'E_PATH_DSH_HOME' })] },
    });
    const unsafe = `${process.cwd()}\u0001secret`;
    const rejected = resolveDshHomeValue(unsafe);
    expect(rejected).toMatchObject({
      ok: false,
      report: { exitCode: 31, diagnostics: [expect.objectContaining({ code: 'E_PATH_DSH_HOME' })] },
    });
    expect(JSON.stringify(rejected)).not.toContain('secret');
    expect(resolveDshHomeValue(process.cwd())).toMatchObject({ ok: true, value: process.cwd() });
  });

  it('classifies MCP credentials as security failures', () => {
    expect(
      exitCodeFor([
        diagnostic(
          'E_MCP_CREDENTIAL',
          'error',
          'MCP URL contains credentials.',
          'Remove credentials.',
        ),
      ]),
    ).toBe(31);
  });
});
