import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { type PackLock, validateLockValue, validatePackPath } from '@dshpack/core';
import { valid } from 'semver';
import { isAgentPresetLeafKey } from '../adapters/settings.js';
import { assertPortableSnapshotPath, portableSnapshotPathKey } from '../install/snapshot-path.js';

export const PROFILE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
export const MODULE_FALLBACK = 'node_modules';
const RESERVED_PROFILES = new Set(['web', 'headless']);
const TRAVERSAL_NAMES = new Set(['', '.', '..']);
const PRESET_NAME = /^[a-z0-9][a-z0-9-]*$/u;
const RESERVED_PRESETS = new Set(['standard', 'code', 'minimal', 'cordis']);
const ASSET_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SHA256 = /^sha256-[A-Za-z0-9_-]{43}$/u;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const GITHUB_REPO = /^[A-Za-z0-9._-]+$/u;
const TXID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const IDENTITY = /^\d+:\d+:\d+$/u;

export interface InstalledPluginMetadata {
  name: string;
  packageJsonSha512: string;
  bundlePatch: string;
  actualResolved: Readonly<Record<string, unknown>>;
  actualIntegrity: Readonly<Record<string, unknown>>;
}

export interface InstalledMetadataV0 {
  metadataVersion: 0;
  profile: string;
  pack: { name: string; version: string; manifestDigest: string };
  planDigest: string;
  installedAt: string;
  txid: string;
  source: Readonly<Record<string, unknown>>;
  defaults: {
    agentPreset?: string;
    permissionPreset: 'workspace-write' | 'danger-full-access';
  };
  plugins: readonly InstalledPluginMetadata[];
  effectiveLock: PackLock;
  sideEffects: readonly ['profile/cordis.yml'];
}

export type MetadataAssetKind = 'skill' | 'preset' | 'profile' | 'managed-document';
export type MetadataAssetAction = 'create' | 'replace' | 'skip';

export interface MetadataAssetFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface MetadataAsset {
  id: string;
  kind: MetadataAssetKind;
  target: string;
  action: MetadataAssetAction;
  /** Identity follows the transaction adapter's dev:ino:birthtimeNs format. */
  identity: string;
  files: readonly MetadataAssetFile[];
}

export interface SettingsContribution {
  namespace: 'agent-presets';
  keys: readonly { key: string; valueSha256: string }[];
}

export interface InstalledMetadataV1 extends Omit<InstalledMetadataV0, 'metadataVersion'> {
  metadataVersion: 1;
  assets: readonly MetadataAsset[];
  settingsContribution: SettingsContribution;
  generation: number;
  installedBy: string;
}

export type InstalledMetadata = InstalledMetadataV0 | InstalledMetadataV1;
export type MetadataReadMode = 'legacy' | 'full';

export type ParsedInstalledMetadata =
  | { ok: true; metadata: InstalledMetadata; mode: MetadataReadMode }
  | { ok: false; reason?: 'profile-mismatch' };

export type AssetDrift = 'intact' | 'modified' | 'missing';

export interface ObservedAsset {
  identity: string;
  files: readonly MetadataAssetFile[];
}

export function isReservedProfileName(name: string): boolean {
  return RESERVED_PROFILES.has(name);
}

/** Whether `name` addresses a directory inside `profiles/` instead of escaping it. */
export function isAddressableProfileName(name: string): boolean {
  return !TRAVERSAL_NAMES.has(name) && !name.includes('/') && !name.includes('\\');
}

/** Whether dshpack may create and own a profile with this name. */
export function isInstallableProfileName(name: string): boolean {
  return (
    name.length >= 3 &&
    name.length <= 64 &&
    PROFILE_NAME.test(name) &&
    !isReservedProfileName(name) &&
    name !== MODULE_FALLBACK &&
    isAddressableProfileName(name)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validSemver(value: unknown): value is string {
  return typeof value === 'string' && valid(value) === value;
}

function validHttps(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function validSource(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'directory' || value.kind === 'archive')
    return (
      exactKeys(value, ['kind', 'path']) && typeof value.path === 'string' && isAbsolute(value.path)
    );
  if (value.kind === 'https')
    return (
      exactKeys(value, ['kind', 'url', 'integrity']) &&
      validHttps(value.url) &&
      typeof value.integrity === 'string' &&
      SHA512.test(value.integrity)
    );
  if (
    value.kind !== 'github' ||
    !exactKeys(value, ['kind', 'owner', 'repo', 'commit', 'url']) ||
    typeof value.owner !== 'string' ||
    !GITHUB_OWNER.test(value.owner) ||
    typeof value.repo !== 'string' ||
    !GITHUB_REPO.test(value.repo) ||
    value.repo === '.' ||
    value.repo === '..' ||
    typeof value.commit !== 'string' ||
    !COMMIT.test(value.commit) ||
    typeof value.url !== 'string'
  )
    return false;
  return (
    value.url === `https://codeload.github.com/${value.owner}/${value.repo}/tar.gz/${value.commit}`
  );
}

function validResolved(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (exactKeys(value, ['version'])) return validSemver(value.version);
  if (exactKeys(value, ['commit']))
    return typeof value.commit === 'string' && COMMIT.test(value.commit);
  return exactKeys(value, ['url']) && validHttps(value.url);
}

function validIntegrity(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (value.kind === 'unverified')
    return (
      exactKeys(value, ['kind', 'reason']) &&
      typeof value.reason === 'string' &&
      value.reason.trim() !== ''
    );
  if (!exactKeys(value, ['kind', 'value']) || typeof value.value !== 'string') return false;
  if (value.kind === 'git-commit') return COMMIT.test(value.value);
  return (value.kind === 'npm-sri' || value.kind === 'sha512') && SHA512.test(value.value);
}

function validPluginFact(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'name',
      'packageJsonSha512',
      'bundlePatch',
      'actualResolved',
      'actualIntegrity',
    ]) ||
    typeof value.name !== 'string' ||
    !NPM_PACKAGE.test(value.name) ||
    typeof value.packageJsonSha512 !== 'string' ||
    !SHA512.test(value.packageJsonSha512) ||
    typeof value.bundlePatch !== 'string' ||
    !validatePackPath(value.bundlePatch.replace(/^\.\//u, '')).ok ||
    !validResolved(value.actualResolved) ||
    !validIntegrity(value.actualIntegrity)
  )
    return false;
  const resolved = value.actualResolved;
  const integrity = value.actualIntegrity;
  if (integrity.kind === 'unverified') return true;
  if ('version' in resolved) return integrity.kind === 'npm-sri';
  if ('commit' in resolved)
    return integrity.kind === 'git-commit' && resolved.commit === integrity.value;
  return integrity.kind === 'sha512';
}

function validInstalledAt(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validGeneratedAt(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validGeneratedBy(value: string): boolean {
  if (!value.startsWith('dshpack@')) return false;
  const version = value.slice('dshpack@'.length);
  return valid(version) === version;
}

function validLockFiles(lock: PackLock): boolean {
  const paths = new Set<string>();
  for (const file of lock.files) {
    if (!isPortableAssetPath(file.path)) return false;
    const portablePath = portableSnapshotPathKey(file.path);
    if (portablePath === 'pack.yml' || portablePath === 'pack.lock.yml' || paths.has(portablePath))
      return false;
    paths.add(portablePath);
  }
  return true;
}

function matchingPlugins(lock: PackLock, installed: readonly InstalledPluginMetadata[]): boolean {
  if (lock.plugins.length !== installed.length) return false;
  return lock.plugins.every((plugin, index) => {
    const fact = installed[index];
    return (
      fact !== undefined &&
      plugin.name === fact.name &&
      isDeepStrictEqual(plugin.resolved, fact.actualResolved) &&
      isDeepStrictEqual(plugin.integrity, fact.actualIntegrity) &&
      plugin.packageJsonSha512 === fact.packageJsonSha512 &&
      plugin.bundlePatch === fact.bundlePatch
    );
  });
}

export function validEffectiveLock(
  value: unknown,
  manifestDigest: string,
  installedAt: string,
  installed: readonly InstalledPluginMetadata[],
): value is PackLock {
  const parsed = validateLockValue(value);
  if (!parsed.ok || parsed.value === undefined) return false;
  const lock = parsed.value;
  return (
    lock.manifestSha256 === manifestDigest &&
    lock.generatedAt === installedAt &&
    validGeneratedAt(lock.generatedAt) &&
    validGeneratedBy(lock.generatedBy) &&
    valid(lock.dsh.exportedFrom) === lock.dsh.exportedFrom &&
    validLockFiles(lock) &&
    matchingPlugins(lock, installed)
  );
}

function validV0(value: unknown): value is InstalledMetadataV0 {
  if (!isRecord(value)) return false;
  const pack = value.pack;
  const defaults = value.defaults;
  const agentPreset = isRecord(defaults) ? defaults.agentPreset : undefined;
  return (
    exactKeys(value, [
      'metadataVersion',
      'profile',
      'pack',
      'planDigest',
      'installedAt',
      'txid',
      'source',
      'defaults',
      'plugins',
      'effectiveLock',
      'sideEffects',
    ]) &&
    value.metadataVersion === 0 &&
    typeof value.profile === 'string' &&
    isInstallableProfileName(value.profile) &&
    isRecord(pack) &&
    exactKeys(pack, ['name', 'version', 'manifestDigest']) &&
    typeof pack.name === 'string' &&
    isInstallableProfileName(pack.name) &&
    validSemver(pack.version) &&
    typeof pack.manifestDigest === 'string' &&
    SHA256.test(pack.manifestDigest) &&
    typeof value.planDigest === 'string' &&
    SHA256.test(value.planDigest) &&
    validInstalledAt(value.installedAt) &&
    typeof value.txid === 'string' &&
    TXID.test(value.txid) &&
    validSource(value.source) &&
    isRecord(defaults) &&
    exactKeys(
      defaults,
      agentPreset === undefined ? ['permissionPreset'] : ['agentPreset', 'permissionPreset'],
    ) &&
    (agentPreset === undefined ||
      (typeof agentPreset === 'string' &&
        PRESET_NAME.test(agentPreset) &&
        !RESERVED_PRESETS.has(agentPreset))) &&
    (defaults.permissionPreset === 'workspace-write' ||
      defaults.permissionPreset === 'danger-full-access') &&
    Array.isArray(value.plugins) &&
    value.plugins.every(validPluginFact) &&
    validEffectiveLock(
      value.effectiveLock,
      pack.manifestDigest,
      value.installedAt,
      value.plugins,
    ) &&
    Array.isArray(value.sideEffects) &&
    value.sideEffects.length === 1 &&
    value.sideEffects[0] === 'profile/cordis.yml'
  );
}

/** The portable key shared by validation and reference counting on case-insensitive filesystems. */
export function portableTargetKey(target: string): string {
  try {
    assertPortableSnapshotPath(target);
  } catch {
    throw new Error('metadata asset target is not a safe relative path');
  }
  return portableSnapshotPathKey(target);
}

function targetMatchesKind(
  kind: MetadataAssetKind,
  id: string,
  target: string,
  profile: string,
): boolean {
  if (!isPortableAssetPath(target)) return false;
  if (kind === 'skill') return target === `skills/${id}`;
  if (kind === 'preset') return target === `.agent-presets/${id}`;
  if (kind === 'profile') return id === profile && target === `profiles/${profile}`;
  // The installed marker contains this asset manifest, so treating it as an asset would require
  // an unwriteable self-fingerprint. Managed documents deliberately live outside that marker.
  return target === `.dshpack/managed/${id}.json`;
}

function isPortableAssetPath(path: string): boolean {
  try {
    assertPortableSnapshotPath(path);
    return true;
  } catch {
    return false;
  }
}

function validAssetFile(value: unknown): value is MetadataAssetFile {
  return (
    isRecord(value) &&
    exactKeys(value, ['path', 'sha256', 'bytes']) &&
    typeof value.path === 'string' &&
    isPortableAssetPath(value.path) &&
    typeof value.sha256 === 'string' &&
    SHA256.test(value.sha256) &&
    typeof value.bytes === 'number' &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0
  );
}

function uniquePaths(files: readonly MetadataAssetFile[]): boolean {
  const paths = new Set<string>();
  for (const file of files) {
    const path = portableSnapshotPathKey(file.path);
    if (paths.has(path)) return false;
    paths.add(path);
  }
  return true;
}

function validAsset(value: unknown, profile: string): value is MetadataAsset {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['id', 'kind', 'target', 'action', 'identity', 'files']) ||
    typeof value.id !== 'string' ||
    !ASSET_ID.test(value.id) ||
    (value.kind !== 'skill' &&
      value.kind !== 'preset' &&
      value.kind !== 'profile' &&
      value.kind !== 'managed-document') ||
    typeof value.target !== 'string' ||
    !targetMatchesKind(value.kind, value.id, value.target, profile) ||
    (value.action !== 'create' && value.action !== 'replace' && value.action !== 'skip') ||
    typeof value.identity !== 'string' ||
    !IDENTITY.test(value.identity) ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    !value.files.every(validAssetFile)
  )
    return false;
  return uniquePaths(value.files);
}

/** Shared validator for persisted metadata and generation settings facts. */
export function isValidSettingsContribution(value: unknown): value is SettingsContribution {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['namespace', 'keys']) ||
    value.namespace !== 'agent-presets' ||
    !Array.isArray(value.keys)
  )
    return false;
  const keys = new Set<string>();
  return value.keys.every((entry) => {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ['key', 'valueSha256']) ||
      !isAgentPresetLeafKey(entry.key) ||
      typeof entry.valueSha256 !== 'string' ||
      !SHA256.test(entry.valueSha256) ||
      keys.has(entry.key)
    )
      return false;
    keys.add(entry.key);
    return true;
  });
}

function validV1(value: unknown): value is InstalledMetadataV1 {
  const profile = isRecord(value) && typeof value.profile === 'string' ? value.profile : '';
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'metadataVersion',
      'profile',
      'pack',
      'planDigest',
      'installedAt',
      'txid',
      'source',
      'defaults',
      'plugins',
      'effectiveLock',
      'sideEffects',
      'assets',
      'settingsContribution',
      'generation',
      'installedBy',
    ]) ||
    value.metadataVersion !== 1 ||
    !Array.isArray(value.assets) ||
    value.assets.length === 0 ||
    !value.assets.every((asset) => validAsset(asset, profile)) ||
    !isValidSettingsContribution(value.settingsContribution) ||
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    typeof value.installedBy !== 'string' ||
    !validGeneratedBy(value.installedBy)
  )
    return false;
  const ids = new Set<string>();
  for (const asset of value.assets) {
    const id = `${asset.kind}:${asset.id.toLocaleLowerCase('en-US')}`;
    if (ids.has(id)) return false;
    ids.add(id);
  }
  const {
    assets: _assets,
    generation: _generation,
    installedBy: _installedBy,
    settingsContribution: _settings,
    ...base
  } = value;
  return validV0({ ...base, metadataVersion: 0 });
}

/** Parse only records that retain the complete v0 baseline plus their declared version's fields. */
export function parseInstalledMetadata(value: unknown, profile: string): ParsedInstalledMetadata {
  if (!isRecord(value)) return { ok: false };
  if (typeof value.profile === 'string' && value.profile !== profile)
    return { ok: false, reason: 'profile-mismatch' };
  if (value.metadataVersion === 0 && validV0(value))
    return { ok: true, metadata: value, mode: 'legacy' };
  if (value.metadataVersion === 1 && validV1(value))
    return { ok: true, metadata: value, mode: 'full' };
  return { ok: false };
}

/** The only three-way eligibility gate: legacy records lack a trustworthy base. */
export function assessThreeWayEligibility(
  metadata: InstalledMetadata,
): { eligible: true } | { eligible: false; reason: 'legacy-metadata'; hint: string } {
  if (metadata.metadataVersion === 1) return { eligible: true };
  return {
    eligible: false,
    reason: 'legacy-metadata',
    hint: `dshpack migrate ${metadata.profile}`,
  };
}

/**
 * Compare the recorded transaction identity and the complete recursively-expanded file set.
 * A missing file wins over all other observations so callers can safely report deletion.
 */
export function classifyAssetDrift(
  expected: MetadataAsset,
  observed: ObservedAsset | undefined,
): AssetDrift {
  if (observed === undefined) return 'missing';
  const expectedByPath = indexAssetFiles(expected.files);
  const actualByPath = indexAssetFiles(observed.files);
  if (expected.files.some((file) => !actualByPath.files.has(portableSnapshotPathKey(file.path))))
    return 'missing';
  if (expectedByPath.hasCollision || actualByPath.hasCollision) return 'modified';
  if (observed.identity !== expected.identity || observed.files.length !== expected.files.length)
    return 'modified';
  return expected.files.every((file) => {
    const actual = actualByPath.files.get(portableSnapshotPathKey(file.path));
    return actual?.sha256 === file.sha256 && actual.bytes === file.bytes;
  })
    ? 'intact'
    : 'modified';
}

function indexAssetFiles(files: readonly MetadataAssetFile[]): {
  files: Map<string, MetadataAssetFile>;
  hasCollision: boolean;
} {
  const byPath = new Map<string, MetadataAssetFile>();
  let hasCollision = false;
  for (const file of files) {
    const key = portableSnapshotPathKey(file.path);
    if (byPath.has(key)) hasCollision = true;
    else byPath.set(key, file);
  }
  return { files: byPath, hasCollision };
}

/** Count ownership claims by relative DSH_HOME target. */
export function countTargetReferences(
  collections: Iterable<readonly { target: string }[]>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entries of collections)
    for (const entry of entries) {
      const target = portableTargetKey(entry.target);
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
  return counts;
}

export interface MetadataTargetReferenceSummary {
  /** Portable v1 ownership claim counts. */
  counts: Map<string, number>;
  /** Legacy records have no asset inventory, so destructive consumers must remain conservative. */
  legacyProfiles: readonly string[];
}

/** Count v1 asset target claims and explicitly surface legacy ownership uncertainty. */
export function countMetadataAssetTargetReferences(
  metadata: Iterable<InstalledMetadata>,
): MetadataTargetReferenceSummary {
  const v1Assets: MetadataAsset[][] = [];
  const legacyProfiles: string[] = [];
  for (const entry of metadata) {
    if (entry.metadataVersion === 0) {
      legacyProfiles.push(entry.profile);
      continue;
    }
    v1Assets.push([...entry.assets]);
  }
  return { counts: countTargetReferences(v1Assets), legacyProfiles };
}
