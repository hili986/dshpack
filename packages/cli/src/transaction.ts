import { dirname, join, resolve } from 'node:path';
import { EXIT_CODES } from './exit-codes.js';
import {
  createArtifact,
  replaceArtifact,
  writeDocument,
  writeStateFile,
} from './transaction-actions.js';
import {
  diagnostic,
  errorMessage,
  invalidTxidDiagnostic,
  serializeJournal,
} from './transaction-journal.js';
import { rollbackTransaction } from './transaction-rollback.js';
import {
  type RunTransactionOptions,
  type TransactionArtifactLock,
  type TransactionContext,
  TransactionFailure,
  type TransactionJournal,
  type TransactionResult,
  type TransactionStateFileKind,
  TransactionStateReadLimitError,
  TransactionStateReadSecurityError,
} from './transaction-types.js';

export {
  createNodeTransactionAdapter,
  nodeTransactionAdapter,
} from './transaction-node-adapter.js';
export * from './transaction-types.js';

export async function runTransaction<T>(
  options: RunTransactionOptions,
  operation: (transaction: TransactionContext) => Promise<T>,
): Promise<TransactionResult<T>> {
  const { adapter, dshHome, txid } = options;
  const invalidTxid = invalidTxidDiagnostic(txid);
  const backupDirectory = join(
    dshHome,
    '.dshpack',
    'backups',
    invalidTxid === undefined ? txid : '_invalid',
  );
  const journalPath = join(backupDirectory, 'journal.json');
  const journal: TransactionJournal = {
    version: 0,
    txid,
    dshHome,
    backupDirectory,
    state: invalidTxid === undefined ? 'active' : 'not-started',
    actions: [],
  };
  const resultBase = { journal, journalPath, backupDirectory };
  if (invalidTxid !== undefined) {
    return {
      ...resultBase,
      ok: false,
      diagnostics: [invalidTxid],
      status: 'not-started',
      exitCode: EXIT_CODES.SECURITY,
      manualRecovery: [],
    };
  }
  const persist = async (): Promise<void> => {
    await adapter.atomicWriteText(journalPath, serializeJournal(journal));
  };
  let actionQueue = Promise.resolve();
  let actionFailed = false;
  let actionFailure: unknown;
  const serializeAction = async <R>(action: () => Promise<R>): Promise<R> => {
    const predecessor = actionQueue;
    let release = (): void => {};
    actionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    if (actionFailed) {
      release();
      throw actionFailure;
    }
    try {
      return await action();
    } catch (error) {
      actionFailed = true;
      actionFailure = error;
      throw error;
    } finally {
      release();
    }
  };
  let artifactLock: TransactionArtifactLock | undefined;
  const requireArtifactLock = (): TransactionArtifactLock => {
    if (artifactLock === undefined) throw new Error('artifact lock is unavailable');
    return artifactLock;
  };
  const readStateBytes = async (path: string): Promise<Uint8Array | undefined> => {
    if (adapter.readBytesIfExists === undefined) {
      throw new TransactionFailure(EXIT_CODES.INTERNAL, [
        diagnostic(
          'E_TRANSACTION_STATE_ADAPTER',
          'transaction adapter 不支持受管二进制状态读取。',
          '使用生产 transaction adapter，或为测试 adapter 显式实现安全的 bytes 读取。',
          path,
        ),
      ]);
    }
    try {
      return await adapter.readBytesIfExists(path);
    } catch (error) {
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
  };

  const assertGenerationCurrentDocument = (path: string, document: string): void => {
    if (
      Buffer.byteLength(document, 'utf8') > 128 ||
      !/^[1-9]\d*\n$/u.test(document) ||
      !Number.isSafeInteger(Number(document.slice(0, -1)))
    ) {
      throw new TransactionFailure(EXIT_CODES.CONTRACT, [
        diagnostic(
          'E_GENERATION_CURRENT',
          `generation current must be a bounded positive integer pointer: ${path}`,
          'Repair the current pointer before retrying; no state mutation was started.',
          path,
        ),
      ]);
    }
  };

  const transaction: TransactionContext = {
    txid,
    backupDirectory,
    journalPath,
    async create(kind, path, apply) {
      return serializeAction(() =>
        createArtifact(
          { adapter, backupDirectory, journal, lock: requireArtifactLock(), persist },
          kind,
          path,
          apply,
        ),
      );
    },
    async replaceArtifact(kind, path) {
      return serializeAction(() =>
        replaceArtifact(
          { adapter, backupDirectory, journal, lock: requireArtifactLock(), persist },
          kind,
          path,
        ),
      );
    },
    async replaceProfile(path) {
      return serializeAction(() =>
        replaceArtifact(
          { adapter, backupDirectory, journal, lock: requireArtifactLock(), persist },
          'profile',
          path,
        ),
      );
    },
    async artifactIdentity(kind, path) {
      return serializeAction(async () => {
        await adapter.validateMutationPath(requireArtifactLock(), kind, path);
        const identity = await adapter.pathIdentity(path);
        if (identity === undefined) throw new Error(`transaction artifact is missing: ${path}`);
        return identity;
      });
    },
    async readStateBytes(path) {
      return serializeAction(async () => {
        await adapter.validateMutationPath(requireArtifactLock(), 'store-block', path);
        return readStateBytes(path);
      });
    },
    async writeStateFile(kind: TransactionStateFileKind, path, bytes) {
      return serializeAction(() =>
        writeStateFile(
          { adapter, backupDirectory, journal, lock: requireArtifactLock(), persist },
          kind,
          path,
          bytes,
        ),
      );
    },
    async readGenerationCurrent(path) {
      return serializeAction(async () => {
        await adapter.validateMutationPath(requireArtifactLock(), 'generation-current', path);
        const bytes = await readStateBytes(path);
        if (bytes === undefined) return undefined;
        if (bytes.byteLength > 128) {
          throw new TransactionFailure(EXIT_CODES.CONTRACT, [
            diagnostic(
              'E_GENERATION_CURRENT',
              `generation current exceeds its bounded pointer size: ${path}`,
              'Repair the current pointer before retrying.',
              path,
            ),
          ]);
        }
        const text = Buffer.from(bytes).toString('utf8');
        if (!Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) {
          throw new TransactionFailure(EXIT_CODES.CONTRACT, [
            diagnostic(
              'E_GENERATION_CURRENT',
              `generation current is not valid UTF-8: ${path}`,
              'Repair the current pointer before retrying.',
              path,
            ),
          ]);
        }
        return text;
      });
    },
    async writeGenerationCurrent(path, expectedDocument, newDocument) {
      if (expectedDocument !== undefined) assertGenerationCurrentDocument(path, expectedDocument);
      assertGenerationCurrentDocument(path, newDocument);
      return serializeAction(() =>
        writeDocument(
          { adapter, backupDirectory, journal, lock: requireArtifactLock(), persist },
          'generation-current',
          path,
          newDocument,
          expectedDocument,
        ),
      );
    },
    async writeManagedDocument(path, newDocument) {
      return serializeAction(() =>
        writeDocument(
          { adapter, backupDirectory, journal, lock: requireArtifactLock(), persist },
          'managed-document',
          path,
          newDocument,
        ),
      );
    },
    async writeSettings(path, expectedDocument, newDocument) {
      return serializeAction(() =>
        writeDocument(
          { adapter, backupDirectory, journal, lock: requireArtifactLock(), persist },
          'settings',
          path,
          newDocument,
          expectedDocument,
        ),
      );
    },
  };

  try {
    artifactLock = await adapter.acquireArtifactLock(dshHome);
    if (resolve(artifactLock.dshHome) !== resolve(dshHome)) {
      throw new TransactionFailure(EXIT_CODES.SECURITY, [
        diagnostic(
          'E_TRANSACTION_ARTIFACT_LOCK_SCOPE',
          'artifact lock 不属于当前 DSH_HOME。',
          '拒绝跨 DSH_HOME 复用 lock token。',
          artifactLock.lockPath,
        ),
      ]);
    }
    await adapter.ensureDirectory(dirname(backupDirectory));
    if (!(await adapter.createDirectoryExclusive(backupDirectory))) {
      journal.state = 'not-started';
      await artifactLock.release();
      artifactLock = undefined;
      return {
        ...resultBase,
        ok: false,
        diagnostics: [
          diagnostic(
            'E_TRANSACTION_BACKUP_EXISTS',
            'transaction backup 目录已存在，拒绝覆盖旧 journal。',
            '生成新的 txid，或先人工审计既有 backup。',
            backupDirectory,
          ),
        ],
        status: 'not-started',
        exitCode: EXIT_CODES.PROFILE_CONFLICT_OR_LOCK,
        manualRecovery: [],
      };
    }
    await adapter.ensureDirectory(backupDirectory);
    await persist();
  } catch (error) {
    const lock = artifactLock;
    artifactLock = undefined;
    let releaseError: unknown;
    if (lock !== undefined) {
      try {
        await lock.release();
      } catch (caught) {
        releaseError = caught;
      }
    }
    journal.state = 'not-started';
    const setupDiagnostics =
      error instanceof TransactionFailure
        ? [...error.diagnostics]
        : [
            diagnostic(
              'E_TRANSACTION_SETUP_FAILED',
              `transaction journal 初始化失败：${errorMessage(error)}`,
              `检查备份目录与 journal 路径：${backupDirectory}、${journalPath}。`,
              journalPath,
            ),
          ];
    if (releaseError !== undefined && lock !== undefined) {
      setupDiagnostics.push(
        diagnostic(
          'E_TRANSACTION_ARTIFACT_LOCK_RELEASE_FAILED',
          `transaction 初始化失败后 artifact lock 释放失败：${errorMessage(releaseError)}`,
          `人工检查锁文件；绝不自动删除未知 owner：${lock.lockPath}。`,
          lock.lockPath,
        ),
      );
    }
    return {
      ...resultBase,
      ok: false,
      diagnostics: setupDiagnostics,
      status: 'not-started',
      exitCode:
        releaseError === undefined
          ? error instanceof TransactionFailure
            ? error.exitCode
            : EXIT_CODES.INTERNAL
          : // The lock file outlived the failed setup; the caller must inspect it by hand.
            EXIT_CODES.MANUAL_RECOVERY_REQUIRED,
      manualRecovery:
        releaseError === undefined || lock === undefined
          ? []
          : [
              {
                actionId: 'artifact-lock',
                operation: 'inspect-lock',
                sourcePath: lock.lockPath,
                destinationPath: lock.lockPath,
                reason: errorMessage(releaseError),
              },
            ],
    };
  }

  try {
    const value = await operation(transaction);
    await actionQueue;
    if (actionFailed) throw actionFailure;
    journal.state = 'committed';
    await persist();
    if (artifactLock !== undefined) {
      const lock = artifactLock;
      try {
        await lock.release();
      } catch (error) {
        return {
          ...resultBase,
          ok: false,
          diagnostics: [
            diagnostic(
              'E_TRANSACTION_ARTIFACT_LOCK_RELEASE_FAILED',
              `事务已 commit，但 artifact lock 释放失败：${errorMessage(error)}`,
              `人工检查锁文件，绝不自动删除未知 owner：${lock.lockPath}。`,
              lock.lockPath,
            ),
          ],
          status: 'committed',
          // The install itself committed, but a stranded lock will block the next run
          // until a human inspects it — that is manual recovery, not a clean outcome.
          exitCode: EXIT_CODES.MANUAL_RECOVERY_REQUIRED,
          manualRecovery: [
            {
              actionId: 'artifact-lock',
              operation: 'inspect-lock',
              sourcePath: lock.lockPath,
              destinationPath: lock.lockPath,
              reason: errorMessage(error),
            },
          ],
        };
      }
    }
    artifactLock = undefined;
    return {
      ...resultBase,
      ok: true,
      value,
      diagnostics: [],
      status: 'committed',
      exitCode: EXIT_CODES.SUCCESS,
      manualRecovery: [],
    };
  } catch (error) {
    await actionQueue;
    const failures = [error];
    if (actionFailed && actionFailure !== error) failures.push(actionFailure);
    return rollbackTransaction({
      adapter,
      artifactLock,
      backupDirectory,
      failures,
      journal,
      journalPath,
    });
  }
}
