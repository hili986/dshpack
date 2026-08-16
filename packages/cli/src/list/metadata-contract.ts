import { isDeepStrictEqual } from 'node:util';

import { type PackLock, validateLockValue, validatePackPath } from '@dshpack/core';
import { valid } from 'semver';

export interface InstalledPluginMetadata {
  name: string;
  packageJsonSha512: string;
  bundlePatch: string;
  actualResolved: Readonly<Record<string, unknown>>;
  actualIntegrity: Readonly<Record<string, unknown>>;
}

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
  plugins: readonly InstalledPluginMetadata[];
  effectiveLock: PackLock;
  sideEffects: readonly ['profile/cordis.yml'];
}

function validGeneratedAt(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validGeneratedBy(value: string): boolean {
  if (!value.startsWith('dshpack@')) return false;
  const version = value.slice('dshpack@'.length);
  return valid(version) === version;
}

function validFiles(lock: PackLock): boolean {
  const paths = new Set<string>();
  for (const file of lock.files) {
    const portablePath = file.path.toLowerCase();
    if (
      !validatePackPath(file.path).ok ||
      portablePath === 'pack.yml' ||
      portablePath === 'pack.lock.yml' ||
      paths.has(portablePath)
    )
      return false;
    paths.add(portablePath);
  }
  return true;
}

function matchingPlugins(lock: PackLock, installed: readonly InstalledPluginMetadata[]): boolean {
  if (lock.plugins.length !== installed.length) return false;
  return lock.plugins.every((plugin, index) => {
    const fact = installed[index];
    return (
      fact !== undefined &&
      plugin.name === fact.name &&
      isDeepStrictEqual(plugin.resolved, fact.actualResolved) &&
      isDeepStrictEqual(plugin.integrity, fact.actualIntegrity) &&
      plugin.packageJsonSha512 === fact.packageJsonSha512 &&
      plugin.bundlePatch === fact.bundlePatch
    );
  });
}

export function validEffectiveLock(
  value: unknown,
  manifestDigest: string,
  installedAt: string,
  installed: readonly InstalledPluginMetadata[],
): value is PackLock {
  const parsed = validateLockValue(value);
  if (!parsed.ok || parsed.value === undefined) return false;
  const lock = parsed.value;
  return (
    lock.manifestSha256 === manifestDigest &&
    lock.generatedAt === installedAt &&
    validGeneratedAt(lock.generatedAt) &&
    validGeneratedBy(lock.generatedBy) &&
    valid(lock.dsh.exportedFrom) === lock.dsh.exportedFrom &&
    validFiles(lock) &&
    matchingPlugins(lock, installed)
  );
}
