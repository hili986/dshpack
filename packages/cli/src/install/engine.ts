import type { Diagnostic } from '@dshpack/core';
import { satisfies } from 'semver';

import { SourceError } from '../adapters/source.js';
import { diagnostic } from '../commands/shared.js';
import { EXIT_CODES, type ExitCode } from '../exit-codes.js';
import { runTransaction, TransactionFailure } from '../transaction.js';
import { skillsIn } from './build-plan.js';
import { applyInstallOperation } from './engine-apply.js';
import { runInstallFault } from './engine-errors.js';
import type { InstallReplayCommand } from './engine-profile.js';
import { prepareInstallPlanFromValidated } from './plan.js';
import type { ReadPackResult, ValidatedPackMaterial } from './read.js';
import type {
  CaptureInstallTargetInput,
  InstallInput,
  InstallReport,
  InstallRuntime,
  InstallTargetCapture,
} from './runtime-types.js';
import type { InstallPlan, InstallPromptDecision, InstallResolution } from './types.js';

function report(
  exitCode: ExitCode,
  diagnostics: readonly Diagnostic[],
  status: InstallReport['metadata']['status'],
  plan?: InstallPlan,
): InstallReport {
  return {
    diagnostics,
    exitCode,
    metadata: { status, ...(plan === undefined ? {} : { plan, profile: plan.targetProfile }) },
  };
}

export function captureInstallTargetRequest(
  input: Pick<InstallInput, 'dshHome' | 'as'>,
  material: ValidatedPackMaterial,
): CaptureInstallTargetInput {
  const profile = input.as ?? material.manifest.name;
  const presets = [
    ...new Set(
      material.paths
        .filter((path) => path.startsWith('presets/'))
        .map((path) => `.agent-presets/${path.split('/')[1] as string}`),
    ),
  ].sort();
  const defaultPreset = material.manifest.defaults.agentPreset;
  const bundledDefault =
    defaultPreset !== undefined &&
    material.paths.includes(`presets/${defaultPreset}/agent.cordis.yml`);
  return {
    dshHome: input.dshHome,
    profile,
    skills: skillsIn(material.paths).map(({ id }) => `skills/${id}`),
    presets,
    ...(defaultPreset === undefined || bundledDefault
      ? {}
      : { externalDefaultPreset: `.agent-presets/${defaultPreset}` }),
  };
}

function renderReview(plan: InstallPlan): string {
  const lines = [
    `Will install ${plan.pack.name}@${plan.pack.version} as ${plan.targetProfile}`,
    `SOURCE: ${JSON.stringify(plan.source)}`,
    `dsh: current=${plan.dsh.current} tested=${plan.dsh.tested.join(',')} mismatch=${plan.dsh.versionMismatch}`,
    `pnpm: current=${plan.pnpm.current}`,
  ];
  for (const plugin of plan.plugins) {
    lines.push(
      `plugin ${plugin.name}: ${plugin.exactSpec} integrity=${JSON.stringify(plugin.integrity)} [${plugin.effectiveAt}]`,
    );
    if (plugin.allowBuilds) lines.push(`\u001b[31m[危险 allowBuilds] ${plugin.name}\u001b[0m`);
  }
  for (const asset of [...plan.skills, ...plan.presets])
    lines.push(
      `asset ${asset.source} -> ${asset.target} action=${asset.action} collision=${asset.collision} [${asset.effectiveAt}]`,
    );
  for (const mcp of plan.mcp)
    lines.push(
      `MCP ${mcp.serverName}: ${mcp.source} -> ${mcp.target} action=${mcp.action} [${mcp.effectiveAt}]`,
    );
  for (const setting of plan.settingsNamespaces)
    lines.push(
      `settings ${setting.source} -> ${setting.target} action=${setting.action} [${setting.effectiveAt}]`,
    );
  if (plan.defaults.agentPreset !== undefined)
    lines.push(
      `default agentPreset=${plan.defaults.agentPreset.value} source=${plan.defaults.agentPreset.source} [${plan.defaults.agentPreset.effectiveAt}]`,
    );
  lines.push(
    `default permissionPreset=${plan.defaults.permissionPreset.value} [${plan.defaults.permissionPreset.effectiveAt}]`,
  );
  for (const permission of plan.requiredDangerousPermissions)
    lines.push(`\u001b[31m[危险 permission] ${permission}：必须显式授权\u001b[0m`);
  for (const write of plan.writes) lines.push(`write ${write.path} [${write.effectiveAt}]`);
  for (const effect of plan.sideEffects) lines.push(`side-effect ${effect.path}: ${effect.reason}`);
  lines.push(
    `rollback snapshot: enabled=${plan.rollbackSnapshot.enabled} state=${plan.rollbackSnapshot.targetBeforeStateDigest}`,
  );
  return lines.join('\n');
}

async function confirmPlan(
  input: InstallInput,
  runtime: InstallRuntime,
  plan: InstallPlan,
  prompts: readonly InstallPromptDecision[],
): Promise<{
  ok: boolean;
  approvals: Set<string>;
  declined?: (typeof prompts)[number];
}> {
  const approvals = new Set(input.allowBuilds ?? []);
  if (input.json !== true) runtime.writeStderr(renderReview(plan));
  if (prompts.length === 0) return { ok: true, approvals };
  if (!input.interactive || input.json === true) return { ok: false, approvals };
  for (const prompt of prompts) {
    let accepted = false;
    try {
      accepted = await runtime.confirm(prompt);
    } catch {
      return { ok: false, approvals, declined: prompt };
    }
    if (!accepted) return { ok: false, approvals, declined: prompt };
    if (prompt.kind === 'allow-build') approvals.add(prompt.subject);
  }
  return { ok: true, approvals };
}

export async function installPack(
  input: InstallInput,
  runtime: InstallRuntime,
): Promise<InstallReport> {
  let materialized: Awaited<ReturnType<InstallRuntime['materializeSource']>>;
  try {
    materialized = await runtime.materializeSource(input.source);
  } catch (error) {
    if (error instanceof SourceError)
      return report(
        error.exitCode,
        [diagnostic(error.code, 'error', error.message, error.hint ?? '检查 SOURCE 后重试。')],
        'not-started',
      );
    return report(
      EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
      [diagnostic('E_SOURCE', 'error', 'SOURCE 获取失败。', '检查精确 source 诊断。')],
      'not-started',
    );
  }
  let read: ReadPackResult;
  try {
    read = await runtime.readValidatedPack(materialized.directory, {
      frozen: input.frozen === true,
    });
  } catch (error) {
    const item =
      error instanceof SourceError
        ? diagnostic(error.code, 'error', error.message, error.hint ?? '检查 SOURCE 后重试。')
        : diagnostic('E_SOURCE_READ', 'error', 'SOURCE 验证读取失败。', '固定 SOURCE 后重试。');
    read = {
      diagnostics: [item],
      exitCode: error instanceof SourceError ? error.exitCode : EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
    };
  } finally {
    try {
      await materialized.cleanup();
      await runInstallFault(runtime, 'source-cleanup');
    } catch (error) {
      read = {
        diagnostics:
          error instanceof TransactionFailure
            ? error.diagnostics
            : [
                diagnostic(
                  'E_SOURCE_CLEANUP',
                  'error',
                  'SOURCE 清理失败。',
                  '人工检查私有暂存路径。',
                ),
              ],
        exitCode: EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
      };
    }
  }
  if (read.material === undefined) return report(read.exitCode, read.diagnostics, 'not-started');
  const material = read.material;
  let versions: Awaited<ReturnType<InstallRuntime['probe']>>;
  try {
    versions = await runtime.probe();
  } catch {
    return report(
      EXIT_CODES.ENVIRONMENT,
      [diagnostic('E_PROBE', 'error', 'dsh 或 pnpm 不可用。', '仅从 PATH 安装受支持版本。')],
      'not-started',
    );
  }
  if (!satisfies(versions.pnpmVersion, '>=10.0.0'))
    return report(
      EXIT_CODES.ENVIRONMENT,
      [
        diagnostic(
          'E_PNPM_VERSION_UNSUPPORTED',
          'error',
          `pnpm ${versions.pnpmVersion} 低于 install 要求的 10.0.0。`,
          '从 PATH 提供 pnpm >=10 后重试；未执行任何目标写入。',
        ),
      ],
      'not-started',
    );
  let resolution: InstallResolution;
  try {
    resolution = await runtime.resolvePlugins(material, {
      dshHome: input.dshHome,
      frozen: input.frozen === true,
    });
  } catch (error) {
    const item =
      error instanceof SourceError
        ? diagnostic(error.code, 'error', error.message, error.hint ?? '修复插件来源后重试。')
        : diagnostic(
            'E_PLUGIN_RESOLUTION',
            'error',
            '无法把 manifest 解析为精确且可校验的插件来源。',
            '检查 PATH 中的 pnpm、网络来源与完整性诊断。',
          );
    return report(
      error instanceof SourceError ? error.exitCode : EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
      [item],
      'not-started',
    );
  }
  const request = captureInstallTargetRequest(input, material);
  let before: InstallTargetCapture;
  try {
    before = await runtime.captureTargetState(request);
  } catch {
    return report(
      EXIT_CODES.SECURITY,
      [
        diagnostic(
          'E_TARGET_STATE',
          'error',
          '无法安全采集目标写入面。',
          '移除 symlink/junction 后重试。',
        ),
      ],
      'not-started',
    );
  }
  const planInput = {
    source: { directory: materialized.directory, provenance: materialized.provenance },
    options: { ...input, sourceArgument: input.source },
    environment: {
      dshHome: input.dshHome,
      dshVersion: versions.dshVersion,
      pnpmVersion: versions.pnpmVersion,
      profileExists: before.state.profile.state === 'present',
      interactive: input.json === true ? false : input.interactive,
      targetBeforeState: before.state,
      targetBeforeStateDigest: before.digest,
    },
  };
  const preflight = await prepareInstallPlanFromValidated(
    planInput,
    material,
    read.diagnostics,
    resolution,
  );
  if (preflight.plan === undefined)
    return report(preflight.exitCode, preflight.diagnostics, 'not-started');
  const plan = preflight.plan;
  if (input.dryRun === true) {
    if (input.json !== true) runtime.writeStderr(renderReview(plan));
    return report(EXIT_CODES.SUCCESS, preflight.diagnostics, 'planned', plan);
  }
  const confirmed = await confirmPlan(input, runtime, plan, preflight.decision.prompts);
  if (!confirmed.ok) {
    const declined =
      confirmed.declined === undefined
        ? []
        : [
            diagnostic(
              'E_USER_DECLINED',
              'error',
              `用户拒绝 ${confirmed.declined.kind} 确认。`,
              '未执行任何安装写入；如需继续，请重新运行并显式确认。',
            ),
          ];
    return report(
      EXIT_CODES.USER_DECLINED,
      [...preflight.diagnostics, ...declined],
      'not-started',
      plan,
    );
  }
  let current: InstallTargetCapture;
  try {
    current = await runtime.captureTargetState(request);
  } catch {
    return report(
      EXIT_CODES.SECURITY,
      [
        diagnostic(
          'E_TARGET_STATE',
          'error',
          '确认后无法安全复验目标写入面。',
          '移除 symlink/junction 后重试。',
        ),
      ],
      'not-started',
      plan,
    );
  }
  if (current.digest !== before.digest)
    return report(
      EXIT_CODES.CONTRACT,
      [
        diagnostic(
          'E_TARGET_STATE_CHANGED',
          'error',
          '确认后目标写入面发生变化。',
          '重新生成 plan 后重试。',
        ),
      ],
      'not-started',
      plan,
    );
  const txid = runtime.txid();
  const operationDiagnostics = [...preflight.diagnostics];
  const replay: { current?: InstallReplayCommand } = {};
  const transaction = await runTransaction(
    { adapter: runtime.transactionAdapter, dshHome: input.dshHome, txid },
    async (tx) => {
      await applyInstallOperation({
        approvals: confirmed.approvals,
        before,
        diagnostics: operationDiagnostics,
        input,
        material,
        plan,
        replay,
        request,
        resolution,
        runtime,
        transaction: tx,
        txid,
      });
    },
  );
  if (!transaction.ok)
    return {
      diagnostics: [...operationDiagnostics, ...transaction.diagnostics],
      exitCode: transaction.exitCode,
      metadata: {
        status: transaction.status,
        plan,
        profile: plan.targetProfile,
        backupDirectory: transaction.backupDirectory,
        journalPath: transaction.journalPath,
        manualRecovery: transaction.manualRecovery,
        ...(replay.current === undefined ? {} : { requiredCommand: replay.current }),
      },
    };
  return {
    diagnostics: operationDiagnostics,
    exitCode: EXIT_CODES.SUCCESS,
    metadata: {
      status: 'installed',
      plan,
      profile: plan.targetProfile,
      backupDirectory: transaction.backupDirectory,
    },
  };
}
