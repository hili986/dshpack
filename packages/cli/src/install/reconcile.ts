import type { Diagnostic, PackLockedPlugin, PluginDeclaration } from '@dshpack/core';
import { satisfies, validRange } from 'semver';

import type { InstallPlanPlugin } from './types.js';

export interface ReconcileResult {
  plugin?: InstallPlanPlugin;
  diagnostics: readonly Diagnostic[];
}

function failure(code: string, message: string, hint: string): ReconcileResult {
  return {
    diagnostics: [{ code, severity: 'error', message, hint, evidence: 'local' }],
  };
}

function normalizedTarballUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function npmSpec(
  declaration: PluginDeclaration,
  locked: PackLockedPlugin,
): ReconcileResult | string {
  if (!('version' in locked.resolved)) {
    return failure(
      'E_LOCK_NPM_RESOLUTION',
      `${declaration.name} 缺少 npm 精确版本。`,
      '重新生成 pack.lock.yml。',
    );
  }
  const source = declaration.source as Extract<PluginDeclaration['source'], { kind: 'npm' }>;
  if (validRange(source.range) === null) {
    return failure(
      'E_PLUGIN_NPM_RANGE',
      `${declaration.name} 的 npm range 无效。`,
      '使用 node-semver 支持的 range。',
    );
  }
  if (!satisfies(locked.resolved.version, source.range)) {
    return failure(
      'E_LOCK_NPM_RANGE',
      `${declaration.name}@${locked.resolved.version} 不满足 manifest range。`,
      '重新锁定满足 range 的精确版本。',
    );
  }
  if (locked.integrity.kind !== 'npm-sri' && locked.integrity.kind !== 'unverified') {
    return failure(
      'E_LOCK_NPM_INTEGRITY',
      `${declaration.name} 的 npm integrity 类型不匹配。`,
      'npm 源必须使用 npm-sri 或显式 unverified。',
    );
  }
  return `${declaration.name}@${locked.resolved.version}`;
}

function githubSpec(
  declaration: PluginDeclaration,
  locked: PackLockedPlugin,
): ReconcileResult | string {
  const source = declaration.source as Extract<PluginDeclaration['source'], { kind: 'github' }>;
  if (
    !('commit' in locked.resolved) ||
    locked.resolved.commit !== source.ref ||
    locked.integrity.kind !== 'git-commit' ||
    locked.integrity.value !== source.ref
  ) {
    return failure(
      'E_LOCK_GITHUB_COMMIT',
      `${declaration.name} 的 GitHub commit 未与 manifest 精确 pin 对齐。`,
      '用相同的 40 位小写 commit 重新生成 lock。',
    );
  }
  return `github:${source.owner}/${source.repo}#${source.ref}`;
}

function tarballSpec(
  declaration: PluginDeclaration,
  locked: PackLockedPlugin,
): ReconcileResult | string {
  const source = declaration.source as Extract<PluginDeclaration['source'], { kind: 'tarball' }>;
  const declared = normalizedTarballUrl(source.url);
  const resolved = 'url' in locked.resolved ? normalizedTarballUrl(locked.resolved.url) : undefined;
  if (declared === undefined)
    return failure(
      'E_PLUGIN_TARBALL_URL',
      `${declaration.name} 的 tarball URL 不安全。`,
      '使用无凭据、无 query 的 HTTPS URL。',
    );
  if (resolved === undefined || declared !== resolved)
    return failure(
      'E_LOCK_TARBALL_URL',
      `${declaration.name} 的 tarball URL 与 lock 不一致。`,
      '按 manifest URL 重新生成 lock。',
    );
  if (locked.integrity.kind !== 'sha512')
    return failure(
      'E_LOCK_TARBALL_INTEGRITY',
      `${declaration.name} 的 tarball 缺少强制 sha512 SRI。`,
      'tarball 不允许 unverified 绕过。',
    );
  return source.url;
}

export function reconcileLockedPlugin(
  declaration: PluginDeclaration,
  locked: PackLockedPlugin,
): ReconcileResult {
  if (declaration.name !== locked.name)
    return failure(
      'E_LOCK_PLUGIN_NAME',
      'manifest 与 lock 的插件名不一致。',
      '按 manifest 顺序重新生成 lock。',
    );
  const exact =
    declaration.source.kind === 'npm'
      ? npmSpec(declaration, locked)
      : declaration.source.kind === 'github'
        ? githubSpec(declaration, locked)
        : tarballSpec(declaration, locked);
  if (typeof exact !== 'string') return exact;
  return {
    diagnostics: [],
    plugin: {
      name: declaration.name,
      source: declaration.source,
      exactSpec: exact,
      integrity: locked.integrity,
      allowBuilds: declaration.allowBuilds,
      expectedPackageJsonSha512: locked.packageJsonSha512,
      expectedBundlePatch: locked.bundlePatch,
      effectiveAt: '重启生效',
    },
  };
}
