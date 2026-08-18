import { join } from 'node:path';

import type { Diagnostic } from '@dshpack/core';

import { prepareAgentPresetsMerge } from '../adapters/settings.js';
import { diagnostic } from '../commands/shared.js';
import { EXIT_CODES } from '../exit-codes.js';
import { attributableToInstall } from '../management/attribution.js';
import {
  advanceCurrent,
  captureInstalledAssets,
  generationDocument,
  nextGeneration,
  settingsContribution,
  storeCapturedAssets,
  writeGeneration,
} from '../metadata/state-storage.js';
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

export function materialText(material: ValidatedPackMaterial, path: string): string {
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
  let contribution = settingsContribution({});
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
    contribution = settingsContribution(prepared.value.section);
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
  const ours: Diagnostic[] = [];
  const preexisting: Diagnostic[] = [];
  for (const item of doctor.diagnostics)
    (attributableToInstall(item, input.dshHome, {
      profile: plan.targetProfile,
      assets: [...plan.skills, ...plan.presets],
    })
      ? ours
      : preexisting
    ).push(item);
  if (ours.some((item) => item.severity === 'error'))
    throw new TransactionFailure(EXIT_CODES.POST_INSTALL_VERIFY_FAILURE, ours);
  // A doctor that failed without locating anything is still ours: silence is not evidence
  // that the target is clean.
  if (doctor.exitCode !== EXIT_CODES.SUCCESS && doctor.diagnostics.length === 0)
    throw new TransactionFailure(EXIT_CODES.POST_INSTALL_VERIFY_FAILURE, doctor.diagnostics);
  if (preexisting.length > 0) {
    diagnostics.push(
      diagnostic(
        'W_DOCTOR_PREEXISTING',
        'warning',
        `doctor 报告了 ${preexisting.length} 条本次安装之外的既有问题，安装未因此回滚。`,
        `逐条复核：dshpack doctor --profile ${plan.targetProfile} --strict`,
      ),
    );
    for (const item of preexisting)
      diagnostics.push(
        diagnostic(
          'I_DOCTOR_PREEXISTING',
          'info',
          `${item.code}（${item.severity}）${item.message}`,
          item.hint ?? '与本次安装无关，可单独处理。',
          item.path,
        ),
      );
  }
  await runInstallFault(runtime, 'doctor');
  const assets = await captureInstalledAssets(transaction, input.dshHome, plan);
  const allocation = await nextGeneration(transaction, input.dshHome, plan.targetProfile);
  await storeCapturedAssets(transaction, input.dshHome, assets);
  await runInstallFault(runtime, 'store');
  const installedAt = runtime.now();
  const metadata = installedMetadata(plan, facts, installedAt, txid, material, {
    assets: assets.map(({ asset }) => asset),
    settingsContribution: contribution,
    generation: allocation.sequence,
  });
  const generation = generationDocument(
    allocation.sequence,
    txid,
    installedAt,
    {
      operation: 'install',
      pack: {
        name: plan.pack.name,
        version: plan.pack.version,
        manifestDigest: plan.manifestDigest,
      },
      source: plan.source,
      metadata,
    },
    assets,
    contribution,
  );
  await writeGeneration(transaction, input.dshHome, plan.targetProfile, generation);
  await runInstallFault(runtime, 'generation');
  await advanceCurrent(
    transaction,
    allocation.currentPath,
    allocation.previous,
    allocation.sequence,
  );
  await runInstallFault(runtime, 'current');
  await transaction.writeManagedDocument(
    join(input.dshHome, '.dshpack', 'installed', `${plan.targetProfile}.json`),
    `${JSON.stringify(metadata)}\n`,
  );
  await runInstallFault(runtime, 'metadata');
}
