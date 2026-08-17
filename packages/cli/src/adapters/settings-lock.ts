import { type FileHandle, lstat, open, readFile, rm } from 'node:fs/promises';
import type { Diagnostic, Result } from '@dshpack/core';

export interface SettingsClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface YamlSettingsAdapterOptions {
  beforeLockAcquire?: () => Promise<Result<void>>;
  /** Test seam for replacement between exclusive creation and the writer handle acquisition. */
  beforeLockWrite?: (path: string) => Promise<void>;
  clock?: SettingsClock;
  /** Test seam for a retained lock-handle close failure. */
  closeLockGuard?: (handle: FileHandle) => Promise<void>;
  removeLock?: (path: string) => Promise<void>;
  writeLockContents?: (handle: FileHandle, owner: string) => Promise<void>;
}

const LOCK_RETRY_INITIAL_MS = 20;
const LOCK_RETRY_MAX_MS = 200;
const LOCK_TIMEOUT_MS = 2_000;
const systemClock: SettingsClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};
const writeLockContents = (handle: FileHandle, owner: string): Promise<void> =>
  handle.writeFile(owner, 'utf8');
const closeLockGuard = (handle: FileHandle): Promise<void> => handle.close();
const removeLock = (path: string): Promise<void> => rm(path, { force: true });

function pass<T>(value: T): Result<T> {
  return { ok: true, value, diagnostics: [] };
}

function fail<T>(diagnostics: readonly Diagnostic[]): Result<T> {
  return { ok: false, diagnostics };
}

function diagnostic(code: string, message: string, hint: string, path: string): Diagnostic {
  return { code, severity: 'error', message, hint, path, evidence: 'local' };
}

export function settingsIoFailure<T>(path: string): Result<T> {
  return fail([
    diagnostic(
      'E_SETTINGS_IO',
      'settings 文件系统操作失败，未能确认操作完成。',
      '检查路径权限、磁盘状态和锁文件后重试。',
      path,
    ),
  ]);
}

function isErrorCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

interface LockIdentity {
  dev: bigint;
  ino: bigint;
}

function sameIdentity(stats: LockIdentity, identity: LockIdentity): boolean {
  return stats.dev === identity.dev && stats.ino === identity.ino;
}

async function removeMatchingLock(
  lockPath: string,
  identity: LockIdentity,
  remove: (path: string) => Promise<void>,
): Promise<void> {
  try {
    if (!sameIdentity(await lstat(lockPath, { bigint: true }), identity)) return;
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return;
    throw error;
  }
  await remove(lockPath);
}

async function releaseOwnedLock(
  lockPath: string,
  owner: string,
  identity: LockIdentity,
  remove: (path: string) => Promise<void>,
): Promise<void> {
  let current: string;
  try {
    if (!sameIdentity(await lstat(lockPath, { bigint: true }), identity)) return;
    current = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return;
    throw error;
  }

  // 我方更严，非复刻官方 (stricter by design, not an official-behavior replica):
  // official removes unconditionally; we verify both our inode and PID payload before removal.
  if (current !== owner) return;
  await removeMatchingLock(lockPath, identity, remove);
}

type LockAttempt =
  | { kind: 'acquired'; guard: FileHandle; identity: LockIdentity }
  | { kind: 'contended' }
  | { kind: 'io-error' };

async function tryAcquireLock(
  lockPath: string,
  owner: string,
  write: (handle: FileHandle, owner: string) => Promise<void>,
  beforeWrite: ((path: string) => Promise<void>) | undefined,
  closeGuard: (handle: FileHandle) => Promise<void>,
  remove: (path: string) => Promise<void>,
): Promise<LockAttempt> {
  let guard: FileHandle;
  try {
    guard = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    return isErrorCode(error, 'EEXIST') ? { kind: 'contended' } : { kind: 'io-error' };
  }

  let identity: LockIdentity | undefined;
  let writeHandle: FileHandle | undefined;
  try {
    const stats = await guard.stat({ bigint: true });
    identity = { dev: stats.dev, ino: stats.ino };
    await beforeWrite?.(lockPath);
    writeHandle = await open(lockPath, 'r+');
    if (!sameIdentity(await writeHandle.stat({ bigint: true }), identity))
      throw new Error('lock replaced');
    await write(writeHandle, owner);
    await writeHandle.close();
    return { kind: 'acquired', guard, identity };
  } catch {
    await writeHandle?.close().catch(() => undefined);
    if (identity !== undefined) {
      await removeMatchingLock(lockPath, identity, remove).catch(() => undefined);
    }
    await closeGuard(guard).catch(() => undefined);
    return { kind: 'io-error' };
  }
}

/** Serialize one writer through the official `<file>.lock` protocol. */
export async function withSettingsFileLock<T>(
  filename: string,
  operation: () => Promise<T>,
  options: YamlSettingsAdapterOptions = {},
): Promise<Result<T>> {
  const clock = options.clock ?? systemClock;
  const lockPath = `${filename}.lock`;
  const owner = `${process.pid}\n`;
  const deadline = clock.now() + LOCK_TIMEOUT_MS;
  const closeGuard = options.closeLockGuard ?? closeLockGuard;
  let delay = LOCK_RETRY_INITIAL_MS;
  let guard: FileHandle;
  let identity: LockIdentity;

  for (;;) {
    if (options.beforeLockAcquire !== undefined) {
      let guarded: Result<void>;
      try {
        guarded = await options.beforeLockAcquire();
      } catch {
        return settingsIoFailure(lockPath);
      }
      if (!guarded.ok) return fail(guarded.diagnostics);
    }
    const attempt = await tryAcquireLock(
      lockPath,
      owner,
      options.writeLockContents ?? writeLockContents,
      options.beforeLockWrite,
      closeGuard,
      options.removeLock ?? removeLock,
    );
    if (attempt.kind === 'acquired') {
      guard = attempt.guard;
      identity = attempt.identity;
      break;
    }
    if (attempt.kind === 'io-error') return settingsIoFailure(lockPath);
    if (clock.now() >= deadline) {
      return fail([
        diagnostic(
          'E_SETTINGS_LOCK_TIMEOUT',
          '等待 settings 写锁超时，未修改配置。',
          '确认没有活跃写入者；孤儿锁必须由运维人员人工处理。',
          lockPath,
        ),
      ]);
    }
    await clock.sleep(delay);
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
  }

  let result: Result<T>;
  try {
    result = pass(await operation());
  } catch {
    result = settingsIoFailure(filename);
  }
  let releaseFailed = false;
  try {
    await releaseOwnedLock(lockPath, owner, identity, options.removeLock ?? removeLock);
  } catch {
    releaseFailed = true;
  }
  try {
    await closeGuard(guard);
  } catch {
    releaseFailed = true;
  }
  if (releaseFailed) {
    return settingsIoFailure(lockPath);
  }
  return result;
}
