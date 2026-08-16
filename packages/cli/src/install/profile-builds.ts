import { dirname, join, relative, resolve, sep } from 'node:path';

import type { PluginDeclaration } from '@dshpack/core';

import {
  assertPackageName,
  assertPluginDeclaration,
  InstallProfileError,
  isRecord,
} from './profile-common.js';
import { inspectSecureDirectory, type ProfileReadHooks, readAtomicFile } from './profile-fs.js';
import { buildAuthorizationKey } from './profile-workspace.js';

const lifecycleScripts = ['preinstall', 'install', 'postinstall', 'prepare'] as const;

export interface BuildScriptFinding {
  name: string;
  authorizationKey: string;
  scripts: (typeof lifecycleScripts)[number][];
}

export interface BuildScriptAudit {
  approvedDirect: BuildScriptFinding[];
  transitive: BuildScriptFinding[];
  unapprovedDirectBuildKeys: string[];
  unexpectedTransitiveBuildKeys: string[];
}

interface PackageFacts {
  name: string;
  root: string;
  identity: string;
  requiredDependencies: string[];
  optionalDependencies: string[];
  scripts: (typeof lifecycleScripts)[number][];
}

async function packageJson(
  path: string,
  hooks: ProfileReadHooks,
): Promise<Record<string, unknown>> {
  const file = join(path, 'package.json');
  try {
    const parsed: unknown = JSON.parse(
      (await readAtomicFile(file, 'E_PLUGIN_PACKAGE_JSON', hooks)).bytes.toString('utf8'),
    );
    if (isRecord(parsed)) return parsed;
  } catch (error) {
    if (error instanceof InstallProfileError) throw error;
  }
  throw new InstallProfileError(
    'E_PLUGIN_PACKAGE_JSON',
    `依赖 package.json 无法安全解析：${file}`,
    file,
  );
}

function dependencySection(value: unknown, section: string, packageName: string): string[] {
  if (value === undefined) return [];
  if (!isRecord(value) || Object.values(value).some((specifier) => typeof specifier !== 'string'))
    throw new InstallProfileError(
      'E_PLUGIN_DEPENDENCIES',
      `${packageName} 的 ${section} 不是 string mapping。`,
    );
  const names = Object.keys(value);
  for (const name of names) assertPackageName(name);
  return names;
}

function scriptFacts(value: unknown, packageName: string): (typeof lifecycleScripts)[number][] {
  if (value === undefined) return [];
  if (!isRecord(value) || Object.values(value).some((command) => typeof command !== 'string'))
    throw new InstallProfileError(
      'E_PLUGIN_SCRIPTS',
      `${packageName} 的 scripts 不是 string mapping。`,
    );
  return lifecycleScripts.filter((name) => {
    const command = value[name];
    return typeof command === 'string' && command.trim().length > 0;
  });
}

async function readPackage(
  root: string,
  expectedName: string,
  hooks: ProfileReadHooks,
): Promise<PackageFacts> {
  const directory = await inspectSecureDirectory(root, hooks);
  if (directory === undefined)
    throw new InstallProfileError(
      'E_PLUGIN_DEPENDENCY_MISSING',
      `依赖未安装：${expectedName}`,
      root,
    );
  const json = await packageJson(root, hooks);
  const currentDirectory = await inspectSecureDirectory(root, hooks);
  if (currentDirectory?.identity !== directory.identity)
    throw new InstallProfileError('E_PROFILE_FILE_CHANGED', `依赖目录在读取期间被替换：${root}`);
  if (json.name !== expectedName)
    throw new InstallProfileError(
      'E_PLUGIN_PACKAGE_ALIAS',
      `依赖路径 ${expectedName} 实际声明为 ${String(json.name)}。`,
      root,
    );
  const requiredDependencies = dependencySection(json.dependencies, 'dependencies', expectedName);
  const optional = dependencySection(
    json.optionalDependencies,
    'optionalDependencies',
    expectedName,
  );
  const peers = dependencySection(json.peerDependencies, 'peerDependencies', expectedName);
  return {
    name: expectedName,
    root,
    identity: directory.identity,
    requiredDependencies,
    optionalDependencies: [...new Set([...optional, ...peers])],
    scripts: scriptFacts(json.scripts, expectedName),
  };
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`));
}

async function resolveDependency(
  profileRoot: string,
  packageRoot: string,
  name: string,
  optional: boolean,
  hooks: ProfileReadHooks,
): Promise<string | undefined> {
  let cursor = packageRoot;
  while (isInside(profileRoot, cursor)) {
    const candidate = join(cursor, 'node_modules', ...name.split('/'));
    const directory = await inspectSecureDirectory(candidate, hooks);
    if (directory !== undefined) return candidate;
    if (resolve(cursor) === resolve(profileRoot)) break;
    cursor = dirname(cursor);
  }
  if (optional) return undefined;
  throw new InstallProfileError('E_PLUGIN_DEPENDENCY_MISSING', `依赖未安装：${name}`);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Audit the installed dependency closure without mutating pnpm-workspace.yaml. Any transitive
 * lifecycle script is returned separately and therefore requires a second explicit confirmation.
 */
export async function auditInstalledBuildScripts(
  profileRoot: string,
  directPlugins: readonly PluginDeclaration[],
  approvedBuildKeys: ReadonlySet<string>,
  hooks: ProfileReadHooks = {},
): Promise<BuildScriptAudit> {
  if ((await inspectSecureDirectory(profileRoot, hooks)) === undefined)
    throw new InstallProfileError('E_PLUGIN_PATH_ALIAS', 'profile 根目录不存在。', profileRoot);
  if ((await inspectSecureDirectory(join(profileRoot, 'node_modules'), hooks)) === undefined)
    throw new InstallProfileError(
      'E_PLUGIN_PATH_ALIAS',
      'profile node_modules 不存在。',
      profileRoot,
    );

  const directByName = new Map<string, PluginDeclaration>();
  for (const plugin of directPlugins) {
    assertPluginDeclaration(plugin);
    directByName.set(plugin.name, plugin);
  }
  const queue: PackageFacts[] = [];
  const directByIdentity = new Map<string, PluginDeclaration>();
  for (const plugin of directByName.values()) {
    const facts = await readPackage(
      join(profileRoot, 'node_modules', ...plugin.name.split('/')),
      plugin.name,
      hooks,
    );
    queue.push(facts);
    directByIdentity.set(facts.identity, plugin);
  }

  const approvedDirect: BuildScriptFinding[] = [];
  const transitive: BuildScriptFinding[] = [];
  const unapprovedDirect: string[] = [];
  const unexpectedTransitive: string[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift() as PackageFacts;
    if (visited.has(current.identity)) continue;
    visited.add(current.identity);
    const direct = directByIdentity.get(current.identity);
    if (current.scripts.length > 0) {
      const authorizationKey = direct === undefined ? current.name : buildAuthorizationKey(direct);
      const finding = { name: current.name, authorizationKey, scripts: current.scripts };
      if (direct === undefined) {
        transitive.push(finding);
        unexpectedTransitive.push(authorizationKey);
      } else if (approvedBuildKeys.has(authorizationKey)) approvedDirect.push(finding);
      else unapprovedDirect.push(authorizationKey);
    }
    for (const name of current.requiredDependencies) {
      const dependencyRoot = await resolveDependency(profileRoot, current.root, name, false, hooks);
      queue.push(await readPackage(dependencyRoot as string, name, hooks));
    }
    for (const name of current.optionalDependencies) {
      const dependencyRoot = await resolveDependency(profileRoot, current.root, name, true, hooks);
      if (dependencyRoot !== undefined) queue.push(await readPackage(dependencyRoot, name, hooks));
    }
  }

  approvedDirect.sort((left, right) => left.authorizationKey.localeCompare(right.authorizationKey));
  transitive.sort((left, right) => left.authorizationKey.localeCompare(right.authorizationKey));
  return {
    approvedDirect,
    transitive,
    unapprovedDirectBuildKeys: sortedUnique(unapprovedDirect),
    unexpectedTransitiveBuildKeys: sortedUnique(unexpectedTransitive),
  };
}
