import { afterEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.fn();
const confirmMock = vi.fn();
const isCancelMock = vi.fn();

vi.mock('execa', () => ({ execa: execaMock }));
vi.mock('@clack/prompts', () => ({ confirm: confirmMock, isCancel: isCancelMock }));

const { nodeSwitchRuntime } = await import('../src/switch/engine.js');

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('nodeSwitchRuntime', () => {
  it('writes diff to stderr and keeps every prompt default rejecting', async () => {
    const output: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    nodeSwitchRuntime.showDiff('diff');
    expect(output).toEqual(['diff\n']);

    confirmMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    isCancelMock.mockReturnValueOnce(false).mockReturnValueOnce(true).mockReturnValueOnce(false);
    const options = { message: 'confirm?', initialValue: false as const };
    await expect(nodeSwitchRuntime.confirm(options)).resolves.toBe(true);
    await expect(nodeSwitchRuntime.confirm(options)).resolves.toBe(false);
    await expect(nodeSwitchRuntime.confirm(options)).resolves.toBe(false);
    expect(confirmMock).toHaveBeenCalledWith({ message: 'confirm?', initialValue: false });
  });

  it('spawns only one foreground direct child without shell or descendant termination', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0 }).mockResolvedValueOnce({ exitCode: undefined });
    await expect(nodeSwitchRuntime.spawnDsh('demo', 'C:/temporary-home')).resolves.toBe(0);
    await expect(nodeSwitchRuntime.spawnDsh('demo', 'C:/temporary-home')).resolves.toBe(1);
    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      'dsh',
      ['--profile', 'demo'],
      expect.objectContaining({
        cwd: expect.stringMatching(/temporary-home[\\/]profiles[\\/]demo$/u),
        env: expect.objectContaining({ DSH_HOME: 'C:/temporary-home' }),
        killDescendants: false,
        reject: false,
        shell: false,
        stdio: 'inherit',
        windowsHide: true,
      }),
    );
  });
});
