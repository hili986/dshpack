import type { Command } from 'commander';
import { createNodeInstallRuntime } from '../install/runtime.js';
import {
  type MigrateInput,
  type MigrateReport,
  type MigrateRuntime,
  migrateProfile,
} from '../migrate/engine.js';
import { resolveDshHome, writeReport } from './shared.js';

export const migrateCommand = {
  name: 'migrate',
  description: '把 legacy installed metadata 重建为 v1',
} as const;

export type MigrateRunner = (
  input: MigrateInput,
  runtime: MigrateRuntime,
) => Promise<MigrateReport>;
export type MigrateRuntimeFactory = (dshHome: string) => MigrateRuntime;

export function registerMigrateCommand(
  program: Command,
  run: MigrateRunner = migrateProfile,
  runtimeFactory: MigrateRuntimeFactory = createNodeInstallRuntime,
): void {
  program
    .command('migrate <profile>')
    .description(migrateCommand.description)
    .option('--dry-run', '仅重建并校验，不写 DSH state')
    .option('--json', 'stdout 仅输出一个 JSON object')
    .action(async (profile: string, options: { dryRun?: boolean; json?: boolean }) => {
      const root = program.opts<{ dshHome?: string; json?: boolean }>();
      const json = options.json === true || root.json === true;
      const home = resolveDshHome(program);
      if (!home.ok) {
        writeReport(home.report, json);
        return;
      }
      const report = await run(
        { dshHome: home.value, profile, dryRun: options.dryRun === true },
        runtimeFactory(home.value),
      );
      writeReport(report, json);
    });
}
