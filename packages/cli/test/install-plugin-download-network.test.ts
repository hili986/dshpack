import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PackLockedPlugin, PluginDeclaration } from '@dshpack/core';
import { request } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { stagePluginTarballDownload } from '../src/install/plugin-download.js';

const undiciState = vi.hoisted(() => ({
  agents: [] as Array<{ close: ReturnType<typeof vi.fn> }>,
  options: [] as unknown[],
}));

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    Agent: class MockAgent {
      readonly close = vi.fn(async () => undefined);

      constructor(options: unknown) {
        undiciState.agents.push(this);
        undiciState.options.push(options);
      }
    },
    request: vi.fn(),
  };
});

const roots: string[] = [];
const bytes = Buffer.from('bound plugin transport');
const plugin: PluginDeclaration = {
  name: 'bound-plugin',
  source: { kind: 'tarball', url: 'https://plugins.example/plugin.tgz' },
  allowBuilds: false,
};
const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const locked: PackLockedPlugin = {
  name: plugin.name,
  resolved: { url: plugin.source.kind === 'tarball' ? plugin.source.url : '' },
  integrity: { kind: 'sha512', value: digest },
  packageJsonSha512: digest,
  bundlePatch: 'index.yml',
};

async function privateParent(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-plugin-network-'));
  roots.push(root);
  const parent = join(root, 'private');
  await mkdir(parent, { mode: 0o700 });
  return parent;
}

afterEach(async () => {
  vi.mocked(request).mockReset();
  undiciState.agents.splice(0);
  undiciState.options.splice(0);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('plugin downloader DNS binding', () => {
  it('passes an address-bound dispatcher to the production request', async () => {
    const body = Object.assign(
      (async function* () {
        yield bytes;
      })(),
      { destroy: vi.fn() },
    );
    vi.mocked(request).mockResolvedValue({ statusCode: 200, headers: {}, body } as never);
    const result = await stagePluginTarballDownload(plugin, locked, await privateParent(), {
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    const agent = undiciState.agents[0];
    expect(request).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dispatcher: agent, maxRedirections: 0 }),
    );
    const options = undiciState.options[0] as {
      connect: {
        lookup: (
          hostname: string,
          options: { all: false },
          callback: (error: null, address: string, family: 4 | 6) => void,
        ) => void;
      };
    };
    await new Promise<void>((resolve) =>
      options.connect.lookup('ignored.test', { all: false }, (error, address, family) => {
        expect(error).toBeNull();
        expect({ address, family }).toEqual({ address: '93.184.216.34', family: 4 });
        resolve();
      }),
    );
    await result.cleanup();
  });

  it('closes the bound dispatcher when request rejects', async () => {
    vi.mocked(request).mockRejectedValue(new Error('TLS failed'));
    await expect(
      stagePluginTarballDownload(plugin, locked, await privateParent(), {
        resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
      }),
    ).rejects.toThrow('TLS failed');
    expect(undiciState.agents[0]?.close).toHaveBeenCalledOnce();
  });
});
