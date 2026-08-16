import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PackLockedPlugin, PackManifest } from '@dshpack/core';
import { stringify } from 'yaml';

import type {
  InstallPathBeforeState,
  InstallTargetBeforeState,
  PrepareInstallPlanInput,
} from '../src/install/types.js';

const digest = (algorithm: 'sha256' | 'sha512', bytes: Uint8Array): string =>
  `${algorithm}-${createHash(algorithm)
    .update(bytes)
    .digest(algorithm === 'sha256' ? 'base64url' : 'base64')}`;
const packageDigest = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
export const integrity = `sha512-${Buffer.alloc(64, 9).toString('base64')}`;
export const commit = '0123456789abcdef0123456789abcdef01234567';

export function targetBeforeState(
  profile = 'research-pack',
  options: {
    profilePresent?: boolean;
    skills?: readonly InstallPathBeforeState[];
    presets?: readonly InstallPathBeforeState[];
    settings?: InstallPathBeforeState;
  } = {},
): { state: InstallTargetBeforeState; digest: string } {
  const state: InstallTargetBeforeState = {
    profile: options.profilePresent
      ? { path: `profiles/${profile}`, state: 'present', sha256: 'sha256-profile' }
      : { path: `profiles/${profile}`, state: 'absent' },
    skills: options.skills ?? [],
    presets: options.presets ?? [],
    settings: options.settings ?? { path: 'settings.yaml', state: 'absent' },
  };
  return { state, digest: digest('sha256', Buffer.from(JSON.stringify(state))) };
}

export function manifest(plugin?: Partial<PackManifest['plugins'][number]>): PackManifest {
  return {
    formatVersion: 0,
    name: 'research-pack',
    version: '1.0.0',
    description: 'test pack',
    author: 'tester',
    license: 'MIT',
    dsh: { tested: ['0.1.0-rc.6'] },
    plugins: [
      {
        name: 'example-bundle',
        source: { kind: 'npm', range: '^1.2.0' },
        allowBuilds: false,
        ...plugin,
      },
    ],
    mcp: [],
    defaults: { permissionPreset: 'workspace-write' },
  };
}

export function lockedPlugin(overrides: Partial<PackLockedPlugin> = {}): PackLockedPlugin {
  return {
    name: 'example-bundle',
    resolved: { version: '1.2.3' },
    integrity: { kind: 'npm-sri', value: integrity },
    packageJsonSha512: packageDigest,
    bundlePatch: 'cordis.patch.yml',
    ...overrides,
  };
}

interface FixtureOptions {
  manifest?: PackManifest;
  locked?: PackLockedPlugin;
  files?: Record<string, string>;
  omitLock?: boolean;
}

export async function fixture(options: FixtureOptions = {}): Promise<string> {
  const root = join(tmpdir(), `dshpack-plan-${crypto.randomUUID()}`);
  await mkdir(join(root, 'patch'), { recursive: true });
  const packText = stringify(options.manifest ?? manifest(), { lineWidth: 0 });
  const payloads: Record<string, string> = {
    'patch/cordis.patch.yml': '[]\n',
    ...options.files,
  };
  await writeFile(join(root, 'pack.yml'), packText);
  for (const [path, content] of Object.entries(payloads)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  if (!options.omitLock) {
    const lock = {
      lockVersion: 0,
      manifestSha256: digest('sha256', Buffer.from(packText)),
      generatedBy: 'dshpack@0.0.0',
      generatedAt: '2026-08-16T00:00:00Z',
      dsh: { exportedFrom: '0.1.0-rc.6' },
      plugins: [options.locked ?? lockedPlugin()],
      files: Object.entries(payloads).map(([path, content]) => ({
        path,
        sha512: digest('sha512', Buffer.from(content)),
      })),
    };
    await writeFile(join(root, 'pack.lock.yml'), stringify(lock, { lineWidth: 0 }));
  }
  return root;
}

export function input(
  directory: string,
  overrides: Partial<PrepareInstallPlanInput> = {},
): PrepareInstallPlanInput {
  const before = targetBeforeState();
  const { options, ...remaining } = overrides;
  return {
    source: { directory, provenance: { kind: 'directory', path: directory } },
    environment: {
      dshHome: join(tmpdir(), `absent-dsh-home-${crypto.randomUUID()}`),
      dshVersion: '0.1.0-rc.6',
      pnpmVersion: '11.7.0',
      profileExists: false,
      interactive: false,
      targetBeforeState: before.state,
      targetBeforeStateDigest: before.digest,
    },
    ...remaining,
    options:
      options === undefined
        ? { sourceArgument: directory, yes: true, frozen: true }
        : { frozen: true, ...options },
  };
}

export async function directoryBytes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else result[absolute.slice(root.length + 1)] = (await readFile(absolute)).toString('base64');
    }
  };
  await visit(root);
  return result;
}
