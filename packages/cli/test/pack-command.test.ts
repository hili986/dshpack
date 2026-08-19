import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerPackCommand } from '../src/commands/pack.js';
import { EXIT_CODES } from '../src/exit-codes.js';

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('pack command', () => {
  it('passes directory and output to the pack runner and preserves JSON closure', async () => {
    const program = new Command().option('--json');
    const run = vi.fn().mockResolvedValue({
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { output: 'dist', archive: 'dist/repro.tgz' },
    });
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    registerPackCommand(program, run);

    await program.parseAsync(['node', 'dshpack', '--json', 'pack', 'source', '--output', 'dist']);

    expect(run).toHaveBeenCalledWith({ directory: 'source', output: 'dist' });
    expect(process.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(JSON.parse(stdout)).toMatchObject({ diagnostics: [], output: 'dist' });
  });

  it('honors command-local --json when the root flag is absent', async () => {
    const program = new Command();
    const run = vi.fn().mockResolvedValue({
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { output: 'dist' },
    });
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    registerPackCommand(program, run);
    await program.parseAsync(['node', 'dshpack', 'pack', 'source', '--json']);
    expect(run).toHaveBeenCalledWith({ directory: 'source' });
    expect(JSON.parse(stdout)).toMatchObject({ diagnostics: [], output: 'dist' });
  });
});
