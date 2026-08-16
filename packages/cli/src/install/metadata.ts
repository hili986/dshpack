import type { InstalledMetadataV0 } from '../list/contracts.js';
import type { InstalledPluginFact } from './profile-plugin.js';
import type { InstallPlan } from './types.js';

export function installedMetadata(
  plan: InstallPlan,
  plugins: readonly InstalledPluginFact[],
  installedAt: string,
  txid: string,
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
    sideEffects: ['profile/cordis.yml'],
  };
}
