import type { Command } from 'commander';

import { type PackInput, type PackReport, packDirectory } from '../pack/engine.js';
import { writeReport } from './shared.js';

export const packCommand = {
  name: 'pack',
  description: '将本地 pack 打成可复现且带 SRI 的 tarball',
} as const;

export type PackRunner = (input: PackInput) => Promise<PackReport>;

export function registerPackCommand(program: Command, run: PackRunner = packDirectory): void {
  program
    .command('pack [directory]')
    .description(packCommand.description)
    .option('--output <directory>', '输出目录')
    .option('--json', 'stdout only emits one JSON object')
    .action(async (directory = '.', options: { output?: string; json?: boolean }) => {
      const json = options.json === true || program.opts<{ json?: boolean }>().json === true;
      const report = await run({
        directory,
        ...(options.output === undefined ? {} : { output: options.output }),
      });
      writeReport(report, json);
    });
}
