import type { Command } from 'commander';
import { type DiffInput, type DiffReport, type DiffRuntime, diffProfile } from '../diff/engine.js';
import { createNodeInstallRuntime } from '../install/runtime.js';
import { terminalSafeText } from '../terminal-safe.js';
import { resolveDshHome, writeReport } from './shared.js';

export const diffCommand = {
  name: 'diff',
  description: '只读对比受跟踪 profile 的本地漂移与可选上游差异',
} as const;

export type DiffRunner = (input: DiffInput, runtime: DiffRuntime) => Promise<DiffReport>;
export type DiffRuntimeFactory = (dshHome: string) => DiffRuntime;

function display(report: DiffReport): void {
  const groups = [
    ['local-drift', report.metadata.localDrift],
    ['upstream-delta', report.metadata.upstreamDelta],
    ['effective-mismatch', report.metadata.effectiveMismatch],
  ] as const;
  process.stdout.write(
    `${terminalSafeText(report.metadata.profile)}  ${terminalSafeText(report.metadata.pack.name)}@${terminalSafeText(report.metadata.pack.version)}\n`,
  );
  for (const [label, entries] of groups) {
    process.stdout.write(`${label}: ${entries.length}\n`);
    for (const entry of entries) {
      if ('mergeAction' in entry)
        process.stdout.write(
          `  ${entry.mergeAction} ${entry.kind}:${terminalSafeText(entry.target)}\n`,
        );
      else
        process.stdout.write(
          `  ${terminalSafeText(entry.source)} -> ${terminalSafeText(entry.effective)}\n`,
        );
    }
  }
  if (report.metadata.sideEffects?.some(({ path }) => path === 'profile/cordis.yml'))
    process.stdout.write('注意：--effective 已请求 dsh 写入 profile/cordis.yml。\n');
}

export function registerDiffCommand(
  program: Command,
  run: DiffRunner = diffProfile,
  runtimeFactory: DiffRuntimeFactory = createNodeInstallRuntime,
): void {
  program
    .command('diff <profile>')
    .description(diffCommand.description)
    .option('--to <source>', '指定目标 SOURCE，执行完整三方对比')
    .option('--effective', '调用 dsh --dump-config 对账生效层；会写入 profile/cordis.yml')
    .option('--json', 'stdout 仅输出一个 JSON object')
    .action(
      async (profile: string, options: { to?: string; effective?: boolean; json?: boolean }) => {
        const root = program.opts<{ json?: boolean }>();
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
            ...(options.effective === true ? { effective: true } : {}),
          },
          runtimeFactory(home.value),
        );
        writeReport(report, json);
        if (report.exitCode === 0 && !json) display(report);
      },
    );
}
