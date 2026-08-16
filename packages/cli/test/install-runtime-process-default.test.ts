import { execa } from 'execa';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPathProcessRuntime } from '../src/install/runtime-process.js';

vi.mock('execa', () => ({ execa: vi.fn() }));

describe('install default PATH subprocess', () => {
  beforeEach(() => vi.mocked(execa).mockReset());

  it('uses execa directly with no shell, no rejection, and no descendant killing', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '0.1.0-rc.6\n', stderr: '' } as never)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '10.0.0\n', stderr: '' } as never);
    const process = createPathProcessRuntime();
    await expect(process.probe('C:/isolated-dsh-home')).resolves.toEqual({
      dshVersion: '0.1.0-rc.6',
      pnpmVersion: '10.0.0',
    });
    expect(execa).toHaveBeenCalledTimes(2);
    expect(execa).toHaveBeenNthCalledWith(
      1,
      'dsh',
      ['--version'],
      expect.objectContaining({
        shell: false,
        reject: false,
        killDescendants: false,
        windowsHide: true,
      }),
    );
    expect(execa).toHaveBeenNthCalledWith(2, 'pnpm', ['--version'], expect.anything());
  });
});
