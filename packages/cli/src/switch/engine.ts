import { join } from 'node:path';

import { confirm, isCancel } from '@clack/prompts';
import { execa } from 'execa';

import {
  type CommandReport,
  diagnostic,
  exitCodeFor,
  resolveDshHomeValue,
} from '../commands/shared.js';
import { EXIT_CODES, type ExitCode } from '../exit-codes.js';
import {
  type InspectionFailureKind,
  inspectMetadata,
  inspectPreset,
  inspectProfile,
  isInstallableProfileName,
  isReservedProfileName,
} from '../list/contracts.js';
import { revalidateDirectory } from '../list/safe-fs.js';
import { inspectCurrentAgentPresets, updateSelectedPreset } from './settings.js';

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
  facts: { ran: boolean; settingsChanged: boolean } = {
    ran: false,
    settingsChanged: false,
  },
): CommandReport<SwitchMetadata> {
  return {
    diagnostics: [diagnostic(code, 'error', message, hint)],
    exitCode,
    metadata: {
      profile: input.profile,
      command: `dsh --profile ${input.profile}`,
      ran: facts.ran,
      settingsChanged: facts.settingsChanged,
      ...(facts.settingsChanged ? { effect: 'new-session' as const } : {}),
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
  const quote = (value: string): string =>
    process.platform === 'win32'
      ? `'${value.replaceAll("'", "''")}'`
      : `'${value.replaceAll("'", `'"'"'`)}'`;
  const flags = [
    ...(input.run === true ? ['--run'] : []),
    ...(input.setDefaultPreset === true ? ['--set-default-preset'] : []),
    ...(input.json === true ? ['--json'] : []),
    '--yes',
  ];
  return `dshpack --dsh-home ${quote(dshHome)} switch ${input.profile} ${flags.join(' ')}`;
}

function isUnsafeProfileInput(profile: string): boolean {
  return (
    [...profile].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    }) ||
    /[/\\]/u.test(profile) ||
    profile.includes('..') ||
    /^[A-Za-z]:/u.test(profile)
  );
}

function exitForFailure(kind: InspectionFailureKind): ExitCode {
  if (kind === 'security') return EXIT_CODES.SECURITY;
  return kind === 'environment' ? EXIT_CODES.ENVIRONMENT : EXIT_CODES.CONTRACT;
}

async function setDefaultPreset(
  input: SwitchInput,
  dshHome: string,
  runtime: SwitchRuntime,
): Promise<CommandReport<SwitchMetadata> | boolean> {
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
      exitForFailure(metadataState.failureKind),
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
  const presetState = await inspectPreset(dshHome, preset);
  if (presetState.status !== 'valid')
    return report(
      input,
      presetState.status === 'broken' ? 'E_SWITCH_PRESET_PATH' : 'E_SWITCH_PRESET_MISSING',
      presetState.status === 'broken'
        ? presetState.reason
        : 'installed metadata 指定的默认 preset 不存在。',
      `恢复 .agent-presets/${preset}/agent.cordis.yml 后重试。`,
      presetState.status === 'broken'
        ? exitForFailure(presetState.failureKind)
        : EXIT_CODES.CONTRACT,
    );

  const current = await inspectCurrentAgentPresets(join(dshHome, 'settings.yaml'));
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
  try {
    runtime.showDiff(settingsDiff(current.value.selected, preset));
  } catch {
    return report(
      input,
      'E_SWITCH_DIFF_OUTPUT',
      '无法安全显示 settings diff。',
      '修复 stderr 输出环境后重试。',
      EXIT_CODES.ENVIRONMENT,
    );
  }
  if (input.yes !== true) {
    if (input.json === true || !runtime.isTTY)
      return report(
        input,
        'E_SWITCH_CONFIRM_REQUIRED',
        '非交互环境需要显式确认 settings.yaml 变更。',
        `非交互执行：${nonInteractiveCommand(input, dshHome)}`,
        EXIT_CODES.USER_DECLINED,
      );
    let accepted = false;
    try {
      accepted = await runtime.confirm({
        message: '确认将默认 agent preset 写入 settings.yaml？[新会话生效]',
        initialValue: false,
      });
    } catch {
      return report(
        input,
        'E_SWITCH_CONFIRM_IO',
        '交互确认失败，未写入 settings。',
        '修复终端输入后重试。',
        EXIT_CODES.ENVIRONMENT,
      );
    }
    if (!accepted)
      return report(
        input,
        'E_SWITCH_DECLINED',
        '用户拒绝修改 settings.yaml。',
        '未写入任何 settings 变更。',
        EXIT_CODES.USER_DECLINED,
      );
  }
  const updated = await updateSelectedPreset(
    join(dshHome, 'settings.yaml'),
    preset,
    {},
    current.value,
  );
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
  return updated.value ?? false;
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
  const resolution = resolveDshHomeValue(input.dshHome);
  if (!resolution.ok) {
    const item = resolution.report.diagnostics[0];
    return report(
      input,
      item?.code ?? 'E_DSH_HOME_REQUIRED',
      item?.message ?? 'DSH_HOME 无效。',
      item?.hint ?? '设置有效的绝对 DSH_HOME 后重试。',
      resolution.report.exitCode,
    );
  }
  // switch only inspects and prints a launch command, so it takes no ownership: dsh's own
  // reserved profiles are legitimate targets here even though install refuses to own them.
  if (!isInstallableProfileName(input.profile) && !isReservedProfileName(input.profile)) {
    const unsafe = isUnsafeProfileInput(input.profile);
    return report(
      input,
      unsafe ? 'E_PATH_PROFILE' : 'E_SWITCH_PROFILE_NAME',
      'profile 名称不符合安全规则。',
      '使用 3–64 字符的 kebab-case profile 名称。',
      unsafe ? EXIT_CODES.SECURITY : EXIT_CODES.CONTRACT,
    );
  }
  const dshHome = resolution.value;
  const profileState = await inspectProfile(dshHome, input.profile);
  if (profileState.status !== 'valid')
    return report(
      input,
      'E_SWITCH_PROFILE',
      profileState.reason,
      '修复或初始化该 profile 后重试。',
      exitForFailure(profileState.failureKind),
    );
  let settingsChanged = false;
  if (input.setDefaultPreset === true) {
    const result = await setDefaultPreset(input, dshHome, runtime);
    if (typeof result !== 'boolean') return result;
    settingsChanged = result;
  } else {
    const metadataState = await inspectMetadata(dshHome, input.profile);
    if (metadataState.status === 'broken')
      return report(
        input,
        'E_SWITCH_METADATA',
        metadataState.reason,
        '修复 installed metadata 或重新安装该 pack。',
        exitForFailure(metadataState.failureKind),
      );
  }
  if (input.run === true) {
    const stableProfile = await revalidateDirectory(profileState.binding);
    if (!stableProfile.ok)
      return report(
        input,
        'E_PATH_PROFILE_CHANGED',
        stableProfile.reason,
        '确认 profile 路径未被替换且不含 symlink 后重试。',
        EXIT_CODES.SECURITY,
        { ran: false, settingsChanged },
      );
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
        { ran: false, settingsChanged },
      );
    }
    if (childExit !== 0)
      return report(
        input,
        'E_SWITCH_DSH_EXIT',
        `前台 dsh 以 exit ${childExit} 结束。`,
        '检查 dsh 输出后重试。',
        EXIT_CODES.DSH_SUBPROCESS_FAILURE,
        { ran: true, settingsChanged },
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
