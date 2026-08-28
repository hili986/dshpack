import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectAndExtractArchive,
  MAX_RAW_HEADER_BYTES,
  rawHeadersSafe,
} from '../src/adapters/source-archive.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-source-archive-test-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function rawArchive(): Buffer {
  const header = Buffer.alloc(512);
  header.write('safe.txt', 0, 100, 'utf8');
  header.write(octal(0o644, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(1, 12), 124, 12, 'ascii');
  header.write(octal(0, 12), 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return Buffer.concat([header, Buffer.from('x'), Buffer.alloc(511), Buffer.alloc(1024)]);
}

function tarEntry(input: { name: string; type?: string; data?: Uint8Array | string }): Buffer {
  const data = Buffer.from(input.data ?? '');
  const header = Buffer.alloc(512);
  header.write(input.name, 0, 100, 'utf8');
  header.write(octal(0o644, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(data.byteLength, 12), 124, 12, 'ascii');
  header.write(octal(0, 12), 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(input.type ?? '0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.byteLength % 512)) % 512)]);
}

function archive(entries: Array<Parameters<typeof tarEntry>[0]>): Buffer {
  return gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]));
}

function archiveFailure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe('source archive raw-header preflight', () => {
  it('reports a decompression cap with its own code and the observed byte count', async () => {
    const root = await temporaryRoot();
    const archive = join(root, 'oversized.dshpack.tgz');
    await writeFile(archive, gzipSync(rawArchive()));

    expect(MAX_RAW_HEADER_BYTES).toBe(256 * 1024 * 1024);
    const safety = await rawHeadersSafe(archive, 1024);

    expect(safety).toMatchObject({ safe: false, reason: 'cap', maxExpandedBytes: 1024 });
    if (safety.safe || safety.reason !== 'cap')
      throw new Error('expected the injected cap to reject');
    await expect(
      inspectAndExtractArchive(archive, join(root, 'output'), archiveFailure, undefined, {
        rawHeaderMaxBytes: 1024,
      }),
    ).rejects.toMatchObject({
      code: 'E_ARCHIVE_PREFLIGHT_CAP',
      message: expect.stringContaining(String(safety.expandedBytes)),
    });
  });

  it('keeps malformed raw headers classified as ARCHIVE_UNSAFE', async () => {
    const root = await temporaryRoot();
    const archive = join(root, 'malformed.dshpack.tgz');
    const malformed = rawArchive();
    malformed[9] = 0;
    malformed[10] = 'x'.charCodeAt(0);
    await writeFile(archive, gzipSync(malformed));

    await expect(
      inspectAndExtractArchive(archive, join(root, 'output'), archiveFailure),
    ).rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE', message: expect.stringContaining('header') });
  });

  it('treats a non-octal raw tar size field as unsafe before parser extraction', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'non-octal-size.dshpack.tgz');
    const malformed = rawArchive();
    malformed.write('not-octal', 124, 'ascii');
    await writeFile(source, gzipSync(malformed));

    await expect(rawHeadersSafe(source)).resolves.toEqual({ safe: false, reason: 'unsafe' });
  });

  it('rejects a syntactically safe but empty tar archive', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'empty.dshpack.tgz');
    await writeFile(source, gzipSync(Buffer.alloc(1024)));

    await expect(inspectAndExtractArchive(source, root, archiveFailure)).rejects.toMatchObject({
      code: 'ARCHIVE_UNSAFE',
    });
  });

  it('rejects a directory entry that carries file bytes', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'directory-data.dshpack.tgz');
    await writeFile(source, archive([{ name: 'directory/', type: '5', data: 'x' }]));

    await expect(inspectAndExtractArchive(source, root, archiveFailure)).rejects.toMatchObject({
      code: 'ARCHIVE_UNSAFE',
    });
  });

  it('keeps a genuinely corrupted gzip stream classified as ARCHIVE_UNSAFE', async () => {
    const root = await temporaryRoot();
    const archive = join(root, 'corrupted-gzip.dshpack.tgz');
    const gzip = gzipSync(rawArchive());
    await writeFile(archive, gzip.subarray(0, -1));

    await expect(
      inspectAndExtractArchive(archive, join(root, 'output'), archiveFailure),
    ).rejects.toMatchObject({ code: 'ARCHIVE_UNSAFE' });
  });

  it('keeps the GitHub codeload root while projecting only a conventional SKILL.md', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'codeload.tgz');
    const workspace = join(root, 'output');
    const commit = '0123456789abcdef0123456789abcdef01234567';
    await mkdir(workspace);
    await writeFile(
      source,
      archive([
        { name: 'repo-commit/', type: '5' },
        { name: 'repo-commit/.agents/', type: '5' },
        { name: 'repo-commit/.agents/skills/', type: '5' },
        { name: 'repo-commit/.agents/skills/notes/', type: '5' },
        {
          name: 'repo-commit/.agents/skills/notes/SKILL.md',
          data: '---\nname: notes\ndescription: Notes.\n---\n\n# Notes\n',
        },
        { name: 'repo-commit/README.md', data: 'not composed' },
      ]),
    );

    const extracted = await inspectAndExtractArchive(
      source,
      workspace,
      archiveFailure,
      { commit },
      { selectiveComposeSkills: true },
    );

    expect(extracted.directory).toBe(join(workspace, 'contents', 'repo-commit'));
    await expect(
      lstat(join(extracted.directory, '.agents', 'skills', 'notes', 'SKILL.md')),
    ).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(lstat(join(extracted.directory, 'README.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(extracted.diagnostics).toEqual([
      expect.objectContaining({
        code: 'E_ARCHIVE_SELECTIVE_SKIPPED',
        message: expect.stringContaining('1 个普通条目，共 12 bytes'),
      }),
    ]);
  });

  // Nails the selective-mode id rule independently of downstream compose validation: a
  // mutant that relaxes the safe-id regex must turn this red by deploying the bad id.
  it('skips unsafe skill ids even in selective compose projection', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'unsafe-id.tgz');
    const workspace = join(root, 'output');
    const commit = '0123456789abcdef0123456789abcdef01234567';
    await mkdir(workspace);
    await writeFile(
      source,
      archive([
        { name: 'repo-commit/', type: '5' },
        { name: 'repo-commit/.agents/skills/notes/SKILL.md', data: '# safe\n' },
        { name: 'repo-commit/.agents/skills/UPPER_CASE/SKILL.md', data: '# unsafe id\n' },
      ]),
    );

    const extracted = await inspectAndExtractArchive(
      source,
      workspace,
      archiveFailure,
      { commit },
      { selectiveComposeSkills: true },
    );

    await expect(
      lstat(join(extracted.directory, '.agents', 'skills', 'notes', 'SKILL.md')),
    ).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(
      lstat(join(extracted.directory, '.agents', 'skills', 'UPPER_CASE')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(extracted.diagnostics).toEqual([
      expect.objectContaining({ code: 'E_ARCHIVE_SELECTIVE_SKIPPED' }),
    ]);
  });
});
