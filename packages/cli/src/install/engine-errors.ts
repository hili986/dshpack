import { DshProcessError } from '../adapters/process.js';
import { SourceError } from '../adapters/source.js';
import { diagnostic } from '../commands/shared.js';
import { EXIT_CODES, type ExitCode } from '../exit-codes.js';
import { TransactionFailure } from '../transaction.js';
import { InstallProfileError } from './profile-common.js';
import type { InstallRuntime, InstallRuntimeStage } from './runtime-types.js';

const stageExit: Record<InstallRuntimeStage, ExitCode> = {
  'source-cleanup': EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
  init: EXIT_CODES.DSH_SUBPROCESS_FAILURE,
  add: EXIT_CODES.DSH_SUBPROCESS_FAILURE,
  verify: EXIT_CODES.POST_INSTALL_VERIFY_FAILURE,
  assets: EXIT_CODES.CONTRACT,
  settings: EXIT_CODES.CONTRACT,
  dump: EXIT_CODES.POST_INSTALL_VERIFY_FAILURE,
  doctor: EXIT_CODES.POST_INSTALL_VERIFY_FAILURE,
  metadata: EXIT_CODES.POST_INSTALL_VERIFY_FAILURE,
};

export function installFailure(
  exitCode: ExitCode,
  code: string,
  message: string,
  hint: string,
): TransactionFailure {
  return new TransactionFailure(exitCode, [diagnostic(code, 'error', message, hint)]);
}

export async function runInstallFault(
  runtime: InstallRuntime,
  stage: InstallRuntimeStage,
): Promise<void> {
  try {
    await runtime.fault(stage);
  } catch {
    throw installFailure(
      stageExit[stage],
      `E_INSTALL_${stage.replace('-', '_').toUpperCase()}`,
      `install ${stage} 阶段失败。`,
      `修复 ${stage} 的最小失败原因后重试；事务将回滚。`,
    );
  }
}

export async function guardedInstall<T>(
  exitCode: ExitCode,
  code: string,
  message: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TransactionFailure) throw error;
    if (error instanceof SourceError)
      throw installFailure(
        error.exitCode,
        error.code,
        error.message,
        error.hint ?? '检查 source 后重试。',
      );
    if (error instanceof InstallProfileError)
      throw new TransactionFailure(exitCode, [
        diagnostic(error.code, 'error', error.message, '修复精确安装事实后重试。', error.path),
      ]);
    if (error instanceof DshProcessError)
      throw installFailure(exitCode, error.code, error.message, '检查 dsh 子进程诊断后重试。');
    throw installFailure(exitCode, code, message, '查看前一条精确诊断并修复后重试。');
  }
}
