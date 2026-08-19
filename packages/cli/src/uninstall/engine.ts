import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Diagnostic } from '@dshpack/core';
import { isMap, isNode, isPair, isScalar, isSeq, parseDocument } from 'yaml';

import { type CommandReport, diagnostic, resolveDshHomeValue } from '../commands/shared.js';
import { type DoctorInput, type DoctorMetadata, runDoctor } from '../doctor/engine.js';
import { EXIT_CODES, type ExitCode } from '../exit-codes.js';
import { GcFailure, purgeCommittedStateQuarantine } from '../gc/engine.js';
import { captureSourceDirectory, SnapshotCaptureError } from '../install/snapshot-capture.js';
import {
  bindDirectory,
  bindSecureRoot,
  type DirectoryBinding,
  readBytes,
  readDirectory,
  readText,
  revalidateDirectoryEntries,
  type SafePathFailure,
} from '../list/safe-fs.js';
import { attributableToInstall } from '../management/attribution.js';
import { ManagementStateError, readCasBlock, readGeneration } from '../management/state.js';
import {
  type AssetDrift,
  classifyAssetDrift,
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
  casStoreShard,
  generationFilename,
  isManagedProfileInventoryPath,
  nextGeneration,
  settingsContribution,
  writeGeneration,
} from '../metadata/state-storage.js';
import { terminalSafeText } from '../terminal-safe.js';
import {
  createNodeTransactionAdapter,
  runTransaction,
  type TransactionAdapter,
  TransactionFailure,
} from '../transaction.js';
import { MAX_TRANSACTION_STATE_BYTES } from '../transaction-types.js';

export interface UninstallInput {
  readonly dshHome: string;
  readonly profile: string;
  readonly dryRun?: boolean;
  readonly keepAssets?: boolean;
  readonly force?: boolean;
  readonly purgeGenerations?: boolean;
  readonly yes?: boolean;
  readonly interactive?: boolean;
}

export interface UninstallAssetOutcome {
  readonly target: string;
  readonly drift: AssetDrift;
  readonly action: 'delete' | 'retain' | 'missing';
  readonly reason:
    | 'intact'
    | 'force-modified'
    | 'modified'
    | 'missing'
    | 'skip-user-owned'
    | 'keep-assets'
    | 'shared-target'
    | 'legacy-profile-reference'
    | 'unsupported-asset';
}

export interface UninstallMetadata {
  readonly profile: string;
  readonly dryRun: boolean;
  readonly keepAssets: boolean;
  readonly force: boolean;
  readonly purgeGenerations: boolean;
  readonly removedMarker: boolean;
  readonly activation: 'profile-removed' | 'unchanged';
  /** Planned outcome for the profile directory, including v0 target-only force cleanup. */
  readonly profileAction: 'delete' | 'retain' | 'missing' | 'none';
  /** A tracked marker deletion is bound to every valid mutation plan. */
  readonly markerAction: 'delete' | 'none';
  readonly assets: readonly UninstallAssetOutcome[];
  readonly legacyProfiles: readonly string[];
  readonly settingsRemoved: readonly string[];
  readonly settingsRetained: readonly string[];
  readonly generation?: number;
  readonly deletedGenerations: readonly string[];
  readonly deletedBlocks: readonly string[];
  /** Managed state was removed, but committed immutable payloads still need a verified retry. */
  readonly pendingPurge: boolean;
  readonly backupDirectory?: string;
  readonly manualRecovery: readonly unknown[];
}

export type UninstallReport = CommandReport<UninstallMetadata>;

export interface UninstallDependencies {
  readonly createAdapter?: () => TransactionAdapter;
  readonly createTxid?: () => string;
  readonly now?: () => string;
  /** Runtime seam for the strict, transaction-bound post-uninstall doctor check. */
  readonly runDoctor?: (input: DoctorInput) => Promise<CommandReport<DoctorMetadata>>;
}

function isUninstallPurgeTransactionId(value: string): boolean {
  return /^uninstall-purge-[A-Za-z0-9][A-Za-z0-9._-]{0,111}$/u.test(value);
}

interface TrackedMarker {
  readonly profile: string;
  readonly metadata: InstalledMetadata;
  readonly document: string;
  readonly identity: string;
}

interface MetadataScan {
  readonly markers: readonly TrackedMarker[];
  readonly target: TrackedMarker | undefined;
}

export interface SettingsPlan {
  readonly expected: string | undefined;
  readonly replacement: string | undefined;
  readonly removed: readonly string[];
  readonly retained: readonly string[];
}

interface UninstallPlan {
  readonly marker: TrackedMarker;
  readonly assets: readonly UninstallAssetOutcome[];
  /** Exact identities captured while building the plan under the artifact lease. */
  readonly assetIdentities: ReadonlyMap<string, string>;
  readonly settings: SettingsPlan;
  readonly legacyProfiles: readonly string[];
}

interface PlannedStateFile {
  readonly path: string;
  readonly relative: string;
  readonly sha256: string;
  readonly identity: string;
}

interface PurgePlan {
  readonly current: PlannedStateFile;
  readonly generations: readonly PlannedStateFile[];
  readonly blocks: readonly PlannedStateFile[];
}

class UninstallError extends Error {
  constructor(
    readonly exitCode: ExitCode,
    readonly code: string,
    message: string,
    readonly hint: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'UninstallError';
  }
}

function fail(
  exitCode: ExitCode,
  code: string,
  message: string,
  hint: string,
  path?: string,
): never {
  throw new UninstallError(exitCode, code, message, hint, path);
}

function failureKind(failure: SafePathFailure): ExitCode {
  return failure.kind === 'security' ? EXIT_CODES.SECURITY : EXIT_CODES.CONTRACT;
}

function safeRead<T>(
  value: { ok: true; value: T } | SafePathFailure,
  code: string,
  message: string,
  path: string,
): T {
  if (value.ok) return value.value;
  fail(
    failureKind(value),
    code,
    message,
    'Repair the managed state and retry; no files were changed.',
    path,
  );
}

function metadataReport(
  input: UninstallInput,
  extra: Partial<UninstallMetadata> = {},
): UninstallMetadata {
  return {
    profile: input.profile,
    dryRun: input.dryRun === true,
    keepAssets: input.keepAssets === true,
    force: input.force === true,
    purgeGenerations: input.purgeGenerations === true,
    removedMarker: false,
    activation: 'unchanged',
    profileAction: 'none',
    markerAction: 'none',
    assets: [],
    legacyProfiles: [],
    settingsRemoved: [],
    settingsRetained: [],
    deletedGenerations: [],
    deletedBlocks: [],
    pendingPurge: false,
    manualRecovery: [],
    ...extra,
  };
}

function reportFailure(input: UninstallInput, error: unknown): CommandReport<UninstallMetadata> {
  const failure =
    error instanceof UninstallError
      ? error
      : error instanceof ManagementStateError
        ? new UninstallError(
            error.kind === 'security' || error.kind === 'changed'
              ? EXIT_CODES.SECURITY
              : error.kind === 'environment'
                ? EXIT_CODES.INTERNAL
                : EXIT_CODES.CONTRACT,
            error.diagnostic.code,
            error.diagnostic.message,
            error.diagnostic.hint ?? 'Repair the managed state and retry.',
            error.diagnostic.path,
          )
        : new UninstallError(
            EXIT_CODES.INTERNAL,
            'E_UNINSTALL_INTERNAL',
            'uninstall failed unexpectedly.',
            'Inspect the managed state and retry.',
          );
  return {
    diagnostics: [diagnostic(failure.code, 'error', failure.message, failure.hint, failure.path)],
    exitCode: failure.exitCode,
    metadata: metadataReport(input),
  };
}

function sha256(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
}

function targetPath(dshHome: string, target: string): string {
  return join(dshHome, ...target.split('/'));
}

async function scanTrackedMetadata(dshHome: string, profile: string): Promise<MetadataScan> {
  const home = await bindSecureRoot(dshHome);
  if (!home.ok) {
    if (home.kind === 'missing') return { markers: [], target: undefined };
    fail(
      failureKind(home),
      'E_UNINSTALL_HOME',
      'DSH_HOME cannot be read securely.',
      'Use a regular absolute DSH_HOME and retry.',
      dshHome,
    );
  }
  // The target marker is the authority for E_NOT_TRACKED. Read it before walking peer
  // markers so unrelated corruption cannot turn an absent-profile request into a contract
  // failure (and, importantly, no peer content is parsed unless this marker exists).
  if (!isInstallableProfileName(profile)) return { markers: [], target: undefined };
  const targetFilename = `${profile}.json`;
  const targetPath = join(dshHome, '.dshpack', 'installed', targetFilename);
  const targetSource = await readText(
    home.value,
    ['.dshpack', 'installed', targetFilename],
    {},
    MAX_TRANSACTION_STATE_BYTES,
  );
  if (!targetSource.ok) {
    if (targetSource.kind === 'missing') return { markers: [], target: undefined };
    fail(
      failureKind(targetSource),
      'E_UNINSTALL_METADATA',
      'installed metadata cannot be read securely.',
      'Repair the managed metadata directory and retry.',
      targetPath,
    );
  }
  let targetParsed: ReturnType<typeof parseInstalledMetadata>;
  try {
    targetParsed = parseInstalledMetadata(JSON.parse(targetSource.value.text), profile);
  } catch {
    fail(
      EXIT_CODES.CONTRACT,
      'E_UNINSTALL_METADATA',
      'installed metadata is not valid JSON.',
      'Repair or migrate the managed profile before retrying.',
      targetPath,
    );
  }
  if (!targetParsed.ok) {
    fail(
      EXIT_CODES.CONTRACT,
      'E_UNINSTALL_METADATA',
      'installed metadata does not satisfy its versioned contract.',
      'Repair or migrate the managed profile before retrying.',
      targetPath,
    );
  }
  const target: TrackedMarker = {
    profile,
    metadata: targetParsed.metadata,
    document: targetSource.value.text,
    identity: targetSource.value.identity,
  };
  // v0 cannot establish shared asset ownership. Its documented force path is deliberately
  // target-only, so neither a migration hint nor conservative profile+marker cleanup should
  // be blocked by unrelated peer metadata that it is unable to reason about safely.
  if (target.metadata.metadataVersion === 0) return { markers: [target], target };
  const entries = await readDirectory(home.value, ['.dshpack', 'installed']);
  if (!entries.ok) {
    if (entries.kind === 'missing') return { markers: [], target: undefined };
    fail(
      failureKind(entries),
      'E_UNINSTALL_METADATA',
      'installed metadata cannot be read securely.',
      'Repair the managed metadata directory and retry.',
      join(dshHome, '.dshpack', 'installed'),
    );
  }
  const markers: TrackedMarker[] = [target];
  for (const entry of entries.value) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail(
        EXIT_CODES.SECURITY,
        'E_UNINSTALL_METADATA',
        'installed metadata contains a non-regular entry.',
        'Repair the managed metadata directory and retry.',
        join(dshHome, '.dshpack', 'installed', entry.name),
      );
    }
    if (!entry.name.endsWith('.json')) {
      fail(
        EXIT_CODES.CONTRACT,
        'E_UNINSTALL_METADATA',
        'installed metadata contains a non-marker file.',
        'Repair the managed metadata directory and retry.',
        join(dshHome, '.dshpack', 'installed', entry.name),
      );
    }
    const markerProfile = entry.name.slice(0, -'.json'.length);
    if (!isInstallableProfileName(markerProfile)) {
      fail(
        EXIT_CODES.CONTRACT,
        'E_UNINSTALL_METADATA',
        'installed metadata has an unsafe profile filename.',
        'Repair the managed metadata directory and retry.',
        join(dshHome, '.dshpack', 'installed', entry.name),
      );
    }
    if (entry.name === targetFilename) continue;
    const source = safeRead(
      await readText(
        home.value,
        ['.dshpack', 'installed', entry.name],
        {},
        MAX_TRANSACTION_STATE_BYTES,
      ),
      'E_UNINSTALL_METADATA',
      'installed metadata cannot be read securely.',
      join(dshHome, '.dshpack', 'installed', entry.name),
    );
    let parsed: ReturnType<typeof parseInstalledMetadata>;
    try {
      parsed = parseInstalledMetadata(JSON.parse(source.text), markerProfile);
    } catch {
      fail(
        EXIT_CODES.CONTRACT,
        'E_UNINSTALL_METADATA',
        'installed metadata is not valid JSON.',
        'Repair or migrate the managed profile before retrying.',
        join(dshHome, '.dshpack', 'installed', entry.name),
      );
    }
    if (!parsed.ok) {
      fail(
        EXIT_CODES.CONTRACT,
        'E_UNINSTALL_METADATA',
        'installed metadata does not satisfy its versioned contract.',
        'Repair or migrate the managed profile before retrying.',
        join(dshHome, '.dshpack', 'installed', entry.name),
      );
    }
    markers.push({
      profile: markerProfile,
      metadata: parsed.metadata,
      document: source.text,
      identity: source.identity,
    });
  }
  const installed = safeRead(
    await bindDirectory(home.value, ['.dshpack', 'installed']),
    'E_UNINSTALL_METADATA',
    'installed metadata directory cannot be rebound securely.',
    join(dshHome, '.dshpack', 'installed'),
  );
  safeRead(
    await revalidateDirectoryEntries(installed, entries.value),
    'E_UNINSTALL_METADATA',
    'installed metadata changed during the scan.',
    join(dshHome, '.dshpack', 'installed'),
  );
  return { markers, target };
}

async function observeAsset(
  dshHome: string,
  asset: MetadataAsset,
): Promise<ObservedAsset | undefined> {
  const path = targetPath(dshHome, asset.target);
  try {
    const first = await lstat(path, { bigint: true });
    if (!first.isDirectory() || first.isSymbolicLink()) {
      fail(
        EXIT_CODES.SECURITY,
        'E_UNINSTALL_ASSET_PATH',
        'managed asset is no longer a regular directory.',
        'Inspect the asset path before retrying.',
        path,
      );
    }
    const directory = await captureSourceDirectory(
      path,
      asset.kind === 'profile'
        ? { skipPath: (entry) => !isManagedProfileInventoryPath(entry) }
        : {},
    );
    const last = await lstat(path, { bigint: true });
    const identity = `${last.dev}:${last.ino}:${last.birthtimeNs}`;
    if (
      first.dev !== last.dev ||
      first.ino !== last.ino ||
      first.birthtimeNs !== last.birthtimeNs
    ) {
      fail(
        EXIT_CODES.SECURITY,
        'E_UNINSTALL_ASSET_CHANGED',
        'managed asset changed during drift inspection.',
        'Retry after concurrent writes have stopped.',
        path,
      );
    }
    return {
      identity,
      files: directory.files.map((file) => ({
        path: file.path,
        sha256: sha256(file.bytes),
        bytes: file.bytes.byteLength,
      })),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return undefined;
    if (error instanceof UninstallError) throw error;
    if (error instanceof SnapshotCaptureError) {
      fail(
        error.kind === 'security' ? EXIT_CODES.SECURITY : EXIT_CODES.CONTRACT,
        'E_UNINSTALL_ASSET_PATH',
        'managed asset cannot be inspected safely.',
        'Inspect the asset path before retrying.',
        path,
      );
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface TextSpan {
  readonly start: number;
  readonly end: number;
}

function lineStart(source: string, offset: number): number {
  return source.lastIndexOf('\n', offset - 1) + 1;
}

/** YAML exposes comments separately from scalar text, so a literal `#` never becomes a false
 * ownership claim.  The recursive walk includes comments on nested mapping values too. */
function hasYamlComment(node: unknown): boolean {
  if (!isNode(node)) return false;
  if (node.comment !== undefined || node.commentBefore !== undefined) return true;
  if (isMap(node) || isSeq(node))
    return node.items.some((item) => {
      if (isPair(item)) return hasYamlComment(item.key) || hasYamlComment(item.value);
      return hasYamlComment(item);
    });
  return false;
}

/** An alias can appear in a retained pair outside the span being removed.  Deleting an anchor
 * definition would make that otherwise untouched YAML invalid, so anchor-bearing owned pairs
 * are conservatively retained rather than trying to rewrite aliases. */
function hasYamlAnchor(node: unknown): boolean {
  if (!isNode(node)) return false;
  if (node.anchor !== undefined) return true;
  if (isMap(node) || isSeq(node))
    return node.items.some((item) => {
      if (isPair(item)) return hasYamlAnchor(item.key) || hasYamlAnchor(item.value);
      return hasYamlAnchor(item);
    });
  return false;
}

/**
 * The semantic check uses YAML's AST, but the inverse merge must not serialize the document:
 * unrelated comments, EOL spelling, and flow formatting are user-owned bytes.  We therefore
 * remove only complete direct mapping pairs whose values still equal the recorded contribution.
 * Any comment in the owned pair or in a separator that must be removed makes the key user-owned:
 * retaining it is the only byte-preserving option.
 */
function directSettingsKeySpans(
  source: string,
  document: ReturnType<typeof parseDocument>,
  keys: ReadonlySet<string>,
): ReadonlyMap<string, TextSpan> {
  const section = document.get('agent-presets', true);
  if (!isMap(section)) return new Map();
  // Replacing a final child with `{}` would detach a root anchor/tag (and can make an external
  // alias unresolved).  Preserve the exact document rather than relocating node properties.
  if (section.anchor !== undefined || section.tag !== undefined) return new Map();
  const spans = new Map<string, TextSpan>();
  for (let index = 0; index < section.items.length; index += 1) {
    const item = section.items[index];
    const key = item?.key;
    const name = isScalar(key) ? key.value : undefined;
    const keyRange = isScalar(key) ? key.range : undefined;
    if (
      item === undefined ||
      typeof name !== 'string' ||
      keyRange === undefined ||
      keyRange === null ||
      !keys.has(name)
    )
      continue;
    const next = section.items[index + 1];
    const nextRange = next !== undefined && isScalar(next.key) ? next.key.range : undefined;
    const valueRange = isNode(item.value) ? item.value.range : undefined;
    if (section.flow) {
      if (valueRange === undefined || valueRange === null) continue;
      if (
        hasYamlComment(item.key) ||
        hasYamlComment(item.value) ||
        hasYamlAnchor(item.key) ||
        hasYamlAnchor(item.value)
      )
        continue;
      const valueEnd = valueRange[1];
      if (nextRange !== undefined && nextRange !== null) {
        const separator = source.slice(valueEnd, nextRange[0]);
        const comma = separator.indexOf(',');
        if (comma < 0) continue;
        spans.set(name, { start: keyRange[0], end: valueEnd + comma + 1 });
        continue;
      }
      const previous = section.items[index - 1];
      const previousRange =
        previous !== undefined && isNode(previous.value) ? previous.value.range : undefined;
      if (previousRange === undefined || previousRange === null) {
        spans.set(name, { start: keyRange[0], end: valueEnd });
        continue;
      }
      if (previous === undefined) continue;
      // Only a trailing comment after the previous value is in the comma span we would erase.
      // `commentBefore`/nested comments belong to that retained pair and remain byte-identical.
      if (isNode(previous.value) && previous.value.comment !== undefined) continue;
      const separator = source.slice(previousRange[1], keyRange[0]);
      const comma = separator.lastIndexOf(',');
      if (comma < 0) continue;
      spans.set(name, { start: previousRange[1] + comma, end: valueEnd });
      continue;
    }
    const start = lineStart(source, keyRange[0]);
    const end = valueRange === undefined || valueRange === null ? keyRange[2] : valueRange[2];
    if (end <= start) continue;
    if (
      hasYamlComment(item.key) ||
      hasYamlComment(item.value) ||
      hasYamlAnchor(item.key) ||
      hasYamlAnchor(item.value)
    )
      continue;
    spans.set(name, { start, end });
  }
  return spans;
}

function removeSettingsSpans(source: string, spans: readonly TextSpan[]): string {
  return [...spans]
    .sort((left, right) => right.start - left.start)
    .reduce((result, span) => `${result.slice(0, span.start)}${result.slice(span.end)}`, source);
}

/** Find the mapping colon in the exact CST range between a root key and its value. */
function rootPairMappingColon(
  source: string,
  keyRange: readonly number[],
  value: unknown,
): number | undefined {
  if (!isNode(value) || value.range === undefined || value.range === null) return undefined;
  const keyEnd = keyRange[1];
  const valueStart = value.range[0];
  if (keyEnd === undefined || valueStart === undefined) return undefined;
  let inComment = false;
  for (let offset = keyEnd; offset < valueStart; offset += 1) {
    const character = source[offset];
    if (character === '\n' || character === '\r') {
      inComment = false;
      continue;
    }
    if (inComment) continue;
    if (character === '#') {
      inComment = true;
      continue;
    }
    if (character === ':') return offset;
  }
  return undefined;
}

/**
 * Replace the value of the exact root `agent-presets` pair after its final owned child has been
 * removed.  The pair's YAML CST key range is authoritative: quotes, spacing, comments, and EOL
 * spelling are user bytes and must stay untouched.
 */
function normalizeEmptySettingsRootMap(
  source: string,
  replacement: string,
  document: ReturnType<typeof parseDocument>,
): string {
  const root = document.contents;
  if (!isMap(root)) return replacement;
  for (const pair of root.items) {
    if (!isPair(pair) || !isScalar(pair.key) || pair.key.value !== 'agent-presets') continue;
    const keyRange = pair.key.range;
    if (keyRange === undefined || keyRange === null) return replacement;
    const colon = rootPairMappingColon(source, keyRange, pair.value);
    if (colon === undefined) return replacement;
    return `${replacement.slice(0, colon + 1)} {}${replacement.slice(colon + 1)}`;
  }
  return replacement;
}

/**
 * A comment on the root pair's own line survives a child-span deletion, while a comment before
 * the first child would be detached by changing that block map to `{}`.  YAML attaches both as
 * `commentBefore` on the map, so classify their exact CST-relative source positions instead of
 * treating every `commentBefore` as an owned child comment.
 */
function hasEmptySettingsSectionComment(
  source: string,
  document: ReturnType<typeof parseDocument>,
  section: unknown,
): boolean {
  if (!isMap(section)) return true;
  const root = document.contents;
  if (!isMap(root)) return true;
  let rootKeyRange: readonly number[] | undefined;
  for (const pair of root.items) {
    if (!isPair(pair) || !isScalar(pair.key) || pair.key.value !== 'agent-presets') continue;
    if (pair.value !== section) return true;
    rootKeyRange = pair.key.range ?? undefined;
    break;
  }
  if (rootKeyRange === undefined) return true;
  if (
    section.items.some(
      (item) => isPair(item) && (hasYamlComment(item.key) || hasYamlComment(item.value)),
    )
  )
    return true;
  if (section.commentBefore === undefined) return false;
  const first = section.items[0];
  if (
    !isPair(first) ||
    !isScalar(first.key) ||
    first.key.range === undefined ||
    first.key.range === null
  )
    return true;
  const pair = root.items.find(
    (item) => isPair(item) && isScalar(item.key) && item.key.value === 'agent-presets',
  );
  if (pair === undefined || !isPair(pair)) return true;
  const colon = rootPairMappingColon(source, rootKeyRange, pair.value);
  if (colon === undefined) return true;
  const colonLineEnd = source.indexOf('\n', colon);
  if (colonLineEnd < 0) return true;
  const beforeFirstChild = source.slice(colonLineEnd + 1, lineStart(source, first.key.range[0]));
  return beforeFirstChild.trim().length > 0;
}

/** Reuse the byte-preserving inverse merge for uninstall and restore-to-uninstalled state. */
export async function prepareInverseSettings(
  dshHome: string,
  home: DirectoryBinding,
  marker: InstalledMetadataV1,
  keepAssets: boolean,
  force = false,
): Promise<SettingsPlan> {
  if (keepAssets || marker.settingsContribution.keys.length === 0)
    return { expected: undefined, replacement: undefined, removed: [], retained: [] };
  const path = join(dshHome, 'settings.yaml');
  const read = await readText(home, ['settings.yaml']);
  if (!read.ok) {
    if (read.kind === 'missing')
      return {
        expected: undefined,
        replacement: undefined,
        removed: [],
        retained: marker.settingsContribution.keys.map(({ key }) => key),
      };
    safeRead(read, 'E_UNINSTALL_SETTINGS', 'settings.yaml cannot be read securely.', path);
  }
  if (!read.ok) throw new Error('unreachable');
  const document = parseDocument(read.value.text, { prettyErrors: true });
  if (document.errors.length > 0) {
    fail(
      EXIT_CODES.CONTRACT,
      'E_UNINSTALL_SETTINGS',
      'settings.yaml is not valid YAML.',
      'Repair settings.yaml before uninstalling its recorded contribution.',
      path,
    );
  }
  const root: unknown = document.toJS();
  if (!isRecord(root) || !isRecord(root['agent-presets'])) {
    return {
      expected: read.value.text,
      replacement: undefined,
      removed: [],
      retained: marker.settingsContribution.keys.map(({ key }) => key),
    };
  }
  const section = root['agent-presets'];
  const removed: string[] = [];
  const retained: string[] = [];
  const removable = new Set<string>();
  for (const contribution of marker.settingsContribution.keys) {
    if (!Object.hasOwn(section, contribution.key)) {
      retained.push(contribution.key);
      continue;
    }
    try {
      const current = settingsContribution({ [contribution.key]: section[contribution.key] })
        .keys[0];
      if (current?.valueSha256 !== contribution.valueSha256 && !force) {
        retained.push(contribution.key);
        continue;
      }
    } catch {
      retained.push(contribution.key);
      continue;
    }
    removable.add(contribution.key);
  }
  const spans = directSettingsKeySpans(read.value.text, document, removable);
  for (const key of removable) {
    if (!spans.has(key)) {
      retained.push(key);
      continue;
    }
    removed.push(key);
  }
  const removalSpans = removed.map((key) => {
    const span = spans.get(key);
    if (span === undefined)
      fail(
        EXIT_CODES.CONTRACT,
        'E_UNINSTALL_SETTINGS',
        'Settings removal plan lost a selected key span.',
        'Retry uninstall after checking settings.yaml.',
        join(dshHome, 'settings.yaml'),
      );
    return span;
  });
  const replacement =
    removed.length === 0 ? undefined : removeSettingsSpans(read.value.text, removalSpans);
  const sectionNode = document.get('agent-presets', true);
  const emptySection =
    replacement !== undefined &&
    isMap(sectionNode) &&
    !sectionNode.flow &&
    !hasEmptySettingsSectionComment(read.value.text, document, sectionNode) &&
    sectionNode.items.length === removed.length;
  return {
    expected: read.value.text,
    replacement: emptySection
      ? normalizeEmptySettingsRootMap(read.value.text, replacement, document)
      : replacement,
    removed,
    retained,
  };
}

/**
 * Defense in depth for the transaction apply path. `buildPlan` normally constructs only v1,
 * directory-backed delete outcomes, but a corrupted in-memory plan must never reach a file move.
 */
function isDirectoryAsset(
  asset: MetadataAsset,
): asset is MetadataAsset & { readonly kind: 'profile' | 'skill' | 'preset' } {
  return asset.kind === 'profile' || asset.kind === 'skill' || asset.kind === 'preset';
}

export function resolveUninstallDeleteSource(
  metadata: InstalledMetadata,
  target: string,
): MetadataAsset & { readonly kind: 'profile' | 'skill' | 'preset' } {
  if (metadata.metadataVersion !== 1)
    fail(
      EXIT_CODES.CONTRACT,
      'E_UNINSTALL_PLAN_METADATA',
      'Uninstall delete plan is not backed by v1 asset metadata.',
      'Retry uninstall; no files were replaced.',
      target,
    );
  const source = metadata.assets.find((candidate) => candidate.target === target);
  if (source === undefined)
    fail(
      EXIT_CODES.CONTRACT,
      'E_UNINSTALL_PLAN_ASSET',
      'Uninstall delete plan lost its source asset.',
      'Retry uninstall; no files were replaced.',
      target,
    );
  if (!isDirectoryAsset(source))
    fail(
      EXIT_CODES.CONTRACT,
      'E_UNINSTALL_PLAN_KIND',
      'Uninstall delete plan references a non-directory asset.',
      'Retry uninstall; no files were replaced.',
      target,
    );
  return source;
}

async function buildPlan(input: UninstallInput, scan: MetadataScan): Promise<UninstallPlan> {
  const marker = scan.target;
  if (marker === undefined) {
    fail(
      EXIT_CODES.ENVIRONMENT,
      'E_NOT_TRACKED',
      'profile is not tracked by dshpack.',
      `Use dshpack list to inspect profiles, or install ${terminalSafeText(input.profile)} before uninstalling it.`,
    );
  }
  if (marker.metadata.metadataVersion === 0 && input.force !== true) {
    fail(
      EXIT_CODES.CONTRACT,
      'E_UNINSTALL_LEGACY',
      'legacy installed metadata cannot prove asset ownership.',
      `Run dshpack migrate ${input.profile}, or use --force to remove only the profile and marker.`,
    );
  }
  if (marker.metadata.metadataVersion === 0) {
    return {
      marker,
      assets: [],
      assetIdentities: new Map(),
      settings: { expected: undefined, replacement: undefined, removed: [], retained: [] },
      legacyProfiles: [],
    };
  }
  const other = scan.markers.filter((candidate) => candidate.profile !== marker.profile);
  const ownership = countMetadataAssetTargetReferences(
    other.map((candidate) => candidate.metadata),
  );
  const outcomes: UninstallAssetOutcome[] = [];
  const assetIdentities = new Map<string, string>();
  for (const asset of marker.metadata.assets) {
    const observed = await observeAsset(input.dshHome, asset);
    if (observed === undefined) {
      outcomes.push({
        target: asset.target,
        drift: 'missing',
        action: 'missing',
        reason: 'missing',
      });
      continue;
    }
    const drift = classifyAssetDrift(asset, observed);
    assetIdentities.set(asset.target, observed.identity);
    // A skip records that a path was observed but never installed by this profile.  It is not an
    // ownership claim and must not be made permanent by an uninstall reference scan.
    if (asset.action === 'skip') {
      outcomes.push({ target: asset.target, drift, action: 'retain', reason: 'skip-user-owned' });
      continue;
    }
    if (asset.kind === 'managed-document') {
      outcomes.push({ target: asset.target, drift, action: 'retain', reason: 'unsupported-asset' });
      continue;
    }
    if (input.keepAssets === true && asset.kind !== 'profile') {
      outcomes.push({ target: asset.target, drift, action: 'retain', reason: 'keep-assets' });
      continue;
    }
    const target = portableTargetKey(asset.target);
    const metadataReferences = ownership.counts.get(target) ?? 0;
    if (ownership.legacyProfiles.length > 0) {
      outcomes.push({
        target: asset.target,
        drift,
        action: 'retain',
        reason: 'legacy-profile-reference',
      });
      continue;
    }
    if (metadataReferences > 0) {
      outcomes.push({ target: asset.target, drift, action: 'retain', reason: 'shared-target' });
      continue;
    }
    if (drift === 'modified' && input.force !== true) {
      outcomes.push({ target: asset.target, drift, action: 'retain', reason: 'modified' });
      continue;
    }
    outcomes.push({
      target: asset.target,
      drift,
      action: 'delete',
      reason: drift === 'modified' ? 'force-modified' : 'intact',
    });
  }
  const home = safeRead(
    await bindSecureRoot(input.dshHome),
    'E_UNINSTALL_HOME',
    'DSH_HOME cannot be read securely.',
    input.dshHome,
  );
  return {
    marker,
    assets: outcomes,
    assetIdentities,
    settings: await prepareInverseSettings(
      input.dshHome,
      home,
      marker.metadata,
      input.keepAssets === true,
      input.force === true,
    ),
    legacyProfiles: ownership.legacyProfiles,
  };
}

function planStateActions(
  plan: UninstallPlan,
): Pick<UninstallMetadata, 'profileAction' | 'markerAction'> {
  const profile = plan.assets.find((asset) => asset.target === `profiles/${plan.marker.profile}`);
  return {
    // v0 has no asset inventory, but --force is documented to remove the profile directory
    // (when it still exists) and the marker. Surface that destructive action before --yes.
    profileAction:
      plan.marker.metadata.metadataVersion === 0 ? 'delete' : (profile?.action ?? 'none'),
    markerAction: 'delete',
  };
}

function sequenceFromFilename(name: string): number | undefined {
  const match = /^(\d+)\.json$/u.exec(name);
  if (match === null) return undefined;
  const sequence = Number(match[1]);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return undefined;
  return generationFilename(sequence) === name ? sequence : undefined;
}

/**
 * Read all generation documents once before purge. The resulting CAS plan deliberately uses
 * references from every other profile, so a block is never reclaimed merely because another
 * profile happened not to be the active profile.
 */
async function buildPurgePlan(dshHome: string, targetProfile: string): Promise<PurgePlan> {
  const home = safeRead(
    await bindSecureRoot(dshHome),
    'E_UNINSTALL_HOME',
    'DSH_HOME cannot be read securely.',
    dshHome,
  );
  const root = safeRead(
    await bindDirectory(home, ['.dshpack', 'generations']),
    'E_UNINSTALL_GENERATION',
    'generation state cannot be read securely.',
    join(dshHome, '.dshpack', 'generations'),
  );
  const profiles = safeRead(
    await readDirectory(home, ['.dshpack', 'generations']),
    'E_UNINSTALL_GENERATION',
    'generation state cannot be enumerated securely.',
    join(dshHome, '.dshpack', 'generations'),
  );
  const allEntries: Array<{ profile: string; sha256: string }> = [];
  const targetGenerations: PlannedStateFile[] = [];
  let current: PlannedStateFile | undefined;
  let currentSequence: number | undefined;
  for (const profileEntry of profiles) {
    if (
      !profileEntry.isDirectory() ||
      profileEntry.isSymbolicLink() ||
      !isInstallableProfileName(profileEntry.name)
    ) {
      fail(
        EXIT_CODES.CONTRACT,
        'E_UNINSTALL_GENERATION',
        'generation state contains an invalid profile directory.',
        'Repair generation state before retrying.',
        join(dshHome, '.dshpack', 'generations', profileEntry.name),
      );
    }
    const profile = profileEntry.name;
    const entries = safeRead(
      await readDirectory(home, ['.dshpack', 'generations', profile]),
      'E_UNINSTALL_GENERATION',
      'generation files cannot be enumerated securely.',
      join(dshHome, '.dshpack', 'generations', profile),
    );
    const sequences = new Set<number>();
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        fail(
          EXIT_CODES.SECURITY,
          'E_UNINSTALL_GENERATION',
          'generation state contains a non-regular entry.',
          'Repair generation state before retrying.',
          join(dshHome, '.dshpack', 'generations', profile, entry.name),
        );
      }
      if (entry.name === 'current') {
        if (profile !== targetProfile) continue;
        const document = safeRead(
          await readText(
            home,
            ['.dshpack', 'generations', profile, 'current'],
            {},
            MAX_TRANSACTION_STATE_BYTES,
          ),
          'E_UNINSTALL_GENERATION',
          'generation current pointer cannot be read securely.',
          join(dshHome, '.dshpack', 'generations', profile, 'current'),
        );
        if (!/^[1-9]\d*\n$/u.test(document.text)) {
          fail(
            EXIT_CODES.CONTRACT,
            'E_UNINSTALL_GENERATION',
            'generation current pointer is invalid.',
            'Repair generation state before retrying.',
            join(dshHome, '.dshpack', 'generations', profile, 'current'),
          );
        }
        current = {
          path: join(dshHome, '.dshpack', 'generations', profile, 'current'),
          relative: ['.dshpack', 'generations', profile, 'current'].join('/'),
          sha256: sha256(Buffer.from(document.text, 'utf8')),
          identity: document.identity,
        };
        const sequence = Number(document.text.slice(0, -1));
        if (!Number.isSafeInteger(sequence) || sequence < 1) {
          fail(
            EXIT_CODES.CONTRACT,
            'E_UNINSTALL_GENERATION',
            'generation current pointer is outside the safe positive range.',
            'Repair generation state before retrying.',
            join(dshHome, '.dshpack', 'generations', profile, 'current'),
          );
        }
        currentSequence = sequence;
        continue;
      }
      const sequence = sequenceFromFilename(entry.name);
      if (sequence === undefined || sequences.has(sequence)) {
        fail(
          EXIT_CODES.CONTRACT,
          'E_UNINSTALL_GENERATION',
          'generation state contains an invalid filename.',
          'Repair generation state before retrying.',
          join(dshHome, '.dshpack', 'generations', profile, entry.name),
        );
      }
      sequences.add(sequence);
      const path = join(dshHome, '.dshpack', 'generations', profile, entry.name);
      const bytes = safeRead(
        await readBytes(
          home,
          ['.dshpack', 'generations', profile, entry.name],
          {},
          MAX_TRANSACTION_STATE_BYTES,
        ),
        'E_UNINSTALL_GENERATION',
        'generation document cannot be read securely.',
        path,
      );
      const document = await readGeneration(dshHome, profile, sequence);
      for (const generationEntry of document.entries)
        allEntries.push({ profile, sha256: generationEntry.sha256 });
      if (profile === targetProfile) {
        targetGenerations.push({
          path,
          relative: ['.dshpack', 'generations', profile, entry.name].join('/'),
          sha256: sha256(bytes.bytes),
          identity: bytes.identity,
        });
      }
    }
    safeRead(
      await revalidateDirectoryEntries(
        safeRead(
          await bindDirectory(home, ['.dshpack', 'generations', profile]),
          'E_UNINSTALL_GENERATION',
          'generation directory cannot be rebound securely.',
          join(dshHome, '.dshpack', 'generations', profile),
        ),
        entries,
      ),
      'E_UNINSTALL_GENERATION',
      'generation directory changed during the scan.',
      join(dshHome, '.dshpack', 'generations', profile),
    );
  }
  safeRead(
    await revalidateDirectoryEntries(root, profiles),
    'E_UNINSTALL_GENERATION',
    'generation root changed during the scan.',
    join(dshHome, '.dshpack', 'generations'),
  );
  if (targetGenerations.length === 0 || current === undefined) {
    fail(
      EXIT_CODES.CONTRACT,
      'E_UNINSTALL_GENERATION',
      'tracked v1 profile has incomplete generation history.',
      'Repair or migrate generation state before purging it.',
      join(dshHome, '.dshpack', 'generations', targetProfile),
    );
  }
  if (
    currentSequence === undefined ||
    !targetGenerations.some(({ path }) => path.endsWith(generationFilename(currentSequence)))
  ) {
    fail(
      EXIT_CODES.CONTRACT,
      'E_UNINSTALL_GENERATION',
      'generation current does not reference a retained generation file.',
      'Repair generation state before retrying.',
      current.path,
    );
  }
  const referencedByOtherProfiles = new Set(
    allEntries.filter((entry) => entry.profile !== targetProfile).map((entry) => entry.sha256),
  );
  const targetDigests = new Set(
    allEntries.filter((entry) => entry.profile === targetProfile).map((entry) => entry.sha256),
  );
  const blocks: PlannedStateFile[] = [];
  for (const digest of [...targetDigests].sort((left, right) => left.localeCompare(right, 'en'))) {
    if (referencedByOtherProfiles.has(digest)) continue;
    const path = join(dshHome, '.dshpack', 'store', casStoreShard(digest), digest);
    const block = safeRead(
      await readBytes(
        home,
        ['.dshpack', 'store', casStoreShard(digest), digest],
        {},
        MAX_TRANSACTION_STATE_BYTES,
      ),
      'E_UNINSTALL_CAS',
      'CAS block cannot be read securely.',
      path,
    );
    const verified = await readCasBlock(dshHome, digest);
    if (sha256(block.bytes) !== digest || !Buffer.from(block.bytes).equals(verified)) {
      fail(
        EXIT_CODES.CONTRACT,
        'E_UNINSTALL_CAS',
        'CAS block does not match its referenced digest.',
        'Repair the CAS store before retrying.',
        path,
      );
    }
    blocks.push({
      path,
      relative: ['.dshpack', 'store', casStoreShard(digest), digest].join('/'),
      sha256: digest,
      identity: block.identity,
    });
  }
  return {
    current,
    generations: targetGenerations.sort((left, right) => left.path.localeCompare(right.path, 'en')),
    blocks,
  };
}

function warnings(plan: UninstallPlan): ReturnType<typeof diagnostic>[] {
  return [
    ...plan.assets
      .filter((asset) => asset.action === 'delete' && asset.reason === 'force-modified')
      .map((asset) =>
        diagnostic(
          'W_UNINSTALL_ASSET_FORCE_REMOVED',
          'warning',
          `${asset.target} was force-removed after it was modified.`,
          'Its pre-removal contents were placed in the transaction backup.',
        ),
      ),
    ...plan.assets
      .filter((asset) => asset.action === 'retain' || asset.action === 'missing')
      .map((asset) =>
        diagnostic(
          'W_UNINSTALL_ASSET_RETAINED',
          'warning',
          `${asset.target} was ${asset.action === 'missing' ? 'already missing' : 'retained'} (${asset.reason}).`,
          'Review the retained target before deleting it manually.',
        ),
      ),
    ...plan.settings.retained.map((key) =>
      diagnostic(
        'W_UNINSTALL_SETTINGS_RETAINED',
        'warning',
        `agent-presets.${terminalSafeText(key)} was retained because it no longer matches the recorded contribution.`,
        'Review the key manually if it should be removed.',
      ),
    ),
  ];
}

function postUninstallOwnership(marker: TrackedMarker) {
  return {
    profile: marker.profile,
    assets: marker.metadata.metadataVersion === 1 ? marker.metadata.assets : [],
  };
}

/** Run strict doctor before commit, while a failed verification can still roll back every change. */
async function verifyPostUninstall(
  dshHome: string,
  marker: TrackedMarker,
  doctorRunner: (input: DoctorInput) => Promise<CommandReport<DoctorMetadata>>,
): Promise<readonly Diagnostic[]> {
  let report: CommandReport<DoctorMetadata>;
  try {
    report = await doctorRunner({ dshHome, strict: true, yes: true, fix: false });
  } catch {
    throw new TransactionFailure(EXIT_CODES.POST_INSTALL_VERIFY_FAILURE, [
      diagnostic(
        'E_UNINSTALL_DOCTOR',
        'error',
        'strict doctor could not complete after uninstall.',
        'The transaction was rolled back; inspect doctor and retry.',
      ),
    ]);
  }
  const ours: Diagnostic[] = [];
  const preexisting: Diagnostic[] = [];
  for (const item of report.diagnostics)
    (attributableToInstall(item, dshHome, postUninstallOwnership(marker))
      ? ours
      : preexisting
    ).push(item);
  if (ours.some((item) => item.severity === 'error'))
    throw new TransactionFailure(EXIT_CODES.POST_INSTALL_VERIFY_FAILURE, ours);
  if (report.exitCode !== EXIT_CODES.SUCCESS && report.diagnostics.length === 0)
    throw new TransactionFailure(EXIT_CODES.POST_INSTALL_VERIFY_FAILURE, [
      diagnostic(
        'E_UNINSTALL_DOCTOR',
        'error',
        'strict doctor failed without diagnostics after uninstall.',
        'The transaction was rolled back; inspect doctor and retry.',
      ),
    ]);
  if (preexisting.length === 0) return [];
  return [
    diagnostic(
      'W_UNINSTALL_DOCTOR_PREEXISTING',
      'warning',
      `doctor reported ${preexisting.length} preexisting issue(s) outside this uninstall scope.`,
      'Review them separately with dshpack doctor --strict.',
    ),
  ];
}

/** Uninstall one managed profile without deleting any unproven user-owned content. */
export async function uninstallProfile(
  input: UninstallInput,
  dependencies: UninstallDependencies = {},
): Promise<UninstallReport> {
  const resolution = resolveDshHomeValue(input.dshHome);
  if (!resolution.ok) return { ...resolution.report, metadata: metadataReport(input) };
  const normalized = { ...input, dshHome: resolution.value };
  try {
    const scan = await scanTrackedMetadata(normalized.dshHome, normalized.profile);
    const plan = await buildPlan(normalized, scan);
    const preflightPurge =
      normalized.purgeGenerations === true && plan.marker.metadata.metadataVersion === 1
        ? await buildPurgePlan(normalized.dshHome, normalized.profile)
        : undefined;
    const base = (activePlan: UninstallPlan, purge: PurgePlan | undefined = preflightPurge) =>
      metadataReport(normalized, {
        assets: activePlan.assets,
        legacyProfiles: activePlan.legacyProfiles,
        settingsRemoved: activePlan.settings.removed,
        settingsRetained: activePlan.settings.retained,
        ...planStateActions(activePlan),
        ...(purge === undefined
          ? {}
          : {
              deletedGenerations: purge.generations.map((generation) => generation.relative),
              deletedBlocks: purge.blocks.map((block) => block.sha256),
            }),
      });
    if (normalized.dryRun === true)
      return { diagnostics: warnings(plan), exitCode: EXIT_CODES.SUCCESS, metadata: base(plan) };
    if (normalized.yes !== true) {
      return {
        diagnostics: [
          diagnostic(
            'E_UNINSTALL_CONFIRM_REQUIRED',
            'error',
            'uninstall would modify managed files and requires --yes in non-interactive mode.',
            'Review with --dry-run, then rerun with --yes.',
          ),
        ],
        exitCode: EXIT_CODES.USER_DECLINED,
        metadata: base(plan),
      };
    }
    const adapter = dependencies.createAdapter?.() ?? createNodeTransactionAdapter();
    const txid =
      dependencies.createTxid?.() ??
      `${normalized.purgeGenerations === true ? 'uninstall-purge' : 'uninstall'}-${randomUUID()}`;
    if (normalized.purgeGenerations === true && !isUninstallPurgeTransactionId(txid)) {
      return {
        diagnostics: [
          diagnostic(
            'E_UNINSTALL_PURGE_TXID',
            'error',
            'purge transaction identifiers must use the uninstall-purge-* namespace.',
            'Retry without a custom transaction identifier.',
          ),
        ],
        exitCode: EXIT_CODES.CONTRACT,
        metadata: base(plan),
      };
    }
    let executedPlan = plan;
    let postDoctorDiagnostics: readonly Diagnostic[] = [];
    const transaction = await runTransaction(
      {
        adapter,
        dshHome: normalized.dshHome,
        txid,
        ...(normalized.purgeGenerations === true ? { purpose: 'uninstall-purge' as const } : {}),
      },
      async (tx) => {
        // The preflight plan is for dry-run and confirmation. Rebuild after the DSH_HOME-wide
        // transaction lease is held, so a writer that changed an asset meanwhile cannot turn an
        // intact deletion into removal of its newer user-owned content.
        const lockedScan = await scanTrackedMetadata(normalized.dshHome, normalized.profile);
        const lockedPlan = await buildPlan(normalized, lockedScan);
        const lockedPurge =
          normalized.purgeGenerations === true && lockedPlan.marker.metadata.metadataVersion === 1
            ? await buildPurgePlan(normalized.dshHome, normalized.profile)
            : undefined;
        executedPlan = lockedPlan;
        let profileRemoved = lockedPlan.assets.some(
          (asset) => asset.target === `profiles/${normalized.profile}` && asset.action === 'delete',
        );
        if (lockedPlan.marker.metadata.metadataVersion === 0) {
          const profilePath = join(normalized.dshHome, 'profiles', normalized.profile);
          // A forced legacy cleanup may find that the user already removed the only
          // unprovable asset. Do not enqueue a failing replace action: transaction
          // actions are intentionally fail-sticky so catching one would still poison
          // the surrounding transaction.
          try {
            await lstat(profilePath);
            const expectedIdentity = await tx.artifactIdentity('profile', profilePath);
            await tx.replaceProfile(profilePath, expectedIdentity);
            profileRemoved = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            profileRemoved = false;
          }
        }
        for (const asset of lockedPlan.assets) {
          if (asset.action !== 'delete') continue;
          // Only v1 observed directory assets can have a delete outcome.  `buildPlan` captures
          // both their marker source and the locked-scan identity before constructing this list.
          const source = resolveUninstallDeleteSource(lockedPlan.marker.metadata, asset.target);
          const expectedIdentity = lockedPlan.assetIdentities.get(source.target);
          if (expectedIdentity === undefined)
            fail(
              EXIT_CODES.CONTRACT,
              'E_UNINSTALL_IDENTITY',
              `Uninstall plan has no locked identity for ${source.target}.`,
              'Retry uninstall; no files were replaced.',
              targetPath(normalized.dshHome, source.target),
            );
          await tx.replaceArtifact(
            source.kind,
            targetPath(normalized.dshHome, source.target),
            expectedIdentity,
          );
        }
        if (
          lockedPlan.settings.replacement !== undefined &&
          lockedPlan.settings.expected !== undefined
        )
          await tx.writeSettings(
            join(normalized.dshHome, 'settings.yaml'),
            lockedPlan.settings.expected,
            lockedPlan.settings.replacement,
          );
        let sequence: number | undefined;
        if (lockedPurge !== undefined) {
          await tx.deleteStateFile(
            'generation-current',
            lockedPurge.current.path,
            lockedPurge.current.sha256,
            lockedPurge.current.identity,
          );
          for (const generation of lockedPurge.generations)
            await tx.deleteStateFile(
              'generation',
              generation.path,
              generation.sha256,
              generation.identity,
            );
          for (const block of lockedPurge.blocks)
            await tx.deleteStateFile('store-block', block.path, block.sha256, block.identity);
        } else if (lockedPlan.marker.metadata.metadataVersion === 1) {
          const allocation = await nextGeneration(tx, normalized.dshHome, normalized.profile);
          sequence = allocation.sequence;
          await writeGeneration(tx, normalized.dshHome, normalized.profile, {
            seq: allocation.sequence,
            txid,
            createdAt: dependencies.now?.() ?? new Date().toISOString(),
            operation: 'uninstall',
            pack: { ...lockedPlan.marker.metadata.pack },
            source: { ...lockedPlan.marker.metadata.source },
            entries: [],
            settingsContribution: { namespace: 'agent-presets', keys: [] },
            metadata: null,
            restorable: true,
          });
          await advanceCurrent(
            tx,
            allocation.currentPath,
            allocation.previous,
            allocation.sequence,
          );
        }
        await tx.deleteManagedDocument(
          join(normalized.dshHome, '.dshpack', 'installed', `${normalized.profile}.json`),
          lockedPlan.marker.document,
          lockedPlan.marker.identity,
        );
        postDoctorDiagnostics = await verifyPostUninstall(
          normalized.dshHome,
          lockedPlan.marker,
          dependencies.runDoctor ?? runDoctor,
        );
        return { sequence, purge: lockedPurge, profileRemoved };
      },
    );
    if (!transaction.ok) {
      // `runTransaction` can report a committed exit 25 if its final lease release fails.  The
      // mutation is durable in that case; preserve the closure's facts so JSON/human output does
      // not falsely claim the profile remains installed and invite an unsafe retry.
      const committed = transaction.status === 'committed' ? transaction.value : undefined;
      const committedPurgePending = committed?.purge !== undefined;
      return {
        diagnostics: [
          ...transaction.diagnostics,
          ...(committedPurgePending
            ? [
                diagnostic(
                  'W_UNINSTALL_PURGE_PENDING',
                  'warning',
                  'uninstall committed generation removal, but physical reclamation is pending.',
                  'After resolving the artifact lock, run dshpack gc to complete verified physical reclamation.',
                ),
              ]
            : []),
        ],
        exitCode: transaction.exitCode,
        metadata: metadataReport(normalized, {
          ...base(executedPlan, committed?.purge),
          ...(committed === undefined
            ? {}
            : {
                removedMarker: true,
                activation: committed.profileRemoved === true ? 'profile-removed' : 'unchanged',
                ...(committed.sequence === undefined ? {} : { generation: committed.sequence }),
                ...(committedPurgePending ? { pendingPurge: true } : {}),
              }),
          backupDirectory: transaction.backupDirectory,
          manualRecovery: transaction.manualRecovery,
        }),
      };
    }
    const purgeWarnings: Diagnostic[] = [];
    if (transaction.value?.purge !== undefined) {
      try {
        await purgeCommittedStateQuarantine(normalized.dshHome, adapter, txid);
      } catch (error) {
        // A failed verified-purge is retryable only while ownership remains unambiguous.  Lock
        // release/manual-recovery failures deliberately remain exit 25 even though uninstall's
        // active-state mutation has committed, so callers never mistake a stranded lease for a
        // successful pending cleanup.
        if (error instanceof GcFailure && error.manualRecovery.length > 0) {
          return {
            diagnostics: [
              diagnostic(
                error.code,
                'error',
                error.message,
                'Inspect the artifact lock before retrying physical purge.',
              ),
            ],
            exitCode: error.exitCode,
            metadata: metadataReport(normalized, {
              ...base(executedPlan, transaction.value.purge),
              removedMarker: true,
              activation:
                transaction.value.profileRemoved === true ? 'profile-removed' : 'unchanged',
              backupDirectory: transaction.backupDirectory,
              manualRecovery: error.manualRecovery,
            }),
          };
        }
        purgeWarnings.push(
          diagnostic(
            'W_UNINSTALL_PURGE_PENDING',
            'warning',
            'uninstall committed generation removal, but verified physical reclamation is pending.',
            'Run dshpack gc after resolving the quarantine condition; retained user-content backups were not removed.',
          ),
        );
      }
    }
    return {
      diagnostics: [...warnings(executedPlan), ...postDoctorDiagnostics, ...purgeWarnings],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: metadataReport(normalized, {
        ...base(executedPlan, transaction.value?.purge),
        removedMarker: true,
        activation: transaction.value?.profileRemoved === true ? 'profile-removed' : 'unchanged',
        ...(purgeWarnings.length === 0 ? {} : { pendingPurge: true }),
        ...(transaction.value?.sequence === undefined
          ? {}
          : { generation: transaction.value.sequence }),
        backupDirectory: transaction.backupDirectory,
      }),
    };
  } catch (error) {
    return reportFailure(normalized, error);
  }
}
