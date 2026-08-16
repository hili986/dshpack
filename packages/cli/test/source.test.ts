// biome-ignore-all format: compact security matrices keep this test file under the 400-line project limit.
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { request } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as sourceAdapter from '../src/adapters/source.js';

vi.mock('undici', () => ({ request: vi.fn() }));

interface DownloadResponse {
  statusCode: number;
  location?: string;
  body?: AsyncIterable<Uint8Array>;
  discard?: () => Promise<void>;
}

interface SourceDependencies {
  download?: (url: URL) => Promise<DownloadResponse>;
  makeTempDirectory?: () => Promise<string>;
  removeTempDirectory?: (path: string) => Promise<void>;
  hostnamePolicy?: (hostname: string) => boolean | Promise<boolean>;
}

interface MaterializedSource {
  directory: string;
  provenance: Record<string, unknown>;
  cleanup(): Promise<void>;
}

type Materializer = (
  reference: string,
  dependencies?: SourceDependencies,
) => Promise<MaterializedSource>;

const materialize = sourceAdapter.materializeSource as unknown as Materializer;
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-source-test-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(request).mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function tarEntry(input: {
  name: string;
  type?: string;
  data?: Uint8Array | string;
  declaredSize?: number;
  linkName?: string;
}): Buffer {
  const data = Buffer.from(input.data ?? '');
  const header = Buffer.alloc(512);
  header.write(input.name, 0, 100, 'utf8');
  header.write(octal(0o644, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(input.declaredSize ?? data.length, 12), 124, 12, 'ascii');
  header.write(octal(0, 12), 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(input.type ?? '0', 156, 1, 'ascii');
  header.write(input.linkName ?? '', 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function archive(
  entries: Array<Parameters<typeof tarEntry>[0]> = [
    { name: 'pack/', type: '5' },
    { name: 'pack/file.txt', data: 'safe' },
  ],
): Buffer {
  return gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]));
}

function chunks(value: Uint8Array, chunkSize = 97): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (let offset = 0; offset < value.byteLength; offset += chunkSize) {
      yield value.subarray(offset, offset + chunkSize);
    }
  })();
}

function sri(value: Uint8Array): string {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

async function expectSourceError(
  promise: Promise<unknown>,
  exitCode: 20 | 31,
  code?: string,
): Promise<Error & { code: string; exitCode: number; hint?: string }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(sourceAdapter.SourceError);
    expect(error).toMatchObject({ exitCode, ...(code === undefined ? {} : { code }) });
    return error as Error & { code: string; exitCode: number; hint?: string };
  }
  throw new Error('Expected materializeSource to reject.');
}

describe('materializeSource', () => {
  it('exports the source materialization entry point and structured error', () => {
    expect(sourceAdapter.materializeSource).toBeTypeOf('function');
    expect(sourceAdapter.SourceError).toBeTypeOf('function');
  });

  it('returns an ordinary local directory without deleting it on cleanup', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'pack');
    await mkdir(source);
    const result = await materialize(source);
    expect(result).toMatchObject({
      directory: resolve(source),
      provenance: { kind: 'directory', path: resolve(source) },
    });
    await result.cleanup();
    await result.cleanup();
    await expect(access(source)).resolves.toBeUndefined();
  });

  it('copies and extracts a local .dshpack.tgz entirely under private temp', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'fixture.dshpack.tgz');
    const workspace = join(root, 'controlled-temp');
    await writeFile(source, archive());
    const result = await materialize(source, {
      makeTempDirectory: async () => {
        await mkdir(workspace, { mode: 0o700 });
        return workspace;
      },
    });
    expect(result.directory.startsWith(workspace)).toBe(true);
    await expect(readFile(join(result.directory, 'pack/file.txt'), 'utf8')).resolves.toBe('safe');
    expect(result.provenance).toEqual({ kind: 'archive', path: resolve(source) });
    await result.cleanup();
    await result.cleanup();
    await expect(access(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects missing, non-tarball file, and directory symlink local sources', async () => {
    const root = await temporaryRoot();
    const file = join(root, 'pack.txt');
    const directory = join(root, 'real');
    const link = join(root, 'link');
    await writeFile(file, 'x');
    await mkdir(directory);
    await symlink(directory, link, 'junction');
    for (const source of [join(root, 'missing'), file, link]) {
      await expectSourceError(materialize(source), 20, 'SOURCE_INVALID');
    }
  });

  it.each([
    'http://example.test/a.tgz#sha512-AAAA',
    'https://user@example.test/a.tgz#sha512-AAAA',
    'https://example.test/a.tgz?token=secret#sha512-AAAA',
    'https://example.test/a.tgz',
    'https://example.test/a.tgz#sha256-AAAA',
    'https://example.test/a.tgz#sha512-not_base64',
  ])('rejects unsafe or unpinned HTTPS reference %s before download', async (reference) => {
    const download = vi.fn();
    await expectSourceError(materialize(reference, { download }), 20, 'SOURCE_INVALID');
    expect(download).not.toHaveBeenCalled();
  });

  it.each(['localhost', 'a.localhost', '127.0.0.1', '10.0.0.1', '169.254.1.1', '172.16.1.1', '192.168.1.1', '[::1]', '[fe80::1]', '[fc00::1]', '[fd00::1]', '[::ffff:127.0.0.1]'])(
    'rejects literal local, private, or link-local host %s',
    async (hostname) => {
      const bytes = archive();
      const download = vi.fn();
      await expectSourceError(
        materialize(`https://${hostname}/a.tgz#${sri(bytes)}`, { download }),
        20,
        'SOURCE_HOST_REJECTED',
      );
      expect(download).not.toHaveBeenCalled();
    },
  );

  it.each(['http://example.test/a.tgz', 'https://user@example.test/a.tgz', 'https://example.test/a.tgz?q=x', 'https://[']) (
    'rejects URL policy violation with an otherwise valid integrity %s',
    async (base) => {
      const download = vi.fn();
      await expectSourceError(materialize(`${base}#${sri(archive())}`, { download }), 20, 'SOURCE_INVALID');
      expect(download).not.toHaveBeenCalled();
    },
  );

  it('applies injectable hostname policy and validates every redirect hop', async () => {
    const bytes = archive();
    const download = vi.fn(async () => ({
      statusCode: 302,
      location: 'https://127.0.0.1/steal.tgz',
      discard: async () => undefined,
    }));
    const hostnamePolicy = vi.fn(async (hostname: string) => hostname === 'example.test');
    await expectSourceError(
      materialize(`https://example.test/a.tgz#${sri(bytes)}`, { download, hostnamePolicy }),
      20,
      'SOURCE_HOST_REJECTED',
    );
    expect(download).toHaveBeenCalledTimes(1);
    expect(hostnamePolicy).toHaveBeenCalledWith('example.test');
  });

  it('streams a pinned HTTPS tarball through a checked public redirect', async () => {
    const bytes = archive();
    const seen: string[] = [];
    const download = vi.fn(async (url: URL): Promise<DownloadResponse> => {
      seen.push(url.href);
      return seen.length === 1
        ? { statusCode: 307, location: 'https://cdn.example.test/final.tgz' }
        : { statusCode: 200, body: chunks(bytes) };
    });
    const result = await materialize(`https://example.test/a.tgz#${sri(bytes)}`, { download });
    expect(seen).toEqual([
      'https://example.test/a.tgz',
      'https://cdn.example.test/final.tgz',
    ]);
    expect(result.provenance).toMatchObject({ kind: 'https', integrity: sri(bytes) });
    await expect(readFile(join(result.directory, 'pack/file.txt'), 'utf8')).resolves.toBe('safe');
    await result.cleanup();
  });

  it('uses the default downloader with redirect handling disabled per request', async () => {
    const bytes = archive();
    const redirectBody = Object.assign(chunks(new Uint8Array()), { dump: vi.fn(async () => undefined) });
    const successBody = Object.assign(chunks(bytes), { dump: vi.fn(async () => undefined) });
    vi.mocked(request)
      .mockResolvedValueOnce({ statusCode: 302, headers: { location: 'https://cdn.example.test/a.tgz' }, body: redirectBody } as never)
      .mockResolvedValueOnce({ statusCode: 200, headers: {}, body: successBody } as never);
    const result = await materialize(`https://example.test/a.tgz#${sri(bytes)}`);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, expect.any(URL), expect.objectContaining({ headersTimeout: 30_000 }));
    expect(redirectBody.dump).toHaveBeenCalledOnce();
    await result.cleanup();
  });

  it('rejects absent and excessive redirects', async () => {
    const bytes = archive();
    await expectSourceError(materialize(`https://example.test/a.tgz#${sri(bytes)}`, {
      download: async () => ({ statusCode: 302 }),
    }), 20, 'SOURCE_NETWORK');
    await expectSourceError(materialize(`https://example.test/a.tgz#${sri(bytes)}`, {
      download: async () => ({ statusCode: 307, location: 'https://example.test/again.tgz' }),
    }), 20, 'SOURCE_NETWORK');
  });

  it('rejects integrity mismatch, oversized downloads, and non-success status', async () => {
    const good = archive();
    await expectSourceError(
      materialize(`https://example.test/a.tgz#${sri(good)}`, {
        download: async () => ({ statusCode: 200, body: chunks(Buffer.from('wrong')) }),
      }),
      20,
      'SOURCE_INTEGRITY',
    );
    const megabyte = Buffer.alloc(1024 * 1024);
    await expectSourceError(
      materialize(`https://example.test/a.tgz#${sri(good)}`, {
        download: async () => ({
          statusCode: 200,
          body: (async function* () {
            for (let index = 0; index < 51; index += 1) yield megabyte;
          })(),
        }),
      }),
      20,
      'SOURCE_TOO_LARGE',
    );
    await expectSourceError(
      materialize(`https://example.test/a.tgz#${sri(good)}`, {
        download: async () => ({ statusCode: 503 }),
      }),
      20,
      'SOURCE_NETWORK',
    );
  });

  it('uses exact GitHub commit codeload and gives clone-local hint without fallback', async () => {
    const bytes = archive();
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const download = vi.fn(async (_url: URL) => ({ statusCode: 200, body: chunks(bytes) }));
    const result = await materialize(`github:owner/repo#${commit}`, { download });
    expect(download.mock.calls[0]?.[0].href).toBe(
      `https://codeload.github.com/owner/repo/tar.gz/${commit}`,
    );
    expect(result.provenance).toMatchObject({ kind: 'github', owner: 'owner', repo: 'repo', commit });
    await result.cleanup();

    const secret = 'signed-url-secret';
    const failure = await expectSourceError(
      materialize(`github:owner/repo#${commit}`, {
        download: async () => {
          throw new Error(secret);
        },
      }),
      20,
      'SOURCE_NETWORK',
    );
    expect(failure.hint).toMatch(/git clone/u);
    expect(`${failure.message} ${failure.hint}`).not.toContain(secret);
  });

  it.each([
    '/absolute',
    'C:/drive',
    'a\\backslash',
    'a\x01control',
    './dot',
    '../parent',
    'a/../parent',
    'a//empty',
    'safe:ads',
    'CON.txt',
    'trailing./file',
    'space /file',
  ])('rejects unsafe archive path %j', async (name) => {
    const root = await temporaryRoot();
    const source = join(root, 'bad.dshpack.tgz');
    await writeFile(source, archive([{ name, data: 'x' }]));
    await expectSourceError(materialize(source), 31, 'ARCHIVE_UNSAFE');
  });

  it.each(['1', '2', '3', '4', '6', '7', 'S'])(
    'rejects link and special tar entry type %s',
    async (type) => {
      const root = await temporaryRoot();
      const source = join(root, 'special.dshpack.tgz');
      await writeFile(source, archive([{ name: 'unsafe', type, linkName: 'target' }]));
      await expectSourceError(materialize(source), 31, 'ARCHIVE_UNSAFE');
    },
  );

  it.each([
    { entries: [{ name: 'A.txt', data: 'a' }, { name: 'a.txt', data: 'b' }] },
    { entries: [{ name: '\u00e9.txt', data: 'a' }, { name: 'e\u0301.txt', data: 'b' }] },
    { entries: [{ name: 'same.txt', data: 'a' }, { name: 'same.txt', data: 'b' }] },
  ])('fails closed on case, NFC, or duplicate path collision', async ({ entries }) => {
    const root = await temporaryRoot();
    const source = join(root, 'collision.dshpack.tgz');
    await writeFile(source, archive(entries));
    await expectSourceError(materialize(source), 31, 'ARCHIVE_COLLISION');
  });

  it('enforces per-file, aggregate, and file-count extraction limits', async () => {
    const root = await temporaryRoot();
    const cases = [
      archive([{ name: 'large', data: Buffer.alloc(1024 * 1024 + 1) }]),
      archive(
        Array.from({ length: 11 }, (_, index) => ({
          name: `file-${index}`,
          data: Buffer.alloc(1024 * 1024),
        })),
      ),
      archive(Array.from({ length: 1001 }, (_, index) => ({ name: `file-${index}` }))),
    ];
    for (const [index, contents] of cases.entries()) {
      const source = join(root, `limit-${index}.dshpack.tgz`);
      await writeFile(source, contents);
      await expectSourceError(materialize(source), 31, 'ARCHIVE_LIMIT');
    }
  });

  it('rejects oversized local archives and sanitizes temporary workspace failures', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'large.dshpack.tgz');
    await writeFile(source, 'x');
    await truncate(source, 50 * 1024 * 1024 + 1);
    await expectSourceError(materialize(source), 20, 'SOURCE_TOO_LARGE');
    await expectSourceError(materialize(source, {
      makeTempDirectory: async () => join(root, 'absent', 'nested'),
    }), 20, 'SOURCE_IO');
  });
});
