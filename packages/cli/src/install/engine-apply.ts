import { join } from 'node:path';

import type { Diagnostic } from '@dshpack/core';

import { prepareAgentPresetsMerge } from '../adapters/settings.js';
import { diagnostic } from '../commands/shared.js';
import { EXIT_CODES } from '../exit-codes.js';
import { type TransactionContext, TransactionFailure } from '../transaction.js';
import { guardedInstall, installFailure, runInstallFault } from './engine-errors.js';
import { type InstallReplayCommand, installProfile } from './engine-profile.js';
import { installedMetadata } from './metadata.js';
import type { ValidatedPackMaterial } from './read.js';
import type {
  CaptureInstallTargetInput,
  InstallInput,
  InstallRuntime,
  InstallTargetCapture,
} from './runtime-types.js';
import type { InstallPlan, InstallPlanAsset, InstallResolution } from './types.js';

function materialText(material: ValidatedPackMaterial, path: string): string {
  const encoded = material.files.find((file) => file.path === path)?.contentBase64;
  if (encoded === undefined)
    throw installFailure(
      EXIT_CODES.CONTRACT,
      'E_INSTALL_PAYLOAD',
      `验证快照缺少 ${path}。`,
      '重新验证 pack。',
    );
  return Buffer.from(encoded, 'base64').toString('utf8');
}

async function applyAsset(
  transaction: TransactionContext,
  runtime: InstallRuntime,
  material: ValidatedPackMaterial,
  dshHome: string,
  asset: InstallPlanAsset,
  kind: 'skill' | 'preset',
  diagnostics: Diagnostic[],
): Promise<void> {
  if (asset.action === 'skip') {
    diagnostics.push(
      diagnostic(
        'W_ASSET_EXISTS',
        'warning',
        `跳过用户既有 ${asset.target}。`,
        '使用 --force 才会备份后替换。',
      ),
    );
    return;
  }
  const target = join(dshHome, ...asset.target.split('/'));
  if (asset.action === 'replace') await transaction.replaceArtifact(kind, target);
  await transaction.create(kind, target, () =>
    guardedInstall(EXIT_CODES.CONTRACT, 'E_ASSET_WRITE', `无法写入 ${asset.target}。`, () =>
      runtime.writeMaterialAsset(material, asset.source, target, kind),
    ),
  );
}

export interface ApplyInstallOperationInput {
  readonly approvals: Set<string>;
  readonly before: InstallTargetCapture;
  readonly diagnostics: Diagnostic[];
  readonly input: InstallInput;
  readonly material: ValidatedPackMaterial;
  readonly plan: InstallPlan;
  readonly request: CaptureInstallTargetInput;
  readonly replay: { current?: InstallReplayCommand };
  readonly resolution: InstallResolution;
  readonly runtime: InstallRuntime;
  readonly transaction: TransactionContext;
  readonly txid: string;
}

export async function applyInstallOperation(args: ApplyInstallOperationInput): Promise<void> {
  const {
    approvals,
    before,
    diagnostics,
    input,
    material,
    plan,
    replay,
    request,
    resolution,
    runtime,
    transaction,
    txid,
  } = args;
  const lockedState = await guardedInstall(
    EXIT_CODES.SECURITY,
    'E_TARGET_STATE',
    '事务锁内无法安全复验目标写入面。',
    () => runtime.captureTargetState(request),
  );
  if (lockedState.digest !== before.digest)
    throw installFailure(
      EXIT_CODES.CONTRACT,
      'E_TARGET_STATE_CHANGED',
      '事务锁内复验发现目标写入面变化。',
      '重新生成 plan 后重试。',
    );
  const facts = await installProfile(
    input,
    runtime,
    transaction,
    plan,
    material,
    resolution,
    approvals,
    replay,
  );
  for (const asset of plan.skills)
    await applyAsset(transaction, runtime, material, input.dshHome, asset, 'skill', diagnostics);
  for (const asset of plan.presets)
    await applyAsset(transaction, runtime, material, input.dshHome, asset, 'preset', diagnostics);
  await runInstallFault(runtime, 'assets');
  if (material.manifest.settings !== undefined) {
    const prepared = prepareAgentPresetsMerge({
      currentDocument: before.settingsDocument,
      fragment: materialText(material, 'settings/agent-presets.yml'),
      settingsPath: join(input.dshHome, 'settings.yaml'),
      fragmentPath: 'settings/agent-presets.yml',
    });
    if (!prepared.ok || prepared.value === undefined)
      throw new TransactionFailure(EXIT_CODES.CONTRACT, prepared.diagnostics);
    await transaction.writeSettings(
      join(input.dshHome, 'settings.yaml'),
      before.settingsDocument,
      prepared.value.document,
    );
  }
  await runInstallFault(runtime, 'settings');
  await guardedInstall(
    EXIT_CODES.POST_INSTALL_VERIFY_FAILURE,
    'E_DUMP_CONFIG',
    'dsh dump-config 对账失败。',
    () =>
      runtime.runDsh(['--profile', plan.targetProfile, '--dump-config'], {
        dshHome: input.dshHome,
        cwd: join(input.dshHome, 'profiles', plan.targetProfile),
      }),
  );
  await runInstallFault(runtime, 'dump');
  const doctor = await guardedInstall(
    EXIT_CODES.POST_INSTALL_VERIFY_FAILURE,
    'E_DOCTOR',
    'doctor --strict 快检失败。',
    () =>
      runtime.runDoctor({
        dshHome: input.dshHome,
        profile: plan.targetProfile,
        strict: true,
        yes: true,
        fix: false,
      }),
  );
  if (doctor.exitCode !== EXIT_CODES.SUCCESS)
    throw new TransactionFailure(EXIT_CODES.POST_INSTALL_VERIFY_FAILURE, doctor.diagnostics);
  await runInstallFault(runtime, 'doctor');
  const metadata = installedMetadata(plan, facts, runtime.now(), txid, material);
  await transaction.writeManagedDocument(
    join(input.dshHome, '.dshpack', 'installed', `${plan.targetProfile}.json`),
    `${JSON.stringify(metadata)}\n`,
  );
  await runInstallFault(runtime, 'metadata');
}
