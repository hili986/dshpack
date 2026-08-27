// biome-ignore-all format: compact security matrices keep this test file under the 400-line project limit.
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { access, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { request } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as sourceAdapter from '../src/adapters/source.js';
import { fixedLookup, isPublicAddress, trustLocalDnsEnabled } from '../src/adapters/source-network.js';

vi.mock('node:dns/promises', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:dns/promises')>()), lookup: vi.fn() }));
vi.mock('undici', async (importOriginal) => ({ ...(await importOriginal<typeof import('undici')>()), request: vi.fn() }));
interface DownloadResponse { statusCode: number; location?: string; body?: AsyncIterable<Uint8Array>; cancel?: () => Promise<void> }
interface ResolvedAddress { address: string; family: 4 | 6 }
interface SourceDependencies { download?: (url: URL, address?: ResolvedAddress) => Promise<DownloadResponse>; makeTempDirectory?: () => Promise<string>; removeTempDirectory?: (path: string) => Promise<void>; hostnamePolicy?: (hostname: string) => boolean | Promise<boolean>; resolveHostname?: (hostname: string) => Promise<ResolvedAddress[]>; trustLocalDns?: boolean; writeChunk?: (handle: unknown, chunk: Uint8Array, offset: number) => Promise<number> }
interface MaterializedSource { directory: string; provenance: Record<string, unknown>; cleanup(): Promise<void> }
type Materializer = (reference: string, dependencies?: SourceDependencies) => Promise<MaterializedSource>;

const rawMaterialize = sourceAdapter.materializeSource as unknown as Materializer;
const materialize: Materializer = (reference, dependencies = {}) => rawMaterialize(reference, { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }], ...dependencies });
const roots: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-source-test-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(lookup).mockReset();
  vi.mocked(request).mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function tarEntry(input: { name: string; type?: string; data?: Uint8Array | string; declaredSize?: number; linkName?: string }): Buffer {
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

function archive(entries: Array<Parameters<typeof tarEntry>[0]> = [{ name: 'pack/', type: '5' }, { name: 'pack/file.txt', data: 'safe' }]): Buffer {
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
async function expectSourceError(promise: Promise<unknown>, exitCode: 20 | 31, code?: string): Promise<Error & { code: string; exitCode: number; hint?: string }> {
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
  it.each([
    [{ kind: 'directory', path: 'C:/safe/pack' }, 'C:/safe/pack'],
    [{ kind: 'archive', path: 'C:/safe/pack.dshpack.tgz' }, 'C:/safe/pack.dshpack.tgz'],
    [{ kind: 'https', url: 'https://packs.example/demo.tgz', integrity: `sha512-${'A'.repeat(86)}==` }, `https://packs.example/demo.tgz#sha512-${'A'.repeat(86)}==`],
    [{ kind: 'github', owner: 'owner', repo: 'demo', commit: 'a'.repeat(40), url: 'https://codeload.github.com/owner/demo/tar.gz/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, 'github:owner/demo#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
  ] as const)('reconstructs the single safe source reference for persisted provenance %#', (provenance, expected) => {
    expect(sourceAdapter.sourceReferenceFromProvenance(provenance)).toBe(expected);
  });
  it('classifies public addresses and binds both DNS lookup result shapes', async () => {
    for (const [address, allowed] of [['93.184.216.34', true], ['0.0.0.0', false], ['10.0.0.1', false], ['100.64.0.1', false], ['127.0.0.1', false], ['169.254.0.1', false], ['172.16.0.1', false], ['192.0.0.1', false], ['192.0.2.1', false], ['192.88.99.1', false], ['192.168.0.1', false], ['198.18.0.1', false], ['198.51.100.1', false], ['203.0.113.1', false], ['224.0.0.1', false], ['240.0.0.1', false], ['2606:4700:4700::1111', true], ['2606:4700:4700:0:0:0:0:1111', true], ['2001:4860::1', true], ['2001:21::1', false], ['2001:db8::1', false], ['2002::1', false], ['3fff::1', false], ['::1', false], ['::ffff:192.0.2.1', false], ['fe80::1%lo', false], ['invalid', false]] as const) expect(isPublicAddress(address)).toBe(allowed);
    const target = { address: '93.184.216.34', family: 4 as const }; const bound = fixedLookup(target);
    await new Promise<void>((resolveLookup) => bound('ignored.test', { all: true }, (error, addresses) => { expect(error).toBeNull(); expect(addresses).toEqual([target]); resolveLookup(); }));
    await new Promise<void>((resolveLookup) => bound('ignored.test', { all: false }, (error, address, family) => { expect(error).toBeNull(); expect({ address, family }).toEqual(target); resolveLookup(); }));
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
  it('requires SRI for file: tarballs and rejects a tampered archive', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'pack.tgz');
    const bytes = archive();
    await writeFile(source, bytes);

    await expectSourceError(materialize(`file:${source}`), 20, 'SOURCE_INVALID');
    const valid = await materialize(`file:${source}#${sri(bytes)}`);
    expect(valid.provenance).toEqual({ kind: 'file', path: resolve(source), integrity: sri(bytes) });
    await valid.cleanup();

    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    await writeFile(source, tampered);
    await expectSourceError(materialize(`file:${source}#${sri(bytes)}`), 20, 'SOURCE_INTEGRITY');
  });
  it('propagates cleanup failure and retries removal', async () => {
    const root = await temporaryRoot(); const source = join(root, 'retry.dshpack.tgz'); const workspace = join(root, 'retry-temp'); await writeFile(source, archive());
    const removeTempDirectory = vi.fn().mockRejectedValueOnce(new Error('busy')).mockImplementation((path: string) => rm(path, { recursive: true, force: true }));
    const result = await materialize(source, { makeTempDirectory: async () => { await mkdir(workspace); return workspace; }, removeTempDirectory });
    await expect(result.cleanup()).rejects.toThrow('busy');
    await expect(result.cleanup()).resolves.toBeUndefined();
    expect(removeTempDirectory).toHaveBeenCalledTimes(2);
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
  it.each(['http://example.test/a.tgz#sha512-AAAA', 'https://user@example.test/a.tgz#sha512-AAAA', 'https://example.test/a.tgz?token=secret#sha512-AAAA', 'https://example.test/a.tgz', 'https://example.test/a.tgz#sha256-AAAA', 'https://example.test/a.tgz#sha512-not_base64'])('rejects unsafe or unpinned HTTPS reference %s before download', async (reference) => {
    const download = vi.fn();
    await expectSourceError(materialize(reference, { download }), 20, 'SOURCE_INVALID');
    expect(download).not.toHaveBeenCalled();
  });
  it.each(['localhost', 'a.localhost', '127.0.0.1', '10.0.0.1', '169.254.1.1', '172.16.1.1', '192.168.1.1', '93.184.216.34', '[::1]', '[fe80::1]', '[fc00::1]', '[fd00::1]', '[::ffff:127.0.0.1]', '[2606:2800:220:1:248:1893:25c8:1946]'])(
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
  it.each(['localhost.', '0.0.0.0', '[::]'])('rejects normalized or unspecified host %s', async (hostname) => {
    const bytes = archive(); await expectSourceError(materialize(`https://${hostname}/a.tgz#${sri(bytes)}`, { download: async () => ({ statusCode: 200, body: chunks(bytes) }) }), 20, 'SOURCE_HOST_REJECTED');
  });
  it('requires public DNS answers and binds the validated address against rebinding', async () => {
    const bytes = archive(); const publicAddress = { address: '93.184.216.34', family: 4 as const };
    await expectSourceError(materialize(`https://private.example/a.tgz#${sri(bytes)}`, { resolveHostname: async () => [{ address: '10.0.0.1', family: 4 }], download: async () => ({ statusCode: 200, body: chunks(bytes) }) }), 20, 'SOURCE_HOST_REJECTED');
    const resolveHostname = vi.fn(async () => [publicAddress]);
    const download = vi.fn(async (url: URL, address?: ResolvedAddress) => { expect(url.hostname).toBe('public.example'); expect(address).toEqual(publicAddress); return { statusCode: 200, body: chunks(bytes) }; });
    const result = await materialize(`https://public.example./a.tgz#${sri(bytes)}`, { resolveHostname, download });
    expect(resolveHostname).toHaveBeenCalledWith('public.example'); await result.cleanup();
    await expectSourceError(materialize(`https://empty.example/a.tgz#${sri(bytes)}`, { resolveHostname: async () => [] }), 20, 'SOURCE_HOST_REJECTED');
    await expectSourceError(materialize(`https://failed.example/a.tgz#${sri(bytes)}`, { resolveHostname: async () => { throw new Error('dns failure'); } }), 20, 'SOURCE_HOST_REJECTED');
  });
  it('accepts a fake-IP DNS answer only after the explicit opt-in, while keeping localhost and IP literals denied', async () => {
    const bytes = archive();
    const fakeIp = { address: '198.18.0.115', family: 4 as const };
    const sourceUrl = `https://fake-ip.example/a.tgz#${sri(bytes)}`;
    await expectSourceError(
      materialize(sourceUrl, {
        trustLocalDns: false,
        resolveHostname: async () => [fakeIp],
        download: async () => ({ statusCode: 200, body: chunks(bytes) }),
      }),
      20,
      'SOURCE_HOST_REJECTED',
    );
    const source = await materialize(sourceUrl, {
      trustLocalDns: true,
      resolveHostname: async () => [fakeIp],
      download: async () => ({ statusCode: 200, body: chunks(bytes) }),
    });
    expect(source.provenance).toMatchObject({ kind: 'https' });
    await source.cleanup();
    for (const hostname of ['localhost', 'a.localhost', '127.0.0.1', '[::1]']) {
      await expectSourceError(
        materialize(`https://${hostname}/a.tgz#${sri(bytes)}`, {
          trustLocalDns: true,
          download: async () => ({ statusCode: 200, body: chunks(bytes) }),
        }),
        20,
        'SOURCE_HOST_REJECTED',
      );
    }
    expect(trustLocalDnsEnabled({ DSHPACK_TRUST_LOCAL_DNS: '1' })).toBe(true);
    expect(trustLocalDnsEnabled({ DSHPACK_TRUST_LOCAL_DNS: 'true' })).toBe(false);
    expect(trustLocalDnsEnabled({})).toBe(false);
  });
  it.each(['http://example.test/a.tgz', 'https://user@example.test/a.tgz', 'https://example.test/a.tgz?q=x', 'https://@example.test/a.tgz', 'https:////@example.test/a.tgz', 'https:\\\\@example.test/a.tgz', 'h\tttps://@example.test/a.tgz', 'https://example.test/a\rb.tgz', 'https://example.test/a\nb.tgz', 'https://example.test/a\tb.tgz', 'https://example.test/a\0b.tgz', 'https://example.test/a b.tgz', 'https://example.test/a\x7fb.tgz', 'https://example.test/a.tgz?', 'https://[']) (
    'rejects URL policy violation with an otherwise valid integrity %s',
    async (base) => {
      const download = vi.fn();
      const failure = await expectSourceError(materialize(`${base}#${sri(archive())}`, { download }), 20, 'SOURCE_INVALID'); if (base.startsWith('h\t')) expect(failure.message).toContain('URL');
      expect(download).not.toHaveBeenCalled();
    },
  );
  it('applies injectable hostname policy and validates every redirect hop', async () => {
    const bytes = archive();
    const download = vi.fn(async () => ({
      statusCode: 302,
      location: 'https://127.0.0.1/steal.tgz',
      cancel: async () => undefined,
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
        ? { statusCode: 307, location: 'https://cdn.example.test/final%20archive.tgz' }
        : { statusCode: 200, body: chunks(bytes) };
    });
    const result = await materialize(`https://example.test/a%20archive.tgz#${sri(bytes)}`, { download });
    expect(seen).toEqual([
      'https://example.test/a%20archive.tgz',
      'https://cdn.example.test/final%20archive.tgz',
    ]);
    expect(result.provenance).toMatchObject({ kind: 'https', integrity: sri(bytes) });
    await expect(readFile(join(result.directory, 'pack/file.txt'), 'utf8')).resolves.toBe('safe');
    await result.cleanup();
  });
  it.each(['https://@cdn.example/a.tgz', 'https:////@cdn.example/a.tgz', 'https:\\\\@cdn.example/a.tgz', 'h\tttps://@cdn.example/a.tgz', 'https://cdn.example/a\rb.tgz', 'https://cdn.example/a\nb.tgz', 'https://cdn.example/a\tb.tgz', 'https://cdn.example/a\0b.tgz', 'https://cdn.example/a b.tgz', 'https://cdn.example/a\x7fb.tgz', 'https://cdn.example/a.tgz?'])('rejects raw redirect syntax %s before requesting the hop', async (location) => {
    const bytes = archive(); const download = vi.fn(async () => ({ statusCode: 302, location }));
    await expectSourceError(materialize(`https://example.test/a.tgz#${sri(bytes)}`, { download }), 20, 'SOURCE_INVALID');
    expect(download).toHaveBeenCalledTimes(1);
  });
  it('uses the default downloader with redirect handling disabled per request', async () => {
    const bytes = archive();
    vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    const redirectBody = Object.assign(chunks(new Uint8Array()), { destroy: vi.fn() });
    const successBody = Object.assign(chunks(bytes), { destroy: vi.fn() });
    vi.mocked(request)
      .mockResolvedValueOnce({ statusCode: 302, headers: { location: 'https://cdn.example.test/a.tgz' }, body: redirectBody } as never)
      .mockResolvedValueOnce({ statusCode: 200, headers: {}, body: successBody } as never);
    const result = await rawMaterialize(`https://example.test/a.tgz#${sri(bytes)}`);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, expect.any(URL), expect.objectContaining({ headersTimeout: 30_000 }));
    expect(redirectBody.destroy).toHaveBeenCalledOnce();
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

  it.each([{ statusCode: 302 }, { statusCode: 503 }])('cancels status $statusCode body without traversing it', async (response) => {
    const bytes = archive(); const next = vi.fn(async () => ({ done: false as const, value: new Uint8Array() })); const cancel = vi.fn(async () => undefined);
    const body = { [Symbol.asyncIterator]: () => ({ next }) };
    await expectSourceError(materialize(`https://example.test/a.tgz#${sri(bytes)}`, { download: async () => ({ ...response, body, cancel }) }), 20, 'SOURCE_NETWORK');
    expect(cancel).toHaveBeenCalledOnce(); expect(next).not.toHaveBeenCalled();
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
    await expectSourceError(materialize(`github:owner/..#${commit}`), 20, 'SOURCE_INVALID');

    const secret = 'signed-url-secret';
    const failure = await expectSourceError(
      materialize(`github:owner/repo#${commit}`, {
        download: async () => ({ statusCode: 200, body: (async function* () { yield await Promise.reject(new Error(secret)); })() }),
      }),
      20,
      'SOURCE_NETWORK',
    );
    expect(failure.hint).toMatch(/git clone/u);
    expect(`${failure.message} ${failure.hint}`).not.toContain(secret);
  });

  it.each([
    'github:owner/repo',
    'https://github.com/owner/repo',
    'https://github.com/owner/repo/',
    'https://github.com/owner/repo.git',
  ])('resolves bare GitHub repository %s to a pinned codeload source', async (reference) => {
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const download = vi.fn(async (url: URL): Promise<DownloadResponse> => {
      if (url.href === 'https://api.github.com/repos/owner/repo')
        return { statusCode: 200, body: chunks(Buffer.from('{"default_branch":"main"}')) };
      if (url.href === 'https://api.github.com/repos/owner/repo/commits/main')
        return { statusCode: 200, body: chunks(Buffer.from(`{"sha":"${commit}"}`)) };
      return { statusCode: 200, body: chunks(archive()) };
    });

    const source = await materialize(reference, { download });

    expect(download.mock.calls.map(([url]) => url.href)).toEqual([
      'https://api.github.com/repos/owner/repo',
      'https://api.github.com/repos/owner/repo/commits/main',
      `https://codeload.github.com/owner/repo/tar.gz/${commit}`,
    ]);
    expect(source.provenance).toMatchObject({
      kind: 'github',
      owner: 'owner',
      repo: 'repo',
      commit,
    });
    expect(sourceAdapter.sourceReferenceFromProvenance(source.provenance as never)).toBe(
      `github:owner/repo#${commit}`,
    );
    await source.cleanup();
  });

  it.each([
    ['a missing repository', 404, 'SOURCE_GITHUB_RESOLVE_NOT_FOUND'],
    ['GitHub rate limiting', 403, 'SOURCE_GITHUB_RESOLVE_RATE_LIMIT'],
    ['an unavailable resolver endpoint', 500, 'SOURCE_GITHUB_RESOLVE_NETWORK'],
  ])('classifies %s while resolving a bare GitHub source', async (_case, statusCode, code) => {
    await expectSourceError(
      materialize('github:owner/repo', {
        download: async () => ({ statusCode }),
      }),
      20,
      code,
    );
  });

  it('rejects a non-SHA default-branch HEAD rather than downloading an unpinned archive', async () => {
    const download = vi.fn(async (url: URL): Promise<DownloadResponse> =>
      url.pathname.endsWith('/commits/main')
        ? { statusCode: 200, body: chunks(Buffer.from('{"sha":"main"}')) }
        : { statusCode: 200, body: chunks(Buffer.from('{"default_branch":"main"}')) },
    );
    await expectSourceError(
      materialize('github:owner/repo', { download }),
      20,
      'SOURCE_GITHUB_RESOLVE_INVALID',
    );
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('accepts only a matching harmless GitHub codeload global PAX comment', async () => {
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const pax = (value: string) => archive([{ name: 'pax_global_header', type: 'g', data: `52 comment=${value}\n` }, { name: 'repo/file', data: 'safe' }]);
    const result = await materialize(`github:owner/repo#${commit}`, { download: async () => ({ statusCode: 200, body: chunks(pax(commit)) }) });
    await expect(readFile(join(result.directory, 'file'), 'utf8')).resolves.toBe('safe');
    await result.cleanup();
    await expectSourceError(materialize(`github:owner/repo#${commit}`, { download: async () => ({ statusCode: 200, body: chunks(pax('1123456789abcdef0123456789abcdef01234567')) }) }), 31, 'ARCHIVE_UNSAFE');
    const root = await temporaryRoot(); const local = join(root, 'pax.dshpack.tgz'); await writeFile(local, pax(commit));
    await expectSourceError(materialize(local), 31, 'ARCHIVE_UNSAFE');
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
    'safe:ads', 'bad<name', 'bad>name', 'bad"name', 'bad|name', 'bad?name', 'bad*name', 'bad\0hidden', 'c1\u0085name', 'pua\uF03Aname',
    'CON.txt', 'CLOCK$', 'COM¹.txt',
    'trailing./file',
    'space /file',
  ])('rejects unsafe archive path %j', async (name) => {
    const root = await temporaryRoot();
    const source = join(root, 'bad.dshpack.tgz');
    await writeFile(source, archive([{ name, data: 'x' }]));
    await expectSourceError(materialize(source), 31, 'ARCHIVE_UNSAFE');
  });

  it.each(['1', '2', '3', '4', '6', '7', 'S', 'Z', 'L'])(
    'rejects link and special tar entry type %s',
    async (type) => {
      const root = await temporaryRoot();
      const source = join(root, 'special.dshpack.tgz');
      await writeFile(source, archive([{ name: 'safe', data: 'ok' }, { name: 'unsafe', type, ...(type === '1' || type === '2' ? { linkName: 'target' } : {}), data: type === 'L' ? 'tail\0' : '' }]));
      const failure = await expectSourceError(materialize(source), 31, 'ARCHIVE_UNSAFE');
      if (type === 'Z' || type === 'L') expect(failure.message).toMatch(/header/u);
    },
  );

  it.each([
    { entries: [{ name: 'A.txt', data: 'a' }, { name: 'a.txt', data: 'b' }] },
    { entries: [{ name: '\u00e9.txt', data: 'a' }, { name: 'e\u0301.txt', data: 'b' }] },
    { entries: [{ name: 'same.txt', data: 'a' }, { name: 'same.txt', data: 'b' }] },
    { entries: [{ name: 'a', data: 'a' }, { name: 'a/b', data: 'b' }] },
    { entries: [{ name: 'a/b', data: 'b' }, { name: 'a', data: 'a' }] },
    { entries: [{ name: '././@LongLink', type: 'L', data: 'a\\evil\0' }, { name: 'placeholder', data: 'x' }] },
  ])('fails closed on case, NFC, or duplicate path collision', async ({ entries }) => {
    const root = await temporaryRoot();
    const source = join(root, 'collision.dshpack.tgz');
    await writeFile(source, archive(entries));
    await expectSourceError(materialize(source), 31, entries[0]?.type === 'L' ? 'ARCHIVE_UNSAFE' : 'ARCHIVE_COLLISION');
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
      archive(Array.from({ length: 1001 }, (_, index) => ({ name: `dir-${index}/`, type: '5' }))),
    ];
    for (const [index, contents] of cases.entries()) {
      const source = join(root, `limit-${index}.dshpack.tgz`);
      await writeFile(source, contents);
      await expectSourceError(materialize(source), 31, 'ARCHIVE_LIMIT');
    }
  });
  it('loops partial FileHandle writes and persists the exact downloaded archive', async () => {
    const root = await temporaryRoot(); const workspace = join(root, 'short-write'); const bytes = archive();
    const writeChunk = vi.fn(async (handle: unknown, chunk: Uint8Array, offset: number) => { const file = handle as { write(buffer: Uint8Array, offset: number, length: number, position: null): Promise<{ bytesWritten: number }> }; return (await file.write(chunk, offset, Math.min(3, chunk.byteLength - offset), null)).bytesWritten; });
    const result = await materialize(`https://example.test/a.tgz#${sri(bytes)}`, { makeTempDirectory: async () => { await mkdir(workspace); return workspace; }, writeChunk, download: async () => ({ statusCode: 200, body: chunks(bytes, 23) }) });
    expect(writeChunk).toHaveBeenCalled(); expect(await readFile(join(workspace, 'source.dshpack.tgz'))).toEqual(bytes);
    await result.cleanup();
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
