import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerGcCommand } from '../src/commands/gc.js';

const TEST_DSH_HOME = resolve('/gc-command-home');
const roots: string[] = [];

async function gcHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-gc-command-'));
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

afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('gc command registration', () => {
  it('forwards keep and dry-run and emits exactly one JSON object', async () => {
    const io = capture();
    const run = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: {
        dryRun: true,
        keep: 3,
        deletedGenerations: ['.dshpack/generations/demo/0001.json'],
        deletedBlocks: [],
        pendingPurge: false,
        manualRecovery: [],
      },
    }));
    const cli = program();
    registerGcCommand(cli, run);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      '--json',
      'gc',
      '--keep',
      '3',
      '--dry-run',
    ]);

    expect(run).toHaveBeenCalledWith({ dshHome: TEST_DSH_HOME, keep: '3', dryRun: true });
    expect(io.stderr).toEqual([]);
    expect(io.stdout).toHaveLength(1);
    expect(JSON.parse(io.stdout[0] ?? '{}')).toMatchObject({
      diagnostics: [],
      dryRun: true,
      keep: 3,
    });
  });

  it('rejects an unsafe home before calling the GC runner', async () => {
    const io = capture();
    const run = vi.fn();
    const cli = program();
    registerGcCommand(cli, run);

    await cli.parseAsync(['node', 'dshpack', '--dsh-home', 'relative', '--json', 'gc']);

    expect(run).not.toHaveBeenCalled();
    expect(io.stdout).toHaveLength(1);
    expect(JSON.parse(io.stdout[0] ?? '{}')).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'E_PATH_DSH_HOME' })],
    });
  });

  it('honors child JSON and omits an unspecified keep option', async () => {
    const io = capture();
    const run = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: {
        dryRun: false,
        keep: 10,
        deletedGenerations: [],
        deletedBlocks: [],
        pendingPurge: false,
        manualRecovery: [],
      },
    }));
    const cli = program();
    registerGcCommand(cli, run);

    await cli.parseAsync(['node', 'dshpack', '--dsh-home', TEST_DSH_HOME, 'gc', '--json']);

    expect(run).toHaveBeenCalledWith({ dshHome: TEST_DSH_HOME, dryRun: false });
    expect(io.stderr).toEqual([]);
    expect(io.stdout).toHaveLength(1);
  });

  it('returns one contract JSON report for an invalid keep value without prompting', async () => {
    const io = capture();
    const cli = program();
    registerGcCommand(cli);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      await gcHome(),
      '--json',
      'gc',
      '--keep',
      '1.5',
      '--dry-run',
    ]);

    expect(io.stderr).toEqual([]);
    expect(io.stdout).toHaveLength(1);
    expect(JSON.parse(io.stdout[0] ?? '{}')).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'E_GC_KEEP' })],
      dryRun: true,
    });
    expect(process.exitCode).toBe(30);
  });

  it('runs the default engine with a valid concrete keep value in dry-run mode', async () => {
    const io = capture();
    const cli = program();
    registerGcCommand(cli);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      await gcHome(),
      '--json',
      'gc',
      '--keep',
      '0',
      '--dry-run',
    ]);

    expect(io.stderr).toEqual([]);
    expect(io.stdout).toHaveLength(1);
    expect(JSON.parse(io.stdout[0] ?? '{}')).toMatchObject({ keep: 0, dryRun: true });
    expect(process.exitCode).toBe(0);
  });

  it('lets the default engine supply its keep default when the option is absent', async () => {
    const io = capture();
    const cli = program();
    registerGcCommand(cli);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      await gcHome(),
      '--json',
      'gc',
      '--dry-run',
    ]);

    expect(io.stderr).toEqual([]);
    expect(io.stdout).toHaveLength(1);
    expect(JSON.parse(io.stdout[0] ?? '{}')).toMatchObject({ keep: 10, dryRun: true });
    expect(process.exitCode).toBe(0);
  });

  it('uses non-JSON diagnostic output without a prompt', async () => {
    const io = capture();
    const run = vi.fn(async () => ({
      diagnostics: [
        {
          code: 'E_GC_TEST',
          severity: 'error' as const,
          message: 'test collection failure',
          hint: 'test only',
          evidence: 'local' as const,
        },
      ],
      exitCode: 30 as const,
      metadata: {
        dryRun: false,
        keep: 10,
        deletedGenerations: [],
        deletedBlocks: [],
        pendingPurge: false,
        manualRecovery: [],
      },
    }));
    const cli = program();
    registerGcCommand(cli, run);

    await cli.parseAsync(['node', 'dshpack', '--dsh-home', TEST_DSH_HOME, 'gc']);

    expect(run).toHaveBeenCalledWith({ dshHome: TEST_DSH_HOME, dryRun: false });
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toHaveLength(2);
    expect(io.stderr.join('')).toContain('E_GC_TEST');
    expect(process.exitCode).toBe(30);
  });
});
