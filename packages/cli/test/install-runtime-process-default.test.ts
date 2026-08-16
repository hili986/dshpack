import { execa } from 'execa';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPathProcessRuntime } from '../src/install/runtime-process.js';

vi.mock('execa', () => ({ execa: vi.fn() }));

describe('install default PATH subprocess', () => {
  beforeEach(() => vi.mocked(execa).mockReset());

  it('uses Windows command shims without enabling a shell', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '0.1.0-rc.6\n', stderr: '' } as never)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '10.0.0\n', stderr: '' } as never);
    const process = createPathProcessRuntime();

    await process.probe('C:/isolated-dsh-home');

    expect(execa).toHaveBeenNthCalledWith(
      1,
      globalThis.process.platform === 'win32' ? 'dsh.cmd' : 'dsh',
      ['--version'],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
    expect(execa).toHaveBeenNthCalledWith(
      2,
      globalThis.process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['--version'],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
  });

  it('probes a fresh isolated DSH_HOME from an existing process cwd', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '0.1.0-rc.6\n', stderr: '' } as never)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '10.0.0\n', stderr: '' } as never);
    const process = createPathProcessRuntime();
    const freshHome = 'C:/isolated-dsh-home-that-does-not-exist';

    await process.probe(freshHome);

    const firstOptions = vi.mocked(execa).mock.calls[0]?.[2];
    expect(firstOptions?.cwd).toBe(globalThis.process.cwd());
    expect(firstOptions?.env.DSH_HOME).toBe(freshHome);
  });

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
      globalThis.process.platform === 'win32' ? 'dsh.cmd' : 'dsh',
      ['--version'],
      expect.objectContaining({
        shell: false,
        reject: false,
        killDescendants: false,
        windowsHide: true,
      }),
    );
    expect(execa).toHaveBeenNthCalledWith(
      2,
      globalThis.process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['--version'],
      expect.anything(),
    );
  });
});
