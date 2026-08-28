import type { PackLock } from '@dshpack/core';

import type { InstalledMetadataV1, SettingsContribution } from '../metadata/contracts.js';
import { GENERATED_BY } from '../version.js';
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
    generatedBy: GENERATED_BY,
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
  state: {
    assets: InstalledMetadataV1['assets'];
    settingsContribution: SettingsContribution;
    generation: number;
  },
): InstalledMetadataV1 {
  return {
    metadataVersion: 1,
    profile: plan.targetProfile,
    pack: {
      name: plan.pack.name,
      version: plan.pack.version,
      manifestDigest: plan.manifestDigest,
    },
    // Only persisted when non-empty so pre-provenance markers stay byte-compatible.
    ...(material.manifest.provenance?.length
      ? { provenance: material.manifest.provenance }
      : {}),
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
    assets: state.assets,
    settingsContribution: state.settingsContribution,
    generation: state.generation,
    installedBy: GENERATED_BY,
  };
}
