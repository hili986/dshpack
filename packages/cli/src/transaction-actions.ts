import { dirname, join } from 'node:path';

import { EXIT_CODES } from './exit-codes.js';
import { actionId, diagnostic } from './transaction-journal.js';
import {
  type CreateJournalAction,
  type ManagedDocumentJournalAction,
  type ReplaceJournalAction,
  type SettingsJournalAction,
  type TransactionAdapter,
  type TransactionArtifactKind,
  type TransactionArtifactLock,
  TransactionFailure,
  type TransactionJournal,
  type TransactionMutationKind,
} from './transaction-types.js';

interface ActionOptions {
  adapter: TransactionAdapter;
  backupDirectory: string;
  journal: TransactionJournal;
  lock: TransactionArtifactLock;
  persist(): Promise<void>;
}

export async function createArtifact(
  options: ActionOptions,
  kind: TransactionArtifactKind,
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

export async function replaceArtifact(
  options: ActionOptions,
  kind: TransactionArtifactKind,
  path: string,
): Promise<void> {
  const { adapter, backupDirectory, journal, lock, persist } = options;
  await adapter.validateMutationPath(lock, kind, path);
  if (!(await adapter.pathExists(path))) {
    throw new TransactionFailure(EXIT_CODES.PROFILE_CONFLICT_OR_LOCK, [
      diagnostic(
        'E_TRANSACTION_REPLACE_MISSING',
        `replace 目标 ${kind} 不存在。`,
        '移除 replace 选项，或确认目标路径。',
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
    old: { path, exists: true },
    new: { path, exists: false, preservedAt },
  };
  journal.actions.push(action);
  // This durable journal entry must precede the only forward rename.
  await persist();
  await adapter.moveArtifactPath(lock, kind, path, preservedAt, 'to-backup');
  action.phase = 'applied';
  await persist();
}

type DocumentAction = SettingsJournalAction | ManagedDocumentJournalAction;

export async function writeDocument(
  options: ActionOptions,
  documentKind: Extract<TransactionMutationKind, 'settings' | 'managed-document'>,
  path: string,
  newDocument: string,
  callerExpected?: string,
): Promise<void> {
  const { adapter, backupDirectory, journal, lock, persist } = options;
  await adapter.validateMutationPath(lock, documentKind, path);
  const originalDocument = await adapter.readTextIfExists(path);
  if (documentKind === 'settings' && originalDocument !== callerExpected) {
    throw new TransactionFailure(EXIT_CODES.CONTRACT, [
      diagnostic(
        'E_TRANSACTION_SETTINGS_CHANGED',
        `${path} 在 settings 候选文档生成后被其他写入者修改。`,
        '重新读取最新 settings 文档、重新生成候选内容后再试。',
        path,
      ),
    ]);
  }
  const id = actionId(journal.actions.length + 1);
  const label = documentKind === 'settings' ? 'settings' : 'managed';
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
      : { ...common, kind: 'managed-document-write' };
  journal.actions.push(action);
  // Persist old/new document locations and the pending state before the CAS write.
  await persist();
  const expectedDocument = documentKind === 'settings' ? callerExpected : originalDocument;
  if (!(await adapter.compareAndSwapText(path, expectedDocument, newDocument))) {
    action.writeState = 'not-written';
    await persist();
    throw new TransactionFailure(EXIT_CODES.CONTRACT, [
      diagnostic(
        documentKind === 'settings'
          ? 'E_TRANSACTION_SETTINGS_CHANGED'
          : 'E_TRANSACTION_MANAGED_DOCUMENT_CHANGED',
        `${path} 在事务读取后被其他写入者修改。`,
        '重新读取最新文档后重试安装。',
        path,
      ),
    ]);
  }
  action.writeState = 'written';
  await persist();
  action.phase = 'applied';
  await persist();
}
