import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseDocument } from 'yaml';

import { type CommandReport, diagnostic } from '../commands/shared.js';
import { EXIT_CODES } from '../exit-codes.js';
import type { InstallRuntime } from '../install/runtime-types.js';
import {
  type ProfileDiffPlan,
  ProfileDiffPlanError,
  planProfileDiff,
  preflightUpdate,
  type UpdateInput,
} from '../update/engine.js';
import { mergeAssetState, mergeSettingsState } from '../update/merge.js';

export interface DiffInput {
  readonly dshHome: string;
  readonly profile: string;
  readonly to?: string;
  readonly checkUpdates?: boolean;
  readonly effective?: boolean;
}

export interface DiffItem {
  readonly kind: 'profile' | 'skill' | 'preset' | 'setting';
  readonly id: string;
  readonly target: string;
  readonly mergeAction:
    | 'unchanged'
    | 'update'
    | 'retain'
    | 'converged'
    | 'conflict'
    | 'create'
    | 'remove';
  readonly base: 'present' | 'absent';
  readonly current: 'present' | 'absent';
  readonly targetState: 'present' | 'absent';
  readonly baseSha256?: string;
  readonly currentSha256?: string;
  readonly targetSha256?: string;
}

export interface EffectiveMismatch {
  readonly source: string;
  readonly effective: string;
  readonly sourceSha256: string;
  readonly effectiveSha256: string;
}

export interface DiffMetadata {
  readonly profile: string;
  readonly pack: { readonly name: string; readonly version: string };
  readonly localDrift: readonly DiffItem[];
  readonly upstreamDelta: readonly DiffItem[];
  readonly effectiveMismatch: readonly EffectiveMismatch[];
  readonly generation?: number;
  readonly assetDigests: readonly { readonly target: string; readonly digest: string }[];
  readonly sideEffects?: readonly { readonly owner: 'dsh'; readonly path: 'profile/cordis.yml' }[];
}

export type DiffReport = CommandReport<DiffMetadata>;
export type DiffRuntime = InstallRuntime;

function digest(value: string): string {
  return `sha256-${createHash('sha256').update(value).digest('base64url')}`;
}

function state(value: { readonly present: boolean; readonly canonicalValue?: string }): {
  readonly presence: 'present' | 'absent';
  readonly digest?: string;
} {
  if (!value.present) return { presence: 'absent' };
  return { presence: 'present', digest: digest(value.canonicalValue ?? '') };
}

function item(value: {
  readonly kind: DiffItem['kind'];
  readonly id: string;
  readonly targetPath: string;
  readonly mergeAction: DiffItem['mergeAction'];
  readonly base: { readonly present: boolean; readonly canonicalValue?: string };
  readonly current: { readonly present: boolean; readonly canonicalValue?: string };
  readonly targetState: { readonly present: boolean; readonly canonicalValue?: string };
}): DiffItem {
  const base = state(value.base);
  const current = state(value.current);
  const target = state(value.targetState);
  return {
    kind: value.kind,
    id: value.id,
    target: value.targetPath,
    mergeAction: value.mergeAction,
    base: base.presence,
    current: current.presence,
    targetState: target.presence,
    ...(base.digest === undefined ? {} : { baseSha256: base.digest }),
    ...(current.digest === undefined ? {} : { currentSha256: current.digest }),
    ...(target.digest === undefined ? {} : { targetSha256: target.digest }),
  };
}

function changedAsset(entry: ProfileDiffPlan['assets'][number]): boolean {
  return (
    mergeAssetState(entry.baseState, entry.currentState, entry.baseState).action !== 'unchanged'
  );
}

function changedTarget(entry: ProfileDiffPlan['assets'][number]): boolean {
  return (
    mergeAssetState(entry.baseState, entry.baseState, entry.targetState).action !== 'unchanged'
  );
}

function changedSetting(entry: ProfileDiffPlan['settings'][number]): boolean {
  return mergeSettingsState(entry.base, entry.current, entry.base).action !== 'unchanged';
}

function changedTargetSetting(entry: ProfileDiffPlan['settings'][number]): boolean {
  return mergeSettingsState(entry.base, entry.base, entry.target).action !== 'unchanged';
}

function reportFromPlanError(error: ProfileDiffPlanError): DiffReport {
  return {
    diagnostics: error.report.diagnostics,
    exitCode: error.report.exitCode,
    metadata: {
      profile: '',
      pack: { name: '', version: '' },
      localDrift: [],
      upstreamDelta: [],
      effectiveMismatch: [],
      assetDigests: [],
    },
  };
}

function reportFromUnknown(profile: string): DiffReport {
  return {
    diagnostics: [
      diagnostic(
        'E_DIFF',
        'error',
        '无法安全计算 profile 对比计划。',
        '检查受管理文件与并发写入后重试；未执行任何 dshpack 写入。',
      ),
    ],
    exitCode: EXIT_CODES.CONTRACT,
    metadata: {
      profile,
      pack: { name: '', version: '' },
      localDrift: [],
      upstreamDelta: [],
      effectiveMismatch: [],
      assetDigests: [],
    },
  };
}

async function effectiveMismatch(
  input: DiffInput,
  runtime: DiffRuntime,
): Promise<readonly EffectiveMismatch[]> {
  const profileRoot = join(input.dshHome, 'profiles', input.profile);
  await runtime.runDsh(['--profile', input.profile, '--dump-config'], {
    dshHome: input.dshHome,
    cwd: profileRoot,
  });
  const sourcePath = join(profileRoot, 'cordis.patch.yml');
  const effectivePath = join(profileRoot, 'cordis.yml');
  const [source, effective] = await Promise.all([
    readFile(sourcePath, 'utf8'),
    readFile(effectivePath, 'utf8'),
  ]);
  const sourceValue = parseDocument(source).toJS();
  const effectiveValue = parseDocument(effective).toJS();
  if (JSON.stringify(sourceValue) === JSON.stringify(effectiveValue)) return [];
  return [
    {
      source: 'profile/cordis.patch.yml',
      effective: 'profile/cordis.yml',
      sourceSha256: digest(source),
      effectiveSha256: digest(effective),
    },
  ];
}

export async function diffProfile(input: DiffInput, runtime: DiffRuntime): Promise<DiffReport> {
  const preflightInput: UpdateInput = {
    dshHome: input.dshHome,
    profile: input.profile,
    ...(input.to === undefined ? {} : { to: input.to }),
    interactive: false,
    json: true,
  };
  let plan: ProfileDiffPlan;
  const target = input.to !== undefined || input.checkUpdates === true;
  const diagnostics: Array<DiffReport['diagnostics'][number]> = [];
  try {
    if (target) {
      const prepared = await preflightUpdate(preflightInput, runtime);
      diagnostics.push(...prepared.report.diagnostics);
      if (prepared.preflight === undefined)
        return {
          diagnostics,
          exitCode: prepared.report.exitCode,
          metadata: {
            profile: input.profile,
            pack: { name: '', version: '' },
            localDrift: [],
            upstreamDelta: [],
            effectiveMismatch: [],
            assetDigests: [],
          },
        };
      plan = await planProfileDiff({
        dshHome: input.dshHome,
        profile: input.profile,
        runtime,
        target: prepared.preflight,
      });
    } else {
      plan = await planProfileDiff({ dshHome: input.dshHome, profile: input.profile, runtime });
    }
  } catch (error) {
    if (error instanceof ProfileDiffPlanError) return reportFromPlanError(error);
    return reportFromUnknown(input.profile);
  }

  const localDrift: DiffItem[] = [];
  const upstreamDelta: DiffItem[] = [];
  const assetDigests: { target: string; digest: string }[] = [];
  for (const entry of plan.assets) {
    const value = item({
      kind: entry.kind,
      id:
        entry.kind === 'profile'
          ? input.profile
          : entry.target.slice(entry.target.lastIndexOf('/') + 1),
      targetPath: entry.target,
      mergeAction: entry.mergeAction,
      base: entry.baseState,
      current: entry.currentState,
      targetState: entry.targetState,
    });
    if (entry.kind !== 'profile' && entry.currentState.present)
      assetDigests.push({
        target: entry.target,
        digest: digest(entry.currentState.canonicalValue ?? ''),
      });
    if (changedAsset(entry)) localDrift.push(value);
    if (target && changedTarget(entry)) upstreamDelta.push(value);
  }
  for (const entry of plan.settings) {
    const value = item({
      kind: 'setting',
      id: entry.key,
      targetPath: `settings/agent-presets.${entry.key}`,
      mergeAction: entry.action,
      base: entry.base,
      current: entry.current,
      targetState: entry.target,
    });
    if (changedSetting(entry)) localDrift.push(value);
    if (target && changedTargetSetting(entry)) upstreamDelta.push(value);
  }
  let mismatches: readonly EffectiveMismatch[] = [];
  if (input.effective === true) {
    try {
      mismatches = await effectiveMismatch(input, runtime);
    } catch {
      return {
        diagnostics: [
          ...diagnostics,
          diagnostic(
            'E_DIFF_EFFECTIVE',
            'error',
            '无法读取 dsh 生效层配置。',
            '检查 profile 的 dsh 运行环境后重试；diff 未执行其它写入。',
          ),
        ],
        exitCode: EXIT_CODES.ENVIRONMENT,
        metadata: {
          profile: input.profile,
          pack: plan.marker.metadata.pack,
          localDrift,
          upstreamDelta,
          effectiveMismatch: [],
          assetDigests,
          sideEffects: [{ owner: 'dsh', path: 'profile/cordis.yml' }],
        },
      };
    }
  }
  return {
    diagnostics: [
      ...diagnostics,
      ...(input.effective === true
        ? [
            diagnostic(
              'I_DIFF_EFFECTIVE_WRITE',
              'info',
              '已请求 dsh --dump-config；该选项会写入 profile/cordis.yml。',
              '这是 --effective 明确声明的唯一生效层写入。',
            ),
          ]
        : []),
    ],
    exitCode: EXIT_CODES.SUCCESS,
    metadata: {
      profile: input.profile,
      pack: plan.marker.metadata.pack,
      localDrift,
      upstreamDelta,
      effectiveMismatch: mismatches,
      generation: plan.marker.metadata.generation,
      assetDigests,
      ...(input.effective === true
        ? { sideEffects: [{ owner: 'dsh' as const, path: 'profile/cordis.yml' as const }] }
        : {}),
    },
  };
}
