import { join, resolve, sep } from 'node:path';

import type { Diagnostic } from '@dshpack/core';

export interface InstallOwnershipAsset {
  readonly target: string;
  readonly action: 'create' | 'replace' | 'skip';
}

/** The persisted ownership facts needed to attribute post-operation doctor findings. */
export interface InstallOwnership {
  readonly profile: string;
  readonly assets: readonly InstallOwnershipAsset[];
}

function ownedRoots(dshHome: string, ownership: InstallOwnership): readonly string[] {
  return [
    join(dshHome, 'profiles', ownership.profile),
    join(dshHome, 'settings.yaml'),
    ...ownership.assets
      .filter((asset) => asset.action !== 'skip')
      .map((asset) => join(dshHome, ...asset.target.split('/'))),
  ].map((path) => resolve(path));
}

/**
 * Whether a scoped post-operation doctor finding is this installation's to answer for.
 *
 * doctor grades the whole harness home: every skill anyone ever wrote and every profile.
 * Findings without a path describe the scoped target itself, while skipped assets remain
 * user-owned because this installation did not write them.
 */
export function attributableToInstall(
  item: Diagnostic,
  dshHome: string,
  ownership: InstallOwnership,
): boolean {
  if (item.path === undefined) return true;
  const path = resolve(item.path);
  return ownedRoots(dshHome, ownership).some(
    (root) => path === root || path.startsWith(`${root}${sep}`),
  );
}
