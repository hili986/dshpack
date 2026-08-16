import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerListCommand } from '../src/commands/list.js';
import { registerSwitchCommand } from '../src/commands/switch.js';

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
    await cli.parseAsync(['node', 'dshpack', '--dsh-home', 'C:/temp-home', 'list', '--json']);

    expect(run).toHaveBeenCalledWith({ dshHome: 'C:/temp-home' });
    expect(io.stdout).toEqual([
      '{"diagnostics":[],"profiles":[{"profile":"demo","status":"tracked","pack":{"name":"demo-pack","version":"1.0.0"},"installedAt":"2026-08-16T00:00:00.000Z"}]}\n',
    ]);
    expect(io.stderr).toEqual([]);
  });

  it('renders tracked, untracked, broken, and empty human reports', async () => {
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
          ],
        },
      })
      .mockResolvedValueOnce({ diagnostics: [], exitCode: 0, metadata: { profiles: [] } });
    const first = program();
    registerListCommand(first, run);
    await first.parseAsync(['node', 'dshpack', 'list']);
    const second = program();
    registerListCommand(second, run);
    await second.parseAsync(['node', 'dshpack', 'list']);

    expect(io.stdout.join('')).toContain('alpha  tracked  alpha-pack@1.0.0');
    expect(io.stdout.join('')).toContain('beta  untracked');
    expect(io.stdout.join('')).toContain('gamma  broken  bad marker');
    expect(io.stdout.join('')).toContain('未发现 profile。');
  });
});

describe('switch command registration', () => {
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
    await cli.parseAsync(['node', 'dshpack', '--dsh-home', 'C:/temp-home', 'switch', 'demo']);
    expect(run).toHaveBeenCalledWith({
      dshHome: 'C:/temp-home',
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
    await first.parseAsync(['node', 'dshpack', 'switch', 'demo', '--run']);
    const second = program();
    registerSwitchCommand(second, run);
    await second.parseAsync(['node', 'dshpack', 'switch', 'missing']);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.join('')).toContain('E_SWITCH_PROFILE');
  });
});
