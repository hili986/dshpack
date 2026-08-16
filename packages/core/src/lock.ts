import { parseDocument } from 'yaml';

import type { Diagnostic, LockedPlugin, PluginDeclaration, Result } from './contracts.js';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function error(code: string, message: string, hint: string): Diagnostic {
  return { code, severity: 'error', message, hint, evidence: 'local' };
}

function fail(code: string, message: string, hint: string): Result<LockedPlugin> {
  return { ok: false, diagnostics: [error(code, message, hint)] };
}

function pass(value: LockedPlugin): Result<LockedPlugin> {
  return { ok: true, value, diagnostics: [] };
}

function dependencyFromImporter(importer: UnknownRecord, name: string): UnknownRecord | undefined {
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const dependencies = importer[section];
    if (!isRecord(dependencies)) continue;
    const dependency = dependencies[name];
    if (isRecord(dependency)) return dependency;
  }
  return undefined;
}

function matchingPackage(
  packages: UnknownRecord,
  name: string,
  version: string,
): { key: string; value: UnknownRecord } | undefined {
  const exact = `${name}@${version}`;
  const direct = packages[exact];
  if (isRecord(direct)) return { key: exact, value: direct };
  for (const [key, value] of Object.entries(packages)) {
    if ((key === exact || key.startsWith(`${exact}(`)) && isRecord(value)) return { key, value };
  }
  return undefined;
}

function commitFrom(values: readonly string[]): string | undefined {
  for (const value of values) {
    const match = /(?:^|[^a-f0-9])([a-f0-9]{40})(?:$|[^a-f0-9])/u.exec(value);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

function https(value: unknown): value is string {
  return typeof value === 'string' && /^https:\/\//u.test(value);
}

/**
 * Extract only facts present in pnpm 9's lockfile. E3 proves that all four locations below are
 * needed: importer specifier, importer version, package key, and package resolution. Git commits
 * are intentionally not read from a nonexistent resolution.commit field.
 */
export function resolveIntegrityFromPnpmLock(
  lockYaml: string | undefined,
  decl: PluginDeclaration,
): Result<LockedPlugin> {
  if (lockYaml === undefined || lockYaml.trim().length === 0) {
    return fail(
      'E_NO_LOCK',
      '缺少 pnpm-lock.yaml，不能证明安装事实。',
      '先完成插件安装并生成 pnpm-lock.yaml。',
    );
  }

  const document = parseDocument(lockYaml, { version: '1.2', uniqueKeys: true, merge: false });
  if (document.errors.length > 0 || !isRecord(document.toJS())) {
    return fail(
      'E_LOCK_INVALID',
      'pnpm-lock.yaml 不能解析为对象。',
      '使用 pnpm 11 重新生成 lockfile。',
    );
  }
  const root = document.toJS() as UnknownRecord;
  if (root.lockfileVersion !== '9.0') {
    return fail(
      'E_LOCK_VERSION',
      'pnpm lockfileVersion 不是已验证的 9.0。',
      '使用 pnpm 11.7.0 重新生成 lockfile。',
    );
  }
  const importers = root.importers;
  if (!isRecord(importers) || !isRecord(importers['.'])) {
    return fail(
      'E_LOCK_IMPORTER_MISSING',
      'lockfile 缺少 profile 的 . importer。',
      '在 profile 根目录重新安装插件。',
    );
  }
  const importerDependency = dependencyFromImporter(importers['.'], decl.name);
  if (importerDependency === undefined) {
    return fail(
      'E_LOCK_IMPORTER_MISSING',
      'lockfile importer 缺少该插件。',
      '确认该插件已安装到 profile dependencies。',
    );
  }
  const specifier = importerDependency.specifier;
  const version = importerDependency.version;
  if (typeof specifier !== 'string' || typeof version !== 'string') {
    return fail(
      'E_LOCK_IMPORTER_MISSING',
      'lockfile importer 缺少 specifier 或 version。',
      '用 pnpm 11 重新安装该插件。',
    );
  }
  const packages = root.packages;
  if (!isRecord(packages))
    return fail(
      'E_LOCK_PACKAGE_MISSING',
      'lockfile 缺少 packages 记录。',
      '用 pnpm 11 重新安装该插件。',
    );
  const found = matchingPackage(packages, decl.name, version);
  if (found === undefined) {
    return fail(
      'E_LOCK_PACKAGE_MISSING',
      'lockfile 缺少 importer version 对应的 package 记录。',
      '用 pnpm 11 重新安装该插件。',
    );
  }
  const resolution = found.value.resolution;
  if (
    !isRecord(resolution) ||
    typeof resolution.integrity !== 'string' ||
    !resolution.integrity.startsWith('sha512-')
  ) {
    return fail(
      'E_LOCK_DIGEST_MISSING',
      'lockfile package 缺少 sha512 integrity。',
      '拒绝导出，或由 CLI 显式标记 unverified。',
    );
  }

  const tarball = resolution.tarball;
  const importerIsUrl = https(specifier);
  if (decl.source.kind === 'github') {
    const commit = commitFrom([
      specifier,
      version,
      found.key,
      ...(typeof tarball === 'string' ? [tarball] : []),
    ]);
    if (commit === undefined) {
      return fail(
        'E_LOCK_GIT_UNPINNED',
        'git 来源只有 tag 或 branch，缺少 40 位小写 commit。',
        '改用 github:owner/repo#<40位小写sha>。',
      );
    }
    return pass({
      name: decl.name,
      resolved: { commit },
      integrity: { kind: 'git-commit', value: commit },
    });
  }

  if (decl.source.kind === 'tarball') {
    const url = https(tarball) ? tarball : importerIsUrl ? specifier : undefined;
    if (url === undefined) {
      return fail(
        'E_LOCK_SOURCE_MISMATCH',
        'tarball 来源在 importer 与 resolution 中都没有 HTTPS URL。',
        '使用 HTTPS tarball specifier 重新安装。',
      );
    }
    return pass({
      name: decl.name,
      resolved: { url },
      integrity: { kind: 'sha512', value: resolution.integrity },
    });
  }

  if (importerIsUrl) {
    return fail(
      'E_LOCK_SOURCE_MISMATCH',
      'importer specifier 是 URL，不能把 pnpm 归一化记录当作可信 npm 来源。',
      '将 manifest source 声明为 tarball 并锁定该 URL。',
    );
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    return fail(
      'E_LOCK_VERSION',
      'npm importer version 不是精确版本。',
      '使用产生精确 version 的 pnpm lockfile。',
    );
  }
  return pass({
    name: decl.name,
    resolved: { version },
    integrity: { kind: 'npm-sri', value: resolution.integrity },
  });
}
