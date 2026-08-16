import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { validateLocalPack } from '../src/validation/validate-pack.js';

const temporaryRoots: string[] = [];

function sha512(value: string): string {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

function sha256(value: string): string {
  return `sha256-${createHash('sha256').update(value).digest('base64url')}`;
}

const manifest = [
  'formatVersion: 0',
  'name: demo-pack',
  'version: 0.1.0',
  'description: 测试用 pack',
  'author: dshpack-test',
  'license: MIT',
  'dsh:',
  '  tested: [0.1.0-rc.6]',
  'plugins: []',
  'mcp: []',
  'defaults:',
  '  permissionPreset: workspace-write',
  '',
].join('\n');

async function makePack(extra: Readonly<Record<string, string>> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-validate-'));
  temporaryRoots.push(root);
  const files: Record<string, string> = { 'patch/cordis.patch.yml': '[]\n', ...extra };
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, text, 'utf8');
  }
  const lock = {
    lockVersion: 0,
    manifestSha256: sha256(manifest),
    generatedBy: 'dshpack@0.1.0',
    generatedAt: '2026-08-16T00:00:00Z',
    dsh: { exportedFrom: '0.1.0-rc.6' },
    plugins: [],
    files: Object.entries(files).map(([path, text]) => ({ path, sha512: sha512(text) })),
  };
  await writeFile(join(root, 'pack.yml'), manifest, 'utf8');
  await writeFile(join(root, 'pack.lock.yml'), stringify(lock), 'utf8');
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('validateLocalPack', () => {
  it('validates a complete local pack without requiring dsh', async () => {
    const root = await makePack();
    await expect(validateLocalPack(root, { strict: true })).resolves.toMatchObject({
      exitCode: 0,
      metadata: { valid: true },
      diagnostics: [],
    });
  });

  it('fails closed for a forbidden credential file without disclosing its value', async () => {
    const token = 'sk-TESTONLY-012345678901234567890123456789012345';
    const result = await validateLocalPack(
      await makePack({ '.credentials.yaml': `key: ${token}\n` }),
    );

    expect(result.exitCode).toBe(31);
    expect(JSON.stringify(result.diagnostics)).not.toContain(token.slice(0, 8));
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'E_SECRET_FILENAME' }),
    );
  });

  it('rejects the M0 overrides reserved directory', async () => {
    const result = await validateLocalPack(await makePack({ 'overrides/patch.yml': '[]\n' }));

    expect(result.exitCode).toBe(30);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'E_OVERRIDES_RESERVED' }),
    );
  });

  it('upgrades a skill warning to an error in strict mode', async () => {
    const skill = [
      '---',
      'name: demo-skill',
      'description: demo',
      'when_to_use: warning shape',
      '---',
      'body',
      '',
    ].join('\n');
    const root = await makePack({ 'skills/demo-skill/SKILL.md': skill });
    const loose = await validateLocalPack(root);
    const strict = await validateLocalPack(root, { strict: true });

    expect(loose.exitCode).toBe(0);
    expect(strict.exitCode).toBe(30);
    expect(strict.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'DSH011', severity: 'error' }),
    );
  });

  it('declines W12 remote source forms explicitly', async () => {
    await expect(
      validateLocalPack('github:owner/repo#0123456789012345678901234567890123456789'),
    ).resolves.toMatchObject({
      exitCode: 70,
      diagnostics: [expect.objectContaining({ code: 'E_W12_REMOTE_SOURCE' })],
    });
  });
});
