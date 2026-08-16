import { createHash } from 'node:crypto';

import type { ValidatedPackMaterial } from '../src/install/read.js';
import type { InstallResolution } from '../src/install/types.js';

const sha512 = (content: string): string =>
  `sha512-${createHash('sha512').update(content).digest('base64')}`;

export function fakeInstallResolution(
  material: ValidatedPackMaterial,
  frozen: boolean,
): InstallResolution {
  if (frozen) {
    if (material.lock === undefined || material.lockDigest === undefined)
      throw new Error('fixture frozen resolution requires lock');
    return {
      mode: 'frozen',
      resolutionDigest: material.lockDigest,
      plugins: material.lock.plugins.map((plugin) => ({
        name: plugin.name,
        resolved: plugin.resolved,
        integrity: plugin.integrity,
        expectedInstalledFacts: {
          packageJsonSha512: plugin.packageJsonSha512,
          bundlePatch: plugin.bundlePatch,
        },
      })),
    };
  }
  const plugins = material.manifest.plugins.map((plugin) => ({
    name: plugin.name,
    resolved:
      plugin.source.kind === 'npm'
        ? { version: '1.0.0' }
        : plugin.source.kind === 'github'
          ? { commit: plugin.source.ref }
          : { url: plugin.source.url },
    integrity:
      plugin.source.kind === 'npm'
        ? { kind: 'npm-sri' as const, value: sha512('example-bundle-tarball') }
        : plugin.source.kind === 'github'
          ? { kind: 'git-commit' as const, value: plugin.source.ref }
          : { kind: 'sha512' as const, value: sha512('example-bundle-tarball') },
  }));
  return {
    mode: 'manifest',
    resolutionDigest: `sha256-${createHash('sha256')
      .update(JSON.stringify(plugins))
      .digest('base64url')}`,
    plugins,
  };
}
