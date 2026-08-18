import { resolve } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as updateModule from '../src/commands/update.js';
import type { UpdateInput, UpdateReport, UpdateRuntime } from '../src/update/engine.js';

type RegisterUpdate = (
  program: Command,
  runner: (input: UpdateInput, runtime: UpdateRuntime) => Promise<UpdateReport>,
  runtimeFactory: (dshHome: string) => UpdateRuntime,
  interactive?: () => boolean,
) => void;

const TEST_DSH_HOME = resolve('/update-command-home');

function program(): Command {
  return new Command().name('dshpack').exitOverride().option('--dsh-home <path>').option('--json');
}

function capture() {
  const stdout: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  return { stdout };
}

function captureStderr() {
  const stderr: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  return { stderr };
}

function register(): RegisterUpdate {
  expect('registerUpdateCommand' in updateModule).toBe(true);
  return (updateModule as unknown as { registerUpdateCommand: RegisterUpdate })
    .registerUpdateCommand;
}

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('update command registration', () => {
  it('forwards all update flags and repeated collection options', async () => {
    const runtime = {} as UpdateRuntime;
    const runner = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: { profile: 'demo-pack', status: 'preflight' as const },
    }));
    const runtimeFactory = vi.fn(() => runtime);
    const cli = program();
    register()(cli, runner, runtimeFactory, () => false);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      'update',
      'demo-pack',
      '--to',
      '--source-like-data',
      '--dry-run',
      '--ours',
      '--only',
      'skill:notes',
      '--only',
      'setting:agent-presets.custom',
      '--allow-build',
      'direct-package',
      '--allow-build',
      '@scope/other',
      '--allow-unverified',
      '--allow-version-mismatch',
      '--allow-danger-full-access',
      '--yes',
    ]);

    expect(runtimeFactory).toHaveBeenCalledWith(TEST_DSH_HOME);
    expect(runner).toHaveBeenCalledWith(
      {
        dshHome: TEST_DSH_HOME,
        profile: 'demo-pack',
        to: '--source-like-data',
        dryRun: true,
        ours: true,
        theirs: false,
        only: ['skill:notes', 'setting:agent-presets.custom'],
        allowBuilds: ['direct-package', '@scope/other'],
        allowUnverified: true,
        allowVersionMismatch: true,
        allowDangerFullAccess: true,
        yes: true,
        interactive: false,
        json: false,
      },
      runtime,
    );
  });

  it('keeps JSON output to exactly one object and forces non-interactive mode', async () => {
    const io = capture();
    const cli = program();
    register()(
      cli,
      async () => ({
        diagnostics: [],
        exitCode: 0,
        metadata: { profile: 'demo-pack', status: 'preflight' },
      }),
      () => ({}) as UpdateRuntime,
      () => true,
    );

    await cli.parseAsync([
      'node',
      'dshpack',
      '--json',
      '--dsh-home',
      TEST_DSH_HOME,
      'update',
      'demo-pack',
      '--dry-run',
    ]);

    expect(io.stdout).toHaveLength(1);
    expect(JSON.parse(io.stdout[0] ?? '{}')).toEqual({
      diagnostics: [],
      profile: 'demo-pack',
      status: 'preflight',
    });
  });

  it('renders dry-run review diagnostics for humans while JSON remains one object', async () => {
    const human = captureStderr();
    const cli = program();
    const report: UpdateReport = {
      diagnostics: [
        {
          code: 'I_UPDATE_SOURCE',
          severity: 'info',
          message: 'resolved validated local directory',
          hint: 'no write',
          evidence: 'local',
        },
        {
          code: 'I_UPDATE_INTEGRITY',
          severity: 'info',
          message: 'resolved plugin integrity summary: npm-sri',
          hint: 'no raw identity',
          evidence: 'local',
        },
      ],
      exitCode: 0,
      metadata: { profile: 'demo-pack', status: 'preflight' },
    };
    register()(
      cli,
      async () => report,
      () => ({}) as UpdateRuntime,
      () => false,
    );

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      'update',
      'demo-pack',
      '--dry-run',
    ]);

    expect(human.stderr.join('')).toContain('I_UPDATE_SOURCE');
    expect(human.stderr.join('')).toContain('I_UPDATE_INTEGRITY');
  });

  it('reports a missing DSH home before creating an update runtime', async () => {
    vi.stubEnv('DSH_HOME', '');
    const human = captureStderr();
    const runner = vi.fn();
    const factory = vi.fn(() => ({}) as UpdateRuntime);
    const cli = program();
    register()(cli, runner, factory, () => false);

    await cli.parseAsync(['node', 'dshpack', 'update', 'demo-pack']);

    expect(human.stderr.join('')).toContain('E_DSH_HOME_REQUIRED');
    expect(factory).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it('uses the default terminal detector when both process streams are interactive', async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stderrDescriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
    try {
      const runner = vi.fn(async () => ({
        diagnostics: [],
        exitCode: 0 as const,
        metadata: { profile: 'demo-pack', status: 'preflight' as const },
      }));
      const cli = program();
      register()(cli, runner, () => ({}) as UpdateRuntime);

      await cli.parseAsync(['node', 'dshpack', '--dsh-home', TEST_DSH_HOME, 'update', 'demo-pack']);

      expect(runner).toHaveBeenCalledWith(
        expect.objectContaining({ interactive: true }),
        expect.anything(),
      );
    } finally {
      if (stdinDescriptor === undefined) Reflect.deleteProperty(process.stdin, 'isTTY');
      else Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
      if (stderrDescriptor === undefined) Reflect.deleteProperty(process.stderr, 'isTTY');
      else Object.defineProperty(process.stderr, 'isTTY', stderrDescriptor);
    }
  });

  it('declares Chinese help and rejects mutually exclusive --ours and --theirs', async () => {
    const cli = program();
    register()(
      cli,
      async () => ({
        diagnostics: [],
        exitCode: 0,
        metadata: { profile: 'demo-pack', status: 'preflight' as const },
      }),
      () => ({}) as UpdateRuntime,
    );
    const command = cli.commands.find((item) => item.name() === 'update');

    expect(command?.helpInformation()).toContain('更新');
    expect(command?.helpInformation()).toContain('仅确认普通更新，不替代任何 --allow-* 危险授权');
    await expect(
      cli.parseAsync([
        'node',
        'dshpack',
        '--dsh-home',
        TEST_DSH_HOME,
        'update',
        'demo-pack',
        '--ours',
        '--theirs',
      ]),
    ).rejects.toThrow(/cannot be used with option/u);
  });
});
