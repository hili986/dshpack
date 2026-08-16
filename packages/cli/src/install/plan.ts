import { isAbsolute } from 'node:path';

import type { Diagnostic } from '@dshpack/core';

import { EXIT_CODES, type ExitCode } from '../exit-codes.js';
import { buildInstallPlan, digestTargetBeforeState, skillsIn } from './build-plan.js';
import { contentFailure, diagnostic } from './content-validation.js';
import { decideInstall } from './policy.js';
import { readValidatedPack, type ValidatedPackMaterial } from './read.js';
import { reconcileLockedPlugin } from './reconcile.js';
import type {
  InstallDecision,
  InstallPlanPlugin,
  InstallPreflightResult,
  PrepareInstallPlanInput,
} from './types.js';

const profileName = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const exactPackageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function emptyDecision(): InstallDecision {
  return {
    status: 'rejected',
    prompts: [],
    missingAllowBuilds: [],
    nonInteractiveArgv: [],
    nonInteractiveCommand: '',
  };
}

function failure(exitCode: ExitCode, diagnostics: readonly Diagnostic[]): InstallPreflightResult {
  return { exitCode, diagnostics, decision: emptyDecision() };
}

function validProfile(value: string): boolean {
  return (
    value.length >= 3 &&
    value.length <= 64 &&
    value !== 'web' &&
    value !== 'headless' &&
    profileName.test(value)
  );
}

function profilePathRisk(value: string): boolean {
  return (
    hasControl(value) ||
    value.includes('/') ||
    value.includes('\\') ||
    value === '.' ||
    value === '..' ||
    /^[A-Za-z]:/u.test(value) ||
    isAbsolute(value)
  );
}

function inputFailure(input: PrepareInstallPlanInput): InstallPreflightResult | undefined {
  const { dshHome, dshVersion, pnpmVersion } = input.environment;
  if (hasControl(input.options.sourceArgument) || hasControl(dshHome)) {
    return failure(EXIT_CODES.SECURITY, [
      diagnostic(
        'E_COMMAND_CONTROL',
        'SOURCE 或 DSH_HOME 含控制字符。',
        '移除换行、NUL 与其他控制字符后重试。',
      ),
    ]);
  }
  if (dshHome.trim().length === 0 || !isAbsolute(dshHome)) {
    return failure(EXIT_CODES.ENVIRONMENT, [
      diagnostic(
        'E_DSH_HOME',
        'DSH_HOME 必须是非空绝对路径。',
        '显式提供隔离的绝对 --dsh-home。',
        dshHome,
      ),
    ]);
  }
  if (dshVersion.trim().length === 0)
    return failure(EXIT_CODES.ENVIRONMENT, [
      diagnostic('E_DSH_VERSION', '未取得 dsh 版本。', '先完成 dsh probe。'),
    ]);
  if (pnpmVersion.trim().length === 0)
    return failure(EXIT_CODES.ENVIRONMENT, [
      diagnostic('E_PNPM_VERSION', '未取得 pnpm 版本。', '先完成 pnpm probe。'),
    ]);
  if (input.options.frozen === false) {
    return failure(EXIT_CODES.CONTRACT, [
      diagnostic(
        'E_FROZEN_REQUIRED',
        'M0 install 只接受 frozen lock。',
        '移除禁用 frozen 的请求并保留 pack.lock.yml。',
      ),
    ]);
  }
  if (input.options.as !== undefined && profilePathRisk(input.options.as)) {
    return failure(EXIT_CODES.SECURITY, [
      diagnostic(
        'E_PROFILE_PATH',
        '目标 profile 含路径或控制字符。',
        '只提供安全 kebab-case profile 名。',
        input.options.as,
      ),
    ]);
  }
  if (input.options.as !== undefined && !validProfile(input.options.as)) {
    return failure(EXIT_CODES.CONTRACT, [
      diagnostic(
        'E_PROFILE_NAME',
        '目标 profile 名不符合契约。',
        '使用 3–64 位 kebab-case，且不能为 web/headless。',
        input.options.as,
      ),
    ]);
  }
  if (!isAbsolute(input.source.directory)) {
    return failure(EXIT_CODES.SOURCE_NETWORK_INTEGRITY, [
      diagnostic(
        'E_SOURCE_DIRECTORY',
        'materialized source 必须是绝对目录。',
        '先通过 source adapter 归一化 SOURCE。',
        input.source.directory,
      ),
    ]);
  }
  return undefined;
}

function buildApprovalFailure(allowed: readonly string[]): Diagnostic | undefined {
  const invalid = allowed.find((name) => !exactPackageName.test(name));
  return invalid === undefined
    ? undefined
    : diagnostic(
        'E_ALLOW_BUILD_PATTERN',
        `--allow-build 必须是精确包名：${invalid}`,
        '禁止 glob；逐个提供完整 npm package 名。',
        invalid,
      );
}

function samePaths(actual: readonly { path: string }[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every(
      ({ path }, index) => path === [...expected].sort((a, b) => a.localeCompare(b, 'en'))[index],
    )
  );
}

function beforeStateFailure(
  input: PrepareInstallPlanInput,
  material: ValidatedPackMaterial,
  targetProfile: string,
): Diagnostic | undefined {
  const {
    targetBeforeState: state,
    targetBeforeStateDigest: digest,
    profileExists,
  } = input.environment;
  if (digestTargetBeforeState(state) !== digest) {
    return diagnostic(
      'E_BEFORE_STATE_DIGEST',
      '目标写入前状态摘要不匹配。',
      '重新采集 profile/assets/settings 状态。',
    );
  }
  if (
    state.profile.path !== `profiles/${targetProfile}` ||
    (state.profile.state === 'present') !== profileExists ||
    state.settings.path !== 'settings.yaml'
  ) {
    return diagnostic(
      'E_BEFORE_STATE_TARGET',
      '目标写入前状态与目标 profile 不一致。',
      '按最终 target 重新采集状态。',
    );
  }
  const skills = skillsIn(material.paths).map(({ id }) => `skills/${id}`);
  const presets = [
    ...new Set(
      material.paths
        .filter((path) => path.startsWith('presets/'))
        .map((path) => `.agent-presets/${path.split('/')[1] as string}`),
    ),
  ];
  const sortedSkills = [...state.skills].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const sortedPresets = [...state.presets].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (!samePaths(sortedSkills, skills) || !samePaths(sortedPresets, presets)) {
    return diagnostic(
      'E_BEFORE_STATE_ASSETS',
      'skills/presets 写入前状态不完整。',
      '为 plan 中每个目标采集 absent 或内容摘要。',
    );
  }
  const defaultPreset = material.manifest.defaults.agentPreset;
  const bundledDefault =
    defaultPreset !== undefined &&
    material.paths.includes(`presets/${defaultPreset}/agent.cordis.yml`);
  const external = state.externalDefaultPreset;
  if (
    defaultPreset !== undefined &&
    !bundledDefault &&
    external !== undefined &&
    (external.path !== `.agent-presets/${defaultPreset}` ||
      external.state !== 'present' ||
      !/^sha256-[A-Za-z0-9_-]+$/u.test(external.sha256))
  ) {
    return diagnostic(
      'E_DEFAULT_PRESET_STATE',
      '外部默认 preset 的路径、存在性或摘要无效。',
      '重新采集精确 .agent-presets/<id> 目录摘要。',
      external.path,
    );
  }
  return undefined;
}

function unverifiedFailure(
  plugins: readonly InstallPlanPlugin[],
  allowed: boolean,
): Diagnostic | undefined {
  const names = plugins
    .filter(({ integrity }) => integrity.kind === 'unverified')
    .map(({ name }) => name);
  if (names.length === 0 || allowed) return undefined;
  return diagnostic(
    'E_UNVERIFIED_REQUIRED',
    `插件 ${names.join(', ')} 缺少可验证 integrity。`,
    '仅在独立审计后显式提供 --allow-unverified；--yes 不授权此风险。',
  );
}

export async function prepareInstallPlanFromValidated(
  input: PrepareInstallPlanInput,
  material: ValidatedPackMaterial,
  validationDiagnostics: readonly Diagnostic[] = [],
): Promise<InstallPreflightResult> {
  const invalidInput = inputFailure(input);
  if (invalidInput !== undefined) return invalidInput;
  const targetProfile = input.options.as ?? material.manifest.name;
  if (!validProfile(targetProfile)) {
    return failure(EXIT_CODES.CONTRACT, [
      diagnostic(
        'E_PROFILE_NAME',
        '目标 profile 名不符合契约。',
        '修复 pack.name 或显式提供安全 --as。',
        targetProfile,
      ),
    ]);
  }
  const beforeFailure = beforeStateFailure(input, material, targetProfile);
  if (beforeFailure !== undefined) return failure(EXIT_CODES.CONTRACT, [beforeFailure]);
  if (input.environment.profileExists && input.options.replace !== true) {
    return failure(EXIT_CODES.PROFILE_CONFLICT_OR_LOCK, [
      diagnostic(
        'E_PROFILE_EXISTS',
        `profile ${targetProfile} 已存在。`,
        '确认备份与替换意图后显式提供 --replace；--yes 不能替代。',
        `profiles/${targetProfile}`,
      ),
    ]);
  }
  const content = contentFailure(material);
  if (content !== undefined) {
    const exitCode = /^(?:E_SECRET|E_SETTINGS_MCP_ENV)/u.test(content.code)
      ? EXIT_CODES.SECURITY
      : EXIT_CODES.CONTRACT;
    return failure(exitCode, [content]);
  }
  const approval = buildApprovalFailure(input.options.allowBuilds ?? []);
  if (approval !== undefined) return failure(EXIT_CODES.CONTRACT, [approval]);

  const plugins: InstallPlanPlugin[] = [];
  for (let index = 0; index < material.manifest.plugins.length; index += 1) {
    const declaration = material.manifest.plugins[
      index
    ] as (typeof material.manifest.plugins)[number];
    const locked = material.lock.plugins[index] as (typeof material.lock.plugins)[number];
    const reconciled = reconcileLockedPlugin(declaration, locked);
    if (reconciled.plugin === undefined) {
      return failure(EXIT_CODES.SOURCE_NETWORK_INTEGRITY, reconciled.diagnostics);
    }
    plugins.push(reconciled.plugin);
  }
  const unverified = unverifiedFailure(plugins, input.options.allowUnverified === true);
  if (unverified !== undefined) return failure(EXIT_CODES.SOURCE_NETWORK_INTEGRITY, [unverified]);

  const defaultPreset = material.manifest.defaults.agentPreset;
  if (
    defaultPreset !== undefined &&
    !material.paths.includes(`presets/${defaultPreset}/agent.cordis.yml`) &&
    input.environment.targetBeforeState.externalDefaultPreset === undefined
  ) {
    return failure(EXIT_CODES.CONTRACT, [
      diagnostic(
        'E_DEFAULT_PRESET_MISSING',
        `默认 preset ${defaultPreset} 不在 pack 或已安装环境中。`,
        '携带对应 preset payload，或先安装并采集该 preset。',
      ),
    ]);
  }
  const plan = buildInstallPlan({
    provenance: input.source.provenance,
    manifest: material.manifest,
    lock: material.lock,
    lockDigest: material.lockDigest,
    sourceFiles: material.sourceFiles,
    plugins,
    paths: material.paths,
    targetProfile,
    options: input.options,
    environment: input.environment,
  });
  const decided = decideInstall(input.options, input.environment, plan);
  const diagnostics = [...validationDiagnostics];
  if (plan.dsh.versionMismatch) {
    diagnostics.push({
      code: 'W_DSH_VERSION_MISMATCH',
      severity: 'warning',
      message: `当前 dsh ${plan.dsh.current} 不在 pack 的 tested 列表。`,
      hint: '非交互安装必须同时提供 --yes 与 --allow-version-mismatch。',
      evidence: 'local',
    });
  }
  if (decided.diagnostic !== undefined) diagnostics.push(decided.diagnostic);
  return {
    plan,
    decision: decided.decision,
    diagnostics,
    exitCode: decided.diagnostic === undefined ? EXIT_CODES.SUCCESS : EXIT_CODES.USER_DECLINED,
  };
}

/** Read-only preflight. All later apply work must consume `ValidatedPackMaterial`, never SOURCE. */
export async function prepareInstallPlan(
  input: PrepareInstallPlanInput,
): Promise<InstallPreflightResult> {
  const invalidInput = inputFailure(input);
  if (invalidInput !== undefined) return invalidInput;
  const read = await readValidatedPack(input.source.directory);
  if (read.material === undefined) return failure(read.exitCode, read.diagnostics);
  return prepareInstallPlanFromValidated(input, read.material, read.diagnostics);
}

export type {
  InstallDecision,
  InstallEnvironmentFacts,
  InstallPlan,
  InstallPlanOptions,
  InstallPreflightResult,
  PrepareInstallPlanInput,
} from './types.js';
