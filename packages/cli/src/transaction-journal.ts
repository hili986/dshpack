import type { Diagnostic } from '@dshpack/core';

import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import {
  MAX_TRANSACTION_STATE_BYTES,
  type ManualRecoveryStep,
  type TransactionAdapter,
  type TransactionArtifactLock,
  TransactionFailure,
  type TransactionJournal,
  type TransactionJournalAction,
} from './transaction-types.js';

export interface NormalizedFailure {
  exitCode: ExitCode;
  diagnostics: readonly Diagnostic[];
}

export function diagnostic(code: string, message: string, hint: string, path?: string): Diagnostic {
  return {
    code,
    severity: 'error',
    message,
    ...(path === undefined ? {} : { path }),
    hint,
    evidence: 'local',
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeFailure(error: unknown): NormalizedFailure {
  if (error instanceof TransactionFailure) {
    return { exitCode: error.exitCode, diagnostics: error.diagnostics };
  }
  return {
    exitCode: EXIT_CODES.INTERNAL,
    diagnostics: [
      diagnostic(
        'E_TRANSACTION_ABORTED',
        `事务步骤失败：${errorMessage(error)}`,
        '检查 transaction 结果中的回滚状态和备份路径。',
      ),
    ],
  };
}

export function invalidTxidDiagnostic(txid: string): Diagnostic | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(txid) || txid === '.' || txid === '..') {
    return diagnostic(
      'E_TRANSACTION_ID',
      'transaction id 不是安全的单路径段。',
      '使用 1–128 位字母、数字、点、下划线或连字符。',
      txid,
    );
  }
  return undefined;
}

export function serializeJournal(journal: TransactionJournal): string {
  return `${JSON.stringify(journal, undefined, 2)}\n`;
}

export function actionId(index: number): string {
  return `action-${String(index).padStart(4, '0')}`;
}

export function recoveryStep(action: TransactionJournalAction, reason: string): ManualRecoveryStep {
  const documentAction =
    action.kind === 'settings-write' ||
    action.kind === 'managed-document-write' ||
    action.kind === 'generation-current-write';
  const sourcePath =
    action.kind === 'create'
      ? action.new.path
      : action.kind === 'replace'
        ? action.new.preservedAt
        : action.old.exists
          ? action.old.documentPath
          : action.new.path;
  const missingDocument = documentAction && !action.old.exists;
  return {
    actionId: action.id,
    operation: documentAction && !missingDocument ? 'atomic-write' : 'rename',
    sourcePath,
    destinationPath:
      action.kind === 'create' || missingDocument ? action.new.rollbackPath : action.old.path,
    reason,
  };
}

export async function rollbackAction(
  adapter: TransactionAdapter,
  lock: TransactionArtifactLock,
  action: TransactionJournalAction,
): Promise<void> {
  if (action.kind === 'create') {
    if (action.ownership === 'not-owned') return;
    try {
      await adapter.validateMutationPath(lock, action.artifact, action.new.path);
    } catch (error) {
      // A transaction-created state parent replaced by an escaped link is no longer ours to move.
      // Leaving the external replacement untouched is the only safe rollback action.
      if (
        action.new.emptyOnRollback === true &&
        error instanceof TransactionFailure &&
        error.exitCode === EXIT_CODES.SECURITY
      )
        return;
      throw error;
    }
    if (action.ownership === 'pending') {
      const currentIdentity = await adapter.pathIdentity(action.new.path);
      if (currentIdentity !== undefined) {
        throw new Error(`artifact ownership is unresolved: ${action.new.path}`);
      }
      return;
    }
    if (action.new.identity === undefined) {
      throw new Error(`owned artifact identity was not recorded: ${action.new.path}`);
    }
    const stateCondition =
      action.artifact === 'store-block' || action.artifact === 'generation'
        ? action.new.contentSha256 === undefined
          ? undefined
          : { contentSha256: action.new.contentSha256 }
        : action.new.emptyOnRollback === true
          ? { empty: true as const }
          : undefined;
    if (
      (action.artifact === 'store-block' || action.artifact === 'generation') &&
      stateCondition === undefined
    ) {
      throw new Error(`owned state content cannot be verified: ${action.new.path}`);
    }
    if (
      !(await adapter.moveArtifactPath(
        lock,
        action.artifact,
        action.new.path,
        action.new.rollbackPath,
        'to-backup',
        action.new.identity,
        stateCondition,
      ))
    ) {
      throw new Error(`owned artifact is missing or identity changed: ${action.new.path}`);
    }
    return;
  }
  if (
    action.kind === 'settings-write' ||
    action.kind === 'managed-document-write' ||
    action.kind === 'generation-current-write'
  ) {
    if (action.writeState === 'not-written') return;
    await adapter.validateMutationPath(
      lock,
      action.kind === 'settings-write'
        ? 'settings'
        : action.kind === 'managed-document-write'
          ? 'managed-document'
          : 'generation-current',
      action.new.path,
    );
    if (action.writeState === 'pending') {
      throw new Error(`settings write outcome is unresolved: ${action.new.path}`);
    }
    const readTransactionBackupText = adapter.readTransactionBackupText;
    if (readTransactionBackupText === undefined) {
      throw new Error('transaction adapter does not support bounded rollback backup reads');
    }
    const maximumBackupBytes =
      action.kind === 'generation-current-write' ? 128 : MAX_TRANSACTION_STATE_BYTES;
    const readBackup = (path: string): Promise<string> =>
      readTransactionBackupText.call(adapter, path, maximumBackupBytes);
    const expectedDocument = await readBackup(action.new.documentPath);
    const restored =
      action.kind === 'generation-current-write'
        ? action.old.exists
          ? adapter.compareAndSwapGenerationCurrent === undefined
            ? false
            : await adapter.compareAndSwapGenerationCurrent(
                action.old.path,
                expectedDocument,
                await readBackup(action.old.documentPath),
              )
          : adapter.compareAndMoveGenerationCurrent === undefined
            ? false
            : await adapter.compareAndMoveGenerationCurrent(
                action.old.path,
                expectedDocument,
                action.new.rollbackPath,
              )
        : action.kind === 'managed-document-write'
          ? action.old.exists
            ? adapter.compareAndSwapManagedDocument === undefined
              ? false
              : await adapter.compareAndSwapManagedDocument(
                  action.old.path,
                  expectedDocument,
                  await readBackup(action.old.documentPath),
                )
            : adapter.compareAndMoveManagedDocument === undefined
              ? false
              : await adapter.compareAndMoveManagedDocument(
                  action.old.path,
                  expectedDocument,
                  action.new.rollbackPath,
                )
          : action.old.exists
            ? await adapter.compareAndSwapText(
                action.old.path,
                expectedDocument,
                await readBackup(action.old.documentPath),
              )
            : await adapter.compareAndMoveText(
                action.old.path,
                expectedDocument,
                action.new.rollbackPath,
              );
    if (!restored) throw new Error(`settings changed after transaction write: ${action.new.path}`);
    return;
  }
  await adapter.validateMutationPath(lock, action.artifact, action.old.path);
  const preserved = await adapter.pathExists(action.new.preservedAt);
  const occupied = await adapter.pathExists(action.old.path);
  if (preserved && occupied) throw new Error(`restore target still exists: ${action.old.path}`);
  if (preserved) {
    await adapter.moveArtifactPath(
      lock,
      action.artifact,
      action.old.path,
      action.new.preservedAt,
      'from-backup',
    );
  } else if (!occupied) throw new Error(`preserved original is missing: ${action.new.preservedAt}`);
}
