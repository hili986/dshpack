import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PackLockedPlugin, PluginDeclaration } from '@dshpack/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { stagePluginTarballDownload } from '../src/install/plugin-download.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const roots: string[] = [];
const bytes = Buffer.from('cleanup-bound-bytes');
const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const plugin: PluginDeclaration = {
  name: 'cleanup-plugin',
  source: { kind: 'tarball', url: 'https://plugins.example/plugin.tgz' },
  allowBuilds: false,
};
const locked: PackLockedPlugin = {
  name: plugin.name,
  resolved: { url: 'https://plugins.example/plugin.tgz' },
  integrity: { kind: 'sha512', value: digest },
  packageJsonSha512: digest,
  bundlePatch: 'index.yml',
};

async function parent(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-plugin-cleanup-'));
  roots.push(root);
  const privateDirectory = join(root, 'private');
  await mkdir(privateDirectory, { mode: 0o700 });
  return privateDirectory;
}

afterEach(async () => {
  vi.mocked(rm).mockReset();
  vi.mocked(rm).mockImplementation(
    (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rm,
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('plugin download cleanup failures', () => {
  it('reports a typed cleanup failure from the returned staging handle', async () => {
    const result = await stagePluginTarballDownload(plugin, locked, await parent(), {
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
      download: async () => ({
        statusCode: 200,
        body: (async function* () {
          yield bytes;
        })(),
      }),
    });
    vi.mocked(rm).mockRejectedValueOnce(new Error('cleanup denied'));
    await expect(result.cleanup()).rejects.toMatchObject({
      code: 'E_PLUGIN_CLEANUP',
      exitCode: 20,
    });
  });

  it('does not swallow cleanup failure while unwinding a download error', async () => {
    vi.mocked(rm).mockRejectedValueOnce(new Error('cleanup denied'));
    await expect(
      stagePluginTarballDownload(plugin, locked, await parent(), {
        resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
        download: async () => {
          throw new Error('TLS failed');
        },
      }),
    ).rejects.toMatchObject({ code: 'E_PLUGIN_CLEANUP', exitCode: 20 });
  });
});
