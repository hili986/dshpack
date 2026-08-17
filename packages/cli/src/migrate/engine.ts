import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  try {
    await materialized.cleanup();
  } catch {
    return {
      report: report(
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
      ),
    };
  }
  if (read.material === undefined)
    return {
      report: report(read.exitCode, read.diagnostics, 'not-started', profile),
    };
  if (!sourceMatchesLegacy(legacy, materialized.provenance, read.material))
    return {
      report: report(
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
    };
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

function sourceBaseMatchesLegacy(
  legacy: InstalledMetadataV0,
  marker: InstalledMetadataV1,
): boolean {
  return (
    isDeepStrictEqual(marker.source, legacy.source) &&
    isDeepStrictEqual(marker.pack, legacy.pack) &&
    isDeepStrictEqual(marker.effectiveLock, legacy.effectiveLock) &&
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
  return { report: cleanup ?? failure };
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
      createNodeInstallRuntime(scratch, { now: () => legacy.installedAt }),
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
    if (rebuilt.exitCode !== EXIT_CODES.SUCCESS || rebuilt.metadata.plan === undefined)
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
    const markerPath = join(scratch, '.dshpack', 'installed', `${profile}.json`);
    const parsed = parseInstalledMetadata(JSON.parse(await readFile(markerPath, 'utf8')), profile);
    if (!parsed.ok || parsed.metadata.metadataVersion !== 1)
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
              'isolated reconstruction did not produce valid v1 metadata',
              'Reinstall the profile to establish a new v1 base.',
            ),
          ],
          'not-started',
          profile,
        ),
      );
    if (!sourceBaseMatchesLegacy(legacy, parsed.metadata))
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
    return { dshHome: scratch, marker: parsed.metadata, plan: rebuilt.metadata.plan };
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
 * v0 did not persist ownership for skill/preset assets.  The profile action is recoverable only
 * when its original transaction journal still proves the same operation; otherwise the v1
 * marker deliberately records `skip` so a later destructive command cannot guess ownership.
 */
async function legacyProfileOwnership(
  dshHome: string,
  profile: string,
  legacy: InstalledMetadataV0,
): Promise<MetadataAssetAction> {
  const root = await bindSecureRoot(dshHome);
  if (!root.ok) return 'skip';
  const backup = await bindDirectory(root.value, ['.dshpack', 'backups', legacy.txid]);
  if (!backup.ok) return 'skip';
  const journal = await readText(backup.value, ['journal.json']);
  if (!journal.ok) return 'skip';
  let parsed: unknown;
  try {
    parsed = JSON.parse(journal.value.text);
  } catch {
    return 'skip';
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { actions?: unknown }).actions)
  )
    return 'skip';
  const expectedPath = join(dshHome, 'profiles', profile);
  for (const action of (parsed as { actions: unknown[] }).actions) {
    if (typeof action !== 'object' || action === null) continue;
    const record = action as {
      kind?: unknown;
      artifact?: unknown;
      ownership?: unknown;
      old?: { path?: unknown };
    };
    if (record.artifact !== 'profile' || record.old?.path !== expectedPath) continue;
    if (record.kind === 'create' && record.ownership === 'owned') return 'create';
    if (record.kind === 'replace') return 'replace';
  }
  return 'skip';
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
  const profileAction = await legacyProfileOwnership(input.dshHome, input.profile, initial.marker);
  const planned = await preflightMigration(input, runtime, original.material, original.diagnostics);
  if ('report' in planned) {
    const cleanup = await cleanupScratchBase(runtime, input.profile, scratch.dshHome);
    return cleanup ?? planned.report;
  }
  if (input.dryRun) {
    const cleanup = await cleanupScratchBase(runtime, input.profile, scratch.dshHome);
    return cleanup ?? report(EXIT_CODES.SUCCESS, planned.diagnostics, 'planned', input.profile);
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
      let current: InstallTargetCapture;
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
      const assets = await captureScratchBaseAssets(tx, input.dshHome, scratch, profileAction);
      const allocation = await nextGeneration(tx, input.dshHome, input.profile);
      await storeCapturedAssets(tx, input.dshHome, assets);
      await runInstallFault(runtime, 'store');
      const installedAt = runtime.now();
      const generation = generationDocument(
        allocation.sequence,
        txid,
        installedAt,
        {
          operation: 'install',
          pack: initial.marker.pack,
          source: initial.marker.source,
        },
        assets,
        planned.contribution,
      );
      await writeGeneration(tx, input.dshHome, input.profile, generation);
      await runInstallFault(runtime, 'generation');
      await advanceCurrent(tx, allocation.currentPath, allocation.previous, allocation.sequence);
      await runInstallFault(runtime, 'current');
      const metadata: InstalledMetadataV1 = {
        ...initial.marker,
        metadataVersion: 1,
        assets: assets.map(({ asset }) => asset),
        settingsContribution: planned.contribution,
        generation: allocation.sequence,
        installedBy: GENERATED_BY,
      };
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
    return cleanup ?? result;
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
  return cleanup ?? result;
}
