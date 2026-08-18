import type { Command } from 'commander';
import type { DiffRuntime } from '../diff/engine.js';
import { createNodeInstallRuntime } from '../install/runtime.js';
import { type StatusInput, type StatusReport, statusProfiles } from '../status/engine.js';
import { terminalSafeText } from '../terminal-safe.js';
import { resolveDshHome, writeReport } from './shared.js';

export const statusCommand = {
  name: 'status',
  description: '只读汇总所有 profile 的受跟踪状态；默认不联网',
} as const;

export type StatusRunner = (input: StatusInput, runtime: DiffRuntime) => Promise<StatusReport>;
export type StatusRuntimeFactory = (dshHome: string) => DiffRuntime;

function display(report: StatusReport): void {
  for (const profile of report.metadata.profiles) {
    if (profile.status === 'tracked') {
      process.stdout.write(
        `${terminalSafeText(profile.profile)}  ${terminalSafeText(profile.pack.name)}@${terminalSafeText(profile.pack.version)}  seq=${profile.generation ?? '-'}  drift=${profile.drift}  shared=${profile.sharedAssets}  update=${profile.update}\n`,
      );
      continue;
    }
    process.stdout.write(
      `${terminalSafeText(profile.profile)}  ${profile.status}${profile.reason === undefined ? '' : `  ${terminalSafeText(profile.reason)}`}\n`,
    );
  }
}

export function registerStatusCommand(
  program: Command,
  run: StatusRunner = statusProfiles,
  runtimeFactory: StatusRuntimeFactory = createNodeInstallRuntime,
): void {
  program
    .command('status')
    .description(statusCommand.description)
    .option('--check-updates', '联网检查受跟踪 profile 是否有可用上游更新')
    .option('--json', 'stdout 仅输出一个 JSON object')
    .action(async (options: { checkUpdates?: boolean; json?: boolean }) => {
      const root = program.opts<{ json?: boolean }>();
      const json = options.json === true || root.json === true;
      const home = resolveDshHome(program);
      if (!home.ok) {
        writeReport(home.report, json);
        return;
      }
      const report = await run(
        { dshHome: home.value, checkUpdates: options.checkUpdates === true },
        runtimeFactory(home.value),
      );
      writeReport(report, json);
      if (report.exitCode === 0 && !json) display(report);
    });
}
