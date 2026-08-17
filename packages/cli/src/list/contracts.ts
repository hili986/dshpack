import { join } from 'node:path';

import { parseCanonicalYaml } from '@dshpack/core';
import {
  type InstalledMetadata,
  isAddressableProfileName,
  type MetadataReadMode,
  parseInstalledMetadata as parseMetadataContract,
} from '../metadata/contracts.js';
import {
  bindDirectory,
  bindSecureRoot,
  type DirectoryBinding,
  readText,
  revalidateDirectory,
  type SafePathFailureKind,
  type SafePathHooks,
} from './safe-fs.js';

export type {
  InstalledMetadata,
  InstalledMetadataV0,
  InstalledMetadataV1,
  InstalledPluginMetadata,
} from '../metadata/contracts.js';
export {
  isAddressableProfileName,
  isInstallableProfileName,
  isReservedProfileName,
  MODULE_FALLBACK,
  PROFILE_NAME,
} from '../metadata/contracts.js';

const PRESET_NAME = /^[a-z0-9][a-z0-9-]*$/u;
const RESERVED_PRESETS = new Set(['standard', 'code', 'minimal', 'cordis']);
export type ProfileInspection =
  | { status: 'valid'; root: string; binding: DirectoryBinding }
  | { status: 'missing'; reason: string; failureKind: InspectionFailureKind }
  | { status: 'broken'; reason: string; failureKind: InspectionFailureKind };

export type MetadataInspection =
  | { status: 'valid'; metadata: InstalledMetadata; mode: MetadataReadMode }
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
  if (!isAddressableProfileName(profile)) return broken('profile 名称不符合安全规则。');
  const root = join(dshHome, 'profiles', profile);
  const home = await bindSecureRoot(dshHome, hooks);
  if (!home.ok)
    return home.kind === 'missing'
      ? { status: 'missing', reason: 'DSH_HOME 不存在。', failureKind: 'environment' }
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

export async function inspectMetadata(
  dshHome: string,
  profile: string,
  hooks: SafePathHooks = {},
): Promise<MetadataInspection> {
  if (!isAddressableProfileName(profile))
    return {
      status: 'broken',
      reason: 'profile 名称不符合安全规则。',
      failureKind: 'contract',
    };
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
    const parsed = parseMetadataContract(JSON.parse(source.value.text), profile);
    if (!parsed.ok)
      return {
        status: 'broken',
        reason:
          parsed.reason === 'profile-mismatch'
            ? 'installed metadata 的 profile 与文件名不一致。'
            : 'installed metadata 格式不合法。',
        failureKind: 'contract',
      };
    return { status: 'valid', metadata: parsed.metadata, mode: parsed.mode };
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
