import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  type LockedPlugin,
  type PackLockedPlugin,
  type PluginDeclaration,
  resolveIntegrityFromPnpmLock,
} from '@dshpack/core';
import { satisfies, valid } from 'semver';

import { assertPluginDeclaration, InstallProfileError, isRecord } from './profile-common.js';

export interface InstalledPluginFact {
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

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertMatchingName(plugin: PluginDeclaration, locked: PackLockedPlugin): void {
  assertPluginDeclaration(plugin);
  if (locked.name !== plugin.name)
    throw new InstallProfileError(
      'E_PLUGIN_LOCK_MISMATCH',
      `lock 插件名 ${locked.name} 与 manifest ${plugin.name} 不一致。`,
    );
}

async function ordinaryFile(path: string, code: string): Promise<Buffer> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch {
    throw new InstallProfileError(code, `缺少必须文件：${path}`, path);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new InstallProfileError(code, `拒绝 symlink 或非普通文件：${path}`, path);
  return readFile(path);
}

async function ordinaryDirectory(path: string): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch {
    throw new InstallProfileError('E_PLUGIN_PATH_ALIAS', `插件目录不存在：${path}`, path);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new InstallProfileError(
      'E_PLUGIN_PATH_ALIAS',
      `拒绝 symlink、junction 或非目录插件路径：${path}`,
      path,
    );
}

function installedPackageRoot(profileRoot: string, name: string): string {
  const segments = name.split('/');
  return join(profileRoot, 'node_modules', ...segments);
}

async function assertPackagePath(profileRoot: string, name: string): Promise<string> {
  await ordinaryDirectory(profileRoot);
  const modules = join(profileRoot, 'node_modules');
  await ordinaryDirectory(modules);
  const segments = name.split('/');
  if (segments.length === 2) await ordinaryDirectory(join(modules, segments[0] as string));
  const packageRoot = installedPackageRoot(profileRoot, name);
  await ordinaryDirectory(packageRoot);
  return packageRoot;
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
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/u.test(normalized) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  )
    throw new InstallProfileError(
      'E_PLUGIN_BUNDLE_PATCH_PATH',
      `dsh.bundle.patch 不是安全相对路径：${value}`,
    );
  return value;
}

function npmSpec(plugin: SourceKind<'npm'>, locked: PackLockedPlugin): string {
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

function githubSpec(plugin: SourceKind<'github'>, locked: PackLockedPlugin): string {
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
  locked: PackLockedPlugin,
  stagedTarball: string | undefined,
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
  if (stagedTarball === undefined || !isAbsolute(stagedTarball) || !stagedTarball.endsWith('.tgz'))
    throw new InstallProfileError(
      'E_PLUGIN_TARBALL_PATH',
      'tarball 必须先校验并落为绝对本地 .tgz 路径。',
    );
  const bytes = await ordinaryFile(stagedTarball, 'E_PLUGIN_TARBALL_PATH');
  if (sha512(bytes) !== locked.integrity.value)
    throw new InstallProfileError(
      'E_PLUGIN_TARBALL_INTEGRITY',
      '本地 staged tarball 的 sha512 与 lock 不一致。',
      stagedTarball,
    );
  return stagedTarball;
}

/** Generate only exact, pinned specs; a remote tarball URL is never returned. */
export async function exactPluginAddSpec(
  plugin: PluginDeclaration,
  locked: PackLockedPlugin,
  stagedTarball?: string,
): Promise<string> {
  assertMatchingName(plugin, locked);
  if (plugin.source.kind === 'npm') return npmSpec(plugin as SourceKind<'npm'>, locked);
  if (plugin.source.kind === 'github') return githubSpec(plugin as SourceKind<'github'>, locked);
  return tarballSpec(plugin as SourceKind<'tarball'>, locked, stagedTarball);
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
  expected: PackLockedPlugin,
): LockedPlugin {
  const resolved = resolveIntegrityFromPnpmLock(source, plugin);
  if (!resolved.ok || resolved.value === undefined)
    throw new InstallProfileError('E_PLUGIN_LOCK', 'pnpm-lock 四处联合提取失败。');
  if (!same(resolved.value.resolved, expected.resolved))
    throw new InstallProfileError('E_PLUGIN_LOCK_MISMATCH', '实际 lock 来源与 pack lock 不一致。');
  if (
    expected.integrity.kind !== 'unverified' &&
    !same(resolved.value.integrity, expected.integrity)
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
  expected: PackLockedPlugin,
): Promise<InstalledPluginFact> {
  assertMatchingName(plugin, expected);
  const packageRoot = await assertPackagePath(profileRoot, plugin.name);
  const packagePath = join(packageRoot, 'package.json');
  const packageBytes = await ordinaryFile(packagePath, 'E_PLUGIN_PACKAGE_JSON');
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
  await ordinaryFile(
    join(packageRoot, ...normalizedPatch.split('/')),
    'E_PLUGIN_BUNDLE_PATCH_PATH',
  );
  const packageJsonSha512 = sha512(packageBytes);
  if (packageJsonSha512 !== expected.packageJsonSha512)
    throw new InstallProfileError(
      'E_PLUGIN_PACKAGE_HASH',
      '实际 package.json sha512 与 pack lock 不一致。',
    );
  if (bundlePatch !== expected.bundlePatch)
    throw new InstallProfileError(
      'E_PLUGIN_BUNDLE_PATCH',
      '实际 bundle patch 与 pack lock 不一致。',
    );

  const profilePath = join(profileRoot, 'package.json');
  const profile = parseJson(
    await ordinaryFile(profilePath, 'E_PLUGIN_PROFILE_PACKAGE'),
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
  const lockSource = await ordinaryFile(lockPath, 'E_PLUGIN_LOCK');
  const actual = reconcileLock(lockSource.toString('utf8'), plugin, expected);
  return {
    packageJsonSha512,
    bundlePatch,
    actualResolved: actual.resolved,
    actualIntegrity: actual.integrity,
  };
}
