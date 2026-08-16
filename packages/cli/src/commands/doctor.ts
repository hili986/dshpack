import type { Command } from 'commander';

import { runDoctor } from '../doctor/engine.js';
import { writeReport } from './shared.js';

export const doctorCommand = {
  name: 'doctor',
  description: '诊断 dsh 环境；dump 检查会让 dsh 写 profile/cordis.yml',
} as const;

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description(doctorCommand.description)
    .option('--profile <profile>', '要检查的 profile')
    .option('--fix', '仅修复 DSH008 空 patch 与 DSH010 缺 name')
    .option('--strict', '将 warning 升级为 error')
    .option('--yes', '确认允许的低风险修复和 dump 副作用')
    .option('--json', 'stdout 仅输出一个 JSON object')
    .action(
      async (options: {
        fix?: boolean;
        json?: boolean;
        profile?: string;
        strict?: boolean;
        yes?: boolean;
      }) => {
        const report = await runDoctor({
          dshHome: program.opts<{ dshHome?: string }>().dshHome ?? process.env.DSH_HOME ?? '',
          ...(options.fix === undefined ? {} : { fix: options.fix }),
          ...(options.profile === undefined ? {} : { profile: options.profile }),
          ...(options.strict === undefined ? {} : { strict: options.strict }),
          ...(options.yes === undefined ? {} : { yes: options.yes }),
        });
        writeReport(
          report,
          options.json === true || program.opts<{ json?: boolean }>().json === true,
        );
      },
    );
}
