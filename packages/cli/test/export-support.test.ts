import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  abandonTemporary,
  collectDirectory,
  fileName,
  materialFromFile,
  mcpFromPatch,
  prepareOutput,
  publishTemporary,
  scanProfileNames,
  sourceFromSpecifier,
  writeMaterials,
} from '../src/export/support.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-export-support-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('export support', () => {
  it('classifies npm, tarball, pinned git, and unpinned git specifiers', () => {
    expect(sourceFromSpecifier('pkg', '1.2.3')).toEqual({
      source: { kind: 'npm', range: '1.2.3' },
      diagnostics: [],
    });
    expect(sourceFromSpecifier('pkg', 'https://example.test/pkg.tgz')).toEqual({
      source: { kind: 'tarball', url: 'https://example.test/pkg.tgz' },
      diagnostics: [],
    });
    expect(
      sourceFromSpecifier('pkg', 'github:owner/repo#0123456789012345678901234567890123456789'),
    ).toEqual({
      source: {
        kind: 'github',
        owner: 'owner',
        repo: 'repo',
        ref: '0123456789012345678901234567890123456789',
      },
      diagnostics: [],
    });
    expect(sourceFromSpecifier('pkg', 'github:owner/repo#main').diagnostics).toContainEqual(
      expect.objectContaining({ code: 'E_EXPORT_GIT_PIN', path: 'pkg' }),
    );
  });

  it('collects ordinary files and rejects special, unreadable, and nonexistent asset paths', async () => {
    const root = await temporaryRoot();
    const file = join(root, 'asset.txt');
    await writeFile(file, 'asset', 'utf8');

    await expect(materialFromFile(file, 'assets/asset.txt')).resolves.toEqual({
      material: { path: 'assets/asset.txt', bytes: Buffer.from('asset') },
      diagnostics: [],
    });
    await expect(materialFromFile(root, 'assets/root')).resolves.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'E_EXPORT_PATH' })],
    });
    await expect(materialFromFile(join(root, 'missing'), 'assets/missing')).resolves.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'E_EXPORT_READ' })],
    });
  });

  it('walks optional asset directories but fails closed when the root cannot be read', async () => {
    const root = await temporaryRoot();
    const assets = join(root, 'assets');
    await mkdir(join(assets, 'nested'), { recursive: true });
    await writeFile(join(assets, 'top.md'), '# top\n', 'utf8');
    await writeFile(join(assets, 'nested', 'child.txt'), 'child\n', 'utf8');

    await expect(collectDirectory(join(root, 'missing'), 'skills')).resolves.toEqual({
      materials: [],
      diagnostics: [],
    });
    await expect(collectDirectory(assets, 'skills')).resolves.toMatchObject({
      diagnostics: [],
      materials: expect.arrayContaining([
        expect.objectContaining({ path: 'skills/top.md' }),
        expect.objectContaining({ path: 'skills/nested/child.txt' }),
      ]),
    });
    await expect(collectDirectory(join(assets, 'top.md'), 'skills')).resolves.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'E_EXPORT_READ' })],
    });
  });

  it('scans profile-visible names without traversing node_modules or the profile lock', async () => {
    const root = await temporaryRoot();
    await expect(scanProfileNames(join(root, 'missing'))).resolves.toEqual([]);
    await mkdir(join(root, 'node_modules', '.credentials'), { recursive: true });
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lock\n', 'utf8');
    await writeFile(join(root, 'nested', '.credentials.yaml'), 'ignored-content\n', 'utf8');

    await expect(scanProfileNames(root)).resolves.toContainEqual(
      expect.objectContaining({ code: 'E_SECRET_FILENAME', path: 'nested/.credentials.yaml' }),
    );
    await expect(scanProfileNames(join(root, 'pnpm-lock.yaml'))).resolves.toMatchObject([
      expect.objectContaining({ code: 'E_EXPORT_READ' }),
    ]);
  });

  it('extracts only safe streamable-http MCP records and runs a URL secret scan', () => {
    expect(mcpFromPatch('not: [valid').diagnostics).toEqual([]);
    expect(mcpFromPatch('[]\n')).toEqual({ mcp: [], diagnostics: [] });
    expect(
      mcpFromPatch(
        '- insert:\n    - name: "@deepseek-ai/dsh-mcp-client"\n      config: { serverName: bad, transport: stdio }\n',
      ).diagnostics,
    ).toContainEqual(expect.objectContaining({ code: 'E_EXPORT_MCP' }));
    expect(
      mcpFromPatch(
        '- insert:\n    - name: "@deepseek-ai/dsh-mcp-client"\n      config: { serverName: private, transport: streamable-http, url: "https://x.test/mcp?token=sk-TESTONLY-01234567890123456789" }\n',
      ).diagnostics,
    ).toContainEqual(expect.objectContaining({ code: expect.stringMatching(/^E_SECRET/) }));
    expect(
      mcpFromPatch(
        '- insert:\n    - name: "@deepseek-ai/dsh-mcp-client"\n      config: { serverName: safe, transport: streamable-http, url: "https://x.test/mcp" }\n',
      ),
    ).toEqual({
      mcp: [{ serverName: 'safe', transport: 'streamable-http', url: 'https://x.test/mcp' }],
      diagnostics: [],
    });
  });

  it('uses a temporary output directory, preserves confirmation boundaries, and publishes materials atomically', async () => {
    const root = await temporaryRoot();
    const output = join(root, 'pack');
    await expect(prepareOutput(output, false)).resolves.toMatchObject({
      temporary: expect.any(String),
      diagnostics: [],
    });
    const first = await prepareOutput(output, false);
    await abandonTemporary(first.temporary);
    await abandonTemporary(undefined);

    await writeFile(output, 'file', 'utf8');
    await expect(prepareOutput(output, true)).resolves.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'E_EXPORT_OUTPUT' })],
    });
    await rm(output);
    await mkdir(output);
    await writeFile(join(output, 'existing.txt'), 'existing', 'utf8');
    await expect(prepareOutput(output, true)).resolves.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'E_EXPORT_OUTPUT_CONFIRM' })],
    });
    await rm(join(output, 'existing.txt'));
    await expect(prepareOutput(output, false)).resolves.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'E_EXPORT_OUTPUT_CONFIRM' })],
    });

    const prepared = await prepareOutput(output, true);
    expect(prepared.temporary).toBeDefined();
    await writeMaterials(prepared.temporary as string, [
      { path: 'nested/payload.txt', bytes: Buffer.from('payload') },
    ]);
    await expect(
      readFile(join(prepared.temporary as string, 'nested', 'payload.txt'), 'utf8'),
    ).resolves.toBe('payload');
    await publishTemporary(prepared.temporary as string, output);
    await expect(readFile(join(output, 'nested', 'payload.txt'), 'utf8')).resolves.toBe('payload');
    expect(fileName(output)).toBe('pack');
  });
});
