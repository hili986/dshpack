import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Diagnostic } from '@dshpack/core';
import { isMap, isNode, parseDocument, stringify } from 'yaml';

import { type CommandReport, diagnostic, resolveDshHomeValue } from '../commands/shared.js';
import { type DoctorInput, type DoctorMetadata, runDoctor } from '../doctor/engine.js';
import { EXIT_CODES, type ExitCode } from '../exit-codes.js';
import { captureSourceDirectory, SnapshotCaptureError } from '../install/snapshot-capture.js';
import {
  bindDirectory,
  bindSecureRoot,
  type DirectoryBinding,
  readDirectory,
  readText,
  revalidateDirectoryEntries,
  type SafePathFailure,
} from '../list/safe-fs.js';
import { attributableToInstall } from '../management/attribution.js';
import {
  listGenerations,
  ManagementStateError,
  readCasBlock,
  readGenerationCurrent,
} from '../management/state.js';
import {
  type AssetDrift,
  countMetadataAssetTargetReferences,
  type InstalledMetadata,
  type InstalledMetadataV1,
  isInstallableProfileName,
  type MetadataAsset,
  type ObservedAsset,
  parseInstalledMetadata,
  portableTargetKey,
} from '../metadata/contracts.js';
import {
  advanceCurrent,
  decodeCanonicalSettingsValue,
  type GenerationDocument,
  isManagedProfileInventoryPath,
  nextGeneration,
  writeGeneration,
} from '../metadata/state-storage.js';
import { terminalSafeText } from '../terminal-safe.js';
import {
  createNodeTransactionAdapter,
  runTransaction,
  type TransactionAdapter,
  type TransactionContext,
  TransactionFailure,
} from '../transaction.js';
import { MAX_TRANSACTION_STATE_BYTES } from '../transaction-types.js';
import { prepareInverseSettings } from '../uninstall/engine.js';

export interface RestoreInput {
  readonly dshHome: string;
  readonly profile: string;
  readonly to?: number;
  readonly list?: boolean;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly yes?: boolean;
}

export interface RestoreGenerationSummary {
  readonly seq: number;
  readonly createdAt: string;
  readonly operation: GenerationDocument['operation'];
  readonly packVersion: string;
  readonly restorable: boolean;
}

export interface RestoreAssetOutcome {
  readonly target: string;
  readonly action: 'materialize' | 'remove' | 'retain' | 'unchanged';
  readonly reason:
    | 'target-generation'
    | 'target-absent'
    | 'modified'
    | 'missing'
    | 'untracked'
    | 'shared-target'
    | 'legacy-profile-reference';
}

export interface RestoreMetadata {
  readonly profile: string;
  readonly dryRun: boolean;
  readonly targetGeneration?: number;
  readonly generations: readonly RestoreGenerationSummary[];
  readonly assets: readonly RestoreAssetOutcome[];
  readonly retainedSettings: readonly string[];
  readonly generation?: number;
  /** Every immutable target block that was absent during CAS preflight. */
  readonly missingCasBlocks?: readonly string[];
  readonly backupDirectory?: string;
  readonly manualRecovery: readonly unknown[];
}

export interface RestoreDependencies {
  readonly createAdapter?: () => TransactionAdapter;
  readonly createTxid?: () => string;
  readonly now?: () => string;
  /** Runtime seam for the strict, transaction-bound post-restore doctor check. */
  readonly runDoctor?: (input: DoctorInput) => Promise<CommandReport<DoctorMetadata>>;
}

export interface MarkerRecord {
  readonly metadata: InstalledMetadataV1;
  readonly document: string;
  readonly identity: string;
}

export interface RestorePlan {
  readonly home: DirectoryBinding;
  readonly target: GenerationDocument;
  readonly targetGeneration: number;
  readonly current: MarkerRecord | undefined;
  readonly entries: ReadonlyMap<string, Buffer>;
  /** Identities observed during the locked-plan preflight for replacement backup safety. */
  readonly observedIdentities: ReadonlyMap<string, string>;
  readonly assets: readonly RestoreAssetOutcome[];
  readonly settings:
    | {
        readonly expected: string | undefined;
        readonly replacement: string | undefined;
        readonly retained: readonly string[];
      }
    | undefined;
}

class RestoreError extends Error {
  constructor(
    readonly exitCode: ExitCode,
    readonly code: string,
    message: string,
    readonly hint: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'RestoreError';
  }
}

class RestoreCasPreflightError extends RestoreError {
  constructor(readonly missingBlocks: readonly string[]) {
    super(
      EXIT_CODES.CONTRACT,
      'E_RESTORE_CAS',
      'the requested generation is missing immutable CAS blocks.',
      'Repair or regenerate every listed CAS block before retrying; no restore mutation was started.',
    );
    this.name = 'RestoreCasPreflightError';
  }
}

function fail(
  exitCode: ExitCode,
  code: string,
  message: string,
  hint: string,
  path?: string,
): never {
  throw new RestoreError(exitCode, code, message, hint, path);
}

function fromSafeFailure(
  failure: SafePathFailure,
  code: string,
  message: string,
  path: string,
): never {
  fail(
    failure.kind === 'security' || failure.kind === 'changed'
      ? EXIT_CODES.SECURITY
      : EXIT_CODES.CONTRACT,
    code,
    message,
    'Repair the managed state and retry; no restore mutation was started.',
    path,
  );
}

function targetPath(dshHome: string, target: string): string {
  return join(dshHome, ...target.split('/'));
}

function summaries(
  generations: readonly GenerationDocument[],
): readonly RestoreGenerationSummary[] {
  return generations.map((generation) => ({
    seq: generation.seq,
    createdAt: generation.createdAt,
    operation: generation.operation,
    packVersion: generation.pack.version,
    restorable: generation.restorable,
  }));
}

function metadata(input: RestoreInput, extra: Partial<RestoreMetadata> = {}): RestoreMetadata {
  return {
    profile: input.profile,
    dryRun: input.dryRun === true,
    generations: [],
    assets: [],
    retainedSettings: [],
    manualRecovery: [],
    ...extra,
  };
}

function diagnosticFor(error: RestoreError | ManagementStateError) {
  if (error instanceof ManagementStateError) return error.diagnostic;
  return diagnostic(error.code, 'error', error.message, error.hint, error.path);
}

export function exitCodeForManagementState(error: ManagementStateError): ExitCode {
  if (error.kind === 'security' || error.kind === 'changed') return EXIT_CODES.SECURITY;
  if (error.kind === 'environment') return EXIT_CODES.INTERNAL;
  return EXIT_CODES.CONTRACT;
}

export async function readMarker(
  dshHome: string,
  profile: string,
): Promise<{ home: DirectoryBinding; marker?: MarkerRecord }> {
  const home = await bindSecureRoot(dshHome);
  if (!home.ok)
    fromSafeFailure(home, 'E_RESTORE_METADATA', 'managed home cannot be read securely.', dshHome);
  const path = join(dshHome, '.dshpack', 'installed', `${profile}.json`);
  const document = await readText(
    home.value,
    ['.dshpack', 'installed', `${profile}.json`],
    {},
    MAX_TRANSACTION_STATE_BYTES,
  );
  if (!document.ok) {
    if (document.kind === 'missing') return { home: home.value };
    fromSafeFailure(
      document,
      'E_RESTORE_METADATA',
      'installed metadata cannot be read securely.',
      path,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(document.value.text);
  } catch {
    fail(
      EXIT_CODES.CONTRACT,
      'E_RESTORE_METADATA',
      'installed metadata is not valid JSON.',
      'Repair or migrate the managed profile before restoring it.',
      path,
    );
  }
  const parsed = parseInstalledMetadata(value, profile);
  if (!parsed.ok || parsed.metadata.metadataVersion !== 1)
    fail(
      EXIT_CODES.CONTRACT,
      'E_RESTORE_METADATA',
      'installed metadata is not a complete v1 record for this profile.',
      'Run dshpack migrate before restoring this tracked profile.',
      path,
    );
  return {
    home: home.value,
    marker: {
      metadata: parsed.metadata,
      document: document.value.text,
      identity: document.value.identity,
    },
  };
}

/**
 * Restore can replace or remove historical paths, so peer installed markers are part of its
 * ownership proof. A v0 peer has no asset inventory and therefore blocks every destructive
 * action conservatively; `--force` deliberately cannot override another profile's claim.
 */
async function sharedTargetOwnership(
  dshHome: string,
  home: DirectoryBinding,
  profile: string,
): Promise<ReturnType<typeof countMetadataAssetTargetReferences>> {
  const entries = await readDirectory(home, ['.dshpack', 'installed']);
  if (!entries.ok) {
    if (entries.kind === 'missing') return countMetadataAssetTargetReferences([]);
    fromSafeFailure(
      entries,
      'E_RESTORE_METADATA',
      'installed metadata cannot be read securely.',
      join(dshHome, '.dshpack', 'installed'),
    );
  }
  const peers: InstalledMetadata[] = [];
  for (const entry of entries.value) {
    const path = join(dshHome, '.dshpack', 'installed', entry.name);
    if (!entry.isFile() || entry.isSymbolicLink())
      fail(
        EXIT_CODES.SECURITY,
        'E_RESTORE_METADATA',
        'installed metadata contains a non-regular entry.',
        'Repair the managed metadata directory and retry.',
        path,
      );
    if (!entry.name.endsWith('.json'))
      fail(
        EXIT_CODES.CONTRACT,
        'E_RESTORE_METADATA',
        'installed metadata contains a non-marker file.',
        'Repair the managed metadata directory and retry.',
        path,
      );
    const peerProfile = entry.name.slice(0, -'.json'.length);
    if (!isInstallableProfileName(peerProfile))
      fail(
        EXIT_CODES.CONTRACT,
        'E_RESTORE_METADATA',
        'installed metadata has an unsafe profile filename.',
        'Repair the managed metadata directory and retry.',
        path,
      );
    if (peerProfile === profile) continue;
    const source = await readText(
      home,
      ['.dshpack', 'installed', entry.name],
      {},
      MAX_TRANSACTION_STATE_BYTES,
    );
    if (!source.ok)
      fromSafeFailure(
        source,
        'E_RESTORE_METADATA',
        'installed metadata cannot be read securely.',
        path,
      );
    let parsed: ReturnType<typeof parseInstalledMetadata>;
    try {
      parsed = parseInstalledMetadata(JSON.parse(source.value.text), peerProfile);
    } catch {
      fail(
        EXIT_CODES.CONTRACT,
        'E_RESTORE_METADATA',
        'installed metadata is not valid JSON.',
        'Repair or migrate the managed profile before restoring it.',
        path,
      );
    }
    if (!parsed.ok)
      fail(
        EXIT_CODES.CONTRACT,
        'E_RESTORE_METADATA',
        'installed metadata does not satisfy its versioned contract.',
        'Repair or migrate the managed profile before restoring it.',
        path,
      );
    peers.push(parsed.metadata);
  }
  const installed = await bindDirectory(home, ['.dshpack', 'installed']);
  if (!installed.ok)
    fromSafeFailure(
      installed,
      'E_RESTORE_METADATA',
      'installed metadata directory cannot be rebound securely.',
      join(dshHome, '.dshpack', 'installed'),
    );
  const stable = await revalidateDirectoryEntries(installed.value, entries.value);
  if (!stable.ok)
    fromSafeFailure(
      stable,
      'E_RESTORE_METADATA',
      'installed metadata changed during the scan.',
      join(dshHome, '.dshpack', 'installed'),
    );
  return countMetadataAssetTargetReferences(peers);
}

export async function observeAsset(
  dshHome: string,
  asset: MetadataAsset,
): Promise<ObservedAsset | undefined> {
  const path = targetPath(dshHome, asset.target);
  try {
    const before = await lstat(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink())
      fail(
        EXIT_CODES.SECURITY,
        'E_RESTORE_ASSET_PATH',
        'managed asset is no longer a regular directory.',
        'Inspect the asset path before retrying.',
        path,
      );
    const captured = await captureSourceDirectory(
      path,
      asset.kind === 'profile'
        ? { skipPath: (entry) => !isManagedProfileInventoryPath(entry) }
        : {},
    );
    const after = await lstat(path, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.birthtimeNs !== after.birthtimeNs
    )
      fail(
        EXIT_CODES.SECURITY,
        'E_RESTORE_ASSET_CHANGED',
        'managed asset changed during restore preflight.',
        'Retry after concurrent writes have stopped.',
        path,
      );
    return {
      identity: `${after.dev}:${after.ino}:${after.birthtimeNs}`,
      files: captured.files.map((file) => ({
        path: file.path,
        sha256: `sha256-${createHash('sha256').update(file.bytes).digest('base64url')}`,
        bytes: file.bytes.byteLength,
      })),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return undefined;
    if (error instanceof RestoreError) throw error;
    if (error instanceof SnapshotCaptureError)
      fail(
        error.kind === 'security' ? EXIT_CODES.SECURITY : EXIT_CODES.CONTRACT,
        'E_RESTORE_ASSET_PATH',
        'managed asset cannot be inspected safely.',
        'Inspect links and special files before retrying.',
        path,
      );
    throw error;
  }
}

function supported(
  asset: MetadataAsset,
): asset is MetadataAsset & { kind: 'profile' | 'skill' | 'preset' } {
  return asset.kind === 'profile' || asset.kind === 'skill' || asset.kind === 'preset';
}

/** A restored directory necessarily receives a fresh filesystem identity, so restore drift is content-based. */
export function restoreDrift(
  expected: MetadataAsset,
  observed: ObservedAsset | undefined,
): AssetDrift {
  if (observed === undefined) return 'missing';
  if (expected.files.length !== observed.files.length) return 'modified';
  const actual = new Map(observed.files.map((file) => [file.path, file]));
  return expected.files.every((file) => {
    const candidate = actual.get(file.path);
    return candidate?.sha256 === file.sha256 && candidate.bytes === file.bytes;
  })
    ? 'intact'
    : 'modified';
}

function assetEntries(
  generation: GenerationDocument,
  asset: MetadataAsset,
): readonly { target: string; sha256: string }[] {
  const prefix = `${asset.target}/`;
  return generation.entries.filter((entry) => entry.target.startsWith(prefix));
}

export function targetAssets(generation: GenerationDocument): readonly MetadataAsset[] {
  if (generation.metadata === null) {
    if (generation.entries.length !== 0)
      fail(
        EXIT_CODES.CONTRACT,
        'E_RESTORE_GENERATION',
        'an uninstalled generation cannot contain materialized entries.',
        'Repair the generation history before retrying.',
      );
    return [];
  }
  const assets = generation.metadata.assets.filter(
    (asset) => asset.action !== 'skip' && supported(asset),
  );
  for (const entry of generation.entries) {
    if (!assets.some((asset) => entry.target.startsWith(`${asset.target}/`)))
      fail(
        EXIT_CODES.CONTRACT,
        'E_RESTORE_GENERATION',
        'generation entry is not attributable to its effective metadata.',
        'Repair the generation history before retrying.',
      );
  }
  for (const asset of assets) {
    const expected = new Map<string, MetadataAsset['files'][number]>(
      asset.files.map((file) => [`${asset.target}/${file.path}`, file] as const),
    );
    const actual = assetEntries(generation, asset);
    if (actual.length !== expected.size)
      fail(
        EXIT_CODES.CONTRACT,
        'E_RESTORE_GENERATION',
        'generation immutable entries do not exactly match the effective metadata files.',
        'Repair the generation history before retrying.',
      );
    for (const entry of actual) {
      const file = expected.get(entry.target);
      if (file === undefined || file.sha256 !== entry.sha256)
        fail(
          EXIT_CODES.CONTRACT,
          'E_RESTORE_GENERATION',
          'generation immutable entries do not exactly match the effective metadata files.',
          'Repair the generation history before retrying.',
        );
    }
  }
  return assets;
}

function settingsEol(source: string): '\n' | '\r\n' {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

function settingsPair(key: string, value: unknown, eol: string): string {
  return `${stringify({ [key]: value }, { lineWidth: 0 })
    .trimEnd()
    .split('\n')
    .map((line) => `  ${line}`)
    .join(eol)}${eol}`;
}

/**
 * Add only previously absent pack-owned keys. This deliberately declines to rewrite any existing
 * key because its surrounding comments and spelling are user-owned bytes; a later explicit
 * update can resolve that semantic conflict without normalizing the whole settings document.
 */
export function appendRestoredSettings(
  source: string | undefined,
  values: readonly { key: string; value: unknown }[],
): {
  readonly expected: string | undefined;
  readonly replacement: string | undefined;
  readonly retained: readonly string[];
} {
  if (values.length === 0) return { expected: source, replacement: undefined, retained: [] };
  if (source === undefined) {
    const eol = '\n';
    return {
      expected: undefined,
      replacement: `agent-presets:${eol}${values.map((entry) => settingsPair(entry.key, entry.value, eol)).join('')}`,
      retained: [],
    };
  }
  const document = parseDocument(source, { prettyErrors: true });
  if (document.errors.length > 0)
    fail(
      EXIT_CODES.CONTRACT,
      'E_RESTORE_SETTINGS',
      'settings.yaml is not valid YAML.',
      'Repair settings.yaml before restoring its recorded contribution.',
    );
  const root = document.toJS();
  const rootRecord =
    typeof root === 'object' && root !== null && !Array.isArray(root)
      ? (root as Record<string, unknown>)
      : undefined;
  const hasNamespace = rootRecord !== undefined && Object.hasOwn(rootRecord, 'agent-presets');
  const section = rootRecord?.['agent-presets'];
  const node = document.get('agent-presets', true);
  const existing =
    typeof section === 'object' && section !== null && !Array.isArray(section)
      ? (section as Record<string, unknown>)
      : undefined;
  const retained = values.filter(
    (entry) => existing !== undefined && Object.hasOwn(existing, entry.key),
  );
  const additions = values.filter((entry) => !retained.includes(entry));
  if (additions.length === 0) {
    return { expected: source, replacement: undefined, retained: retained.map(({ key }) => key) };
  }
  const eol = settingsEol(source);
  const appended = additions.map((entry) => settingsPair(entry.key, entry.value, eol)).join('');
  const nodeRange = isNode(node) ? node.range : undefined;
  if (
    isMap(node) &&
    node.flow &&
    node.items.length === 0 &&
    nodeRange !== undefined &&
    nodeRange !== null
  ) {
    const lineStart = source.lastIndexOf('\n', nodeRange[0] - 1) + 1;
    const lineEnd = source.indexOf('\n', nodeRange[2]);
    const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);
    // An empty flow map is the canonical uninstall result. It has no user-owned
    // pair to retain, so only a comment-free token may become the block map
    // needed to add a restored key.
    if (node.comment === undefined && node.commentBefore === undefined && !line.includes('#')) {
      const before = source.slice(0, nodeRange[0]).replace(/[\t ]*$/u, '');
      const after = source.slice(nodeRange[2]);
      return {
        expected: source,
        replacement: `${before}${eol}${appended}${after.startsWith(eol) ? after.slice(eol.length) : after}`,
        retained: retained.map(({ key }) => key),
      };
    }
  }
  if (existing !== undefined && (!isMap(node) || node.flow)) {
    return {
      expected: source,
      replacement: undefined,
      retained: values.map(({ key }) => key),
    };
  }
  if (existing !== undefined) {
    // `node.range[2]` ends precisely before the next root mapping pair. Appending at EOF would
    // make the new indented key belong to that later namespace, so insert at this CST boundary
    // and leave all following root-owned bytes untouched.
    if (isMap(node) && !node.flow && nodeRange !== undefined && nodeRange !== null) {
      const boundary = nodeRange[2];
      const before = source.slice(0, boundary);
      const separator = before.endsWith('\n') || before.endsWith('\r') ? '' : eol;
      return {
        expected: source,
        replacement: `${before}${separator}${appended}${source.slice(boundary)}`,
        retained: retained.map(({ key }) => key),
      };
    }
    const prefix = source.endsWith('\n') ? '' : eol;
    return {
      expected: source,
      replacement: `${source}${prefix}${appended}`,
      retained: retained.map(({ key }) => key),
    };
  }
  if (hasNamespace && section === null) {
    if (nodeRange !== undefined && nodeRange !== null) {
      const before = source.slice(0, nodeRange[0]);
      const after = source.slice(nodeRange[2]);
      return {
        expected: source,
        replacement: `${before}${eol}${appended}${after.startsWith(eol) ? after.slice(eol.length) : after}`,
        retained: retained.map(({ key }) => key),
      };
    }
    const prefix = source.endsWith('\n') ? '' : eol;
    return {
      expected: source,
      replacement: `${source}${prefix}${appended}`,
      retained: retained.map(({ key }) => key),
    };
  }
  if (hasNamespace) {
    return {
      expected: source,
      replacement: undefined,
      retained: values.map(({ key }) => key),
    };
  }
  // `agent-presets:` with no value is parsed as null. It is nevertheless an
  // existing, user-owned section header, so populate that header instead of
  // introducing a duplicate top-level key.
  if (node !== undefined) {
    const prefix = source.endsWith('\n') ? '' : eol;
    return {
      expected: source,
      replacement: `${source}${prefix}${appended}`,
      retained: retained.map(({ key }) => key),
    };
  }
  const prefix = source === '' || source.endsWith('\n') ? '' : eol;
  return {
    expected: source,
    replacement: `${source}${prefix}agent-presets:${eol}${appended}`,
    retained: retained.map(({ key }) => key),
  };
}

async function settingsPlan(
  dshHome: string,
  home: DirectoryBinding,
  target: GenerationDocument,
  current: MarkerRecord | undefined,
  force: boolean,
): Promise<RestorePlan['settings']> {
  if (target.metadata === null) {
    if (current === undefined) return undefined;
    const inverse = await prepareInverseSettings(dshHome, home, current.metadata, false, force);
    return {
      expected: inverse.expected,
      replacement: inverse.replacement,
      retained: inverse.retained,
    };
  }
  const inverse =
    current !== undefined && current.metadata.settingsContribution.keys.length > 0
      ? await prepareInverseSettings(dshHome, home, current.metadata, false, force)
      : undefined;
  let source = inverse?.replacement ?? inverse?.expected;
  if (inverse === undefined) {
    const currentText = await readText(home, ['settings.yaml']);
    if (!currentText.ok && currentText.kind !== 'missing')
      fromSafeFailure(
        currentText,
        'E_RESTORE_SETTINGS',
        'settings.yaml cannot be read securely.',
        join(dshHome, 'settings.yaml'),
      );
    source = currentText.ok ? currentText.value.text : undefined;
  }
  const targetValues = target.settingsContribution.keys.map(({ key, canonicalValue }) => ({
    key,
    value: decodeCanonicalSettingsValue(canonicalValue),
  }));
  // A missing current contribution is a user deletion, not a free slot to repopulate. When the
  // whole settings document is absent, retain the entire target contribution by default: creating
  // only newly introduced keys would still silently recreate the document the user removed.
  const retained = new Set(force ? [] : (inverse?.retained ?? []));
  if (!force && inverse !== undefined && source === undefined)
    for (const { key } of targetValues) retained.add(key);
  const values = targetValues.filter(({ key }) => !retained.has(key));
  if (values.length === 0) {
    if (inverse === undefined) return undefined;
    return {
      expected: inverse.expected,
      replacement: inverse.replacement,
      retained: [...retained],
    };
  }
  const merged = appendRestoredSettings(source, values);
  if (inverse === undefined) return merged;
  return {
    expected: inverse.expected,
    replacement: merged.replacement ?? inverse.replacement,
    retained: [...new Set([...retained, ...merged.retained])],
  };
}

/**
 * Read every immutable block before a transaction begins so an incomplete target never starts
 * moving user files.  Missing blocks are accumulated rather than reported one-at-a-time.
 */
async function preflightTargetEntries(
  dshHome: string,
  target: GenerationDocument,
  assets: readonly MetadataAsset[],
): Promise<ReadonlyMap<string, Buffer>> {
  const blocks = new Map<string, Buffer>();
  const missing = new Set<string>();
  for (const digest of new Set(target.entries.map((entry) => entry.sha256))) {
    try {
      blocks.set(digest, await readCasBlock(dshHome, digest));
    } catch (error) {
      if (error instanceof ManagementStateError && error.kind === 'missing') {
        missing.add(digest);
        continue;
      }
      throw error;
    }
  }
  if (missing.size > 0) throw new RestoreCasPreflightError([...missing].sort());
  const expected = new Map<string, MetadataAsset['files'][number]>(
    assets.flatMap((asset) =>
      asset.files.map((file) => [`${asset.target}/${file.path}`, file] as const),
    ),
  );
  const entries = new Map<string, Buffer>();
  for (const entry of target.entries) {
    const block = blocks.get(entry.sha256);
    if (block === undefined) throw new Error('CAS preflight lost a validated immutable block');
    const file = expected.get(entry.target);
    if (file === undefined || block.byteLength !== file.bytes)
      fail(
        EXIT_CODES.CONTRACT,
        'E_RESTORE_GENERATION',
        'generation CAS bytes do not match the effective metadata files.',
        'Repair the generation history before retrying.',
        entry.target,
      );
    entries.set(entry.target, block);
  }
  return entries;
}

/** The marker is the materialized current state; it must agree exactly with `current`. */
function assertCurrentState(
  generations: readonly GenerationDocument[],
  currentSequence: number,
  marker: MarkerRecord | undefined,
): void {
  const current = generations.find((generation) => generation.seq === currentSequence);
  if (current === undefined)
    fail(
      EXIT_CODES.CONTRACT,
      'E_RESTORE_CURRENT',
      'generation current does not point to a retained generation document.',
      'Repair the generation current pointer before retrying.',
    );
  if (current.metadata === null) {
    if (marker === undefined) return;
    fail(
      EXIT_CODES.CONTRACT,
      'E_RESTORE_CURRENT',
      'an uninstalled current generation must not have an installed marker.',
      'Repair the installed marker or generation current pointer before retrying.',
    );
  }
  if (
    marker === undefined ||
    marker.metadata.generation !== currentSequence ||
    !isDeepStrictEqual(marker.metadata, current.metadata)
  )
    fail(
      EXIT_CODES.CONTRACT,
      'E_RESTORE_CURRENT',
      'installed marker does not exactly describe the current generation.',
      'Repair the installed marker or generation current pointer before retrying.',
    );
}

async function preparePlan(input: RestoreInput): Promise<RestorePlan> {
  const listed = await listGenerations(input.dshHome, input.profile);
  const currentSequence = await readGenerationCurrent(input.dshHome, input.profile);
  const targetGeneration = input.to ?? currentSequence - 1;
  if (!Number.isSafeInteger(targetGeneration) || targetGeneration < 1)
    fail(
      EXIT_CODES.CONTRACT,
      'E_RESTORE_TARGET',
      'restore requires a previous positive generation when --to is omitted.',
      'Pass --to <seq> for a retained generation.',
    );
  const target = listed.find((generation) => generation.seq === targetGeneration);
  if (target === undefined)
    fail(
      EXIT_CODES.CONTRACT,
      'E_RESTORE_TARGET',
      'requested generation is not retained for this profile.',
      'Use --list to inspect available generation sequences.',
    );
  const { home, marker } = await readMarker(input.dshHome, input.profile);
  assertCurrentState(listed, currentSequence, marker);
  const desired = targetAssets(target);
  const entries = await preflightTargetEntries(input.dshHome, target, desired);
  if (!target.restorable)
    fail(
      EXIT_CODES.CONTRACT,
      'E_RESTORE_NOT_RESTORABLE',
      'requested generation is marked non-restorable.',
      'Run dshpack gc diagnostics and repair missing CAS blocks before restoring.',
    );
  const peerOwnership = await sharedTargetOwnership(input.dshHome, home, input.profile);
  const currentAssets = marker?.metadata.assets.filter(supported) ?? [];
  const outcomes: RestoreAssetOutcome[] = [];
  const observedIdentities = new Map<string, string>();
  for (const asset of new Map(
    [...currentAssets, ...desired].map((item) => [item.target, item]),
  ).values()) {
    const currentAsset = currentAssets.find((item) => item.target === asset.target);
    const desiredAsset = desired.find((item) => item.target === asset.target);
    const observedAsset = currentAsset ?? desiredAsset;
    const observed =
      observedAsset === undefined ? undefined : await observeAsset(input.dshHome, observedAsset);
    if (observed !== undefined) observedIdentities.set(asset.target, observed.identity);
    // Peer markers protect only an existing path that restore would replace or remove. They
    // cannot establish ownership of an absent target, so do not let an unrelated legacy marker
    // prevent a clean historical materialization into an empty location.
    if (observed !== undefined && peerOwnership.legacyProfiles.length > 0) {
      outcomes.push({
        target: asset.target,
        action: 'retain',
        reason: 'legacy-profile-reference',
      });
      continue;
    }
    if (
      observed !== undefined &&
      (peerOwnership.counts.get(portableTargetKey(asset.target)) ?? 0) > 0
    ) {
      outcomes.push({ target: asset.target, action: 'retain', reason: 'shared-target' });
      continue;
    }
    const currentAttributable =
      currentAsset === undefined ||
      attributableToInstall(
        diagnostic(
          'I_RESTORE_ASSET_SCOPE',
          'info',
          'restore asset ownership check',
          'internal ownership check',
          targetPath(input.dshHome, currentAsset.target),
        ),
        input.dshHome,
        {
          profile: marker?.metadata.profile ?? input.profile,
          assets: marker?.metadata.assets ?? [],
        },
      );
    const desiredAttributable =
      desiredAsset === undefined ||
      attributableToInstall(
        diagnostic(
          'I_RESTORE_ASSET_SCOPE',
          'info',
          'restore asset ownership check',
          'internal ownership check',
          targetPath(input.dshHome, desiredAsset.target),
        ),
        input.dshHome,
        {
          profile: target.metadata?.profile ?? input.profile,
          assets: target.metadata?.assets ?? [],
        },
      );
    if (!currentAttributable || !desiredAttributable) {
      if (input.force === true && desiredAsset !== undefined) {
        outcomes.push({
          target: asset.target,
          action: 'materialize',
          reason: 'target-generation',
        });
        continue;
      }
      outcomes.push({ target: asset.target, action: 'unchanged', reason: 'untracked' });
      continue;
    }
    if (currentAsset === undefined && desiredAsset !== undefined && observed !== undefined) {
      outcomes.push(
        input.force === true
          ? { target: asset.target, action: 'materialize', reason: 'target-generation' }
          : { target: asset.target, action: 'retain', reason: 'untracked' },
      );
      continue;
    }
    // An uninstall target has no desired asset. If that current asset is already absent there is
    // no mutation to retain or remove, so report the target state rather than a user-change warning.
    if (desiredAsset === undefined && observed === undefined) {
      outcomes.push({ target: asset.target, action: 'unchanged', reason: 'target-absent' });
      continue;
    }
    const drift: AssetDrift | undefined =
      currentAsset === undefined ? undefined : restoreDrift(currentAsset, observed);
    if ((drift === 'modified' || drift === 'missing') && input.force !== true) {
      outcomes.push({ target: asset.target, action: 'retain', reason: drift });
      continue;
    }
    if (desiredAsset !== undefined)
      outcomes.push({
        target: asset.target,
        action: 'materialize',
        reason: 'target-generation',
      });
    else if (observed === undefined)
      outcomes.push({ target: asset.target, action: 'unchanged', reason: 'target-absent' });
    else outcomes.push({ target: asset.target, action: 'remove', reason: 'target-absent' });
  }
  return {
    home,
    target,
    targetGeneration,
    current: marker,
    entries,
    observedIdentities,
    assets: outcomes,
    settings: await settingsPlan(input.dshHome, home, target, marker, input.force === true),
  };
}

export async function materializeAsset(
  tx: TransactionContext,
  dshHome: string,
  asset: MetadataAsset,
  target: GenerationDocument,
  entries: ReadonlyMap<string, Buffer>,
): Promise<void> {
  if (!supported(asset)) return;
  const root = targetPath(dshHome, asset.target);
  const files = assetEntries(target, asset);
  if (files.length === 0)
    fail(
      EXIT_CODES.CONTRACT,
      'E_RESTORE_GENERATION',
      'effective metadata asset has no immutable generation entries.',
      'Repair the generation history before retrying.',
      root,
    );
  await tx.create(asset.kind, root, async () => {
    for (const file of files) {
      const bytes = entries.get(file.target);
      if (bytes === undefined)
        fail(
          EXIT_CODES.CONTRACT,
          'E_RESTORE_CAS',
          'generation CAS preflight lost an immutable block.',
          'Retry from a repaired generation store.',
          file.target,
        );
      const relative = file.target.slice(`${asset.target}/`.length);
      const path = join(root, ...relative.split('/'));
      await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
      await writeFile(path, bytes, { mode: 0o600 });
    }
  });
}

/**
 * A restore creates fresh directories, so the historical marker's dev/inode facts are no longer
 * true even when every restored byte matches. Persist the freshly observed identities; otherwise
 * the next uninstall would conservatively mistake this restore's own files for user edits.
 */
export async function restoredMetadata(
  plan: RestorePlan,
  tx: TransactionContext,
  dshHome: string,
  sequence: number,
): Promise<InstalledMetadataV1 | null> {
  if (plan.target.metadata === null) return null;
  const outcomes = new Map(plan.assets.map((asset) => [asset.target, asset]));
  const assets: MetadataAsset[] = [];
  for (const asset of plan.target.metadata.assets) {
    const outcome = outcomes.get(asset.target);
    if (
      !supported(asset) ||
      asset.action === 'skip' ||
      outcome?.action === 'retain' ||
      outcome?.action === 'unchanged'
    ) {
      assets.push({ ...asset, action: 'skip' });
      continue;
    }
    assets.push({
      ...asset,
      identity: await tx.artifactIdentity(asset.kind, targetPath(dshHome, asset.target)),
    });
  }
  const retainedSettings = new Set(plan.settings?.retained ?? []);
  const settingsContribution = {
    ...plan.target.metadata.settingsContribution,
    keys: plan.target.metadata.settingsContribution.keys.filter(
      ({ key }) => !retainedSettings.has(key),
    ),
  };
  return { ...plan.target.metadata, generation: sequence, assets, settingsContribution };
}

/** A generation must only reference bytes that belong to its effective, non-skip marker assets. */
function effectiveGenerationEntries(
  target: GenerationDocument,
  metadata: InstalledMetadataV1 | null,
): readonly GenerationDocument['entries'][number][] {
  if (metadata === null) return [];
  const materialized = metadata.assets.filter(
    (asset) => asset.action !== 'skip' && supported(asset),
  );
  return target.entries.filter((entry) =>
    materialized.some((asset) => entry.target.startsWith(`${asset.target}/`)),
  );
}

export function warnings(plan: RestorePlan): ReturnType<typeof diagnostic>[] {
  return [
    ...plan.assets
      .filter((asset) => asset.action === 'retain')
      .map((asset) =>
        diagnostic(
          'W_RESTORE_ASSET_RETAINED',
          'warning',
          `${terminalSafeText(asset.target)} was retained because ${
            asset.reason === 'missing'
              ? 'the user removed it after the current generation'
              : asset.reason === 'shared-target'
                ? 'another installed profile still claims that target'
                : asset.reason === 'legacy-profile-reference'
                  ? 'a legacy installed profile cannot prove that target is unshared'
                  : 'it was modified after the current generation'
          }.`,
          asset.reason === 'shared-target' || asset.reason === 'legacy-profile-reference'
            ? 'Uninstall or migrate the other profile before changing this shared target.'
            : 'Use --force only after reviewing the user-owned changes.',
        ),
      ),
    ...(plan.settings?.retained ?? []).map((key) =>
      diagnostic(
        'W_RESTORE_SETTINGS_RETAINED',
        'warning',
        `agent-presets.${terminalSafeText(key)} was retained because it no longer matches the current marker.`,
        'Review the key manually before overwriting it.',
      ),
    ),
  ];
}

/** Run strict doctor before commit, while a failed restore verification can still roll back. */
async function verifyPostRestore(
  dshHome: string,
  ownership: InstalledMetadataV1 | undefined,
  profile: string | undefined,
  doctorRunner: (input: DoctorInput) => Promise<CommandReport<DoctorMetadata>>,
): Promise<readonly Diagnostic[]> {
  let report: CommandReport<DoctorMetadata>;
  try {
    report = await doctorRunner({
      dshHome,
      ...(profile === undefined ? {} : { profile }),
      strict: true,
      yes: true,
      fix: false,
    });
  } catch {
    throw new TransactionFailure(EXIT_CODES.POST_INSTALL_VERIFY_FAILURE, [
      diagnostic(
        'E_RESTORE_DOCTOR',
        'error',
        'strict doctor could not complete after restore.',
        'The transaction was rolled back; inspect doctor and retry.',
      ),
    ]);
  }
  const ours: Diagnostic[] = [];
  const preexisting: Diagnostic[] = [];
  for (const item of report.diagnostics)
    (attributableToInstall(item, dshHome, {
      profile: ownership?.profile ?? '',
      assets: ownership?.assets ?? [],
    })
      ? ours
      : preexisting
    ).push(item);
  if (ours.some((item) => item.severity === 'error'))
    throw new TransactionFailure(EXIT_CODES.POST_INSTALL_VERIFY_FAILURE, ours);
  if (report.exitCode !== EXIT_CODES.SUCCESS && report.diagnostics.length === 0)
    throw new TransactionFailure(EXIT_CODES.POST_INSTALL_VERIFY_FAILURE, [
      diagnostic(
        'E_RESTORE_DOCTOR',
        'error',
        'strict doctor failed without diagnostics after restore.',
        'The transaction was rolled back; inspect doctor and retry.',
      ),
    ]);
  if (preexisting.length === 0) return [];
  return [
    diagnostic(
      'W_RESTORE_DOCTOR_PREEXISTING',
      'warning',
      `doctor reported ${preexisting.length} preexisting issue(s) outside this restore scope.`,
      'Review them separately with dshpack doctor --strict.',
    ),
  ];
}

/** Materialize any retained generation while preserving changes made after the current marker. */
export async function restoreProfile(
  input: RestoreInput,
  dependencies: RestoreDependencies = {},
): Promise<CommandReport<RestoreMetadata>> {
  const resolution = resolveDshHomeValue(input.dshHome);
  if (!resolution.ok) return { ...resolution.report, metadata: metadata(input) };
  const normalized = { ...input, dshHome: resolution.value };
  try {
    const listed = await listGenerations(normalized.dshHome, normalized.profile);
    if (normalized.list === true)
      return {
        diagnostics: [],
        exitCode: EXIT_CODES.SUCCESS,
        metadata: metadata(normalized, { generations: summaries(listed) }),
      };
    const plan = await preparePlan(normalized);
    const base = (activePlan: RestorePlan) =>
      metadata(normalized, {
        targetGeneration: activePlan.targetGeneration,
        generations: summaries(listed),
        assets: activePlan.assets,
        retainedSettings: activePlan.settings?.retained ?? [],
      });
    if (normalized.dryRun === true)
      return { diagnostics: warnings(plan), exitCode: EXIT_CODES.SUCCESS, metadata: base(plan) };
    if (normalized.yes !== true)
      return {
        diagnostics: [
          diagnostic(
            'E_RESTORE_CONFIRM_REQUIRED',
            'error',
            'restore would modify managed files and requires --yes in non-interactive mode.',
            'Review with --dry-run, then rerun with --yes.',
          ),
        ],
        exitCode: EXIT_CODES.USER_DECLINED,
        metadata: base(plan),
      };
    const txid = dependencies.createTxid?.() ?? `restore-${randomUUID()}`;
    let executedPlan = plan;
    let postDoctorDiagnostics: readonly Diagnostic[] = [];
    const transaction = await runTransaction(
      {
        adapter: dependencies.createAdapter?.() ?? createNodeTransactionAdapter(),
        dshHome: normalized.dshHome,
        txid,
      },
      async (tx) => {
        // The dry-run/confirmation plan is advisory. Rebuild it after taking the DSH_HOME
        // transaction lease so a concurrent user edit cannot be replaced using stale drift facts.
        const lockedPlan = await preparePlan(normalized);
        executedPlan = lockedPlan;
        for (const outcome of lockedPlan.assets) {
          if (outcome.action === 'retain' || outcome.action === 'unchanged') continue;
          const current = lockedPlan.current?.metadata.assets.find(
            (asset) => asset.target === outcome.target,
          );
          const currentIdentity = lockedPlan.observedIdentities.get(outcome.target);
          if (current !== undefined && supported(current) && currentIdentity !== undefined)
            await tx.replaceArtifact(
              current.kind,
              targetPath(normalized.dshHome, current.target),
              currentIdentity,
            );
          if (outcome.action !== 'materialize') continue;
          const targetAsset = lockedPlan.target.metadata?.assets.find(
            (asset) => asset.target === outcome.target,
          );
          if (targetAsset === undefined) throw new Error('restore plan lost a target asset');
          if (current === undefined && supported(targetAsset)) {
            const identity = lockedPlan.observedIdentities.get(outcome.target);
            if (identity !== undefined)
              await tx.replaceArtifact(
                targetAsset.kind,
                targetPath(normalized.dshHome, targetAsset.target),
                identity,
              );
          }
          await materializeAsset(
            tx,
            normalized.dshHome,
            targetAsset,
            lockedPlan.target,
            lockedPlan.entries,
          );
        }
        if (lockedPlan.settings?.replacement !== undefined)
          await tx.writeSettings(
            join(normalized.dshHome, 'settings.yaml'),
            lockedPlan.settings.expected,
            lockedPlan.settings.replacement,
          );
        const allocation = await nextGeneration(tx, normalized.dshHome, normalized.profile);
        const effectiveMetadata = await restoredMetadata(
          lockedPlan,
          tx,
          normalized.dshHome,
          allocation.sequence,
        );
        const effectiveEntries = effectiveGenerationEntries(lockedPlan.target, effectiveMetadata);
        await writeGeneration(tx, normalized.dshHome, normalized.profile, {
          seq: allocation.sequence,
          txid,
          createdAt: dependencies.now?.() ?? new Date().toISOString(),
          operation: 'restore',
          pack: { ...lockedPlan.target.pack },
          source: { ...lockedPlan.target.source },
          entries: effectiveEntries.map((entry) => ({ ...entry })),
          settingsContribution:
            effectiveMetadata?.settingsContribution ?? lockedPlan.target.settingsContribution,
          metadata: effectiveMetadata,
          restorable: true,
        });
        await advanceCurrent(tx, allocation.currentPath, allocation.previous, allocation.sequence);
        const markerPath = join(
          normalized.dshHome,
          '.dshpack',
          'installed',
          `${normalized.profile}.json`,
        );
        if (effectiveMetadata === null) {
          if (lockedPlan.current !== undefined)
            await tx.deleteManagedDocument(
              markerPath,
              lockedPlan.current.document,
              lockedPlan.current.identity,
            );
        } else
          await tx.writeManagedDocument(
            markerPath,
            `${JSON.stringify(effectiveMetadata)}\n`,
            lockedPlan.current?.document,
          );
        postDoctorDiagnostics = await verifyPostRestore(
          normalized.dshHome,
          effectiveMetadata ?? lockedPlan.current?.metadata,
          effectiveMetadata?.profile,
          dependencies.runDoctor ?? runDoctor,
        );
        return allocation.sequence;
      },
    );
    if (!transaction.ok) {
      // A transaction whose journal is committed but whose final lock release failed is durable.
      // Preserve its sequence and locked plan so callers do not retry an already-applied restore.
      const committed = transaction.status === 'committed' ? transaction.value : undefined;
      return {
        diagnostics: transaction.diagnostics,
        exitCode: transaction.exitCode,
        metadata: metadata(normalized, {
          ...base(executedPlan),
          ...(committed === undefined ? {} : { generation: committed }),
          backupDirectory: transaction.backupDirectory,
          manualRecovery: transaction.manualRecovery,
        }),
      };
    }
    return {
      diagnostics: [...warnings(executedPlan), ...postDoctorDiagnostics],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: metadata(normalized, {
        ...base(executedPlan),
        generation:
          transaction.value ??
          (() => {
            throw new Error('committed restore did not retain its generation sequence');
          })(),
        backupDirectory: transaction.backupDirectory,
      }),
    };
  } catch (error) {
    if (error instanceof RestoreError || error instanceof ManagementStateError)
      return {
        diagnostics: [diagnosticFor(error)],
        exitCode:
          error instanceof RestoreError ? error.exitCode : exitCodeForManagementState(error),
        metadata: metadata(
          normalized,
          error instanceof RestoreCasPreflightError
            ? { missingCasBlocks: error.missingBlocks }
            : {},
        ),
      };
    if (error instanceof TransactionFailure)
      return {
        diagnostics: error.diagnostics,
        exitCode: error.exitCode,
        metadata: metadata(normalized),
      };
    return {
      diagnostics: [
        diagnostic(
          'E_RESTORE_INTERNAL',
          'error',
          'restore encountered an unexpected internal error.',
          'Retry; if the problem persists, report only this diagnostic code.',
        ),
      ],
      exitCode: EXIT_CODES.INTERNAL,
      metadata: metadata(normalized),
    };
  }
}
