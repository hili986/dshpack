import type { PluginDeclaration } from '@dshpack/core';

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const githubIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const gitCommit = /^[a-f0-9]{40}$/u;

export class InstallProfileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path?: string,
    readonly reasonCode?: string,
  ) {
    super(message);
    this.name = 'InstallProfileError';
  }
}

export function assertPackageName(name: string): void {
  if (!packageNamePattern.test(name))
    throw new InstallProfileError('E_PLUGIN_NAME', `插件包名不安全：${name}`);
}

export function assertPluginDeclaration(plugin: PluginDeclaration): void {
  assertPackageName(plugin.name);
  const { source } = plugin;
  if (source.kind === 'github') {
    if (
      !githubIdentifier.test(source.owner) ||
      !githubIdentifier.test(source.repo) ||
      !gitCommit.test(source.ref)
    )
      throw new InstallProfileError('E_PLUGIN_SOURCE', `GitHub 插件来源不合法：${plugin.name}`);
    return;
  }
  if (source.kind === 'tarball') {
    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      throw new InstallProfileError('E_PLUGIN_SOURCE', `tarball URL 不合法：${plugin.name}`);
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '')
      throw new InstallProfileError(
        'E_PLUGIN_SOURCE',
        `tarball URL 必须是无 userinfo 的 HTTPS：${plugin.name}`,
      );
    return;
  }
  if (source.range.trim().length === 0)
    throw new InstallProfileError('E_PLUGIN_SOURCE', `npm range 为空：${plugin.name}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}
