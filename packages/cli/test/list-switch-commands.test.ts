import { resolve } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerListCommand } from '../src/commands/list.js';
import { registerSwitchCommand } from '../src/commands/switch.js';

const TEST_DSH_HOME = resolve('/temp-home');

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

describe('list command registration', () => {
  it('gates an unsafe global DSH_HOME into one redacted JSON object before calling the runner', async () => {
    const io = capture();
    const run = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: { profiles: [] },
    }));
    const cli = program();
    registerListCommand(cli, run);
    const unsafe = `${resolve('missing-home')}\u0001secret`;
    await cli.parseAsync(['node', 'dshpack', '--dsh-home', unsafe, '--json', 'list']);

    expect(run).not.toHaveBeenCalled();
    expect(io.stdout).toHaveLength(1);
    expect(JSON.parse(io.stdout[0] ?? '{}')).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'E_PATH_DSH_HOME' })],
    });
    expect(io.stdout[0]).not.toContain('secret');
  });

  it('writes exactly one JSON object and forwards the global DSH_HOME', async () => {
    const io = capture();
    const run = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: {
        profiles: [
          {
            profile: 'demo',
            status: 'tracked' as const,
            pack: { name: 'demo-pack', version: '1.0.0' },
            installedAt: '2026-08-16T00:00:00.000Z',
          },
        ],
      },
    }));
    const cli = program();
    registerListCommand(cli, run);
    await cli.parseAsync(['node', 'dshpack', '--dsh-home', TEST_DSH_HOME, 'list', '--json']);

    expect(run).toHaveBeenCalledWith({ dshHome: TEST_DSH_HOME });
    expect(io.stdout).toEqual([
      '{"diagnostics":[],"profiles":[{"profile":"demo","status":"tracked","pack":{"name":"demo-pack","version":"1.0.0"},"installedAt":"2026-08-16T00:00:00.000Z"}]}\n',
    ]);
    expect(io.stderr).toEqual([]);
  });

  it('renders tracked, untracked, reserved, broken, and empty human reports', async () => {
    const io = capture();
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        diagnostics: [],
        exitCode: 0,
        metadata: {
          profiles: [
            {
              profile: 'alpha',
              status: 'tracked',
              pack: { name: 'alpha-pack', version: '1.0.0' },
              installedAt: '2026-08-16T00:00:00.000Z',
            },
            { profile: 'beta', status: 'untracked' },
            { profile: 'gamma', status: 'broken', reason: 'bad marker' },
            { profile: 'web', status: 'reserved', reason: 'dsh 保留 profile，dshpack 不接管。' },
          ],
        },
      })
      .mockResolvedValueOnce({ diagnostics: [], exitCode: 0, metadata: { profiles: [] } });
    const first = program();
    registerListCommand(first, run);
    await first.parseAsync(['node', 'dshpack', '--dsh-home', TEST_DSH_HOME, 'list']);
    const second = program();
    registerListCommand(second, run);
    await second.parseAsync(['node', 'dshpack', '--dsh-home', TEST_DSH_HOME, 'list']);

    expect(io.stdout.join('')).toContain('alpha  tracked  alpha-pack@1.0.0');
    expect(io.stdout.join('')).toContain('beta  untracked');
    expect(io.stdout.join('')).toContain('gamma  broken  bad marker');
    // A reserved profile must not read as damaged: the word broken is the whole bug.
    expect(io.stdout.join('')).toContain('web  reserved  dsh 保留 profile，dshpack 不接管。');
    expect(io.stdout.join('')).not.toContain('web  broken');
    expect(io.stdout.join('')).toContain('未发现 profile。');
  });
});

describe('switch command registration', () => {
  it('gates an unsafe DSH_HOME from child --json without calling the runner', async () => {
    const io = capture();
    const run = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: {
        profile: 'demo',
        command: 'dsh --profile demo',
        ran: false,
        settingsChanged: false,
      },
    }));
    const cli = program();
    registerSwitchCommand(cli, run);
    const unsafe = `${resolve('missing-home')}\u0001secret`;
    await cli.parseAsync(['node', 'dshpack', '--dsh-home', unsafe, 'switch', 'demo', '--json']);

    expect(run).not.toHaveBeenCalled();
    expect(io.stdout).toHaveLength(1);
    expect(JSON.parse(io.stdout[0] ?? '{}')).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'E_PATH_DSH_HOME' })],
    });
    expect(io.stdout[0]).not.toContain('secret');
  });

  it('prints only the exact command for the conservative default', async () => {
    const io = capture();
    const run = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: {
        profile: 'demo',
        command: 'dsh --profile demo',
        ran: false,
        settingsChanged: false,
      },
    }));
    const cli = program();
    registerSwitchCommand(cli, run);
    await cli.parseAsync(['node', 'dshpack', '--dsh-home', TEST_DSH_HOME, 'switch', 'demo']);
    expect(run).toHaveBeenCalledWith({
      dshHome: TEST_DSH_HOME,
      json: false,
      profile: 'demo',
      run: false,
      setDefaultPreset: false,
      yes: false,
    });
    expect(io.stdout).toEqual(['dsh --profile demo\n']);
    expect(io.stderr).toEqual([]);
  });

  it('keeps JSON to one object and does not append a launch command', async () => {
    const io = capture();
    const run = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: {
        profile: 'demo',
        command: 'dsh --profile demo',
        ran: false,
        settingsChanged: true,
        effect: 'new-session' as const,
      },
    }));
    const cli = program();
    registerSwitchCommand(cli, run);
    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      '--json',
      'switch',
      'demo',
      '--set-default-preset',
      '--yes',
    ]);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ json: true, setDefaultPreset: true, yes: true }),
    );
    expect(io.stdout).toHaveLength(1);
    expect(JSON.parse(io.stdout[0] ?? '{}')).toMatchObject({
      profile: 'demo',
      settingsChanged: true,
    });
  });

  it('does not print a synthetic command after --run or after failure', async () => {
    const io = capture();
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        diagnostics: [],
        exitCode: 0,
        metadata: {
          profile: 'demo',
          command: 'dsh --profile demo',
          ran: true,
          settingsChanged: false,
        },
      })
      .mockResolvedValueOnce({
        diagnostics: [
          {
            code: 'E_SWITCH_PROFILE',
            severity: 'error',
            message: 'missing',
            hint: 'fix',
            evidence: 'local',
          },
        ],
        exitCode: 30,
        metadata: {
          profile: 'missing',
          command: 'dsh --profile missing',
          ran: false,
          settingsChanged: false,
        },
      });
    const first = program();
    registerSwitchCommand(first, run);
    await first.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      'switch',
      'demo',
      '--run',
    ]);
    const second = program();
    registerSwitchCommand(second, run);
    await second.parseAsync(['node', 'dshpack', '--dsh-home', TEST_DSH_HOME, 'switch', 'missing']);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.join('')).toContain('E_SWITCH_PROFILE');
  });
});
