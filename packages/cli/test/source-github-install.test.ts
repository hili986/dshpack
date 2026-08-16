import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import { materializeSource } from '../src/adapters/source.js';
import { readValidatedPack } from '../src/install/read.js';
import { enginePack } from './install-engine-fixture.js';

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function tarEntry(input: { name: string; type?: '0' | '5'; data?: Uint8Array | string }): Buffer {
  const data = Buffer.from(input.data ?? '');
  const header = Buffer.alloc(512);
  header.write(input.name, 0, 100, 'utf8');
  header.write(octal(0o644, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(data.length, 12), 124, 12, 'ascii');
  header.write(octal(0, 12), 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(input.type ?? '0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function archive(entries: Parameters<typeof tarEntry>[0][]): Buffer {
  return gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]));
}

function chunks(value: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield value;
  })();
}

const commit = '0123456789abcdef0123456789abcdef01234567';
const reference = `github:owner/repo#${commit}`;
const expectedRoot = `repo-${commit}`;

describe('GitHub source install handoff', () => {
  it('unwraps the exact codeload root before validated pack reading', async () => {
    const pack = await enginePack();
    const bytes = archive([
      { name: `${expectedRoot}/`, type: '5' },
      { name: `${expectedRoot}/patch/`, type: '5' },
      { name: `${expectedRoot}/pack.yml`, data: await readFile(join(pack, 'pack.yml')) },
      { name: `${expectedRoot}/pack.lock.yml`, data: await readFile(join(pack, 'pack.lock.yml')) },
      {
        name: `${expectedRoot}/patch/cordis.patch.yml`,
        data: await readFile(join(pack, 'patch', 'cordis.patch.yml')),
      },
    ]);
    const source = await materializeSource(reference, {
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
      download: async () => ({ statusCode: 200, body: chunks(bytes) }),
    });

    expect(source.directory.endsWith(expectedRoot)).toBe(true);
    const validated = await readValidatedPack(source.directory);
    expect(validated).toMatchObject({ material: { manifest: { name: 'engine-pack' } } });
    expect(validated.diagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
    await source.cleanup();
  });

  it('accepts one safe server-selected root without treating its name as the pin', async () => {
    const root = 'server-selected-root';
    const bytes = archive([{ name: `${root}/file`, data: 'safe' }]);
    const source = await materializeSource(reference, {
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
      download: async () => ({ statusCode: 200, body: chunks(bytes) }),
    });
    expect(source.directory.endsWith(root)).toBe(true);
    expect(await readFile(join(source.directory, 'file'), 'utf8')).toBe('safe');
    await source.cleanup();
  });

  it.each([
    [
      'multiple roots',
      [
        { name: `${expectedRoot}/`, type: '5' },
        { name: `${expectedRoot}/pack.yml`, data: 'x' },
        { name: 'other/', type: '5' },
        { name: 'other/file', data: 'x' },
      ],
    ],
    ['file-shaped root', [{ name: expectedRoot, data: 'x' }]],
  ] as const)('rejects a codeload archive with %s', async (_case, entries) => {
    const download = vi.fn(async () => ({ statusCode: 200, body: chunks(archive([...entries])) }));
    await expect(
      materializeSource(reference, {
        resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
        download,
      }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE', exitCode: 31 });
  });
});
