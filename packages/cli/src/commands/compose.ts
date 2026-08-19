import type { Command } from 'commander';

import { type ComposeInput, type ComposeReport, composePack } from '../compose/engine.js';
import { resolveDshHomeValue, writeReport } from './shared.js';

export const composeCommand = {
  name: 'compose',
  description: '将多个来源的 skill 组装为一个可验证的本地 pack',
} as const;

export type ComposeRunner = (input: ComposeInput) => Promise<ComposeReport>;

interface ComposeOptions {
  allowUnknownLicense?: boolean;
  dryRun?: boolean;
  output?: string;
}

export function registerComposeCommand(program: Command, run: ComposeRunner = composePack): void {
  program
    .command('compose [compose.yml]')
    .description(composeCommand.description)
    .option('--output <directory>', '输出目录')
    .option('--dry-run', '只报告计划，不创建输出目录')
    .option('--allow-unknown-license', '确认包含 license 不明的来源')
    .action(async (composeFile = 'compose.yml', options: ComposeOptions) => {
      const root = program.opts<{ dshHome?: string; json?: boolean }>();
      const json = root.json === true;
      // Unlike every other command, compose only needs a home when the manifest names a
      // `profile:` source — a compose of github and local sources must work with no home at all.
      // So resolve it conditionally rather than demanding it up front. What is NOT conditional is
      // validation: passing the raw value through let a relative path reach the filesystem and be
      // reported as a contract error, while the same input on `doctor` is refused as exit 31
      // before any I/O. A home that is present gets checked here, ahead of the engine.
      const configured = root.dshHome ?? process.env.DSH_HOME;
      let dshHome: string | undefined;
      if (configured !== undefined && configured.trim() !== '') {
        const resolved = resolveDshHomeValue(configured);
        if (!resolved.ok) {
          writeReport(resolved.report, json);
          return;
        }
        dshHome = resolved.value;
      }
      const report = await run({
        composeFile,
        ...(options.output === undefined ? {} : { output: options.output }),
        ...(options.dryRun === true ? { dryRun: true } : {}),
        ...(options.allowUnknownLicense === true ? { allowUnknownLicense: true } : {}),
        ...(dshHome === undefined ? {} : { dshHome }),
      });
      writeReport(report, json);
    });
}
