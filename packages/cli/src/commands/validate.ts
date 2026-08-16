import type { Command } from 'commander';
import { validateLocalPack } from '../validation/validate-pack.js';
import { writeReport } from './shared.js';

export const validateCommand = {
  name: 'validate',
  description: '零写入校验本地 dshpack 目录（不调用 dsh）',
} as const;

export function registerValidateCommand(program: Command): void {
  program
    .command('validate <source>')
    .description(validateCommand.description)
    .option('--strict', '将 warning 升级为 error')
    .option('--json', 'stdout 仅输出一个 JSON object')
    .action(async (source: string, options: { json?: boolean; strict?: boolean }) => {
      const report = await validateLocalPack(source, {
        ...(options.strict === undefined ? {} : { strict: options.strict }),
      });
      writeReport(report, options.json === true);
    });
}
