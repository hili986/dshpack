import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseDocument } from 'yaml';

import { InstallProfileError, isRecord, sameKeys } from './profile-common.js';

export { InstallProfileError } from './profile-common.js';

const initialFiles = ['cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml'] as const;

export interface OfficialProfileFacts {
  packageName: string;
  dependencies: Record<string, never>;
  bundles: ['@deepseek-ai/dsh-base'];
}

async function requireRegularFile(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new InstallProfileError(
      'E_PROFILE_INIT_FILE_TYPE',
      `官方初始化文件不是普通文件：${path}`,
      path,
    );
  return readFile(path, 'utf8');
}

function parseObjectYaml(source: string, code: string, path: string): Record<string, unknown> {
  const document = parseDocument(source, { version: '1.2', uniqueKeys: true, merge: false });
  const value = document.toJS();
  if (document.errors.length > 0 || !isRecord(value))
    throw new InstallProfileError(code, `官方初始化 YAML 结构不符：${path}`, path);
  return value;
}

function validatePackage(source: string, profileName: string, path: string): OfficialProfileFacts {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new InstallProfileError(
      'E_PROFILE_INIT_PACKAGE',
      '官方初始化 package.json 无法解析。',
      path,
    );
  }
  if (!isRecord(value) || !sameKeys(value, ['name', 'private', 'dependencies', 'dsh']))
    throw new InstallProfileError(
      'E_PROFILE_INIT_PACKAGE',
      '官方初始化 package.json 顶层结构漂移。',
      path,
    );
  const dsh = value.dsh;
  const dependencies = value.dependencies;
  if (
    value.name !== `dsh-profile-${profileName}` ||
    value.private !== true ||
    !isRecord(dependencies) ||
    Object.keys(dependencies).length !== 0 ||
    !isRecord(dsh) ||
    !sameKeys(dsh, ['profile']) ||
    !isRecord(dsh.profile) ||
    !sameKeys(dsh.profile, ['bundles']) ||
    !Array.isArray(dsh.profile.bundles) ||
    dsh.profile.bundles.length !== 1 ||
    dsh.profile.bundles[0] !== '@deepseek-ai/dsh-base'
  )
    throw new InstallProfileError(
      'E_PROFILE_INIT_PACKAGE',
      '官方初始化 package.json 内容漂移。',
      path,
    );
  return {
    packageName: value.name,
    dependencies: {},
    bundles: ['@deepseek-ai/dsh-base'],
  };
}

function validatePatch(source: string, path: string): void {
  const document = parseDocument(source, { version: '1.2', uniqueKeys: true, merge: false });
  const value = document.toJS();
  if (document.errors.length > 0 || !Array.isArray(value) || value.length !== 0)
    throw new InstallProfileError(
      'E_PROFILE_INIT_PATCH',
      '官方初始化 cordis.patch.yml 必须是空顶层数组。',
      path,
    );
}

function validateWorkspace(source: string, path: string): void {
  const value = parseObjectYaml(source, 'E_PROFILE_INIT_WORKSPACE', path);
  if (
    !sameKeys(value, ['packages', 'nodeLinker', 'autoInstallPeers']) ||
    !Array.isArray(value.packages) ||
    value.packages.length !== 1 ||
    value.packages[0] !== '.' ||
    value.nodeLinker !== 'hoisted' ||
    value.autoInstallPeers !== false
  )
    throw new InstallProfileError(
      'E_PROFILE_INIT_WORKSPACE',
      '官方初始化 pnpm-workspace.yaml 内容漂移。',
      path,
    );
}

/** Assert the exact three-file E1 baseline before any transaction mutation. */
export async function validateOfficialProfileInit(
  profileRoot: string,
  profileName: string,
): Promise<OfficialProfileFacts> {
  const rootMetadata = await lstat(profileRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink())
    throw new InstallProfileError(
      'E_PROFILE_INIT_ROOT',
      'profile 根目录不是普通目录。',
      profileRoot,
    );
  const entries = await readdir(profileRoot, { withFileTypes: true });
  const names = entries.map(({ name }) => name).sort();
  if (
    names.length !== initialFiles.length ||
    !names.every((name, index) => name === initialFiles[index])
  )
    throw new InstallProfileError(
      'E_PROFILE_INIT_FILES',
      `官方初始化应恰有 ${initialFiles.join(', ')}；实际为 ${names.join(', ') || '(空)'}。`,
      profileRoot,
    );
  const packagePath = join(profileRoot, 'package.json');
  const patchPath = join(profileRoot, 'cordis.patch.yml');
  const workspacePath = join(profileRoot, 'pnpm-workspace.yaml');
  const [packageSource, patchSource, workspaceSource] = await Promise.all([
    requireRegularFile(packagePath),
    requireRegularFile(patchPath),
    requireRegularFile(workspacePath),
  ]);
  const facts = validatePackage(packageSource, profileName, packagePath);
  validatePatch(patchSource, patchPath);
  validateWorkspace(workspaceSource, workspacePath);
  return facts;
}
