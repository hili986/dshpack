import { Command, CommanderError } from 'commander';
import { diffCommand, registerDiffCommand } from './commands/diff.js';
import { doctorCommand, registerDoctorCommand } from './commands/doctor.js';
import { exportCommand, registerExportCommand } from './commands/export.js';
import { gcCommand, registerGcCommand } from './commands/gc.js';
import { initCommand, registerInitCommand } from './commands/init.js';
import { installCommand, registerInstallCommand } from './commands/install.js';
import { listCommand, registerListCommand } from './commands/list.js';
import { lockCommand, registerLockCommand } from './commands/lock.js';
import { migrateCommand, registerMigrateCommand } from './commands/migrate.js';
import { packCommand, registerPackCommand } from './commands/pack.js';
import { registerRestoreCommand, restoreCommand } from './commands/restore.js';
import { diagnostic, writeReport } from './commands/shared.js';
import { registerStatusCommand, statusCommand } from './commands/status.js';
import { registerSwitchCommand, switchCommand } from './commands/switch.js';
import { registerUninstallCommand, uninstallCommand } from './commands/uninstall.js';
import { registerUpdateCommand, updateCommand } from './commands/update.js';
import { registerValidateCommand, validateCommand } from './commands/validate.js';
import { EXIT_CODES } from './exit-codes.js';
import { DSHPACK_VERSION } from './version.js';

const commandDefinitions = [
  exportCommand,
  installCommand,
  listCommand,
  lockCommand,
  switchCommand,
  doctorCommand,
  gcCommand,
  migrateCommand,
  uninstallCommand,
  restoreCommand,
  updateCommand,
  diffCommand,
  statusCommand,
  validateCommand,
  initCommand,
  packCommand,
] as const;

export const COMMAND_NAMES = commandDefinitions.map(({ name }) => name);

export function createProgram(): Command {
  const program = new Command()
    .name('dshpack')
    .description('dshpack 命令行工具')
    .version(DSHPACK_VERSION, '-V, --version', '输出 dshpack 版本号')
    .option('--dsh-home <path>', '指定 DSH home 路径')
    .option('--no-color', '禁用彩色输出')
    .option('--quiet', '仅输出必要信息')
    .option('--json', '使用 JSON 输出');

  registerValidateCommand(program);
  registerDoctorCommand(program);
  registerGcCommand(program);
  registerMigrateCommand(program);
  registerExportCommand(program);
  registerInstallCommand(program);
  registerListCommand(program);
  registerLockCommand(program);
  registerSwitchCommand(program);
  registerUninstallCommand(program);
  registerRestoreCommand(program);
  registerUpdateCommand(program);
  registerDiffCommand(program);
  registerStatusCommand(program);
  registerInitCommand(program);
  registerPackCommand(program);

  return program;
}

function configureErrorBoundary(command: Command, json: boolean, helpOutput: string[]): void {
  command.exitOverride();
  if (json) {
    command.configureOutput({
      writeErr: () => undefined,
      writeOut: (value) => helpOutput.push(value),
    });
  }
  for (const child of command.commands) configureErrorBoundary(child, json, helpOutput);
}

/**
 * Commander recognises program options *after* a subcommand name too, so `dshpack init x --version
 * 0.1.0` hands `--version` to the program: it prints dshpack's own version and exits 0 having
 * created nothing. Exit 0 is what makes this worth its own guard — every other misspelling exits 2
 * with `unknown option`, so this is the single wrong guess that a wrapping script reads as success.
 *
 * `enablePositionalOptions()` is Commander's official fix, and it is not usable here: it would stop
 * recognising `--dsh-home` after a subcommand, which is the form README's quickstart and the machine
 * argv built in `install/policy.ts` both emit. So refuse this one shape rather than move every
 * program option. Returns the offending subcommand name, or undefined when the argv is fine.
 *
 * This scans raw argv without knowing any option's arity — reimplementing Commander's parser to
 * tell a flag from an option value would be the more fragile choice. The residual imprecision is
 * that an option *value* spelled exactly like a subcommand (`--dsh-home list --version`) starts
 * the scan early. That errs toward refusing with a clear message, never toward the silent exit 0
 * this exists to prevent, so leave it alone.
 */
function versionFlagAfterSubcommand(argv: readonly string[]): string | undefined {
  const args = argv.slice(2);
  const terminator = args.indexOf('--');
  const scanned = terminator === -1 ? args : args.slice(0, terminator);
  const names: readonly string[] = COMMAND_NAMES;
  const subcommand = scanned.findIndex((arg) => names.includes(arg));
  if (subcommand === -1) return undefined;
  const misplaced = scanned
    .slice(subcommand + 1)
    .some((arg) => arg === '--version' || arg === '-V');
  return misplaced ? scanned[subcommand] : undefined;
}

export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  const json = argv.includes('--json');
  const misplacedVersion = versionFlagAfterSubcommand(argv);
  if (misplacedVersion !== undefined) {
    writeReport(
      {
        diagnostics: [
          diagnostic(
            'E_USAGE',
            'error',
            '--version 是 dshpack 自身的版本选项，放在子命令之后不会生效。',
            misplacedVersion === 'init'
              ? '设置 pack 版本请用 --pack-version；查询 dshpack 版本请运行 dshpack --version。'
              : '查询 dshpack 版本请把 --version 放在子命令之前：dshpack --version。',
          ),
        ],
        exitCode: EXIT_CODES.USAGE,
        metadata: {},
      },
      json,
    );
    return;
  }
  const program = createProgram();
  const helpOutput: string[] = [];
  configureErrorBoundary(program, json, helpOutput);
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) {
        if (json) {
          // `--version` and `--help` both stop the parse successfully; only the latter
          // has anything to say in `help`, so report the version under its own key.
          const metadata =
            error.code === 'commander.version'
              ? { version: DSHPACK_VERSION }
              : { help: helpOutput.join('') };
          writeReport({ diagnostics: [], exitCode: EXIT_CODES.SUCCESS, metadata }, true);
        } else {
          process.exitCode = EXIT_CODES.SUCCESS;
        }
        return;
      }
      process.exitCode = EXIT_CODES.USAGE;
      if (json) {
        writeReport(
          {
            diagnostics: [
              diagnostic('E_USAGE', 'error', error.message, '请运行 dshpack --help 查看完整用法。'),
            ],
            exitCode: EXIT_CODES.USAGE,
            metadata: {},
          },
          true,
        );
      }
      return;
    }
    writeReport(
      {
        diagnostics: [
          diagnostic(
            'E_INTERNAL',
            'error',
            '命令发生未预期的内部错误。',
            '请重试；若问题持续，请仅携带该诊断代码报告问题。',
          ),
        ],
        exitCode: EXIT_CODES.INTERNAL,
        metadata: {},
      },
      json,
    );
  }
}
