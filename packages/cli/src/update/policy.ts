import { buildAuthorizationKey } from '../install/profile-workspace.js';
import type { ValidatedPackMaterial } from '../install/read.js';
import type { InstallResolvedPlugin } from '../install/types.js';
import type { InstalledMetadataV1 } from '../metadata/contracts.js';

export interface UpdateAuthorizationInput {
  readonly dryRun?: boolean;
  readonly yes?: boolean;
  readonly interactive: boolean;
  readonly json?: boolean;
  readonly allowBuilds?: readonly string[];
  readonly allowDangerFullAccess?: boolean;
  readonly allowVersionMismatch?: boolean;
}

export type AuthorizationDelta =
  | {
      readonly kind: 'new-plugin';
      readonly plugin: string;
      /** Stable identity includes the exact resolved target and integrity evidence. */
      readonly identity: string;
      readonly change: 'new' | 'identity-change';
    }
  | {
      readonly kind: 'allow-build';
      readonly plugin: string;
      readonly authorization: string;
    }
  | { readonly kind: 'danger-full-access' }
  | {
      readonly kind: 'version-mismatch';
      readonly current: string;
      readonly tested: readonly string[];
    };

export interface UpdateAuthorizationDecision {
  readonly status: 'ready' | 'review-only' | 'requires-interaction' | 'rejected';
  /** Items that remain unapproved after explicit authorization flags are evaluated. */
  readonly missing: readonly AuthorizationDelta[];
  /** Routine update consent is independent from every dangerous authorization. */
  readonly normalConfirmationRequired: boolean;
}

function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

/** A resolved package identity cannot be confused with an unpinned declaration name. */
export function resolvedPluginIdentity(plugin: InstallResolvedPlugin): string {
  return `${plugin.name}\u0000${canonical(plugin.resolved)}\u0000${canonical(plugin.integrity)}`;
}

function installedPluginIdentity(plugin: InstalledMetadataV1['plugins'][number]): string {
  return `${plugin.name}\u0000${canonical(plugin.actualResolved)}\u0000${canonical(plugin.actualIntegrity)}`;
}

/**
 * Report privilege increases using only immutable marker facts and the validated target pack.
 * A marker deliberately does not persist a previous `allowBuilds` declaration, so target build
 * permission is conservative: an installed identity asking to run builds is always re-authorized.
 */
export function authorizationDelta(input: {
  readonly marker: InstalledMetadataV1;
  readonly material: ValidatedPackMaterial;
  readonly resolution: readonly InstallResolvedPlugin[];
  readonly dshVersion: string;
}): readonly AuthorizationDelta[] {
  const installed = new Set(input.marker.plugins.map(installedPluginIdentity));
  const installedNames = new Set(input.marker.plugins.map((plugin) => plugin.name));
  const declarations = new Map(
    input.material.manifest.plugins.map((plugin) => [plugin.name, plugin]),
  );
  const delta: AuthorizationDelta[] = [];
  for (const plugin of input.resolution) {
    const identity = resolvedPluginIdentity(plugin);
    if (!installed.has(identity)) {
      delta.push({
        kind: 'new-plugin',
        plugin: plugin.name,
        identity,
        change: installedNames.has(plugin.name) ? 'identity-change' : 'new',
      });
    }
    const declaration = declarations.get(plugin.name);
    if (declaration?.allowBuilds === true)
      delta.push({
        kind: 'allow-build',
        plugin: plugin.name,
        authorization: buildAuthorizationKey(declaration),
      });
  }
  if (
    input.marker.defaults.permissionPreset !== 'danger-full-access' &&
    input.material.manifest.defaults.permissionPreset === 'danger-full-access'
  )
    delta.push({ kind: 'danger-full-access' });
  if (!input.material.manifest.dsh.tested.includes(input.dshVersion))
    delta.push({
      kind: 'version-mismatch',
      current: input.dshVersion,
      tested: [...input.material.manifest.dsh.tested],
    });
  return delta;
}

function isExplicitlyApproved(item: AuthorizationDelta, input: UpdateAuthorizationInput): boolean {
  switch (item.kind) {
    case 'allow-build':
      return (input.allowBuilds ?? []).includes(item.authorization);
    case 'danger-full-access':
      return input.allowDangerFullAccess === true;
    case 'version-mismatch':
      return input.allowVersionMismatch === true;
    case 'new-plugin':
      // There is intentionally no non-interactive blanket flag for a newly resolved plugin.
      return false;
  }
}

/** `--yes` confirms a routine update only; it never grants an authorization delta. */
export function decideUpdateAuthorization(
  input: UpdateAuthorizationInput,
  delta: readonly AuthorizationDelta[],
): UpdateAuthorizationDecision {
  if (input.dryRun === true)
    return { status: 'review-only', missing: [], normalConfirmationRequired: false };
  const missing = delta.filter((item) => !isExplicitlyApproved(item, input));
  const normalConfirmationRequired = input.yes !== true;
  if (missing.length === 0 && !normalConfirmationRequired)
    return { status: 'ready', missing, normalConfirmationRequired };
  if (input.interactive && input.json !== true)
    return { status: 'requires-interaction', missing, normalConfirmationRequired };
  return { status: 'rejected', missing, normalConfirmationRequired };
}
