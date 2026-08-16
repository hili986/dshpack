import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));

vi.mock('execa', () => ({ execa: execaMock }));

import { DshProcessError, runDsh } from '../src/adapters/process.js';

interface FakeOutcome {
  stdout: string;
  stderr: string;
  exitCode?: number;
  timedOut?: boolean;
  isCanceled?: boolean;
  isTerminated?: boolean;
  code?: string;
  shortMessage?: string;
}

interface FakeChild extends Promise<FakeOutcome> {
  kill: ReturnType<typeof vi.fn>;
}

const temporaryRoots: string[] = [];

async function makeOptions(
  overrides: Partial<Parameters<typeof runDsh>[1]> = {},
): Promise<Parameters<typeof runDsh>[1]> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-process-unit-'));
  temporaryRoots.push(root);
  const bin = join(root, 'bin');
  await mkdir(bin);
  const dshFile = join(bin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
  await writeFile(dshFile, 'unit-test placeholder', 'utf8');
  if (process.platform !== 'win32') await chmod(dshFile, 0o755);
  return {
    cwd: root,
    dshHome: join(root, 'dsh-home'),
    env: { PATH: bin },
    timeout: 321,
    ...overrides,
  };
}

function resolvedChild(outcome: FakeOutcome): FakeChild {
  return Object.assign(Promise.resolve(outcome), { kill: vi.fn(() => true) });
}

function rejectedChild(outcome: FakeOutcome): FakeChild {
  return rejectedErrorChild(Object.assign(new Error('untrusted child error'), outcome));
}

function rejectedErrorChild(error: Error): FakeChild {
  const promise = Promise.reject<FakeOutcome>(error);
  // The mock can be configured before async fixture setup completes. Mark it handled immediately;
  // runDsh still awaits the original rejected promise and observes the same error.
  void promise.catch(() => undefined);
  return Object.assign(promise, { kill: vi.fn(() => true) });
}

function deferredRejectedChild(outcome: FakeOutcome): {
  child: FakeChild;
  reject: () => void;
} {
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<FakeOutcome>((_resolve, reject) => {
    rejectPromise = reject;
  });
  const error = Object.assign(new Error('interrupted child'), outcome);
  const child = Object.assign(promise, {
    kill: vi.fn(() => {
      rejectPromise?.(error);
      return true;
    }),
  });
  return { child, reject: () => rejectPromise?.(error) };
}

afterEach(async () => {
  execaMock.mockReset();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('runDsh', () => {
  it('uses an argument array without a shell and writes only redacted child output to the log', async () => {
    const fakeToken = 'ghp_1234567890abcdefghijklmnop';
    const child = resolvedChild({
      stdout: `profile ready\ntoken: ${fakeToken}\n`,
      stderr: `Bearer ${fakeToken}\n`,
      exitCode: 0,
    });
    execaMock.mockReturnValue(child);
    const options = await makeOptions();
    const args = ['plugin', '--profile', '研究 profile #1', 'add', 'github:owner/repo#dead beef'];

    const result = await runDsh(args, options);

    expect(execaMock).toHaveBeenCalledOnce();
    expect(execaMock).toHaveBeenCalledWith(
      'dsh',
      args,
      expect.objectContaining({
        cwd: options.cwd,
        shell: false,
        timeout: 321,
        windowsHide: true,
        // Execa uses taskkill /T on Windows only when this is true. It must stay false.
        killDescendants: false,
      }),
    );
    expect(result).toMatchObject({
      exitCode: 0,
      launcher: 'path',
      stderr: `Bearer ${fakeToken}\n`,
      stdout: `profile ready\ntoken: ${fakeToken}\n`,
    });
    const log = await readFile(result.logPath, 'utf8');
    expect(log).toContain('[stdout]\nprofile ready');
    expect(log).toContain('[REDACTED]');
    expect(log).not.toContain(fakeToken);
    expect(result.logPath).toMatch(/[\\/]\.dshpack[\\/]logs[\\/].+-dsh\.log$/u);
  });

  it('never persists argv values because low-entropy credentials cannot be redacted reliably', async () => {
    execaMock.mockReturnValue(resolvedChild({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const options = await makeOptions();

    const result = await runDsh(['plugin', 'add', '--password', 'letmein123'], options);

    const log = await readFile(result.logPath, 'utf8');
    expect(log).toContain('argvCount=4');
    expect(log).not.toContain('--password');
    expect(log).not.toContain('letmein123');
  });

  it('does not reintroduce argv values through an Execa failure summary', async () => {
    execaMock.mockReturnValue(
      rejectedChild({
        stdout: '',
        stderr: 'failed',
        exitCode: 7,
        shortMessage: 'Command failed with exit code 7: dsh plugin add --password letmein123',
      }),
    );
    const options = await makeOptions();

    let error: unknown;
    try {
      await runDsh(['plugin', 'add', '--password', 'letmein123'], options);
    } catch (reason) {
      error = reason;
    }

    expect(error).toBeInstanceOf(DshProcessError);
    if (!(error instanceof DshProcessError)) throw new Error('expected DshProcessError');
    const log = await readFile(error.logPath, 'utf8');
    expect(log).toContain('failed=true');
    expect(log).not.toContain('--password');
    expect(log).not.toContain('letmein123');
  });

  it('prefers an explicit PATH key when environment casing contains duplicates', async () => {
    execaMock.mockReturnValue(resolvedChild({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const options = await makeOptions();
    options.env = { Path: join(options.cwd, 'missing'), PATH: options.env?.PATH };

    const result = await runDsh(['--version'], options);

    expect(result.launcher).toBe('path');
    expect(execaMock.mock.calls[0]?.[0]).toBe('dsh');
  });

  it.each([
    Object.assign(new Error('missing'), { code: 'ENOENT', stdout: '', stderr: '' }),
    Object.assign(new Error('missing'), {
      shortMessage: 'Command failed with ENOENT: dsh --version',
      stdout: '',
      stderr: '',
    }),
  ])('falls back to npx only when PATH dsh is missing', async (missingError) => {
    execaMock
      .mockReturnValueOnce(rejectedErrorChild(missingError))
      .mockReturnValueOnce(resolvedChild({ stdout: '0.1.0-test\n', stderr: '', exitCode: 0 }));
    const slowPath = vi.fn();
    const options = await makeOptions({ onSlowPath: slowPath });

    const result = await runDsh(['--version'], options);

    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      'dsh',
      ['--version'],
      expect.objectContaining({ shell: false }),
    );
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      'npx',
      ['--yes', '@deepseek-ai/dsh', '--version'],
      expect.objectContaining({ shell: false }),
    );
    expect(slowPath).toHaveBeenCalledOnce();
    expect(slowPath.mock.calls[0]?.[0]).toContain('npx --yes @deepseek-ai/dsh');
    expect(result.launcher).toBe('npx');
  });

  it('selects npx directly when the PATH probe cannot find dsh', async () => {
    execaMock.mockReturnValue(resolvedChild({ stdout: '0.1.0-test\n', stderr: '', exitCode: 0 }));
    const slowPath = vi.fn();
    const options = await makeOptions({ onSlowPath: slowPath });
    options.env = { PATH: join(options.cwd, 'missing-bin') };

    const result = await runDsh(['--version'], options);

    expect(execaMock).toHaveBeenCalledExactlyOnceWith(
      'npx',
      ['--yes', '@deepseek-ai/dsh', '--version'],
      expect.objectContaining({ shell: false }),
    );
    expect(slowPath).toHaveBeenCalledOnce();
    expect(result.launcher).toBe('npx');
  });

  it('does not hide a real dsh nonzero exit behind the npx fallback', async () => {
    execaMock.mockReturnValue(
      rejectedChild({
        stdout: '',
        stderr: 'plugin failed',
        exitCode: 7,
        shortMessage: 'Command failed with exit code 7: dsh plugin list',
      }),
    );
    const slowPath = vi.fn();
    const options = await makeOptions({ onSlowPath: slowPath });

    const promise = runDsh(['plugin', 'list'], options);

    await expect(promise).rejects.toMatchObject({
      exitCode: 7,
      launcher: 'path',
      name: 'DshProcessError',
    });
    expect(execaMock).toHaveBeenCalledOnce();
    expect(slowPath).not.toHaveBeenCalled();
    await expect(promise).rejects.toBeInstanceOf(DshProcessError);
  });

  it('reports the redacted log path when the selected child fails', async () => {
    const fakeToken = 'ghp_abcdefghijklmnopqrstuvwxyz';
    execaMock.mockReturnValue(
      rejectedChild({
        stdout: '',
        stderr: `token: ${fakeToken}`,
        exitCode: 9,
      }),
    );
    const options = await makeOptions();

    let error: unknown;
    try {
      await runDsh(['plugin', 'list'], options);
    } catch (reason) {
      error = reason;
    }
    expect(error).toBeInstanceOf(DshProcessError);
    if (!(error instanceof DshProcessError)) throw new Error('expected DshProcessError');
    expect(error.message).toContain(error.logPath);
    const log = await readFile(error.logPath, 'utf8');
    expect(log).toContain('[REDACTED]');
    expect(log).not.toContain(fakeToken);
  });

  it('marks a timeout as interrupted while descendant killing remains disabled', async () => {
    execaMock.mockReturnValue(
      rejectedChild({ stdout: '', stderr: '', timedOut: true, isTerminated: true }),
    );
    const interrupted = vi.fn();
    const options = await makeOptions({ onInterrupted: interrupted });

    await expect(runDsh(['--version'], options)).rejects.toMatchObject({
      interrupted: true,
      interruptionReason: 'timeout',
      timedOut: true,
    });

    expect(interrupted).toHaveBeenCalledExactlyOnceWith('timeout');
    expect(execaMock.mock.calls[0]?.[2]).toMatchObject({
      killDescendants: false,
      timeout: 321,
    });
  });

  it('forwards a transaction interrupt to only the currently held direct child', async () => {
    const controller = new AbortController();
    const { child } = deferredRejectedChild({
      stdout: '',
      stderr: '',
      isTerminated: true,
    });
    execaMock.mockReturnValue(child);
    const interrupted = vi.fn();
    const options = await makeOptions({
      interruptSignal: controller.signal,
      onInterrupted: interrupted,
    });

    const promise = runDsh(['plugin', 'list'], options);
    await vi.waitFor(() => expect(execaMock).toHaveBeenCalledOnce());
    controller.abort();

    await expect(promise).rejects.toMatchObject({
      interrupted: true,
      interruptionReason: 'signal',
    });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(interrupted).toHaveBeenCalledExactlyOnceWith('signal');
    expect(execaMock.mock.calls[0]?.[2]).toMatchObject({ killDescendants: false });
  });

  it('does not spawn when the transaction signal was already interrupted', async () => {
    const controller = new AbortController();
    controller.abort();
    const interrupted = vi.fn();
    const options = await makeOptions({
      interruptSignal: controller.signal,
      onInterrupted: interrupted,
    });

    await expect(runDsh(['plugin', 'list'], options)).rejects.toMatchObject({
      interrupted: true,
      interruptionReason: 'signal',
    });
    expect(execaMock).not.toHaveBeenCalled();
    expect(interrupted).toHaveBeenCalledExactlyOnceWith('signal');
  });

  it('does not spawn when interrupted while PATH discovery is in progress', async () => {
    const controller = new AbortController();
    const interrupted = vi.fn();
    const options = await makeOptions({
      interruptSignal: controller.signal,
      onInterrupted: interrupted,
    });
    const availableBin = options.env?.PATH ?? '';
    options.env = {
      PATH: [
        ...Array.from({ length: 30 }, (_value, index) => join(options.cwd, `missing-${index}`)),
        availableBin,
      ].join(delimiter),
    };

    const promise = runDsh(['plugin', 'list'], options);
    queueMicrotask(() => controller.abort());

    await expect(promise).rejects.toMatchObject({
      interrupted: true,
      interruptionReason: 'signal',
    });
    expect(execaMock).not.toHaveBeenCalled();
    expect(interrupted).toHaveBeenCalledExactlyOnceWith('signal');
  });
});
