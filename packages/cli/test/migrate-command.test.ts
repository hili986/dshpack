import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerMigrateCommand } from '../src/commands/migrate.js';
import type { InstallRuntime } from '../src/install/runtime-types.js';

const TEST_DSH_HOME = resolve('/migrate-command-home');
const roots: string[] = [];

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-migrate-command-'));
  roots.push(root);
  return root;
}

function program(): Command {
  return new Command().name('dshpack').exitOverride().option('--dsh-home <path>').option('--json');
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

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('migrate command registration', () => {
  it('forwards profile and dry-run and emits exactly one JSON object without a prompt', async () => {
    const io = capture();
    const run = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: { status: 'planned' as const, profile: 'demo' },
    }));
    const cli = program();
    const runtime = {} as InstallRuntime;
    const runtimeFactory = vi.fn(() => runtime);
    registerMigrateCommand(cli, run, runtimeFactory);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      '--json',
      'migrate',
      'demo',
      '--dry-run',
    ]);

    expect(run).toHaveBeenCalledWith(
      { dshHome: TEST_DSH_HOME, profile: 'demo', dryRun: true },
      runtime,
    );
    expect(runtimeFactory).toHaveBeenCalledWith(TEST_DSH_HOME);
    expect(io.stderr).toEqual([]);
    expect(io.stdout).toHaveLength(1);
    expect(JSON.parse(io.stdout[0] ?? '{}')).toEqual({
      diagnostics: [],
      status: 'planned',
      profile: 'demo',
    });
  });

  it('honors child JSON and resolves DSH_HOME before calling the runner', async () => {
    const io = capture();
    const run = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: { status: 'already-current' as const, profile: 'demo', generation: 1 },
    }));
    const cli = program();
    registerMigrateCommand(cli, run, () => ({}) as InstallRuntime);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      'migrate',
      'demo',
      '--json',
    ]);

    expect(run).toHaveBeenCalledWith(
      { dshHome: TEST_DSH_HOME, profile: 'demo', dryRun: false },
      expect.anything(),
    );
    expect(io.stderr).toEqual([]);
    expect(io.stdout).toHaveLength(1);
  });

  it('rejects an unsafe DSH_HOME before invoking the migration runner', async () => {
    const io = capture();
    const run = vi.fn();
    const cli = program();
    registerMigrateCommand(cli, run);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      'relative',
      '--json',
      'migrate',
      'demo',
    ]);

    expect(run).not.toHaveBeenCalled();
    expect(io.stderr).toEqual([]);
    expect(io.stdout).toHaveLength(1);
    expect(JSON.parse(io.stdout[0] ?? '{}')).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'E_PATH_DSH_HOME' })],
    });
  });

  it('runs the default non-TTY dry-run without prompting and emits one contract JSON object', async () => {
    const io = capture();
    const cli = program();
    registerMigrateCommand(cli);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      await home(),
      '--json',
      'migrate',
      'demo',
      '--dry-run',
    ]);

    expect(io.stderr).toEqual([]);
    expect(io.stdout).toHaveLength(1);
    expect(JSON.parse(io.stdout[0] ?? '{}')).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'E_NOT_TRACKED' })],
      status: 'not-started',
      profile: 'demo',
    });
    expect(process.exitCode).toBe(10);
  });
});
