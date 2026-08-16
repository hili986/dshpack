import { resolve } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runners = vi.hoisted(() => ({ generateAndWriteLock: vi.fn() }));

vi.mock('../src/lock/engine.js', () => ({
  generateAndWriteLock: runners.generateAndWriteLock,
}));

import { registerLockCommand } from '../src/commands/lock.js';

afterEach(() => {
  runners.generateAndWriteLock.mockReset();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('lock command', () => {
  it('uses the optional directory, writes one JSON report, and does not require DSH_HOME', async () => {
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    runners.generateAndWriteLock.mockResolvedValue({
      diagnostics: [],
      exitCode: 0,
      metadata: { source: 'C:/tmp/handwritten-pack', written: true },
    });
    const program = new Command().option('--json');
    registerLockCommand(program);

    await program.parseAsync(['node', 'dshpack', '--json', 'lock', 'C:/tmp/handwritten-pack'], {
      from: 'node',
    });

    expect(runners.generateAndWriteLock).toHaveBeenCalledWith(resolve('C:/tmp/handwritten-pack'));
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      diagnostics: [],
      source: 'C:/tmp/handwritten-pack',
      written: true,
    });
  });
});
