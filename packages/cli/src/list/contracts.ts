import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { parseCanonicalYaml, validatePackPath } from '@dshpack/core';

export const PROFILE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const RESERVED_PROFILES = new Set(['web', 'headless', '.', '..']);
const PRESET_NAME = /^[a-z0-9][a-z0-9-]*$/u;
const RESERVED_PRESETS = new Set(['standard', 'code', 'minimal', 'cordis']);
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
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
  | { status: 'valid'; root: string }
  | { status: 'missing'; reason: string }
  | { status: 'broken'; reason: string };

export type MetadataInspection =
  | { status: 'valid'; metadata: InstalledMetadataV0 }
  | { status: 'missing' }
  | { status: 'broken'; reason: string };

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

type RegularText =
  | { kind: 'text'; value: string }
  | { kind: 'missing' }
  | { kind: 'unsafe' }
  | { kind: 'unreadable' };

async function regularText(path: string): Promise<RegularText> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return { kind: 'unsafe' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unreadable' };
  }
  try {
    return { kind: 'text', value: await readFile(path, 'utf8') };
  } catch {
    return { kind: 'unreadable' };
  }
}

export async function inspectProfile(dshHome: string, profile: string): Promise<ProfileInspection> {
  if (!isSafeProfileName(profile))
    return { status: 'broken', reason: 'profile 名称不符合安全规则。' };
  const root = join(dshHome, 'profiles', profile);
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      return { status: 'broken', reason: 'profile 路径不是普通目录。' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { status: 'missing', reason: 'profile 不存在。' };
    return { status: 'broken', reason: 'profile 路径不可读取。' };
  }

  const packageText = await regularText(join(root, 'package.json'));
  const patchText = await regularText(join(root, 'cordis.patch.yml'));
  const workspaceText = await regularText(join(root, 'pnpm-workspace.yaml'));
  const baseFiles = [packageText, patchText, workspaceText];
  if (baseFiles.some(({ kind }) => kind === 'unsafe'))
    return { status: 'broken', reason: 'profile 基座文件不是普通文件。' };
  if (baseFiles.some(({ kind }) => kind === 'unreadable'))
    return { status: 'broken', reason: 'profile 基座文件不可读取。' };
  if (baseFiles.some(({ kind }) => kind === 'missing'))
    return { status: 'broken', reason: 'profile 缺少官方初始化基座文件。' };
  if (packageText.kind !== 'text' || patchText.kind !== 'text' || workspaceText.kind !== 'text')
    return { status: 'broken', reason: 'profile 基座文件状态不一致。' };

  let manifest: unknown;
  try {
    manifest = JSON.parse(packageText.value);
  } catch {
    return { status: 'broken', reason: 'profile package.json 不能解析。' };
  }
  if (!isRecord(manifest))
    return { status: 'broken', reason: 'profile package.json 顶层必须是 object。' };
  if (manifest.name !== `dsh-profile-${profile}`)
    return { status: 'broken', reason: 'profile package.json.name 与最终目录名不一致。' };
  const dsh = manifest.dsh;
  const profileConfig = isRecord(dsh) ? dsh.profile : undefined;
  const bundles = isRecord(profileConfig) ? profileConfig.bundles : undefined;
  if (
    manifest.private !== true ||
    !isStringRecord(manifest.dependencies) ||
    !isStringArray(bundles) ||
    new Set(bundles).size !== bundles.length
  )
    return { status: 'broken', reason: 'profile package.json 契约不合法。' };

  const patch = parseCanonicalYaml(patchText.value, { allowJsTag: true });
  if (!patch.ok || !Array.isArray(patch.value?.value))
    return { status: 'broken', reason: 'profile cordis.patch.yml 顶层必须是 array。' };
  const workspace = parseCanonicalYaml(workspaceText.value);
  if (!workspace.ok || !isRecord(workspace.value?.value))
    return { status: 'broken', reason: 'profile pnpm-workspace.yaml 顶层必须是 object。' };
  return { status: 'valid', root };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
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
  if (exactKeys(value, ['version']))
    return typeof value.version === 'string' && SEMVER.test(value.version);
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
  if (!isRecord(value)) return { status: 'broken', reason: 'installed metadata 格式不合法。' };
  if (value.profile !== profile)
    return { status: 'broken', reason: 'installed metadata 的 profile 与文件名不一致。' };
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
    typeof pack.version !== 'string' ||
    !SEMVER.test(pack.version) ||
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
    return { status: 'broken', reason: 'installed metadata 格式不合法。' };
  return { status: 'valid', metadata: value as unknown as InstalledMetadataV0 };
}

export async function inspectMetadata(
  dshHome: string,
  profile: string,
): Promise<MetadataInspection> {
  const path = join(dshHome, '.dshpack', 'installed', `${profile}.json`);
  const source = await regularText(path);
  if (source.kind === 'missing') return { status: 'missing' };
  if (source.kind === 'unsafe')
    return { status: 'broken', reason: 'installed metadata 不是普通文件。' };
  if (source.kind === 'unreadable')
    return { status: 'broken', reason: 'installed metadata 不可读取。' };
  try {
    return parseInstalledMetadata(JSON.parse(source.value), profile);
  } catch {
    return { status: 'broken', reason: 'installed metadata 不是有效 JSON。' };
  }
}

export async function presetExists(dshHome: string, preset: string): Promise<boolean> {
  if (!isSafePresetName(preset)) return false;
  const path = join(dshHome, '.agent-presets', preset, 'agent.cordis.yml');
  return (await regularText(path)).kind === 'text';
}
