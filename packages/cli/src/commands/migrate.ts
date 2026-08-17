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
  description: 'rebuild legacy installed metadata as v1',
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
    .option('--dry-run', 'rebuild and validate without writing DSH state')
    .option('--json', 'stdout only emits one JSON object')
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
