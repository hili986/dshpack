import { constants } from 'node:fs';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import { redactSecrets } from '@dshpack/core';
import { execa, type Options, type ResultPromise } from 'execa';

export interface ProcessAdapter {
  readonly argv: readonly string[];
  writeStderr(message: string): void;
  setExitCode(code: number): void;
}

export type DshLauncher = 'path' | 'npx';
export type DshInterruptionReason = 'signal' | 'timeout';

export interface RunDshOptions {
  cwd: string;
  dshHome: string;
  timeout: number;
  env?: Readonly<NodeJS.ProcessEnv>;
  /** A transaction-owned signal which uses the same direct-child path as Ctrl+C. */
  interruptSignal?: AbortSignal;
  onInterrupted?: (reason: DshInterruptionReason) => void;
  onSlowPath?: (message: string) => void;
}

export interface DshProcessResult {
  exitCode: number;
  launcher: DshLauncher;
  logPath: string;
  stderr: string;
  stdout: string;
}

interface DshProcessErrorDetails extends DshProcessResult {
  interrupted: boolean;
  interruptionReason: DshInterruptionReason | undefined;
  timedOut: boolean;
}

export class DshProcessError extends Error {
  readonly code = 'E_DSH_SUBPROCESS';
  readonly exitCode: number;
  readonly interrupted: boolean;
  readonly interruptionReason: DshInterruptionReason | undefined;
  readonly launcher: DshLauncher;
  readonly logPath: string;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;

  constructor(message: string, details: DshProcessErrorDetails) {
    super(message);
    this.name = 'DshProcessError';
    this.exitCode = details.exitCode;
    this.interrupted = details.interrupted;
    this.interruptionReason = details.interruptionReason;
    this.launcher = details.launcher;
    this.logPath = details.logPath;
    this.stderr = details.stderr;
    this.stdout = details.stdout;
    this.timedOut = details.timedOut;
  }
}

interface KillableChild {
  kill(signal?: NodeJS.Signals | number): boolean;
}

interface InvocationAttempt {
  args: readonly string[];
  command: string;
  exitCode: number;
  failure: unknown;
  launcher: DshLauncher;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export interface DirectChildCompletion {
  exitCode: number;
  failure: unknown;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

const slowPathMessage =
  '未在 PATH 中找到 dsh，改用 npx --yes @deepseek-ai/dsh（首次运行可能较慢）。';
const directChildTimeoutGrace = 250;
let logSequence = 0;

function stringProperty(value: unknown, property: string): string {
  if (typeof value !== 'object' || value === null) return '';
  const candidate = Reflect.get(value, property);
  return typeof candidate === 'string' ? candidate : '';
}

function booleanProperty(value: unknown, property: string): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return Reflect.get(value, property) === true;
}

function numberProperty(value: unknown, property: string): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = Reflect.get(value, property);
  return typeof candidate === 'number' ? candidate : undefined;
}

function unrefProcessHandle(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  const unref = Reflect.get(value, 'unref');
  if (typeof unref !== 'function') return;
  try {
    unref.call(value);
  } catch {
    // A closed stream may reject unref. Timeout completion must remain non-blocking.
  }
}

/**
 * Await one direct Execa child without making its descendants an interruption target.
 * The local guard settles even when a descendant retains an inherited output pipe after Execa's
 * own timeout has terminated the direct child.
 */
export async function awaitDirectChild<OptionsType extends Options>(
  child: ResultPromise<OptionsType>,
  timeout: number,
  onTimeout?: () => void,
): Promise<DirectChildCompletion> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const appendStdout = (chunk: string | Uint8Array): void => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
  };
  const appendStderr = (chunk: string | Uint8Array): void => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
  };
  child.stdout?.on('data', appendStdout);
  child.stderr?.on('data', appendStderr);
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const childCompletion = child.then(
      (result): DirectChildCompletion => {
        const timedOut = booleanProperty(result, 'timedOut');
        if (timedOut) onTimeout?.();
        return {
          exitCode: numberProperty(result, 'exitCode') ?? 1,
          failure: undefined,
          stderr: typeof result.stderr === 'string' ? result.stderr : '',
          stdout: typeof result.stdout === 'string' ? result.stdout : '',
          timedOut,
        };
      },
      (failure): DirectChildCompletion => {
        const timedOut = booleanProperty(failure, 'timedOut');
        if (timedOut) onTimeout?.();
        return {
          exitCode: numberProperty(failure, 'exitCode') ?? 1,
          failure,
          stderr: stringProperty(failure, 'stderr'),
          stdout: stringProperty(failure, 'stdout'),
          timedOut,
        };
      },
    );
    if (timeout <= 0) return await childCompletion;
    const timeoutCompletion = new Promise<DirectChildCompletion>((resolveTimeout) => {
      timeoutTimer = setTimeout(() => {
        onTimeout?.();
        try {
          child.kill('SIGTERM');
        } catch {
          // Execa may expose an already-closed direct child; do not wait for its descendants.
        }
        // Inherited pipes must not keep the CLI event loop alive after the timeout returns.
        unrefProcessHandle(child.nodeChildProcess);
        unrefProcessHandle(child.stdout);
        unrefProcessHandle(child.stderr);
        resolveTimeout({
          exitCode: 1,
          failure: new Error('subprocess timed out before its inherited output closed'),
          stderr: stderrChunks.join(''),
          stdout: stdoutChunks.join(''),
          timedOut: true,
        });
      }, timeout + directChildTimeoutGrace);
    });
    return await Promise.race([childCompletion, timeoutCompletion]);
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    child.stdout?.off('data', appendStdout);
    child.stderr?.off('data', appendStderr);
  }
}

function isMissingCommand(error: unknown): boolean {
  if (stringProperty(error, 'code') === 'ENOENT') return true;
  return /\bENOENT\b/u.test(stringProperty(error, 'shortMessage'));
}

export function environmentValue(
  overrides: Readonly<NodeJS.ProcessEnv> | undefined,
  name: string,
  processEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
): string | undefined {
  const normalizedName = name.toLowerCase();
  const exactOverride = overrides?.[name];
  if (exactOverride !== undefined) return exactOverride;
  const override = Object.entries(overrides ?? {}).findLast(
    ([key]) => key.toLowerCase() === normalizedName,
  )?.[1];
  if (override !== undefined) return override;
  const exactProcessValue = processEnvironment[name];
  if (exactProcessValue !== undefined) return exactProcessValue;
  return Object.entries(processEnvironment).findLast(
    ([key]) => key.toLowerCase() === normalizedName,
  )?.[1];
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) return false;
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve PATH membership without invoking a shell or treating a real dsh exit as discovery. */
async function commandExistsOnPath(
  command: string,
  cwd: string,
  env: Readonly<NodeJS.ProcessEnv> | undefined,
): Promise<boolean> {
  const pathValue = environmentValue(env, 'PATH');
  if (pathValue === undefined) return false;
  const extensions =
    process.platform === 'win32'
      ? (environmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter((extension) => extension !== '')
      : [''];
  for (const rawDirectory of pathValue.split(delimiter)) {
    const unquotedDirectory = rawDirectory.replace(/^"|"$/gu, '');
    const directory = unquotedDirectory === '' ? cwd : resolve(cwd, unquotedDirectory);
    for (const extension of extensions) {
      if (await isExecutableFile(join(directory, `${command}${extension}`))) return true;
    }
  }
  return false;
}

function renderAttempt(attempt: InvocationAttempt): string {
  const status =
    attempt.failure === undefined
      ? `exitCode=${attempt.exitCode}`
      : `failed=true exitCode=${attempt.exitCode} timedOut=${attempt.timedOut}`;
  return [
    `[command]\n${attempt.command}`,
    `[launcher]\n${attempt.launcher}`,
    `[argv]\nargvCount=${attempt.args.length}`,
    `[status]\n${status}`,
    `[stdout]\n${redactSecrets(attempt.stdout)}`,
    `[stderr]\n${redactSecrets(attempt.stderr)}`,
  ].join('\n');
}

async function persistLog(
  dshHome: string,
  attempts: readonly InvocationAttempt[],
): Promise<string> {
  const logDirectory = join(dshHome, '.dshpack', 'logs');
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  logSequence += 1;
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const logPath = join(logDirectory, `${timestamp}-${process.pid}-${logSequence}-dsh.log`);
  const contents = `${attempts.map(renderAttempt).join('\n\n')}\n`;
  await writeFile(logPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return logPath;
}

function failureDetails(
  attempt: InvocationAttempt,
  logPath: string,
  interruptionReason: DshInterruptionReason | undefined,
): DshProcessErrorDetails {
  return {
    exitCode: attempt.exitCode,
    interrupted: interruptionReason !== undefined,
    interruptionReason,
    launcher: attempt.launcher,
    logPath,
    stderr: redactSecrets(attempt.stderr),
    stdout: redactSecrets(attempt.stdout),
    timedOut: attempt.timedOut,
  };
}

/**
 * Run dsh without a shell, retaining only the direct Execa child as an interruption target.
 * `killDescendants` must remain false: on Windows Execa implements the true branch with
 * `taskkill /T`, which could terminate a user's unrelated, already-running dsh process tree.
 */
export async function runDsh(
  args: readonly string[],
  options: RunDshOptions,
): Promise<DshProcessResult> {
  const attempts: InvocationAttempt[] = [];
  let activeChild: KillableChild | undefined;
  let interruptionReason: DshInterruptionReason | undefined;

  const markInterrupted = (reason: DshInterruptionReason): void => {
    if (interruptionReason !== undefined) return;
    interruptionReason = reason;
    try {
      options.onInterrupted?.(reason);
    } catch {
      // Cleanup and direct-child termination must not be bypassed by a bookkeeping callback.
    }
  };
  const interruptDirectChild = (): void => {
    if (interruptionReason !== undefined) return;
    markInterrupted('signal');
    activeChild?.kill('SIGTERM');
  };
  const handleSigint = (): void => interruptDirectChild();

  process.on('SIGINT', handleSigint);
  options.interruptSignal?.addEventListener('abort', interruptDirectChild, { once: true });

  const invoke = async (
    command: string,
    commandArgs: readonly string[],
    launcher: DshLauncher,
  ): Promise<InvocationAttempt> => {
    const child = execa(command, [...commandArgs], {
      cwd: options.cwd,
      env: { ...options.env, DSH_HOME: options.dshHome },
      // Never enable this: Execa's Windows implementation uses taskkill /T for process trees.
      killDescendants: false,
      shell: false,
      timeout: options.timeout,
      windowsHide: true,
    });
    activeChild = child;
    try {
      const result = await awaitDirectChild(child, options.timeout, () =>
        markInterrupted('timeout'),
      );
      return {
        args: commandArgs,
        command,
        exitCode: result.exitCode,
        failure: result.failure,
        launcher,
        stderr: result.stderr,
        stdout: result.stdout,
        timedOut: result.timedOut,
      };
    } finally {
      if (activeChild === child) activeChild = undefined;
    }
  };

  const failBeforeSpawn = async (): Promise<never> => {
    const selected: InvocationAttempt = {
      args,
      command: 'dsh',
      exitCode: 1,
      failure: new Error('interrupted before spawn'),
      launcher: 'path',
      stderr: '',
      stdout: '',
      timedOut: false,
    };
    attempts.push(selected);
    const logPath = await persistLog(options.dshHome, attempts);
    throw new DshProcessError(
      `dsh 子进程执行已中断。 脱敏日志：${logPath}`,
      failureDetails(selected, logPath, interruptionReason),
    );
  };

  try {
    if (options.interruptSignal?.aborted === true) {
      interruptDirectChild();
      await failBeforeSpawn();
    }

    const pathDshAvailable = await commandExistsOnPath('dsh', options.cwd, options.env);
    if (interruptionReason !== undefined) await failBeforeSpawn();
    let selected: InvocationAttempt;
    if (pathDshAvailable) {
      selected = await invoke('dsh', args, 'path');
      attempts.push(selected);
    } else {
      selected = {
        args,
        command: 'dsh',
        exitCode: 1,
        failure: Object.assign(new Error('dsh is absent from PATH'), { code: 'ENOENT' }),
        launcher: 'path',
        stderr: '',
        stdout: '',
        timedOut: false,
      };
      attempts.push(selected);
    }
    if (
      selected.failure !== undefined &&
      interruptionReason === undefined &&
      isMissingCommand(selected.failure)
    ) {
      (options.onSlowPath ?? ((message) => process.stderr.write(`${message}\n`)))(slowPathMessage);
      selected = await invoke('npx', ['--yes', '@deepseek-ai/dsh', ...args], 'npx');
      attempts.push(selected);
    }

    const logPath = await persistLog(options.dshHome, attempts);
    if (selected.failure !== undefined || interruptionReason !== undefined) {
      const details = failureDetails(selected, logPath, interruptionReason);
      const summary = details.timedOut
        ? 'dsh 子进程执行超时。'
        : details.interrupted
          ? 'dsh 子进程执行已中断。'
          : 'dsh 子进程执行失败。';
      throw new DshProcessError(`${summary} 脱敏日志：${logPath}`, details);
    }

    return {
      exitCode: selected.exitCode,
      launcher: selected.launcher,
      logPath,
      stderr: selected.stderr,
      stdout: selected.stdout,
    };
  } finally {
    process.off('SIGINT', handleSigint);
    options.interruptSignal?.removeEventListener('abort', interruptDirectChild);
  }
}
