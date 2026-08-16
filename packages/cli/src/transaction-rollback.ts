import type { Diagnostic } from '@dshpack/core';

import { EXIT_CODES } from './exit-codes.js';
import {
  diagnostic,
  errorMessage,
  normalizeFailure,
  recoveryStep,
  rollbackAction,
  serializeJournal,
} from './transaction-journal.js';
import {
  type ManualRecoveryStep,
  type TransactionAdapter,
  type TransactionArtifactLock,
  TransactionFailure,
  type TransactionJournal,
  type TransactionResult,
} from './transaction-types.js';

interface RollbackOptions {
  adapter: TransactionAdapter;
  artifactLock: TransactionArtifactLock | undefined;
  backupDirectory: string;
  failures: readonly unknown[];
  journal: TransactionJournal;
  journalPath: string;
}

export async function rollbackTransaction<T>(
  options: RollbackOptions,
): Promise<TransactionResult<T>> {
  const { adapter, backupDirectory, failures, journal, journalPath } = options;
  let artifactLock = options.artifactLock;
  const normalizedFailures = failures.map(normalizeFailure);
  const originalFailure = normalizedFailures[0] ?? normalizeFailure('transaction aborted');
  const operationDiagnostics = normalizedFailures.flatMap(({ diagnostics }) => diagnostics);
  const rollbackDiagnostics: Diagnostic[] = [];
  const manualRecovery: ManualRecoveryStep[] = [];
  const persist = (): Promise<void> =>
    adapter.atomicWriteText(journalPath, serializeJournal(journal));
  const reportJournalFailure = (error: unknown): void => {
    const reason = errorMessage(error);
    rollbackDiagnostics.push(
      diagnostic(
        'E_TRANSACTION_JOURNAL_WRITE_FAILED',
        `回滚 journal 写入失败：${reason}`,
        `人工检查并保存 journal：${journalPath}。`,
        journalPath,
      ),
    );
    manualRecovery.push({
      actionId: 'journal',
      operation: 'write-journal',
      sourcePath: journalPath,
      destinationPath: journalPath,
      reason,
    });
  };
  const reportLockFailure = (lock: TransactionArtifactLock, error: unknown): void => {
    const reason = errorMessage(error);
    rollbackDiagnostics.push(
      diagnostic(
        'E_TRANSACTION_ARTIFACT_LOCK_RELEASE_FAILED',
        `artifact lock 释放失败：${reason}`,
        `人工检查锁文件，绝不自动删除未知 owner：${lock.lockPath}。`,
        lock.lockPath,
      ),
    );
    manualRecovery.push({
      actionId: 'artifact-lock',
      operation: 'inspect-lock',
      sourcePath: lock.lockPath,
      destinationPath: lock.lockPath,
      reason,
    });
  };

  journal.state = 'rolling-back';
  try {
    await persist();
  } catch (error) {
    reportJournalFailure(error);
  }
  for (const action of [...journal.actions].reverse()) {
    try {
      if (artifactLock === undefined) throw new Error('artifact lock is unavailable');
      await rollbackAction(adapter, artifactLock, action);
    } catch (error) {
      const reason = errorMessage(error);
      action.phase = 'rollback-failed';
      const recovery = recoveryStep(action, reason);
      if (error instanceof TransactionFailure) rollbackDiagnostics.push(...error.diagnostics);
      rollbackDiagnostics.push(
        diagnostic(
          'E_TRANSACTION_ROLLBACK_FAILED',
          `回滚动作 ${action.id} 失败：${reason}`,
          `人工执行 ${recovery.operation} ${recovery.sourcePath} → ${recovery.destinationPath}。`,
          recovery.sourcePath,
        ),
      );
      manualRecovery.push(recovery);
      continue;
    }
    action.phase = 'rolled-back';
    try {
      await persist();
    } catch (error) {
      reportJournalFailure(error);
    }
  }

  journal.state = rollbackDiagnostics.length === 0 ? 'rolled-back' : 'rollback-failed';
  try {
    await persist();
  } catch (error) {
    journal.state = 'rollback-failed';
    reportJournalFailure(error);
  }
  if (artifactLock !== undefined) {
    const lock = artifactLock;
    artifactLock = undefined;
    try {
      await lock.release();
    } catch (error) {
      journal.state = 'rollback-failed';
      reportLockFailure(lock, error);
      try {
        await persist();
      } catch (journalError) {
        reportJournalFailure(journalError);
      }
    }
  }

  if (rollbackDiagnostics.length > 0) {
    return {
      ok: false,
      diagnostics: [...operationDiagnostics, ...rollbackDiagnostics],
      status: 'rollback-failed',
      exitCode: EXIT_CODES.POST_INSTALL_OR_ROLLBACK_FAILURE,
      journal,
      journalPath,
      backupDirectory,
      manualRecovery,
    };
  }
  return {
    ok: false,
    diagnostics: operationDiagnostics,
    status: 'rolled-back',
    exitCode: originalFailure.exitCode,
    journal,
    journalPath,
    backupDirectory,
    manualRecovery: [],
  };
}
