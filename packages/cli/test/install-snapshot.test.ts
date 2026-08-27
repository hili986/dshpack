import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertPortableSnapshotEntries,
  captureSourceDirectory,
  readBoundedRegularFile,
  SnapshotCaptureError,
  type SnapshotStat,
} from '../src/install/snapshot-capture.js';

function fileStat(size = 1): SnapshotStat {
  return {
    kind: 'file',
    dev: 1,
    ino: 2,
    size,
    birthtimeMs: 2,
    mtimeMs: 3,
    ctimeMs: 4,
  };
}

describe('install source snapshot safety', () => {
  it.each([
    [['C:/drive.yml'], 'drive'],
    [['safe:ads.yml'], 'colon/ADS'],
    [['CON.txt'], 'Windows device'],
    [['folder/tail.'], 'trailing dot'],
    [['folder/tail '], 'trailing space'],
    [['folder\\file'], 'backslash'],
    [['folder/../file'], 'navigation'],
    [[`folder/${String.fromCharCode(0x80)}file`], 'C1 control'],
    [['A/file', 'a/file'], 'portable collision'],
    [['foo', 'foo/bar'], 'file-directory collision'],
  ])('rejects %s before writing the validation snapshot (%s)', (paths) => {
    expect(() =>
      assertPortableSnapshotEntries(
        paths.map((path) => ({ path, kind: path === 'A/file' ? 'directory' : 'file' })),
      ),
    ).toThrow(SnapshotCaptureError);
  });

  it('accepts unique portable file and directory entries', () => {
    expect(() =>
      assertPortableSnapshotEntries([
        { path: 'skills', kind: 'directory' },
        { path: 'skills/notes.md', kind: 'file' },
      ]),
    ).not.toThrow();
  });

  it('stops a growing same-handle read at 1 MiB + 1 without readFile allocation', async () => {
    const stat = fileStat(1);
    let remaining = 1024 * 1024 + 1;
    let largestRequest = 0;
    let closed = false;
    let caught: unknown;
    try {
      await readBoundedRegularFile('C:/pack/growing.bin', {
        async lstatPath() {
          return stat;
        },
        async openFile() {
          return {
            async stat() {
              return stat;
            },
            async read(buffer, offset, length) {
              largestRequest = Math.max(largestRequest, length);
              const bytesRead = Math.min(length, remaining);
              buffer.fill(1, offset, offset + bytesRead);
              remaining -= bytesRead;
              return { bytesRead };
            },
            async close() {
              closed = true;
            },
          };
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ kind: 'limit' });
    expect(largestRequest).toBeLessThanOrEqual(64 * 1024);
    expect(closed).toBe(true);
  });

  it('rejects a non-file, an oversized stat, and an identity swap before reading', async () => {
    const neverOpen = async () => {
      throw new Error('must not open');
    };
    await expect(
      readBoundedRegularFile('directory', {
        lstatPath: async () => ({ ...fileStat(), kind: 'directory' }),
        openFile: neverOpen,
      }),
    ).rejects.toMatchObject({ kind: 'security' });
    await expect(
      readBoundedRegularFile('large', {
        lstatPath: async () => fileStat(1024 * 1024 + 1),
        openFile: neverOpen,
      }),
    ).rejects.toMatchObject({ kind: 'limit' });

    let closed = false;
    await expect(
      readBoundedRegularFile('swapped', {
        lstatPath: async () => fileStat(),
        openFile: async () => ({
          stat: async () => ({ ...fileStat(), ino: 99 }),
          read: async () => ({ bytesRead: 0 }),
          close: async () => {
            closed = true;
          },
        }),
      }),
    ).rejects.toMatchObject({ kind: 'security' });
    expect(closed).toBe(true);
  });

  it('rejects invalid reads and a same-handle file mutation', async () => {
    let closedInvalid = false;
    await expect(
      readBoundedRegularFile('invalid-read', {
        lstatPath: async () => fileStat(),
        openFile: async () => ({
          stat: async () => fileStat(),
          read: async (_buffer, _offset, length) => ({ bytesRead: length + 1 }),
          close: async () => {
            closedInvalid = true;
          },
        }),
      }),
    ).rejects.toMatchObject({ kind: 'security' });
    expect(closedInvalid).toBe(true);

    let statCalls = 0;
    await expect(
      readBoundedRegularFile('mutated', {
        lstatPath: async () => fileStat(),
        openFile: async () => ({
          stat: async () => {
            statCalls += 1;
            return statCalls === 1 ? fileStat() : { ...fileStat(), ctimeMs: 99 };
          },
          read: async () => ({ bytesRead: 0 }),
          close: async () => undefined,
        }),
      }),
    ).rejects.toMatchObject({ kind: 'security' });
  });

  it('rejects a canonical escape and special directory entry before opening it', async () => {
    const directory = { ...fileStat(0), kind: 'directory' as const };
    const special = { ...fileStat(0), kind: 'special' as const };
    async function* one(name: string) {
      yield { name };
    }
    await expect(
      captureSourceDirectory('C:/pack', {
        lstatPath: async (path) => (path.endsWith('escape') ? fileStat() : directory),
        realpathPath: async (path) => (path.endsWith('escape') ? 'C:/outside' : path),
        listDirectory: () => one('escape'),
      }),
    ).rejects.toMatchObject({ kind: 'security' });
    await expect(
      captureSourceDirectory('C:/pack', {
        lstatPath: async (path) => (path.endsWith('device') ? special : directory),
        realpathPath: async (path) => path,
        listDirectory: () => one('device'),
      }),
    ).rejects.toMatchObject({ kind: 'security' });
  });

  it('refuses a SOURCE reached through a linked ancestor, or one it cannot inspect', async () => {
    const directory = { ...fileStat(0), kind: 'directory' as const };
    const link = { ...fileStat(0), kind: 'symlink' as const };
    async function* empty() {}

    // Same spelling in and out — the old check compared those two and so never fired
    // here, while on Windows an 8.3 alias made it fire on directories with no link at all.
    await expect(
      captureSourceDirectory('C:/outer/inner/pack', {
        lstatPath: async (path) => (path === resolve('C:/outer/inner') ? link : directory),
        realpathPath: async (path) => path,
        listDirectory: empty,
      }),
    ).rejects.toMatchObject({ kind: 'security' });

    await expect(
      captureSourceDirectory('C:/outer/inner/pack', {
        lstatPath: async (path) => {
          if (path === resolve('C:/outer')) throw new Error('unreadable ancestor');
          return directory;
        },
        realpathPath: async (path) => path,
        listDirectory: empty,
      }),
    ).rejects.toMatchObject({ kind: 'security' });

    // An ordinary chain is captured, including when the root's spelling differs from its
    // realpath the way a Windows 8.3 alias does.
    await expect(
      captureSourceDirectory('C:/outer/inner/pack', {
        lstatPath: async () => directory,
        realpathPath: async () => resolve('C:/outer/inner/pack-with-a-long-name'),
        listDirectory: empty,
      }),
    ).resolves.toEqual({ entries: [], files: [] });
  });

  it('skips ignored entries before lstat or recursive traversal', async () => {
    const directory = { ...fileStat(0), kind: 'directory' as const };
    const lstatPaths: string[] = [];
    async function* gitDirectory() {
      yield { name: '.git' };
    }

    const captured = await captureSourceDirectory('C:/pack', {
      skipPath: (path: string) => path === '.git',
      lstatPath: async (path) => {
        lstatPaths.push(path);
        if (path.endsWith('.git')) throw new Error('ignored entry was inspected');
        return directory;
      },
      realpathPath: async (path) => path,
      listDirectory: gitDirectory,
    });

    expect(captured).toEqual({ entries: [], files: [] });
    expect(lstatPaths.some((path) => path.endsWith('.git'))).toBe(false);
  });

  it('rejects the 4097th streamed file entry before opening that entry', async () => {
    const directory = { ...fileStat(0), kind: 'directory' as const };
    let opens = 0;
    async function* files() {
      for (let index = 0; index < 4097; index += 1) yield { name: `${index}.txt` };
    }
    await expect(
      captureSourceDirectory('C:/pack', {
        lstatPath: async (path) => (path.endsWith('pack') ? directory : fileStat()),
        realpathPath: async (path) => path,
        listDirectory: files,
        openFile: async () => {
          opens += 1;
          let read = false;
          return {
            stat: async () => fileStat(),
            read: async (buffer) => {
              if (read) return { bytesRead: 0 };
              read = true;
              buffer[0] = 1;
              return { bytesRead: 1 };
            },
            close: async () => undefined,
          };
        },
      }),
    ).rejects.toMatchObject({ kind: 'limit' });
    expect(opens).toBe(4096);
  });
});
