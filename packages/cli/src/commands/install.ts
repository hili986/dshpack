import type { Command } from 'commander';

import { installPack } from '../install/engine.js';
import { createNodeInstallRuntime, type NodeInstallRuntimeOptions } from '../install/runtime.js';
import type { InstallInput, InstallReport, InstallRuntime } from '../install/runtime-types.js';
import { resolveDshHome, writeReport } from './shared.js';

export const installCommand = {
  name: 'install',
  description: '以可回滚事务安装 pack',
} as const;

export type InstallRunner = (
  input: InstallInput,
  runtime: InstallRuntime,
) => Promise<InstallReport>;
export type InstallRuntimeFactory = (
  dshHome: string,
  options?: Pick<NodeInstallRuntimeOptions, 'writeStderr'>,
) => InstallRuntime;

interface InstallCommandOptions {
  allowBuild: string[];
  allowDangerFullAccess?: boolean;
  allowUnverified?: boolean;
  allowVersionMismatch?: boolean;
  as?: string;
  dryRun?: boolean;
  force?: boolean;
  frozen?: boolean;
  json?: boolean;
  replace?: boolean;
  yes?: boolean;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function stripAnsi(value: string): string {
  const sgr = new RegExp(`${String.fromCodePoint(27)}\\[[0-9;]*m`, 'gu');
  return value.replaceAll(sgr, '');
}

function showSuccess(report: InstallReport, dshHome: string): void {
  if (report.exitCode !== 0 || report.metadata.status !== 'installed') return;
  const profile = report.metadata.profile;
  if (profile === undefined) return;
  const lines = [
    `启动：dsh --profile ${profile}`,
    '生效提醒：请 restart dsh；技能热生效，preset/settings 在 new session 生效。',
    `审计：dshpack --dsh-home ${quoted(dshHome)} doctor --profile ${profile} --strict`,
    `配置对账：dsh --profile ${profile} --dump-config（会写 profiles/${profile}/cordis.yml）`,
    `插件审计：dsh plugin --profile ${profile} list --depth=0`,
  ];
  if (report.metadata.plan?.requiredDangerousPermissions.includes('danger-full-access'))
    lines.push(
      '权限提醒：已确认 pack 请求 danger-full-access，但不会自动生效或写入 settings；启动新会话时仍须显式选择。',
    );
  process.stdout.write(`${lines.join('\n')}\n`);
}

function installInput(
  source: string,
  dshHome: string,
  json: boolean,
  interactive: boolean,
  options: InstallCommandOptions,
): InstallInput {
  return {
    source,
    dshHome,
    interactive: json ? false : interactive,
    json,
    allowBuilds: options.allowBuild,
    ...(options.as === undefined ? {} : { as: options.as }),
    ...(options.replace === true ? { replace: true } : {}),
    ...(options.frozen === true ? { frozen: true } : {}),
    ...(options.dryRun === true ? { dryRun: true } : {}),
    ...(options.force === true ? { force: true } : {}),
    ...(options.yes === true ? { yes: true } : {}),
    ...(options.allowUnverified === true ? { allowUnverified: true } : {}),
    ...(options.allowVersionMismatch === true ? { allowVersionMismatch: true } : {}),
    ...(options.allowDangerFullAccess === true ? { allowDangerFullAccess: true } : {}),
  };
}

export function registerInstallCommand(
  program: Command,
  run: InstallRunner = installPack,
  runtimeFactory: InstallRuntimeFactory = createNodeInstallRuntime,
  interactive: () => boolean = isInteractiveTerminal,
): void {
  program
    .command('install <source>')
    .description(installCommand.description)
    .option('--as <profile>', '目标 profile 名称')
    .option('--replace', '显式替换已有 profile（旧目录进入事务 backup）')
    .option('--frozen', '严格使用现有 pack.lock（默认从 manifest 重新解析）')
    .option('--dry-run', '仅输出 plan，确认前零写入')
    .option('--allow-build <package>', '逐项授权 exact package build', collect, [])
    .option('--allow-unverified', '显式允许 lock 中不可验证的插件')
    .option('--allow-version-mismatch', '显式允许 dsh 版本超出 tested 范围')
    .option('--allow-danger-full-access', '显式允许 danger-full-access')
    .option('--force', '覆盖冲突 asset 前先备份')
    .option('--yes', '确认普通安装；不替代任何危险授权')
    .option('--json', 'stdout 仅输出一个 JSON object')
    .action(async (source: string, options: InstallCommandOptions) => {
      const root = program.opts<{ color?: boolean; dshHome?: string; json?: boolean }>();
      const json = options.json === true || root.json === true;
      const home = resolveDshHome(program);
      if (!home.ok) {
        writeReport(home.report, json);
        return;
      }
      const runtime = runtimeFactory(home.value, {
        writeStderr: (message) =>
          process.stderr.write(`${root.color === false ? stripAnsi(message) : message}\n`),
      });
      const report = await run(
        installInput(source, home.value, json, interactive(), options),
        runtime,
      );
      writeReport(report, json);
      if (!json) showSuccess(report, home.value);
    });
}
