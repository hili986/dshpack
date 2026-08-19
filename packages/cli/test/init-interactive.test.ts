import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

const prompts = vi.hoisted(() => ({
  text: vi.fn(),
  isCancel: vi.fn(() => false),
}));

vi.mock('@clack/prompts', () => prompts);

import { registerInitCommand } from '../src/commands/init.js';
import { EXIT_CODES } from '../src/exit-codes.js';

afterEach(() => {
  prompts.text.mockReset();
  prompts.isCancel.mockReset().mockReturnValue(false);
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('interactive init', () => {
  it('asks for missing metadata only on the injected TTY path', async () => {
    prompts.text
      .mockResolvedValueOnce('interactive-pack')
      .mockResolvedValueOnce('Interactive description')
      .mockResolvedValueOnce('Interactive author')
      .mockResolvedValueOnce('MIT');
    const run = vi.fn().mockResolvedValue({
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { directory: 'interactive-pack', template: 'minimal' },
    });
    const program = new Command();
    registerInitCommand(program, run, vi.fn(), () => true);
    await program.parseAsync(['node', 'dshpack', 'init', 'interactive-pack']);

    expect(prompts.text).toHaveBeenCalledTimes(4);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'interactive-pack',
        description: 'Interactive description',
        author: 'Interactive author',
        license: 'MIT',
      }),
    );
  });

  it('maps a prompt cancellation to exit 21 without writing', async () => {
    prompts.text.mockResolvedValueOnce(Symbol('cancel'));
    prompts.isCancel.mockReturnValue(true);
    const run = vi.fn();
    const program = new Command();
    registerInitCommand(program, run, vi.fn(), () => true);
    await program.parseAsync(['node', 'dshpack', 'init', 'cancelled']);
    expect(process.exitCode).toBe(EXIT_CODES.USER_DECLINED);
    expect(run).not.toHaveBeenCalled();
  });
});
