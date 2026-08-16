import { randomBytes } from 'node:crypto';
import { type FileHandle, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface FileSystemAdapter {
  ensureDirectory(path: string): Promise<void>;
  createDirectoryExclusive(path: string): Promise<boolean>;
  pathExists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  atomicWriteText(path: string, contents: string): Promise<void>;
  writeText(path: string, contents: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
}

export interface AtomicWriteOptions {
  mode: number;
  dirMode?: number;
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (process.platform !== 'win32') return false;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EISDIR' || code === 'EINVAL' || code === 'EPERM' || code === 'ENOTSUP';
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    // Windows does not expose a portable Node API for opening/fsyncing directories.
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close();
  }
}

/** Atomically and durably replace a file through an exclusive sibling temp file. */
export async function writeFileAtomic(
  filename: string,
  contents: string,
  options: AtomicWriteOptions,
): Promise<void> {
  const parent = dirname(filename);
  await mkdir(parent, {
    recursive: true,
    ...(options.dirMode === undefined ? {} : { mode: options.dirMode }),
  });
  const temporary = `${filename}.${randomBytes(6).toString('hex')}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, 'wx', options.mode);
    await handle.writeFile(contents, 'utf8');

    // 我方更严，非复刻官方 (stricter by design, not an official-behavior replica):
    // official atomic-write leaves fsync out of scope; user settings justify the extra durability.
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(parent);
    await rename(temporary, filename);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Secure default adapter for user-private text files. */
const atomicWriteText = (path: string, contents: string): Promise<void> =>
  writeFileAtomic(path, contents, { mode: 0o600, dirMode: 0o700 });

export const nodeFileSystemAdapter: FileSystemAdapter = {
  ensureDirectory: async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  createDirectoryExclusive: async (path) => {
    try {
      await mkdir(path, { mode: 0o700 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') return false;
      throw error;
    }
  },
  pathExists: async (path) => {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
      throw error;
    }
  },
  readText: (path) => readFile(path, 'utf8'),
  atomicWriteText,
  writeText: atomicWriteText,
  rename,
};
