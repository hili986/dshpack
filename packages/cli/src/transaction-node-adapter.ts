import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Result } from '@dshpack/core';

import { nodeFileSystemAdapter } from './adapters/fs.js';
import {
  compareAndMoveText,
  compareAndSwapText,
  withSettingsFileLock,
  type YamlSettingsAdapterOptions,
} from './adapters/settings.js';
import { EXIT_CODES } from './exit-codes.js';
import {
  type TransactionAdapter,
  type TransactionArtifactKind,
  type TransactionArtifactLock,
  TransactionFailure,
  type TransactionMutationKind,
} from './transaction-types.js';

const ARTIFACT_ROOTS: Record<TransactionArtifactKind, string> = {
  profile: 'profiles',
  skill: 'skills',
  preset: '.agent-presets',
};

function unwrapSettingsResult<T>(result: Result<T>): T {
  if (!result.ok) {
    const exitCode = result.diagnostics.some(({ code }) => code === 'E_SETTINGS_LOCK_TIMEOUT')
      ? EXIT_CODES.PROFILE_CONFLICT_OR_LOCK
      : EXIT_CODES.INTERNAL;
    throw new TransactionFailure(exitCode, result.diagnostics);
  }
  return result.value as T;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, resolve(path));
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

function samePath(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === '';
}

function scopeFailure(code: string, path: string): TransactionFailure {
  return new TransactionFailure(EXIT_CODES.SECURITY, [
    {
      code,
      severity: 'error',
      message: 'transaction mutation path is outside its DSH_HOME scope.',
      hint: 'Use the exact profiles, skills, .agent-presets, or settings.yaml path for this home.',
      path,
      evidence: 'local',
    },
  ]);
}

async function assertCanonicalMapping(
  logicalBase: string,
  canonicalBase: string,
  path: string,
  failure: TransactionFailure,
): Promise<void> {
  let existing = resolve(path);
  for (;;) {
    try {
      const actual = await realpath(existing);
      const expected = resolve(canonicalBase, relative(resolve(logicalBase), existing));
      if (!samePath(actual, expected)) throw failure;
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
      try {
        await lstat(existing);
      } catch (lstatError) {
        if (!isMissing(lstatError)) throw lstatError;
        existing = dirname(existing);
        continue;
      }
      throw failure;
    }
  }
}

async function validateMutationPath(
  lock: TransactionArtifactLock,
  kind: TransactionMutationKind,
  path: string,
): Promise<void> {
  const home = resolve(lock.dshHome);
  const canonicalHome = await realpath(home);
  if (kind === 'settings') {
    const failure = scopeFailure('E_TRANSACTION_SETTINGS_PATH_SCOPE', path);
    if (!samePath(path, join(home, 'settings.yaml'))) throw failure;
    await assertCanonicalMapping(home, canonicalHome, path, failure);
    return;
  }
  const rootName = ARTIFACT_ROOTS[kind];
  const root = join(home, rootName);
  const child = relative(root, resolve(path));
  const failure = scopeFailure('E_TRANSACTION_ARTIFACT_PATH_SCOPE', path);
  if (child === '' || isAbsolute(child) || dirname(child) !== '.') throw failure;
  await assertCanonicalMapping(root, join(canonicalHome, rootName), path, failure);
}

async function validateBackupPath(lock: TransactionArtifactLock, path: string): Promise<void> {
  const home = resolve(lock.dshHome);
  const backupRoot = join(home, '.dshpack', 'backups');
  const failure = scopeFailure('E_TRANSACTION_ARTIFACT_LOCK_SCOPE', path);
  if (!isWithin(backupRoot, path) || samePath(backupRoot, path)) throw failure;
  await assertCanonicalMapping(
    backupRoot,
    join(await realpath(home), '.dshpack', 'backups'),
    path,
    failure,
  );
}

async function prepareMetadataDirectory(dshHome: string): Promise<string> {
  const home = resolve(dshHome);
  await nodeFileSystemAdapter.ensureDirectory(home);
  const metadata = join(home, '.dshpack');
  const failure = scopeFailure('E_TRANSACTION_METADATA_PATH_SCOPE', metadata);
  const canonicalHome = await realpath(home);
  await assertCanonicalMapping(home, canonicalHome, metadata, failure);
  await nodeFileSystemAdapter.ensureDirectory(metadata);
  await assertCanonicalMapping(home, canonicalHome, metadata, failure);
  const backups = join(metadata, 'backups');
  const backupFailure = scopeFailure('E_TRANSACTION_BACKUP_PATH_SCOPE', backups);
  const canonicalMetadata = join(canonicalHome, '.dshpack');
  await assertCanonicalMapping(metadata, canonicalMetadata, backups, backupFailure);
  await nodeFileSystemAdapter.ensureDirectory(backups);
  await assertCanonicalMapping(metadata, canonicalMetadata, backups, backupFailure);
  return home;
}

async function readPathIdentity(path: string): Promise<string | undefined> {
  try {
    const stats = await lstat(path, { bigint: true });
    return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** Production adapter with durable FS operations and settings-lock conditional mutations. */
export function createNodeTransactionAdapter(
  settingsOptions: YamlSettingsAdapterOptions = {},
): TransactionAdapter {
  const activeLocks = new WeakSet<TransactionArtifactLock>();
  const requireActiveLock = (lock: TransactionArtifactLock): void => {
    if (!activeLocks.has(lock)) throw new Error(`artifact lock is not held: ${lock.lockPath}`);
  };
  return {
    ...nodeFileSystemAdapter,
    async acquireArtifactLock(dshHome) {
      const canonicalHome = await prepareMetadataDirectory(dshHome);
      const scope = join(canonicalHome, '.dshpack', 'artifacts');
      let enteredResolve = (): void => {};
      let releaseResolve = (): void => {};
      const entered = new Promise<void>((resolveEntered) => {
        enteredResolve = resolveEntered;
      });
      const releaseSignal = new Promise<void>((resolveRelease) => {
        releaseResolve = resolveRelease;
      });
      const held = withSettingsFileLock(
        scope,
        async () => {
          enteredResolve();
          await releaseSignal;
        },
        settingsOptions,
      );
      await Promise.race([
        entered,
        held.then((result) => {
          unwrapSettingsResult(result);
          throw new Error(`artifact lock ended before acquisition: ${scope}.lock`);
        }),
      ]);

      let releaseOperation: Promise<void> | undefined;
      const lock: TransactionArtifactLock = {
        dshHome: canonicalHome,
        lockPath: `${scope}.lock`,
        release() {
          releaseOperation ??= (async () => {
            releaseResolve();
            try {
              unwrapSettingsResult(await held);
            } finally {
              activeLocks.delete(lock);
            }
          })();
          return releaseOperation;
        },
      };
      activeLocks.add(lock);
      return lock;
    },
    async compareAndMoveText(path, expected, destination) {
      return unwrapSettingsResult(
        await compareAndMoveText(path, expected, destination, settingsOptions),
      );
    },
    async compareAndSwapText(path, expected, replacement) {
      return unwrapSettingsResult(
        await compareAndSwapText(path, expected, replacement, settingsOptions),
      );
    },
    async moveArtifactPath(lock, artifact, artifactPath, backupPath, direction, expectedIdentity) {
      requireActiveLock(lock);
      await validateMutationPath(lock, artifact, artifactPath);
      await validateBackupPath(lock, backupPath);
      const from = direction === 'to-backup' ? artifactPath : backupPath;
      const to = direction === 'to-backup' ? backupPath : artifactPath;
      if (await nodeFileSystemAdapter.pathExists(to)) throw new Error(`move target exists: ${to}`);
      // Node exposes no cross-platform CAS-rename primitive. The DSH_HOME-wide lease is held from
      // before reservation through commit/rollback, so protocol participants cannot enter this
      // check→rename window. Raw non-cooperating filesystem writes remain outside that guarantee.
      if (
        expectedIdentity !== undefined &&
        (await readPathIdentity(artifactPath)) !== expectedIdentity
      ) {
        return false;
      }
      await nodeFileSystemAdapter.rename(from, to);
      return true;
    },
    async pathIdentity(path) {
      return readPathIdentity(path);
    },
    async readTextIfExists(path) {
      try {
        return await nodeFileSystemAdapter.readText(path);
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },
    async validateMutationPath(lock, kind, path) {
      requireActiveLock(lock);
      await validateMutationPath(lock, kind, path);
    },
  };
}

export const nodeTransactionAdapter = createNodeTransactionAdapter();
