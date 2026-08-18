import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PackLock } from '@dshpack/core';

export const SHA256_A = `sha256-${createHash('sha256').update('list-switch fixture A').digest('base64url')}`;
export const SHA256_B = `sha256-${createHash('sha256').update('list-switch fixture B').digest('base64url')}`;
export const SHA512 = `sha512-${createHash('sha512').update('list-switch fixture SHA-512').digest('base64')}`;

export interface SecurityMarker {
  metadataVersion: number;
  profile: string;
  pack: { name: string; version: string; manifestDigest: string };
  planDigest: string;
  installedAt: string;
  txid: string;
  source: Record<string, unknown>;
  defaults: { agentPreset?: string; permissionPreset: string };
  plugins: unknown[];
  effectiveLock: PackLock;
  sideEffects: string[];
}

export interface SecurityPluginFact {
  name: string;
  packageJsonSha512: string;
  bundlePatch: string;
  actualResolved: PackLock['plugins'][number]['resolved'];
  actualIntegrity: PackLock['plugins'][number]['integrity'];
}

export function securityEffectiveLock(
  plugins: readonly SecurityPluginFact[] = [],
  manifestSha256 = SHA256_A,
): PackLock {
  return {
    lockVersion: 0,
    manifestSha256,
    generatedBy: 'dshpack@0.0.0',
    generatedAt: '2026-08-16T00:00:00.000Z',
    dsh: { exportedFrom: '0.1.0-rc.6' },
    plugins: plugins.map((plugin) => ({
      name: plugin.name,
      resolved: plugin.actualResolved,
      integrity: plugin.actualIntegrity,
      packageJsonSha512: plugin.packageJsonSha512,
      bundlePatch: plugin.bundlePatch,
    })),
    files: [],
  };
}

export async function securityHome(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `dshpack-${prefix}-`));
}

export async function securityProfile(home: string, name = 'demo'): Promise<void> {
  const root = join(home, 'profiles', name);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: `dsh-profile-${name}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }),
    'utf8',
  );
  await writeFile(join(root, 'cordis.patch.yml'), '[]\n', 'utf8');
  await writeFile(
    join(root, 'pnpm-workspace.yaml'),
    "packages: ['.']\nnodeLinker: hoisted\nautoInstallPeers: false\n",
    'utf8',
  );
}

export function securityMarker(home: string, profile = 'demo'): SecurityMarker {
  return {
    metadataVersion: 0,
    profile,
    pack: { name: 'demo-pack', version: '1.0.0', manifestDigest: SHA256_A },
    planDigest: SHA256_B,
    installedAt: '2026-08-16T00:00:00.000Z',
    txid: 'tx-security',
    source: { kind: 'directory', path: home },
    defaults: { agentPreset: 'demo-preset', permissionPreset: 'workspace-write' },
    plugins: [],
    effectiveLock: securityEffectiveLock(),
    sideEffects: ['profile/cordis.yml'],
  };
}

export async function writeSecurityMarker(
  home: string,
  value: SecurityMarker = securityMarker(home),
): Promise<void> {
  const root = join(home, '.dshpack', 'installed');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${value.profile}.json`), JSON.stringify(value), 'utf8');
}

export async function securityTrackedHome(prefix = 'switch-security'): Promise<string> {
  const home = await securityHome(prefix);
  await securityProfile(home);
  await writeSecurityMarker(home);
  const preset = join(home, '.agent-presets', 'demo-preset');
  await mkdir(preset, { recursive: true });
  await writeFile(join(preset, 'agent.cordis.yml'), '[]\n', 'utf8');
  return home;
}
