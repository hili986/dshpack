import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { manifestDiagnostics, validateLocalPack } from '../src/validation/validate-pack.js';

const temporaryRoots: string[] = [];

function sha512(value: string): string {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

function sha256(value: string): string {
  return `sha256-${createHash('sha256').update(value).digest('base64url')}`;
}

function manifest(extra: readonly string[] = []): string {
  return [
    'formatVersion: 0',
    'name: coverage-pack',
    'version: 0.1.0',
    'description: coverage fixture',
    'author: dshpack-test',
    'license: MIT',
    'dsh:',
    '  tested: [0.1.0-rc.6]',
    'plugins: []',
    'mcp: []',
    'defaults:',
    '  permissionPreset: workspace-write',
    ...extra,
    '',
  ].join('\n');
}

async function pack(
  options: {
    files?: Readonly<Record<string, string>>;
    lock?: Record<string, unknown>;
    manifest?: string;
  } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-validate-coverage-'));
  temporaryRoots.push(root);
  const packText = options.manifest ?? manifest();
  const files = { 'patch/cordis.patch.yml': '[]\n', ...(options.files ?? {}) };
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  const defaultLock = {
    lockVersion: 0,
    manifestSha256: sha256(packText),
    generatedBy: 'dshpack@0.1.0',
    generatedAt: '2026-08-16T00:00:00Z',
    dsh: { exportedFrom: '0.1.0-rc.6' },
    plugins: [],
    files: Object.entries(files).map(([path, content]) => ({ path, sha512: sha512(content) })),
  };
  await writeFile(join(root, 'pack.yml'), packText, 'utf8');
  await writeFile(join(root, 'pack.lock.yml'), stringify(options.lock ?? defaultLock), 'utf8');
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('validate coverage scenarios', () => {
  it('rejects absent, file, and unknown local sources without invoking dsh', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack-validate-source-'));
    temporaryRoots.push(root);
    const missing = await validateLocalPack(join(root, 'missing'));
    expect(missing.exitCode).toBe(30);
    expect(missing.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'E_SOURCE_DIRECTORY' }),
    );
    const sourceFile = join(root, 'source.txt');
    await writeFile(sourceFile, 'not a pack', 'utf8');
    const file = await validateLocalPack(sourceFile);
    expect(file.exitCode).toBe(30);
    expect(file.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'E_SOURCE_DIRECTORY' }),
    );
    const unknown = await pack({ files: { 'unknown.txt': 'unsupported\n' } });
    await expect(validateLocalPack(unknown)).resolves.toMatchObject({
      exitCode: 30,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'E_LAYOUT_UNKNOWN' })]),
    });
  });

  it('rejects reserved layouts, missing required payload, invalid patch shapes, and skill lint output', async () => {
    const root = await pack({
      files: {
        'overrides/patch.yml': '[]\n',
        'presets/standard/agent.cordis.yml': 'agents: []\n',
        'skills/demo-skill/SKILL.md':
          '---\nname: demo-skill\ndescription: demo\nwhen_to_use: old\n---\nbody\n',
        'patch/cordis.patch.yml': 'not-an-array: true\n',
      },
    });
    const result = await validateLocalPack(root, { strict: true });
    expect(result.exitCode).toBe(30);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'E_OVERRIDES_RESERVED' }),
        expect.objectContaining({ code: 'E_PRESET_RESERVED' }),
        expect.objectContaining({ code: 'E_PATCH_TOP_LEVEL' }),
        expect.objectContaining({ code: 'DSH011', severity: 'error' }),
      ]),
    );

    const missingPatch = await pack({ files: {} });
    await rm(join(missingPatch, 'patch'), { recursive: true });
    await expect(validateLocalPack(missingPatch)).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'E_LAYOUT_REQUIRED' })]),
    });
  });

  it('surfaces schema, plugin, MCP, and skill diagnostic identifiers without changing them', async () => {
    const schemaFailure = await pack({ manifest: 'formatVersion: 0\nname: invalid\n' });
    await expect(validateLocalPack(schemaFailure)).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'E_SCHEMA_REQUIRED' })]),
    });

    const mcpManifest = manifest().replace(
      'mcp: []',
      [
        'mcp:',
        '  - serverName: private',
        '    transport: streamable-http',
        '    url: https://mcp.example.test/mcp?token=plain',
      ].join('\n'),
    );
    const mcp = await validateLocalPack(await pack({ manifest: mcpManifest }));
    expect(mcp.diagnostics).toContainEqual(expect.objectContaining({ code: 'E_MCP_CREDENTIAL' }));

    const malformedMcp = await validateLocalPack(
      await pack({
        manifest: manifest().replace(
          'mcp: []',
          [
            'mcp:',
            '  - serverName: malformed',
            '    transport: streamable-http',
            '    url: "https://"',
          ].join('\n'),
        ),
      }),
    );
    expect(malformedMcp.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'E_SCHEMA_PATTERN' }),
    );

    const nonHttpMcp = await validateLocalPack(
      await pack({
        manifest: manifest().replace(
          'mcp: []',
          [
            'mcp:',
            '  - serverName: local',
            '    transport: stdio',
            '    url: https://mcp.example.test/mcp',
          ].join('\n'),
        ),
      }),
    );
    expect(nonHttpMcp.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'E_SCHEMA_ENUM' }),
    );

    const skills = await validateLocalPack(
      await pack({
        files: {
          'skills/demo-skill/SKILL.md':
            '---\nname: demo-skill\ndescription: demo\ndisableModelInvocation: true\n---\n',
          'skills/bad-name/SKILL.md': '---\nname: Bad_Name\ndescription: demo\n---\n',
        },
      }),
    );
    expect(skills.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DSH012' }),
        expect.objectContaining({ code: 'DSH013' }),
      ]),
    );
  });

  it('checks every lock reconciliation direction and preserves a valid baseline', async () => {
    const root = await pack();
    await writeFile(join(root, 'patch', 'cordis.patch.yml'), '[]\n# changed\n', 'utf8');
    const changed = await validateLocalPack(root);
    expect(changed.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'E_LOCK_PAYLOAD_DIGEST' }),
    );

    const manifestChanged = await pack();
    await writeFile(
      join(manifestChanged, 'pack.yml'),
      manifest().replace('version: 0.1.0', 'version: 0.1.1'),
      'utf8',
    );
    const digest = await validateLocalPack(manifestChanged);
    expect(digest.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'E_LOCK_MANIFEST_DIGEST' }),
    );

    const pluginManifest = manifest().replace(
      'plugins: []',
      [
        'plugins:',
        '  - name: demo-plugin',
        '    source: { kind: npm, range: 1.0.0 }',
        '    allowBuilds: false',
      ].join('\n'),
    );
    const pluginMismatch = await validateLocalPack(await pack({ manifest: pluginManifest }));
    expect(pluginMismatch.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'E_LOCK_PLUGIN_MISMATCH' }),
    );

    const phantomLock = {
      lockVersion: 0,
      manifestSha256: sha256(manifest()),
      generatedBy: 'dshpack@0.1.0',
      generatedAt: '2026-08-16T00:00:00Z',
      dsh: { exportedFrom: '0.1.0-rc.6' },
      plugins: [],
      files: [
        { path: 'patch/cordis.patch.yml', sha512: sha512('[]\n') },
        { path: 'missing.txt', sha512: sha512('missing') },
      ],
    };
    const phantom = await validateLocalPack(await pack({ lock: phantomLock }));
    expect(phantom.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'E_LOCK_PAYLOAD_MISSING' }),
    );
  });

  it('allows every documented payload location without treating it as unknown layout', async () => {
    const root = await pack({
      files: {
        'agents-md/README.md': '# managed manually\n',
        'settings/agent-presets.yml': 'selected: demo\n',
        'presets/demo/agent.cordis.yml': 'agents: []\n',
        'presets/demo/preset.yml': 'name: demo\n',
        'presets/demo/skills/preset-skill/SKILL.md':
          '---\nname: preset-skill\ndescription: demo\n---\n',
        'skills/flat-skill.md': '---\nname: flat-skill\ndescription: demo\n---\n',
        'export-report.json': '{}\n',
      },
    });
    await mkdir(join(root, 'empty-directory'));
    await symlink(
      join(root, 'patch'),
      join(root, 'patch-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const result = await validateLocalPack(root);
    expect(result.diagnostics.some(({ code }) => code === 'E_LAYOUT_UNKNOWN')).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'E_PATH_SPECIAL_FILE' }),
    );
  });

  it('covers absent manifest and lock paths, explicit overrides, safe MCP URLs, and junction sources', async () => {
    const absent = await pack();
    await rm(join(absent, 'pack.yml'));
    await rm(join(absent, 'pack.lock.yml'));
    const incomplete = await validateLocalPack(absent);
    expect(incomplete.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'E_LAYOUT_REQUIRED', path: 'pack.yml' }),
        expect.objectContaining({ code: 'E_LAYOUT_REQUIRED', path: 'pack.lock.yml' }),
      ]),
    );

    const overrideFile = await validateLocalPack(
      await pack({ files: { overrides: 'reserved\n' } }),
    );
    expect(overrideFile.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'E_OVERRIDES_RESERVED' }),
    );

    const invalidLockRoot = await pack();
    await writeFile(join(invalidLockRoot, 'pack.lock.yml'), '[', 'utf8');
    const invalidLock = await validateLocalPack(invalidLockRoot);
    expect(invalidLock.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'E_YAML_PARSE' }),
    );

    const safeMcp = await validateLocalPack(
      await pack({
        manifest: manifest().replace(
          'mcp: []',
          [
            'mcp:',
            '  - serverName: safe',
            '    transport: streamable-http',
            '    url: https://mcp.example.test/mcp',
          ].join('\n'),
        ),
      }),
    );
    expect(safeMcp.exitCode).toBe(0);

    const target = await pack();
    const parent = await mkdtemp(join(tmpdir(), 'dshpack-validate-junction-'));
    temporaryRoots.push(parent);
    const junction = join(parent, 'pack-junction');
    await symlink(target, junction, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(validateLocalPack(junction)).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'E_SOURCE_DIRECTORY' }),
      ]),
    });

    expect(
      manifestDiagnostics({ plugins: [{ name: 'Bad_Name' }], mcp: [] } as never),
    ).toContainEqual(expect.objectContaining({ code: 'E_PLUGIN_NAME' }));
  });
});
