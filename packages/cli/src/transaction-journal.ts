import type { Diagnostic } from '@dshpack/core';

import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import {
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
  const sourcePath =
    action.kind === 'create'
      ? action.new.path
      : action.kind === 'replace'
        ? action.new.preservedAt
        : action.old.exists
          ? action.old.documentPath
          : action.new.path;
  const missingSettings = action.kind === 'settings-write' && !action.old.exists;
  return {
    actionId: action.id,
    operation: action.kind === 'settings-write' && !missingSettings ? 'atomic-write' : 'rename',
    sourcePath,
    destinationPath:
      action.kind === 'create' || missingSettings ? action.new.rollbackPath : action.old.path,
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
    await adapter.validateMutationPath(lock, action.artifact, action.new.path);
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
    if (
      !(await adapter.moveArtifactPath(
        lock,
        action.artifact,
        action.new.path,
        action.new.rollbackPath,
        'to-backup',
        action.new.identity,
      ))
    ) {
      throw new Error(`owned artifact is missing or identity changed: ${action.new.path}`);
    }
    return;
  }
  if (action.kind === 'settings-write') {
    if (action.writeState === 'not-written') return;
    await adapter.validateMutationPath(lock, 'settings', action.new.path);
    if (action.writeState === 'pending') {
      throw new Error(`settings write outcome is unresolved: ${action.new.path}`);
    }
    const expectedDocument = await adapter.readText(action.new.documentPath);
    const restored = action.old.exists
      ? await adapter.compareAndSwapText(
          action.old.path,
          expectedDocument,
          await adapter.readText(action.old.documentPath),
        )
      : await adapter.compareAndMoveText(
          action.old.path,
          expectedDocument,
          action.new.rollbackPath,
        );
    if (!restored) throw new Error(`settings changed after transaction write: ${action.new.path}`);
    return;
  }
  await adapter.validateMutationPath(lock, 'profile', action.old.path);
  const preserved = await adapter.pathExists(action.new.preservedAt);
  const occupied = await adapter.pathExists(action.old.path);
  if (preserved && occupied) throw new Error(`restore target still exists: ${action.old.path}`);
  if (preserved) {
    await adapter.moveArtifactPath(
      lock,
      'profile',
      action.old.path,
      action.new.preservedAt,
      'from-backup',
    );
  } else if (!occupied) throw new Error(`preserved original is missing: ${action.new.preservedAt}`);
}
