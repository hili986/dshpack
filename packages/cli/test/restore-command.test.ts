import { resolve } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/cli.js';
import { displayRestorePlan, registerRestoreCommand } from '../src/commands/restore.js';

const TEST_DSH_HOME = resolve('restore-command-home');

function program(): Command {
  return new Command().name('dshpack').exitOverride().option('--dsh-home <path>').option('--json');
}

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('restore command registration', () => {
  it('renders a retained-generation inventory when no target was selected', () => {
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });

    displayRestorePlan({
      profile: 'demo-pack',
      dryRun: false,
      generations: [
        {
          seq: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          operation: 'install',
          packVersion: '1.0.0',
          restorable: true,
        },
      ],
      assets: [],
      retainedSettings: [],
      manualRecovery: [],
    });

    expect(stdout.join('')).toContain('Retained generations for demo-pack:');
    expect(stdout.join('')).not.toContain('Dry run:');
  });

  it('escapes control characters from persisted metadata in human output', () => {
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });

    displayRestorePlan({
      profile: 'demo\u001b[2J',
      dryRun: true,
      targetGeneration: 2,
      generations: [],
      assets: [
        {
          target: 'skills/notes\u001b[2J',
          action: 'retain',
          reason: 'modified',
        },
      ],
      retainedSettings: ['user\u202Evalue'],
      manualRecovery: [],
    });

    const output = stdout.join('');
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('\u202e');
    expect(output).toContain('demo\\u001b[2J');
    expect(output).toContain('skills/notes\\u001b[2J');
    expect(output).toContain('user\\u202evalue');
  });

  it('renders a non-JSON generation and asset plan without serializing raw settings values', async () => {
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const run = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: {
        profile: 'demo-pack',
        dryRun: true,
        targetGeneration: 2,
        generations: [
          {
            seq: 2,
            createdAt: '2026-01-01T00:00:00.000Z',
            operation: 'uninstall' as const,
            packVersion: '1.0.0',
            restorable: true,
          },
        ],
        assets: [
          { target: 'skills/notes', action: 'retain' as const, reason: 'modified' as const },
        ],
        retainedSettings: ['user-edit'],
        manualRecovery: [],
      },
    }));
    const cli = program();
    registerRestoreCommand(cli, run);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      'restore',
      'demo-pack',
      '--dry-run',
    ]);

    const output = stdout.join('');
    expect(output).toContain('Restore plan for demo-pack to generation 2');
    expect(output).toContain('retain skills/notes (modified)');
    expect(output).toContain('retain settings agent-presets.user-edit');
    expect(output).not.toContain('canonicalValue');
  });

  it('forwards generation selection, review, and destructive-override flags', async () => {
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const run = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: {
        profile: 'demo-pack',
        dryRun: true,
        targetGeneration: 2,
        generations: [],
        assets: [],
        retainedSettings: [],
        manualRecovery: [],
      },
    }));
    const cli = program();
    registerRestoreCommand(cli, run);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      '--json',
      'restore',
      'demo-pack',
      '--to',
      '2',
      '--dry-run',
      '--force',
      '--yes',
    ]);

    expect(run).toHaveBeenCalledWith({
      dshHome: TEST_DSH_HOME,
      profile: 'demo-pack',
      to: 2,
      list: false,
      dryRun: true,
      force: true,
      yes: true,
    });
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] ?? '{}')).toMatchObject({ targetGeneration: 2, dryRun: true });
  });

  it.each(['0', '-1', 'not-a-number', '9007199254740992'])(
    'rejects an invalid --to sequence before calling the restore engine: %s',
    async (sequence) => {
      const run = vi.fn();
      const cli = program();
      registerRestoreCommand(cli, run);

      await expect(
        cli.parseAsync([
          'node',
          'dshpack',
          '--dsh-home',
          TEST_DSH_HOME,
          'restore',
          'demo-pack',
          '--to',
          sequence,
        ]),
      ).rejects.toThrow(/positive integer|safe positive integer/u);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it('maps invalid --to through the real JSON CLI boundary as usage, not an internal error', async () => {
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

    await runCli([
      'node',
      'dshpack',
      '--json',
      '--dsh-home',
      TEST_DSH_HOME,
      'restore',
      'demo-pack',
      '--to',
      'not-a-number',
    ]);

    expect(process.exitCode).toBe(2);
    expect(stderr).toBe('');
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(stdout)).toEqual({
      diagnostics: [expect.objectContaining({ code: 'E_USAGE', severity: 'error' })],
    });
  });

  it('does not invoke restore when --dsh-home fails boundary validation', async () => {
    const run = vi.fn();
    const cli = program();
    registerRestoreCommand(cli, run);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      'relative',
      '--json',
      'restore',
      'demo',
    ]);

    expect(run).not.toHaveBeenCalled();
  });
});
