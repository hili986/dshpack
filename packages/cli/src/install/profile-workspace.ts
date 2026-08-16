import type { PluginDeclaration } from '@dshpack/core';
import { isMap, parseDocument } from 'yaml';

import { assertPluginDeclaration, InstallProfileError, isRecord } from './profile-common.js';

export function buildAuthorizationKey(plugin: PluginDeclaration): string {
  assertPluginDeclaration(plugin);
  if (plugin.source.kind === 'github')
    return `${plugin.name}@git+https://github.com/${plugin.source.owner}/${plugin.source.repo}.git`;
  return plugin.name;
}

/**
 * Comment-preserving, fail-closed RMW. Only the declaration-derived exact key is changed; callers
 * cannot pass globs or broaden another package's authorization.
 */
export function updateWorkspaceAllowBuilds(source: string, plugin: PluginDeclaration): string {
  const authorization = buildAuthorizationKey(plugin);
  const document = parseDocument(source, { version: '1.2', uniqueKeys: true, merge: false });
  const root = document.contents;
  if (document.errors.length > 0 || !isMap(root))
    throw new InstallProfileError(
      'E_WORKSPACE_YAML',
      'pnpm-workspace.yaml 不是可安全修改的 mapping。',
    );
  const values = document.toJS();
  if (!isRecord(values))
    throw new InstallProfileError('E_WORKSPACE_YAML', 'pnpm-workspace.yaml 顶层不是 mapping。');
  const existing = values.allowBuilds;
  if (existing !== undefined) {
    if (!isRecord(existing) || Object.values(existing).some((value) => typeof value !== 'boolean'))
      throw new InstallProfileError(
        'E_WORKSPACE_ALLOW_BUILDS',
        'allowBuilds 必须是仅含 boolean 值的 mapping。',
      );
  }
  if (existing?.[authorization] === true) return source;
  document.setIn(['allowBuilds', authorization], true);
  return String(document);
}
