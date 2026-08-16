import type { Diagnostic } from '@dshpack/core';

import type { ExitCode } from './exit-codes.js';

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
  createDirectoryExclusive(path: string): Promise<boolean>;
  ensureDirectory(path: string): Promise<void>;
  moveArtifactPath(
    lock: TransactionArtifactLock,
    artifact: TransactionArtifactKind,
    artifactPath: string,
    backupPath: string,
    direction: TransactionArtifactMoveDirection,
    expectedIdentity?: string,
  ): Promise<boolean>;
  pathIdentity(path: string): Promise<string | undefined>;
  pathExists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  readTextIfExists(path: string): Promise<string | undefined>;
  atomicWriteText(path: string, contents: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  validateMutationPath(
    lock: TransactionArtifactLock,
    kind: TransactionMutationKind,
    path: string,
  ): Promise<void>;
}

export type TransactionArtifactKind = 'profile' | 'skill' | 'preset';
export type TransactionMutationKind = TransactionArtifactKind | 'settings' | 'managed-document';
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
  new: { path: string; exists: true; rollbackPath: string; identity?: string };
}

export interface ReplaceJournalAction {
  id: string;
  kind: 'replace';
  artifact: TransactionArtifactKind;
  phase: TransactionPhase;
  old: { path: string; exists: true };
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

export type TransactionJournalAction =
  | CreateJournalAction
  | ReplaceJournalAction
  | SettingsJournalAction
  | ManagedDocumentJournalAction;

export interface TransactionJournal {
  version: 0;
  txid: string;
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
  create(kind: TransactionArtifactKind, path: string, apply: () => Promise<void>): Promise<void>;
  replaceArtifact(kind: TransactionArtifactKind, path: string): Promise<void>;
  replaceProfile(path: string): Promise<void>;
  writeManagedDocument(path: string, newDocument: string): Promise<void>;
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
