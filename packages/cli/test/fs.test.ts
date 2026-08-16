import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { nodeFileSystemAdapter, writeFileAtomic } from '../src/adapters/fs.js';

async function withScratch(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dshpack-fs-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('writeFileAtomic', () => {
  it('creates owner-only parents and an owner-only complete replacement', async () => {
    await withScratch(async (directory) => {
      const parent = join(directory, 'private', 'nested');
      const target = join(parent, 'settings.yaml');

      await writeFileAtomic(target, 'agent-presets:\n  selected: alpha\n', {
        mode: 0o600,
        dirMode: 0o700,
      });

      expect(await readFile(target, 'utf8')).toBe('agent-presets:\n  selected: alpha\n');
      if (process.platform !== 'win32') {
        expect((await stat(target)).mode & 0o777).toBe(0o600);
        expect((await stat(parent)).mode & 0o777).toBe(0o700);
      }
      expect((await readdir(parent)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    });
  });

  it('cleans its exclusive temp sibling when rename cannot replace the target', async () => {
    await withScratch(async (directory) => {
      const target = join(directory, 'occupied');
      await mkdir(target);

      await expect(
        writeFileAtomic(target, 'content', { mode: 0o600, dirMode: 0o700 }),
      ).rejects.toThrow();

      expect((await readdir(directory)).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    });
  });
});

describe('nodeFileSystemAdapter', () => {
  it('provides the complete transaction filesystem surface on a real temp tree', async () => {
    await withScratch(async (directory) => {
      const nested = join(directory, 'nested');
      const source = join(nested, 'source.yml');
      const target = join(nested, 'document.yml');

      expect(await nodeFileSystemAdapter.pathExists(source)).toBe(false);
      await nodeFileSystemAdapter.ensureDirectory(nested);
      expect(await nodeFileSystemAdapter.pathExists(nested)).toBe(true);
      const exclusive = join(nested, 'exclusive');
      expect(await nodeFileSystemAdapter.createDirectoryExclusive(exclusive)).toBe(true);
      expect(await nodeFileSystemAdapter.createDirectoryExclusive(exclusive)).toBe(false);
      await nodeFileSystemAdapter.atomicWriteText(source, 'name: 测试\n');
      expect(await nodeFileSystemAdapter.readText(source)).toBe('name: 测试\n');
      await nodeFileSystemAdapter.rename(source, target);
      expect(await nodeFileSystemAdapter.pathExists(source)).toBe(false);
      expect(await nodeFileSystemAdapter.pathExists(target)).toBe(true);
      await nodeFileSystemAdapter.writeText(target, 'name: replacement\n');

      expect(await nodeFileSystemAdapter.readText(target)).toBe('name: replacement\n');
      expect((await readdir(nested)).sort()).toEqual(['document.yml', 'exclusive']);
    });
  });
});
