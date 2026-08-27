import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { request } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type MaterializedSource, materializeSource, SourceError } from '../src/adapters/source.js';
import { defaultDownload } from '../src/adapters/source-network.js';

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

afterEach(async () => {
  vi.mocked(request).mockReset();
  undiciState.agents.splice(0);
  undiciState.options.splice(0);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function archive(): Buffer {
  const data = Buffer.from('safe');
  const header = Buffer.alloc(512);
  header.write('file.txt', 0, 100, 'utf8');
  for (const [offset, length, value] of [
    [100, 8, 0o644],
    [108, 8, 0],
    [116, 8, 0],
    [124, 12, data.length],
    [136, 12, 0],
  ] as const) {
    header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
  }
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return gzipSync(Buffer.concat([header, data, Buffer.alloc(508), Buffer.alloc(1024)]));
}

async function capture(promise: Promise<MaterializedSource>): Promise<unknown> {
  return promise.then(
    async (result) => {
      await result.cleanup();
      return result;
    },
    (error: unknown) => error,
  );
}

describe('source review regressions', () => {
  it('passes an address-bound dispatcher with redirects disabled to request', async () => {
    const body = Object.assign((async function* () {})(), { destroy: vi.fn() });
    vi.mocked(request).mockResolvedValue({ statusCode: 200, headers: {}, body } as never);
    const target = { address: '93.184.216.34', family: 4 as const };
    const response = await defaultDownload(new URL('https://example.test/a.tgz'), target);
    const agent = undiciState.agents[0];
    expect(request).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        dispatcher: agent,
        headers: { 'user-agent': 'dshpack' },
        maxRedirections: 0,
      }),
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
        expect({ address, family }).toEqual(target);
        resolve();
      }),
    );
    await response.cancel?.();
  });

  it('closes the dispatcher when request fails before a response', async () => {
    vi.mocked(request).mockRejectedValue(new Error('TLS failed'));
    await expect(
      defaultDownload(new URL('https://example.test/a.tgz'), {
        address: '93.184.216.34',
        family: 4,
      }),
    ).rejects.toThrow('TLS failed');
    expect(undiciState.agents[0]?.close).toHaveBeenCalledOnce();
  });

  it('preserves the git clone hint when GitHub host resolution fails', async () => {
    const outcome = await capture(
      materializeSource('github:owner/repo#0123456789abcdef0123456789abcdef01234567', {
        resolveHostname: async () => [],
      }),
    );
    expect(outcome).toBeInstanceOf(SourceError);
    expect(outcome).toMatchObject({
      code: 'SOURCE_HOST_REJECTED',
      hint: expect.stringContaining('git clone'),
    });
  });

  it('enforces the local archive limit while the source grows during streaming', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack-source-growth-'));
    roots.push(root);
    const source = join(root, 'growing.dshpack.tgz');
    await writeFile(source, archive());
    const readLocalArchive = async function* (path: string) {
      await truncate(path, 50 * 1024 * 1024 + 1);
      for (let index = 0; index < 51; index += 1) yield Buffer.alloc(1024 * 1024);
    };
    const outcome = await capture(materializeSource(source, { readLocalArchive }));
    expect(outcome).toBeInstanceOf(SourceError);
    expect(outcome).toMatchObject({ code: 'SOURCE_TOO_LARGE' });
  });

  it('rejects an empty source instead of resolving the current directory', async () => {
    const outcome = await capture(materializeSource(''));
    expect(outcome).toBeInstanceOf(SourceError);
    expect(outcome).toMatchObject({ code: 'SOURCE_INVALID' });
  });
});
