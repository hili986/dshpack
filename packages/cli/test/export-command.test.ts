import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/export/engine.js', () => ({
  exportProfile: async () => ({
    diagnostics: [],
    exitCode: 0,
    metadata: {
      exportMode: 'portable',
      integrity: 'verified',
      output: 'C:/tmp/out',
      profile: 'demo',
      redactions: [],
      review: [],
    },
  }),
}));

import { registerExportCommand } from '../src/commands/export.js';

describe('export command JSON output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('honors the root --json flag and emits no human success text', async () => {
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    const program = new Command().option('--dsh-home <path>').option('--json');
    registerExportCommand(program);

    await program.parseAsync(
      [
        'node',
        'dshpack',
        '--dsh-home',
        process.cwd(),
        '--json',
        'export',
        '--profile',
        'demo',
        '--output',
        'C:/tmp/out',
      ],
      { from: 'node' },
    );

    expect(JSON.parse(stdout)).toMatchObject({
      diagnostics: [],
      output: 'C:/tmp/out',
      profile: 'demo',
    });
  });
});
