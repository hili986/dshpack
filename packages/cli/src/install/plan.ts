import { isAbsolute } from 'node:path';

import type { Diagnostic } from '@dshpack/core';

import { EXIT_CODES, type ExitCode } from '../exit-codes.js';
import { buildInstallPlan } from './build-plan.js';
import { decideInstall } from './policy.js';
import { readValidatedPack } from './read.js';
import { reconcileLockedPlugin } from './reconcile.js';
import type {
  InstallDecision,
  InstallPlanPlugin,
  InstallPreflightResult,
  PrepareInstallPlanInput,
} from './types.js';

const profileName = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

function diagnostic(code: string, message: string, hint: string, path?: string): Diagnostic {
  return {
    code,
    severity: 'error',
    message,
    hint,
    evidence: 'local',
    ...(path === undefined ? {} : { path }),
  };
}

function emptyDecision(): InstallDecision {
  return {
    status: 'rejected',
    prompts: [],
    missingAllowBuilds: [],
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

function environmentFailure(input: PrepareInstallPlanInput): Diagnostic | undefined {
  const { dshHome, dshVersion, pnpmVersion } = input.environment;
  if (dshHome.trim().length === 0 || !isAbsolute(dshHome) || dshHome.includes('\0')) {
    return diagnostic(
      'E_DSH_HOME',
      'DSH_HOME 必须是非空绝对路径。',
      '显式提供隔离且绝对的 --dsh-home。',
      dshHome,
    );
  }
  if (dshVersion.trim().length === 0)
    return diagnostic('E_DSH_VERSION', '未取得 dsh 版本。', '先完成 dsh probe。');
  if (pnpmVersion.trim().length === 0)
    return diagnostic('E_PNPM_VERSION', '未取得 pnpm 版本。', '先完成 pnpm probe。');
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

function unknownBuildAuthorization(
  plugins: readonly InstallPlanPlugin[],
  allowed: readonly string[],
): Diagnostic | undefined {
  const required = new Set(
    plugins.filter(({ allowBuilds }) => allowBuilds).map(({ name }) => name),
  );
  const unknown = allowed.filter((name) => !required.has(name));
  if (unknown.length === 0) return undefined;
  return diagnostic(
    'E_ALLOW_BUILD_UNKNOWN',
    `--allow-build 只能逐项授权 manifest 中 allowBuilds=true 的直接包：${unknown.join(', ')}。`,
    '移除未请求构建权限的包名。',
  );
}

/**
 * Read-only install preflight. It consumes an already materialized source directory and injected
 * environment facts; it never creates a profile, transaction journal, settings file, or DSH_HOME.
 */
export async function prepareInstallPlan(
  input: PrepareInstallPlanInput,
): Promise<InstallPreflightResult> {
  const invalidEnvironment = environmentFailure(input);
  if (invalidEnvironment !== undefined) {
    return failure(EXIT_CODES.ENVIRONMENT, [invalidEnvironment]);
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
  if (input.options.as !== undefined && !validProfile(input.options.as)) {
    return failure(EXIT_CODES.SECURITY, [
      diagnostic(
        'E_PROFILE_NAME',
        '目标 profile 名不符合安全规则。',
        '使用 3–64 位 kebab-case，且不能为 web/headless。',
        input.options.as,
      ),
    ]);
  }

  const read = await readValidatedPack(input.source.directory);
  if (read.material === undefined) return failure(read.exitCode, read.diagnostics);
  const { manifest, lock, paths } = read.material;
  const targetProfile = input.options.as ?? manifest.name;
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
  if (
    manifest.settings !== undefined &&
    manifest.settings.namespaces['agent-presets'] !== 'agent-presets.yml'
  ) {
    return failure(EXIT_CODES.CONTRACT, [
      diagnostic(
        'E_SETTINGS_SOURCE',
        'v0 settings namespace 必须引用 settings/agent-presets.yml。',
        '将 agent-presets 映射值改为 agent-presets.yml。',
      ),
    ]);
  }
  if (manifest.settings !== undefined && !paths.includes('settings/agent-presets.yml')) {
    return failure(EXIT_CODES.CONTRACT, [
      diagnostic(
        'E_SETTINGS_SOURCE_MISSING',
        'manifest 声明了 agent-presets settings，但 payload 文件不存在。',
        '提供 settings/agent-presets.yml 并将其加入 lock.files。',
        'settings/agent-presets.yml',
      ),
    ]);
  }

  const plugins: InstallPlanPlugin[] = [];
  for (let index = 0; index < manifest.plugins.length; index += 1) {
    // validateLocalPack proved the one-to-one, same-order lock invariant before this loop.
    const declaration = manifest.plugins[index] as (typeof manifest.plugins)[number];
    const locked = lock.plugins[index] as (typeof lock.plugins)[number];
    const reconciled = reconcileLockedPlugin(declaration, locked);
    if (reconciled.plugin === undefined) {
      return failure(EXIT_CODES.SOURCE_NETWORK_INTEGRITY, reconciled.diagnostics);
    }
    plugins.push(reconciled.plugin);
  }

  const unverified = unverifiedFailure(plugins, input.options.allowUnverified === true);
  if (unverified !== undefined) {
    return failure(EXIT_CODES.SOURCE_NETWORK_INTEGRITY, [unverified]);
  }
  const unknownBuild = unknownBuildAuthorization(plugins, input.options.allowBuilds ?? []);
  if (unknownBuild !== undefined) return failure(EXIT_CODES.CONTRACT, [unknownBuild]);

  const plan = buildInstallPlan({
    provenance: input.source.provenance,
    manifest,
    lock,
    plugins,
    paths,
    targetProfile,
    options: input.options,
    environment: input.environment,
  });
  const decided = decideInstall(input.options, input.environment, plan);
  const diagnostics = [...read.diagnostics];
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

export type {
  InstallDecision,
  InstallEnvironmentFacts,
  InstallPlan,
  InstallPlanOptions,
  InstallPreflightResult,
  PrepareInstallPlanInput,
} from './types.js';
