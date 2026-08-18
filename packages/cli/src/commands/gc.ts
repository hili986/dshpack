import type { Command } from 'commander';

import { type GcMetadata, runGc } from '../gc/engine.js';
import { type CommandReport, resolveDshHome, writeReport } from './shared.js';

export const gcCommand = {
  name: 'gc',
  description: '回收无引用的 CAS block 与过期代际',
} as const;

export type GcRunner = (input: {
  dshHome: string;
  keep?: string;
  dryRun: boolean;
}) => Promise<CommandReport<GcMetadata>>;

async function runDefault(input: {
  dshHome: string;
  keep?: string;
  dryRun: boolean;
}): Promise<CommandReport<GcMetadata>> {
  const keep =
    input.keep === undefined
      ? undefined
      : /^(?:0|[1-9]\d*)$/u.test(input.keep)
        ? Number(input.keep)
        : Number.NaN;
  return runGc({
    dshHome: input.dshHome,
    ...(keep === undefined ? {} : { keep }),
    dryRun: input.dryRun,
  });
}

export function registerGcCommand(program: Command, run: GcRunner = runDefault): void {
  program
    .command('gc')
    .description(gcCommand.description)
    .option('--keep <n>', '每个 profile 保留最新的 n 代')
    .option('--dry-run', '仅输出回收 plan，确认前零写入')
    .option('--json', 'stdout 仅输出一个 JSON object')
    .action(async (options: { keep?: string; dryRun?: boolean; json?: boolean }) => {
      const root = program.opts<{ dshHome?: string; json?: boolean }>();
      const json = options.json === true || root.json === true;
      const home = resolveDshHome(program);
      if (!home.ok) {
        writeReport(home.report, json);
        return;
      }
      const report = await run({
        dshHome: home.value,
        ...(options.keep === undefined ? {} : { keep: options.keep }),
        dryRun: options.dryRun === true,
      });
      writeReport(report, json);
    });
}
