import { describe, expect, it } from 'vitest';

import {
  PackLockSchema,
  PackManifestSchema,
  validateLockValue,
  validatePackValue,
} from '../src/index.js';

const manifest = {
  formatVersion: 0,
  name: 'web-dev',
  version: '0.1.0',
  description: '面向前端开发的保守 dsh 场景包。',
  author: 'dsh-packs',
  license: 'MIT',
  homepage: 'https://example.test/web-dev',
  repository: 'https://example.test/repo',
  dsh: { tested: ['0.1.0-rc.6'], compatibility: '>=0.1.0-rc.6' },
  plugins: [
    { name: 'registry-plugin', source: { kind: 'npm', range: '^1.2.3' }, allowBuilds: false },
  ],
  mcp: [
    {
      serverName: 'context7',
      transport: 'streamable-http',
      url: 'https://mcp.context7.com/mcp',
      description: '技术文档检索',
    },
  ],
  defaults: { agentPreset: 'web-dev', permissionPreset: 'workspace-write' },
  settings: { namespaces: { 'agent-presets': 'agent-presets.yml' } },
} as const;

const lock = {
  lockVersion: 0,
  manifestSha256: 'sha256-AQIDBAUGBwgJCgsMDQ4PEA',
  generatedBy: 'dshpack@0.1.0',
  generatedAt: '2026-08-16T00:00:00Z',
  dsh: { exportedFrom: '0.1.0-rc.6' },
  plugins: [
    {
      name: 'registry-plugin',
      resolved: { version: '1.2.3' },
      integrity: { kind: 'npm-sri', value: 'sha512-AQID' },
      packageJsonSha512: 'sha512-AQID',
      bundlePatch: 'cordis.patch.yml',
    },
  ],
  files: [{ path: 'patch/cordis.patch.yml', sha512: 'sha512-AQID' }],
} as const;

function remove(object: object, key: string): object {
  const value = structuredClone(object) as Record<string, unknown>;
  delete value[key];
  return value;
}

function setAt(object: object, path: readonly string[], value: unknown): object {
  const copy = structuredClone(object) as Record<string, unknown>;
  let target = copy;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[path.at(-1) as string] = value;
  return copy;
}

describe('PackManifest TypeBox truth source', () => {
  it('accepts the smallest complete v0 manifest', () => {
    expect(validatePackValue(manifest)).toEqual({ ok: true, value: manifest, diagnostics: [] });
    expect(PackManifestSchema.additionalProperties).toBe(false);
  });

  it.each([
    'formatVersion',
    'name',
    'version',
    'description',
    'author',
    'license',
    'dsh',
    'plugins',
    'mcp',
    'defaults',
  ])('rejects missing required top-level field %s', (field) => {
    expect(validatePackValue(remove(manifest, field)).diagnostics).not.toEqual([]);
  });

  it.each([
    ['dsh', 'tested'],
    ['plugins.0', 'name'],
    ['plugins.0', 'source'],
    ['plugins.0', 'allowBuilds'],
    ['mcp.0', 'serverName'],
    ['mcp.0', 'transport'],
    ['mcp.0', 'url'],
    ['defaults', 'permissionPreset'],
  ])('rejects missing required nested field %s.%s', (parent, field) => {
    const copy = structuredClone(manifest) as Record<string, unknown>;
    const path = parent.split('.');
    let target: Record<string, unknown> = copy;
    for (const key of path) target = target[key] as Record<string, unknown>;
    delete target[field];
    expect(validatePackValue(copy).diagnostics).not.toEqual([]);
  });

  it.each([
    [['plugins', '0', 'source', 'kind'], 'unsupported'],
    [['plugins', '0', 'role'], 'other'],
    [['mcp', '0', 'transport'], 'stdio'],
    [['defaults', 'permissionPreset'], 'read-only'],
  ])('rejects enum mutant at %s', (path, value) => {
    expect(validatePackValue(setAt(manifest, path, value)).diagnostics).not.toEqual([]);
  });

  it.each(['ab', '1-web', 'web', 'headless', 'a'.repeat(65)])(
    'enforces the §3.2 pack-name rule for %s',
    (name) => {
      expect(validatePackValue({ ...manifest, name }).ok).toBe(false);
    },
  );

  it('rejects an invalid npm plugin name', () => {
    expect(
      validatePackValue(setAt(manifest, ['plugins', '0', 'name'], 'bad/package/name')).ok,
    ).toBe(false);
  });

  it('rejects duplicate plugin names and duplicate MCP server names', () => {
    const duplicatePlugin = structuredClone(manifest) as Record<string, unknown>;
    (duplicatePlugin.plugins as unknown[]).push(structuredClone(manifest.plugins[0]));
    expect(validatePackValue(duplicatePlugin).ok).toBe(false);

    const duplicateMcp = structuredClone(manifest) as Record<string, unknown>;
    (duplicateMcp.mcp as unknown[]).push(structuredClone(manifest.mcp[0]));
    expect(validatePackValue(duplicateMcp).ok).toBe(false);
  });

  it.each([
    ['npm', 'range'],
    ['github', 'owner'],
    ['github', 'repo'],
    ['github', 'ref'],
    ['tarball', 'url'],
  ])('rejects source branch %s missing its required %s field', (kind, field) => {
    const copy = structuredClone(manifest) as Record<string, unknown>;
    const source =
      kind === 'npm'
        ? { kind, range: '^1.2.3' }
        : kind === 'github'
          ? { kind, owner: 'owner', repo: 'repo', ref: '0123456789abcdef0123456789abcdef01234567' }
          : { kind, url: 'https://example.test/plugin.tgz' };
    delete (source as Record<string, unknown>)[field];
    const plugin = (copy.plugins as Array<{ source: unknown }>)[0];
    if (plugin === undefined) throw new Error('test fixture lacks a plugin');
    plugin.source = source;
    expect(validatePackValue(copy).diagnostics).not.toEqual([]);
  });

  it.each([
    [[]],
    [['dsh']],
    [['plugins', '0']],
    [['plugins', '0', 'source']],
    [['mcp', '0']],
    [['defaults']],
    [['settings']],
    [['settings', 'namespaces']],
  ])('rejects an unknown field in every manifest object at %j', (path) => {
    const copy = structuredClone(manifest) as Record<string, unknown>;
    let target: Record<string, unknown> = copy;
    for (const key of path) target = target[key] as Record<string, unknown>;
    target.unexpected = true;
    expect(validatePackValue(copy).diagnostics).not.toEqual([]);
  });

  it('gives E_FORMAT_TOO_NEW as the minimal reason for a future format', () => {
    const result = validatePackValue({ ...manifest, formatVersion: 1 });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'E_FORMAT_TOO_NEW',
        severity: 'error',
        message: expect.stringContaining('formatVersion'),
      }),
    ]);
  });

  it('snapshots all Ajv diagnostic shapes without generic validation wording', () => {
    const cases = [
      remove(manifest, 'name'),
      setAt(manifest, ['mcp', '0', 'transport'], 'stdio'),
      setAt(manifest, ['plugins', '0', 'source'], { kind: 'github', owner: 'owner' }),
      { ...manifest, unexpected: true },
    ];
    const diagnostics = cases.map((candidate) => validatePackValue(candidate).diagnostics);
    expect(diagnostics).toMatchSnapshot();
    expect(diagnostics.flat().every((diagnostic) => diagnostic.message !== '校验失败')).toBe(true);
  });
});

describe('PackLock TypeBox truth source', () => {
  it('accepts the smallest complete v0 lock', () => {
    expect(validateLockValue(lock)).toEqual({ ok: true, value: lock, diagnostics: [] });
    expect(PackLockSchema.additionalProperties).toBe(false);
  });

  it.each([
    'lockVersion',
    'manifestSha256',
    'generatedBy',
    'generatedAt',
    'dsh',
    'plugins',
    'files',
  ])('rejects missing required lock field %s', (field) =>
    expect(validateLockValue(remove(lock, field)).diagnostics).not.toEqual([]),
  );

  it.each([
    ['dsh', 'exportedFrom'],
    ['plugins.0', 'name'],
    ['plugins.0', 'resolved'],
    ['plugins.0', 'integrity'],
    ['plugins.0', 'packageJsonSha512'],
    ['plugins.0', 'bundlePatch'],
    ['files.0', 'path'],
    ['files.0', 'sha512'],
  ])('rejects missing required lock nested field %s.%s', (parent, field) => {
    const copy = structuredClone(lock) as Record<string, unknown>;
    let target: Record<string, unknown> = copy;
    for (const key of parent.split('.')) target = target[key] as Record<string, unknown>;
    delete target[field];
    expect(validateLockValue(copy).diagnostics).not.toEqual([]);
  });

  it.each([
    { kind: 'git-commit', value: '0123456789abcdef0123456789abcdef01234567' },
    { kind: 'sha512', value: 'sha512-AQID' },
    { kind: 'unverified', reason: 'missing lock' },
  ])('accepts lock integrity branch %#', (integrity) => {
    expect(validateLockValue(setAt(lock, ['plugins', '0', 'integrity'], integrity)).ok).toBe(true);
  });

  it('rejects lock object unknown fields and invalid integrity kind', () => {
    const withUnknown = setAt(lock, ['plugins', '0', 'integrity'], { kind: 'other', value: 'x' });
    expect(validateLockValue(withUnknown).diagnostics).not.toEqual([]);
    expect(validateLockValue({ ...lock, unexpected: true }).diagnostics).not.toEqual([]);
  });
});
