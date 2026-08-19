import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));

vi.mock('execa', () => ({ execa: execaMock }));

import {
  awaitDirectChild,
  DshProcessError,
  environmentValue,
  runDsh,
} from '../src/adapters/process.js';

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

function pendingChild(): FakeChild {
  return Object.assign(new Promise<FakeOutcome>(() => undefined), { kill: vi.fn(() => true) });
}

function pendingChildWithStreams(unref: () => void = vi.fn()): {
  child: FakeChild & {
    nodeChildProcess: { unref: () => void };
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = Object.assign(new Promise<FakeOutcome>(() => undefined), {
    kill: vi.fn(() => true),
    nodeChildProcess: { unref },
    stdout,
    stderr,
  });
  return { child, stdout, stderr };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

afterEach(async () => {
  execaMock.mockReset();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('runDsh', () => {
  it('resolves process environment keys case-insensitively when the exact key is absent', () => {
    expect(environmentValue(undefined, 'PATH', { Path: 'case-insensitive-path' })).toBe(
      'case-insensitive-path',
    );
  });

  it('uses an exact process environment key when no command override is provided', () => {
    expect(environmentValue(undefined, 'PATH', { PATH: 'exact-process-path' })).toBe(
      'exact-process-path',
    );
    expect(environmentValue({}, 'PATH', { PATH: 'exact-process-path' })).toBe('exact-process-path');
  });

  it('uses a case-insensitive PATH override when selecting the direct dsh launcher', async () => {
    execaMock.mockReturnValue(resolvedChild({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const options = await makeOptions();
    options.env = { Path: options.env?.PATH };

    const result = await runDsh(['--version'], options);

    expect(result.launcher).toBe('path');
    expect(execaMock).toHaveBeenCalledExactlyOnceWith(
      'dsh',
      ['--version'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('uses non-empty PATHEXT entries to find a Windows command suffix', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      execaMock.mockReturnValue(resolvedChild({ stdout: 'ok', stderr: '', exitCode: 0 }));
      const options = await makeOptions();
      options.env = { PATH: options.env?.PATH, PATHEXT: ';.cmd' };

      const result = await runDsh(['--version'], options);

      expect(result.launcher).toBe('path');
      expect(execaMock).toHaveBeenCalledExactlyOnceWith(
        'dsh',
        ['--version'],
        expect.objectContaining({ shell: false }),
      );
    } finally {
      if (originalPlatform === undefined) Reflect.deleteProperty(process, 'platform');
      else Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

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

  it('returns a timeout attempt when a direct child never closes its inherited output', async () => {
    const child = pendingChild();
    execaMock.mockReturnValue(child);
    const interrupted = vi.fn();
    const options = await makeOptions({ onInterrupted: interrupted, timeout: 10 });

    const outcome = await Promise.race([
      runDsh(['--version'], options).then(
        () => new Error('expected runDsh to reject after timing out'),
        (reason: unknown) => reason,
      ),
      delay(600).then(() => new Error('unit-test safety valve: runDsh did not settle')),
    ]);

    expect(outcome).toMatchObject({ timedOut: true, interruptionReason: 'timeout' });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(interrupted).toHaveBeenCalledExactlyOnceWith('timeout');
  });

  it('reports a duplicated local-and-Execa timeout interruption only once', async () => {
    const { child } = deferredRejectedChild({
      stdout: '',
      stderr: '',
      timedOut: true,
      isTerminated: true,
    });
    execaMock.mockReturnValue(child);
    const interrupted = vi.fn();
    const options = await makeOptions({ onInterrupted: interrupted, timeout: 1 });

    await expect(runDsh(['--version'], options)).rejects.toMatchObject({
      timedOut: true,
      interruptionReason: 'timeout',
    });

    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(interrupted).toHaveBeenCalledExactlyOnceWith('timeout');
  });

  it('clears the local timeout guard after a child succeeds', async () => {
    const child = resolvedChild({ stdout: 'ok', stderr: '', exitCode: 0 });
    execaMock.mockReturnValue(child);
    const options = await makeOptions({ timeout: 10 });

    await expect(runDsh(['--version'], options)).resolves.toMatchObject({ stdout: 'ok' });
    await delay(300);

    expect(child.kill).not.toHaveBeenCalled();
  });

  it('unrefs the direct process and both output streams when the local guard times out', async () => {
    const processUnref = vi.fn();
    const stdoutUnref = vi.fn();
    const stderrUnref = vi.fn();
    const { child, stdout, stderr } = pendingChildWithStreams(processUnref);
    child.stdout = Object.assign(stdout, { unref: stdoutUnref });
    child.stderr = Object.assign(stderr, { unref: stderrUnref });

    const completion = await awaitDirectChild(child as never, 1);

    expect(completion).toMatchObject({ timedOut: true });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(processUnref).toHaveBeenCalledOnce();
    expect(stdoutUnref).toHaveBeenCalledOnce();
    expect(stderrUnref).toHaveBeenCalledOnce();
  });

  it('keeps timeout completion non-blocking when an unref implementation throws', async () => {
    const throwingUnref = vi.fn(() => {
      throw new Error('closed handle');
    });
    const { child } = pendingChildWithStreams(throwingUnref);

    const completion = await awaitDirectChild(child as never, 1);

    expect(completion).toMatchObject({ timedOut: true });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(throwingUnref).toHaveBeenCalledOnce();
  });

  it('decodes Uint8Array output chunks before a timeout settles', async () => {
    const { child, stdout, stderr } = pendingChildWithStreams();
    const completionPromise = awaitDirectChild(child as never, 1);
    stdout.emit('data', new Uint8Array([0x6f, 0x6b]));
    stderr.emit('data', new Uint8Array([0x6e, 0x6f]));

    await expect(completionPromise).resolves.toMatchObject({
      timedOut: true,
      stdout: 'ok',
      stderr: 'no',
    });
  });

  it('preserves an already-settled timed-out result without arming a second timeout guard', async () => {
    const callback = vi.fn();
    const child = resolvedChild({ stdout: '', stderr: '', timedOut: true });

    await expect(awaitDirectChild(child as never, 0, callback)).resolves.toEqual({
      exitCode: 1,
      failure: undefined,
      stderr: '',
      stdout: '',
      timedOut: true,
    });
    expect(callback).toHaveBeenCalledExactlyOnceWith();
  });

  it('normalizes missing successful child output to stable empty strings', async () => {
    const child = resolvedChild({ exitCode: 0 } as FakeOutcome);

    await expect(awaitDirectChild(child as never, 0)).resolves.toEqual({
      exitCode: 0,
      failure: undefined,
      stderr: '',
      stdout: '',
      timedOut: false,
    });
  });

  it('normalizes non-string successful child output to stable empty strings', async () => {
    const child = resolvedChild({
      exitCode: 0,
      stdout: 42 as unknown as string,
      stderr: { value: 'not text' } as unknown as string,
    });

    await expect(awaitDirectChild(child as never, 0)).resolves.toEqual({
      exitCode: 0,
      failure: undefined,
      stderr: '',
      stdout: '',
      timedOut: false,
    });
  });

  it('normalizes malformed child rejection values into a nonzero completion', async () => {
    const promise = Promise.reject<never>(null);
    void promise.catch(() => undefined);
    const child = Object.assign(promise, { kill: vi.fn(() => true) });

    await expect(awaitDirectChild(child as never, 0)).resolves.toEqual({
      exitCode: 1,
      failure: null,
      stderr: '',
      stdout: '',
      timedOut: false,
    });
  });

  it('collects string output chunks before timing out', async () => {
    const { child, stdout, stderr } = pendingChildWithStreams();
    const completionPromise = awaitDirectChild(child as never, 1);
    stdout.emit('data', 'standard output');
    stderr.emit('data', 'standard error');

    await expect(completionPromise).resolves.toMatchObject({
      timedOut: true,
      stdout: 'standard output',
      stderr: 'standard error',
    });
  });

  it('reports the npx fallback through the default stderr writer when no callback is supplied', async () => {
    execaMock.mockReturnValue(resolvedChild({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const options = await makeOptions({ env: { PATH: join(process.cwd(), 'missing-bin') } });

    await expect(runDsh(['--version'], options)).resolves.toMatchObject({ launcher: 'npx' });

    expect(write).toHaveBeenCalledOnce();
    expect(String(write.mock.calls[0]?.[0])).toContain('npx --yes @deepseek-ai/dsh');
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
