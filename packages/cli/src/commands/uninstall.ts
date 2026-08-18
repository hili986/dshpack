import type { Command } from 'commander';
import { EXIT_CODES } from '../exit-codes.js';
import { terminalSafeText } from '../terminal-safe.js';
import {
  type UninstallInput,
  type UninstallMetadata,
  uninstallProfile,
} from '../uninstall/engine.js';
import { type CommandReport, resolveDshHome, writeReport } from './shared.js';

export const uninstallCommand = {
  name: 'uninstall',
  description: '卸载一个 tracked profile；归属无法证明的用户内容一律保留',
} as const;

export type UninstallRunner = (input: UninstallInput) => Promise<CommandReport<UninstallMetadata>>;

function confirmationGuidance(metadata: UninstallMetadata): string {
  const flags = [metadata.force ? '--force' : undefined, '--yes'].filter(
    (flag): flag is string => flag !== undefined,
  );
  return `Review this plan, then rerun the same command with ${flags.join(' ')}.`;
}

/** Present the byte-level plan before normal diagnostics can ask for confirmation. */
export function displayUninstallPlan(metadata: UninstallMetadata): void {
  const lines = ['Uninstall plan:'];
  const profileIsListed = metadata.assets.some(
    (asset) => asset.target === `profiles/${metadata.profile}`,
  );
  if (!profileIsListed && metadata.profileAction === 'delete')
    lines.push('  delete profile directory (legacy-force)');
  for (const asset of metadata.assets)
    lines.push(`  ${asset.action} ${asset.target} (${asset.reason})`);
  if (metadata.markerAction === 'delete') lines.push('  delete tracked installed marker');
  for (const key of metadata.settingsRemoved)
    lines.push(`  delete settings agent-presets.${terminalSafeText(key)}`);
  for (const key of metadata.settingsRetained)
    lines.push(`  retain settings agent-presets.${terminalSafeText(key)}`);
  for (const profile of metadata.legacyProfiles)
    lines.push(`  retain all assets (legacy profile reference: ${profile})`);
  for (const generation of metadata.deletedGenerations)
    lines.push(`  delete generation ${generation}`);
  for (const digest of metadata.deletedBlocks) lines.push(`  delete CAS block ${digest}`);
  if (metadata.dryRun)
    lines.push(`Dry run: no files will be changed. ${confirmationGuidance(metadata)}`);
  else if (metadata.removedMarker) {
    lines.push('Uninstall completed.');
    lines.push(
      metadata.activation === 'profile-removed'
        ? 'Skills and presets are hot-effective; restart dsh for profile removal to take effect.'
        : 'The profile was retained; its dsh activation remains unchanged.',
    );
  } else lines.push(confirmationGuidance(metadata));
  if (metadata.pendingPurge)
    lines.push('Physical generation/CAS reclamation is pending; run dshpack gc to retry it.');
  process.stdout.write(`${lines.join('\n')}\n`);
}

export function registerUninstallCommand(
  program: Command,
  run: UninstallRunner = uninstallProfile,
): void {
  program
    .command('uninstall <profile>')
    .description(uninstallCommand.description)
    .option('--dry-run', '仅输出卸载 plan，确认前零写入')
    .option('--keep-assets', '保留 skills、presets 与 settings 贡献')
    .option('--force', '允许删除被用户改过的 tracked asset（先进事务 backup）')
    .option('--purge-generations', '一并删除该 profile 的代际历史与无引用 CAS block')
    .option('--yes', '确认非交互式写操作；不替代 --force')
    .option('--json', 'stdout 仅输出一个 JSON object')
    .action(
      async (
        profile: string,
        options: {
          dryRun?: boolean;
          keepAssets?: boolean;
          force?: boolean;
          purgeGenerations?: boolean;
          yes?: boolean;
          json?: boolean;
        },
      ) => {
        const root = program.opts<{ dshHome?: string; json?: boolean }>();
        const json = options.json === true || root.json === true;
        const home = resolveDshHome(program);
        if (!home.ok) {
          writeReport(home.report, json);
          return;
        }
        const report = await run({
          dshHome: home.value,
          profile,
          dryRun: options.dryRun === true,
          keepAssets: options.keepAssets === true,
          force: options.force === true,
          purgeGenerations: options.purgeGenerations === true,
          yes: options.yes === true,
          interactive: false,
        });
        if (
          !json &&
          ((report.exitCode === EXIT_CODES.SUCCESS && report.metadata.dryRun) ||
            report.exitCode === EXIT_CODES.USER_DECLINED ||
            (report.exitCode === EXIT_CODES.SUCCESS && report.metadata.removedMarker))
        )
          displayUninstallPlan(report.metadata);
        writeReport(report, json);
      },
    );
}
