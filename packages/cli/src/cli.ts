import { Command } from 'commander';

import { doctorCommand, registerDoctorCommand } from './commands/doctor.js';
import { exportCommand, registerExportCommand } from './commands/export.js';
import { initCommand } from './commands/init.js';
import { installCommand } from './commands/install.js';
import { listCommand } from './commands/list.js';
import { packCommand } from './commands/pack.js';
import { switchCommand } from './commands/switch.js';
import { registerValidateCommand, validateCommand } from './commands/validate.js';
import { EXIT_CODES } from './exit-codes.js';

const commandDefinitions = [
  exportCommand,
  installCommand,
  listCommand,
  switchCommand,
  doctorCommand,
  validateCommand,
  initCommand,
  packCommand,
] as const;

export const COMMAND_NAMES = commandDefinitions.map(({ name }) => name);

const NOT_IMPLEMENTED_MESSAGE = '未实现（W10+）';

function reportNotImplemented(): void {
  process.stderr.write(`${NOT_IMPLEMENTED_MESSAGE}\n`);
  process.exitCode = EXIT_CODES.INTERNAL;
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
    if (name === 'validate' || name === 'doctor' || name === 'export') continue;
    program.command(name).description(description).action(reportNotImplemented);
  }
  registerValidateCommand(program);
  registerDoctorCommand(program);
  registerExportCommand(program);

  return program;
}

export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  await createProgram().parseAsync(argv);
}
