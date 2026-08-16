import type { PackLock } from '@dshpack/core';

import type { InstalledMetadataV0 } from '../list/contracts.js';
import type { InstalledPluginFact } from './profile-plugin.js';
import type { ValidatedPackMaterial } from './read.js';
import type { InstallPlan } from './types.js';

export function effectiveInstallLock(
  plan: InstallPlan,
  material: ValidatedPackMaterial,
  plugins: readonly InstalledPluginFact[],
  generatedAt: string,
): PackLock {
  return {
    lockVersion: 0,
    manifestSha256: plan.manifestDigest,
    generatedBy: 'dshpack@0.0.0',
    generatedAt,
    dsh: { exportedFrom: plan.dsh.current },
    plugins: plugins.map((plugin) => ({
      name: plugin.name,
      resolved: plugin.actualResolved,
      integrity: plugin.actualIntegrity,
      packageJsonSha512: plugin.packageJsonSha512,
      bundlePatch: plugin.bundlePatch,
    })),
    files: material.sourceFiles
      .filter(({ path }) => path !== 'pack.yml' && path !== 'pack.lock.yml')
      .map((file) => ({ ...file })),
  };
}

export function installedMetadata(
  plan: InstallPlan,
  plugins: readonly InstalledPluginFact[],
  installedAt: string,
  txid: string,
  material: ValidatedPackMaterial,
): InstalledMetadataV0 {
  return {
    metadataVersion: 0,
    profile: plan.targetProfile,
    pack: {
      name: plan.pack.name,
      version: plan.pack.version,
      manifestDigest: plan.manifestDigest,
    },
    planDigest: plan.planDigest,
    installedAt,
    txid,
    source: plan.source,
    defaults: {
      ...(plan.defaults.agentPreset === undefined
        ? {}
        : { agentPreset: plan.defaults.agentPreset.value }),
      permissionPreset: plan.defaults.permissionPreset.value,
    },
    plugins,
    effectiveLock: effectiveInstallLock(plan, material, plugins, installedAt),
    sideEffects: ['profile/cordis.yml'],
  };
}
