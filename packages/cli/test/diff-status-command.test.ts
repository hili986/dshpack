import { resolve } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerDiffCommand } from '../src/commands/diff.js';
import { registerStatusCommand } from '../src/commands/status.js';
import type { DiffReport, DiffRuntime } from '../src/diff/engine.js';
import type { StatusReport } from '../src/status/engine.js';

const HOME = resolve('/diff-status-command-home');

function program(): Command {
  return new Command().name('dshpack').exitOverride().option('--dsh-home <path>').option('--json');
}

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('diff command', () => {
  it('forwards --to and --effective without granting update authorization flags', async () => {
    const run = vi.fn(
      async () =>
        ({
          diagnostics: [],
          exitCode: 0,
          metadata: {
            profile: 'demo',
            pack: { name: 'demo', version: '1.0.0' },
            localDrift: [],
            upstreamDelta: [],
            effectiveMismatch: [],
            assetDigests: [],
          },
        }) satisfies DiffReport,
    );
    const runtime = {} as DiffRuntime;
    const factory = vi.fn(() => runtime);
    const cli = program();
    registerDiffCommand(cli, run, factory);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--json',
      '--dsh-home',
      HOME,
      'diff',
      'demo',
      '--to',
      'source-dir',
      '--effective',
    ]);

    expect(run).toHaveBeenCalledWith(
      { dshHome: HOME, profile: 'demo', to: 'source-dir', effective: true },
      runtime,
    );
    expect(factory).toHaveBeenCalledWith(HOME);
  });

  it('declares the effective write in Chinese help and output', async () => {
    const cli = program();
    const output: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    registerDiffCommand(
      cli,
      async () => ({
        diagnostics: [
          {
            code: 'I_DIFF_EFFECTIVE_WRITE',
            severity: 'info',
            message: '该选项会写入 profile/cordis.yml。',
            hint: '唯一声明的 dsh 生效层写入。',
            evidence: 'local',
          },
        ],
        exitCode: 0,
        metadata: {
          profile: 'demo',
          pack: { name: 'demo', version: '1.0.0' },
          localDrift: [],
          upstreamDelta: [],
          effectiveMismatch: [],
          assetDigests: [],
          sideEffects: [{ owner: 'dsh', path: 'profile/cordis.yml' }],
        },
      }),
      () => ({}) as DiffRuntime,
    );
    const command = cli.commands.find((item) => item.name() === 'diff');
    expect(command?.helpInformation()).toContain('写入 profile/cordis.yml');
    await cli.parseAsync(['node', 'dshpack', '--dsh-home', HOME, 'diff', 'demo', '--effective']);
    expect(output.join('')).toContain('profile/cordis.yml');
  });

  it('renders every diff category for humans and rejects a missing home before runtime creation', async () => {
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const run = vi.fn(
      async () =>
        ({
          diagnostics: [],
          exitCode: 0,
          metadata: {
            profile: 'demo\u001b',
            pack: { name: 'demo', version: '1.0.0' },
            localDrift: [
              {
                kind: 'skill' as const,
                id: 'notes',
                target: 'skills/notes',
                mergeAction: 'conflict' as const,
                base: 'present' as const,
                current: 'present' as const,
                targetState: 'present' as const,
              },
            ],
            upstreamDelta: [],
            effectiveMismatch: [
              {
                source: 'profile/cordis.patch.yml',
                effective: 'profile/cordis.yml',
                sourceSha256: 'sha256-source',
                effectiveSha256: 'sha256-effective',
              },
            ],
            assetDigests: [],
          },
        }) satisfies DiffReport,
    );
    const factory = vi.fn(() => ({}) as DiffRuntime);
    const cli = program();
    registerDiffCommand(cli, run, factory);
    await cli.parseAsync(['node', 'dshpack', '--dsh-home', HOME, 'diff', 'demo']);
    const text = stdout.join('');
    expect(text).toContain('local-drift: 1');
    expect(text).toContain('effective-mismatch: 1');
    expect(text).toContain('\\u001b');
    await cli.parseAsync(['node', 'dshpack', 'diff', 'demo']);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('status command', () => {
  it('defaults to offline and forwards --check-updates only when present', async () => {
    const run = vi.fn(
      async () =>
        ({
          diagnostics: [],
          exitCode: 0,
          metadata: { profiles: [], checkUpdates: false },
        }) satisfies StatusReport,
    );
    const factory = vi.fn(() => ({}) as DiffRuntime);
    const cli = program();
    registerStatusCommand(cli, run, factory);
    await cli.parseAsync(['node', 'dshpack', '--dsh-home', HOME, 'status']);
    expect(run).toHaveBeenLastCalledWith({ dshHome: HOME, checkUpdates: false }, expect.anything());
    await cli.parseAsync(['node', 'dshpack', '--dsh-home', HOME, 'status', '--check-updates']);
    expect(run).toHaveBeenLastCalledWith({ dshHome: HOME, checkUpdates: true }, expect.anything());
    expect(cli.commands.find((item) => item.name() === 'status')?.helpInformation()).toContain(
      '联网',
    );
  });

  it('renders tracked and degraded profiles for humans', async () => {
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const cli = program();
    registerStatusCommand(
      cli,
      async () => ({
        diagnostics: [],
        exitCode: 0,
        metadata: {
          checkUpdates: false,
          profiles: [
            {
              profile: 'demo',
              status: 'tracked',
              pack: { name: 'demo', version: '1.0.0' },
              generation: 2,
              drift: 1,
              sharedAssets: 3,
              update: 'not-checked',
            },
            { profile: 'web', status: 'reserved', reason: 'dsh 保留 profile' },
            { profile: 'legacy', status: 'untracked' },
          ],
        },
      }),
      () => ({}) as DiffRuntime,
    );
    await cli.parseAsync(['node', 'dshpack', '--dsh-home', HOME, 'status']);
    expect(stdout.join('')).toContain('seq=2');
    expect(stdout.join('')).toContain('reserved');
  });

  it('keeps JSON to one object and does not build a runtime without DSH_HOME', async () => {
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const run = vi.fn(
      async () =>
        ({
          diagnostics: [],
          exitCode: 0,
          metadata: { profiles: [], checkUpdates: false },
        }) satisfies StatusReport,
    );
    const factory = vi.fn(() => ({}) as DiffRuntime);
    const cli = program();
    registerStatusCommand(cli, run, factory);
    await cli.parseAsync(['node', 'dshpack', '--json', '--dsh-home', HOME, 'status']);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] ?? '{}')).toMatchObject({ profiles: [], checkUpdates: false });
    vi.stubEnv('DSH_HOME', '');
    await cli.parseAsync(['node', 'dshpack', 'status']);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
