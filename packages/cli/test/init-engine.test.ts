import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { scanSecrets } from '@dshpack/core';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../src/exit-codes.js';
import { type InitInput, type InitTemplate, initializePack } from '../src/init/engine.js';
import { validateLocalPack } from '../src/validation/validate-pack.js';
import { removeFixtureDirectory } from './fixture-cleanup.js';

const roots: string[] = [];

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-init-engine-'));
  roots.push(root);
  return root;
}

async function treeFingerprint(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = join(directory, name);
      const stat = await lstat(absolute);
      if (stat.isDirectory()) {
        await visit(absolute);
        continue;
      }
      const bytes = await readFile(absolute);
      result.push(
        `${relative(root, absolute).replaceAll('\\', '/').toLowerCase()}:${bytes.byteLength}:${createHash('sha256').update(bytes).digest('hex')}`,
      );
    }
  };
  await visit(root);
  return result.sort();
}

function input(directory: string, template: InitTemplate): InitInput {
  return {
    author: 'dshpack test',
    description: 'A safe generated pack.',
    directory,
    license: 'MIT',
    name: 'generated-pack',
    template,
    version: '0.1.0',
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeFixtureDirectory(root)));
});

describe('initializePack', () => {
  it.each(['minimal', 'skills', 'mcp', 'full'] as const)(
    'writes a valid zero-credential %s template',
    async (template) => {
      const parent = await temporary();
      const target = join(parent, template);
      const report = await initializePack(input(target, template));

      expect(report.exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(report.metadata.files).toContain('pack.lock.yml');
      const files: string[] = [];
      const visit = async (directory: string): Promise<void> => {
        for (const name of await readdir(directory)) {
          const absolute = join(directory, name);
          const stat = await lstat(absolute);
          if (stat.isDirectory()) await visit(absolute);
          else {
            const path = relative(target, absolute).replaceAll('\\', '/');
            files.push(path);
            const content = await readFile(absolute, 'utf8');
            const diagnostics = scanSecrets({ path, content }).filter(
              ({ code }) => !(path === 'pack.lock.yml' && code === 'E_SECRET_HIGH_ENTROPY'),
            );
            expect(diagnostics).toEqual([]);
            if (path === 'pack.yml' && template === 'mcp') {
              expect(content).toContain('https://example.invalid/mcp');
              expect(content).not.toMatch(/https?:\/\/[^/\s:@]+:[^@/\s]+@/u);
            }
            if (path === 'pack.yml' && template === 'full') {
              expect(content).toContain('https://example.invalid/mcp');
              expect(content).not.toMatch(/https?:\/\/[^/\s:@]+:[^@/\s]+@/u);
            }
          }
        }
      };
      await visit(target);
      expect(files).toContain('pack.yml');
      if (template === 'skills' || template === 'full')
        expect(files).toContain('skills/example-skill/SKILL.md');
      if (template === 'mcp' || template === 'full') {
        expect(await readFile(join(target, 'pack.yml'), 'utf8')).toContain('example-mcp');
      }
      await expect(validateLocalPack(target, { strict: true })).resolves.toMatchObject({
        exitCode: EXIT_CODES.SUCCESS,
        metadata: { valid: true },
      });
    },
  );

  it('restores the complete parent tree when strict validation fails', async () => {
    const parent = await temporary();
    await mkdir(join(parent, 'existing'), { recursive: true });
    const marker = join(parent, 'existing', 'marker.txt');
    await writeFile(marker, 'before\n', 'utf8');
    const before = await treeFingerprint(parent);
    const target = join(parent, 'rollback-pack');
    const report = await initializePack(input(target, 'full'), {
      generateLock: async () => ({
        diagnostics: [],
        exitCode: EXIT_CODES.SUCCESS,
        metadata: { source: target, written: true },
      }),
      validate: async () => ({
        diagnostics: [
          {
            code: 'E_TEST_VALIDATE',
            severity: 'error' as const,
            message: 'synthetic validation failure',
            hint: 'test',
            evidence: 'local' as const,
          },
        ],
        exitCode: EXIT_CODES.CONTRACT,
        metadata: { source: target, valid: false },
      }),
    });

    expect(report.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(await treeFingerprint(parent)).toEqual(before);
  });

  it('rejects a non-empty target without writing into it', async () => {
    const parent = await temporary();
    const target = join(parent, 'existing-pack');
    await mkdir(target);
    await writeFile(join(target, 'keep.txt'), 'keep\n', 'utf8');
    const report = await initializePack(input(target, 'minimal'));

    expect(report.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe('keep\n');
  });

  it('rolls back staging when lock generation fails', async () => {
    const parent = await temporary();
    const target = join(parent, 'lock-failure');
    const report = await initializePack(input(target, 'minimal'), {
      generateLock: async () => ({
        diagnostics: [
          {
            code: 'E_TEST_LOCK',
            severity: 'error' as const,
            message: 'lock failed',
            hint: 'test',
            evidence: 'local' as const,
          },
        ],
        exitCode: EXIT_CODES.CONTRACT,
        metadata: { source: target, written: false },
      }),
    });

    expect(report.exitCode).toBe(EXIT_CODES.CONTRACT);
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
