import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  type LockedPlugin,
  type PluginDeclaration,
  resolveIntegrityFromPnpmLock,
} from '@dshpack/core';
import { satisfies, valid } from 'semver';

import { assertPluginDeclaration, InstallProfileError, isRecord } from './profile-common.js';
import {
  type ProfileReadHooks,
  readAtomicFile,
  readConfinedAtomicFile,
  requireSecureDirectory,
} from './profile-fs.js';
import { type StagedPluginTarball, verifyStagedPluginTarball } from './profile-tarball.js';
import type { InstallResolvedPlugin } from './types.js';

export type { StagedPluginTarball } from './profile-tarball.js';
export { stageVerifiedPluginTarball } from './profile-tarball.js';

export interface InstalledPluginFact {
  name: string;
  packageJsonSha512: string;
  bundlePatch: string;
  actualResolved: LockedPlugin['resolved'];
  actualIntegrity: LockedPlugin['integrity'];
}

type SourceKind<K extends PluginDeclaration['source']['kind']> = PluginDeclaration & {
  source: Extract<PluginDeclaration['source'], { kind: K }>;
};

function sha512(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function sameResolved(
  left: LockedPlugin['resolved'],
  right: InstallResolvedPlugin['resolved'],
): boolean {
  if ('version' in left) return 'version' in right && left.version === right.version;
  if ('commit' in left) return 'commit' in right && left.commit === right.commit;
  return 'url' in right && left.url === right.url;
}

function sameIntegrity(
  left: LockedPlugin['integrity'],
  right: Exclude<InstallResolvedPlugin['integrity'], { kind: 'unverified' }>,
): boolean {
  return left.kind === right.kind && left.value === right.value;
}

function assertMatchingName(plugin: PluginDeclaration, locked: InstallResolvedPlugin): void {
  assertPluginDeclaration(plugin);
  if (locked.name !== plugin.name)
    throw new InstallProfileError(
      'E_PLUGIN_LOCK_MISMATCH',
      `lock 插件名 ${locked.name} 与 manifest ${plugin.name} 不一致。`,
    );
}

function installedPackageRoot(profileRoot: string, name: string): string {
  const segments = name.split('/');
  return join(profileRoot, 'node_modules', ...segments);
}

async function assertPackagePath(
  profileRoot: string,
  name: string,
  hooks: ProfileReadHooks,
): Promise<{ root: string; identity: string }> {
  await requireSecureDirectory(profileRoot, hooks);
  const modules = join(profileRoot, 'node_modules');
  await requireSecureDirectory(modules, hooks);
  const segments = name.split('/');
  if (segments.length === 2)
    await requireSecureDirectory(join(modules, segments[0] as string), hooks);
  const packageRoot = installedPackageRoot(profileRoot, name);
  const packageDirectory = await requireSecureDirectory(packageRoot, hooks);
  return { root: packageRoot, identity: packageDirectory.identity };
}

function safeBundlePatch(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    value.includes('\0')
  )
    throw new InstallProfileError('E_PLUGIN_BUNDLE_PATCH', '实际包未声明安全的 dsh.bundle.patch。');
  const normalized = value.startsWith('./') ? value.slice(2) : value;
  const segments = normalized.split('/');
  const windowsDevice = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/u.test(normalized) ||
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        /[<>:"|?*]/u.test(segment) ||
        /\p{Cc}/u.test(segment) ||
        /[. ]$/u.test(segment) ||
        windowsDevice.test(segment),
    )
  )
    throw new InstallProfileError(
      'E_PLUGIN_BUNDLE_PATCH_PATH',
      `dsh.bundle.patch 不是安全相对路径：${value}`,
    );
  return value;
}

function npmSpec(plugin: SourceKind<'npm'>, locked: InstallResolvedPlugin): string {
  if (
    !('version' in locked.resolved) ||
    locked.integrity.kind !== 'npm-sri' ||
    valid(locked.resolved.version) === null
  )
    throw new InstallProfileError('E_PLUGIN_LOCK_MISMATCH', 'npm 插件缺少 exact version/npm-sri。');
  let compatible = false;
  try {
    compatible = satisfies(locked.resolved.version, plugin.source.range, {
      includePrerelease: true,
    });
  } catch {
    compatible = false;
  }
  if (!compatible)
    throw new InstallProfileError(
      'E_PLUGIN_LOCK_MISMATCH',
      `锁定版本 ${locked.resolved.version} 不满足 ${plugin.source.range}。`,
    );
  return `${plugin.name}@${locked.resolved.version}`;
}

function githubSpec(plugin: SourceKind<'github'>, locked: InstallResolvedPlugin): string {
  if (
    !('commit' in locked.resolved) ||
    locked.resolved.commit !== plugin.source.ref ||
    locked.integrity.kind !== 'git-commit' ||
    locked.integrity.value !== plugin.source.ref
  )
    throw new InstallProfileError(
      'E_PLUGIN_LOCK_MISMATCH',
      'GitHub lock commit 与 manifest pin 不一致。',
    );
  return `github:${plugin.source.owner}/${plugin.source.repo}#${plugin.source.ref}`;
}

async function tarballSpec(
  plugin: SourceKind<'tarball'>,
  locked: InstallResolvedPlugin,
  stagedTarball: StagedPluginTarball | undefined,
  hooks: ProfileReadHooks,
): Promise<string> {
  if (!('url' in locked.resolved) || locked.resolved.url !== plugin.source.url)
    throw new InstallProfileError(
      'E_PLUGIN_LOCK_MISMATCH',
      'tarball lock URL 与 manifest 不一致。',
    );
  if (locked.integrity.kind !== 'sha512')
    throw new InstallProfileError(
      'E_PLUGIN_TARBALL_UNVERIFIED',
      '远程 tarball 没有可重验的 sha512 SRI，不能交给 dsh。',
    );
  if (stagedTarball === undefined)
    throw new InstallProfileError(
      'E_PLUGIN_TARBALL_PATH',
      'tarball 必须先校验并落为绝对本地 .tgz 路径。',
    );
  return verifyStagedPluginTarball(stagedTarball, locked.integrity.value, hooks);
}

/** Generate only exact, pinned specs; a remote tarball URL is never returned. */
export async function exactPluginAddSpec(
  plugin: PluginDeclaration,
  locked: InstallResolvedPlugin,
  stagedTarball?: StagedPluginTarball,
  hooks: ProfileReadHooks = {},
): Promise<string> {
  assertMatchingName(plugin, locked);
  if (plugin.source.kind === 'npm') return npmSpec(plugin as SourceKind<'npm'>, locked);
  if (plugin.source.kind === 'github') return githubSpec(plugin as SourceKind<'github'>, locked);
  return tarballSpec(plugin as SourceKind<'tarball'>, locked, stagedTarball, hooks);
}

function parseJson(bytes: Uint8Array, code: string, path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (isRecord(value)) return value;
  } catch {
    // The minimal diagnostic below deliberately does not expose package contents.
  }
  throw new InstallProfileError(code, `JSON 文件无法解析为 object：${path}`, path);
}

function packageBundles(profile: Record<string, unknown>, path: string): readonly unknown[] {
  const dsh = profile.dsh;
  if (!isRecord(dsh))
    throw new InstallProfileError('E_PLUGIN_PROFILE_BUNDLE', 'profile dsh 结构无效。', path);
  const profileData = dsh.profile;
  if (!isRecord(profileData))
    throw new InstallProfileError(
      'E_PLUGIN_PROFILE_BUNDLE',
      'profile dsh.profile 结构无效。',
      path,
    );
  const bundles = profileData.bundles;
  if (!Array.isArray(bundles))
    throw new InstallProfileError('E_PLUGIN_PROFILE_BUNDLE', 'profile bundles 结构无效。', path);
  return bundles;
}

function reconcileLock(
  source: string,
  plugin: PluginDeclaration,
  expected: InstallResolvedPlugin,
): LockedPlugin {
  const resolved = resolveIntegrityFromPnpmLock(source, plugin);
  if (!resolved.ok || resolved.value === undefined) {
    const reasonCode = resolved.diagnostics.map(({ code }) => code).join(',');
    throw new InstallProfileError(
      'E_PLUGIN_LOCK',
      `pnpm-lock 四处联合提取失败：${reasonCode}。`,
      undefined,
      reasonCode,
    );
  }
  if (!sameResolved(resolved.value.resolved, expected.resolved))
    throw new InstallProfileError('E_PLUGIN_LOCK_MISMATCH', '实际 lock 来源与 pack lock 不一致。');
  if (
    expected.integrity.kind !== 'unverified' &&
    !sameIntegrity(resolved.value.integrity, expected.integrity)
  )
    throw new InstallProfileError(
      'E_PLUGIN_LOCK_MISMATCH',
      '实际 lock integrity 与 pack lock 不一致。',
    );
  return resolved.value;
}

/** Re-observe package.json facts only after add, then reconcile profile bundles and pnpm lock. */
export async function verifyInstalledPlugin(
  profileRoot: string,
  plugin: PluginDeclaration,
  expected: InstallResolvedPlugin,
  hooks: ProfileReadHooks = {},
): Promise<InstalledPluginFact> {
  assertMatchingName(plugin, expected);
  const installed = await assertPackagePath(profileRoot, plugin.name, hooks);
  const packageRoot = installed.root;
  const packagePath = join(packageRoot, 'package.json');
  const packageBytes = (await readAtomicFile(packagePath, 'E_PLUGIN_PACKAGE_JSON', hooks)).bytes;
  const packageJson = parseJson(packageBytes, 'E_PLUGIN_PACKAGE_JSON', packagePath);
  if (packageJson.name !== plugin.name)
    throw new InstallProfileError(
      'E_PLUGIN_PACKAGE_ALIAS',
      `node_modules 路径包名与 package.json.name 不一致：${plugin.name}。`,
      packagePath,
    );
  const dsh = packageJson.dsh;
  const bundle = isRecord(dsh) ? dsh.bundle : undefined;
  const bundlePatch = safeBundlePatch(isRecord(bundle) ? bundle.patch : undefined);
  const normalizedPatch = bundlePatch.startsWith('./') ? bundlePatch.slice(2) : bundlePatch;
  await readConfinedAtomicFile(packageRoot, normalizedPatch, 'E_PLUGIN_BUNDLE_PATCH_PATH', hooks);
  const currentPackageRoot = await requireSecureDirectory(packageRoot, hooks);
  if (currentPackageRoot.identity !== installed.identity)
    throw new InstallProfileError('E_PROFILE_FILE_CHANGED', '插件目录在验证期间被替换。');
  const packageJsonSha512 = sha512(packageBytes);
  if (
    expected.expectedInstalledFacts !== undefined &&
    packageJsonSha512 !== expected.expectedInstalledFacts.packageJsonSha512
  )
    throw new InstallProfileError(
      'E_PLUGIN_PACKAGE_HASH',
      '实际 package.json sha512 与 frozen pack lock 不一致。',
    );
  if (
    expected.expectedInstalledFacts !== undefined &&
    bundlePatch !== expected.expectedInstalledFacts.bundlePatch
  )
    throw new InstallProfileError(
      'E_PLUGIN_BUNDLE_PATCH',
      '实际 bundle patch 与 frozen pack lock 不一致。',
    );

  const profilePath = join(profileRoot, 'package.json');
  const profile = parseJson(
    (await readAtomicFile(profilePath, 'E_PLUGIN_PROFILE_PACKAGE', hooks)).bytes,
    'E_PLUGIN_PROFILE_PACKAGE',
    profilePath,
  );
  const dependencies = profile.dependencies;
  if (!isRecord(dependencies) || typeof dependencies[plugin.name] !== 'string')
    throw new InstallProfileError(
      'E_PLUGIN_PROFILE_DEPENDENCY',
      '插件未出现在 profile dependencies。',
    );
  if (!packageBundles(profile, profilePath).includes(plugin.name))
    throw new InstallProfileError('E_PLUGIN_PROFILE_BUNDLE', '插件未出现在 profile bundles。');

  const lockPath = join(profileRoot, 'pnpm-lock.yaml');
  const lockSource = await readAtomicFile(lockPath, 'E_PLUGIN_LOCK', hooks);
  const actual = reconcileLock(lockSource.bytes.toString('utf8'), plugin, expected);
  return {
    name: plugin.name,
    packageJsonSha512,
    bundlePatch,
    actualResolved: actual.resolved,
    actualIntegrity: actual.integrity,
  };
}
