import type { Diagnostic } from '@dshpack/core';

import type { ExitCode } from './exit-codes.js';

export const MAX_TRANSACTION_STATE_BYTES = 10 * 1024 * 1024;

export class TransactionStateReadLimitError extends Error {
  constructor(
    readonly path: string,
    readonly bytes: number,
  ) {
    super(
      `managed transaction state exceeds ${String(MAX_TRANSACTION_STATE_BYTES)} bytes: ${path}`,
    );
    this.name = 'TransactionStateReadLimitError';
  }
}

export class TransactionStateReadSecurityError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`managed transaction state changed during bounded read: ${path}: ${reason}`);
    this.name = 'TransactionStateReadSecurityError';
  }
}

/**
 * A state mutation crossed an irreversible filesystem boundary but could not complete its
 * durability acknowledgement. Callers must not report a clean failure with no recovery state.
 */
export class TransactionPhysicalProgressError extends Error {
  constructor(
    message: string,
    readonly sourcePath?: string,
    readonly destinationPath?: string,
  ) {
    super(message);
    this.name = 'TransactionPhysicalProgressError';
  }
}

export interface TransactionStateMoveCondition {
  contentSha256?: string;
  empty?: true;
}

export interface TransactionArtifactLock {
  readonly dshHome: string;
  readonly lockPath: string;
  release(): Promise<void>;
}

export interface TransactionAdapter {
  acquireArtifactLock(dshHome: string): Promise<TransactionArtifactLock>;
  compareAndMoveText(path: string, expected: string, destination: string): Promise<boolean>;
  compareAndSwapText(
    path: string,
    expected: string | undefined,
    replacement: string,
  ): Promise<boolean>;
  /** Bounded compare-and-swap for generation current; never delegates to settings text I/O. */
  compareAndSwapGenerationCurrent?(
    path: string,
    expected: string | undefined,
    replacement: string,
  ): Promise<boolean>;
  /** Bounded read for generation current before any transaction document action is reserved. */
  readGenerationCurrent?(path: string): Promise<string | undefined>;
  /** Bounded compare-and-move for generation current rollback. */
  compareAndMoveGenerationCurrent?(
    path: string,
    expected: string,
    destination: string,
  ): Promise<boolean>;
  /** Bounded compare-and-swap for installed metadata; never delegates to settings text I/O. */
  readManagedDocument?(path: string): Promise<string | undefined>;
  /** Stable bounded reader for transaction-private rollback document backups. */
  readTransactionBackupText?(path: string, maximumBytes: number): Promise<string>;
  compareAndSwapManagedDocument?(
    path: string,
    expected: string | undefined,
    replacement: string,
  ): Promise<boolean>;
  /** Bounded compare-and-move for installed metadata rollback. */
  compareAndMoveManagedDocument?(
    path: string,
    expected: string,
    destination: string,
  ): Promise<boolean>;
  createDirectoryExclusive(path: string): Promise<boolean>;
  ensureDirectory(path: string): Promise<void>;
  moveArtifactPath(
    lock: TransactionArtifactLock,
    artifact: TransactionArtifactKind,
    artifactPath: string,
    backupPath: string,
    direction: TransactionArtifactMoveDirection,
    expectedIdentity?: string,
    stateCondition?: TransactionStateMoveCondition,
  ): Promise<boolean>;
  pathIdentity(path: string): Promise<string | undefined>;
  pathExists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  readTextIfExists(path: string): Promise<string | undefined>;
  /** Optional for compatibility with pre-M1 test adapters; state writes fail closed when absent. */
  readBytesIfExists?(path: string): Promise<Uint8Array | undefined>;
  atomicWriteText(path: string, contents: string): Promise<void>;
  /** Exclusive, durable binary creation used only for transaction-owned metadata state. */
  writeExclusiveBytes?(path: string, bytes: Uint8Array): Promise<boolean>;
  /** Check a transaction-owned state parent before it can be removed during rollback. */
  isDirectoryEmpty?(path: string): Promise<boolean>;
  /** Remove a transaction-owned, still-empty setup directory without touching existing content. */
  removeDirectoryIfEmpty?(path: string): Promise<boolean>;
  /**
   * Permanently remove a verified file from a committed GC quarantine. This is deliberately
   * adapter-only: transaction callbacks never receive a generic destructive purge capability.
   */
  purgeGcQuarantineFile?(
    lock: TransactionArtifactLock,
    path: string,
    expectedSha256: string,
    expectedIdentity: string,
  ): Promise<boolean>;
  rename(from: string, to: string): Promise<void>;
  /** Bind a transaction setup directory to the locked DSH_HOME backup root before each setup write. */
  validateTransactionBackupPath(lock: TransactionArtifactLock, path: string): Promise<void>;
  /** Remove only crash-left provisional setup directories that contain no transaction actions. */
  recoverTransactionSetupDirectories(lock: TransactionArtifactLock): Promise<void>;
  validateMutationPath(
    lock: TransactionArtifactLock,
    kind: TransactionMutationKind,
    path: string,
  ): Promise<void>;
}

export type TransactionUserArtifactKind = 'profile' | 'skill' | 'preset';
export type TransactionStateDirectoryKind =
  | 'store-directory'
  | 'generation-directory'
  | 'installed-directory';
/** Internal adapter/journal union; state parents are deliberately absent from TransactionContext. */
export type TransactionDirectoryArtifactKind =
  | TransactionUserArtifactKind
  | TransactionStateDirectoryKind;
export type TransactionStateFileKind = 'store-block' | 'generation';
/** Immutable files which may be journaled away by a destructive state operation. */
export type TransactionStateDeletionKind = TransactionStateFileKind | 'generation-current';
export type TransactionArtifactKind =
  | TransactionDirectoryArtifactKind
  | TransactionStateDeletionKind
  | 'managed-document';
export type TransactionMutationKind =
  | TransactionArtifactKind
  | 'settings'
  | 'managed-document'
  | 'generation-current';
export type TransactionArtifactMoveDirection = 'to-backup' | 'from-backup';
export type TransactionPhase = 'planned' | 'applied' | 'rolled-back' | 'rollback-failed';
export type TransactionState =
  | 'not-started'
  | 'active'
  | 'rolling-back'
  | 'committed'
  | 'rolled-back'
  | 'rollback-failed';

export interface CreateJournalAction {
  id: string;
  kind: 'create';
  artifact: TransactionArtifactKind;
  ownership: 'pending' | 'not-owned' | 'owned';
  phase: TransactionPhase;
  old: { path: string; exists: false };
  new: {
    path: string;
    exists: true;
    rollbackPath: string;
    identity?: string;
    contentSha256?: string;
    emptyOnRollback?: true;
  };
}

export interface ReplaceJournalAction {
  id: string;
  kind: 'replace';
  artifact: TransactionArtifactKind;
  phase: TransactionPhase;
  old: {
    path: string;
    exists: true;
    /** State-file deletion records the original identity and digest for a safe rollback move. */
    identity?: string;
    contentSha256?: string;
  };
  new: { path: string; exists: false; preservedAt: string };
}

export type DocumentJournalOld =
  | { path: string; exists: true; documentPath: string }
  | { path: string; exists: false };

export interface DocumentJournalNew {
  path: string;
  exists: true;
  documentPath: string;
  rollbackPath: string;
}

export interface SettingsJournalAction {
  id: string;
  kind: 'settings-write';
  writeState: 'pending' | 'not-written' | 'written';
  phase: TransactionPhase;
  old: DocumentJournalOld;
  new: DocumentJournalNew;
}

export interface ManagedDocumentJournalAction {
  id: string;
  kind: 'managed-document-write';
  writeState: 'pending' | 'not-written' | 'written';
  phase: TransactionPhase;
  old: DocumentJournalOld;
  new: DocumentJournalNew;
}

export interface GenerationCurrentJournalAction {
  id: string;
  kind: 'generation-current-write';
  writeState: 'pending' | 'not-written' | 'written';
  phase: TransactionPhase;
  old: DocumentJournalOld;
  new: DocumentJournalNew;
}

export type TransactionJournalAction =
  | CreateJournalAction
  | ReplaceJournalAction
  | SettingsJournalAction
  | ManagedDocumentJournalAction
  | GenerationCurrentJournalAction;

export interface TransactionJournal {
  version: 0;
  txid: string;
  /** Only state-collection transactions may create a quarantine eligible for permanent collection. */
  purpose?: 'gc' | 'uninstall-purge';
  dshHome: string;
  backupDirectory: string;
  state: TransactionState;
  actions: TransactionJournalAction[];
}

export interface ManualRecoveryStep {
  actionId: string;
  operation: 'rename' | 'atomic-write' | 'write-journal' | 'inspect-lock';
  sourcePath: string;
  destinationPath: string;
  reason: string;
}

export interface TransactionContext {
  readonly txid: string;
  readonly backupDirectory: string;
  readonly journalPath: string;
  create(
    kind: TransactionUserArtifactKind,
    path: string,
    apply: () => Promise<void>,
  ): Promise<void>;
  /** Move a planned user artifact only if its locked-scan identity is still current. */
  replaceArtifact(
    kind: TransactionUserArtifactKind,
    path: string,
    expectedIdentity?: string,
  ): Promise<void>;
  replaceProfile(path: string, expectedIdentity?: string): Promise<void>;
  artifactIdentity(kind: TransactionUserArtifactKind, path: string): Promise<string>;
  readStateBytes(path: string): Promise<Uint8Array | undefined>;
  writeStateFile(kind: TransactionStateFileKind, path: string, bytes: Uint8Array): Promise<boolean>;
  /** Remove an immutable generation or CAS block through the transaction journal. */
  deleteStateFile(
    kind: TransactionStateDeletionKind,
    path: string,
    expectedSha256: string,
    expectedIdentity: string,
  ): Promise<void>;
  /** Move a pre-read installed marker into this transaction's backup with exact CAS facts. */
  deleteManagedDocument(
    path: string,
    expectedDocument: string,
    expectedIdentity: string,
  ): Promise<void>;
  readGenerationCurrent(path: string): Promise<string | undefined>;
  writeGenerationCurrent(
    path: string,
    expectedDocument: string | undefined,
    newDocument: string,
  ): Promise<void>;
  /**
   * Atomically replace a managed marker.  Supplying `expectedDocument` binds the write to a
   * caller-owned preflight snapshot instead of silently adopting a concurrent writer's text.
   */
  writeManagedDocument(path: string, newDocument: string, expectedDocument?: string): Promise<void>;
  writeSettings(
    path: string,
    expectedDocument: string | undefined,
    newDocument: string,
  ): Promise<void>;
}

export interface TransactionResult<T> {
  ok: boolean;
  value?: T;
  diagnostics: readonly Diagnostic[];
  status: 'not-started' | 'committed' | 'rolled-back' | 'rollback-failed';
  exitCode: ExitCode;
  journal: TransactionJournal;
  journalPath: string;
  backupDirectory: string;
  manualRecovery: readonly ManualRecoveryStep[];
}

export interface RunTransactionOptions {
  adapter: TransactionAdapter;
  dshHome: string;
  txid: string;
  purpose?: 'gc' | 'uninstall-purge';
}

export class TransactionFailure extends Error {
  readonly exitCode: ExitCode;
  readonly diagnostics: readonly Diagnostic[];

  constructor(exitCode: ExitCode, diagnostics: readonly Diagnostic[]) {
    super(diagnostics[0]?.message ?? '事务步骤失败。');
    this.name = 'TransactionFailure';
    this.exitCode = exitCode;
    this.diagnostics = diagnostics;
  }
}
