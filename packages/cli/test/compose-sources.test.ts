import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SourceError } from '../src/adapters/source.js';
import {
  isComposeMaterializedSource,
  materializeComposeSource,
  missingSkillDiagnostics,
  sourceSkills,
} from '../src/compose/sources.js';
import { EXIT_CODES } from '../src/exit-codes.js';
import type { ValidatedPackMaterial } from '../src/install/read.js';

const sha512 = 'sha512-AQID';

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
});
