import type { Command } from 'commander';

import { exportProfile } from '../export/engine.js';
import { writeReport } from './shared.js';

export const exportCommand = {
  name: 'export',
  description: '导出 profile 为本地 pack；dsh dump 会写 profile/cordis.yml',
} as const;

function showSuccess(report: Awaited<ReturnType<typeof exportProfile>>): void {
  const { metadata } = report;
  process.stdout.write(`✅ 已导出 pack ${metadata.profile}@0.1.0 → ${metadata.output}\n`);
  process.stdout.write(
    `   integrity: ${metadata.integrity}   exportMode: ${metadata.exportMode}\n`,
  );
  process.stdout.write(
    '   采集分类：portable（patch/skills/presets）、parameterized（MCP）、sensitive（0 项）\n',
  );
  process.stdout.write(`   下一步：dshpack validate "${metadata.output}" --strict\n`);
  process.stdout.write(`⚠️ 请人工复查（自由文本无法完全自动脱敏）：${metadata.review.join(', ')}\n`);
}

export function registerExportCommand(program: Command): void {
  program
    .command('export')
    .description(exportCommand.description)
    .requiredOption('--profile <profile>', '要导出的 profile；不会猜当前 profile')
    .requiredOption('--output <directory>', '不存在或经确认的空目录')
    .option('--include-skills', '包含 $DSH_HOME/skills')
    .option('--include-presets <ids>', '逗号分隔的 preset id')
    .option('--include-settings <namespace>', '仅允许 agent-presets')
    .option('--redact', '仅将已知 settings 值写为 <REDACTED>')
    .option('--allow-unverified-export', '允许缺少 lock digest 时写 unverified lock')
    .option('--yes', '确认使用已有空输出目录')
    .option('--json', 'stdout 仅输出一个 JSON object')
    .action(
      async (options: {
        allowUnverifiedExport?: boolean;
        includePresets?: string;
        includeSettings?: string;
        includeSkills?: boolean;
        json?: boolean;
        output: string;
        profile: string;
        redact?: boolean;
        yes?: boolean;
      }) => {
        if (options.includeSettings !== undefined && options.includeSettings !== 'agent-presets') {
          process.stderr.write('✖ E_EXPORT_SETTINGS: --include-settings 仅允许 agent-presets。\n');
          process.exitCode = 2;
          return;
        }
        const report = await exportProfile({
          dshHome: program.opts<{ dshHome?: string }>().dshHome ?? process.env.DSH_HOME ?? '',
          output: options.output,
          profile: options.profile,
          ...(options.allowUnverifiedExport === undefined
            ? {}
            : { allowUnverifiedExport: options.allowUnverifiedExport }),
          ...(options.includePresets === undefined
            ? {}
            : { includePresets: options.includePresets.split(',').filter(Boolean) }),
          ...(options.includeSettings === undefined ? {} : { includeSettings: true }),
          ...(options.includeSkills === undefined ? {} : { includeSkills: options.includeSkills }),
          ...(options.redact === undefined ? {} : { redact: options.redact }),
          ...(options.yes === undefined ? {} : { yes: options.yes }),
        });
        const json = options.json === true || program.opts<{ json?: boolean }>().json === true;
        writeReport(report, json);
        if (report.exitCode === 0 && !json) showSuccess(report);
      },
    );
}
