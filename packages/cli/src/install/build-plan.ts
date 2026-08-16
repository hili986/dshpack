import { createHash } from 'node:crypto';

import type { PackLock, PackManifest } from '@dshpack/core';

import type { SourceProvenance } from '../adapters/source.js';
import type {
  InstallEnvironmentFacts,
  InstallPathBeforeState,
  InstallPlan,
  InstallPlanAsset,
  InstallPlanOptions,
  InstallPlanPlugin,
  InstallPlanSideEffect,
  InstallPlanSourceFile,
  InstallPlanWrite,
  InstallTargetBeforeState,
} from './types.js';

function sha256(value: unknown): string {
  return `sha256-${createHash('sha256').update(JSON.stringify(value)).digest('base64url')}`;
}

export function normalizeTargetBeforeState(
  value: InstallTargetBeforeState,
): InstallTargetBeforeState {
  return {
    profile: value.profile,
    skills: [...value.skills].sort((a, b) => a.path.localeCompare(b.path, 'en')),
    presets: [...value.presets].sort((a, b) => a.path.localeCompare(b.path, 'en')),
    settings: value.settings,
    ...(value.externalDefaultPreset === undefined
      ? {}
      : { externalDefaultPreset: value.externalDefaultPreset }),
  };
}

export function digestTargetBeforeState(value: InstallTargetBeforeState): string {
  return sha256(normalizeTargetBeforeState(value));
}

function uniqueTopLevel(paths: readonly string[], prefix: string): string[] {
  return [
    ...new Set(
      paths
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length).split('/')[0])
        .filter((name): name is string => name !== undefined && name.length > 0),
    ),
  ].sort((left, right) => left.localeCompare(right, 'en'));
}

export function skillsIn(paths: readonly string[]): { id: string; source: string }[] {
  const skills = new Map<string, string>();
  for (const path of paths) {
    if (!path.startsWith('skills/')) continue;
    const remainder = path.slice('skills/'.length);
    const first = remainder.split('/')[0] as string;
    const flat = !remainder.includes('/') && first.endsWith('.md');
    const id = flat ? first.slice(0, -3) : first;
    if (!skills.has(id)) skills.set(id, flat ? path : `skills/${first}`);
  }
  return [...skills].map(([id, source]) => ({ id, source }));
}

function beforeAt(
  states: readonly InstallPathBeforeState[],
  target: string,
): InstallPathBeforeState | undefined {
  return states.find(({ path }) => path === target);
}

function asset(
  id: string,
  source: string,
  target: string,
  states: readonly InstallPathBeforeState[],
  force: boolean,
  effectiveAt: InstallPlanAsset['effectiveAt'],
): InstallPlanAsset {
  const collision = beforeAt(states, target)?.state === 'present';
  return {
    id,
    source,
    target,
    collision,
    action: collision ? (force ? 'replace' : 'skip') : 'create',
    effectiveAt,
  };
}

function assetsFor(
  paths: readonly string[],
  before: InstallTargetBeforeState,
  force: boolean,
): { skills: InstallPlanAsset[]; presets: InstallPlanAsset[] } {
  return {
    skills: skillsIn(paths).map(({ id, source }) =>
      asset(id, source, `skills/${id}`, before.skills, force, '热生效'),
    ),
    presets: uniqueTopLevel(paths, 'presets/').map((id) =>
      asset(id, `presets/${id}`, `.agent-presets/${id}`, before.presets, force, '新会话生效'),
    ),
  };
}

function writesFor(
  manifest: PackManifest,
  profile: string,
  assets: { skills: readonly InstallPlanAsset[]; presets: readonly InstallPlanAsset[] },
): InstallPlanWrite[] {
  const writes: InstallPlanWrite[] = [
    {
      path: `profiles/${profile}`,
      kind: 'profile',
      policy: 'create-or-replace',
      effectiveAt: '重启生效',
    },
    {
      path: `profiles/${profile}/cordis.patch.yml`,
      kind: 'profile',
      policy: 'transactional',
      effectiveAt: '重启生效',
    },
  ];
  for (const item of assets.skills) {
    writes.push({
      path: item.target,
      kind: 'skill',
      policy: item.action === 'skip' ? 'skip-existing' : 'create-or-replace',
      effectiveAt: item.effectiveAt,
    });
  }
  for (const item of assets.presets) {
    writes.push({
      path: item.target,
      kind: 'preset',
      policy: item.action === 'skip' ? 'skip-existing' : 'create-or-replace',
      effectiveAt: item.effectiveAt,
    });
  }
  if (manifest.settings !== undefined) {
    writes.push({
      path: 'settings.yaml',
      kind: 'settings',
      policy: 'merge',
      effectiveAt: '新会话生效',
    });
  }
  writes.push({
    path: `.dshpack/installed/${profile}.json`,
    kind: 'metadata',
    policy: 'transactional',
    effectiveAt: '热生效',
  });
  return writes;
}

export function buildInstallPlan(input: {
  provenance: SourceProvenance;
  manifest: PackManifest;
  lock: PackLock;
  lockDigest: string;
  sourceFiles: readonly InstallPlanSourceFile[];
  plugins: readonly InstallPlanPlugin[];
  paths: readonly string[];
  targetProfile: string;
  options: InstallPlanOptions;
  environment: InstallEnvironmentFacts;
}): InstallPlan {
  const { manifest, lock, plugins, targetProfile, options, environment } = input;
  const requiredDangerousPermissions =
    manifest.defaults.permissionPreset === 'danger-full-access'
      ? (['danger-full-access'] as const)
      : ([] as const);
  const authorizedDangerousPermissions =
    requiredDangerousPermissions.length > 0 && options.allowDangerFullAccess === true
      ? (['danger-full-access'] as const)
      : ([] as const);
  const versionMismatch = !manifest.dsh.tested.includes(environment.dshVersion);
  const requiredBuilds = plugins.filter(({ allowBuilds }) => allowBuilds).map(({ name }) => name);
  const extraBuildApprovals = [...new Set(options.allowBuilds ?? [])]
    .filter((name) => !requiredBuilds.includes(name))
    .sort((left, right) => left.localeCompare(right, 'en'));
  const assets = assetsFor(input.paths, environment.targetBeforeState, options.force === true);
  const beforeState = normalizeTargetBeforeState(environment.targetBeforeState);
  const stateDigest = sha256({
    targetProfile,
    dshVersion: environment.dshVersion,
    pnpmVersion: environment.pnpmVersion,
    targetBeforeStateDigest: environment.targetBeforeStateDigest,
  });
  const packPreset = manifest.defaults.agentPreset;
  const presetFromPack =
    packPreset !== undefined && assets.presets.some(({ id }) => id === packPreset);
  const draft = {
    planVersion: 0 as const,
    manifestDigest: lock.manifestSha256,
    lockDigest: input.lockDigest,
    sourceFiles: [...input.sourceFiles].sort((a, b) => a.path.localeCompare(b.path, 'en')),
    stateDigest,
    source: input.provenance,
    dshHome: environment.dshHome,
    pack: { name: manifest.name, version: manifest.version },
    targetProfile,
    replaceExistingProfile: environment.profileExists && options.replace === true,
    frozen: true as const,
    dsh: { current: environment.dshVersion, tested: manifest.dsh.tested, versionMismatch },
    pnpm: { current: environment.pnpmVersion },
    plugins,
    allowBuilds: requiredBuilds,
    extraBuildApprovals,
    skills: assets.skills,
    presets: assets.presets,
    mcp: manifest.mcp.map(({ serverName, transport, url }) => ({
      serverName,
      transport,
      source: url,
      target: 'profile patch' as const,
      action: 'configure' as const,
      effectiveAt: '重启生效' as const,
    })),
    defaults: {
      ...(packPreset === undefined
        ? {}
        : {
            agentPreset: {
              value: packPreset,
              source: presetFromPack ? ('pack' as const) : ('environment' as const),
              effectiveAt: '仅空白会话' as const,
            },
          }),
      permissionPreset: {
        value: manifest.defaults.permissionPreset,
        effectiveAt: '仅空白会话' as const,
      },
    },
    settingsNamespaces:
      manifest.settings === undefined
        ? []
        : [
            {
              namespace: 'agent-presets' as const,
              source: 'settings/agent-presets.yml' as const,
              target: 'settings.yaml#agent-presets' as const,
              action: 'merge' as const,
              effectiveAt: '新会话生效' as const,
            },
          ],
    writes: writesFor(manifest, targetProfile, assets),
    sideEffects: [
      {
        path: `profiles/${targetProfile}/cordis.yml`,
        reason: 'dsh --dump-config（E9）',
      },
    ] satisfies InstallPlanSideEffect[],
    beforeState,
    rollbackSnapshot: {
      enabled: true as const,
      targetBeforeStateDigest: environment.targetBeforeStateDigest,
    },
    requiredDangerousPermissions,
    authorizedDangerousPermissions,
  };
  return { ...draft, planDigest: sha256(draft) };
}
