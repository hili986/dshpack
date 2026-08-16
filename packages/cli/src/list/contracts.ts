import { isAbsolute, join } from 'node:path';

import { parseCanonicalYaml, validatePackPath } from '@dshpack/core';
import { valid } from 'semver';

import {
  bindDirectory,
  bindSecureRoot,
  type DirectoryBinding,
  readText,
  revalidateDirectory,
  type SafePathFailureKind,
  type SafePathHooks,
} from './safe-fs.js';

export const PROFILE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const RESERVED_PROFILES = new Set(['web', 'headless', '.', '..']);
const PRESET_NAME = /^[a-z0-9][a-z0-9-]*$/u;
const RESERVED_PRESETS = new Set(['standard', 'code', 'minimal', 'cordis']);
const SHA256 = /^sha256-[A-Za-z0-9_-]{43}$/u;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const GITHUB_REPO = /^[A-Za-z0-9._-]+$/u;
const TXID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

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
  sideEffects: readonly ['profile/cordis.yml'];
}

export type ProfileInspection =
  | { status: 'valid'; root: string; binding: DirectoryBinding }
  | { status: 'missing'; reason: string; failureKind: 'contract' }
  | { status: 'broken'; reason: string; failureKind: InspectionFailureKind };

export type MetadataInspection =
  | { status: 'valid'; metadata: InstalledMetadataV0 }
  | { status: 'missing' }
  | { status: 'broken'; reason: string; failureKind: InspectionFailureKind };

export type PresetInspection =
  | { status: 'valid' }
  | { status: 'missing' }
  | { status: 'broken'; reason: string; failureKind: InspectionFailureKind };

export type InspectionFailureKind = 'contract' | 'security' | 'environment';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function isSafeProfileName(name: string): boolean {
  return (
    name.length >= 3 && name.length <= 64 && PROFILE_NAME.test(name) && !RESERVED_PROFILES.has(name)
  );
}

function isSafePresetName(name: string): boolean {
  return PRESET_NAME.test(name) && !RESERVED_PRESETS.has(name);
}

function failureKind(kind: SafePathFailureKind): InspectionFailureKind {
  return kind === 'security' ? 'security' : 'environment';
}

function broken(reason: string, kind: InspectionFailureKind = 'contract'): ProfileInspection {
  return { status: 'broken', reason, failureKind: kind };
}

export async function inspectProfile(
  dshHome: string,
  profile: string,
  hooks: SafePathHooks = {},
): Promise<ProfileInspection> {
  if (!isSafeProfileName(profile)) return broken('profile 名称不符合安全规则。');
  const root = join(dshHome, 'profiles', profile);
  const home = await bindSecureRoot(dshHome, hooks);
  if (!home.ok)
    return home.kind === 'missing'
      ? { status: 'missing', reason: 'DSH_HOME 不存在。', failureKind: 'contract' }
      : broken(home.reason, failureKind(home.kind));
  const profileDirectory = await bindDirectory(home.value, ['profiles', profile], hooks);
  if (!profileDirectory.ok)
    return profileDirectory.kind === 'missing'
      ? { status: 'missing', reason: 'profile 不存在。', failureKind: 'contract' }
      : broken(profileDirectory.reason, failureKind(profileDirectory.kind));

  const paths = ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml'] as const;
  const files = [];
  for (const name of paths) {
    const file = await readText(home.value, ['profiles', profile, name], hooks);
    if (!file.ok)
      return file.kind === 'missing'
        ? broken('profile 缺少官方初始化基座文件。')
        : broken(file.reason, failureKind(file.kind));
    files.push(file.value.text);
  }
  const [packageText, patchText, workspaceText] = files as [string, string, string];

  let manifest: unknown;
  try {
    manifest = JSON.parse(packageText);
  } catch {
    return broken('profile package.json 不能解析。');
  }
  if (!isRecord(manifest)) return broken('profile package.json 顶层必须是 object。');
  if (manifest.name !== `dsh-profile-${profile}`)
    return broken('profile package.json.name 与最终目录名不一致。');
  const dsh = manifest.dsh;
  const profileConfig = isRecord(dsh) ? dsh.profile : undefined;
  const bundles = isRecord(profileConfig) ? profileConfig.bundles : undefined;
  if (
    manifest.private !== true ||
    !isStringRecord(manifest.dependencies) ||
    !isStringArray(bundles) ||
    new Set(bundles).size !== bundles.length
  )
    return broken('profile package.json 契约不合法。');

  const patch = parseCanonicalYaml(patchText, { allowJsTag: true });
  if (!patch.ok || !Array.isArray(patch.value?.value))
    return broken('profile cordis.patch.yml 顶层必须是 array。');
  const workspace = parseCanonicalYaml(workspaceText);
  const workspaceValue = workspace.value?.value;
  if (
    !workspace.ok ||
    !isRecord(workspaceValue) ||
    !Array.isArray(workspaceValue.packages) ||
    workspaceValue.packages.length !== 1 ||
    workspaceValue.packages[0] !== '.' ||
    workspaceValue.nodeLinker !== 'hoisted' ||
    workspaceValue.autoInstallPeers !== false
  )
    return broken('profile pnpm-workspace.yaml 不符合官方初始化基座。');
  const stable = await revalidateDirectory(profileDirectory.value, hooks);
  if (!stable.ok) return broken(stable.reason, 'security');
  return { status: 'valid', root, binding: profileDirectory.value };
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

function parseInstalledMetadata(value: unknown, profile: string): MetadataInspection {
  if (!isRecord(value))
    return {
      status: 'broken',
      reason: 'installed metadata 格式不合法。',
      failureKind: 'contract',
    };
  if (value.profile !== profile)
    return {
      status: 'broken',
      reason: 'installed metadata 的 profile 与文件名不一致。',
      failureKind: 'contract',
    };
  const pack = value.pack;
  const defaults = value.defaults;
  const agentPreset = isRecord(defaults) ? defaults.agentPreset : undefined;
  if (
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
      'sideEffects',
    ]) ||
    value.metadataVersion !== 0 ||
    !isRecord(pack) ||
    !exactKeys(pack, ['name', 'version', 'manifestDigest']) ||
    typeof pack.name !== 'string' ||
    !isSafeProfileName(pack.name) ||
    !validSemver(pack.version) ||
    typeof pack.manifestDigest !== 'string' ||
    !SHA256.test(pack.manifestDigest) ||
    typeof value.planDigest !== 'string' ||
    !SHA256.test(value.planDigest) ||
    !validInstalledAt(value.installedAt) ||
    typeof value.txid !== 'string' ||
    !TXID.test(value.txid) ||
    !validSource(value.source) ||
    !isRecord(defaults) ||
    !exactKeys(
      defaults,
      agentPreset === undefined ? ['permissionPreset'] : ['agentPreset', 'permissionPreset'],
    ) ||
    (agentPreset !== undefined &&
      (typeof agentPreset !== 'string' || !isSafePresetName(agentPreset))) ||
    (defaults.permissionPreset !== 'workspace-write' &&
      defaults.permissionPreset !== 'danger-full-access') ||
    !Array.isArray(value.plugins) ||
    !value.plugins.every(validPluginFact) ||
    !Array.isArray(value.sideEffects) ||
    value.sideEffects.length !== 1 ||
    value.sideEffects[0] !== 'profile/cordis.yml'
  )
    return {
      status: 'broken',
      reason: 'installed metadata 格式不合法。',
      failureKind: 'contract',
    };
  return { status: 'valid', metadata: value as unknown as InstalledMetadataV0 };
}

export async function inspectMetadata(
  dshHome: string,
  profile: string,
  hooks: SafePathHooks = {},
): Promise<MetadataInspection> {
  const home = await bindSecureRoot(dshHome, hooks);
  if (!home.ok) {
    if (home.kind === 'missing') return { status: 'missing' };
    return { status: 'broken', reason: home.reason, failureKind: failureKind(home.kind) };
  }
  const source = await readText(home.value, ['.dshpack', 'installed', `${profile}.json`], hooks);
  if (!source.ok) {
    if (source.kind === 'missing') return { status: 'missing' };
    return { status: 'broken', reason: source.reason, failureKind: failureKind(source.kind) };
  }
  try {
    return parseInstalledMetadata(JSON.parse(source.value.text), profile);
  } catch {
    return {
      status: 'broken',
      reason: 'installed metadata 不是有效 JSON。',
      failureKind: 'contract',
    };
  }
}

export async function inspectPreset(
  dshHome: string,
  preset: string,
  hooks: SafePathHooks = {},
): Promise<PresetInspection> {
  if (!isSafePresetName(preset))
    return { status: 'broken', reason: 'preset 名称不符合安全规则。', failureKind: 'contract' };
  const home = await bindSecureRoot(dshHome, hooks);
  if (!home.ok) {
    if (home.kind === 'missing') return { status: 'missing' };
    return { status: 'broken', reason: home.reason, failureKind: failureKind(home.kind) };
  }
  const file = await readText(home.value, ['.agent-presets', preset, 'agent.cordis.yml'], hooks);
  if (file.ok) return { status: 'valid' };
  if (file.kind === 'missing') return { status: 'missing' };
  return { status: 'broken', reason: file.reason, failureKind: failureKind(file.kind) };
}

export async function presetExists(dshHome: string, preset: string): Promise<boolean> {
  return (await inspectPreset(dshHome, preset)).status === 'valid';
}
