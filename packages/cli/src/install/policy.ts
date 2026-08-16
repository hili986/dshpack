import type { Diagnostic } from '@dshpack/core';

import type {
  InstallDecision,
  InstallEnvironmentFacts,
  InstallPlan,
  InstallPlanOptions,
  InstallPromptDecision,
} from './types.js';

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function nonInteractiveInstallArgv(
  options: InstallPlanOptions,
  plan: InstallPlan,
  environment: InstallEnvironmentFacts,
): string[] {
  const args = [
    'install',
    options.sourceArgument,
    '--as',
    plan.targetProfile,
    '--dsh-home',
    environment.dshHome,
    '--frozen',
  ];
  if (plan.replaceExistingProfile) args.push('--replace');
  if (plan.plugins.some(({ integrity }) => integrity.kind === 'unverified'))
    args.push('--allow-unverified');
  for (const name of [...plan.allowBuilds, ...plan.extraBuildApprovals])
    args.push('--allow-build', name);
  if (plan.requiredDangerousPermissions.length > 0) args.push('--allow-danger-full-access');
  if (plan.dsh.versionMismatch) args.push('--allow-version-mismatch');
  if (options.force === true) args.push('--force');
  args.push('--yes');
  return args;
}

export function nonInteractiveInstallCommand(
  options: InstallPlanOptions,
  plan: InstallPlan,
  environment: InstallEnvironmentFacts,
): string {
  const argv = nonInteractiveInstallArgv(options, plan, environment);
  const rendered = argv.map((value, index) => {
    const previous = argv[index - 1];
    if (value === 'install' || value.startsWith('--')) return value;
    if (index === 1 || previous === '--dsh-home') return quotePowerShell(value);
    return /^[A-Za-z0-9_@.-]+$/u.test(value) ? value : quotePowerShell(value);
  });
  return ['dshpack', ...rendered].join(' ');
}

function prompt(kind: InstallPromptDecision['kind'], subject: string): InstallPromptDecision {
  return { kind, subject, defaultValue: false };
}

export function decideInstall(
  options: InstallPlanOptions,
  environment: InstallEnvironmentFacts,
  plan: InstallPlan,
): { decision: InstallDecision; diagnostic?: Diagnostic } {
  const grantedBuilds = new Set(options.allowBuilds ?? []);
  const missingAllowBuilds = plan.allowBuilds.filter((name) => !grantedBuilds.has(name));
  const prompts: InstallPromptDecision[] = [];
  if (options.dryRun === true) {
    const nonInteractiveArgv = nonInteractiveInstallArgv(options, plan, environment);
    return {
      decision: {
        status: 'review-only',
        prompts,
        missingAllowBuilds,
        nonInteractiveArgv,
        nonInteractiveCommand: nonInteractiveInstallCommand(options, plan, environment),
      },
    };
  }
  for (const name of missingAllowBuilds) prompts.push(prompt('allow-build', name));
  if (plan.requiredDangerousPermissions.length > 0 && options.allowDangerFullAccess !== true) {
    prompts.push(prompt('danger-full-access', 'danger-full-access'));
  }
  if (
    plan.dsh.versionMismatch &&
    !(options.yes === true && options.allowVersionMismatch === true)
  ) {
    prompts.push(prompt('version-mismatch', `${plan.dsh.current} ∉ dsh.tested`));
  }
  if (options.yes !== true) prompts.push(prompt('install', plan.targetProfile));
  const nonInteractiveArgv = nonInteractiveInstallArgv(options, plan, environment);
  const command = nonInteractiveInstallCommand(options, plan, environment);
  if (prompts.length === 0) {
    return {
      decision: {
        status: 'ready',
        prompts,
        missingAllowBuilds,
        nonInteractiveArgv,
        nonInteractiveCommand: command,
      },
    };
  }
  if (environment.interactive) {
    return {
      decision: {
        status: 'requires-interaction',
        prompts,
        missingAllowBuilds,
        nonInteractiveArgv,
        nonInteractiveCommand: command,
      },
    };
  }
  return {
    decision: {
      status: 'rejected',
      prompts,
      missingAllowBuilds,
      nonInteractiveArgv,
      nonInteractiveCommand: command,
    },
    diagnostic: {
      code: 'E_CONFIRMATION_REQUIRED',
      severity: 'error',
      message: '非交互安装缺少逐项授权或确认。',
      hint: `运行完整非交互命令：${command}`,
      evidence: 'local',
    },
  };
}
