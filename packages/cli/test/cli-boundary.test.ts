import { isAbsolute } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runners = vi.hoisted(() => ({
  doctor: vi.fn(),
  exportProfile: vi.fn(),
}));

vi.mock('../src/doctor/engine.js', () => ({ runDoctor: runners.doctor }));
vi.mock('../src/export/engine.js', () => ({ exportProfile: runners.exportProfile }));

import { runCli } from '../src/cli.js';
import { diagnostic, exitCodeFor, resolveDshHomeValue } from '../src/commands/shared.js';

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
    'serializes the %s placeholder for root and child JSON placement',
    async (command) => {
      for (const args of [
        ['--json', command],
        [command, '--json'],
      ]) {
        const result = await capture(args);
        expect(result).toMatchObject({ exitCode: 70, stderr: '' });
        expect(result.stdout.trim().split('\n')).toHaveLength(1);
        expect(JSON.parse(result.stdout)).toEqual({
          diagnostics: [expect.objectContaining({ code: 'E_NOT_IMPLEMENTED', severity: 'error' })],
        });
        vi.restoreAllMocks();
      }
    },
  );

  it.each(['init', 'pack'] as const)(
    'reports the %s placeholder to stderr outside JSON mode',
    async (command) => {
      const result = await capture([command]);

      expect(result).toMatchObject({ exitCode: 70, stdout: '' });
      expect(result.stderr).not.toBe('');
    },
  );

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
