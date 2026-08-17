import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Result } from '@dshpack/core';

import {
  DurableDirectoryRemoveError,
  DurableRemoveAfterUnlinkError,
  DurableRenameAfterMoveError,
  nodeFileSystemAdapter,
  removeDirectoryDurable,
  removeFileDurable,
  writeFileAtomic,
  writeFileExclusive,
} from './adapters/fs.js';
import {
  compareAndMoveText,
  compareAndSwapText,
  withSettingsFileLock,
  type YamlSettingsAdapterOptions,
} from './adapters/settings.js';
import { EXIT_CODES } from './exit-codes.js';
import {
  type BoundedReadDependencies,
  readBoundedRegularFile,
  SnapshotCaptureError,
} from './install/snapshot-capture.js';
import { isInstallableProfileName } from './metadata/contracts.js';
import {
  casStoreShard,
  isCanonicalCasStoreShard,
  isExactCasStoreShardLeaf,
} from './metadata/state-storage.js';
import {
  MAX_TRANSACTION_STATE_BYTES,
  type TransactionAdapter,
  type TransactionArtifactKind,
  type TransactionArtifactLock,
  TransactionFailure,
  type TransactionMutationKind,
  TransactionPhysicalProgressError,
  type TransactionStateMoveCondition,
  TransactionStateReadLimitError,
  TransactionStateReadSecurityError,
} from './transaction-types.js';

const ARTIFACT_ROOTS: Record<TransactionArtifactKind, string> = {
  profile: 'profiles',
  skill: 'skills',
  preset: '.agent-presets',
  'store-directory': '.dshpack/store',
  'generation-directory': '.dshpack/generations',
  'installed-directory': '.dshpack/installed',
  'store-block': '.dshpack/store',
  generation: '.dshpack/generations',
};

const STORE_DIGEST = /^sha256-[A-Za-z0-9_-]{43}$/u;
const MAX_GENERATION_CURRENT_BYTES = 128;
const SETUP_DIRECTORY = /^\.setup-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const SETUP_JOURNAL_TEMPORARY = /^journal\.json\.[0-9a-f]{12}\.tmp$/u;

function isCanonicalGenerationFile(leaf: string): boolean {
  const match = /^(\d+)\.json$/u.exec(leaf);
  if (match === null) return false;
  const sequence = Number(match[1]);
  return (
    Number.isSafeInteger(sequence) &&
    sequence > 0 &&
    leaf === `${String(sequence).padStart(4, '0')}.json`
  );
}

function isCanonicalActionId(leaf: string): boolean {
  const match = /^action-(\d+)$/u.exec(leaf);
  if (match === null) return false;
  const value = Number(match[1]);
  return (
    Number.isSafeInteger(value) && value > 0 && leaf === `action-${String(value).padStart(4, '0')}`
  );
}

function gcQuarantineActionId(leaf: string): string | undefined {
  if (isCanonicalActionId(leaf)) return leaf;
  const match = /^(action-\d+)\.purging-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.exec(leaf);
  const actionId = match?.[1];
  return actionId !== undefined && isCanonicalActionId(actionId) ? actionId : undefined;
}

function isGcTransactionId(value: string): boolean {
  return /^gc-[A-Za-z0-9][A-Za-z0-9._-]{0,124}$/u.test(value);
}

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

/**
 * Case-insensitive filesystems can bind a canonical `store/db` request to an older physical
 * `store/DB` directory. The shard leaf is part of the portable CAS format, so check the resolved
 * leaf exactly while leaving ancestor aliases (including 8.3 spellings) alone.
 */
async function assertCanonicalCasStoreShardDirectory(
  path: string,
  expectedShard: string,
  failure: TransactionFailure,
): Promise<void> {
  try {
    const resolved = await realpath(path);
    if (!isExactCasStoreShardLeaf(basename(resolved), expectedShard)) throw failure;
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
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
  if (kind === 'managed-document') {
    const installed = join(home, '.dshpack', 'installed');
    const child = relative(installed, resolve(path));
    const failure = scopeFailure('E_TRANSACTION_MANAGED_DOCUMENT_PATH_SCOPE', path);
    const stem = child.endsWith('.json') ? child.slice(0, -'.json'.length) : '';
    if (
      child === '' ||
      isAbsolute(child) ||
      dirname(child) !== '.' ||
      !isInstallableProfileName(stem)
    ) {
      throw failure;
    }
    await assertCanonicalMapping(
      installed,
      join(canonicalHome, '.dshpack', 'installed'),
      path,
      failure,
    );
    return;
  }
  if (kind === 'store-directory') {
    const store = join(home, ARTIFACT_ROOTS['store-directory']);
    const child = relative(store, resolve(path));
    const failure = scopeFailure('E_TRANSACTION_STORE_DIRECTORY_SCOPE', path);
    if (
      child !== '' &&
      (isAbsolute(child) || dirname(child) !== '.' || !/^[a-z0-9_-]{2}$/u.test(child))
    ) {
      throw failure;
    }
    await assertCanonicalMapping(store, join(canonicalHome, '.dshpack', 'store'), path, failure);
    if (child !== '') await assertCanonicalCasStoreShardDirectory(path, child, failure);
    return;
  }
  if (kind === 'generation-directory') {
    const generations = join(home, ARTIFACT_ROOTS['generation-directory']);
    const child = relative(generations, resolve(path));
    const failure = scopeFailure('E_TRANSACTION_GENERATION_DIRECTORY_SCOPE', path);
    if (
      child !== '' &&
      (isAbsolute(child) || dirname(child) !== '.' || !isInstallableProfileName(child))
    ) {
      throw failure;
    }
    await assertCanonicalMapping(
      generations,
      join(canonicalHome, '.dshpack', 'generations'),
      path,
      failure,
    );
    return;
  }
  if (kind === 'installed-directory') {
    const installed = join(home, ARTIFACT_ROOTS['installed-directory']);
    const failure = scopeFailure('E_TRANSACTION_INSTALLED_DIRECTORY_SCOPE', path);
    if (!samePath(path, installed)) throw failure;
    await assertCanonicalMapping(
      installed,
      join(canonicalHome, '.dshpack', 'installed'),
      path,
      failure,
    );
    return;
  }
  if (kind === 'store-block') {
    const store = join(home, ARTIFACT_ROOTS['store-block']);
    const child = relative(store, resolve(path));
    const failure = scopeFailure('E_TRANSACTION_STORE_PATH_SCOPE', path);
    const parts = child.split(sep);
    const digest = parts[1];
    if (
      parts.length !== 2 ||
      parts.some((part) => part === '' || part === '.' || part === '..') ||
      digest === undefined ||
      !STORE_DIGEST.test(digest) ||
      !isCanonicalCasStoreShard(parts[0] ?? '', digest)
    ) {
      throw failure;
    }
    await assertCanonicalMapping(store, join(canonicalHome, '.dshpack', 'store'), path, failure);
    await assertCanonicalCasStoreShardDirectory(dirname(path), casStoreShard(digest), failure);
    return;
  }
  if (kind === 'generation' || kind === 'generation-current') {
    const generations = join(home, '.dshpack', 'generations');
    const child = relative(generations, resolve(path));
    const failure = scopeFailure('E_TRANSACTION_GENERATION_PATH_SCOPE', path);
    const parts = child.split(sep);
    const profile = parts[0];
    const leaf = parts[1];
    const validLeaf =
      kind === 'generation-current'
        ? leaf === 'current'
        : leaf !== undefined && isCanonicalGenerationFile(leaf);
    if (
      parts.length !== 2 ||
      profile === undefined ||
      !isInstallableProfileName(profile) ||
      !validLeaf
    ) {
      throw failure;
    }
    await assertCanonicalMapping(
      generations,
      join(canonicalHome, '.dshpack', 'generations'),
      path,
      failure,
    );
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

/** Bind one setup/published transaction directory to a stable direct child of backups. */
async function validateTransactionBackupPath(
  lock: TransactionArtifactLock,
  path: string,
): Promise<void> {
  const home = resolve(lock.dshHome);
  const backupRoot = join(home, '.dshpack', 'backups');
  const child = relative(backupRoot, resolve(path));
  const failure = scopeFailure('E_TRANSACTION_BACKUP_SCOPE', path);
  if (child === '' || isAbsolute(child) || dirname(child) !== '.') throw failure;
  await assertCanonicalMapping(
    backupRoot,
    join(await realpath(home), '.dshpack', 'backups'),
    path,
    failure,
  );
}

function setupRecoveryFailure(path: string, message: string): TransactionFailure {
  return new TransactionFailure(EXIT_CODES.SECURITY, [
    {
      code: 'E_TRANSACTION_SETUP_RECOVERY_SCOPE',
      severity: 'error',
      message,
      hint: 'Inspect the provisional transaction setup directory before retrying.',
      path,
      evidence: 'local',
    },
  ]);
}

interface UnpublishedSetupJournal {
  readonly dshHome: string;
  readonly backupDirectory: string;
  readonly txid: string;
}

function parseUnpublishedSetupJournal(bytes: Uint8Array): UnpublishedSetupJournal | undefined {
  const text = Buffer.from(bytes).toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const journal = value as Record<string, unknown>;
    if (
      journal.version === 0 &&
      typeof journal.txid === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(journal.txid) &&
      journal.txid !== '.' &&
      journal.txid !== '..' &&
      typeof journal.dshHome === 'string' &&
      typeof journal.backupDirectory === 'string' &&
      journal.backupDirectory === join(journal.dshHome, '.dshpack', 'backups', journal.txid) &&
      journal.state === 'active' &&
      Array.isArray(journal.actions) &&
      journal.actions.length === 0
    ) {
      return {
        dshHome: journal.dshHome,
        backupDirectory: journal.backupDirectory,
        txid: journal.txid,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function isUnpublishedSetupJournalForLock(
  bytes: Uint8Array,
  lock: TransactionArtifactLock,
): Promise<boolean> {
  const journal = parseUnpublishedSetupJournal(bytes);
  if (journal === undefined) return false;
  try {
    return samePath(await realpath(journal.dshHome), await realpath(lock.dshHome));
  } catch {
    return false;
  }
}

/** Safely discard only a crash-left provisional directory before it published any action. */
async function recoverTransactionSetupDirectories(
  lock: TransactionArtifactLock,
  dependencies: BoundedReadDependencies,
): Promise<void> {
  const home = resolve(lock.dshHome);
  const backupRoot = join(home, '.dshpack', 'backups');
  const rootFailure = scopeFailure('E_TRANSACTION_SETUP_RECOVERY_SCOPE', backupRoot);
  await assertCanonicalMapping(
    backupRoot,
    join(await realpath(home), '.dshpack', 'backups'),
    backupRoot,
    rootFailure,
  );
  let entries: Dirent<string>[];
  try {
    entries = await readdir(backupRoot, { encoding: 'utf8', withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw setupRecoveryFailure(backupRoot, 'transaction backup root cannot be enumerated safely.');
  }
  let recoveryStateChanged = false;
  const removeSetupFile = async (path: string, directory: string): Promise<void> => {
    await validateTransactionBackupPath(lock, directory);
    try {
      await removeFileDurable(path);
      recoveryStateChanged = true;
    } catch (error) {
      if (error instanceof DurableRemoveAfterUnlinkError) {
        throw new TransactionPhysicalProgressError(
          'provisional transaction setup file was unlinked without durable acknowledgement.',
          path,
          directory,
        );
      }
      throw error;
    }
  };
  const removeSetupDirectory = async (directory: string): Promise<void> => {
    await validateTransactionBackupPath(lock, directory);
    try {
      await removeDirectoryDurable(directory);
      recoveryStateChanged = true;
    } catch (error) {
      if (error instanceof DurableDirectoryRemoveError) {
        throw new TransactionPhysicalProgressError(
          'provisional transaction setup directory was removed without durable acknowledgement.',
          directory,
          backupRoot,
        );
      }
      throw error;
    }
  };
  try {
    for (const entry of entries) {
      if (!entry.name.startsWith('.setup-')) continue;
      const directory = join(backupRoot, entry.name);
      if (!SETUP_DIRECTORY.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        throw setupRecoveryFailure(directory, 'transaction setup directory has an unsafe shape.');
      }
      await validateTransactionBackupPath(lock, directory);
      const children = await readdir(directory, { encoding: 'utf8', withFileTypes: true });
      if (children.length === 0) {
        await removeSetupDirectory(directory);
        continue;
      }
      const onlyChild = children[0];
      if (
        children.length === 1 &&
        onlyChild !== undefined &&
        onlyChild.isFile() &&
        !onlyChild.isSymbolicLink() &&
        SETUP_JOURNAL_TEMPORARY.test(onlyChild.name)
      ) {
        const temporaryPath = join(directory, onlyChild.name);
        try {
          if (
            (await readBoundedTransactionStateFile(
              temporaryPath,
              dependencies,
              MAX_TRANSACTION_STATE_BYTES,
            )) === undefined
          ) {
            throw setupRecoveryFailure(temporaryPath, 'provisional journal temporary vanished.');
          }
        } catch (error) {
          if (error instanceof TransactionFailure) throw error;
          throw setupRecoveryFailure(
            temporaryPath,
            'provisional journal temporary cannot be read safely.',
          );
        }
        await removeSetupFile(temporaryPath, directory);
        await removeSetupDirectory(directory);
        continue;
      }
      if (
        children.length !== 1 ||
        onlyChild?.name !== 'journal.json' ||
        !onlyChild.isFile() ||
        onlyChild.isSymbolicLink()
      ) {
        throw setupRecoveryFailure(
          directory,
          'transaction setup directory contains unpublished unknown state.',
        );
      }
      const journalPath = join(directory, 'journal.json');
      let bytes: Uint8Array | undefined;
      try {
        bytes = await readBoundedTransactionStateFile(
          journalPath,
          dependencies,
          MAX_TRANSACTION_STATE_BYTES,
        );
      } catch {
        throw setupRecoveryFailure(journalPath, 'transaction setup journal cannot be read safely.');
      }
      if (bytes === undefined || !(await isUnpublishedSetupJournalForLock(bytes, lock))) {
        throw setupRecoveryFailure(
          journalPath,
          'transaction setup journal is not an unpublished active journal.',
        );
      }
      await removeSetupFile(journalPath, directory);
      await removeSetupDirectory(directory);
    }
  } catch (error) {
    if (error instanceof TransactionPhysicalProgressError) throw error;
    if (recoveryStateChanged) {
      throw new TransactionPhysicalProgressError(
        'provisional transaction setup recovery changed state before a later safety check failed.',
        backupRoot,
        backupRoot,
      );
    }
    throw error;
  }
}

/** Restrict permanent removal to an immutable payload from a committed GC action. */
async function validateGcQuarantinePath(
  lock: TransactionArtifactLock,
  path: string,
): Promise<void> {
  const home = resolve(lock.dshHome);
  const backupRoot = join(home, '.dshpack', 'backups');
  const child = relative(backupRoot, resolve(path));
  const parts = child.split(sep);
  const failure = scopeFailure('E_TRANSACTION_GC_QUARANTINE_SCOPE', path);
  if (
    parts.length !== 3 ||
    !isGcTransactionId(parts[0] ?? '') ||
    parts[1] !== 'old' ||
    gcQuarantineActionId(parts[2] ?? '') === undefined
  ) {
    throw failure;
  }
  await assertCanonicalMapping(
    backupRoot,
    join(await realpath(home), '.dshpack', 'backups'),
    path,
    failure,
  );
}

/**
 * Create a metadata ancestor chain durably without requiring new capabilities for an existing
 * DSH_HOME. Each component is exclusively created and its parent fsynced before proceeding, so a
 * post-create failure is reported as physical progress instead of being hidden by recursive mkdir.
 */
async function ensureDirectoryDurable(path: string): Promise<void> {
  const missing: string[] = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    try {
      await lstat(current);
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      missing.push(current);
      if (dirname(current) === current) throw error;
    }
  }
  let firstCreated: string | undefined;
  try {
    for (const directory of missing.reverse()) {
      if (await nodeFileSystemAdapter.createDirectoryExclusive(directory)) {
        firstCreated ??= directory;
      }
    }
  } catch (error) {
    if (firstCreated !== undefined) {
      throw new TransactionPhysicalProgressError(
        'a transaction metadata ancestor was created before a later durable create failed.',
        firstCreated,
        dirname(firstCreated),
      );
    }
    throw error;
  }
}

async function prepareMetadataDirectory(dshHome: string): Promise<string> {
  const home = resolve(dshHome);
  await ensureDirectoryDurable(home);
  const metadata = join(home, '.dshpack');
  const failure = scopeFailure('E_TRANSACTION_METADATA_PATH_SCOPE', metadata);
  const canonicalHome = await realpath(home);
  await assertCanonicalMapping(home, canonicalHome, metadata, failure);
  // Exclusive creation fsyncs the parent, unlike recursive mkdir: a fresh .dshpack entry must
  // survive power loss before a transaction can publish a backup below it.
  await nodeFileSystemAdapter.createDirectoryExclusive(metadata);
  await assertCanonicalMapping(home, canonicalHome, metadata, failure);
  const backups = join(metadata, 'backups');
  const backupFailure = scopeFailure('E_TRANSACTION_BACKUP_PATH_SCOPE', backups);
  const canonicalMetadata = join(canonicalHome, '.dshpack');
  await assertCanonicalMapping(metadata, canonicalMetadata, backups, backupFailure);
  await nodeFileSystemAdapter.createDirectoryExclusive(backups);
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

function sha256(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
}

/**
 * Read mutable transaction state through the same before/open/after path-and-handle stability
 * protocol as source capture. Metadata state permits a larger, but still bounded, 10 MiB block.
 */
export async function readBoundedTransactionStateFile(
  path: string,
  dependencies: BoundedReadDependencies = {},
  maximumBytes = MAX_TRANSACTION_STATE_BYTES,
): Promise<Uint8Array | undefined> {
  try {
    return await readBoundedRegularFile(path, dependencies, undefined, maximumBytes, true);
  } catch (error) {
    if (isMissing(error)) return undefined;
    if (error instanceof SnapshotCaptureError) {
      if (error.kind === 'limit') throw new TransactionStateReadLimitError(path, maximumBytes + 1);
      throw new TransactionStateReadSecurityError(path, error.message);
    }
    throw error;
  }
}

async function readBoundedGenerationCurrent(
  path: string,
  dependencies: BoundedReadDependencies = {},
): Promise<string | undefined> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await readBoundedTransactionStateFile(path, dependencies, MAX_GENERATION_CURRENT_BYTES);
  } catch (error) {
    if (error instanceof TransactionStateReadLimitError) {
      throw new TransactionFailure(EXIT_CODES.CONTRACT, [
        {
          code: 'E_GENERATION_CURRENT',
          severity: 'error',
          message: `generation current cannot be read safely: ${path}`,
          hint: 'Repair the current pointer before retrying.',
          path,
          evidence: 'local',
        },
      ]);
    }
    if (error instanceof TransactionStateReadSecurityError) {
      throw new TransactionFailure(EXIT_CODES.SECURITY, [
        {
          code: 'E_GENERATION_CURRENT',
          severity: 'error',
          message: `generation current cannot be read safely: ${path}`,
          hint: 'Repair the current pointer before retrying.',
          path,
          evidence: 'local',
        },
      ]);
    }
    throw error;
  }
  if (bytes === undefined) return undefined;
  const text = Buffer.from(bytes).toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) {
    throw new TransactionFailure(EXIT_CODES.CONTRACT, [
      {
        code: 'E_GENERATION_CURRENT',
        severity: 'error',
        message: `generation current is not valid UTF-8: ${path}`,
        hint: 'Repair the current pointer before retrying.',
        path,
        evidence: 'local',
      },
    ]);
  }
  return text;
}

async function readBoundedManagedDocument(
  path: string,
  dependencies: BoundedReadDependencies = {},
): Promise<string | undefined> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await readBoundedTransactionStateFile(path, dependencies);
  } catch (error) {
    if (error instanceof TransactionStateReadLimitError) {
      throw new TransactionFailure(EXIT_CODES.CONTRACT, [
        {
          code: 'E_MANAGED_DOCUMENT',
          severity: 'error',
          message: `installed metadata cannot be read safely: ${path}`,
          hint: 'Repair or remove the installed metadata before retrying.',
          path,
          evidence: 'local',
        },
      ]);
    }
    if (error instanceof TransactionStateReadSecurityError) {
      throw new TransactionFailure(EXIT_CODES.SECURITY, [
        {
          code: 'E_MANAGED_DOCUMENT',
          severity: 'error',
          message: `installed metadata cannot be read safely: ${path}`,
          hint: 'Repair or remove the installed metadata before retrying.',
          path,
          evidence: 'local',
        },
      ]);
    }
    throw error;
  }
  if (bytes === undefined) return undefined;
  const text = Buffer.from(bytes).toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) {
    throw new TransactionFailure(EXIT_CODES.CONTRACT, [
      {
        code: 'E_MANAGED_DOCUMENT',
        severity: 'error',
        message: `installed metadata is not valid UTF-8: ${path}`,
        hint: 'Repair or remove the installed metadata before retrying.',
        path,
        evidence: 'local',
      },
    ]);
  }
  return text;
}

async function readBoundedTransactionBackupText(
  path: string,
  dependencies: BoundedReadDependencies,
  maximumBytes: number,
): Promise<string> {
  const bytes = await readBoundedTransactionStateFile(path, dependencies, maximumBytes);
  if (bytes === undefined) throw new Error(`transaction backup document is missing: ${path}`);
  const text = Buffer.from(bytes).toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) {
    throw new TransactionStateReadSecurityError(path, 'transaction backup is not valid UTF-8');
  }
  return text;
}

async function stateConditionMatches(
  path: string,
  condition: TransactionStateMoveCondition | undefined,
  dependencies: BoundedReadDependencies = {},
): Promise<boolean> {
  if (condition === undefined) return true;
  if (condition.contentSha256 !== undefined) {
    const bytes = await readBoundedTransactionStateFile(path, dependencies);
    return bytes !== undefined && sha256(bytes) === condition.contentSha256;
  }
  if (condition.empty === true) return (await readdir(path)).length === 0;
  return true;
}

interface NodeTransactionAdapterTestHooks {
  /** Test-only deterministic interleaving after a state rollback rename and before post-move proof. */
  afterStateMoveRename?(from: string, to: string): Promise<void>;
  /** Test-only deterministic interleaving after a GC quarantine rename and before purge proof. */
  afterGcQuarantineRename?(from: string, to: string): Promise<void>;
  stateReadDependencies?: BoundedReadDependencies;
}

/** Production adapter with durable FS operations and settings-lock conditional mutations. */
export function createNodeTransactionAdapter(
  settingsOptions: YamlSettingsAdapterOptions = {},
  testHooks: NodeTransactionAdapterTestHooks = {},
): TransactionAdapter {
  const stateReadDependencies = testHooks.stateReadDependencies ?? {};
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
    async compareAndSwapGenerationCurrent(path, expected, replacement) {
      if ((await readBoundedGenerationCurrent(path, stateReadDependencies)) !== expected)
        return false;
      await writeFileAtomic(path, replacement, { mode: 0o600, dirMode: 0o700 });
      return true;
    },
    async readGenerationCurrent(path) {
      return readBoundedGenerationCurrent(path, stateReadDependencies);
    },
    async compareAndMoveGenerationCurrent(path, expected, destination) {
      if ((await readBoundedGenerationCurrent(path, stateReadDependencies)) !== expected)
        return false;
      if (await nodeFileSystemAdapter.pathExists(destination)) {
        throw new Error(`generation current rollback target exists: ${destination}`);
      }
      await nodeFileSystemAdapter.rename(path, destination);
      return true;
    },
    async readManagedDocument(path) {
      return readBoundedManagedDocument(path, stateReadDependencies);
    },
    async readTransactionBackupText(path, maximumBytes) {
      return readBoundedTransactionBackupText(path, stateReadDependencies, maximumBytes);
    },
    async compareAndSwapManagedDocument(path, expected, replacement) {
      if ((await readBoundedManagedDocument(path, stateReadDependencies)) !== expected)
        return false;
      await writeFileAtomic(path, replacement, { mode: 0o600, dirMode: 0o700 });
      return true;
    },
    async compareAndMoveManagedDocument(path, expected, destination) {
      if ((await readBoundedManagedDocument(path, stateReadDependencies)) !== expected)
        return false;
      if (await nodeFileSystemAdapter.pathExists(destination)) {
        throw new Error(`managed document rollback target exists: ${destination}`);
      }
      await nodeFileSystemAdapter.rename(path, destination);
      return true;
    },
    async readBytesIfExists(path) {
      return readBoundedTransactionStateFile(path, stateReadDependencies);
    },
    async writeExclusiveBytes(path, bytes) {
      return writeFileExclusive(path, bytes, { mode: 0o600, dirMode: 0o700 });
    },
    async isDirectoryEmpty(path) {
      return (await readdir(path)).length === 0;
    },
    async removeDirectoryIfEmpty(path) {
      try {
        await removeDirectoryDurable(path);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'ENOTEMPTY' || code === 'ENOENT') return false;
        throw error;
      }
    },
    async purgeGcQuarantineFile(lock, path, expectedSha256, expectedIdentity) {
      requireActiveLock(lock);
      await validateGcQuarantinePath(lock, path);
      const actionId = gcQuarantineActionId(path.split(sep).at(-1) ?? '');
      if (actionId === undefined) {
        throw scopeFailure('E_TRANSACTION_GC_QUARANTINE_SCOPE', path);
      }
      if ((await readPathIdentity(path)) !== expectedIdentity) return false;
      if (
        !(await stateConditionMatches(
          path,
          { contentSha256: expectedSha256 },
          stateReadDependencies,
        ))
      )
        return false;
      const purging = join(dirname(path), `${actionId}.purging-${randomUUID()}`);
      if (await nodeFileSystemAdapter.pathExists(purging)) {
        throw new Error(`GC quarantine temporary path already exists: ${purging}`);
      }
      const restorePurgingPayload = async (): Promise<void> => {
        try {
          // Never compensate through a lexical backup path after its canonical root has changed.
          await validateGcQuarantinePath(lock, path);
          await validateGcQuarantinePath(lock, purging);
          if (
            (await nodeFileSystemAdapter.pathExists(path)) ||
            !(await nodeFileSystemAdapter.pathExists(purging))
          ) {
            throw new Error('GC quarantine reverse rename no longer has its expected paths.');
          }
          await nodeFileSystemAdapter.rename(purging, path);
          await validateGcQuarantinePath(lock, path);
        } catch (_error) {
          throw new TransactionPhysicalProgressError(
            'GC quarantine reverse rename could not be safely proven after physical progress.',
            purging,
            path,
          );
        }
      };
      let moved = false;
      try {
        await nodeFileSystemAdapter.rename(path, purging);
        moved = true;
        await testHooks.afterGcQuarantineRename?.(path, purging);
        const home = resolve(lock.dshHome);
        const backupRoot = join(home, '.dshpack', 'backups');
        await assertCanonicalMapping(
          backupRoot,
          join(await realpath(home), '.dshpack', 'backups'),
          purging,
          scopeFailure('E_TRANSACTION_GC_QUARANTINE_SCOPE', purging),
        );
        if (
          (await readPathIdentity(purging)) !== expectedIdentity ||
          !(await stateConditionMatches(
            purging,
            { contentSha256: expectedSha256 },
            stateReadDependencies,
          ))
        ) {
          await restorePurgingPayload();
          return false;
        }
        try {
          await removeFileDurable(purging);
        } catch (error) {
          if (error instanceof DurableRemoveAfterUnlinkError) {
            throw new TransactionPhysicalProgressError(
              'GC quarantine payload was unlinked but parent durability confirmation failed.',
            );
          }
          throw error;
        }
        return true;
      } catch (error) {
        if (error instanceof DurableRenameAfterMoveError) moved = true;
        if (moved) await restorePurgingPayload();
        if (error instanceof DurableRenameAfterMoveError) {
          throw new TransactionPhysicalProgressError(
            'GC quarantine payload was renamed but directory durability confirmation failed.',
          );
        }
        throw error;
      }
    },
    async moveArtifactPath(
      lock,
      artifact,
      artifactPath,
      backupPath,
      direction,
      expectedIdentity,
      stateCondition,
    ) {
      requireActiveLock(lock);
      await validateMutationPath(lock, artifact, artifactPath);
      await validateBackupPath(lock, backupPath);
      const from = direction === 'to-backup' ? artifactPath : backupPath;
      const to = direction === 'to-backup' ? backupPath : artifactPath;
      if (await nodeFileSystemAdapter.pathExists(to)) throw new Error(`move target exists: ${to}`);
      // Node exposes no cross-platform CAS-rename primitive. The DSH_HOME-wide lease is held from
      // before reservation through commit/rollback, so protocol participants cannot enter this
      // check→rename window. Raw non-cooperating filesystem writes remain outside that guarantee.
      if (expectedIdentity !== undefined && (await readPathIdentity(from)) !== expectedIdentity) {
        return false;
      }
      if (!(await stateConditionMatches(from, stateCondition, stateReadDependencies))) return false;
      let moved = false;
      try {
        await nodeFileSystemAdapter.rename(from, to);
        moved = true;
        if (stateCondition !== undefined) await testHooks.afterStateMoveRename?.(from, to);
        if (
          (expectedIdentity === undefined || (await readPathIdentity(to)) === expectedIdentity) &&
          (await stateConditionMatches(to, stateCondition, stateReadDependencies))
        )
          return true;
        // The post-rename bytes are no longer transaction-owned. Leave them in the journal
        // backup so rollback reports manual recovery instead of claiming byte-identical restore.
        return false;
      } catch (error) {
        if (error instanceof DurableRenameAfterMoveError) moved = true;
        const provenOriginal =
          moved &&
          !(await nodeFileSystemAdapter.pathExists(from)) &&
          (await nodeFileSystemAdapter.pathExists(to)) &&
          (expectedIdentity === undefined || (await readPathIdentity(to)) === expectedIdentity) &&
          (await stateConditionMatches(to, stateCondition, stateReadDependencies));
        if (provenOriginal) {
          try {
            await nodeFileSystemAdapter.rename(to, from);
          } catch (restoreError) {
            if (restoreError instanceof DurableRenameAfterMoveError) {
              throw new TransactionPhysicalProgressError(
                'state rename and its compensating rename both completed without durable acknowledgement.',
                from,
                to,
              );
            }
            throw restoreError;
          }
        }
        throw error;
      }
    },
    async pathIdentity(path) {
      return readPathIdentity(path);
    },
    async validateTransactionBackupPath(lock, path) {
      requireActiveLock(lock);
      await validateTransactionBackupPath(lock, path);
    },
    async recoverTransactionSetupDirectories(lock) {
      requireActiveLock(lock);
      await recoverTransactionSetupDirectories(lock, stateReadDependencies);
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
