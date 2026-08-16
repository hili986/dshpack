import { Command, CommanderError } from 'commander';

import { doctorCommand, registerDoctorCommand } from './commands/doctor.js';
import { exportCommand, registerExportCommand } from './commands/export.js';
import { initCommand } from './commands/init.js';
import { installCommand, registerInstallCommand } from './commands/install.js';
import { listCommand, registerListCommand } from './commands/list.js';
import { lockCommand, registerLockCommand } from './commands/lock.js';
import { packCommand } from './commands/pack.js';
import { diagnostic, writeReport } from './commands/shared.js';
import { registerSwitchCommand, switchCommand } from './commands/switch.js';
import { registerValidateCommand, validateCommand } from './commands/validate.js';
import { EXIT_CODES } from './exit-codes.js';

const commandDefinitions = [
  exportCommand,
  installCommand,
  listCommand,
  lockCommand,
  switchCommand,
  doctorCommand,
  validateCommand,
  initCommand,
  packCommand,
] as const;

export const COMMAND_NAMES = commandDefinitions.map(({ name }) => name);

const NOT_IMPLEMENTED_MESSAGE = '未实现（W10+）';

function reportNotImplemented(json: boolean): void {
  if (!json) {
    process.stderr.write(`${NOT_IMPLEMENTED_MESSAGE}\n`);
    process.exitCode = EXIT_CODES.INTERNAL;
    return;
  }
  writeReport(
    {
      diagnostics: [
        diagnostic(
          'E_NOT_IMPLEMENTED',
          'error',
          '该命令尚未实现。',
          '请使用已实现的命令，或等待后续版本。',
        ),
      ],
      exitCode: EXIT_CODES.INTERNAL,
      metadata: {},
    },
    true,
  );
}

export function createProgram(): Command {
  const program = new Command()
    .name('dshpack')
    .description('dshpack 命令行工具')
    .option('--dsh-home <path>', '指定 DSH home 路径')
    .option('--no-color', '禁用彩色输出')
    .option('--quiet', '仅输出必要信息')
    .option('--json', '使用 JSON 输出');

  for (const { description, name } of commandDefinitions) {
    if (
      name === 'validate' ||
      name === 'doctor' ||
      name === 'export' ||
      name === 'install' ||
      name === 'list' ||
      name === 'lock' ||
      name === 'switch'
    )
      continue;
    program
      .command(name)
      .description(description)
      .option('--json', 'stdout only emits one JSON object')
      .action((options: { json?: boolean }) =>
        reportNotImplemented(
          options.json === true || program.opts<{ json?: boolean }>().json === true,
        ),
      );
  }
  registerValidateCommand(program);
  registerDoctorCommand(program);
  registerExportCommand(program);
  registerInstallCommand(program);
  registerListCommand(program);
  registerLockCommand(program);
  registerSwitchCommand(program);

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

export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  const json = argv.includes('--json');
  const program = createProgram();
  const helpOutput: string[] = [];
  configureErrorBoundary(program, json, helpOutput);
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) {
        if (json) {
          writeReport(
            {
              diagnostics: [],
              exitCode: EXIT_CODES.SUCCESS,
              metadata: { help: helpOutput.join('') },
            },
            true,
          );
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
