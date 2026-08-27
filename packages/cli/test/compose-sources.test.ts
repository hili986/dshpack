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
      diagnostics: [
        {
          code: 'E_ARCHIVE_ENTRY_SKIPPED',
          severity: 'warning',
          message: 'Skipped non-regular archive entry: skills/link.',
          hint: 'The entry was not deployed or followed.',
          evidence: 'local',
        },
      ],
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
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'E_ARCHIVE_ENTRY_SKIPPED', severity: 'warning' }),
    ]);
    await result.cleanup();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('replaces a bare GitHub convenience input with the materialized pinned reference', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const result = await materializeComposeSource(
      { from: 'https://github.com/owner/repo', skills: ['citation'] },
      'C:/workspace/compose.yml',
      undefined,
      {
        materialize: vi.fn().mockResolvedValue({
          directory: 'C:/tmp/extracted',
          provenance: {
            kind: 'github',
            owner: 'owner',
            repo: 'repo',
            commit,
            url: `https://codeload.github.com/owner/repo/tar.gz/${commit}`,
          },
          cleanup,
        }),
        readPack: vi.fn().mockResolvedValue({ material: material(), diagnostics: [], exitCode: 0 }),
      },
    );

    expect(isComposeMaterializedSource(result)).toBe(true);
    if (!isComposeMaterializedSource(result)) throw new Error('expected materialized source');
    expect(result.from).toBe(`github:owner/repo#${commit}`);
    await result.cleanup();
  });

  it('adapts a conventional .agents skills source without admitting unrelated repository files', async () => {
    const root = await temporary();
    const skillRoot = join(root, '.agents', 'skills', 'external-skill');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      join(skillRoot, 'SKILL.md'),
      '---\nname: external-skill\ndescription: An external skill.\n---\n# External\n',
    );
    await writeFile(join(skillRoot, 'reference.md'), 'not a skill entry point\n');
    await writeFile(join(root, 'LICENSE'), 'MIT License\n');
    await writeFile(join(root, 'unrelated.txt'), 'never becomes a composed skill\n');
    const cleanup = vi.fn().mockResolvedValue(undefined);

    const result = await materializeComposeSource(
      { from: './external-source', skills: ['*'] },
      join(root, 'compose.yml'),
      undefined,
      {
        materialize: vi.fn().mockResolvedValue({ directory: root, cleanup }),
        readPack: vi.fn().mockResolvedValue({
          diagnostics: [
            {
              code: 'E_LAYOUT_UNKNOWN',
              severity: 'error',
              message: 'not a dshpack pack',
              hint: '',
              evidence: 'local',
            },
          ],
          exitCode: EXIT_CODES.CONTRACT,
        }),
      },
    );

    expect(isComposeMaterializedSource(result)).toBe(true);
    if (!isComposeMaterializedSource(result)) throw new Error('expected conventional source');
    expect(result.license).toBe('MIT');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'W_COMPOSE_CONVENTIONAL_SKILL_SOURCE' }),
      ]),
    );
    expect(sourceSkills(result, { from: result.from, skills: ['*'] }).available).toEqual([
      'external-skill',
    ]);
    expect(result.material.paths).toEqual(['skills/external-skill/SKILL.md']);
    expect(result.material.files).toEqual([
      expect.objectContaining({ path: 'skills/external-skill/SKILL.md' }),
    ]);
    await result.cleanup();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('keeps the original pack diagnostics when no conventional skill entry exists', async () => {
    const root = await temporary();
    await mkdir(join(root, '.agents', 'skills', 'not_valid'), { recursive: true });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const original = {
      diagnostics: [
        {
          code: 'E_LAYOUT_UNKNOWN',
          severity: 'error' as const,
          message: 'not a dshpack pack',
          hint: '',
          evidence: 'local' as const,
        },
      ],
      exitCode: EXIT_CODES.CONTRACT,
    };

    const result = await materializeComposeSource(
      { from: './external-source', skills: ['*'] },
      join(root, 'compose.yml'),
      undefined,
      {
        materialize: vi.fn().mockResolvedValue({ directory: root, cleanup }),
        readPack: vi.fn().mockResolvedValue(original),
      },
    );

    expect(isComposeMaterializedSource(result)).toBe(false);
    expect(result).toEqual(original);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('rejects malformed conventional skill entry points instead of adapting them', async () => {
    const root = await temporary();
    const skillRoot = join(root, '.agents', 'skills', 'bad-skill');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(skillRoot, 'SKILL.md'), '# missing frontmatter\n');
    const cleanup = vi.fn().mockResolvedValue(undefined);

    const result = await materializeComposeSource(
      { from: './external-source', skills: ['*'] },
      join(root, 'compose.yml'),
      undefined,
      {
        materialize: vi.fn().mockResolvedValue({ directory: root, cleanup }),
        readPack: vi.fn().mockResolvedValue({
          diagnostics: [],
          exitCode: EXIT_CODES.CONTRACT,
        }),
      },
    );

    expect(isComposeMaterializedSource(result)).toBe(false);
    expect(result).toMatchObject({
      exitCode: EXIT_CODES.CONTRACT,
      diagnostics: [expect.objectContaining({ code: 'DSH010' })],
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('rejects a conventional skill root that is not a normal directory', async () => {
    const root = await temporary();
    const agents = join(root, '.agents');
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, 'skills'), 'not a directory\n');
    const cleanup = vi.fn().mockResolvedValue(undefined);

    const result = await materializeComposeSource(
      { from: './external-source', skills: ['*'] },
      join(root, 'compose.yml'),
      undefined,
      {
        materialize: vi.fn().mockResolvedValue({ directory: root, cleanup }),
        readPack: vi.fn().mockResolvedValue({
          diagnostics: [],
          exitCode: EXIT_CODES.CONTRACT,
        }),
      },
    );

    expect(isComposeMaterializedSource(result)).toBe(false);
    expect(result).toMatchObject({
      exitCode: EXIT_CODES.SECURITY,
      diagnostics: [expect.objectContaining({ code: 'E_PATH_CONVENTIONAL_SKILLS' })],
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    ['CC0 license', 'Creative Commons Legal Code\nCC0 1.0 Universal\n', 'CC0-1.0'],
    ['Apache license', 'Apache License\nVersion 2.0, January 2004\n', 'Apache-2.0'],
    ['unknown license', 'A custom license text\n', 'UNLICENSED'],
  ])(
    'reads a declared %s without inventing a different license',
    async (_name, licenseText, license) => {
      const root = await temporary();
      const skillRoot = join(root, '.agents', 'skills', 'licensed-skill');
      await mkdir(skillRoot, { recursive: true });
      await writeFile(
        join(skillRoot, 'SKILL.md'),
        '---\nname: licensed-skill\ndescription: A licensed skill.\n---\n# Licensed\n',
      );
      await writeFile(join(root, 'LICENSE'), licenseText);
      const cleanup = vi.fn().mockResolvedValue(undefined);

      const result = await materializeComposeSource(
        { from: './external-source', skills: ['*'] },
        join(root, 'compose.yml'),
        undefined,
        {
          materialize: vi.fn().mockResolvedValue({ directory: root, cleanup }),
          readPack: vi.fn().mockResolvedValue({ diagnostics: [], exitCode: EXIT_CODES.CONTRACT }),
        },
      );

      expect(isComposeMaterializedSource(result)).toBe(true);
      if (!isComposeMaterializedSource(result)) throw new Error('expected conventional source');
      expect(result.license).toBe(license);
      await result.cleanup();
    },
  );

  it('does not adapt a conventional directory that has no direct SKILL.md entry point', async () => {
    const root = await temporary();
    const skillRoot = join(root, '.agents', 'skills', 'incomplete-skill');
    await mkdir(join(skillRoot, 'nested'), { recursive: true });
    await writeFile(join(skillRoot, 'nested', 'SKILL.md'), '# nested is not deployable\n');
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const original = { diagnostics: [], exitCode: EXIT_CODES.CONTRACT };

    const result = await materializeComposeSource(
      { from: './external-source', skills: ['*'] },
      join(root, 'compose.yml'),
      undefined,
      {
        materialize: vi.fn().mockResolvedValue({ directory: root, cleanup }),
        readPack: vi.fn().mockResolvedValue(original),
      },
    );

    expect(isComposeMaterializedSource(result)).toBe(false);
    expect(result).toEqual(original);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('keeps secret-shaped conventional skill content as a security rejection', async () => {
    const root = await temporary();
    const skillRoot = join(root, '.agents', 'skills', 'secret-skill');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      join(skillRoot, 'SKILL.md'),
      [
        '---',
        'name: secret-skill',
        'description: A skill with a rejected credential.',
        '---',
        'apiKey: zQ9vLm2aBx7Rt4YpNc8Kd1WsFe6Hu3Gi',
      ].join('\n'),
    );
    const cleanup = vi.fn().mockResolvedValue(undefined);

    const result = await materializeComposeSource(
      { from: './external-source', skills: ['*'] },
      join(root, 'compose.yml'),
      undefined,
      {
        materialize: vi.fn().mockResolvedValue({ directory: root, cleanup }),
        readPack: vi.fn().mockResolvedValue({ diagnostics: [], exitCode: EXIT_CODES.CONTRACT }),
      },
    );

    expect(isComposeMaterializedSource(result)).toBe(false);
    expect(result).toMatchObject({
      exitCode: EXIT_CODES.SECURITY,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'E_SECRET_KEY' })]),
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('classifies an unreadable conventional root as source integrity rather than pretending none exists', async () => {
    vi.resetModules();
    const filesystem = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.doMock('node:fs/promises', () => ({
      ...filesystem,
      lstat: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' })),
    }));
    const { materializeComposeSource: materialize } = await import('../src/compose/sources.js');
    const cleanup = vi.fn().mockResolvedValue(undefined);

    const result = await materialize(
      { from: './external-source', skills: ['*'] },
      'C:/workspace/compose.yml',
      undefined,
      {
        materialize: vi.fn().mockResolvedValue({ directory: 'C:/workspace/external', cleanup }),
        readPack: vi.fn().mockResolvedValue({ diagnostics: [], exitCode: EXIT_CODES.CONTRACT }),
      },
    );

    expect(result).toMatchObject({
      exitCode: EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
      diagnostics: [expect.objectContaining({ code: 'E_SOURCE_CONVENTIONAL_SKILLS' })],
    });
    expect(cleanup).toHaveBeenCalledOnce();
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
  });

  it.each([
    ['security', EXIT_CODES.SECURITY, 'E_PATH_CONVENTIONAL_SKILLS'],
    ['limit', EXIT_CODES.SOURCE_NETWORK_INTEGRITY, 'E_SOURCE_CONVENTIONAL_SKILLS'],
  ] as const)(
    'keeps conventional snapshot %s failures visible and classified',
    async (kind, exitCode, code) => {
      vi.resetModules();
      const snapshot = await vi.importActual<typeof import('../src/install/snapshot-capture.js')>(
        '../src/install/snapshot-capture.js',
      );
      vi.doMock('../src/install/snapshot-capture.js', () => ({
        ...snapshot,
        captureSourceDirectory: vi
          .fn()
          .mockRejectedValue(
            new snapshot.SnapshotCaptureError(kind, 'injected snapshot failure', 'SKILL.md'),
          ),
      }));
      const { materializeComposeSource: materialize } = await import('../src/compose/sources.js');
      const root = await temporary();
      await mkdir(join(root, '.agents', 'skills', 'snapshot-skill'), { recursive: true });
      const cleanup = vi.fn().mockResolvedValue(undefined);

      const result = await materialize(
        { from: './external-source', skills: ['*'] },
        join(root, 'compose.yml'),
        undefined,
        {
          materialize: vi.fn().mockResolvedValue({ directory: root, cleanup }),
          readPack: vi.fn().mockResolvedValue({ diagnostics: [], exitCode: EXIT_CODES.CONTRACT }),
        },
      );

      expect(result).toMatchObject({
        exitCode,
        diagnostics: [expect.objectContaining({ code, path: 'SKILL.md' })],
      });
      expect(cleanup).toHaveBeenCalledOnce();
      vi.doUnmock('../src/install/snapshot-capture.js');
      vi.resetModules();
    },
  );

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
