import { createHash } from 'node:crypto';

import type { PackLock, PackManifest } from '@dshpack/core';

import type { SourceProvenance } from '../adapters/source.js';
import type {
  InstallEnvironmentFacts,
  InstallPlan,
  InstallPlanOptions,
  InstallPlanPlugin,
  InstallPlanSideEffect,
  InstallPlanWrite,
} from './types.js';

function sha256(value: unknown): string {
  return `sha256-${createHash('sha256').update(JSON.stringify(value)).digest('base64url')}`;
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

function writesFor(
  manifest: PackManifest,
  paths: readonly string[],
  profile: string,
  force: boolean,
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
  for (const skill of uniqueTopLevel(paths, 'skills/')) {
    // uniqueTopLevel only returns names derived from paths, so this assertion cannot invent a path.
    const source = paths.find(
      (path) => path === `skills/${skill}` || path.startsWith(`skills/${skill}/`),
    ) as string;
    writes.push({
      path: source,
      kind: 'skill',
      policy: force ? 'create-or-replace' : 'skip-existing',
      effectiveAt: '热生效',
    });
  }
  for (const preset of uniqueTopLevel(paths, 'presets/')) {
    writes.push({
      path: `.agent-presets/${preset}`,
      kind: 'preset',
      policy: force ? 'create-or-replace' : 'skip-existing',
      effectiveAt: '新会话生效',
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
  const stateDigest = sha256({
    targetProfile,
    profileExists: environment.profileExists,
    dshVersion: environment.dshVersion,
    pnpmVersion: environment.pnpmVersion,
  });
  const draft = {
    planVersion: 0 as const,
    manifestDigest: lock.manifestSha256,
    stateDigest,
    source: input.provenance,
    pack: { name: manifest.name, version: manifest.version },
    targetProfile,
    replaceExistingProfile: environment.profileExists && options.replace === true,
    frozen: true as const,
    dsh: { current: environment.dshVersion, tested: manifest.dsh.tested, versionMismatch },
    pnpm: { current: environment.pnpmVersion },
    plugins,
    allowBuilds: plugins.filter(({ allowBuilds }) => allowBuilds).map(({ name }) => name),
    skills: uniqueTopLevel(input.paths, 'skills/'),
    presets: uniqueTopLevel(input.paths, 'presets/'),
    mcp: manifest.mcp.map(({ serverName }) => serverName),
    settingsNamespaces:
      manifest.settings === undefined ? ([] as const) : (['agent-presets'] as const),
    writes: writesFor(manifest, input.paths, targetProfile, options.force === true),
    sideEffects: [
      {
        path: `profiles/${targetProfile}/cordis.yml`,
        reason: 'dsh --dump-config（E9）',
      },
    ] satisfies InstallPlanSideEffect[],
    requiredDangerousPermissions,
    authorizedDangerousPermissions,
  };
  return { ...draft, planDigest: sha256(draft) };
}
