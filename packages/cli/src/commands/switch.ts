import type { Command } from 'commander';
import { type SwitchInput, type SwitchMetadata, switchProfile } from '../switch/engine.js';
import type { CommandReport } from './shared.js';
import { resolveDshHome, writeReport } from './shared.js';

export const switchCommand = {
  name: 'switch',
  description: '校验并显示 profile 启动命令；仅 --run 才前台启动 dsh',
} as const;

export type SwitchRunner = (input: SwitchInput) => Promise<CommandReport<SwitchMetadata>>;

export function registerSwitchCommand(
  program: Command,
  runSwitch: SwitchRunner = switchProfile,
): void {
  program
    .command('switch <profile>')
    .description(switchCommand.description)
    .option('--run', '以前台 direct child 运行 dsh；不会终止其他 dsh 进程')
    .option('--set-default-preset', '显示 diff 并确认写入默认 preset（新会话生效）')
    .option('--yes', '确认普通 settings.yaml 变更；不替代任何危险授权')
    .option('--json', 'stdout 仅输出一个 JSON object；不能与 --run 同用')
    .action(
      async (
        profile: string,
        options: { json?: boolean; run?: boolean; setDefaultPreset?: boolean; yes?: boolean },
      ) => {
        const root = program.opts<{ dshHome?: string; json?: boolean }>();
        const json = options.json === true || root.json === true;
        const home = resolveDshHome(program);
        if (!home.ok) {
          writeReport(home.report, json);
          return;
        }
        const report = await runSwitch({
          dshHome: home.value,
          profile,
          json,
          run: options.run === true,
          setDefaultPreset: options.setDefaultPreset === true,
          yes: options.yes === true,
        });
        writeReport(report, json);
        if (report.exitCode === 0 && !json && options.run !== true)
          process.stdout.write(`${report.metadata.command}\n`);
      },
    );
}
