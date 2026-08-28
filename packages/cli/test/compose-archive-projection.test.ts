import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import { materializeSource, materializeSourceForCompose } from '../src/adapters/source.js';
import {
  isComposeMaterializedSource,
  materializeComposeSource,
  sourceSkills,
} from '../src/compose/sources.js';
import { previewCompose } from '../src/ui/compose.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-compose-archive-projection-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
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
  const padding = Buffer.alloc((512 - (data.byteLength % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function archive(entries: Array<Parameters<typeof tarEntry>[0]>): Buffer {
  return gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]));
}

describe('compose archive projection', () => {
  it('deploys only selected SKILL.md files and reports skipped regular entries once', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'external.dshpack.tgz');
    const oversized = Buffer.alloc(1024 * 1024 + 1);
    const readme = 'this repository file is not a composed skill\n';
    await writeFile(
      source,
      archive([
        { name: '.agents/', type: '5' },
        { name: '.agents/skills/', type: '5' },
        { name: '.agents/skills/notes/', type: '5' },
        {
          name: '.agents/skills/notes/SKILL.md',
          data: '---\nname: notes\ndescription: Notes.\n---\n\n# Notes\n',
        },
        { name: '.agents/skills/notes/references/', type: '5' },
        { name: '.agents/skills/notes/references/guide.md', data: '# Reference\n' },
        { name: 'README.md', data: readme },
        { name: 'unrelated.bin', data: oversized },
      ]),
    );

    await expect(materializeSource(source)).rejects.toMatchObject({ code: 'ARCHIVE_LIMIT' });

    const projected = await materializeSourceForCompose(source);
    try {
      await expect(
        lstat(join(projected.directory, '.agents', 'skills', 'notes', 'SKILL.md')),
      ).resolves.toMatchObject({
        isFile: expect.any(Function),
      });
      await expect(
        lstat(join(projected.directory, '.agents', 'skills', 'notes', 'references', 'guide.md')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(join(projected.directory, 'README.md'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(lstat(join(projected.directory, 'unrelated.bin'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(projected.diagnostics).toEqual([
        expect.objectContaining({
          code: 'E_ARCHIVE_SELECTIVE_SKIPPED',
          severity: 'warning',
          message: expect.stringContaining(
            `3 个普通条目，共 ${oversized.byteLength + Buffer.byteLength(readme) + 12} bytes`,
          ),
        }),
      ]);
    } finally {
      await projected.cleanup();
    }

    const composed = await materializeComposeSource(
      { from: source, skills: ['*'] },
      join(root, 'compose.yml'),
      undefined,
    );

    expect(isComposeMaterializedSource(composed)).toBe(true);
    if (!isComposeMaterializedSource(composed)) throw new Error('expected compose material');
    expect(sourceSkills(composed, { from: source, skills: ['*'] }).available).toEqual(['notes']);
    expect(composed.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'E_ARCHIVE_SELECTIVE_SKIPPED', severity: 'warning' }),
      ]),
    );
    expect(composed.material.paths).toEqual(['skills/notes/SKILL.md']);
    await composed.cleanup();
  });

  it('rejects an unsafe path even when it cannot be selected for composition', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'unsafe.dshpack.tgz');
    await writeFile(
      source,
      archive([
        { name: '.agents/', type: '5' },
        { name: '.agents/skills/', type: '5' },
        { name: '.agents/skills/notes/', type: '5' },
        {
          name: '.agents/skills/notes/SKILL.md',
          data: '---\nname: notes\ndescription: Notes.\n---\n\n# Notes\n',
        },
        { name: '../outside.bin', data: Buffer.alloc(1024 * 1024 + 1) },
      ]),
    );

    const result = await materializeComposeSource(
      { from: source, skills: ['*'] },
      join(root, 'compose.yml'),
      undefined,
    );

    expect(isComposeMaterializedSource(result)).toBe(false);
    expect(result).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'ARCHIVE_UNSAFE' })],
    });
  });

  it('applies the 4096-entry limit only to the projected deployment set', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'too-many-unselected.dshpack.tgz');
    await writeFile(
      source,
      archive([
        { name: '.agents/', type: '5' },
        { name: '.agents/skills/', type: '5' },
        { name: '.agents/skills/notes/', type: '5' },
        {
          name: '.agents/skills/notes/SKILL.md',
          data: '---\nname: notes\ndescription: Notes.\n---\n\n# Notes\n',
        },
        ...Array.from({ length: 4093 }, (_, index) => ({
          name: `unselected-${String(index)}.md`,
        })),
      ]),
    );

    const result = await materializeComposeSource(
      { from: source, skills: ['*'] },
      join(root, 'compose.yml'),
      undefined,
    );

    expect(isComposeMaterializedSource(result)).toBe(true);
    if (!isComposeMaterializedSource(result))
      throw new Error('expected projected compose material');
    expect(sourceSkills(result, { from: source, skills: ['*'] }).available).toEqual(['notes']);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'E_ARCHIVE_SELECTIVE_SKIPPED',
          message: expect.stringContaining('4093 个普通条目，共 0 bytes'),
        }),
      ]),
    );
    await result.cleanup();
  });

  it('keeps the 1 MiB limit for a SKILL.md selected by compose', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'oversized-skill.dshpack.tgz');
    await writeFile(
      source,
      archive([
        { name: '.agents/', type: '5' },
        { name: '.agents/skills/', type: '5' },
        { name: '.agents/skills/notes/', type: '5' },
        {
          name: '.agents/skills/notes/SKILL.md',
          data: Buffer.alloc(1024 * 1024 + 1),
        },
      ]),
    );

    const composed = await materializeComposeSource(
      { from: source, skills: ['*'] },
      join(root, 'compose.yml'),
      undefined,
    );

    expect(isComposeMaterializedSource(composed)).toBe(false);
    if (isComposeMaterializedSource(composed)) throw new Error('expected compose rejection');
    expect(composed.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'ARCHIVE_LIMIT' })]),
    );
  });

  it('keeps a root pack archive on install-equivalent full extraction in compose mode', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'pack-with-binary.dshpack.tgz');
    await writeFile(
      source,
      archive([
        { name: 'pack.yml', data: 'formatVersion: 0\nname: demo\nversion: 1.0.0\n' },
        { name: 'unrelated.bin', data: Buffer.alloc(1024 * 1024 + 1) },
      ]),
    );

    await expect(materializeSourceForCompose(source)).rejects.toMatchObject({
      code: 'ARCHIVE_LIMIT',
    });
  });

  it('enforces the 4096-entry cap against the selected deployment set', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'too-many-selected.dshpack.tgz');
    const skills = Array.from({ length: 2048 }, (_, index) => {
      const id = `skill-${String(index)}`;
      return [
        { name: `.agents/skills/${id}/`, type: '5' },
        {
          name: `.agents/skills/${id}/SKILL.md`,
          data: `---\nname: ${id}\ndescription: Test.\n---\n\n# ${id}\n`,
        },
      ];
    }).flat();
    await writeFile(
      source,
      archive([{ name: '.agents/', type: '5' }, { name: '.agents/skills/', type: '5' }, ...skills]),
    );

    await expect(materializeSourceForCompose(source)).rejects.toMatchObject({
      code: 'ARCHIVE_LIMIT',
    });
  });

  it('keeps an explicitly warned no-skill source out of a successful two-source preview', async () => {
    const root = await temporaryRoot();
    const emptySource = join(root, 'empty.dshpack.tgz');
    const skillSource = join(root, 'skill.dshpack.tgz');
    await writeFile(
      emptySource,
      archive([
        { name: 'LICENSE', data: 'MIT License\n' },
        { name: 'unrelated.bin', data: Buffer.alloc(1024 * 1024 + 1) },
      ]),
    );
    await writeFile(
      skillSource,
      archive([
        { name: '.agents/', type: '5' },
        { name: '.agents/skills/', type: '5' },
        { name: '.agents/skills/notes/', type: '5' },
        {
          name: '.agents/skills/notes/SKILL.md',
          data: '---\nname: notes\ndescription: Notes.\n---\n\n# Notes\n',
        },
      ]),
    );
    const preview = await previewCompose(join(root, 'dsh-home'), {
      spec: {
        composeVersion: 0,
        name: 'projected-sources',
        version: '1.0.0',
        description: 'A safe source without skills must not block another source.',
        author: 'test',
        license: 'MIT',
        include: [
          { from: emptySource, skills: ['*'] },
          { from: skillSource, skills: ['*'] },
        ],
        defaults: { permissionPreset: 'workspace-write' },
      },
    });
    expect(preview.exitCode).toBe(0);
    expect(preview.metadata).toMatchObject({
      sourceSkills: [
        { from: emptySource, skills: [] },
        { from: skillSource, skills: ['notes'] },
      ],
    });
    expect(preview.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'W_COMPOSE_NO_SKILL_SOURCE' })]),
    );
  });
});
