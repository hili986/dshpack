import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseCanonicalYaml } from '@dshpack/core';

export const PROFILE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const RESERVED_PROFILES = new Set(['web', 'headless', '.', '..']);
const PRESET_NAME = /^[a-z0-9][a-z0-9-]*$/u;
const RESERVED_PRESETS = new Set(['standard', 'code', 'minimal', 'cordis']);
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

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
  plugins: readonly unknown[];
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

async function regularText(path: string): Promise<string | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
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
  if (packageText === undefined || patchText === undefined || workspaceText === undefined)
    return { status: 'broken', reason: 'profile 缺少官方初始化基座文件。' };

  let manifest: unknown;
  try {
    manifest = JSON.parse(packageText);
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

  const patch = parseCanonicalYaml(patchText, { allowJsTag: true });
  if (!patch.ok || !Array.isArray(patch.value?.value))
    return { status: 'broken', reason: 'profile cordis.patch.yml 顶层必须是 array。' };
  const workspace = parseCanonicalYaml(workspaceText);
  if (!workspace.ok || !isRecord(workspace.value?.value))
    return { status: 'broken', reason: 'profile pnpm-workspace.yaml 顶层必须是 object。' };
  return { status: 'valid', root };
}

function validSource(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'directory' || value.kind === 'archive') return typeof value.path === 'string';
  if (value.kind === 'https')
    return typeof value.url === 'string' && typeof value.integrity === 'string';
  return (
    value.kind === 'github' &&
    typeof value.owner === 'string' &&
    typeof value.repo === 'string' &&
    typeof value.commit === 'string' &&
    typeof value.url === 'string'
  );
}

function parseInstalledMetadata(value: unknown, profile: string): MetadataInspection {
  if (!isRecord(value)) return { status: 'broken', reason: 'installed metadata 格式不合法。' };
  if (value.profile !== profile)
    return { status: 'broken', reason: 'installed metadata 的 profile 与文件名不一致。' };
  const pack = value.pack;
  const defaults = value.defaults;
  const agentPreset = isRecord(defaults) ? defaults.agentPreset : undefined;
  if (
    value.metadataVersion !== 0 ||
    !isRecord(pack) ||
    typeof pack.name !== 'string' ||
    !isSafeProfileName(pack.name) ||
    typeof pack.version !== 'string' ||
    !SEMVER.test(pack.version) ||
    typeof pack.manifestDigest !== 'string' ||
    !pack.manifestDigest.startsWith('sha256-') ||
    typeof value.planDigest !== 'string' ||
    !value.planDigest.startsWith('sha256-') ||
    typeof value.installedAt !== 'string' ||
    Number.isNaN(Date.parse(value.installedAt)) ||
    typeof value.txid !== 'string' ||
    value.txid === '' ||
    !validSource(value.source) ||
    !isRecord(defaults) ||
    (agentPreset !== undefined &&
      (typeof agentPreset !== 'string' || !isSafePresetName(agentPreset))) ||
    (defaults.permissionPreset !== 'workspace-write' &&
      defaults.permissionPreset !== 'danger-full-access') ||
    !Array.isArray(value.plugins) ||
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
  if (source === undefined) return { status: 'missing' };
  try {
    return parseInstalledMetadata(JSON.parse(source), profile);
  } catch {
    return { status: 'broken', reason: 'installed metadata 不是有效 JSON。' };
  }
}

export async function presetExists(dshHome: string, preset: string): Promise<boolean> {
  if (!isSafePresetName(preset)) return false;
  const path = join(dshHome, '.agent-presets', preset, 'agent.cordis.yml');
  return (await regularText(path)) !== undefined;
}
