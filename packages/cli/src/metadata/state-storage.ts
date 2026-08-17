import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { EXIT_CODES } from '../exit-codes.js';
import { installFailure } from '../install/engine-errors.js';
import { captureSourceDirectory, SnapshotCaptureError } from '../install/snapshot-capture.js';
import { portableSnapshotPathKey } from '../install/snapshot-path.js';
import type { InstallPlan } from '../install/types.js';
import type { TransactionContext } from '../transaction.js';
import type { MetadataAsset, MetadataAssetAction, SettingsContribution } from './contracts.js';

const SHA256_PREFIX = 'sha256-';
const CURRENT = 'current';

/**
 * Runtime dependencies are reproducible from the profile lock, not owned snapshot content.
 * Keep this predicate shared for later restore consumers; every other profile entry remains
 * subject to the secure source-capture checks.
 */
export function isManagedProfileInventoryPath(path: string): boolean {
  return portableSnapshotPathKey(path).split('/')[0] !== 'node_modules';
}

export interface StoredGenerationEntry {
  target: string;
  sha256: string;
}

export type GenerationOperation = 'install' | 'update' | 'uninstall' | 'restore';

export interface CapturedInstallAsset {
  asset: MetadataAsset;
  blocks: readonly (StoredGenerationEntry & { bytes: Uint8Array })[];
}

export interface GenerationDocument {
  seq: number;
  txid: string;
  createdAt: string;
  operation: GenerationOperation;
  pack: { name: string; version: string; manifestDigest: string };
  source: Record<string, unknown>;
  entries: readonly StoredGenerationEntry[];
  settingsContribution: SettingsContribution;
  restorable: boolean;
}

export interface GenerationDocumentInput {
  operation: GenerationOperation;
  pack: GenerationDocument['pack'];
  source: GenerationDocument['source'];
}

function sha256(bytes: Uint8Array): string {
  return `${SHA256_PREFIX}${createHash('sha256').update(bytes).digest('base64url')}`;
}

/**
 * Store directories are portable across Windows' case-insensitive filesystem.  The digest file
 * remains its exact SRI spelling; only the two-character sharding directory is canonicalized.
 */
export function casStoreShard(digest: string): string {
  return digest.slice(SHA256_PREFIX.length, SHA256_PREFIX.length + 2).toLowerCase();
}

/** The on-disk shard spelling is part of the portable CAS layout, not a case-insensitive alias. */
export function isCanonicalCasStoreShard(shard: string, digest: string): boolean {
  return shard === casStoreShard(digest);
}

/** A resolved physical shard leaf must retain its portable lower-case spelling. */
export function isExactCasStoreShardLeaf(actual: string, expected: string): boolean {
  return actual === expected;
}

function blockPath(dshHome: string, digest: string): string {
  return join(dshHome, '.dshpack', 'store', casStoreShard(digest), digest);
}

export function generationFilename(sequence: number): string {
  assertPositiveSafeSequence(sequence);
  return `${String(sequence).padStart(4, '0')}.json`;
}

export function assertPositiveSafeSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > Number.MAX_SAFE_INTEGER) {
    throw installFailure(
      EXIT_CODES.CONTRACT,
      'E_GENERATION_SEQUENCE',
      `generation sequence is outside the safe positive range: ${String(sequence)}`,
      'Repair generation state before retrying; no metadata state was changed.',
    );
  }
}

function assertGenerationOperation(operation: unknown): asserts operation is GenerationOperation {
  if (
    operation !== 'install' &&
    operation !== 'update' &&
    operation !== 'uninstall' &&
    operation !== 'restore'
  ) {
    throw installFailure(
      EXIT_CODES.CONTRACT,
      'E_GENERATION_OPERATION',
      'generation operation must be install, update, uninstall, or restore',
      'Supply an explicit generation operation before writing state.',
    );
  }
}

function generationDirectory(dshHome: string, profile: string): string {
  return join(dshHome, '.dshpack', 'generations', profile);
}

function assetSpec(plan: InstallPlan): Array<{
  id: string;
  kind: 'profile' | 'skill' | 'preset';
  target: string;
  action: MetadataAssetAction;
}> {
  return [
    {
      id: plan.targetProfile,
      kind: 'profile',
      target: `profiles/${plan.targetProfile}`,
      action: plan.replaceExistingProfile ? 'replace' : 'create',
    },
    ...plan.skills.map((asset) => ({
      id: asset.id,
      kind: 'skill' as const,
      target: asset.target,
      action: asset.action,
    })),
    ...plan.presets.map((asset) => ({
      id: asset.id,
      kind: 'preset' as const,
      target: asset.target,
      action: asset.action,
    })),
  ];
}

function storageFailure(error: unknown, target: string): never {
  if (error instanceof SnapshotCaptureError) {
    throw installFailure(
      error.kind === 'security' ? EXIT_CODES.SECURITY : EXIT_CODES.CONTRACT,
      error.kind === 'security'
        ? 'E_INSTALL_ASSET_SNAPSHOT_SECURITY'
        : 'E_INSTALL_ASSET_SNAPSHOT_LIMIT',
      `cannot safely capture installed asset: ${target}`,
      'Repair the asset regular-file layout and retry; no generation was written.',
    );
  }
  throw error;
}

/** Capture the actual on-disk install targets, retaining transaction identity and raw file bytes. */
export async function captureInstalledAssets(
  transaction: TransactionContext,
  dshHome: string,
  plan: InstallPlan,
): Promise<readonly CapturedInstallAsset[]> {
  const captured: CapturedInstallAsset[] = [];
  for (const spec of assetSpec(plan)) {
    const target = join(dshHome, ...spec.target.split('/'));
    const before = await transaction.artifactIdentity(spec.kind, target);
    let directory: Awaited<ReturnType<typeof captureSourceDirectory>>;
    try {
      directory = await captureSourceDirectory(
        target,
        spec.kind === 'profile' ? { skipPath: (path) => !isManagedProfileInventoryPath(path) } : {},
      );
    } catch (error) {
      storageFailure(error, spec.target);
    }
    const after = await transaction.artifactIdentity(spec.kind, target);
    if (before !== after) {
      throw installFailure(
        EXIT_CODES.SECURITY,
        'E_INSTALL_ASSET_CHANGED',
        `asset was replaced during snapshot: ${spec.target}`,
        'Stop and inspect concurrent writes or links; no generation was written.',
      );
    }
    if (directory.files.length === 0) {
      throw installFailure(
        EXIT_CODES.CONTRACT,
        'E_INSTALL_ASSET_EMPTY',
        `asset has no snapshotable regular files: ${spec.target}`,
        'Repair the installed asset and retry; no generation was written.',
      );
    }
    let confirmation: Awaited<ReturnType<typeof captureSourceDirectory>>;
    try {
      confirmation = await captureSourceDirectory(
        target,
        spec.kind === 'profile' ? { skipPath: (path) => !isManagedProfileInventoryPath(path) } : {},
      );
    } catch (error) {
      storageFailure(error, spec.target);
    }
    const finalIdentity = await transaction.artifactIdentity(spec.kind, target);
    if (after !== finalIdentity || !sameDirectorySnapshot(directory, confirmation)) {
      throw installFailure(
        EXIT_CODES.SECURITY,
        'E_INSTALL_ASSET_CHANGED',
        `asset changed during snapshot confirmation: ${spec.target}`,
        'Stop and inspect concurrent writes or links; no generation was written.',
      );
    }
    const files = directory.files.map((file) => ({
      path: file.path,
      sha256: sha256(file.bytes),
      bytes: file.bytes.byteLength,
    }));
    captured.push({
      asset: { ...spec, identity: after, files },
      blocks:
        spec.action === 'skip'
          ? []
          : directory.files.map((file) => ({
              target: `${spec.target}/${file.path}`,
              sha256: sha256(file.bytes),
              bytes: file.bytes,
            })),
    });
  }
  return captured;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function sameDirectorySnapshot(
  left: Awaited<ReturnType<typeof captureSourceDirectory>>,
  right: Awaited<ReturnType<typeof captureSourceDirectory>>,
): boolean {
  return (
    left.files.length === right.files.length &&
    left.files.every(
      (file, index) =>
        file.path === right.files[index]?.path && sameBytes(file.bytes, right.files[index].bytes),
    )
  );
}

/** Store every immutable block exactly once; any wrong pre-existing claimed digest is fatal. */
export async function storeCapturedAssets(
  transaction: TransactionContext,
  dshHome: string,
  assets: readonly CapturedInstallAsset[],
): Promise<void> {
  const byDigest = new Map<string, Uint8Array>();
  for (const asset of assets) {
    for (const block of asset.blocks) {
      if (sha256(block.bytes) !== block.sha256) {
        throw installFailure(
          EXIT_CODES.CONTRACT,
          'E_STORE_DIGEST_MISMATCH',
          `captured block digest does not match its bytes: ${block.target}`,
          'Rebuild the install inventory before retrying; no CAS block was written.',
        );
      }
      const previous = byDigest.get(block.sha256);
      if (previous !== undefined && !sameBytes(previous, block.bytes)) {
        throw installFailure(
          EXIT_CODES.CONTRACT,
          'E_STORE_DIGEST_COLLISION',
          'different installed bytes claim the same SHA-256 digest',
          'Stop the install and audit the input; no existing CAS block was overwritten.',
        );
      }
      if (previous === undefined) byDigest.set(block.sha256, block.bytes);
    }
  }
  for (const [digest, expected] of [...byDigest.entries()].sort(([left], [right]) =>
    left.localeCompare(right, 'en'),
  )) {
    const path = blockPath(dshHome, digest);
    let current = await transaction.readStateBytes(path);
    if (current === undefined) {
      const wrote = await transaction.writeStateFile('store-block', path, expected);
      if (wrote) continue;
      current = await transaction.readStateBytes(path);
    }
    if (current === undefined || sha256(current) !== digest || !sameBytes(current, expected)) {
      throw installFailure(
        EXIT_CODES.CONTRACT,
        'E_STORE_DIGEST_COLLISION',
        `existing CAS block bytes do not match their claimed digest: ${digest}`,
        'Stop the install; do not overwrite the block. Audit the store manually first.',
      );
    }
  }
}

export async function nextGeneration(
  transaction: TransactionContext,
  dshHome: string,
  profile: string,
): Promise<{ sequence: number; currentPath: string; previous: string | undefined }> {
  const currentPath = join(generationDirectory(dshHome, profile), CURRENT);
  const previous = await transaction.readGenerationCurrent(currentPath);
  if (previous === undefined) return { sequence: 1, currentPath, previous };
  if (!/^[1-9]\d*\n$/u.test(previous)) {
    throw installFailure(
      EXIT_CODES.CONTRACT,
      'E_GENERATION_CURRENT',
      'generation current pointer must be a positive integer followed by one newline',
      'Repair or migrate generation state and retry; current was not overwritten.',
    );
  }
  const current = Number(previous.slice(0, -1));
  if (!Number.isSafeInteger(current) || current < 1 || current >= Number.MAX_SAFE_INTEGER) {
    throw installFailure(
      EXIT_CODES.CONTRACT,
      'E_GENERATION_CURRENT',
      'generation current pointer is outside the safe sequence range',
      'Repair or migrate generation state and retry; current was not overwritten.',
    );
  }
  const sequence = current + 1;
  assertPositiveSafeSequence(sequence);
  return { sequence, currentPath, previous };
}

export function generationDocument(
  sequence: number,
  txid: string,
  createdAt: string,
  input: GenerationDocumentInput,
  assets: readonly CapturedInstallAsset[],
  settingsContribution: SettingsContribution,
): GenerationDocument {
  assertPositiveSafeSequence(sequence);
  assertGenerationOperation(input.operation);
  const entries = assets
    .flatMap((asset) =>
      asset.blocks.map(({ target, sha256: digest }) => ({ target, sha256: digest })),
    )
    .sort((left, right) => left.target.localeCompare(right.target, 'en'));
  return {
    seq: sequence,
    txid,
    createdAt,
    operation: input.operation,
    pack: input.pack,
    source: input.source,
    entries,
    settingsContribution,
    restorable: true,
  };
}

export async function writeGeneration(
  transaction: TransactionContext,
  dshHome: string,
  profile: string,
  document: GenerationDocument,
): Promise<void> {
  assertPositiveSafeSequence(document.seq);
  const path = join(generationDirectory(dshHome, profile), generationFilename(document.seq));
  const wrote = await transaction.writeStateFile(
    'generation',
    path,
    Buffer.from(`${JSON.stringify(document)}\n`),
  );
  if (!wrote) {
    throw installFailure(
      EXIT_CODES.CONTRACT,
      'E_GENERATION_EXISTS',
      `generation ${String(document.seq)} already exists; refusing to overwrite it`,
      'Inspect current or migrate state, then retry with a new sequence number.',
    );
  }
}

export async function advanceCurrent(
  transaction: TransactionContext,
  currentPath: string,
  previous: string | undefined,
  sequence: number,
): Promise<void> {
  assertPositiveSafeSequence(sequence);
  await transaction.writeGenerationCurrent(currentPath, previous, `${String(sequence)}\n`);
}

function compareCanonicalKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function taggedCanonicalValue(tag: string, body: string): string {
  return `${tag}#${String(body.length)}:${body}`;
}

function canonicalSettingsValue(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return taggedCanonicalValue('null', '');
  switch (typeof value) {
    case 'undefined':
      return taggedCanonicalValue('undefined', '');
    case 'boolean':
      return taggedCanonicalValue('boolean', value ? 'true' : 'false');
    case 'string':
      return taggedCanonicalValue('string', value);
    case 'bigint':
      return taggedCanonicalValue('bigint', value.toString(10));
    case 'number':
      if (Number.isNaN(value)) return taggedCanonicalValue('number', 'NaN');
      if (value === Number.POSITIVE_INFINITY) return taggedCanonicalValue('number', '+Infinity');
      if (value === Number.NEGATIVE_INFINITY) return taggedCanonicalValue('number', '-Infinity');
      if (Object.is(value, -0)) return taggedCanonicalValue('number', '-0');
      return taggedCanonicalValue('number', String(value));
    case 'object':
      if (ancestors.has(value)) throw new TypeError('settings contribution value contains a cycle');
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          const body = [
            taggedCanonicalValue('length', String(value.length)),
            ...Object.keys(value)
              .sort(compareCanonicalKeys)
              .flatMap((key) => [
                taggedCanonicalValue('key', key),
                canonicalSettingsValue(
                  (value as unknown as Record<string, unknown>)[key],
                  ancestors,
                ),
              ]),
          ].join('');
          return taggedCanonicalValue('array', body);
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError('settings contribution value must be a plain object');
        }
        const body = Object.keys(value)
          .sort(compareCanonicalKeys)
          .flatMap((key) => [
            taggedCanonicalValue('key', key),
            canonicalSettingsValue((value as Record<string, unknown>)[key], ancestors),
          ])
          .join('');
        return taggedCanonicalValue('object', body);
      } finally {
        ancestors.delete(value);
      }
    default:
      throw new TypeError(`settings contribution cannot encode ${typeof value}`);
  }
}

/** Hash values canonically so YAML key order cannot falsely look like a user modification. */
export function settingsContribution(
  section: Readonly<Record<string, unknown>>,
): SettingsContribution {
  return {
    namespace: 'agent-presets',
    keys: Object.entries(section)
      .sort(([left], [right]) => compareCanonicalKeys(left, right))
      .map(([key, value]) => ({
        key,
        valueSha256: sha256(Buffer.from(canonicalSettingsValue(value))),
      })),
  };
}
