import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/doctor/engine.js', () => ({
  runDoctor: async () => ({
    diagnostics: [],
    exitCode: 0,
    metadata: { sideEffects: ['profile/cordis.yml'] },
  }),
}));

import { registerDoctorCommand } from '../src/commands/doctor.js';

describe('doctor command JSON output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('honors the root --json flag and exposes side effects as one JSON object', async () => {
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    const program = new Command().option('--dsh-home <path>').option('--json');
    registerDoctorCommand(program);

    await program.parseAsync(['node', 'dshpack', '--json', 'doctor'], { from: 'node' });

    expect(JSON.parse(stdout)).toEqual({ diagnostics: [], sideEffects: ['profile/cordis.yml'] });
  });
});
