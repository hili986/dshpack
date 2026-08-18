import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { Diagnostic } from '@dshpack/core';
import { prepareAgentPresetsMerge } from '../adapters/settings.js';
import {
  SourceError,
  type SourceProvenance,
  sourceReferenceFromProvenance,
} from '../adapters/source.js';
import { type CommandReport, diagnostic } from '../commands/shared.js';
import { EXIT_CODES } from '../exit-codes.js';
import { captureInstallTargetRequest, installPack } from '../install/engine.js';
import { runInstallFault } from '../install/engine-errors.js';
import { buildAuthorizationKey } from '../install/profile-workspace.js';
import type { ReadPackResult, ValidatedPackMaterial } from '../install/read.js';
import { createNodeInstallRuntime } from '../install/runtime.js';
import type {
  CaptureInstallTargetInput,
  InstallRuntime,
  InstallTargetCapture,
} from '../install/runtime-types.js';
import { captureSourceDirectory, SnapshotCaptureError } from '../install/snapshot-capture.js';
import type { InstallPlan } from '../install/types.js';
import { bindDirectory, bindSecureRoot, readText } from '../list/safe-fs.js';
import {
  type InstalledMetadataV0,
  type InstalledMetadataV1,
  isInstallableProfileName,
  type MetadataAsset,
  type MetadataAssetAction,
  parseInstalledMetadata,
} from '../metadata/contracts.js';
import {
  advanceCurrent,
  type CapturedInstallAsset,
  type captureInstalledAssets,
  generationDocument,
  isManagedProfileInventoryPath,
  nextGeneration,
  settingsContribution,
  storeCapturedAssets,
  writeGeneration,
} from '../metadata/state-storage.js';
import { runTransaction, TransactionFailure } from '../transaction.js';
import { MAX_TRANSACTION_STATE_BYTES } from '../transaction-types.js';
import { GENERATED_BY } from '../version.js';

export interface MigrateInput {
  dshHome: string;
  profile: string;
  dryRun: boolean;
}

export interface MigrateMetadata {
  status:
    | 'migrated'
    | 'already-current'
    | 'planned'
    | 'not-started'
    | 'committed'
    | 'rolled-back'
    | 'rollback-failed';
  profile: string;
  generation?: number;
  /** Original operation state retained when a later private-workspace cleanup also fails. */
  primaryStatus?: MigrateMetadata['status'];
  cleanupFailed?: true;
  backupDirectory?: string;
  journalPath?: string;
  manualRecovery?: readonly {
    operation: string;
    sourcePath: string;
    destinationPath: string;
  }[];
}

export type MigrateReport = CommandReport<MigrateMetadata>;
export interface MigrateRuntime extends InstallRuntime {
  /** Test seam for a runtime confined to a private migration reconstruction home. */
  createScratchRuntime?(dshHome: string, legacyInstalledAt: string): InstallRuntime;
  /** Test seam for the private workspace cleanup boundary. */
  removeScratch?(dshHome: string): Promise<void>;
}

function report(
  exitCode: MigrateReport['exitCode'],
  diagnostics: readonly Diagnostic[],
  status: MigrateMetadata['status'],
  profile: string,
  extra: Omit<MigrateMetadata, 'status' | 'profile'> = {},
): MigrateReport {
  return {
    diagnostics,
    exitCode,
    metadata: { status, profile, ...extra },
  };
}

function contractFailure(profile: string, code: string, message: string): MigrateReport {
  return report(
    EXIT_CODES.CONTRACT,
    [diagnostic(code, 'error', message, 'Repair the legacy state and retry migration.')],
    'not-started',
    profile,
  );
}

function mergeCleanupReport(
  primary: MigrateReport,
  cleanup: MigrateReport | undefined,
): MigrateReport {
  if (cleanup === undefined) return primary;
  return {
    diagnostics: [...primary.diagnostics, ...cleanup.diagnostics],
    exitCode: EXIT_CODES.MANUAL_RECOVERY_REQUIRED,
    metadata: {
      ...primary.metadata,
      primaryStatus: primary.metadata.status,
      cleanupFailed: true,
      manualRecovery: [
        ...(primary.metadata.manualRecovery ?? []),
        ...(cleanup.metadata.manualRecovery ?? []),
      ],
    },
  };
}

function metadataReadFailure(
  profile: string,
  kind: 'missing' | 'security' | 'io' | 'limit' | 'changed',
  subject: string,
): MigrateReport {
  const missing = kind === 'missing';
  const limitOrChanged = kind === 'limit' || kind === 'changed';
  return report(
    missing
      ? EXIT_CODES.ENVIRONMENT
      : limitOrChanged
        ? EXIT_CODES.CONTRACT
        : kind === 'security'
          ? EXIT_CODES.SECURITY
          : EXIT_CODES.INTERNAL,
    [
      diagnostic(
        missing
          ? 'E_NOT_TRACKED'
          : limitOrChanged
            ? 'E_MIGRATE_METADATA_LIMIT'
            : 'E_MIGRATE_METADATA_READ',
        'error',
        missing ? 'profile is not tracked' : `${subject} could not be read safely`,
        missing
          ? 'Use list to select an installed profile.'
          : 'Repair links, special files, size limits, or concurrent changes before retrying.',
      ),
    ],
    'not-started',
    profile,
  );
}

function materialText(material: ValidatedPackMaterial, path: string): string {
  const encoded = material.files.find((file) => file.path === path)?.contentBase64;
  if (encoded === undefined)
    throw new TransactionFailure(EXIT_CODES.CONTRACT, [
      diagnostic(
        'E_MIGRATE_SOURCE_PAYLOAD',
        'error',
        `validated source is missing ${path}`,
        'Re-fetch and validate the original source before retrying.',
      ),
    ]);
  return Buffer.from(encoded, 'base64').toString('utf8');
}

function sourceMatchesLegacy(
  legacy: InstalledMetadataV0,
  source: SourceProvenance,
  material: ValidatedPackMaterial,
): boolean {
  return isDeepStrictEqual(
    {
      source,
      pack: {
        name: material.manifest.name,
        version: material.manifest.version,
        manifestDigest: material.manifestDigest,
      },
      files: material.sourceFiles.filter(
        ({ path }) => path !== 'pack.yml' && path !== 'pack.lock.yml',
      ),
    },
    { source: legacy.source, pack: legacy.pack, files: legacy.effectiveLock.files },
  );
}

async function readLegacyMarker(
  dshHome: string,
  profile: string,
): Promise<{ marker: InstalledMetadataV0; text: string } | { report: MigrateReport }> {
  const root = await bindSecureRoot(dshHome);
  if (!root.ok)
    return { report: metadataReadFailure(profile, root.kind, 'installed metadata root') };
  const installed = await bindDirectory(root.value, ['.dshpack', 'installed']);
  if (!installed.ok)
    return { report: metadataReadFailure(profile, installed.kind, 'installed metadata directory') };
  const marker = await readText(installed.value, [`${profile}.json`]);
  if (!marker.ok)
    return { report: metadataReadFailure(profile, marker.kind, 'installed metadata') };
  let value: unknown;
  try {
    value = JSON.parse(marker.value.text);
  } catch {
    return {
      report: contractFailure(
        profile,
        'E_MIGRATE_METADATA_INVALID',
        'installed metadata is not valid JSON',
      ),
    };
  }
  const parsed = parseInstalledMetadata(value, profile);
  if (!parsed.ok)
    return {
      report: contractFailure(
        profile,
        parsed.reason === 'profile-mismatch'
          ? 'E_MIGRATE_METADATA_PROFILE'
          : 'E_MIGRATE_METADATA_INVALID',
        'installed metadata does not satisfy the v0/v1 contract',
      ),
    };
  if (parsed.metadata.metadataVersion === 1)
    return {
      report: report(EXIT_CODES.SUCCESS, [], 'already-current', profile, {
        generation: parsed.metadata.generation,
      }),
    };
  return { marker: parsed.metadata, text: marker.value.text };
}

async function readOriginalSource(
  runtime: MigrateRuntime,
  profile: string,
  legacy: InstalledMetadataV0,
): Promise<
  | {
      material: ValidatedPackMaterial;
      source: SourceProvenance;
      directory: string;
      diagnostics: readonly Diagnostic[];
    }
  | { report: MigrateReport }
> {
  const reference = sourceReferenceFromProvenance(legacy.source as SourceProvenance);
  let materialized: Awaited<ReturnType<MigrateRuntime['materializeSource']>>;
  try {
    materialized = await runtime.materializeSource(reference);
  } catch (error) {
    if (error instanceof SourceError)
      return {
        report: report(
          error.exitCode,
          [
            diagnostic(
              error.code,
              'error',
              error.message,
              error.hint ?? 'Re-fetch the original source.',
            ),
          ],
          'not-started',
          profile,
        ),
      };
    return {
      report: report(
        EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
        [
          diagnostic(
            'E_MIGRATE_SOURCE',
            'error',
            'original source could not be materialized',
            'Check the recorded source and retry migration.',
          ),
        ],
        'not-started',
        profile,
      ),
    };
  }
  let read: ReadPackResult;
  try {
    read = await runtime.readValidatedPack(materialized.directory, { frozen: false });
  } catch (error) {
    if (error instanceof SourceError)
      read = {
        diagnostics: [
          diagnostic(error.code, 'error', error.message, error.hint ?? 'Re-fetch source.'),
        ],
        exitCode: error.exitCode,
      };
    else
      read = {
        diagnostics: [
          diagnostic(
            'E_MIGRATE_SOURCE_READ',
            'error',
            'original source could not be validated',
            'Re-fetch the source and retry migration.',
          ),
        ],
        exitCode: EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
      };
  }
  let cleanup: MigrateReport | undefined;
  try {
    await materialized.cleanup();
  } catch {
    cleanup = report(
      EXIT_CODES.MANUAL_RECOVERY_REQUIRED,
      [
        diagnostic(
          'E_MIGRATE_SOURCE_CLEANUP',
          'error',
          'private source cleanup failed',
          'Remove the reported private source workspace after inspection.',
          materialized.directory,
        ),
      ],
      'rollback-failed',
      profile,
      {
        manualRecovery: [
          {
            operation: 'remove-private-source',
            sourcePath: materialized.directory,
            destinationPath: materialized.directory,
          },
        ],
      },
    );
  }
  if (read.material === undefined)
    return {
      report: mergeCleanupReport(
        report(read.exitCode, read.diagnostics, 'not-started', profile),
        cleanup,
      ),
    };
  if (!sourceMatchesLegacy(legacy, materialized.provenance, read.material))
    return {
      report: mergeCleanupReport(
        report(
          EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
          [
            diagnostic(
              'E_MIGRATE_SOURCE_CHANGED',
              'error',
              'the re-fetched source no longer matches the v0 installed base',
              'Restore the original immutable source or reinstall the profile.',
            ),
          ],
          'not-started',
          profile,
        ),
        cleanup,
      ),
    };
  if (cleanup !== undefined) return { report: cleanup };
  return {
    material: read.material,
    source: materialized.provenance,
    directory: materialized.directory,
    diagnostics: read.diagnostics,
  };
}

interface ScratchReconstruction {
  dshHome: string;
  marker: InstalledMetadataV1;
  plan: InstallPlan;
}

interface ProfileOwnershipProof {
  action: Extract<MetadataAssetAction, 'create' | 'replace'>;
  journalText: string;
  journalIdentity: string;
}

interface ProfileOwnershipReadProblem {
  kind: 'missing' | 'security' | 'io' | 'limit' | 'changed';
}

type ProfileOwnershipObservation = ProfileOwnershipProof | ProfileOwnershipReadProblem | undefined;
type ProfileJournalActionMatch = {
  action: Extract<MetadataAssetAction, 'create' | 'replace'>;
  index: number;
};

function isOwnershipReadProblem(
  observation: ProfileOwnershipObservation,
): observation is ProfileOwnershipReadProblem {
  return observation !== undefined && 'kind' in observation;
}

function ownershipReadProblem(
  kind: ProfileOwnershipReadProblem['kind'],
): ProfileOwnershipReadProblem | undefined {
  return kind === 'missing' ? undefined : { kind };
}

function ownershipReadFailure(
  profile: string,
  kind: ProfileOwnershipReadProblem['kind'],
): MigrateReport {
  return report(
    kind === 'security' ? EXIT_CODES.SECURITY : EXIT_CODES.CONTRACT,
    [
      diagnostic(
        'E_MIGRATE_PROFILE_OWNERSHIP_READ',
        'error',
        'legacy profile ownership journal could not be read safely',
        'Repair the legacy transaction journal and retry migration.',
      ),
    ],
    'not-started',
    profile,
  );
}

type ManagedAssetKind = Exclude<MetadataAsset['kind'], 'managed-document'>;

function targetAssetPaths(request: CaptureInstallTargetInput): readonly {
  kind: ManagedAssetKind;
  target: string;
}[] {
  return [
    { kind: 'profile', target: `profiles/${request.profile}` },
    ...request.skills.map((target) => ({ kind: 'skill' as const, target })),
    ...request.presets.map((target) => ({ kind: 'preset' as const, target })),
  ];
}

function targetIdentityFailure(): TransactionFailure {
  return new TransactionFailure(EXIT_CODES.CONTRACT, [
    diagnostic(
      'E_MIGRATE_TARGET_IDENTITY',
      'error',
      'a migration target was replaced while its base was being observed',
      'Retry migration from a stable target state.',
    ),
  ]);
}

async function captureTargetAssetIdentities(
  transaction: Parameters<typeof captureInstalledAssets>[0],
  request: CaptureInstallTargetInput,
): Promise<ReadonlyMap<string, string>> {
  const identities = new Map<string, string>();
  for (const { kind, target } of targetAssetPaths(request)) {
    const identity = await transaction.artifactIdentity(
      kind,
      join(request.dshHome, ...target.split('/')),
    );
    if (identity === undefined) throw targetIdentityFailure();
    identities.set(target, identity);
  }
  return identities;
}

function sameTargetAssetIdentities(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([target, identity]) => right.get(target) === identity)
  );
}

function effectiveLockCommitment(lock: InstalledMetadataV0['effectiveLock']): object {
  const { generatedBy: _generatedBy, generatedAt: _generatedAt, ...commitment } = lock;
  return commitment;
}

function sourceBaseMatchesLegacy(
  legacy: InstalledMetadataV0,
  marker: InstalledMetadataV1,
): boolean {
  return (
    isDeepStrictEqual(marker.source, legacy.source) &&
    isDeepStrictEqual(marker.pack, legacy.pack) &&
    isDeepStrictEqual(
      effectiveLockCommitment(marker.effectiveLock),
      effectiveLockCommitment(legacy.effectiveLock),
    ) &&
    isDeepStrictEqual(marker.plugins, legacy.plugins)
  );
}

function scriptDeniedScratchRuntime(runtime: InstallRuntime): InstallRuntime {
  return {
    ...runtime,
    async runPnpm(args, options) {
      if (options.scriptPolicy === 'allow-approved')
        throw new Error('migration scratch reconstruction never runs lifecycle scripts');
      return runtime.runPnpm(args, options);
    },
  };
}

async function reconstructionFailure(
  runtime: MigrateRuntime,
  profile: string,
  scratch: string,
  failure: MigrateReport,
): Promise<{ report: MigrateReport }> {
  const cleanup = await cleanupScratchBase(runtime, profile, scratch);
  return { report: mergeCleanupReport(failure, cleanup) };
}

function scratchMarkerFailure(
  profile: string,
  kind: 'missing' | 'security' | 'io' | 'limit' | 'changed',
) {
  return report(
    kind === 'security' ? EXIT_CODES.SECURITY : EXIT_CODES.CONTRACT,
    [
      diagnostic(
        'E_MIGRATE_SCRATCH_MARKER_READ',
        'error',
        'isolated reconstruction metadata could not be read safely',
        'Reinstall the profile to establish a new v1 base.',
      ),
    ],
    'not-started',
    profile,
  );
}

async function readScratchMarker(
  scratch: string,
  profile: string,
): Promise<InstalledMetadataV1 | MigrateReport> {
  const root = await bindSecureRoot(scratch);
  if (!root.ok) return scratchMarkerFailure(profile, root.kind);
  const installed = await bindDirectory(root.value, ['.dshpack', 'installed']);
  if (!installed.ok) return scratchMarkerFailure(profile, installed.kind);
  const marker = await readText(
    installed.value,
    [`${profile}.json`],
    {},
    MAX_TRANSACTION_STATE_BYTES,
  );
  if (!marker.ok) return scratchMarkerFailure(profile, marker.kind);
  try {
    const parsed = parseInstalledMetadata(JSON.parse(marker.value.text), profile);
    if (parsed.ok && parsed.metadata.metadataVersion === 1) return parsed.metadata;
  } catch {
    // The reconstruction contract failure below deliberately omits raw marker contents.
  }
  return report(
    EXIT_CODES.CONTRACT,
    [
      diagnostic(
        'E_MIGRATE_BASE_REBUILD',
        'error',
        'isolated reconstruction did not produce valid v1 metadata',
        'Reinstall the profile to establish a new v1 base.',
      ),
    ],
    'not-started',
    profile,
  );
}

async function reconstructScratchBase(
  runtime: MigrateRuntime,
  profile: string,
  legacy: InstalledMetadataV0,
  material: ValidatedPackMaterial,
): Promise<ScratchReconstruction | { report: MigrateReport }> {
  let scratch: string;
  try {
    scratch = await mkdtemp(join(tmpdir(), 'dshpack-migrate-scratch-'));
  } catch {
    return {
      report: report(
        EXIT_CODES.ENVIRONMENT,
        [
          diagnostic(
            'E_MIGRATE_SCRATCH_CREATE',
            'error',
            'private migration reconstruction workspace could not be created',
            'Repair the temporary directory and retry migration.',
          ),
        ],
        'not-started',
        profile,
      ),
    };
  }
  const scratchRuntime = scriptDeniedScratchRuntime(
    runtime.createScratchRuntime?.(scratch, legacy.installedAt) ??
      createNodeInstallRuntime(scratch, {
        now: () => legacy.installedAt,
        processEnvironmentPolicy: 'migration-scratch',
      }),
  );
  if (
    legacy.plugins.some(
      (plugin) =>
        plugin.actualIntegrity.kind === 'unverified' ||
        legacy.effectiveLock.plugins.some(
          (locked) => locked.name === plugin.name && locked.integrity.kind === 'unverified',
        ),
    )
  )
    return reconstructionFailure(
      runtime,
      profile,
      scratch,
      report(
        EXIT_CODES.CONTRACT,
        [
          diagnostic(
            'E_MIGRATE_UNVERIFIED_BASE',
            'error',
            'an unverified legacy plugin has no complete immutable reconstruction commitment',
            'Reinstall the profile from a fully verified source before migrating.',
          ),
        ],
        'not-started',
        profile,
      ),
    );
  try {
    const rebuilt = await installPack(
      {
        source: sourceReferenceFromProvenance(legacy.source as SourceProvenance),
        dshHome: scratch,
        as: profile,
        yes: true,
        interactive: false,
        // The isolated replay may satisfy a historic declaration, but its runtime rejects every
        // allow-approved rebuild. Dependency adds stay script-denied.
        allowBuilds: material.manifest.plugins
          .filter((plugin) => plugin.allowBuilds)
          .map((plugin) => buildAuthorizationKey(plugin)),
        // These declarations are evaluated only in the private scratch DSH_HOME. They do not
        // widen a live operation, and scripts remain denied above.
        allowDangerFullAccess: true,
        allowUnverified: false,
        allowVersionMismatch: true,
      },
      scratchRuntime,
    );
    if (rebuilt.exitCode !== EXIT_CODES.SUCCESS) {
      const unsafeScratchExitCodes: readonly number[] = [
        EXIT_CODES.USER_DECLINED,
        EXIT_CODES.PROFILE_CONFLICT_OR_LOCK,
        EXIT_CODES.DSH_SUBPROCESS_FAILURE,
        EXIT_CODES.POST_INSTALL_VERIFY_FAILURE,
        EXIT_CODES.CONTRACT,
      ];
      const preserveTypedFailure = !unsafeScratchExitCodes.includes(rebuilt.exitCode);
      return reconstructionFailure(
        runtime,
        profile,
        scratch,
        preserveTypedFailure
          ? report(
              rebuilt.exitCode,
              rebuilt.diagnostics,
              rebuilt.metadata.status === 'installed' ? 'committed' : rebuilt.metadata.status,
              profile,
              {
                ...(rebuilt.metadata.manualRecovery === undefined
                  ? {}
                  : { manualRecovery: rebuilt.metadata.manualRecovery }),
              },
            )
          : report(
              EXIT_CODES.CONTRACT,
              [
                diagnostic(
                  'E_MIGRATE_BASE_REBUILD',
                  'error',
                  'the legacy source cannot be replayed safely in an isolated workspace',
                  'Reinstall the profile to establish a new v1 base.',
                ),
              ],
              'not-started',
              profile,
            ),
      );
    }
    if (rebuilt.metadata.plan === undefined)
      return reconstructionFailure(
        runtime,
        profile,
        scratch,
        report(
          EXIT_CODES.CONTRACT,
          [
            diagnostic(
              'E_MIGRATE_BASE_REBUILD',
              'error',
              'the legacy source cannot be replayed safely in an isolated workspace',
              'Reinstall the profile to establish a new v1 base.',
            ),
          ],
          'not-started',
          profile,
        ),
      );
    const parsed = await readScratchMarker(scratch, profile);
    if ('exitCode' in parsed) return reconstructionFailure(runtime, profile, scratch, parsed);
    if (!sourceBaseMatchesLegacy(legacy, parsed))
      return reconstructionFailure(
        runtime,
        profile,
        scratch,
        report(
          EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
          [
            diagnostic(
              'E_MIGRATE_BASE_CHANGED',
              'error',
              'isolated reconstruction does not match the recorded v0 source base',
              'Reinstall the profile to establish a new v1 base.',
            ),
          ],
          'not-started',
          profile,
        ),
      );
    return { dshHome: scratch, marker: parsed, plan: rebuilt.metadata.plan };
  } catch {
    return reconstructionFailure(
      runtime,
      profile,
      scratch,
      report(
        EXIT_CODES.CONTRACT,
        [
          diagnostic(
            'E_MIGRATE_BASE_REBUILD',
            'error',
            'isolated reconstruction could not be verified',
            'Reinstall the profile to establish a new v1 base.',
          ),
        ],
        'not-started',
        profile,
      ),
    );
  }
}

async function cleanupScratchBase(
  runtime: MigrateRuntime,
  profile: string,
  scratch: string,
): Promise<MigrateReport | undefined> {
  try {
    if (runtime.removeScratch !== undefined) await runtime.removeScratch(scratch);
    else await rm(scratch, { recursive: true, force: true });
    return undefined;
  } catch {
    return report(
      EXIT_CODES.MANUAL_RECOVERY_REQUIRED,
      [
        diagnostic(
          'E_MIGRATE_SCRATCH_CLEANUP',
          'error',
          'private migration reconstruction cleanup failed',
          'Remove the reported private migration workspace after inspection.',
          scratch,
        ),
      ],
      'rollback-failed',
      profile,
      {
        manualRecovery: [
          { operation: 'remove-private-scratch', sourcePath: scratch, destinationPath: scratch },
        ],
      },
    );
  }
}

function sourceBaseFailure(code: string, message: string): TransactionFailure {
  return new TransactionFailure(EXIT_CODES.CONTRACT, [
    diagnostic(code, 'error', message, 'Reinstall the profile to establish a new v1 base.'),
  ]);
}

function expectedFiles(
  files: readonly { path: string; bytes: Uint8Array }[],
): MetadataAsset['files'] {
  return files.map((file) => ({
    path: file.path,
    sha256: `sha256-${createHash('sha256').update(file.bytes).digest('base64url')}`,
    bytes: file.bytes.byteLength,
  }));
}

async function captureScratchBaseAssets(
  transaction: Parameters<typeof captureInstalledAssets>[0],
  dshHome: string,
  scratch: ScratchReconstruction,
  profileAction: MetadataAssetAction,
  targetIdentities: ReadonlyMap<string, string>,
): Promise<readonly CapturedInstallAsset[]> {
  const assets: CapturedInstallAsset[] = [];
  for (const expected of scratch.marker.assets) {
    const kind = expected.kind;
    if (kind === 'managed-document')
      throw sourceBaseFailure(
        'E_MIGRATE_BASE_CAPTURE',
        'isolated reconstruction emitted an unsupported managed-document asset',
      );
    const scratchTarget = join(scratch.dshHome, ...expected.target.split('/'));
    let captured: Awaited<ReturnType<typeof captureSourceDirectory>>;
    try {
      captured = await captureSourceDirectory(
        scratchTarget,
        kind === 'profile' ? { skipPath: (path) => !isManagedProfileInventoryPath(path) } : {},
      );
    } catch (error) {
      if (error instanceof SnapshotCaptureError)
        throw sourceBaseFailure(
          'E_MIGRATE_BASE_CAPTURE',
          'isolated source base changed during capture',
        );
      throw error;
    }
    const files = expectedFiles(captured.files);
    if (!isDeepStrictEqual(files, expected.files))
      throw sourceBaseFailure(
        'E_MIGRATE_BASE_CAPTURE',
        'isolated source base no longer matches its reconstructed metadata',
      );
    const identity = await transaction.artifactIdentity(
      kind,
      join(dshHome, ...expected.target.split('/')),
    );
    if (identity === undefined || identity !== targetIdentities.get(expected.target))
      throw targetIdentityFailure();
    // v0 never recorded globally-safe skill/preset ownership.  Preserve their source base for
    // drift detection, but make future destructive consumers retain them unless newer evidence
    // proves ownership.  The profile is the legacy marker's named managed target.
    const action = kind === 'profile' ? profileAction : 'skip';
    const asset: MetadataAsset = { ...expected, action, identity, files };
    assets.push({
      asset,
      blocks:
        action === 'skip'
          ? []
          : captured.files.map((file) => ({
              target: `${expected.target}/${file.path}`,
              sha256: `sha256-${createHash('sha256').update(file.bytes).digest('base64url')}`,
              bytes: file.bytes,
            })),
    });
  }
  return assets;
}

function targetCaptureRequest(
  dshHome: string,
  profile: string,
  material: ValidatedPackMaterial,
): CaptureInstallTargetInput {
  return {
    ...captureInstallTargetRequest({ dshHome, as: profile }, material),
    profileInventoryPath: isManagedProfileInventoryPath,
  };
}

/**
 * v0 did not persist globally safe ownership for skill/preset assets, so those remain `skip`.
 * The profile is a restorable base and must instead have one exact committed/applied journal
 * proof. Migration rejects rather than publishing a restorable generation without that proof.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPathFact(value: unknown, exists: boolean): value is Record<string, unknown> {
  return isRecord(value) && typeof value.path === 'string' && value.exists === exists;
}

function isArtifactKind(value: unknown): boolean {
  return [
    'profile',
    'skill',
    'preset',
    'store-directory',
    'generation-directory',
    'installed-directory',
    'store-block',
    'generation',
  ].includes(value as string);
}

function isAppliedJournalAction(action: unknown, index: number): action is Record<string, unknown> {
  if (!isRecord(action)) return false;
  if (action.id !== `action-${String(index + 1).padStart(4, '0')}` || action.phase !== 'applied')
    return false;
  if (action.kind === 'create') {
    const next = action.new;
    return (
      isArtifactKind(action.artifact) &&
      ['owned', 'not-owned'].includes(action.ownership as string) &&
      isPathFact(action.old, false) &&
      isPathFact(next, true) &&
      typeof next.rollbackPath === 'string' &&
      (next.identity === undefined || typeof next.identity === 'string') &&
      (next.contentSha256 === undefined || typeof next.contentSha256 === 'string') &&
      (next.emptyOnRollback === undefined || next.emptyOnRollback === true)
    );
  }
  if (action.kind === 'replace') {
    const next = action.new;
    return (
      isArtifactKind(action.artifact) &&
      isPathFact(action.old, true) &&
      isPathFact(next, false) &&
      typeof next.preservedAt === 'string'
    );
  }
  if (
    action.kind !== 'settings-write' &&
    action.kind !== 'managed-document-write' &&
    action.kind !== 'generation-current-write'
  )
    return false;
  const old = action.old;
  const next = action.new;
  return (
    ['written', 'not-written'].includes(action.writeState as string) &&
    isRecord(old) &&
    typeof old.path === 'string' &&
    typeof old.exists === 'boolean' &&
    (old.exists === false || typeof old.documentPath === 'string') &&
    isPathFact(next, true) &&
    typeof next.documentPath === 'string' &&
    typeof next.rollbackPath === 'string'
  );
}

function profileActionFromCommittedJournal(
  value: unknown,
  profile: string,
  legacy: InstalledMetadataV0,
): Extract<MetadataAssetAction, 'create' | 'replace'> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const journal = value as Record<string, unknown>;
  if (
    journal.version !== 0 ||
    journal.txid !== legacy.txid ||
    typeof journal.dshHome !== 'string' ||
    journal.state !== 'committed' ||
    !Array.isArray(journal.actions) ||
    journal.actions.length === 0 ||
    !journal.actions.every((action, index) => isAppliedJournalAction(action, index))
  )
    return undefined;
  const backupDirectory = join(journal.dshHome, '.dshpack', 'backups', legacy.txid);
  if (journal.backupDirectory !== backupDirectory) return undefined;
  const expectedProfilePath = join(journal.dshHome, 'profiles', profile);
  const profileActions = journal.actions
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => action.artifact === 'profile');
  const matches: ProfileJournalActionMatch[] = profileActions.flatMap<ProfileJournalActionMatch>(
    ({ action, index }) => {
      const old = action.old as Record<string, unknown> | undefined;
      const next = action.new as Record<string, unknown> | undefined;
      if (old === undefined || next === undefined) return [];
      if (
        action.kind === 'create' &&
        action.ownership === 'owned' &&
        old.path === expectedProfilePath &&
        old.exists === false &&
        next.path === expectedProfilePath &&
        next.exists === true &&
        next.rollbackPath === join(backupDirectory, 'new', action.id as string)
      )
        return [{ action: 'create' as const, index }];
      if (
        action.kind === 'replace' &&
        old.path === expectedProfilePath &&
        old.exists === true &&
        next.path === expectedProfilePath &&
        next.exists === false &&
        next.preservedAt === join(backupDirectory, 'old', action.id as string)
      )
        return [{ action: 'replace' as const, index }];
      return [];
    },
  );
  if (matches.length !== profileActions.length) return undefined;
  if (matches.length === 1 && matches[0]?.action === 'create') return 'create';
  if (
    matches.length === 2 &&
    matches[0]?.action === 'replace' &&
    matches[1]?.action === 'create' &&
    matches[1].index === matches[0].index + 1
  )
    return 'replace';
  return undefined;
}

async function legacyProfileOwnership(
  dshHome: string,
  profile: string,
  legacy: InstalledMetadataV0,
): Promise<ProfileOwnershipObservation> {
  const root = await bindSecureRoot(dshHome);
  if (!root.ok) return ownershipReadProblem(root.kind);
  const backup = await bindDirectory(root.value, ['.dshpack', 'backups', legacy.txid]);
  if (!backup.ok) return ownershipReadProblem(backup.kind);
  const journal = await readText(backup.value, ['journal.json']);
  if (!journal.ok) return ownershipReadProblem(journal.kind);
  let parsed: unknown;
  try {
    parsed = JSON.parse(journal.value.text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const declaredHome = (parsed as { dshHome?: unknown }).dshHome;
  if (typeof declaredHome !== 'string' || !isAbsolute(declaredHome)) return undefined;
  const declaredRoot = await bindSecureRoot(declaredHome);
  if (!declaredRoot.ok || declaredRoot.value.rootCanonical !== root.value.rootCanonical)
    return undefined;
  const action = profileActionFromCommittedJournal(parsed, profile, legacy);
  if (action === undefined) return undefined;
  return { action, journalText: journal.value.text, journalIdentity: journal.value.identity };
}

async function preflightMigration(
  input: MigrateInput,
  runtime: MigrateRuntime,
  material: ValidatedPackMaterial,
  diagnostics: readonly Diagnostic[],
): Promise<
  | {
      before: InstallTargetCapture;
      request: CaptureInstallTargetInput;
      contribution: ReturnType<typeof settingsContribution>;
      diagnostics: readonly Diagnostic[];
    }
  | { report: MigrateReport }
> {
  const request = targetCaptureRequest(input.dshHome, input.profile, material);
  let before: InstallTargetCapture;
  try {
    before = await runtime.captureTargetState(request);
  } catch {
    return {
      report: report(
        EXIT_CODES.SECURITY,
        [
          diagnostic(
            'E_MIGRATE_TARGET_STATE',
            'error',
            'migration target could not be captured safely',
            'Repair links or concurrent writes before retrying.',
          ),
        ],
        'not-started',
        input.profile,
      ),
    };
  }
  const requiredTargets = [before.state.profile, ...before.state.skills, ...before.state.presets];
  if (requiredTargets.some((target) => target.state !== 'present'))
    return {
      report: contractFailure(
        input.profile,
        'E_MIGRATE_TARGET_MISSING',
        'a legacy-managed target is missing; migrate never recreates installation targets',
      ),
    };
  let contribution = settingsContribution({});
  if (material.manifest.settings !== undefined) {
    let fragment: string;
    try {
      fragment = materialText(material, 'settings/agent-presets.yml');
    } catch (error) {
      if (error instanceof TransactionFailure)
        return { report: report(error.exitCode, error.diagnostics, 'not-started', input.profile) };
      throw error;
    }
    const prepared = prepareAgentPresetsMerge({
      currentDocument: before.settingsDocument,
      fragment,
      settingsPath: join(input.dshHome, 'settings.yaml'),
      fragmentPath: 'settings/agent-presets.yml',
    });
    if (!prepared.ok || prepared.value === undefined)
      return {
        report: report(EXIT_CODES.CONTRACT, prepared.diagnostics, 'not-started', input.profile),
      };
    contribution = settingsContribution(prepared.value.section);
  }
  return { before, request, contribution, diagnostics };
}

export async function migrateProfile(
  input: MigrateInput,
  runtime: MigrateRuntime,
): Promise<MigrateReport> {
  if (!isInstallableProfileName(input.profile))
    return contractFailure(input.profile, 'E_MIGRATE_PROFILE', 'profile is not installable');
  const markerPath = join(input.dshHome, '.dshpack', 'installed', `${input.profile}.json`);
  const initial = await readLegacyMarker(input.dshHome, input.profile);
  if ('report' in initial) return initial.report;
  const ownership = await legacyProfileOwnership(input.dshHome, input.profile, initial.marker);
  if (isOwnershipReadProblem(ownership)) return ownershipReadFailure(input.profile, ownership.kind);
  if (ownership === undefined)
    return contractFailure(
      input.profile,
      'E_MIGRATE_PROFILE_OWNERSHIP',
      'legacy profile ownership cannot be proven from its committed transaction journal',
    );
  const profileAction = ownership.action;
  const original = await readOriginalSource(runtime, input.profile, initial.marker);
  if ('report' in original) return original.report;
  const scratchResult = await reconstructScratchBase(
    runtime,
    input.profile,
    initial.marker,
    original.material,
  );
  if ('report' in scratchResult) return scratchResult.report;
  const scratch = scratchResult;
  const planned = await preflightMigration(input, runtime, original.material, original.diagnostics);
  if ('report' in planned) {
    const cleanup = await cleanupScratchBase(runtime, input.profile, scratch.dshHome);
    return mergeCleanupReport(planned.report, cleanup);
  }
  if (input.dryRun) {
    const cleanup = await cleanupScratchBase(runtime, input.profile, scratch.dshHome);
    return mergeCleanupReport(
      report(EXIT_CODES.SUCCESS, planned.diagnostics, 'planned', input.profile),
      cleanup,
    );
  }

  const txid = runtime.txid();
  const transaction = await runTransaction<number>(
    { adapter: runtime.transactionAdapter, dshHome: input.dshHome, txid },
    async (tx) => {
      if (runtime.transactionAdapter.readManagedDocument === undefined)
        throw new TransactionFailure(EXIT_CODES.INTERNAL, [
          diagnostic(
            'E_MIGRATE_STATE_ADAPTER',
            'error',
            'transaction adapter cannot safely reread installed metadata',
            'Use the production transaction adapter before retrying.',
          ),
        ]);
      let lockedText: string | undefined;
      try {
        lockedText = await runtime.transactionAdapter.readManagedDocument(markerPath);
      } catch (error) {
        if (error instanceof TransactionFailure) throw error;
        throw new TransactionFailure(EXIT_CODES.SECURITY, [
          diagnostic(
            'E_MIGRATE_METADATA_READ',
            'error',
            'installed metadata could not be reread safely under the transaction lock',
            'Repair links, special files, or concurrent changes before retrying.',
          ),
        ]);
      }
      if (lockedText !== initial.text)
        throw new TransactionFailure(EXIT_CODES.CONTRACT, [
          diagnostic(
            'E_MIGRATE_METADATA_CHANGED',
            'error',
            'installed metadata changed during migration preflight',
            'Retry migration from a freshly read legacy marker.',
          ),
        ]);
      const lockedOwnership = await legacyProfileOwnership(
        input.dshHome,
        input.profile,
        initial.marker,
      );
      if (isOwnershipReadProblem(lockedOwnership))
        throw new TransactionFailure(
          lockedOwnership.kind === 'security' ? EXIT_CODES.SECURITY : EXIT_CODES.CONTRACT,
          [
            diagnostic(
              'E_MIGRATE_PROFILE_OWNERSHIP_READ',
              'error',
              'legacy profile ownership journal could not be reread safely under the transaction lock',
              'Repair the legacy transaction journal and retry migration.',
            ),
          ],
        );
      if (
        lockedOwnership === undefined ||
        lockedOwnership.action !== ownership.action ||
        lockedOwnership.journalText !== ownership.journalText ||
        lockedOwnership.journalIdentity !== ownership.journalIdentity
      )
        throw new TransactionFailure(EXIT_CODES.CONTRACT, [
          diagnostic(
            'E_MIGRATE_PROFILE_OWNERSHIP_CHANGED',
            'error',
            'legacy profile ownership proof changed during migration preflight',
            'Retry migration from a freshly read committed transaction journal.',
          ),
        ]);
      let current: InstallTargetCapture;
      const identitiesBeforeCapture = await captureTargetAssetIdentities(tx, planned.request);
      try {
        current = await runtime.captureTargetState(planned.request);
      } catch {
        throw new TransactionFailure(EXIT_CODES.SECURITY, [
          diagnostic(
            'E_MIGRATE_TARGET_STATE',
            'error',
            'migration target could not be recaptured safely under the transaction lock',
            'Repair links or concurrent writes before retrying.',
          ),
        ]);
      }
      if (current.digest !== planned.before.digest)
        throw new TransactionFailure(EXIT_CODES.CONTRACT, [
          diagnostic(
            'E_MIGRATE_TARGET_CHANGED',
            'error',
            'migration target changed after preflight',
            'Retry migration from a fresh target snapshot.',
          ),
        ]);
      const identitiesAfterCapture = await captureTargetAssetIdentities(tx, planned.request);
      if (!sameTargetAssetIdentities(identitiesBeforeCapture, identitiesAfterCapture))
        throw targetIdentityFailure();
      const assets = await captureScratchBaseAssets(
        tx,
        input.dshHome,
        scratch,
        profileAction,
        identitiesAfterCapture,
      );
      const identitiesAfterBaseCapture = await captureTargetAssetIdentities(tx, planned.request);
      if (!sameTargetAssetIdentities(identitiesAfterCapture, identitiesAfterBaseCapture))
        throw targetIdentityFailure();
      const allocation = await nextGeneration(tx, input.dshHome, input.profile);
      await storeCapturedAssets(tx, input.dshHome, assets);
      await runInstallFault(runtime, 'store');
      const installedAt = runtime.now();
      const metadata: InstalledMetadataV1 = {
        ...initial.marker,
        metadataVersion: 1,
        assets: assets.map(({ asset }) => asset),
        settingsContribution: planned.contribution,
        generation: allocation.sequence,
        installedBy: GENERATED_BY,
      };
      const generation = generationDocument(
        allocation.sequence,
        txid,
        installedAt,
        {
          operation: 'install',
          pack: initial.marker.pack,
          source: initial.marker.source,
          metadata,
        },
        assets,
        planned.contribution,
      );
      await writeGeneration(tx, input.dshHome, input.profile, generation);
      await runInstallFault(runtime, 'generation');
      await advanceCurrent(tx, allocation.currentPath, allocation.previous, allocation.sequence);
      await runInstallFault(runtime, 'current');
      await tx.writeManagedDocument(markerPath, `${JSON.stringify(metadata)}\n`, initial.text);
      await runInstallFault(runtime, 'metadata');
      return allocation.sequence;
    },
  );
  if (!transaction.ok) {
    const result = report(
      transaction.exitCode,
      [...planned.diagnostics, ...transaction.diagnostics],
      transaction.status,
      input.profile,
      {
        backupDirectory: transaction.backupDirectory,
        journalPath: transaction.journalPath,
        manualRecovery: transaction.manualRecovery,
      },
    );
    const cleanup = await cleanupScratchBase(runtime, input.profile, scratch.dshHome);
    return mergeCleanupReport(result, cleanup);
  }
  const result = report(EXIT_CODES.SUCCESS, planned.diagnostics, 'migrated', input.profile, {
    generation:
      transaction.value ??
      (() => {
        throw new Error('committed migration did not retain its generation sequence');
      })(),
    backupDirectory: transaction.backupDirectory,
  });
  const cleanup = await cleanupScratchBase(runtime, input.profile, scratch.dshHome);
  return mergeCleanupReport(result, cleanup);
}
