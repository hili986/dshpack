import { describe, expect, it } from 'vitest';

import {
  ComposeManifestSchema,
  parseCompose,
  validateComposeValue,
  validatePackValue,
} from '../src/index.js';

const compose = {
  composeVersion: 0,
  name: 'research-kit',
  version: '0.1.0',
  description: 'A composed research pack.',
  author: 'dsh-packs',
  license: 'MIT',
  include: [
    {
      from: 'github:dsh-packs/web-dev#3414f1af3fd674998cea81716586f4716a538f50',
      skills: ['commit-convention'],
    },
  ],
  resolve: [{ id: 'commit-convention', rename: 'web-commit-convention' }],
  mcp: [
    {
      serverName: 'context7',
      transport: 'streamable-http',
      url: 'https://mcp.context7.com/mcp',
    },
  ],
  defaults: { permissionPreset: 'workspace-write' },
} as const;

describe('compose v0 contract', () => {
  it('parses the complete declared compose document', () => {
    const source = `${JSON.stringify(compose, null, 2)}\n`;
    expect(parseCompose(source)).toEqual({ ok: true, value: compose, diagnostics: [] });
    expect(ComposeManifestSchema.additionalProperties).toBe(false);
  });

  it('rejects unknown fields and a future compose version', () => {
    expect(validateComposeValue({ ...compose, unexpected: true }).ok).toBe(false);
    expect(validateComposeValue({ ...compose, composeVersion: 1 }).diagnostics).toEqual([
      expect.objectContaining({ code: 'E_FORMAT_TOO_NEW', path: '/composeVersion' }),
    ]);
  });

  it('requires a single explicit resolution strategy and a non-empty skill selection', () => {
    expect(
      validateComposeValue({
        ...compose,
        include: [{ ...compose.include[0], skills: [] }],
      }).ok,
    ).toBe(false);
    expect(
      validateComposeValue({
        ...compose,
        resolve: [{ id: 'commit-convention', rename: 'renamed', prefer: 'profile:research' }],
      }).ok,
    ).toBe(false);
  });

  it('allows an output pack to retain P8 provenance without making it mandatory for old packs', () => {
    const manifest = {
      formatVersion: 0,
      name: 'research-kit',
      version: '0.1.0',
      description: 'A composed research pack.',
      author: 'dsh-packs',
      license: 'MIT',
      dsh: { tested: ['0.1.0-rc.6'] },
      plugins: [],
      mcp: [],
      defaults: { permissionPreset: 'workspace-write' },
      provenance: [
        {
          id: 'web-commit-convention',
          from: 'github:dsh-packs/web-dev#3414f1af3fd674998cea81716586f4716a538f50',
          originalId: 'commit-convention',
          license: 'MIT',
        },
      ],
    };
    expect(validatePackValue(manifest).ok).toBe(true);
    expect(validatePackValue({ ...manifest, provenance: undefined }).ok).toBe(true);
  });
});
