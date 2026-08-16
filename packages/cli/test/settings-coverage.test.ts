import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  compareAndMoveText,
  compareAndSwapText,
  type SettingsClock,
  withSettingsFileLock,
  YamlSettingsAdapter,
} from '../src/adapters/settings.js';

async function withScratch(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dshpack-settings-coverage-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

class TimeoutClock implements SettingsClock {
  private current = 0;

  now(): number {
    return this.current;
  }

  async sleep(milliseconds: number): Promise<void> {
    this.current += milliseconds;
  }
}

describe('compareAndSwapText', () => {
  it('distinguishes a missing file from an empty file and writes only on an exact match', async () => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');

      expect(await compareAndSwapText(filename, '', 'unexpected')).toEqual({
        ok: true,
        value: false,
        diagnostics: [],
      });
      await expect(readFile(filename, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      expect(await compareAndSwapText(filename, undefined, '')).toEqual({
        ok: true,
        value: true,
        diagnostics: [],
      });
      expect(await compareAndSwapText(filename, undefined, 'unexpected')).toEqual({
        ok: true,
        value: false,
        diagnostics: [],
      });
      expect(await compareAndSwapText(filename, '', 'old')).toEqual({
        ok: true,
        value: true,
        diagnostics: [],
      });
      expect(await compareAndSwapText(filename, 'wrong', 'unexpected')).toEqual({
        ok: true,
        value: false,
        diagnostics: [],
      });
      expect(await compareAndSwapText(filename, 'old', 'new')).toEqual({
        ok: true,
        value: true,
        diagnostics: [],
      });
      expect(await readFile(filename, 'utf8')).toBe('new');
    });
  });

  it('returns a lock error Result rather than folding timeout into compare-false', async () => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');
      const lockPath = `${filename}.lock`;
      await writeFile(lockPath, 'external\n', { mode: 0o600, flag: 'wx' });

      const result = await compareAndSwapText(filename, undefined, 'new', {
        clock: new TimeoutClock(),
      });

      expect(result.ok).toBe(false);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: 'E_SETTINGS_LOCK_TIMEOUT', path: lockPath }),
      ]);
      expect(await readFile(lockPath, 'utf8')).toBe('external\n');
    });
  });
});

describe('compareAndMoveText', () => {
  it('moves an exact source into a newly created private backup parent', async () => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');
      const backupDirectory = join(directory, 'tx', 'documents');
      const destination = join(backupDirectory, 'settings-new.yaml');
      await writeFile(filename, 'new settings', 'utf8');

      expect(await compareAndMoveText(filename, 'new settings', destination)).toEqual({
        ok: true,
        value: true,
        diagnostics: [],
      });
      await expect(readFile(filename, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(destination, 'utf8')).toBe('new settings');
      if (process.platform !== 'win32') {
        expect((await stat(backupDirectory)).mode & 0o777).toBe(0o700);
      }
    });
  });

  it('makes no change when source text mismatches or the source is absent', async () => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');
      const backupDirectory = join(directory, 'tx', 'documents');
      const destination = join(backupDirectory, 'settings-new.yaml');
      await writeFile(filename, 'actual', 'utf8');

      expect(await compareAndMoveText(filename, 'expected', destination)).toEqual({
        ok: true,
        value: false,
        diagnostics: [],
      });
      expect(await readFile(filename, 'utf8')).toBe('actual');
      await expect(stat(backupDirectory)).rejects.toMatchObject({ code: 'ENOENT' });

      await rm(filename);
      expect(await compareAndMoveText(filename, 'actual', destination)).toEqual({
        ok: true,
        value: false,
        diagnostics: [],
      });
      await expect(stat(backupDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('returns an I/O Result without overwriting an existing destination', async () => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');
      const backupDirectory = join(directory, 'tx', 'documents');
      const destination = join(backupDirectory, 'settings-new.yaml');
      await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
      await writeFile(filename, 'expected', 'utf8');
      await writeFile(destination, 'existing backup', 'utf8');

      const result = await compareAndMoveText(filename, 'expected', destination);

      expect(result.ok).toBe(false);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: 'E_SETTINGS_IO', path: filename }),
      ]);
      expect(await readFile(filename, 'utf8')).toBe('expected');
      expect(await readFile(destination, 'utf8')).toBe('existing backup');
    });
  });

  it('returns a lock I/O Result before moving or creating the backup parent', async () => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');
      const backupDirectory = join(directory, 'tx', 'documents');
      const destination = join(backupDirectory, 'settings-new.yaml');
      await writeFile(filename, 'expected', 'utf8');

      const result = await compareAndMoveText(filename, 'expected', destination, {
        writeLockContents: async () => {
          throw Object.assign(new Error('synthetic'), { code: 'EIO' });
        },
      });

      expect(result.ok).toBe(false);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: 'E_SETTINGS_IO', path: `${filename}.lock` }),
      ]);
      expect(await readFile(filename, 'utf8')).toBe('expected');
      await expect(stat(backupDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(`${filename}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});

describe('settings branch boundaries', () => {
  it('reads an existing map and returns Results for scalar and invalid YAML roots', async () => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');
      const adapter = new YamlSettingsAdapter(filename);

      await writeFile(filename, 'agent-presets:\n  selected: alpha\n', 'utf8');
      expect(await adapter.read()).toEqual({
        ok: true,
        value: { 'agent-presets': { selected: 'alpha' } },
        diagnostics: [],
      });

      await writeFile(filename, 'scalar\n', 'utf8');
      expect((await adapter.read()).diagnostics).toEqual([
        expect.objectContaining({ code: 'E_SETTINGS_ROOT' }),
      ]);

      await writeFile(filename, '[unterminated\n', 'utf8');
      expect((await adapter.read()).diagnostics).toEqual([
        expect.objectContaining({ code: 'E_SETTINGS_INVALID_YAML' }),
      ]);
    });
  });

  it('leaves a same-PID replacement inode and tolerates an externally removed lock', async () => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');
      const lockPath = `${filename}.lock`;

      const replaced = await withSettingsFileLock(filename, async () => {
        await rm(lockPath);
        await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
        return 'replaced';
      });
      expect(replaced.ok).toBe(true);
      expect(await readFile(lockPath, 'utf8')).toBe(`${process.pid}\n`);

      await rm(lockPath);
      const removed = await withSettingsFileLock(filename, async () => {
        await rm(lockPath);
        return 'removed';
      });
      expect(removed).toEqual({ ok: true, value: 'removed', diagnostics: [] });
    });
  });

  it('does not delete a replaced or already removed lock after PID writing fails', async () => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');
      const lockPath = `${filename}.lock`;

      const replaced = await withSettingsFileLock(filename, async () => 'unreachable', {
        writeLockContents: async (handle) => {
          await handle.close();
          await rm(lockPath);
          await writeFile(lockPath, 'replacement\n', { mode: 0o600, flag: 'wx' });
          throw Object.assign(new Error('synthetic'), { code: 'EIO' });
        },
      });
      expect(replaced.ok).toBe(false);
      expect(await readFile(lockPath, 'utf8')).toBe('replacement\n');

      await rm(lockPath);
      const removed = await withSettingsFileLock(filename, async () => 'unreachable', {
        writeLockContents: async (handle) => {
          await handle.close();
          await rm(lockPath);
          throw Object.assign(new Error('synthetic'), { code: 'EIO' });
        },
      });
      expect(removed.ok).toBe(false);
      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
