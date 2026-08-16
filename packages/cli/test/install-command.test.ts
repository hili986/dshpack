import { resolve } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as installModule from '../src/commands/install.js';
import type { InstallReport, InstallRuntime } from '../src/install/runtime-types.js';

type RegisterInstall = (
  program: Command,
  runner: (input: never, runtime: InstallRuntime) => Promise<InstallReport>,
  runtimeFactory: (
    dshHome: string,
    options?: { writeStderr?: (message: string) => void },
  ) => InstallRuntime,
  interactive?: () => boolean,
) => void;

const TEST_DSH_HOME = resolve('/temp-home');

function program(): Command {
  return new Command()
    .name('dshpack')
    .exitOverride()
    .option('--dsh-home <path>')
    .option('--no-color')
    .option('--json');
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  return { stdout, stderr };
}

function register(): RegisterInstall {
  expect('registerInstallCommand' in installModule).toBe(true);
  return (installModule as unknown as { registerInstallCommand: RegisterInstall })
    .registerInstallCommand;
}

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('install command registration', () => {
  it('forwards every independent authorization and a flag-like SOURCE exactly', async () => {
    const io = capture();
    const runtime = {} as InstallRuntime;
    const runtimeFactory = vi.fn(() => runtime);
    const runner = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: { status: 'planned' as const, profile: 'demo' },
    }));
    const cli = program();
    register()(cli, runner as never, runtimeFactory, () => false);
    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      'install',
      '--as',
      'demo',
      '--replace',
      '--frozen',
      '--dry-run',
      '--allow-build',
      'direct-package',
      '--allow-build',
      '@scope/transitive',
      '--allow-unverified',
      '--allow-version-mismatch',
      '--allow-danger-full-access',
      '--force',
      '--yes',
      '--',
      '--bad;Write-Output PWNED',
    ]);

    expect(runtimeFactory).toHaveBeenCalledWith(
      TEST_DSH_HOME,
      expect.objectContaining({ writeStderr: expect.any(Function) }),
    );
    expect(runner).toHaveBeenCalledWith(
      {
        source: '--bad;Write-Output PWNED',
        dshHome: TEST_DSH_HOME,
        interactive: false,
        json: false,
        as: 'demo',
        replace: true,
        frozen: true,
        dryRun: true,
        force: true,
        yes: true,
        allowBuilds: ['direct-package', '@scope/transitive'],
        allowUnverified: true,
        allowVersionMismatch: true,
        allowDangerFullAccess: true,
      },
      runtime,
    );
    expect(io.stdout).toEqual([]);
  });

  it('emits exactly one JSON object and never appends human output', async () => {
    const io = capture();
    const runner = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: { status: 'installed' as const, profile: 'demo' },
    }));
    const cli = program();
    register()(
      cli,
      runner as never,
      () => ({}) as InstallRuntime,
      () => true,
    );
    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      '--json',
      'install',
      'fixture',
    ]);

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({ interactive: false, json: true }),
      expect.anything(),
    );
    expect(io.stdout).toHaveLength(1);
    expect(JSON.parse(io.stdout[0] ?? '{}')).toEqual({
      diagnostics: [],
      status: 'installed',
      profile: 'demo',
    });
  });

  it('prints launch, effect timing, and audit commands only after a human success', async () => {
    const io = capture();
    const runner = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: {
        status: 'installed' as const,
        profile: 'safe-profile',
        plan: { requiredDangerousPermissions: ['danger-full-access'] },
      },
    }));
    const cli = program();
    register()(
      cli,
      runner as never,
      () => ({}) as InstallRuntime,
      () => false,
    );
    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      'install',
      'fixture',
      '--yes',
    ]);

    const output = io.stdout.join('');
    expect(output).toContain('dsh --profile safe-profile');
    expect(output).toContain('restart');
    expect(output).toContain('new session');
    expect(output).toContain('dshpack --dsh-home');
    expect(output).toContain('doctor --profile safe-profile');
    expect(output).toContain('--strict');
    expect(output).toContain('dsh --profile safe-profile --dump-config');
    expect(output).toContain('dsh plugin --profile safe-profile list --depth=0');
    expect(output).toContain('danger-full-access');
    expect(output).toContain('不会自动生效或写入 settings');
  });

  it('keeps the dangerous review visible but strips ANSI under --no-color', async () => {
    const io = capture();
    const runner = vi.fn(async (_input, runtime: InstallRuntime) => {
      runtime.writeStderr('\u001b[31m[危险 permission] danger-full-access\u001b[0m');
      return {
        diagnostics: [],
        exitCode: 0 as const,
        metadata: { status: 'planned' as const, profile: 'demo' },
      };
    });
    const cli = program();
    register()(
      cli,
      runner as never,
      (_home, options) => ({ writeStderr: options?.writeStderr }) as InstallRuntime,
      () => false,
    );
    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      '--no-color',
      'install',
      'fixture',
      '--dry-run',
    ]);
    expect(io.stderr.join('')).toContain('[危险 permission] danger-full-access');
    expect(io.stderr.join('')).not.toContain('\u001b');
  });

  it('preserves ANSI by default and derives interaction from stdin plus stderr TTY', async () => {
    const io = capture();
    const stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stderr = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    const observed: boolean[] = [];
    try {
      for (const [stdinTty, stderrTty] of [
        [false, false],
        [true, false],
        [true, true],
      ] as const) {
        Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTty });
        Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: stderrTty });
        const cli = program();
        register()(
          cli,
          async (input, runtime) => {
            observed.push((input as unknown as { interactive: boolean }).interactive);
            runtime.writeStderr('\u001b[31mdanger\u001b[0m');
            return {
              diagnostics: [],
              exitCode: 0,
              metadata: { status: 'planned', profile: 'demo' },
            };
          },
          (_home, options) => ({ writeStderr: options?.writeStderr }) as InstallRuntime,
        );
        await cli.parseAsync([
          'node',
          'dshpack',
          '--dsh-home',
          TEST_DSH_HOME,
          'install',
          'fixture',
        ]);
      }
    } finally {
      if (stdin === undefined) Reflect.deleteProperty(process.stdin, 'isTTY');
      else Object.defineProperty(process.stdin, 'isTTY', stdin);
      if (stderr === undefined) Reflect.deleteProperty(process.stderr, 'isTTY');
      else Object.defineProperty(process.stderr, 'isTTY', stderr);
    }
    expect(observed).toEqual([false, false, true]);
    expect(io.stderr.join('')).toContain('\u001b[31mdanger\u001b[0m');
  });

  it('gates an unsafe DSH_HOME before runtime creation', async () => {
    const io = capture();
    const runtimeFactory = vi.fn();
    const runner = vi.fn();
    const cli = program();
    register()(cli, runner, runtimeFactory, () => false);
    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      `C:/unsafe\u0001secret`,
      'install',
      'fixture',
    ]);
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(io.stderr.join('')).toContain('E_PATH_DSH_HOME');
    expect(io.stderr.join('')).not.toContain('secret');
  });

  it.each([
    { exitCode: 20 as const, status: 'not-started' as const, profile: 'demo' },
    { exitCode: 0 as const, status: 'installed' as const },
  ])('never prints a success footer for a non-success report %#', async (metadata) => {
    const io = capture();
    const cli = program();
    register()(
      cli,
      async () => ({
        diagnostics: [],
        exitCode: metadata.exitCode,
        metadata,
      }),
      () => ({}) as InstallRuntime,
      () => false,
    );
    await cli.parseAsync(['node', 'dshpack', '--dsh-home', TEST_DSH_HOME, 'install', 'fixture']);
    expect(io.stdout).toEqual([]);
  });
});
