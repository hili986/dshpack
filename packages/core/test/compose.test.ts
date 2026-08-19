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

  it('points a missing required field at the field, not at the document root', () => {
    const { name: _dropped, ...withoutName } = compose;
    expect(validateComposeValue(withoutName)).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'E_SCHEMA_TYPE', path: '/name' })],
    });
  });

  it('accepts a document that omits the optional resolve and mcp sections entirely', () => {
    // The fixture always writes `resolve: []` and `mcp: []`, so the absent case — which is what a
    // hand-written minimal compose.yml actually looks like — went unexercised.
    const { resolve: _r, mcp: _m, ...minimal } = compose;
    expect(validateComposeValue(minimal)).toMatchObject({ ok: true });
  });

  it('rejects a resolve entry that names neither strategy, not just one that names both', () => {
    // "Exactly one" has two ways to be wrong. Only the both-at-once case was covered, and an entry
    // with neither would silently do nothing to a conflict the author believed they had resolved.
    expect(
      validateComposeValue({ ...compose, resolve: [{ id: 'commit-convention' }] }),
    ).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'E_COMPOSE_RESOLVE', path: '/resolve/0' })],
    });
  });

  it.each([
    ['a string', '"just a string"'],
    ['null', 'null'],
    ['a broken document', 'include: [\n'],
  ])('refuses %s without throwing', (_case, source) => {
    expect(parseCompose(source).ok).toBe(false);
    expect(parseCompose(source).diagnostics.length).toBeGreaterThan(0);
  });

  it.each([
    ['a short sha', 'github:dsh-packs/web-dev#3414f1a'],
    ['a branch name', 'github:dsh-packs/web-dev#main'],
    ['an uppercase sha', 'github:dsh-packs/web-dev#3414F1AF3FD674998CEA81716586F4716A538F50'],
    ['no ref at all', 'github:dsh-packs/web-dev'],
    ['plain http', 'tarball:http://example.com/pack.tgz'],
  ])('refuses %s as a source, holding the same pinning rule install does', (_case, from) => {
    expect(validateComposeValue({ ...compose, include: [{ from, skills: ['*'] }] }).ok).toBe(false);
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
