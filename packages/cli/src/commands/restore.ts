import { type Command, InvalidArgumentError } from 'commander';

import { type RestoreInput, type RestoreMetadata, restoreProfile } from '../restore/engine.js';
import { terminalSafeText } from '../terminal-safe.js';
import { type CommandReport, resolveDshHome, writeReport } from './shared.js';

export const restoreCommand = {
  name: 'restore',
  description: '还原 profile 的某一代；不丢弃用户后来的修改',
} as const;

export type RestoreRunner = (input: RestoreInput) => Promise<CommandReport<RestoreMetadata>>;

/** Keep human review useful without serializing settings values or other raw managed content. */
export function displayRestorePlan(metadata: RestoreMetadata): void {
  const lines =
    metadata.targetGeneration === undefined
      ? [`Retained generations for ${terminalSafeText(metadata.profile)}:`]
      : [
          `Restore plan for ${terminalSafeText(metadata.profile)} to generation ${metadata.targetGeneration}:`,
        ];
  for (const generation of metadata.generations)
    lines.push(
      `  ${generation.seq} ${terminalSafeText(generation.createdAt)} ${terminalSafeText(generation.operation)} ${terminalSafeText(generation.packVersion)} restorable=${generation.restorable}`,
    );
  for (const asset of metadata.assets)
    lines.push(
      `  ${terminalSafeText(asset.action)} ${terminalSafeText(asset.target)} (${terminalSafeText(asset.reason)})`,
    );
  for (const key of metadata.retainedSettings)
    lines.push(`  retain settings agent-presets.${terminalSafeText(key)}`);
  for (const digest of metadata.missingCasBlocks ?? [])
    lines.push(`  missing immutable CAS block ${terminalSafeText(digest)}`);
  if (metadata.dryRun) lines.push('Dry run: no files will be changed.');
  process.stdout.write(`${lines.join('\n')}\n`);
}

function parseSequence(value: string): number {
  if (!/^[1-9]\d*$/u.test(value))
    throw new InvalidArgumentError('--to must be a positive integer generation sequence');
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence))
    throw new InvalidArgumentError('--to must be a safe positive integer generation sequence');
  return sequence;
}

export function registerRestoreCommand(
  program: Command,
  run: RestoreRunner = restoreProfile,
): void {
  program
    .command('restore <profile>')
    .description(restoreCommand.description)
    .option('--to <seq>', '还原到指定的代际序号', parseSequence)
    .option('--list', '只读列出保留的代际')
    .option('--dry-run', '仅输出还原 plan，确认前零写入')
    .option('--force', '覆盖被用户改过的 asset（先进事务 backup）')
    .option('--yes', '确认非交互式写操作；不替代 --force')
    .option('--json', 'stdout 仅输出一个 JSON object')
    .action(
      async (
        profile: string,
        options: {
          to?: number;
          list?: boolean;
          dryRun?: boolean;
          force?: boolean;
          yes?: boolean;
          json?: boolean;
        },
      ) => {
        const root = program.opts<{ json?: boolean }>();
        const json = options.json === true || root.json === true;
        const home = resolveDshHome(program);
        if (!home.ok) {
          writeReport(home.report, json);
          return;
        }
        const report = await run({
          dshHome: home.value,
          profile,
          ...(options.to === undefined ? {} : { to: options.to }),
          list: options.list === true,
          dryRun: options.dryRun === true,
          force: options.force === true,
          yes: options.yes === true,
        });
        if (!json) displayRestorePlan(report.metadata);
        writeReport(report, json);
      },
    );
}
