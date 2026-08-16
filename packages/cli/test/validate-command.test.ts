import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/validation/validate-pack.js', () => ({
  validateLocalPack: async () => ({
    diagnostics: [],
    exitCode: 0,
    metadata: { source: 'C:/tmp/pack' },
  }),
}));

import { registerValidateCommand } from '../src/commands/validate.js';

describe('validate command JSON output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('honors the root --json flag', async () => {
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    const program = new Command().option('--json');
    registerValidateCommand(program);

    await program.parseAsync(['node', 'dshpack', '--json', 'validate', 'C:/tmp/pack'], {
      from: 'node',
    });

    expect(JSON.parse(stdout)).toEqual({ diagnostics: [], source: 'C:/tmp/pack' });
  });
});
