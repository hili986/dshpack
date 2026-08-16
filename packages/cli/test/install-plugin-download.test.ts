import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PackLockedPlugin, PluginDeclaration } from '@dshpack/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { stagePluginTarballDownload } from '../src/install/plugin-download.js';

const roots: string[] = [];
const plugin: PluginDeclaration = {
  name: 'downloaded-plugin',
  source: { kind: 'tarball', url: 'https://plugins.example/plugin.tgz' },
  allowBuilds: false,
};

function sri(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function lock(integrity: string): PackLockedPlugin {
  return {
    name: plugin.name,
    resolved: { url: plugin.source.kind === 'tarball' ? plugin.source.url : '' },
    integrity: { kind: 'sha512', value: integrity },
    packageJsonSha512: sri(Buffer.from('package')),
    bundlePatch: 'index.yml',
  };
}

async function parent(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-plugin-download-'));
  roots.push(root);
  await mkdir(join(root, 'private'), { mode: 0o700 });
  return join(root, 'private');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function body(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

describe('secure plugin tarball download', () => {
  it('streams through public DNS, verifies SRI, stages privately, and cleans idempotently', async () => {
    const bytes = Buffer.from('verified plugin tgz bytes');
    const requested: string[] = [];
    const result = await stagePluginTarballDownload(plugin, lock(sri(bytes)), await parent(), {
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
      download: async (url) => {
        requested.push(url.href);
        return { statusCode: 200, body: body([bytes.subarray(0, 5), bytes.subarray(5)]) };
      },
    });
    expect(requested).toEqual([plugin.source.kind === 'tarball' ? plugin.source.url : '']);
    expect(await readFile(result.staged.path)).toEqual(bytes);
    const stagedPath = result.staged.path;
    await result.cleanup();
    await result.cleanup();
    await expect(access(stagedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('revalidates every redirect host and rejects private DNS', async () => {
    const bytes = Buffer.from('redirected');
    const hosts: string[] = [];
    const result = await stagePluginTarballDownload(plugin, lock(sri(bytes)), await parent(), {
      resolveHostname: async (hostname) => {
        hosts.push(hostname);
        return [{ address: '93.184.216.34', family: 4 }];
      },
      download: async (url) =>
        url.hostname === 'plugins.example'
          ? { statusCode: 302, location: 'https://cdn.example/plugin.tgz' }
          : { statusCode: 200, body: body([bytes]) },
    });
    expect(hosts).toEqual(['plugins.example', 'cdn.example']);
    await result.cleanup();

    await expect(
      stagePluginTarballDownload(plugin, lock(sri(bytes)), await parent(), {
        resolveHostname: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_HOST_REJECTED', exitCode: 20 });
  });

  it.each(['integrity', 'size'] as const)(
    'rejects %s before exposing staged bytes',
    async (kind) => {
      const bytes = Buffer.alloc(1024 * 1024, 1);
      await expect(
        stagePluginTarballDownload(plugin, lock(sri(Buffer.from('different'))), await parent(), {
          resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
          download: async () => ({
            statusCode: 200,
            body:
              kind === 'integrity' ? body([bytes]) : body(Array.from({ length: 51 }, () => bytes)),
          }),
        }),
      ).rejects.toMatchObject({
        code: kind === 'integrity' ? 'E_PLUGIN_INTEGRITY' : 'E_PLUGIN_TOO_LARGE',
        exitCode: 20,
      });
    },
  );

  it.each([
    'not a URL',
    'http://plugins.example/plugin.tgz',
    'https://plugins.example/plugin tgz',
    'https://plugins.example/plugin.tgz\n',
    'https://plugins.example/\u0085plugin.tgz',
    'https://plugins.example/%0a.tgz',
    'https://plugins.example/%7f.tgz',
    'https://plugins.example/plugin.tgz?token=TESTONLY',
    'https://user@plugins.example/plugin.tgz',
  ])(
    'rejects normalized control, credential, or userinfo URL %j at transport boundary',
    async (url) => {
      const unsafe = {
        ...plugin,
        source: { kind: 'tarball' as const, url },
      };
      const unsafeLock = { ...lock(sri(Buffer.from('x'))), resolved: { url } };
      await expect(
        stagePluginTarballDownload(unsafe, unsafeLock, await parent()),
      ).rejects.toMatchObject({ exitCode: 20 });
    },
  );

  it('rejects every malformed tarball lock shape before any network request', async () => {
    const requested = vi.fn();
    const base = lock(sri(Buffer.from('x')));
    const npmPlugin: PluginDeclaration = {
      name: 'downloaded-plugin',
      source: { kind: 'npm', range: '1.0.0' },
      allowBuilds: false,
    };
    const cases: Array<[PluginDeclaration, PackLockedPlugin]> = [
      [npmPlugin, base],
      [plugin, { ...base, resolved: { version: '1.0.0' } }],
      [plugin, { ...base, resolved: { url: 'https://plugins.example/other.tgz' } }],
      [plugin, { ...base, integrity: { kind: 'unverified', reason: 'fixture' } }],
    ];
    for (const [declaration, locked] of cases) {
      await expect(
        stagePluginTarballDownload(declaration, locked, await parent(), { download: requested }),
      ).rejects.toMatchObject({ code: 'E_PLUGIN_LOCK', exitCode: 20 });
    }
    expect(requested).not.toHaveBeenCalled();
  });

  it.each([{ statusCode: 500, body: body([Buffer.from('error')]) }, { statusCode: 200 }])(
    'rejects unusable HTTP response %# and cancels it',
    async (response) => {
      const cancel = vi.fn(async () => undefined);
      await expect(
        stagePluginTarballDownload(plugin, lock(sri(Buffer.from('x'))), await parent(), {
          resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
          download: async () => ({ ...response, cancel }),
        }),
      ).rejects.toMatchObject({ code: 'E_PLUGIN_HTTP', exitCode: 20 });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it('rejects a missing redirect target and a sixth redirect', async () => {
    const cancel = vi.fn(async () => undefined);
    await expect(
      stagePluginTarballDownload(plugin, lock(sri(Buffer.from('x'))), await parent(), {
        resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
        download: async () => ({ statusCode: 302, cancel }),
      }),
    ).rejects.toMatchObject({ code: 'E_PLUGIN_REDIRECT', exitCode: 20 });
    expect(cancel).toHaveBeenCalledOnce();

    let redirects = 0;
    await expect(
      stagePluginTarballDownload(plugin, lock(sri(Buffer.from('x'))), await parent(), {
        resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
        download: async () => {
          redirects += 1;
          return { statusCode: 302, location: `/redirect-${redirects}.tgz` };
        },
      }),
    ).rejects.toMatchObject({ code: 'E_PLUGIN_REDIRECT', exitCode: 20 });
    expect(redirects).toBe(6);
  });

  it('removes the private download workspace when staging rejects its parent permissions', async () => {
    if (process.platform === 'win32') return;
    const privateDirectory = await parent();
    await chmod(privateDirectory, 0o755);
    const bytes = Buffer.from('verified bytes');
    await expect(
      stagePluginTarballDownload(plugin, lock(sri(bytes)), privateDirectory, {
        resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
        download: async () => ({ statusCode: 200, body: body([bytes]) }),
      }),
    ).rejects.toMatchObject({ code: 'E_PROFILE_DIRECTORY' });
    expect(await readdir(privateDirectory)).toEqual([]);
  });
});
