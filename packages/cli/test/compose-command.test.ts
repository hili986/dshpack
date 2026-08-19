import { resolve } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerComposeCommand } from '../src/commands/compose.js';
import { EXIT_CODES } from '../src/exit-codes.js';

// `resolve('/name')` is the repo's fixture convention because it is absolute on both platforms.
// A literal 'C:/isolated/dsh' is absolute on Windows and *relative* on POSIX, so it would pass
// the home validation here and fail it on Linux CI only.
const TEST_DSH_HOME = resolve('/compose-command-home');
const originalDshHome = process.env.DSH_HOME;

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  if (originalDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalDshHome;
});

describe('compose command', () => {
  it('passes the optional compose path and only command-local compose options to the engine', async () => {
    const program = new Command().option('--dsh-home <path>').option('--json');
    const run = vi.fn().mockResolvedValue({
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { directory: 'output', dryRun: false, selected: [] },
    });
    registerComposeCommand(program, run);

    await program.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      'compose',
      'custom.yml',
      '--output',
      'output',
      '--allow-unknown-license',
    ]);

    expect(run).toHaveBeenCalledWith({
      composeFile: 'custom.yml',
      output: 'output',
      allowUnknownLicense: true,
      dshHome: TEST_DSH_HOME,
    });
    expect(process.exitCode).toBe(EXIT_CODES.SUCCESS);
  });

  it.each([
    ['relative', 'relative-home'],
    ['control-character', `${resolve('/home')}secret`],
  ])('refuses a %s DSH_HOME before the engine can touch the filesystem', async (_kind, home) => {
    // Every other command routes the home through `resolveDshHome` at the command layer. compose
    // passed it straight through, so `--dsh-home relative-home` reached the filesystem and came
    // back as a contract error naming `relative-home/profiles/...`, while `doctor` refuses the
    // same input as exit 31 before any I/O. Assert the engine is never reached, not just the code.
    const program = new Command().option('--dsh-home <path>').option('--json');
    const run = vi.fn();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    registerComposeCommand(program, run);

    await program.parseAsync(['node', 'dshpack', '--dsh-home', home, 'compose']);

    expect(process.exitCode).toBe(EXIT_CODES.SECURITY);
    expect(run).not.toHaveBeenCalled();
  });

  it('reads DSH_HOME from the environment, like every other command does', async () => {
    // `--dsh-home` and `DSH_HOME` are documented as equivalent for all commands. compose read only
    // the flag, so a user with the variable exported was told to "pass an explicit isolated
    // DSH_HOME" for a `profile:` source they had already configured.
    process.env.DSH_HOME = TEST_DSH_HOME;
    const program = new Command().option('--dsh-home <path>').option('--json');
    const run = vi.fn().mockResolvedValue({
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { directory: 'output', dryRun: false, selected: [] },
    });
    registerComposeCommand(program, run);

    await program.parseAsync(['node', 'dshpack', 'compose']);

    expect(run).toHaveBeenCalledWith({ composeFile: 'compose.yml', dshHome: TEST_DSH_HOME });
  });

  it('still composes with no home at all, since only a profile: source needs one', async () => {
    delete process.env.DSH_HOME;
    const program = new Command().option('--dsh-home <path>').option('--json');
    const run = vi.fn().mockResolvedValue({
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { directory: 'output', dryRun: false, selected: [] },
    });
    registerComposeCommand(program, run);

    await program.parseAsync(['node', 'dshpack', 'compose']);

    expect(run).toHaveBeenCalledWith({ composeFile: 'compose.yml' });
  });

  it('defaults to compose.yml and accepts root --json without defining a colliding child option', async () => {
    const program = new Command().option('--json');
    const run = vi.fn().mockResolvedValue({
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { directory: 'output', dryRun: true, selected: [] },
    });
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    registerComposeCommand(program, run);

    await program.parseAsync(['node', 'dshpack', '--json', 'compose', '--dry-run']);

    expect(run).toHaveBeenCalledWith({ composeFile: 'compose.yml', dryRun: true });
    expect(JSON.parse(stdout)).toMatchObject({ directory: 'output', dryRun: true });
    const compose = program.commands.find((command) => command.name() === 'compose');
    expect(compose?.options.some((option) => option.long === '--json')).toBe(false);
  });
});
