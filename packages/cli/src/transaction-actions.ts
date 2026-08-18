import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { EXIT_CODES } from './exit-codes.js';
import { actionId, diagnostic } from './transaction-journal.js';
import {
  type CreateJournalAction,
  type GenerationCurrentJournalAction,
  MAX_TRANSACTION_STATE_BYTES,
  type ManagedDocumentJournalAction,
  type ReplaceJournalAction,
  type SettingsJournalAction,
  type TransactionAdapter,
  type TransactionArtifactLock,
  type TransactionDirectoryArtifactKind,
  TransactionFailure,
  type TransactionJournal,
  type TransactionMutationKind,
  type TransactionStateDeletionKind,
  type TransactionStateDirectoryKind,
  type TransactionStateFileKind,
  TransactionStateReadLimitError,
  TransactionStateReadSecurityError,
} from './transaction-types.js';

interface ActionOptions {
  adapter: TransactionAdapter;
  backupDirectory: string;
  journal: TransactionJournal;
  lock: TransactionArtifactLock;
  persist(): Promise<void>;
}

function sha256(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function mapStateReadFailure(error: unknown, path: string): never {
  if (error instanceof TransactionStateReadLimitError) {
    throw new TransactionFailure(EXIT_CODES.CONTRACT, [
      diagnostic(
        'E_TRANSACTION_STATE_READ_LIMIT',
        `managed state exceeds the bounded read limit: ${path}`,
        'Inspect or remove the oversized state file before retrying.',
        path,
      ),
    ]);
  }
  if (error instanceof TransactionStateReadSecurityError) {
    throw new TransactionFailure(EXIT_CODES.SECURITY, [
      diagnostic(
        'E_TRANSACTION_STATE_READ_SECURITY',
        `managed state is not a stable regular file: ${path}`,
        'Inspect the state path for links, special files, hard links, or concurrent changes.',
        path,
      ),
    ]);
  }
  throw error;
}

async function verifyWrittenState(
  adapter: TransactionAdapter,
  path: string,
  expected: Uint8Array,
): Promise<void> {
  if (adapter.readBytesIfExists === undefined) {
    throw new TransactionFailure(EXIT_CODES.INTERNAL, [
      diagnostic(
        'E_TRANSACTION_STATE_ADAPTER',
        'transaction adapter does not support managed binary state reads.',
        'Use the production transaction adapter or explicitly provide safe byte reads in tests.',
        path,
      ),
    ]);
  }
  let actual: Uint8Array | undefined;
  try {
    actual = await adapter.readBytesIfExists(path);
  } catch (error) {
    mapStateReadFailure(error, path);
  }
  if (actual === undefined || sha256(actual) !== sha256(expected) || !sameBytes(actual, expected)) {
    throw new Error(`written state content is missing or changed: ${path}`);
  }
}

export async function createArtifact(
  options: ActionOptions,
  kind: TransactionDirectoryArtifactKind,
  path: string,
  apply: () => Promise<void>,
): Promise<void> {
  const { adapter, backupDirectory, journal, lock, persist } = options;
  await adapter.validateMutationPath(lock, kind, path);
  await adapter.ensureDirectory(dirname(path));
  const id = actionId(journal.actions.length + 1);
  const rollbackPath = join(backupDirectory, 'new', id);
  const action: CreateJournalAction = {
    id,
    kind: 'create',
    artifact: kind,
    ownership: 'pending',
    phase: 'planned',
    old: { path, exists: false },
    new: { path, exists: true, rollbackPath },
  };
  journal.actions.push(action);
  await adapter.ensureDirectory(dirname(rollbackPath));
  await persist();
  if (!(await adapter.createDirectoryExclusive(path))) {
    action.ownership = 'not-owned';
    await persist();
    throw new TransactionFailure(EXIT_CODES.PROFILE_CONFLICT_OR_LOCK, [
      diagnostic(
        'E_TRANSACTION_CREATE_CONFLICT',
        '事务不能把既有路径记作本事务新建项。',
        '跳过同名 skill/preset，或先使用明确的 replace 流程。',
        path,
      ),
    ]);
  }
  const identity = await adapter.pathIdentity(path);
  if (identity === undefined) throw new Error(`reserved artifact is missing: ${path}`);
  action.new.identity = identity;
  action.ownership = 'owned';
  await persist();
  await apply();
  action.phase = 'applied';
  await persist();
}

/** Reserve a state parent directory and only remove it later when it remains empty and owned. */
async function ensureStateDirectory(
  options: ActionOptions,
  kind: TransactionStateDirectoryKind,
  path: string,
): Promise<void> {
  const { adapter, backupDirectory, journal, lock, persist } = options;
  await adapter.validateMutationPath(lock, kind, path);
  const id = actionId(journal.actions.length + 1);
  const rollbackPath = join(backupDirectory, 'new', id);
  const action: CreateJournalAction = {
    id,
    kind: 'create',
    artifact: kind,
    ownership: 'pending',
    phase: 'planned',
    old: { path, exists: false },
    new: { path, exists: true, rollbackPath, emptyOnRollback: true },
  };
  journal.actions.push(action);
  await adapter.ensureDirectory(dirname(rollbackPath));
  await persist();
  if (!(await adapter.createDirectoryExclusive(path))) {
    action.ownership = 'not-owned';
    action.phase = 'applied';
    await persist();
    return;
  }
  // A parent can be swapped after the exclusive mkdir. Rebind it before recording ownership.
  await adapter.validateMutationPath(lock, kind, path);
  const identity = await adapter.pathIdentity(path);
  if (identity === undefined) throw new Error(`reserved state directory is missing: ${path}`);
  action.new.identity = identity;
  action.ownership = 'owned';
  await persist();
  action.phase = 'applied';
  await persist();
}

async function ensureStateFileParent(
  options: ActionOptions,
  kind: TransactionStateFileKind,
  path: string,
): Promise<void> {
  const root =
    kind === 'store-block'
      ? join(options.lock.dshHome, '.dshpack', 'store')
      : join(options.lock.dshHome, '.dshpack', 'generations');
  const directoryKind = kind === 'store-block' ? 'store-directory' : 'generation-directory';
  await ensureStateDirectory(options, directoryKind, root);
  await ensureStateDirectory(options, directoryKind, dirname(path));
}

async function ensureDocumentParent(
  options: ActionOptions,
  kind: Extract<TransactionMutationKind, 'managed-document' | 'generation-current'>,
  path: string,
): Promise<void> {
  const root =
    kind === 'managed-document'
      ? join(options.lock.dshHome, '.dshpack', 'installed')
      : join(options.lock.dshHome, '.dshpack', 'generations');
  const directoryKind =
    kind === 'managed-document' ? 'installed-directory' : 'generation-directory';
  await ensureStateDirectory(options, directoryKind, root);
  if (dirname(path) !== root) await ensureStateDirectory(options, directoryKind, dirname(path));
}

/** Create one immutable, transaction-owned state file and remember how to remove it on rollback. */
export async function writeStateFile(
  options: ActionOptions,
  kind: TransactionStateFileKind,
  path: string,
  bytes: Uint8Array,
): Promise<boolean> {
  const { adapter, backupDirectory, journal, lock, persist } = options;
  if (bytes.byteLength > MAX_TRANSACTION_STATE_BYTES) {
    throw new TransactionFailure(EXIT_CODES.CONTRACT, [
      diagnostic(
        'E_TRANSACTION_STATE_READ_LIMIT',
        `managed state exceeds the bounded write limit: ${path}`,
        'Reduce the state payload before retrying; no state mutation was started.',
        path,
      ),
    ]);
  }
  if (adapter.writeExclusiveBytes === undefined) {
    throw new TransactionFailure(EXIT_CODES.INTERNAL, [
      diagnostic(
        'E_TRANSACTION_STATE_ADAPTER',
        'transaction adapter 不支持受管二进制状态写入。',
        '使用生产 transaction adapter，或为测试 adapter 显式实现安全的 exclusive bytes 写入。',
        path,
      ),
    ]);
  }
  await adapter.validateMutationPath(lock, kind, path);
  await ensureStateFileParent(options, kind, path);
  // mkdir may have created an ancestor, so prove that the final path is still canonical before
  // the exclusive write. This does not trust the spelling of a new store/generation directory.
  await adapter.validateMutationPath(lock, kind, path);
  const id = actionId(journal.actions.length + 1);
  const rollbackPath = join(backupDirectory, 'new', id);
  const action: CreateJournalAction = {
    id,
    kind: 'create',
    artifact: kind,
    ownership: 'pending',
    phase: 'planned',
    old: { path, exists: false },
    new: { path, exists: true, rollbackPath, contentSha256: sha256(bytes) },
  };
  journal.actions.push(action);
  await adapter.ensureDirectory(dirname(rollbackPath));
  // The pending journal entry must exist before a block or generation becomes visible.
  await persist();
  const written = await adapter.writeExclusiveBytes(path, bytes);
  if (!written) {
    action.ownership = 'not-owned';
    action.phase = 'applied';
    await persist();
    return false;
  }
  const identity = await adapter.pathIdentity(path);
  if (identity === undefined) throw new Error(`written state file is missing: ${path}`);
  await verifyWrittenState(adapter, path, bytes);
  action.new.identity = identity;
  action.ownership = 'owned';
  await persist();
  action.phase = 'applied';
  await persist();
  return true;
}

/** Move a verified immutable state file aside so rollback can restore its exact original bytes. */
export async function deleteStateFile(
  options: ActionOptions,
  kind: TransactionStateDeletionKind,
  path: string,
  expectedSha256: string,
  expectedIdentity: string,
): Promise<void> {
  const { adapter, backupDirectory, journal, lock, persist } = options;
  if (adapter.readBytesIfExists === undefined) {
    throw new TransactionFailure(EXIT_CODES.INTERNAL, [
      diagnostic(
        'E_TRANSACTION_STATE_ADAPTER',
        'transaction adapter does not support managed binary state reads.',
        'Use the production transaction adapter or explicitly provide safe byte reads in tests.',
        path,
      ),
    ]);
  }
  await adapter.validateMutationPath(lock, kind, path);
  const before = await adapter.pathIdentity(path);
  if (before === undefined || before !== expectedIdentity) {
    throw new TransactionFailure(EXIT_CODES.CONTRACT, [
      diagnostic(
        'E_TRANSACTION_STATE_CHANGED',
        'immutable transaction state changed before it could be collected.',
        'Rebuild the garbage-collection plan and retry; no state file was removed.',
        path,
      ),
    ]);
  }
  let bytes: Uint8Array | undefined;
  try {
    bytes = await adapter.readBytesIfExists(path);
  } catch (error) {
    mapStateReadFailure(error, path);
  }
  const after = await adapter.pathIdentity(path);
  if (after !== before || bytes === undefined || sha256(bytes) !== expectedSha256) {
    throw new TransactionFailure(EXIT_CODES.CONTRACT, [
      diagnostic(
        'E_TRANSACTION_STATE_CHANGED',
        'immutable transaction state changed before it could be collected.',
        'Rebuild the garbage-collection plan and retry; no state file was removed.',
        path,
      ),
    ]);
  }
  const id = actionId(journal.actions.length + 1);
  const preservedAt = join(backupDirectory, 'old', id);
  await adapter.ensureDirectory(dirname(preservedAt));
  const action: ReplaceJournalAction = {
    id,
    kind: 'replace',
    artifact: kind,
    phase: 'planned',
    old: { path, exists: true, identity: before, contentSha256: expectedSha256 },
    new: { path, exists: false, preservedAt },
  };
  journal.actions.push(action);
  // The durable intent is written before the only forward move.
  await persist();
  const moved = await adapter.moveArtifactPath(
    lock,
    kind,
    path,
    preservedAt,
    'to-backup',
    expectedIdentity,
    { contentSha256: expectedSha256 },
  );
  if (!moved) {
    throw new TransactionFailure(EXIT_CODES.CONTRACT, [
      diagnostic(
        'E_TRANSACTION_STATE_CHANGED',
        'immutable transaction state changed while it was being collected.',
        'Rebuild the garbage-collection plan and retry; no state file was removed.',
        path,
      ),
    ]);
  }
  action.phase = 'applied';
  await persist();
}

/**
 * Remove an installed marker only after proving the caller's secure text and identity are still
 * current. The marker is renamed into the transaction backup, never unlinked directly.
 */
export async function deleteManagedDocument(
  options: ActionOptions,
  path: string,
  expectedDocument: string,
  expectedIdentity: string,
): Promise<void> {
  const { adapter, backupDirectory, journal, lock, persist } = options;
  if (adapter.readManagedDocument === undefined) {
    throw new TransactionFailure(EXIT_CODES.INTERNAL, [
      diagnostic(
        'E_TRANSACTION_STATE_ADAPTER',
        'transaction adapter does not support bounded installed metadata reads.',
        'Use the production transaction adapter or explicitly provide a bounded reader in tests.',
        path,
      ),
    ]);
  }
  await adapter.validateMutationPath(lock, 'managed-document', path);
  const current = await adapter.readManagedDocument(path);
  const identity = await adapter.pathIdentity(path);
  if (current !== expectedDocument || identity !== expectedIdentity) {
    throw new TransactionFailure(EXIT_CODES.CONTRACT, [
      diagnostic(
        'E_TRANSACTION_MANAGED_DOCUMENT_CHANGED',
        'installed metadata changed after the caller captured its secure snapshot.',
        'Read the installed metadata again and retry the operation.',
        path,
      ),
    ]);
  }
  const id = actionId(journal.actions.length + 1);
  const preservedAt = join(backupDirectory, 'old', id);
  const contentSha256 = sha256(Buffer.from(expectedDocument, 'utf8'));
  await adapter.ensureDirectory(dirname(preservedAt));
  const action: ReplaceJournalAction = {
    id,
    kind: 'replace',
    artifact: 'managed-document',
    phase: 'planned',
    old: {
      path,
      exists: true,
      identity,
      contentSha256,
    },
    new: { path, exists: false, preservedAt },
  };
  journal.actions.push(action);
  await persist();
  const moved = await adapter.moveArtifactPath(
    lock,
    'managed-document',
    path,
    preservedAt,
    'to-backup',
    expectedIdentity,
    { contentSha256 },
  );
  if (!moved) {
    throw new TransactionFailure(EXIT_CODES.CONTRACT, [
      diagnostic(
        'E_TRANSACTION_MANAGED_DOCUMENT_CHANGED',
        'installed metadata changed while it was being removed.',
        'Read the installed metadata again and retry the operation.',
        path,
      ),
    ]);
  }
  action.phase = 'applied';
  await persist();
}

export async function replaceArtifact(
  options: ActionOptions,
  kind: TransactionDirectoryArtifactKind,
  path: string,
  expectedIdentity?: string,
): Promise<void> {
  const { adapter, backupDirectory, journal, lock, persist } = options;
  await adapter.validateMutationPath(lock, kind, path);
  const identity = await adapter.pathIdentity(path);
  if (identity === undefined) {
    throw new TransactionFailure(EXIT_CODES.PROFILE_CONFLICT_OR_LOCK, [
      diagnostic(
        'E_TRANSACTION_REPLACE_MISSING',
        `replace 目标 ${kind} 不存在。`,
        '移除 replace 选项，或确认目标路径。',
        path,
      ),
    ]);
  }
  if (expectedIdentity !== undefined && identity !== expectedIdentity) {
    throw new TransactionFailure(EXIT_CODES.CONTRACT, [
      diagnostic(
        'E_TRANSACTION_REPLACE_CHANGED',
        `planned ${kind} changed after the locked uninstall scan.`,
        'Rebuild the uninstall plan; the replacement was not removed.',
        path,
      ),
    ]);
  }
  const id = actionId(journal.actions.length + 1);
  const preservedAt = join(backupDirectory, 'old', id);
  await adapter.ensureDirectory(dirname(preservedAt));
  const action: ReplaceJournalAction = {
    id,
    kind: 'replace',
    artifact: kind,
    phase: 'planned',
    // Persist the observed directory identity as the rollback CAS too.  A failed forward
    // move must not restore a different payload that appeared in the quarantine meanwhile.
    old: { path, exists: true, identity },
    new: { path, exists: false, preservedAt },
  };
  journal.actions.push(action);
  // This durable journal entry must precede the only forward rename.
  await persist();
  if (!(await adapter.moveArtifactPath(lock, kind, path, preservedAt, 'to-backup', identity))) {
    throw new TransactionFailure(EXIT_CODES.CONTRACT, [
      diagnostic(
        'E_TRANSACTION_REPLACE_CHANGED',
        `planned ${kind} changed while it was being removed.`,
        'Rebuild the uninstall plan; the replacement was not removed.',
        path,
      ),
    ]);
  }
  action.phase = 'applied';
  await persist();
}

type DocumentAction =
  | SettingsJournalAction
  | ManagedDocumentJournalAction
  | GenerationCurrentJournalAction;

function assertManagedDocumentWriteSize(path: string, document: string): void {
  if (Buffer.byteLength(document, 'utf8') <= MAX_TRANSACTION_STATE_BYTES) return;
  throw new TransactionFailure(EXIT_CODES.CONTRACT, [
    diagnostic(
      'E_MANAGED_DOCUMENT',
      `installed metadata exceeds the bounded write limit: ${path}`,
      'Reduce the metadata document before retrying; no state mutation was started.',
      path,
    ),
  ]);
}

export async function writeDocument(
  options: ActionOptions,
  documentKind: Extract<
    TransactionMutationKind,
    'settings' | 'managed-document' | 'generation-current'
  >,
  path: string,
  newDocument: string,
  callerExpected?: string,
): Promise<void> {
  const { adapter, backupDirectory, journal, lock, persist } = options;
  if (documentKind === 'managed-document') assertManagedDocumentWriteSize(path, newDocument);
  await adapter.validateMutationPath(lock, documentKind, path);
  if (documentKind === 'generation-current') {
    if (adapter.readGenerationCurrent === undefined) {
      throw new TransactionFailure(EXIT_CODES.INTERNAL, [
        diagnostic(
          'E_TRANSACTION_STATE_ADAPTER',
          'transaction adapter does not support bounded generation current reads.',
          'Use the production transaction adapter or explicitly provide a bounded reader in tests.',
          path,
        ),
      ]);
    }
    if ((await adapter.readGenerationCurrent(path)) !== callerExpected) {
      throw new TransactionFailure(EXIT_CODES.CONTRACT, [
        diagnostic(
          'E_TRANSACTION_GENERATION_CURRENT_CHANGED',
          'generation current changed after the caller captured its expected document.',
          'Read the current pointer again and retry the operation.',
          path,
        ),
      ]);
    }
  }
  if (documentKind === 'managed-document' || documentKind === 'generation-current') {
    await ensureDocumentParent(options, documentKind, path);
  } else {
    await adapter.ensureDirectory(dirname(path));
  }
  await adapter.validateMutationPath(lock, documentKind, path);
  let observedDocument: string | undefined;
  if (documentKind === 'generation-current') observedDocument = callerExpected;
  else if (documentKind === 'managed-document') {
    if (adapter.readManagedDocument === undefined)
      throw new TransactionFailure(EXIT_CODES.INTERNAL, [
        diagnostic(
          'E_TRANSACTION_STATE_ADAPTER',
          'transaction adapter does not support bounded managed document reads.',
          'Use the production transaction adapter or explicitly provide a bounded reader in tests.',
          path,
        ),
      ]);
    try {
      observedDocument = await adapter.readManagedDocument(path);
    } catch (error) {
      if (error instanceof TransactionFailure) throw error;
      try {
        mapStateReadFailure(error, path);
      } catch (mapped) {
        if (mapped instanceof TransactionFailure) throw mapped;
      }
      throw new TransactionFailure(EXIT_CODES.SECURITY, [
        diagnostic(
          'E_TRANSACTION_STATE_READ_SECURITY',
          'installed metadata could not be read as stable managed state.',
          'Inspect the installed metadata path for links, special files, or concurrent changes.',
          path,
        ),
      ]);
    }
  } else observedDocument = await adapter.readTextIfExists(path);
  if (
    (documentKind === 'settings' || documentKind === 'managed-document') &&
    callerExpected !== undefined &&
    observedDocument !== callerExpected
  ) {
    throw new TransactionFailure(EXIT_CODES.CONTRACT, [
      diagnostic(
        documentKind === 'managed-document'
          ? 'E_TRANSACTION_MANAGED_DOCUMENT_CHANGED'
          : documentKind === 'settings'
            ? 'E_TRANSACTION_SETTINGS_CHANGED'
            : 'E_TRANSACTION_GENERATION_CURRENT_CHANGED',
        documentKind === 'managed-document'
          ? 'installed metadata changed after the caller captured its expected document.'
          : documentKind === 'settings'
            ? `${path} 在 settings 候选文档生成后被其他写入者修改。`
            : `${path} 在 generation current 读取后被其他写入者修改。`,
        documentKind === 'managed-document'
          ? 'Read the installed metadata again and retry the operation.'
          : documentKind === 'settings'
            ? '重新读取最新 settings 文档、重新生成候选内容后再试。'
            : '重新读取 current 指针后再试。',
        path,
      ),
    ]);
  }
  const originalDocument =
    documentKind === 'managed-document' && callerExpected !== undefined
      ? callerExpected
      : observedDocument;
  const id = actionId(journal.actions.length + 1);
  const label =
    documentKind === 'settings'
      ? 'settings'
      : documentKind === 'managed-document'
        ? 'managed'
        : 'generation-current';
  const documentPath = join(backupDirectory, 'documents', `${id}-${label}-original`);
  const newDocumentPath = join(backupDirectory, 'documents', `${id}-${label}-new`);
  const rollbackPath = join(backupDirectory, 'new', `${id}-${label}`);
  await adapter.ensureDirectory(dirname(documentPath));
  if (originalDocument !== undefined) await adapter.atomicWriteText(documentPath, originalDocument);
  await adapter.atomicWriteText(newDocumentPath, newDocument);
  const common = {
    id,
    writeState: 'pending' as const,
    phase: 'planned' as const,
    old:
      originalDocument === undefined
        ? ({ path, exists: false } as const)
        : ({ path, exists: true, documentPath } as const),
    new: { path, exists: true as const, documentPath: newDocumentPath, rollbackPath },
  };
  const action: DocumentAction =
    documentKind === 'settings'
      ? { ...common, kind: 'settings-write' }
      : documentKind === 'managed-document'
        ? { ...common, kind: 'managed-document-write' }
        : { ...common, kind: 'generation-current-write' };
  journal.actions.push(action);
  // Persist old/new document locations and the pending state before the CAS write.
  await persist();
  const expectedDocument =
    documentKind === 'settings' ||
    documentKind === 'generation-current' ||
    (documentKind === 'managed-document' && callerExpected !== undefined)
      ? callerExpected
      : originalDocument;
  const wrote =
    documentKind === 'generation-current'
      ? adapter.compareAndSwapGenerationCurrent === undefined
        ? (() => {
            throw new TransactionFailure(EXIT_CODES.INTERNAL, [
              diagnostic(
                'E_TRANSACTION_STATE_ADAPTER',
                'transaction adapter does not support bounded generation current writes.',
                'Use the production transaction adapter or explicitly provide a bounded writer in tests.',
                path,
              ),
            ]);
          })()
        : await adapter.compareAndSwapGenerationCurrent(path, expectedDocument, newDocument)
      : documentKind === 'managed-document'
        ? adapter.compareAndSwapManagedDocument === undefined
          ? (() => {
              throw new TransactionFailure(EXIT_CODES.INTERNAL, [
                diagnostic(
                  'E_TRANSACTION_STATE_ADAPTER',
                  'transaction adapter does not support bounded managed document writes.',
                  'Use the production transaction adapter or explicitly provide a bounded writer in tests.',
                  path,
                ),
              ]);
            })()
          : await adapter.compareAndSwapManagedDocument(path, expectedDocument, newDocument)
        : await adapter.compareAndSwapText(path, expectedDocument, newDocument);
  if (!wrote) {
    action.writeState = 'not-written';
    await persist();
    throw new TransactionFailure(EXIT_CODES.CONTRACT, [
      diagnostic(
        documentKind === 'settings'
          ? 'E_TRANSACTION_SETTINGS_CHANGED'
          : documentKind === 'generation-current'
            ? 'E_TRANSACTION_GENERATION_CURRENT_CHANGED'
            : 'E_TRANSACTION_MANAGED_DOCUMENT_CHANGED',
        `${path} 在事务读取后被其他写入者修改。`,
        documentKind === 'generation-current'
          ? '重新读取 current 指针后重试安装。'
          : '重新读取最新文档后重试安装。',
        path,
      ),
    ]);
  }
  action.writeState = 'written';
  await persist();
  action.phase = 'applied';
  await persist();
}
