import { createHash } from 'node:crypto';
import { chmod, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type PluginDeclaration, resolveIntegrityFromPnpmLock } from '@dshpack/core';

import { SourceError } from '../adapters/source.js';
import type { NetworkDependencies } from '../adapters/source-network.js';
import { resolvePluginTarball } from './plugin-download.js';
import type { ValidatedPackMaterial } from './read.js';
import type { PathProcessRuntime } from './runtime-process.js';
import type { InstallResolution, InstallResolvedPlugin } from './types.js';

const MAX_RESOLUTION_LOCK_BYTES = 10 * 1024 * 1024;

export interface InstallResolverDependencies {
  process: PathProcessRuntime;
  network?: NetworkDependencies;
  makeWorkspace?: () => Promise<string>;
  removeWorkspace?: (path: string) => Promise<void>;
}

function failure(code: string, message: string, hint?: string): SourceError {
  return new SourceError(code, 20, message, hint);
}

function digest(plugins: readonly InstallResolvedPlugin[]): string {
  return `sha256-${createHash('sha256').update(JSON.stringify(plugins)).digest('base64url')}`;
}

export function frozenInstallResolution(material: ValidatedPackMaterial): InstallResolution {
  if (material.lock === undefined || material.lockDigest === undefined)
    throw failure('E_NO_LOCK', '--frozen 要求已验证的 pack.lock.yml。');
  const plugins = material.lock.plugins.map((plugin) => ({
    name: plugin.name,
    resolved: plugin.resolved,
    integrity: plugin.integrity,
    expectedInstalledFacts: {
      packageJsonSha512: plugin.packageJsonSha512,
      bundlePatch: plugin.bundlePatch,
    },
  }));
  return { mode: 'frozen', resolutionDigest: material.lockDigest, plugins };
}

async function readBoundedLock(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(MAX_RESOLUTION_LOCK_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_RESOLUTION_LOCK_BYTES)
      throw failure('E_RESOLUTION_LOCK_LIMIT', '临时 pnpm-lock.yaml 超过 10 MiB 上限。');
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function npmPlugins(
  material: ValidatedPackMaterial,
  dshHome: string,
  dependencies: InstallResolverDependencies,
): Promise<InstallResolvedPlugin[]> {
  const declarations = material.manifest.plugins.filter(
    (
      plugin,
    ): plugin is PluginDeclaration & {
      source: Extract<PluginDeclaration['source'], { kind: 'npm' }>;
    } => plugin.source.kind === 'npm',
  );
  if (declarations.length === 0) return [];
  const workspace = await (
    dependencies.makeWorkspace ?? (() => mkdtemp(join(tmpdir(), 'dshpack-resolve-')))
  )();
  let result: InstallResolvedPlugin[] | undefined;
  let caught: unknown;
  try {
    await chmod(workspace, 0o700);
    await writeFile(
      join(workspace, 'package.json'),
      '{"name":"dshpack-resolver","private":true}\n',
      {
        flag: 'wx',
        mode: 0o600,
      },
    );
    const specs = declarations.map((plugin) => `${plugin.name}@${plugin.source.range}`);
    await dependencies.process.runPnpm(
      [
        'add',
        '--lockfile-only',
        '--ignore-scripts',
        '--store-dir',
        join(workspace, 'store'),
        '--cache-dir',
        join(workspace, 'cache'),
        '--state-dir',
        join(workspace, 'state'),
        ...specs,
      ],
      {
        dshHome,
        cwd: workspace,
        scriptPolicy: 'deny',
      },
    );
    const lock = await readBoundedLock(join(workspace, 'pnpm-lock.yaml'));
    result = declarations.map((plugin) => {
      const resolved = resolveIntegrityFromPnpmLock(lock, plugin);
      if (!resolved.ok || resolved.value === undefined)
        throw failure(
          resolved.diagnostics[0]?.code ?? 'E_PLUGIN_RESOLUTION',
          `无法解析 ${plugin.name} 的精确 registry 来源。`,
          resolved.diagnostics[0]?.hint,
        );
      return resolved.value;
    });
  } catch (error) {
    caught = error;
  }
  try {
    await (
      dependencies.removeWorkspace ?? ((path: string) => rm(path, { recursive: true, force: true }))
    )(workspace);
  } catch {
    throw failure(
      'E_RESOLUTION_CLEANUP',
      `插件解析私有临时目录清理失败：${workspace}`,
      `人工检查并移除：${workspace}`,
    );
  }
  if (caught !== undefined) {
    if (caught instanceof SourceError) throw caught;
    throw failure('E_PLUGIN_RESOLUTION', 'pnpm 无法生成精确的临时 resolution lock。');
  }
  return result as InstallResolvedPlugin[];
}

async function pinnedPlugins(
  material: ValidatedPackMaterial,
  network: NetworkDependencies,
): Promise<InstallResolvedPlugin[]> {
  const resolved: InstallResolvedPlugin[] = [];
  for (const plugin of material.manifest.plugins) {
    if (plugin.source.kind === 'npm') continue;
    resolved.push(
      plugin.source.kind === 'github'
        ? {
            name: plugin.name,
            resolved: { commit: plugin.source.ref },
            integrity: { kind: 'git-commit', value: plugin.source.ref },
          }
        : await resolvePluginTarball(plugin, network),
    );
  }
  return resolved;
}

export async function resolveInstallPlugins(
  material: ValidatedPackMaterial,
  options: { dshHome: string; frozen: boolean },
  dependencies: InstallResolverDependencies,
): Promise<InstallResolution> {
  if (options.frozen) return frozenInstallResolution(material);
  const resolved = [
    ...(await npmPlugins(material, options.dshHome, dependencies)),
    ...(await pinnedPlugins(material, dependencies.network ?? {})),
  ];
  const byName = new Map(resolved.map((plugin) => [plugin.name, plugin]));
  const plugins = material.manifest.plugins.map(({ name }) => {
    const plugin = byName.get(name);
    if (plugin === undefined)
      throw failure('E_PLUGIN_RESOLUTION', `插件 ${name} 缺少精确解析结果。`);
    return plugin;
  });
  return { mode: 'manifest', resolutionDigest: digest(plugins), plugins };
}
