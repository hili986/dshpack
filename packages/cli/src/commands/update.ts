import type { Command } from 'commander';

import { createNodeInstallRuntime } from '../install/runtime.js';
import {
  type UpdateInput,
  type UpdateReport,
  type UpdateRuntime,
  updateProfile,
} from '../update/engine.js';
import { resolveDshHome, writeReport } from './shared.js';

export const updateCommand = {
  name: 'update',
  description: '更新受跟踪 profile 到已验证的目标 pack；保留事务 apply 前的安全预检',
} as const;

export type UpdateRunner = (input: UpdateInput, runtime: UpdateRuntime) => Promise<UpdateReport>;
export type UpdateRuntimeFactory = (dshHome: string) => UpdateRuntime;

interface UpdateCommandOptions {
  readonly to?: string;
  readonly dryRun?: boolean;
  readonly ours?: boolean;
  readonly theirs?: boolean;
  readonly only: string[];
  readonly allowBuild: string[];
  readonly allowUnverified?: boolean;
  readonly allowVersionMismatch?: boolean;
  readonly allowDangerFullAccess?: boolean;
  readonly yes?: boolean;
  readonly json?: boolean;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

export function registerUpdateCommand(
  program: Command,
  run: UpdateRunner = updateProfile,
  runtimeFactory: UpdateRuntimeFactory = createNodeInstallRuntime,
  interactive: () => boolean = isInteractiveTerminal,
): void {
  const command = program
    .command('update <profile>')
    .description(updateCommand.description)
    .option('--to <source>', '指定目标 SOURCE；省略时使用安装标记中固定的来源')
    .option('--dry-run', '仅执行安全预检并输出授权差量，确认前零写入')
    .option('--ours', '冲突时保留本地修改')
    .option('--theirs', '冲突时采用目标 pack 内容')
    .option('--only <id>', '仅更新指定 asset 或 setting 标识，可重复', collect, [])
    .option('--allow-build <package>', '逐项授权 exact package build，可重复', collect, [])
    .option('--allow-unverified', '显式允许 lock 中不可验证的插件')
    .option('--allow-version-mismatch', '显式允许 dsh 版本超出 tested 范围')
    .option('--allow-danger-full-access', '显式允许新增 danger-full-access')
    .option('--yes', '仅确认普通更新，不替代任何 --allow-* 危险授权')
    .option('--json', 'stdout 仅输出一个 JSON object');
  command.options.find((option) => option.long === '--ours')?.conflicts('theirs');
  command.action(async (profile: string, options: UpdateCommandOptions) => {
    const root = program.opts<{ dshHome?: string; json?: boolean }>();
    const json = options.json === true || root.json === true;
    const home = resolveDshHome(program);
    if (!home.ok) {
      writeReport(home.report, json);
      return;
    }
    const report = await run(
      {
        dshHome: home.value,
        profile,
        ...(options.to === undefined ? {} : { to: options.to }),
        dryRun: options.dryRun === true,
        ours: options.ours === true,
        theirs: options.theirs === true,
        ...(options.only.length === 0 ? {} : { only: options.only }),
        allowBuilds: options.allowBuild,
        allowUnverified: options.allowUnverified === true,
        allowVersionMismatch: options.allowVersionMismatch === true,
        allowDangerFullAccess: options.allowDangerFullAccess === true,
        yes: options.yes === true,
        interactive: json ? false : interactive(),
        json,
      },
      runtimeFactory(home.value),
    );
    writeReport(report, json);
  });
}
