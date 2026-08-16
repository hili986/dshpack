import { join, resolve } from 'node:path';

import { confirm, isCancel } from '@clack/prompts';
import { execa } from 'execa';

import { YamlSettingsAdapter } from '../adapters/settings.js';
import { type CommandReport, diagnostic, exitCodeFor } from '../commands/shared.js';
import { EXIT_CODES, type ExitCode } from '../exit-codes.js';
import {
  inspectMetadata,
  inspectProfile,
  isSafeProfileName,
  presetExists,
} from '../list/contracts.js';
import { updateSelectedPreset } from './settings.js';

export interface SwitchInput {
  dshHome: string;
  profile: string;
  run?: boolean;
  setDefaultPreset?: boolean;
  yes?: boolean;
  json?: boolean;
}

export interface SwitchMetadata {
  profile: string;
  command: string;
  ran: boolean;
  settingsChanged: boolean;
  effect?: 'new-session';
}

export interface SwitchRuntime {
  isTTY: boolean;
  showDiff(diff: string): void;
  confirm(options: { message: string; initialValue: false }): Promise<boolean>;
  spawnDsh(profile: string, dshHome: string): Promise<number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function foregroundDsh(profile: string, dshHome: string): Promise<number> {
  const result = await execa('dsh', ['--profile', profile], {
    cwd: join(dshHome, 'profiles', profile),
    env: { ...process.env, DSH_HOME: dshHome },
    // Never enable tree termination: Execa uses taskkill /T on Windows.
    killDescendants: false,
    reject: false,
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });
  return result.exitCode ?? 1;
}

export const nodeSwitchRuntime: SwitchRuntime = {
  isTTY: process.stdin.isTTY === true,
  showDiff(diff) {
    process.stderr.write(`${diff}\n`);
  },
  async confirm(options) {
    const answer = await confirm(options);
    return !isCancel(answer) && answer === true;
  },
  spawnDsh: foregroundDsh,
};

function report(
  input: SwitchInput,
  code: string,
  message: string,
  hint: string,
  exitCode: ExitCode,
): CommandReport<SwitchMetadata> {
  return {
    diagnostics: [diagnostic(code, 'error', message, hint)],
    exitCode,
    metadata: {
      profile: input.profile,
      command: `dsh --profile ${input.profile}`,
      ran: false,
      settingsChanged: false,
    },
  };
}

function displayValue(value: unknown): string {
  return value === undefined ? '(未设置)' : JSON.stringify(value);
}

function settingsDiff(previous: unknown, preset: string): string {
  return [
    'settings.yaml diff [新会话生效]',
    `- agent-presets.selected: ${displayValue(previous)}`,
    `+ agent-presets.selected: ${preset}`,
  ].join('\n');
}

function nonInteractiveCommand(input: SwitchInput, dshHome: string): string {
  return `dshpack --dsh-home ${JSON.stringify(dshHome)} switch ${input.profile} --set-default-preset --yes`;
}

async function setDefaultPreset(
  input: SwitchInput,
  dshHome: string,
  runtime: SwitchRuntime,
): Promise<CommandReport<SwitchMetadata> | undefined> {
  const metadataState = await inspectMetadata(dshHome, input.profile);
  if (metadataState.status === 'missing')
    return report(
      input,
      'E_SWITCH_UNTRACKED',
      '该 profile 没有 dshpack installed metadata，无法确定默认 preset。',
      '重新安装该 pack，或不要使用 --set-default-preset。',
      EXIT_CODES.CONTRACT,
    );
  if (metadataState.status === 'broken')
    return report(
      input,
      'E_SWITCH_METADATA',
      metadataState.reason,
      '修复 installed metadata 或重新安装该 pack。',
      EXIT_CODES.CONTRACT,
    );
  const preset = metadataState.metadata.defaults.agentPreset;
  if (preset === undefined)
    return report(
      input,
      'E_SWITCH_NO_DEFAULT',
      'installed metadata 没有默认 preset。',
      '不要使用 --set-default-preset，或安装声明默认 preset 的 pack。',
      EXIT_CODES.CONTRACT,
    );
  if (!(await presetExists(dshHome, preset)))
    return report(
      input,
      'E_SWITCH_PRESET_MISSING',
      'installed metadata 指定的默认 preset 不存在。',
      `恢复 .agent-presets/${preset}/agent.cordis.yml 后重试。`,
      EXIT_CODES.CONTRACT,
    );

  const adapter = new YamlSettingsAdapter(join(dshHome, 'settings.yaml'));
  const current = await adapter.read();
  if (!current.ok || current.value === undefined)
    return {
      diagnostics: current.diagnostics,
      exitCode: exitCodeFor(current.diagnostics),
      metadata: {
        profile: input.profile,
        command: `dsh --profile ${input.profile}`,
        ran: false,
        settingsChanged: false,
      },
    };
  const rawSection = current.value['agent-presets'];
  if (rawSection !== undefined && !isRecord(rawSection))
    return report(
      input,
      'E_SWITCH_SETTINGS',
      'settings.yaml 的 agent-presets namespace 必须是 mapping。',
      '修复 settings.yaml 后重试。',
      EXIT_CODES.CONTRACT,
    );
  const section = rawSection ?? {};
  runtime.showDiff(settingsDiff(section.selected, preset));
  if (input.yes !== true) {
    if (!runtime.isTTY)
      return report(
        input,
        'E_SWITCH_CONFIRM_REQUIRED',
        '非交互环境需要显式确认 settings.yaml 变更。',
        `非交互执行：${nonInteractiveCommand(input, dshHome)}`,
        EXIT_CODES.USER_DECLINED,
      );
    const accepted = await runtime.confirm({
      message: '确认将默认 agent preset 写入 settings.yaml？[新会话生效]',
      initialValue: false,
    });
    if (!accepted)
      return report(
        input,
        'E_SWITCH_DECLINED',
        '用户拒绝修改 settings.yaml。',
        '未写入任何 settings 变更。',
        EXIT_CODES.USER_DECLINED,
      );
  }
  const updated = await updateSelectedPreset(join(dshHome, 'settings.yaml'), preset);
  if (!updated.ok)
    return {
      diagnostics: updated.diagnostics,
      exitCode: exitCodeFor(updated.diagnostics),
      metadata: {
        profile: input.profile,
        command: `dsh --profile ${input.profile}`,
        ran: false,
        settingsChanged: false,
      },
    };
  return undefined;
}

export async function switchProfile(
  input: SwitchInput,
  runtime: SwitchRuntime = nodeSwitchRuntime,
): Promise<CommandReport<SwitchMetadata>> {
  if (input.run === true && input.json === true)
    return report(
      input,
      'E_SWITCH_JSON_RUN',
      '--run 不能与 --json 同时使用。',
      '移除 --run 获取 JSON 校验结果，或移除 --json 前台运行 dsh。',
      EXIT_CODES.USAGE,
    );
  if (input.dshHome.trim() === '')
    return report(
      input,
      'E_DSH_HOME_REQUIRED',
      'DSH_HOME 为空，已拒绝从当前目录推断。',
      '设置 --dsh-home 或 DSH_HOME 后重试。',
      EXIT_CODES.ENVIRONMENT,
    );
  if (!isSafeProfileName(input.profile))
    return report(
      input,
      'E_SWITCH_PROFILE_NAME',
      'profile 名称不符合安全规则。',
      '使用 3–64 字符的 kebab-case profile 名称。',
      EXIT_CODES.CONTRACT,
    );
  const dshHome = resolve(input.dshHome);
  const profileState = await inspectProfile(dshHome, input.profile);
  if (profileState.status !== 'valid')
    return report(
      input,
      'E_SWITCH_PROFILE',
      profileState.reason,
      '修复或初始化该 profile 后重试。',
      EXIT_CODES.CONTRACT,
    );
  let settingsChanged = false;
  if (input.setDefaultPreset === true) {
    const failure = await setDefaultPreset(input, dshHome, runtime);
    if (failure !== undefined) return failure;
    settingsChanged = true;
  } else {
    const metadataState = await inspectMetadata(dshHome, input.profile);
    if (metadataState.status === 'broken')
      return report(
        input,
        'E_SWITCH_METADATA',
        metadataState.reason,
        '修复 installed metadata 或重新安装该 pack。',
        EXIT_CODES.CONTRACT,
      );
  }
  if (input.run === true) {
    let childExit: number;
    try {
      childExit = await runtime.spawnDsh(input.profile, dshHome);
    } catch {
      return report(
        input,
        'E_SWITCH_DSH_MISSING',
        '无法在 PATH 中前台启动 dsh。',
        '安装 dsh 并修复 PATH 后重试。',
        EXIT_CODES.ENVIRONMENT,
      );
    }
    if (childExit !== 0)
      return report(
        input,
        'E_SWITCH_DSH_EXIT',
        `前台 dsh 以 exit ${childExit} 结束。`,
        '检查 dsh 输出后重试。',
        EXIT_CODES.DSH_SUBPROCESS_FAILURE,
      );
  }
  return {
    diagnostics: [],
    exitCode: EXIT_CODES.SUCCESS,
    metadata: {
      profile: input.profile,
      command: `dsh --profile ${input.profile}`,
      ran: input.run === true,
      settingsChanged,
      ...(settingsChanged ? { effect: 'new-session' as const } : {}),
    },
  };
}
