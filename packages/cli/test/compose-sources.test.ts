import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SourceError } from '../src/adapters/source.js';
import {
  isComposeMaterializedSource,
  materializeComposeSource,
  missingSkillDiagnostics,
  sourceSkills,
} from '../src/compose/sources.js';
import { EXIT_CODES } from '../src/exit-codes.js';
import type { ValidatedPackMaterial } from '../src/install/read.js';
import { removeFixtureDirectory } from './fixture-cleanup.js';

const sha512 = 'sha512-AQID';
const roots: string[] = [];

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-compose-sources-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeFixtureDirectory(root)));
});

function material(): ValidatedPackMaterial {
  return {
    manifest: {
      formatVersion: 0,
      name: 'source-pack',
      version: '0.1.0',
      description: 'Source fixture.',
      author: 'dsh-packs',
      license: 'MIT',
      dsh: { tested: ['0.1.0-rc.6'] },
      plugins: [],
      mcp: [],
      defaults: { permissionPreset: 'workspace-write' },
    },
    paths: ['skills/citation/SKILL.md', 'skills/outline/SKILL.md'],
    files: [
      {
        path: 'skills/citation/SKILL.md',
        sha512,
        contentBase64: Buffer.from('# Citation\n').toString('base64'),
      },
      {
        path: 'skills/outline/SKILL.md',
        sha512,
        contentBase64: Buffer.from('# Outline\n').toString('base64'),
      },
    ],
    sourceFiles: [],
    manifestDigest: 'sha256-AQID',
  };
}

describe('compose source materialization', () => {
  it('uses the established source materializer and validated immutable snapshot for a local directory', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const materialize = vi.fn().mockResolvedValue({
      directory: 'C:/workspace/local-pack',
      provenance: { kind: 'directory', path: 'C:/workspace/local-pack' },
      cleanup,
    });
    const readPack = vi
      .fn()
      .mockResolvedValue({ material: material(), diagnostics: [], exitCode: 30 });

    const result = await materializeComposeSource(
      { from: './local-pack', skills: ['citation'] },
      'C:/workspace/compose.yml',
      undefined,
      { materialize, readPack },
    );

    expect(materialize).toHaveBeenCalledWith(resolve('C:/workspace/local-pack'));
    expect(readPack).toHaveBeenCalledWith('C:/workspace/local-pack', { frozen: false });
    expect(isComposeMaterializedSource(result)).toBe(true);
    if (!isComposeMaterializedSource(result)) throw new Error('expected materialized source');
    expect(result.from).toBe('./local-pack');
    expect(result.license).toBe('MIT');
    await result.cleanup();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('expands star, preserves immutable source bytes, and reports every explicit missing skill with choices', () => {
    const source = {
      from: 'github:dsh-packs/web-dev#3414f1af3fd674998cea81716586f4716a538f50',
      material: material(),
      cleanup: async () => undefined,
      license: 'MIT',
    };
    const all = sourceSkills(source, { from: source.from, skills: ['*'] });
    expect(all.available).toEqual(['citation', 'outline']);
    expect(all.items.map(({ id }) => id).sort()).toEqual(['citation', 'outline']);
    expect(all.items[0]?.bytes).toEqual(Buffer.from('# Citation\n'));

    const selected = sourceSkills(source, { from: source.from, skills: ['citation', 'missing'] });
    const diagnostics = missingSkillDiagnostics(
      source,
      { from: source.from, skills: ['citation', 'missing'] },
      selected.available,
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'E_COMPOSE_SKILL_MISSING',
        hint: '可选 id: citation, outline',
      }),
    ]);
  });

  it('preserves the source adapter integrity exit classification', async () => {
    const result = await materializeComposeSource(
      { from: './local-pack', skills: ['citation'] },
      'C:/workspace/compose.yml',
      undefined,
      {
        materialize: vi
          .fn()
          .mockRejectedValue(
            new SourceError('SOURCE_INTEGRITY', EXIT_CODES.SOURCE_NETWORK_INTEGRITY, 'bad SRI'),
          ),
      },
    );

    expect(isComposeMaterializedSource(result)).toBe(false);
    expect(result).toMatchObject({
      exitCode: EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
      diagnostics: [expect.objectContaining({ code: 'SOURCE_INTEGRITY' })],
    });
  });

  it('strips the tarball: prefix and leaves a remote reference otherwise untouched', async () => {
    // Only `./` references are resolved against the compose file. A URL must reach the adapter
    // byte-for-byte, or the SRI fragment it carries would be resolved into a local path.
    const remote = 'https://example.com/pack.tgz#sha512-AQID';
    const materialize = vi.fn().mockResolvedValue({
      directory: 'C:/tmp/extracted',
      cleanup: vi.fn().mockResolvedValue(undefined),
    });

    await materializeComposeSource(
      { from: `tarball:${remote}`, skills: ['*'] },
      'C:/workspace/compose.yml',
      undefined,
      {
        materialize,
        readPack: vi.fn().mockResolvedValue({ material: material(), diagnostics: [], exitCode: 0 }),
      },
    );

    expect(materialize).toHaveBeenCalledWith(remote);
  });

  it('describes a rejection that is not an Error at all', async () => {
    const result = await materializeComposeSource(
      { from: './local-pack', skills: ['citation'] },
      'C:/workspace/compose.yml',
      undefined,
      { materialize: vi.fn().mockRejectedValue('not an error object') },
    );

    expect(result).toMatchObject({
      exitCode: EXIT_CODES.CONTRACT,
      diagnostics: [
        expect.objectContaining({ code: 'E_COMPOSE_SOURCE', message: 'source 获取失败。' }),
      ],
    });
  });

  it('says so explicitly when the source offers no skills at all', () => {
    const empty = {
      from: './empty-pack',
      material: { ...material(), paths: [], files: [] },
      cleanup: async () => undefined,
      license: 'MIT',
    };
    const diagnostics = missingSkillDiagnostics(
      empty,
      { from: empty.from, skills: ['citation'] },
      sourceSkills(empty, { from: empty.from, skills: ['citation'] }).available,
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'E_COMPOSE_SKILL_MISSING', hint: '可选 id: (none)' }),
    ]);
  });

  it('classifies a non-adapter failure as a contract error rather than borrowing a source code', async () => {
    const result = await materializeComposeSource(
      { from: './local-pack', skills: ['citation'] },
      'C:/workspace/compose.yml',
      undefined,
      { materialize: vi.fn().mockRejectedValue(new Error('disk went away')) },
    );

    expect(result).toMatchObject({
      exitCode: EXIT_CODES.CONTRACT,
      diagnostics: [
        expect.objectContaining({ code: 'E_COMPOSE_SOURCE', message: 'disk went away' }),
      ],
    });
  });

  it('releases the snapshot when the pack behind it does not validate, and keeps that exit code', async () => {
    // Without the cleanup on this path a rejected source would leave its extracted tree on disk,
    // and without carrying `exitCode` the caller would see a generic contract failure for what
    // the reader already classified.
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const result = await materializeComposeSource(
      { from: './local-pack', skills: ['citation'] },
      'C:/workspace/compose.yml',
      undefined,
      {
        materialize: vi.fn().mockResolvedValue({ directory: 'C:/workspace/local-pack', cleanup }),
        readPack: vi.fn().mockResolvedValue({
          material: undefined,
          diagnostics: [
            {
              code: 'E_PACK_SCHEMA',
              severity: 'error',
              message: 'bad',
              hint: '',
              evidence: 'local',
            },
          ],
          exitCode: EXIT_CODES.CONTRACT,
        }),
      },
    );

    expect(cleanup).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      exitCode: EXIT_CODES.CONTRACT,
      diagnostics: [expect.objectContaining({ code: 'E_PACK_SCHEMA' })],
    });
  });
});

describe('profile: source materialization', () => {
  // The engine tests inject the materializer, so this whole path — the one that reaches the user's
  // dsh home and shells out through `export` — runs nowhere else.
  it('refuses to touch a profile without an explicit home, before calling export', async () => {
    const exportProfile = vi.fn();
    const result = await materializeComposeSource(
      { from: 'profile:research', skills: ['*'] },
      'C:/workspace/compose.yml',
      undefined,
      { exportProfile },
    );

    expect(exportProfile).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      exitCode: EXIT_CODES.ENVIRONMENT,
      diagnostics: [expect.objectContaining({ code: 'E_DSH_HOME_REQUIRED' })],
    });
  });

  it('surfaces the export failure verbatim instead of reading a directory export never wrote', async () => {
    const readPack = vi.fn();
    const result = await materializeComposeSource(
      { from: 'profile:research', skills: ['*'] },
      'C:/workspace/compose.yml',
      resolve('/isolated-home'),
      {
        exportProfile: vi.fn().mockResolvedValue({
          diagnostics: [
            {
              code: 'DSH004',
              severity: 'error',
              message: 'no profile',
              hint: '',
              evidence: 'local',
            },
          ],
          exitCode: EXIT_CODES.CONTRACT,
          metadata: {},
        }),
        readPack,
      },
    );

    expect(readPack).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      exitCode: EXIT_CODES.CONTRACT,
      diagnostics: [expect.objectContaining({ code: 'DSH004' })],
    });
  });

  it('exports into a scratch directory beside the compose file and removes it on cleanup', async () => {
    const root = await temporary();
    const composeFile = join(root, 'compose.yml');
    let exported = '';
    const exportProfile = vi.fn(async ({ output }: { output: string }) => {
      exported = output;
      await mkdir(output, { recursive: true });
      await writeFile(join(output, 'pack.yml'), 'name: exported\n');
      return { diagnostics: [], exitCode: EXIT_CODES.SUCCESS, metadata: {} };
    });

    const result = await materializeComposeSource(
      { from: 'profile:research', skills: ['*'] },
      composeFile,
      resolve('/isolated-home'),
      {
        exportProfile: exportProfile as never,
        readPack: vi.fn().mockResolvedValue({ material: material(), diagnostics: [], exitCode: 0 }),
      },
    );

    expect(exportProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        dshHome: resolve('/isolated-home'),
        profile: 'research',
        includeSkills: true,
        yes: true,
      }),
    );
    // Scratch lives beside compose.yml, not in the user's tree or a shared temp path.
    expect(exported.startsWith(root)).toBe(true);
    await expect(access(exported)).resolves.toBeUndefined();

    if (!isComposeMaterializedSource(result)) throw new Error('expected materialized source');
    expect(result.from).toBe('profile:research');
    await result.cleanup();
    await expect(access(exported)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
