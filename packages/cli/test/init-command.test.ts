import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerInitCommand } from '../src/commands/init.js';
import { EXIT_CODES } from '../src/exit-codes.js';

async function capture(
  program: Command,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
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
  await program.parseAsync(['node', 'dshpack', ...args]);
  return { stdout, stderr };
}

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('init command', () => {
  it('never prompts outside a TTY and gives a complete copyable --yes command', async () => {
    const program = new Command().option('--json');
    const run = vi.fn();
    registerInitCommand(program, run, vi.fn(), () => false);

    const result = await capture(program, ['init', 'starter']);

    expect(process.exitCode).toBe(EXIT_CODES.USER_DECLINED);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('E_INIT_REQUIRED');
    expect(result.stderr).toContain('dshpack init "starter"');
    expect(result.stderr).toContain('--name "my-pack"');
    expect(result.stderr).toContain('--version "0.1.0"');
    expect(result.stderr).toContain('--description "Describe this pack"');
    expect(result.stderr).toContain('--author "Your Name"');
    expect(result.stderr).toContain('--license "MIT"');
    expect(result.stderr).toContain('--template minimal --yes');
    expect(run).not.toHaveBeenCalled();
  });

  it('passes complete --yes input to the init engine', async () => {
    const program = new Command().option('--json');
    const run = vi.fn().mockResolvedValue({
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { directory: 'starter', files: ['pack.yml'], template: 'full' },
    });
    registerInitCommand(program, run, vi.fn(), () => false);

    await capture(program, [
      'init',
      'starter',
      '--name',
      'starter-pack',
      '--description',
      'Starter description',
      '--author',
      'Test Author',
      '--license',
      'MIT',
      '--template',
      'full',
      '--yes',
    ]);

    expect(run).toHaveBeenCalledWith({
      directory: 'starter',
      name: 'starter-pack',
      version: '0.1.0',
      description: 'Starter description',
      author: 'Test Author',
      license: 'MIT',
      template: 'full',
    });
  });

  it('rejects explicitly empty required values and handles invalid DSH_HOME for profile export', async () => {
    const program = new Command().option('--json').option('--dsh-home <path>');
    const run = vi.fn();
    registerInitCommand(program, run, vi.fn(), () => false);
    const result = await capture(program, [
      'init',
      'starter',
      '--name',
      'starter-pack',
      '--description',
      '',
      '--author',
      'Test Author',
      '--license',
      'MIT',
      '--yes',
    ]);
    expect(process.exitCode).toBe(EXIT_CODES.USER_DECLINED);
    expect(result.stderr).toContain('description');

    const invalid = new Command().option('--json').option('--dsh-home <path>');
    registerInitCommand(invalid, vi.fn(), vi.fn(), () => false);
    const invalidResult = await capture(invalid, [
      '--dsh-home',
      'relative-home',
      'init',
      'starter',
      '--from-profile',
      'research',
    ]);
    expect(process.exitCode).toBe(EXIT_CODES.SECURITY);
    expect(invalidResult.stderr).toContain('E_PATH_DSH_HOME');
  });

  it('delegates --from-profile to export rather than reimplementing it', async () => {
    const program = new Command().option('--json').option('--dsh-home <path>');
    const run = vi.fn();
    const exported = vi.fn().mockResolvedValue({
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { output: 'profile-pack', profile: 'research' },
    });
    registerInitCommand(program, run, exported, () => false);

    await capture(program, [
      '--dsh-home',
      process.cwd(),
      'init',
      'profile-pack',
      '--from-profile',
      'research',
      '--yes',
    ]);

    expect(exported).toHaveBeenCalledWith({
      dshHome: process.cwd(),
      output: 'profile-pack',
      profile: 'research',
      yes: true,
    });
    expect(run).not.toHaveBeenCalled();
  });
});
