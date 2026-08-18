import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { Diagnostic } from '@dshpack/core';
import { satisfies } from 'semver';
import { parseDocument, stringify } from 'yaml';

import { prepareAgentPresetsMerge } from '../adapters/settings.js';
import {
  SourceError,
  type SourceProvenance,
  sourceReferenceFromProvenance,
} from '../adapters/source.js';
import { type CommandReport, diagnostic } from '../commands/shared.js';
import { EXIT_CODES, type ExitCode } from '../exit-codes.js';
import { skillsIn } from '../install/build-plan.js';
import { captureInstallTargetRequest } from '../install/engine.js';
import { materialText } from '../install/engine-apply.js';
import { runInstallFault } from '../install/engine-errors.js';
import { installProfile } from '../install/engine-profile.js';
import { installedMetadata } from '../install/metadata.js';
import { prepareInstallPlanFromValidated } from '../install/plan.js';
import type { InstalledPluginFact } from '../install/profile-plugin.js';
import type { ValidatedPackMaterial } from '../install/read.js';
import type { InstallRuntime } from '../install/runtime-types.js';
import { captureSourceDirectory, SnapshotCaptureError } from '../install/snapshot-capture.js';
import type { InstallPlan, InstallResolution } from '../install/types.js';
import { attributableToInstall } from '../management/attribution.js';
import {
  type DeferredMetadataAsset,
  type InstalledMetadataV1,
  isInstallableProfileName,
  type MetadataAsset,
  type MetadataAssetFile,
} from '../metadata/contracts.js';
import {
  advanceCurrent,
  type CapturedInstallAsset,
  encodeCanonicalSettingsValue,
  generationDocument,
  isManagedProfileInventoryPath,
  nextGeneration,
  storeCapturedAssets,
  writeGeneration,
} from '../metadata/state-storage.js';
import { type MarkerRecord, observeAsset, readMarker } from '../restore/engine.js';
import { terminalSafeText } from '../terminal-safe.js';
import { runTransaction, type TransactionContext, TransactionFailure } from '../transaction.js';
import type { AssetState, SettingsState } from './contracts.js';
import { mergeAssetState, mergeSettingsState } from './merge.js';
import {
  type AuthorizationDelta,
  authorizationDelta,
  decideUpdateAuthorization,
} from './policy.js';

export interface UpdateInput {
  readonly dshHome: string;
  readonly profile: string;
  readonly to?: string;
  readonly dryRun?: boolean;
  readonly ours?: boolean;
  readonly theirs?: boolean;
  readonly only?: readonly string[];
  readonly allowBuilds?: readonly string[];
  readonly allowUnverified?: boolean;
  readonly allowVersionMismatch?: boolean;
  readonly allowDangerFullAccess?: boolean;
  readonly yes?: boolean;
  readonly interactive: boolean;
  readonly json?: boolean;
}

/** Update uses the same hardened runtime and transaction seams as install. */
export type UpdateRuntime = InstallRuntime;

export interface UpdatePreflight {
  readonly marker: MarkerRecord & { readonly metadata: InstalledMetadataV1 };
  /** Immutable validated bytes retained for transaction apply; never re-read SOURCE. */
  readonly material: ValidatedPackMaterial;
  readonly source: SourceProvenance;
  readonly sourceReference: string;
  readonly resolution: InstallResolution;
  readonly versions: { readonly dshVersion: string; readonly pnpmVersion: string };
  readonly authorizationDelta: readonly AuthorizationDelta[];
}

export interface UpdatePreflightResult {
  readonly report: CommandReport;
  readonly preflight?: UpdatePreflight;
}

export interface UpdatePreflightSummary {
  readonly sourceKind: SourceProvenance['kind'];
  readonly pack: { readonly name: string; readonly version: string };
  readonly versions: { readonly dshVersion: string; readonly pnpmVersion: string };
  readonly authorizationDelta: readonly AuthorizationDelta[];
}

export interface UpdateReportMetadata {
  readonly profile?: string;
  readonly status:
    | 'not-started'
    | 'preflight'
    | 'updated'
    | 'committed'
    | 'rolled-back'
    | 'rollback-failed';
  readonly preflight?: UpdatePreflightSummary;
  readonly generation?: number;
  readonly backupDirectory?: string;
  readonly assets?: readonly UpdateAssetOutcome[];
  readonly settings?: readonly UpdateSettingsOutcome[];
}

export type UpdateReport = CommandReport<UpdateReportMetadata>;

function failure(exitCode: ExitCode, item: Diagnostic): UpdatePreflightResult {
  return { report: { diagnostics: [item], exitCode, metadata: {} } };
}

function updateMarkerFailure(error: unknown): UpdatePreflightResult {
  const exitCode =
    (error as { exitCode?: unknown } | undefined)?.exitCode === EXIT_CODES.SECURITY
      ? EXIT_CODES.SECURITY
      : EXIT_CODES.CONTRACT;
  return failure(
    exitCode,
    diagnostic(
      'E_UPDATE_MARKER',
      'error',
      '无法安全读取该 profile 的受跟踪 v1 安装标记。',
      '请先运行 dshpack migrate 或修复受管理的 metadata；更新尚未开始写入。',
    ),
  );
}

function sourceFailure(error: unknown, stage: 'materialize' | 'read'): UpdatePreflightResult {
  const sourceError = error instanceof SourceError ? error : undefined;
  return failure(
    sourceError?.exitCode ?? EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
    diagnostic(
      sourceError?.code ?? (stage === 'read' ? 'E_SOURCE_READ' : 'E_SOURCE'),
      'error',
      'SOURCE 获取或校验失败。',
      sourceError?.hint ?? '检查精确 source 后重试；未执行任何目标写入。',
    ),
  );
}

function sourceCleanupDiagnostic(): Diagnostic {
  return diagnostic(
    'E_SOURCE_CLEANUP',
    'error',
    'SOURCE 私有暂存清理失败。',
    '检查并清理私有暂存目录后重试；未执行任何目标写入。',
  );
}

function withSourceCleanupFailure(
  primary: UpdatePreflightResult,
  cleanup: Diagnostic,
): UpdatePreflightResult {
  return {
    report: {
      ...primary.report,
      diagnostics: [...primary.report.diagnostics, cleanup],
    },
  };
}

function summary(preflight: UpdatePreflight): UpdatePreflightSummary {
  return {
    sourceKind: preflight.source.kind,
    pack: { name: preflight.material.manifest.name, version: preflight.material.manifest.version },
    versions: preflight.versions,
    authorizationDelta: preflight.authorizationDelta,
  };
}

function sourceReview(preflight: UpdatePreflight): string {
  switch (preflight.source.kind) {
    case 'github':
      return `github:${terminalSafeText(preflight.source.owner)}/${terminalSafeText(preflight.source.repo)}@${terminalSafeText(preflight.source.commit)}`;
    case 'https':
      return 'validated https archive';
    case 'archive':
      return 'validated local archive';
    case 'directory':
      return 'validated local directory';
  }
}

function authorizationReviewDiagnostic(
  delta: AuthorizationDelta,
  preflight: UpdatePreflight,
): Diagnostic {
  switch (delta.kind) {
    case 'new-plugin': {
      const plugin = preflight.resolution.plugins.find(
        (candidate) => candidate.name === delta.plugin,
      );
      return diagnostic(
        'I_UPDATE_AUTHORIZATION',
        'info',
        `authorization review: ${terminalSafeText(delta.change)} plugin ${terminalSafeText(delta.plugin)} (${plugin?.integrity.kind ?? 'unknown'} integrity)`,
        'Explicit approval remains required before apply.',
      );
    }
    case 'allow-build':
      return diagnostic(
        'I_UPDATE_AUTHORIZATION',
        'info',
        `authorization review: build scripts for ${terminalSafeText(delta.plugin)}`,
        'Explicit approval remains required before apply.',
      );
    case 'danger-full-access':
      return diagnostic(
        'I_UPDATE_AUTHORIZATION',
        'info',
        'authorization review: danger-full-access permission preset',
        'Explicit approval remains required before apply.',
      );
    case 'version-mismatch':
      return diagnostic(
        'I_UPDATE_AUTHORIZATION',
        'info',
        `authorization review: dsh ${terminalSafeText(delta.current)} is outside tested versions ${terminalSafeText(delta.tested.join(','))}`,
        'Explicit approval remains required before apply.',
      );
  }
}

/** Read-only review facts shown for dry-run and every authorization decision without echoing paths or raw identities. */
function reviewDiagnostics(preflight: UpdatePreflight): readonly Diagnostic[] {
  const integrity = preflight.resolution.plugins
    .map((plugin) => `${terminalSafeText(plugin.name)}:${plugin.integrity.kind}`)
    .join(', ');
  return [
    diagnostic(
      'I_UPDATE_SOURCE',
      'info',
      `resolved ${sourceReview(preflight)}; pack ${terminalSafeText(preflight.material.manifest.name)}@${terminalSafeText(preflight.material.manifest.version)}`,
      'Validated source bytes are ready for review; no target write has occurred.',
    ),
    diagnostic(
      'I_UPDATE_INTEGRITY',
      'info',
      `resolved plugin integrity summary: ${integrity.length === 0 ? 'no plugins' : integrity}`,
      'Only validated integrity classifications are shown; raw source credentials are never reported.',
    ),
    ...preflight.authorizationDelta.map((delta) => authorizationReviewDiagnostic(delta, preflight)),
  ];
}

/**
 * The confirmation applies to the exact delta observed during preflight.  A concurrent marker
 * replacement can change what the same validated target would authorize, so compare the locked
 * delta structurally and only permit newly introduced items when their corresponding explicit
 * flag already covers them.  There is deliberately no second interactive prompt under the lock.
 */
function authorizationAfterMarkerChange(
  input: UpdateInput,
  preflight: UpdatePreflight,
  marker: InstalledMetadataV1,
): readonly AuthorizationDelta[] {
  const previouslyReviewed = new Set(preflight.authorizationDelta.map(stable));
  const locked = authorizationDelta({
    marker,
    material: preflight.material,
    resolution: preflight.resolution.plugins,
    dshVersion: preflight.versions.dshVersion,
  }).filter((item) => !previouslyReviewed.has(stable(item)));
  // Routine consent was already collected before taking the transaction lock.  Re-evaluate only
  // the new dangerous items, and force non-interactive handling so an apply never prompts while
  // holding the lease.
  return decideUpdateAuthorization({ ...input, yes: true, interactive: false }, locked).missing;
}

function confirmationPrompt(delta: AuthorizationDelta): Parameters<UpdateRuntime['confirm']>[0] {
  switch (delta.kind) {
    case 'new-plugin':
      return {
        kind: 'new-plugin',
        subject:
          delta.change === 'identity-change'
            ? `插件精确解析结果变更：${terminalSafeText(delta.plugin)}`
            : `新增插件：${terminalSafeText(delta.plugin)}（精确解析结果）`,
        defaultValue: false,
      };
    case 'allow-build':
      return { kind: 'allow-build', subject: delta.authorization, defaultValue: false };
    case 'danger-full-access':
      return { kind: 'danger-full-access', subject: 'danger-full-access', defaultValue: false };
    case 'version-mismatch':
      return {
        kind: 'version-mismatch',
        subject: `${delta.current} ∉ dsh.tested`,
        defaultValue: false,
      };
  }
}

function authorizationReview(delta: AuthorizationDelta): string {
  switch (delta.kind) {
    case 'new-plugin':
      return delta.change === 'identity-change'
        ? `插件精确解析结果变更：${terminalSafeText(delta.plugin)}（需逐项确认）`
        : `新增插件：${terminalSafeText(delta.plugin)}（精确解析结果，需逐项确认）`;
    case 'allow-build':
      return `危险 allowBuilds：${terminalSafeText(delta.authorization)}`;
    case 'danger-full-access':
      return '危险权限：danger-full-access';
    case 'version-mismatch':
      return `dsh tested 不匹配：当前 ${terminalSafeText(delta.current)}，目标 tested=${terminalSafeText(delta.tested.join(','))}`;
  }
}

function normalUpdatePrompt(preflight: UpdatePreflight): Parameters<UpdateRuntime['confirm']>[0] {
  return {
    kind: 'update',
    subject: `更新 profile ${terminalSafeText(preflight.marker.metadata.profile)}`,
    defaultValue: false,
  };
}

async function confirmPrompts(
  runtime: UpdateRuntime,
  prompts: readonly Parameters<UpdateRuntime['confirm']>[0][],
): Promise<boolean> {
  for (const prompt of prompts) {
    try {
      if (!(await runtime.confirm(prompt))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * SOURCE, DSH_HOME and selectors are caller-provided strings and can carry credentials in paths
 * or query fragments. A diagnostic is a log boundary, not a shell-history substitute, so never
 * echo them as a purported replay command.
 */
function updateConfirmationReplay(): string {
  return 'Re-run the same validated update command after review, adding --yes to confirm it.';
}

function confirmationRequired(
  input: UpdateInput,
  preflight: UpdatePreflight,
  diagnostics: readonly Diagnostic[],
  missing: readonly AuthorizationDelta[],
): UpdateReport {
  const normal = diagnostic(
    'E_CONFIRMATION_REQUIRED',
    'error',
    '普通 update 需要明确确认。',
    `审阅预检后执行：${updateConfirmationReplay()}`,
  );
  return authorizationDeclined(input, preflight, [...diagnostics, normal], missing);
}

function authorizationDeclined(
  input: UpdateInput,
  preflight: UpdatePreflight,
  diagnostics: readonly Diagnostic[],
  missing: readonly AuthorizationDelta[] = preflight.authorizationDelta,
): UpdateReport {
  return {
    diagnostics: [
      ...diagnostics,
      ...(missing.length === 0
        ? []
        : [
            diagnostic(
              'E_UPDATE_AUTHORIZATION_REQUIRED',
              'error',
              '目标更新包含新的危险授权，--yes 不会替代逐项授权。',
              '审阅授权差量；在交互式终端逐项确认，或提供对应的显式 --allow-* 授权。',
            ),
          ]),
      diagnostic(
        'E_USER_DECLINED',
        'error',
        '更新尚未获得所需的安全授权。',
        '未执行任何目标写入。',
      ),
    ],
    exitCode: EXIT_CODES.USER_DECLINED,
    metadata: {
      profile: input.profile,
      status: 'not-started',
      preflight: summary(preflight),
    },
  };
}

/**
 * Read-only update phase. It preserves marker document and identity for Task 3's locked
 * transaction, but keeps the full validated pack out of command JSON to avoid content echoing.
 */
export async function preflightUpdate(
  input: UpdateInput,
  runtime: UpdateRuntime,
): Promise<UpdatePreflightResult> {
  if (!isInstallableProfileName(input.profile))
    return failure(
      EXIT_CODES.CONTRACT,
      diagnostic(
        'E_UPDATE_PROFILE',
        'error',
        'update profile 名称不符合受管理 profile 的安全命名规则。',
        '使用已安装且仅含小写字母、数字和连字符的 profile 名称后重试。',
      ),
    );
  if (input.ours === true && input.theirs === true)
    return failure(
      EXIT_CODES.CONTRACT,
      diagnostic(
        'E_UPDATE_STRATEGY',
        'error',
        '--ours 与 --theirs 不能同时使用。',
        '选择一个冲突策略后重试。',
      ),
    );
  let markerRead: Awaited<ReturnType<typeof readMarker>>;
  try {
    markerRead = await readMarker(input.dshHome, input.profile);
  } catch (error) {
    return updateMarkerFailure(error);
  }
  if (markerRead.marker === undefined)
    return failure(
      EXIT_CODES.CONTRACT,
      diagnostic(
        'E_UPDATE_MARKER_UNTRACKED',
        'error',
        '该 profile 没有可用于更新的受跟踪 v1 安装标记。',
        '先使用 dshpack install 安装，或运行 dshpack migrate 后重试。',
      ),
    );
  const marker = markerRead.marker as MarkerRecord & { readonly metadata: InstalledMetadataV1 };
  const sourceReference =
    input.to ?? sourceReferenceFromProvenance(marker.metadata.source as SourceProvenance);
  let source: Awaited<ReturnType<UpdateRuntime['materializeSource']>>;
  try {
    source = await runtime.materializeSource(sourceReference);
  } catch (error) {
    return sourceFailure(error, 'materialize');
  }
  let read: Awaited<ReturnType<UpdateRuntime['readValidatedPack']>> | undefined;
  let readFailure: UpdatePreflightResult | undefined;
  try {
    read = await runtime.readValidatedPack(source.directory, { frozen: true });
  } catch (error) {
    readFailure = sourceFailure(error, 'read');
  }
  let cleanupFailure: Diagnostic | undefined;
  try {
    await source.cleanup();
  } catch {
    cleanupFailure = sourceCleanupDiagnostic();
  }
  if (readFailure !== undefined)
    return cleanupFailure === undefined
      ? readFailure
      : withSourceCleanupFailure(readFailure, cleanupFailure);
  if (read?.material === undefined) {
    const primary: UpdatePreflightResult = {
      report: {
        diagnostics: read?.diagnostics ?? [],
        exitCode: read?.exitCode ?? EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
        metadata: {},
      },
    };
    return cleanupFailure === undefined
      ? primary
      : withSourceCleanupFailure(primary, cleanupFailure);
  }
  if (cleanupFailure !== undefined)
    return failure(EXIT_CODES.SOURCE_NETWORK_INTEGRITY, cleanupFailure);
  let versions: Awaited<ReturnType<UpdateRuntime['probe']>>;
  try {
    versions = await runtime.probe();
  } catch {
    return failure(
      EXIT_CODES.ENVIRONMENT,
      diagnostic(
        'E_PROBE',
        'error',
        'dsh 或 pnpm 不可用。',
        '从 PATH 提供受支持的 dsh 与 pnpm 后重试；未执行任何目标写入。',
      ),
    );
  }
  if (!satisfies(versions.pnpmVersion, '>=10.0.0'))
    return failure(
      EXIT_CODES.ENVIRONMENT,
      diagnostic(
        'E_PNPM_VERSION_UNSUPPORTED',
        'error',
        `pnpm ${versions.pnpmVersion} 低于 update 要求的 10.0.0。`,
        '从 PATH 提供 pnpm >=10 后重试；未执行任何目标写入。',
      ),
    );
  let resolution: InstallResolution;
  try {
    resolution = await runtime.resolvePlugins(read.material, {
      dshHome: input.dshHome,
      frozen: true,
    });
  } catch (error) {
    const sourceError = error instanceof SourceError ? error : undefined;
    return failure(
      sourceError?.exitCode ?? EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
      diagnostic(
        sourceError?.code ?? 'E_PLUGIN_RESOLUTION',
        'error',
        '无法将目标 pack 解析为精确且可校验的插件来源。',
        sourceError?.hint ?? '检查 pnpm、网络来源和完整性诊断；未执行任何目标写入。',
      ),
    );
  }
  const unverified = resolution.plugins.filter((plugin) => plugin.integrity.kind === 'unverified');
  if (unverified.length > 0 && input.allowUnverified !== true)
    return failure(
      EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
      diagnostic(
        'E_UNVERIFIED_REQUIRED',
        'error',
        '目标插件缺少可验证 integrity。',
        '仅在独立审计后显式提供 --allow-unverified；--yes 或交互确认不授权此风险。',
      ),
    );
  const onlyFailure = validateOnlySelectors(input, marker.metadata, read.material);
  if (onlyFailure !== undefined) return failure(EXIT_CODES.CONTRACT, onlyFailure);
  const preflight: UpdatePreflight = {
    marker,
    material: read.material,
    source: source.provenance,
    sourceReference,
    resolution,
    versions,
    authorizationDelta: authorizationDelta({
      marker: marker.metadata,
      material: read.material,
      resolution: resolution.plugins,
      dshVersion: versions.dshVersion,
    }),
  };
  return {
    report: { diagnostics: read.diagnostics, exitCode: EXIT_CODES.SUCCESS, metadata: {} },
    preflight,
  };
}

type UpdateAssetKind = 'profile' | 'skill' | 'preset';

export interface UpdateAssetOutcome {
  readonly target: string;
  readonly kind: UpdateAssetKind;
  readonly action:
    | 'unchanged'
    | 'update'
    | 'create'
    | 'remove'
    | 'retain'
    | 'converged'
    | 'conflict';
  readonly selected: boolean;
}

export interface UpdateSettingsOutcome {
  readonly key: string;
  readonly action:
    | 'unchanged'
    | 'update'
    | 'create'
    | 'remove'
    | 'retain'
    | 'converged'
    | 'conflict';
  readonly selected: boolean;
}

interface TargetAsset {
  readonly id: string;
  readonly kind: Exclude<UpdateAssetKind, 'profile'>;
  readonly source: string;
  readonly target: string;
  readonly files: readonly MetadataAssetFile[];
}

interface AssetMerge extends UpdateAssetOutcome {
  readonly baseAsset?: MetadataAsset | undefined;
  readonly targetAsset?: TargetAsset | undefined;
  readonly observed?:
    | { readonly identity: string; readonly files: readonly MetadataAssetFile[] }
    | undefined;
  readonly mergeAction: UpdateAssetOutcome['action'];
  readonly baseState: AssetState;
  readonly currentState: AssetState;
  readonly targetState: AssetState;
}

/**
 * Persisted assets and deferred entries have deliberately different ownership meanings. A
 * deferred target without a baseline is a newly introduced asset skipped by `--only`; it is not
 * an incomplete MetadataAsset and therefore never supplies a synthetic three-way base.
 */
type MergeBaseRecord =
  | { readonly origin: 'captured'; readonly asset: MetadataAsset }
  | {
      readonly origin: 'deferred';
      readonly asset: DeferredMetadataAsset;
      readonly baseline: MetadataAsset | undefined;
    };

interface SettingsMerge extends UpdateSettingsOutcome {
  readonly base: SettingsState;
  readonly current: SettingsState;
  readonly target: SettingsState;
}

export interface ProfileDiffPlan {
  readonly marker: MarkerRecord & { readonly metadata: InstalledMetadataV1 };
  readonly assets: readonly AssetMerge[];
  readonly settings: readonly SettingsMerge[];
  readonly currentSettings: Readonly<Record<string, unknown>>;
  readonly desiredSettings: Readonly<Record<string, unknown>>;
  readonly settingsDocument: string | undefined;
  readonly settingsContribution: InstalledMetadataV1['settingsContribution'];
  readonly deferredAssets: readonly DeferredMetadataAsset[];
  readonly conflicts: readonly Diagnostic[];
  readonly profileChanged: boolean;
}

export interface ProfileDiffPlanInput {
  readonly dshHome: string;
  readonly profile: string;
  readonly runtime: UpdateRuntime;
  /** A validated target is optional: local drift never opens a SOURCE. */
  readonly target?: UpdatePreflight;
}

export class ProfileDiffPlanError extends Error {
  constructor(readonly report: CommandReport) {
    super('unable to build a read-only profile diff plan');
    this.name = 'ProfileDiffPlanError';
  }
}

interface MergePlanInput {
  readonly dshHome: string;
  readonly profile: string;
  readonly only?: readonly string[];
  readonly ours?: boolean;
  readonly theirs?: boolean;
}

function updateFailure(
  code: string,
  message: string,
  hint: string,
  exitCode: ExitCode = EXIT_CODES.CONTRACT,
): TransactionFailure {
  return new TransactionFailure(exitCode, [diagnostic(code, 'error', message, hint)]);
}

function sha256(bytes: Uint8Array | string): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
}

function state(files: readonly MetadataAssetFile[] | undefined): AssetState {
  if (files === undefined) return { present: false };
  return {
    present: true,
    canonicalValue: JSON.stringify(
      [...files]
        .map(({ path, sha256: digest, bytes }) => ({ path, sha256: digest, bytes }))
        .sort((left, right) => left.path.localeCompare(right.path, 'en')),
    ),
  };
}

function settingState(section: Readonly<Record<string, unknown>>, key: string): SettingsState {
  if (!Object.hasOwn(section, key)) return { present: false };
  return { present: true, canonicalValue: encodeCanonicalSettingsValue(section[key]) };
}

function contributionState(
  contribution: InstalledMetadataV1['settingsContribution'],
  key: string,
): SettingsState {
  const entry = contribution.keys.find((candidate) => candidate.key === key);
  return entry === undefined
    ? { present: false }
    : { present: true, canonicalValue: entry.canonicalValue };
}

function targetFiles(
  material: ValidatedPackMaterial,
  source: string,
  kind: TargetAsset['kind'],
): readonly MetadataAssetFile[] {
  const flatSkill = source.endsWith('.md');
  const files = material.files
    .filter(({ path }) => (flatSkill ? path === source : path.startsWith(`${source}/`)))
    .map(({ path, contentBase64 }) => {
      const bytes = Buffer.from(contentBase64, 'base64');
      return {
        path: flatSkill && kind === 'skill' ? 'SKILL.md' : path.slice(source.length + 1),
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
  if (files.length === 0)
    throw updateFailure(
      'E_UPDATE_PAYLOAD',
      `validated update payload is missing ${source}`,
      'Revalidate the target pack before retrying.',
    );
  return files;
}

function targetAssets(material: ValidatedPackMaterial): readonly TargetAsset[] {
  const skills = skillsIn(material.paths).map(({ id, source }) => ({
    id,
    kind: 'skill' as const,
    source,
    target: `skills/${id}`,
    files: targetFiles(material, source, 'skill'),
  }));
  const presets = [
    ...new Set(
      material.paths
        .filter((path) => path.startsWith('presets/'))
        .map((path) => path.slice('presets/'.length).split('/')[0])
        .filter((id): id is string => id !== undefined && id.length > 0),
    ),
  ].map((id) => {
    const source = `presets/${id}`;
    return {
      id,
      kind: 'preset' as const,
      source,
      target: `.agent-presets/${id}`,
      files: targetFiles(material, source, 'preset'),
    };
  });
  return [...skills, ...presets].sort((left, right) =>
    left.target.localeCompare(right.target, 'en'),
  );
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(',')}}`;
}

/** The profile writer consumes this payload in addition to manifest-derived MCP and plugins. */
const profileMaterialPaths = new Set(['patch/cordis.patch.yml']);

function profileMaterialInputs(
  files: readonly { readonly path: string; readonly sha512: string }[],
): readonly { readonly path: string; readonly sha512: string }[] {
  return files
    .filter((file) => profileMaterialPaths.has(file.path))
    .map((file) => ({ path: file.path, sha512: file.sha512 }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

/** A profile has no target directory to compare, so use all immutable materialization facts. */
function profileTargetSignature(preflight: UpdatePreflight): string {
  return sha256(
    stable({
      manifest: preflight.material.manifestDigest,
      material: profileMaterialInputs(preflight.material.sourceFiles),
      resolution: preflight.resolution.plugins.map(({ name, resolved, integrity }) => ({
        name,
        resolved,
        integrity,
      })),
    }),
  );
}

function profileBaseSignature(marker: InstalledMetadataV1): string {
  return sha256(
    stable({
      // effectiveLock is the exact persisted source record, including the profile patch bytes.
      manifest: marker.effectiveLock.manifestSha256,
      material: profileMaterialInputs(marker.effectiveLock.files),
      resolution: marker.effectiveLock.plugins.map(({ name, resolved, integrity }) => ({
        name,
        resolved,
        integrity,
      })),
    }),
  );
}

function profileTargetChanged(
  marker: InstalledMetadataV1,
  preflight: UpdatePreflight,
  deferred: DeferredMetadataAsset | undefined,
): boolean {
  return (
    profileTargetSignature(preflight) !==
    (deferred?.profileSignature ?? profileBaseSignature(marker))
  );
}

function onlyIncludes(
  input: Pick<MergePlanInput, 'only'>,
  kind: UpdateAssetKind,
  id: string,
): boolean {
  if ((input.only?.length ?? 0) === 0) return true;
  const selectors = new Set(input.only);
  return (
    selectors.has(`${kind}:${id}`) ||
    (kind === 'profile' && (selectors.has('profile') || selectors.has(`profile:${id}`)))
  );
}

function onlyIncludesSetting(input: Pick<MergePlanInput, 'only'>, key: string): boolean {
  if ((input.only?.length ?? 0) === 0) return true;
  const selectors = new Set(input.only);
  return selectors.has(`setting:${key}`) || selectors.has(`settings:${key}`);
}

function validateOnlySelectors(
  input: UpdateInput,
  marker: InstalledMetadataV1,
  material: ValidatedPackMaterial,
): Diagnostic | undefined {
  if (input.only === undefined) return undefined;
  if (input.only.length === 0)
    return diagnostic(
      'E_UPDATE_ONLY',
      'error',
      '--only must name at least one managed asset or setting.',
      'Use skill:<id>, preset:<id>, profile, or setting:<key>.',
    );
  const assetKeys = new Set([
    ...marker.assets.map((asset) => `${asset.kind}:${asset.id}`),
    ...(marker.deferredAssets ?? []).map((asset) => `${asset.kind}:${asset.id}`),
    ...targetAssets(material).map((asset) => `${asset.kind}:${asset.id}`),
    `profile:${marker.profile}`,
    'profile',
  ]);
  const settingKeys = new Set([
    ...marker.settingsContribution.keys.map(({ key }) => key),
    ...Object.keys(targetSettings(material)),
  ]);
  for (const selector of input.only) {
    if (assetKeys.has(selector)) continue;
    const matched = /^(?:setting|settings):(.+)$/u.exec(selector);
    if (matched !== null && settingKeys.has(matched[1] as string)) continue;
    return diagnostic(
      'E_UPDATE_ONLY',
      'error',
      'an --only selector does not name a managed asset or target setting.',
      'Correct the selector before retrying; update has not written any target.',
    );
  }
  return undefined;
}

function targetAction(
  action: UpdateAssetOutcome['action'],
  target: { readonly present: boolean },
  current: { readonly present: boolean },
  input: Pick<MergePlanInput, 'ours' | 'theirs'>,
): UpdateAssetOutcome['action'] {
  if (action === 'conflict') {
    if (input.ours === true) return 'retain';
    if (input.theirs === true)
      return target.present ? (current.present ? 'update' : 'create') : 'remove';
    return 'conflict';
  }
  // A user deletion is represented as retain by the pure merge.  `--theirs` explicitly turns
  // that preservation rule into a target materialization/removal, while the default never does.
  if (action === 'retain' && input.theirs === true)
    return target.present ? (current.present ? 'update' : 'create') : 'remove';
  return action;
}

function diagnosticState(value: {
  readonly present: boolean;
  readonly canonicalValue?: string;
}): string {
  return value.present ? sha256(value.canonicalValue ?? '') : 'absent';
}

function conflictDiagnostic(
  subject: string,
  base: { readonly present: boolean; readonly canonicalValue?: string },
  current: { readonly present: boolean; readonly canonicalValue?: string },
  target: { readonly present: boolean; readonly canonicalValue?: string },
): Diagnostic {
  return diagnostic(
    'E_UPDATE_CONFLICT',
    'error',
    `three-way conflict for ${terminalSafeText(subject)}: base=${diagnosticState(base)} current=${diagnosticState(current)} target=${diagnosticState(target)}`,
    'Resolve each listed target manually, or rerun with exactly one of --ours / --theirs.',
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function targetSettings(material: ValidatedPackMaterial): Readonly<Record<string, unknown>> {
  if (material.manifest.settings === undefined) return {};
  const parsed = parseDocument(materialText(material, 'settings/agent-presets.yml'), {
    prettyErrors: true,
  });
  if (parsed.errors.length > 0 || !record(parsed.toJS()))
    throw updateFailure(
      'E_UPDATE_SETTINGS_TARGET',
      'validated target settings cannot be read as an agent-presets map.',
      'Revalidate the target pack before retrying.',
    );
  return parsed.toJS() as Record<string, unknown>;
}

async function currentSettings(
  runtime: UpdateRuntime,
  dshHome: string,
): Promise<{
  readonly document: string | undefined;
  readonly section: Readonly<Record<string, unknown>>;
}> {
  const path = join(dshHome, 'settings.yaml');
  // This single byte snapshot is both the merge input and the CAS expectation.  Do not combine
  // a settings adapter read with a later raw read: that can merge one version and overwrite a
  // concurrent edit observed by the other.
  const document = await runtime.readTextIfExists(path);
  const parsed = parseDocument(document ?? '', { prettyErrors: true });
  if (parsed.errors.length > 0)
    throw updateFailure(
      'E_SETTINGS_INVALID_YAML',
      'settings.yaml is not valid YAML and cannot be merged safely.',
      'Repair settings.yaml before retrying.',
    );
  const root = parsed.toJS() ?? {};
  if (!record(root))
    throw updateFailure(
      'E_SETTINGS_ROOT',
      'settings.yaml must have a mapping at its root before update can merge it.',
      'Repair settings.yaml before retrying.',
    );
  const namespace = root['agent-presets'];
  if (namespace !== undefined && !record(namespace))
    throw updateFailure(
      'E_UPDATE_SETTINGS_NAMESPACE',
      'settings.yaml agent-presets must be a mapping before update can merge it.',
      'Repair that namespace without changing other settings, then retry.',
    );
  return { document, section: namespace ?? {} };
}

function observationAsset(
  asset: MetadataAsset | undefined,
  target: TargetAsset | undefined,
): MetadataAsset | undefined {
  if (asset !== undefined) return asset;
  if (target === undefined) return undefined;
  return {
    id: target.id,
    kind: target.kind,
    target: target.target,
    action: 'create',
    identity: '0:0:0',
    files: target.files,
  };
}

function deferredAssets(
  marker: InstalledMetadataV1,
  assets: readonly AssetMerge[],
  profileChanged: boolean,
): readonly DeferredMetadataAsset[] {
  const deferred: DeferredMetadataAsset[] = [];
  for (const asset of assets) {
    const targetDeferred =
      asset.kind === 'profile' ? profileChanged : asset.mergeAction !== 'converged';
    const mustDefer = asset.action === 'retain' || (!asset.selected && targetDeferred);
    if (!mustDefer) continue;
    const reason: DeferredMetadataAsset['reason'] =
      asset.action === 'retain' ? (asset.observed === undefined ? 'missing' : 'modified') : 'only';
    if (asset.baseAsset === undefined && reason !== 'only')
      throw updateFailure(
        'E_UPDATE_DEFERRED_BASE',
        `cannot preserve ${asset.target} without a managed three-way base.`,
        'Resolve the asset explicitly or rerun update without the conflicting selector.',
      );
    deferred.push({
      id:
        asset.kind === 'profile'
          ? marker.profile
          : (asset.targetAsset?.id ?? asset.baseAsset?.id ?? ''),
      kind: asset.kind,
      target: asset.target,
      reason,
      ...(asset.baseAsset === undefined ? {} : { baseline: asset.baseAsset }),
      ...(asset.kind === 'profile'
        ? {
            profileSignature:
              marker.deferredAssets?.find((entry) => entry.kind === 'profile')?.profileSignature ??
              profileBaseSignature(marker),
          }
        : {}),
    });
  }
  return deferred.sort((left, right) =>
    `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`, 'en'),
  );
}

async function prepareMerge(
  input: MergePlanInput,
  runtime: UpdateRuntime,
  marker: MarkerRecord & { readonly metadata: InstalledMetadataV1 },
  preflight?: UpdatePreflight,
): Promise<ProfileDiffPlan> {
  const targets = preflight === undefined ? [] : targetAssets(preflight.material);
  const bases = marker.metadata.assets.filter(
    (asset): asset is MetadataAsset & { kind: UpdateAssetKind } =>
      asset.kind === 'profile' || asset.kind === 'skill' || asset.kind === 'preset',
  );
  const targetByKey = new Map(targets.map((asset) => [`${asset.kind}:${asset.id}`, asset]));
  const capturedByKey = new Map(bases.map((asset) => [`${asset.kind}:${asset.id}`, asset]));
  const deferredByKey = new Map(
    (marker.metadata.deferredAssets ?? []).map((asset) => [`${asset.kind}:${asset.id}`, asset]),
  );
  const mergeBases = new Map<string, MergeBaseRecord>(
    [...capturedByKey].map(([key, asset]) => [key, { origin: 'captured', asset }] as const),
  );
  for (const [key, asset] of deferredByKey)
    mergeBases.set(key, {
      origin: 'deferred',
      asset,
      baseline: asset.baseline,
    });
  const baseByKey = new Map(
    [...mergeBases].flatMap(([key, base]) => {
      if (base.origin === 'captured') return [[key, base.asset] as const];
      return base.baseline === undefined ? [] : [[key, base.baseline] as const];
    }),
  );
  const profileDeferred = deferredByKey.get(`profile:${input.profile}`);
  const profile = baseByKey.get(`profile:${input.profile}`);
  const profileChanged =
    preflight === undefined
      ? false
      : profileTargetChanged(marker.metadata, preflight, profileDeferred);
  const keys = new Set([...mergeBases.keys(), ...targetByKey.keys(), `profile:${input.profile}`]);
  const assets: AssetMerge[] = [];
  const conflicts: Diagnostic[] = [];
  for (const key of [...keys].sort((left, right) => left.localeCompare(right, 'en'))) {
    const baseAsset = baseByKey.get(key);
    const targetAsset = targetByKey.get(key);
    const [kind, id] = key.split(':') as [UpdateAssetKind, string];
    const selected = onlyIncludes(input, kind, id);
    const observedAsset = kind === 'profile' ? profile : observationAsset(baseAsset, targetAsset);
    let observed: AssetMerge['observed'];
    try {
      observed =
        observedAsset === undefined ? undefined : await observeAsset(input.dshHome, observedAsset);
    } catch (error) {
      const exitCode =
        (error as { exitCode?: unknown } | undefined)?.exitCode === EXIT_CODES.SECURITY
          ? EXIT_CODES.SECURITY
          : EXIT_CODES.CONTRACT;
      throw updateFailure(
        'E_UPDATE_ASSET_STATE',
        `cannot safely observe ${key} before update.`,
        'Inspect the managed directory for links, special files, or concurrent writers.',
        exitCode,
      );
    }
    const base = state(baseAsset?.files);
    const current = state(observed?.files);
    const target: AssetState =
      kind === 'profile'
        ? profileChanged && preflight !== undefined
          ? {
              present: true,
              canonicalValue: `profile:${sha256(stable(preflight.resolution))}`,
            }
          : base
        : state(targetAsset?.files);
    const merged = mergeAssetState(base, current, target);
    const rawAction: UpdateAssetOutcome['action'] =
      baseAsset?.action === 'skip' ? 'retain' : merged.action;
    const action = selected ? targetAction(rawAction, target, current, input) : 'unchanged';
    if (action === 'conflict') conflicts.push(conflictDiagnostic(key, base, current, target));
    assets.push({
      target:
        kind === 'profile'
          ? `profiles/${input.profile}`
          : (baseAsset?.target ?? targetAsset?.target ?? key),
      kind,
      action,
      selected,
      baseAsset,
      targetAsset,
      observed,
      mergeAction: rawAction,
      baseState: base,
      currentState: current,
      targetState: target,
    });
  }
  const before = await currentSettings(runtime, input.dshHome);
  const targetSection = preflight === undefined ? {} : targetSettings(preflight.material);
  const settingKeys = new Set([
    ...marker.metadata.settingsContribution.keys.map(({ key }) => key),
    ...Object.keys(targetSection),
  ]);
  // `agent-presets` accepts arbitrary YAML leaf keys, including `__proto__`. Do not assign those
  // values into an Object-prototype dictionary: `desired[key] = …` must always create an own key.
  const desired: Record<string, unknown> = Object.assign(Object.create(null), before.section);
  const settingMerges: SettingsMerge[] = [];
  for (const key of [...settingKeys].sort((left, right) => left.localeCompare(right, 'en'))) {
    const base = contributionState(marker.metadata.settingsContribution, key);
    const current = settingState(before.section, key);
    const target = settingState(targetSection, key);
    const merged = mergeSettingsState(base, current, target);
    const selected = onlyIncludesSetting(input, key);
    const action = selected ? targetAction(merged.action, target, current, input) : 'unchanged';
    if (action === 'conflict')
      conflicts.push(conflictDiagnostic(`setting:${key}`, base, current, target));
    if (selected && (action === 'update' || action === 'create')) desired[key] = targetSection[key];
    if (selected && action === 'remove') delete desired[key];
    settingMerges.push({ key, action, selected, base, current, target });
  }
  const contributionKeys = settingMerges
    .flatMap((entry) => {
      if (!entry.selected) {
        const base = marker.metadata.settingsContribution.keys.find(({ key }) => key === entry.key);
        return base === undefined ? [] : [base];
      }
      if (!entry.target.present) return [];
      const canonicalValue = entry.target.canonicalValue;
      return [
        {
          key: entry.key,
          canonicalValue,
          valueSha256: sha256(canonicalValue),
        },
      ];
    })
    .sort((left, right) => left.key.localeCompare(right.key, 'en'));
  const deferred = deferredAssets(marker.metadata, assets, profileChanged);
  return {
    marker,
    assets,
    settings: settingMerges,
    currentSettings: before.section,
    desiredSettings: desired,
    settingsDocument: before.document,
    settingsContribution: { namespace: 'agent-presets', keys: contributionKeys },
    deferredAssets: deferred,
    conflicts,
    profileChanged,
  };
}

/**
 * Read-only projection shared by `update` and the `diff` command.
 * `deferredAssets` stays inside update/ so a caller can inspect a baseline without claiming it.
 */
export async function planProfileDiff(input: ProfileDiffPlanInput): Promise<ProfileDiffPlan> {
  let marker: MarkerRecord & { readonly metadata: InstalledMetadataV1 };
  if (input.target !== undefined) {
    marker = input.target.marker;
  } else {
    let markerRead: Awaited<ReturnType<typeof readMarker>>;
    try {
      markerRead = await readMarker(input.dshHome, input.profile);
    } catch (error) {
      throw new ProfileDiffPlanError(updateMarkerFailure(error).report);
    }
    if (markerRead.marker === undefined)
      throw new ProfileDiffPlanError(
        failure(
          EXIT_CODES.CONTRACT,
          diagnostic(
            'E_DIFF_MARKER_UNTRACKED',
            'error',
            '该 profile 没有可用于对比的受跟踪 v1 安装标记。',
            '先使用 dshpack install 安装，或运行 dshpack migrate 后重试。',
          ),
        ).report,
      );
    marker = markerRead.marker as MarkerRecord & { readonly metadata: InstalledMetadataV1 };
  }
  return prepareMerge(
    { dshHome: input.dshHome, profile: input.profile },
    input.runtime,
    marker,
    input.target,
  );
}

async function dryRunUpdate(
  input: UpdateInput,
  runtime: UpdateRuntime,
  preflight: UpdatePreflight,
  diagnostics: readonly Diagnostic[],
): Promise<UpdateReport> {
  let plan: ProfileDiffPlan;
  try {
    plan = await prepareMerge(input, runtime, preflight.marker, preflight);
  } catch (error) {
    const known = error instanceof TransactionFailure;
    return {
      diagnostics: [
        ...diagnostics,
        ...(known
          ? error.diagnostics
          : [
              diagnostic(
                'E_UPDATE_STATE',
                'error',
                'cannot safely prepare the update dry-run.',
                'Inspect the managed state and retry; no target write occurred.',
              ),
            ]),
      ],
      exitCode: known ? error.exitCode : EXIT_CODES.CONTRACT,
      metadata: { profile: input.profile, status: 'not-started', preflight: summary(preflight) },
    };
  }
  return {
    diagnostics: [...diagnostics, ...plan.conflicts],
    exitCode: plan.conflicts.length === 0 ? EXIT_CODES.SUCCESS : EXIT_CODES.CONTRACT,
    metadata: {
      profile: input.profile,
      status: 'preflight',
      preflight: summary(preflight),
      assets: plan.assets,
      settings: plan.settings,
    },
  };
}

function writesSettings(plan: ProfileDiffPlan): boolean {
  return plan.settings.some(
    (entry) => entry.action === 'update' || entry.action === 'create' || entry.action === 'remove',
  );
}

function metadataAction(asset: AssetMerge): MetadataAsset['action'] | undefined {
  if (asset.observed === undefined) return undefined;
  if (!asset.selected) {
    const base = asset.baseAsset;
    const observedMatchesBase =
      base !== undefined &&
      base.action !== 'skip' &&
      base.identity === asset.observed.identity &&
      state(base.files).canonicalValue === state(asset.observed.files).canonicalValue;
    // `--only setting:*` leaves an intact asset under its existing ownership.  A changed identity
    // or file summary is user state, however, and must remain a non-owning skip even though the
    // same generation can carry a deferred target base for the next three-way merge.
    return observedMatchesBase ? base.action : 'skip';
  }
  if (asset.action === 'remove') return undefined;
  if (asset.action === 'retain') return 'skip';
  if (asset.action === 'converged' && asset.baseAsset === undefined) return 'skip';
  if (asset.action === 'update') return 'replace';
  if (asset.action === 'create') return 'create';
  return asset.baseAsset?.action ?? 'skip';
}

async function captureUpdateSource(
  root: string,
  kind: UpdateAssetKind,
): Promise<Awaited<ReturnType<typeof captureSourceDirectory>>> {
  try {
    return await captureSourceDirectory(
      root,
      kind === 'profile' ? { skipPath: (path) => !isManagedProfileInventoryPath(path) } : {},
    );
  } catch (error) {
    if (!(error instanceof SnapshotCaptureError)) throw error;
    throw updateFailure(
      'E_UPDATE_ASSET_CAPTURE',
      'an effective update asset cannot be captured safely.',
      'Inspect links, special files, and size limits before retrying.',
      error.kind === 'security' ? EXIT_CODES.SECURITY : EXIT_CODES.CONTRACT,
    );
  }
}

function sameAssetFiles(
  left: readonly MetadataAssetFile[],
  right: readonly MetadataAssetFile[],
): boolean {
  if (left.length !== right.length) return false;
  const expected = new Map(left.map((file) => [file.path, file]));
  return right.every((file) => {
    const candidate = expected.get(file.path);
    return candidate?.sha256 === file.sha256 && candidate.bytes === file.bytes;
  });
}

async function captureUpdateAssets(
  transaction: TransactionContext,
  dshHome: string,
  assets: readonly AssetMerge[],
): Promise<readonly CapturedInstallAsset[]> {
  const captured: CapturedInstallAsset[] = [];
  for (const entry of assets) {
    const action = metadataAction(entry);
    if (action === undefined) continue;
    const root = join(dshHome, ...entry.target.split('/'));
    const identity = await transaction.artifactIdentity(entry.kind, root);
    const snapshot = await captureUpdateSource(root, entry.kind);
    if (snapshot.files.length === 0)
      throw updateFailure(
        'E_UPDATE_ASSET_EMPTY',
        `effective update asset is empty: ${entry.target}`,
        'Repair the managed asset before retrying.',
      );
    const confirmed = await captureUpdateSource(root, entry.kind);
    const finalIdentity = await transaction.artifactIdentity(entry.kind, root);
    if (
      finalIdentity !== identity ||
      snapshot.files.length !== confirmed.files.length ||
      snapshot.files.some(
        (file, index) =>
          file.path !== confirmed.files[index]?.path ||
          !Buffer.from(file.bytes).equals(Buffer.from(confirmed.files[index]?.bytes)),
      )
    )
      throw updateFailure(
        'E_UPDATE_ASSET_CHANGED',
        `effective update asset changed while it was being captured: ${entry.target}`,
        'Stop concurrent writes and retry; no generation was written.',
      );
    const files = snapshot.files.map((file) => ({
      path: file.path,
      sha256: sha256(file.bytes),
      bytes: file.bytes.byteLength,
    }));
    const continuesExistingAsset =
      entry.action === 'unchanged' || entry.action === 'retain' || entry.action === 'converged';
    if (
      continuesExistingAsset &&
      (entry.observed === undefined ||
        finalIdentity !== entry.observed.identity ||
        !sameAssetFiles(files, entry.observed.files))
    )
      throw updateFailure(
        'E_UPDATE_ASSET_CHANGED',
        `effective update asset changed after locked observation: ${entry.target}`,
        'Stop concurrent writes and retry; no generation was written.',
      );
    if (
      (entry.action === 'update' || entry.action === 'create') &&
      entry.targetAsset !== undefined &&
      !sameAssetFiles(files, entry.targetAsset.files)
    )
      throw updateFailure(
        'E_UPDATE_TARGET',
        `written update asset does not match its validated target: ${entry.target}`,
        'Stop concurrent writes and retry; the update was rolled back.',
      );
    captured.push({
      asset: {
        id:
          entry.kind === 'profile'
            ? entry.target.slice('profiles/'.length)
            : (entry.targetAsset?.id ?? entry.baseAsset?.id ?? ''),
        kind: entry.kind,
        target: entry.target,
        action,
        identity,
        files,
      },
      blocks:
        action === 'skip'
          ? []
          : snapshot.files.map((file) => ({
              target: `${entry.target}/${file.path}`,
              sha256: sha256(file.bytes),
              bytes: file.bytes,
            })),
    });
  }
  return captured;
}

async function installPlanForUpdate(
  input: UpdateInput,
  runtime: UpdateRuntime,
  preflight: UpdatePreflight,
): Promise<InstallPlan> {
  const request = captureInstallTargetRequest(
    { dshHome: input.dshHome, as: input.profile },
    preflight.material,
  );
  const before = await runtime.captureTargetState(request);
  const prepared = await prepareInstallPlanFromValidated(
    {
      source: { directory: input.dshHome, provenance: preflight.source },
      options: {
        sourceArgument: preflight.sourceReference,
        as: input.profile,
        replace: true,
        frozen: true,
        force: true,
        yes: true,
        ...(input.allowBuilds === undefined ? {} : { allowBuilds: input.allowBuilds }),
        ...(input.allowUnverified === undefined ? {} : { allowUnverified: input.allowUnverified }),
        ...(input.allowVersionMismatch === undefined
          ? {}
          : { allowVersionMismatch: input.allowVersionMismatch }),
        ...(input.allowDangerFullAccess === undefined
          ? {}
          : { allowDangerFullAccess: input.allowDangerFullAccess }),
      },
      environment: {
        dshHome: input.dshHome,
        dshVersion: preflight.versions.dshVersion,
        pnpmVersion: preflight.versions.pnpmVersion,
        profileExists: before.state.profile.state === 'present',
        interactive: false,
        targetBeforeState: before.state,
        targetBeforeStateDigest: before.digest,
      },
    },
    preflight.material,
    [],
    preflight.resolution,
  );
  if (prepared.plan === undefined)
    throw new TransactionFailure(prepared.exitCode, prepared.diagnostics);
  return prepared.plan;
}

async function verifyUpdateDoctor(
  runtime: UpdateRuntime,
  input: UpdateInput,
  assets: readonly CapturedInstallAsset[],
  diagnostics: Diagnostic[],
): Promise<void> {
  let doctor: Awaited<ReturnType<UpdateRuntime['runDoctor']>>;
  try {
    doctor = await runtime.runDoctor({
      dshHome: input.dshHome,
      profile: input.profile,
      strict: true,
      yes: true,
      fix: false,
    });
  } catch {
    throw updateFailure(
      'E_UPDATE_DOCTOR',
      'strict doctor could not complete after update apply.',
      'The update transaction was rolled back; inspect doctor and retry.',
    );
  }
  const ours: Diagnostic[] = [];
  const preexisting: Diagnostic[] = [];
  for (const item of doctor.diagnostics)
    (attributableToInstall(item, input.dshHome, {
      profile: input.profile,
      assets: assets.map(({ asset }) => asset),
    })
      ? ours
      : preexisting
    ).push(item);
  if (ours.some((item) => item.severity === 'error'))
    throw new TransactionFailure(EXIT_CODES.POST_INSTALL_VERIFY_FAILURE, ours);
  if (doctor.exitCode !== EXIT_CODES.SUCCESS && doctor.diagnostics.length === 0)
    throw updateFailure(
      'E_UPDATE_DOCTOR',
      'strict doctor failed without diagnostics after update apply.',
      'The update transaction was rolled back; inspect doctor and retry.',
    );
  if (preexisting.length > 0)
    diagnostics.push(
      diagnostic(
        'W_UPDATE_DOCTOR_PREEXISTING',
        'warning',
        `doctor reported ${preexisting.length} preexisting issue(s) outside this update scope.`,
        'Review them separately with dshpack doctor --strict.',
      ),
    );
}

async function applyUpdate(
  input: UpdateInput,
  runtime: UpdateRuntime,
  preflight: UpdatePreflight,
  initialDiagnostics: readonly Diagnostic[],
): Promise<UpdateReport> {
  let preview: ProfileDiffPlan;
  try {
    preview = await prepareMerge(input, runtime, preflight.marker, preflight);
  } catch (error) {
    const known = error instanceof TransactionFailure;
    const diagnostics = known
      ? error.diagnostics
      : [
          diagnostic(
            'E_UPDATE_STATE',
            'error',
            'cannot safely prepare update apply.',
            'Inspect the managed state and retry.',
          ),
        ];
    return {
      diagnostics: [...initialDiagnostics, ...diagnostics],
      exitCode: known ? error.exitCode : EXIT_CODES.CONTRACT,
      metadata: { profile: input.profile, status: 'not-started', preflight: summary(preflight) },
    };
  }
  if (preview.conflicts.length > 0)
    return {
      diagnostics: [...initialDiagnostics, ...preview.conflicts],
      exitCode: EXIT_CODES.CONTRACT,
      metadata: {
        profile: input.profile,
        status: 'not-started',
        preflight: summary(preflight),
        assets: preview.assets,
        settings: preview.settings,
      },
    };
  const operationDiagnostics = [...initialDiagnostics];
  let executed = preview;
  const transaction = await runTransaction<number>(
    { adapter: runtime.transactionAdapter, dshHome: input.dshHome, txid: runtime.txid() },
    async (transaction) => {
      const reread = await readMarker(input.dshHome, input.profile);
      if (reread.marker === undefined)
        throw updateFailure(
          'E_UPDATE_MARKER_UNTRACKED',
          'the tracked marker disappeared before update apply.',
          'Re-run update preflight before retrying.',
        );
      const marker = reread.marker as MarkerRecord & { readonly metadata: InstalledMetadataV1 };
      const newlyUnapproved = authorizationAfterMarkerChange(input, preflight, marker.metadata);
      if (newlyUnapproved.length > 0)
        throw new TransactionFailure(EXIT_CODES.USER_DECLINED, [
          diagnostic(
            'E_UPDATE_AUTHORIZATION_RACE',
            'error',
            'the installed marker changed after confirmation and now requires new authorization.',
            'Re-run update preflight and explicitly review every newly listed authorization item.',
          ),
          ...newlyUnapproved.map((item) => authorizationReviewDiagnostic(item, preflight)),
        ]);
      const locked = await prepareMerge(input, runtime, marker, preflight);
      executed = locked;
      if (locked.conflicts.length > 0)
        throw new TransactionFailure(EXIT_CODES.CONTRACT, locked.conflicts);
      const plan = await installPlanForUpdate(input, runtime, preflight);
      const profile = locked.assets.find((asset) => asset.kind === 'profile');
      let facts: readonly InstalledPluginFact[] = marker.metadata.plugins.map((plugin) => ({
        name: plugin.name,
        packageJsonSha512: plugin.packageJsonSha512,
        bundlePatch: plugin.bundlePatch,
        actualResolved: plugin.actualResolved as InstalledPluginFact['actualResolved'],
        actualIntegrity: plugin.actualIntegrity as InstalledPluginFact['actualIntegrity'],
      }));
      if (profile?.action === 'update' || profile?.action === 'create') {
        const profilePath = join(input.dshHome, ...profile.target.split('/'));
        if (profile.observed !== undefined)
          await transaction.replaceProfile(profilePath, profile.observed.identity);
        // installProfile owns the complete profile creation chain.  Replacement was performed
        // above with the locked observation identity, so its plan must now create only.
        facts = await installProfile(
          {
            // installProfile may construct a build-authorization replay. Its source and plan home
            // are diagnostic-only there, while update already owns the validated material and the
            // real write root below. Never let an arbitrary update SOURCE become a replay hint.
            source: '<validated-update-source>',
            dshHome: input.dshHome,
            as: input.profile,
            replace: true,
            frozen: true,
            force: true,
            yes: true,
            interactive: false,
            ...(input.allowBuilds === undefined ? {} : { allowBuilds: input.allowBuilds }),
            ...(input.allowUnverified === undefined
              ? {}
              : { allowUnverified: input.allowUnverified }),
            ...(input.allowVersionMismatch === undefined
              ? {}
              : { allowVersionMismatch: input.allowVersionMismatch }),
            ...(input.allowDangerFullAccess === undefined
              ? {}
              : { allowDangerFullAccess: input.allowDangerFullAccess }),
          },
          runtime,
          transaction,
          { ...plan, dshHome: '<managed-dsh-home>', replaceExistingProfile: false },
          preflight.material,
          preflight.resolution,
          new Set([...plan.allowBuilds, ...(input.allowBuilds ?? [])]),
          {},
        );
      }
      for (const asset of locked.assets) {
        if (
          asset.kind === 'profile' ||
          asset.action === 'retain' ||
          asset.action === 'unchanged' ||
          asset.action === 'converged'
        )
          continue;
        const target = join(input.dshHome, ...asset.target.split('/'));
        if (asset.action === 'remove') {
          if (asset.observed !== undefined)
            await transaction.replaceArtifact(asset.kind, target, asset.observed.identity);
          continue;
        }
        const targetAsset = asset.targetAsset;
        if (targetAsset === undefined)
          throw updateFailure(
            'E_UPDATE_TARGET',
            `update lost target asset ${asset.target}.`,
            'Retry update.',
          );
        if (asset.observed !== undefined)
          await transaction.replaceArtifact(asset.kind, target, asset.observed.identity);
        await transaction.create(asset.kind, target, () =>
          runtime.writeMaterialAsset(
            preflight.material,
            targetAsset.source,
            target,
            asset.kind as 'skill' | 'preset',
          ),
        );
      }
      await runInstallFault(runtime, 'assets');
      if (writesSettings(locked)) {
        const prepared = prepareAgentPresetsMerge({
          currentDocument: locked.settingsDocument,
          fragment: stringify(locked.desiredSettings),
          settingsPath: join(input.dshHome, 'settings.yaml'),
          fragmentPath: 'settings/agent-presets.yml',
        });
        if (!prepared.ok || prepared.value === undefined)
          throw new TransactionFailure(EXIT_CODES.CONTRACT, prepared.diagnostics);
        await transaction.writeSettings(
          join(input.dshHome, 'settings.yaml'),
          locked.settingsDocument,
          prepared.value.document,
        );
      }
      await runInstallFault(runtime, 'settings');
      if (profile?.action === 'update' || profile?.action === 'create') {
        await runtime.runDsh(['--profile', input.profile, '--dump-config'], {
          dshHome: input.dshHome,
          cwd: join(input.dshHome, 'profiles', input.profile),
        });
      }
      await runInstallFault(runtime, 'dump');
      const captured = await captureUpdateAssets(transaction, input.dshHome, locked.assets);
      await verifyUpdateDoctor(runtime, input, captured, operationDiagnostics);
      await runInstallFault(runtime, 'doctor');
      const allocation = await nextGeneration(transaction, input.dshHome, input.profile);
      await storeCapturedAssets(transaction, input.dshHome, captured);
      await runInstallFault(runtime, 'store');
      const installedAt = runtime.now();
      const completeMetadata = installedMetadata(
        plan,
        facts,
        installedAt,
        transaction.txid,
        preflight.material,
        {
          assets: captured.map(({ asset }) => asset),
          settingsContribution: locked.settingsContribution,
          generation: allocation.sequence,
        },
      );
      const metadata: InstalledMetadataV1 = {
        ...completeMetadata,
        ...(locked.deferredAssets.length === 0 ? {} : { deferredAssets: locked.deferredAssets }),
      };
      const generation = generationDocument(
        allocation.sequence,
        transaction.txid,
        installedAt,
        {
          operation: 'update',
          pack: { ...metadata.pack },
          source: { ...metadata.source },
          metadata,
        },
        captured,
        locked.settingsContribution,
      );
      await writeGeneration(transaction, input.dshHome, input.profile, generation);
      await runInstallFault(runtime, 'generation');
      await advanceCurrent(
        transaction,
        allocation.currentPath,
        allocation.previous,
        allocation.sequence,
      );
      await runInstallFault(runtime, 'current');
      await transaction.writeManagedDocument(
        join(input.dshHome, '.dshpack', 'installed', `${input.profile}.json`),
        `${JSON.stringify(metadata)}\n`,
        marker.document,
      );
      await runInstallFault(runtime, 'metadata');
      return allocation.sequence;
    },
  );
  if (!transaction.ok)
    return {
      diagnostics: [...operationDiagnostics, ...transaction.diagnostics],
      exitCode: transaction.exitCode,
      metadata: {
        profile: input.profile,
        status: transaction.status,
        preflight: summary(preflight),
        assets: executed.assets,
        settings: executed.settings,
        backupDirectory: transaction.backupDirectory,
        ...(transaction.value === undefined ? {} : { generation: transaction.value }),
      },
    };
  if (transaction.value === undefined)
    return {
      diagnostics: [
        ...operationDiagnostics,
        diagnostic(
          'E_UPDATE_TRANSACTION',
          'error',
          'committed update did not return its generation sequence.',
          'Inspect the generation current pointer before retrying.',
        ),
      ],
      exitCode: EXIT_CODES.INTERNAL,
      metadata: { profile: input.profile, status: 'committed', preflight: summary(preflight) },
    };
  return {
    diagnostics: operationDiagnostics,
    exitCode: EXIT_CODES.SUCCESS,
    metadata: {
      profile: input.profile,
      status: 'updated',
      preflight: summary(preflight),
      assets: executed.assets,
      settings: executed.settings,
      generation: transaction.value,
      backupDirectory: transaction.backupDirectory,
    },
  };
}

export async function updateProfile(
  input: UpdateInput,
  runtime: UpdateRuntime,
): Promise<UpdateReport> {
  const prepared = await preflightUpdate(input, runtime);
  if (prepared.preflight === undefined)
    return {
      diagnostics: prepared.report.diagnostics,
      exitCode: prepared.report.exitCode,
      metadata: {
        ...(isInstallableProfileName(input.profile) ? { profile: input.profile } : {}),
        status: 'not-started',
      },
    };
  const preflight = prepared.preflight;
  const review = reviewDiagnostics(preflight);
  const initialDiagnostics = [...prepared.report.diagnostics, ...review];
  if (input.dryRun === true) return dryRunUpdate(input, runtime, preflight, initialDiagnostics);
  const policy = decideUpdateAuthorization(input, preflight.authorizationDelta);
  if (policy.status === 'rejected')
    return policy.normalConfirmationRequired
      ? confirmationRequired(input, preflight, initialDiagnostics, policy.missing)
      : authorizationDeclined(input, preflight, initialDiagnostics, policy.missing);
  if (policy.status === 'requires-interaction') {
    const prompts = [
      ...(policy.normalConfirmationRequired ? [normalUpdatePrompt(preflight)] : []),
      ...policy.missing.map((item) => {
        runtime.writeStderr(authorizationReview(item));
        return confirmationPrompt(item);
      }),
    ];
    const accepted = await confirmPrompts(runtime, prompts);
    if (!accepted)
      return authorizationDeclined(input, preflight, initialDiagnostics, policy.missing);
  }
  if (policy.status === 'ready' || policy.status === 'requires-interaction')
    return applyUpdate(input, runtime, preflight, initialDiagnostics);
  return {
    diagnostics: [
      ...initialDiagnostics,
      diagnostic(
        'E_UPDATE_POLICY',
        'error',
        'update authorization policy reached an unsupported terminal state.',
        'Re-run the update command after reviewing its authorization flags.',
      ),
    ],
    exitCode: EXIT_CODES.INTERNAL,
    metadata: { profile: input.profile, status: 'not-started', preflight: summary(preflight) },
  };
}
